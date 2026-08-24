import "webrtc-adapter";
import { PartyTracks, setLogLevel } from "partytracks/client";
import { ReplaySubject, BehaviorSubject, of } from "rxjs";

const QUALITY = {
  '720p30':  { label: '720p 30fps',  width: 1280, height: 720,  fps: 30, bitrate: 2_500_000 },
  '720p60':  { label: '720p 60fps',  width: 1280, height: 720,  fps: 60, bitrate: 4_000_000 },
  '1080p60': { label: '1080p 60fps', width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
};

const $ = (id) => document.getElementById(id);
const state = {
  apiBase: '', roomId: '', participantId: '', token: '', name: '',
  ws: null, socketSeq: 0, heartbeat: null, reconnectTimer: null, reconnectAttempts: 0,
  pollTimer: null, watchdogTimer: null, budgetTimer: null,
  tracks: null, tracksSessionSub: null, pcStateSub: null,
  leaving: false, share: null, reannounce: null, sessionId: '',
  people: new Map(), streams: new Map(), subs: new Map(), joining: new Set(), watching: new Set(), tiles: new Map(),
  budget: null, budgetBlocked: false, audioUnlocked: false,
};

function log(message, level = 'info') {
  const body = $('logBody');
  if (body) {
    const line = document.createElement('div');
    line.className = `log-line log-${level}`;
    line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
  }
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[SimpleShare] ${message}`);
}
function toast(message) {
  const el = $('toast'); if (!el) return;
  el.textContent = message; el.classList.add('show');
  clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.remove('show'), 4500);
}
function setStatus(text, tone = '') { const el = $('status'); if (el) { el.textContent = text; el.className = `status ${tone}`; } }
function randomId(bytes = 8) { const b = new Uint8Array(bytes); crypto.getRandomValues(b); return [...b].map(v => v.toString(16).padStart(2,'0')).join(''); }
function normalizeBase(value) { const raw = String(value || '').trim().replace(/\/+$/, ''); return raw ? (/^https?:\/\//i.test(raw) ? raw : `https://${raw}`) : ''; }
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
async function apiCall(path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`${state.apiBase}${path}`, { method, headers: body ? {'content-type':'application/json'} : undefined, body: body ? JSON.stringify(body) : undefined });
  const text = await response.text(); let data; try { data = JSON.parse(text); } catch { data = {raw:text}; }
  if (!response.ok) throw new Error(data.error || `${path} failed (${response.status})`); return data;
}
const envelope = (extra = {}) => ({ room:state.roomId, participantId:state.participantId, token:state.token, ...extra });
const sessionKey = () => `simpleshare-session-${state.roomId}`;
function savedSession() { try { const p = JSON.parse(sessionStorage.getItem(sessionKey()) || 'null'); return p?.participantId && p?.token ? p : null; } catch { return null; } }

async function joinRoom() {
  const previous = savedSession();
  const result = await apiCall(`/api/rooms/${state.roomId}/join`, { method:'POST', body:{ name:state.name, mode:'cloud', participantId:previous?.participantId, token:previous?.token } });
  state.participantId = result.participantId; state.token = result.token;
  try { sessionStorage.setItem(sessionKey(), JSON.stringify({participantId:state.participantId, token:state.token})); } catch {}
  state.people = new Map((result.snapshot?.participants || []).map(p => [p.id,p]));
  state.streams = new Map((result.snapshot?.streams || []).map(s => [s.id,s]));
  log(result.resumed ? `rejoined room as ${state.name}` : `joined room as ${state.name}`);
  renderPeople();
}

function reportWatching() {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type:'watching', streamIds:[...state.watching] }));
}
function clearSocketTimers() { clearInterval(state.heartbeat); state.heartbeat = null; clearTimeout(state.reconnectTimer); state.reconnectTimer = null; }
function connectSocket() {
  const seq = ++state.socketSeq;
  return new Promise((resolve, reject) => {
    const base = state.apiBase.replace(/^http/i,'ws');
    const url = `${base}/api/rooms/${state.roomId}/socket?id=${encodeURIComponent(state.participantId)}&token=${encodeURIComponent(state.token)}`;
    const ws = new WebSocket(url); state.ws = ws; let settled = false;
    const timer = setTimeout(() => { if (!settled && state.ws === ws) { settled = true; try { ws.close(); } catch {} reject(new Error('Room socket timed out.')); } }, 10000);
    ws.onopen = () => {
      if (state.ws !== ws || seq !== state.socketSeq) { try { ws.close(); } catch {} return; }
      clearTimeout(timer); settled = true; state.reconnectAttempts = 0; clearInterval(state.heartbeat);
      state.heartbeat = setInterval(() => { if (state.ws === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'ping'})); }, 20000);
      log('room socket connected'); reportWatching(); setStatus(state.share ? 'Sharing' : 'Connected','ok');
      $('shareBtn').disabled = state.budgetBlocked;
      resolve();
    };
    ws.onmessage = (e) => { if (state.ws !== ws) return; let msg; try { msg = JSON.parse(e.data); } catch { return; } handleMessage(msg).catch(err => log(`socket handler: ${err.message}`,'error')); };
    ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Room socket failed.')); } };
    ws.onclose = (e) => {
      clearTimeout(timer); if (state.ws !== ws || seq !== state.socketSeq || state.leaving) return;
      clearInterval(state.heartbeat); state.heartbeat = null;
      log(`room socket closed (code ${e.code}${e.reason ? `, ${e.reason}` : ''})`,'warn'); setStatus('Reconnecting','warn'); scheduleReconnect();
    };
  });
}
function scheduleReconnect() {
  if (state.leaving || state.reconnectTimer) return;
  state.reconnectAttempts += 1;
  if (state.reconnectAttempts > 6) { log('socket recovery exhausted — reloading cleanly','error'); toast('Connection lost. Reloading the room…'); setTimeout(() => location.reload(),1200); return; }
  const delay = Math.min(800 * (2 ** (state.reconnectAttempts - 1)), 8000) + Math.floor(Math.random()*350);
  log(`reconnecting in ${(delay/1000).toFixed(1)}s (attempt ${state.reconnectAttempts}/6)`);
  state.reconnectTimer = setTimeout(() => { state.reconnectTimer = null; connectSocket().catch(err => { log(`reconnect failed: ${err.message}`,'warn'); scheduleReconnect(); }); }, delay);
}

async function handleMessage(msg) {
  if (msg.type === 'snapshot') {
    state.people = new Map((msg.participants || []).map(p => [p.id,p]));
    const incoming = new Map((msg.streams || []).map(s => [s.id,s]));
    for (const id of [...state.streams.keys()]) if (!incoming.has(id)) await dropStream(id);
    for (const s of incoming.values()) await addStream(s);
    renderPeople(); return;
  }
  if (msg.type === 'participant-joined' || msg.type === 'participant-updated') { state.people.set(msg.participant.id,msg.participant); renderPeople(); return; }
  if (msg.type === 'participant-left') { state.people.delete(msg.participantId); for (const id of msg.removedStreams || []) await dropStream(id); renderPeople(); return; }
  if (msg.type === 'stream-upsert') { await addStream(msg.stream); return; }
  if (msg.type === 'stream-remove') { await dropStream(msg.streamId); }
}

function initTracks() {
  if (state.tracks) return state.tracks;
  state.tracks = new PartyTracks({ prefix:`${state.apiBase}/partytracks`, headers:new Headers({'x-room':state.roomId,'x-participant-id':state.participantId,'x-participant-token':state.token}) });
  state.tracksSessionSub = state.tracks.session$.subscribe({
    next:({sessionId}) => {
      if (state.sessionId && state.sessionId !== sessionId) log(`media session rebuilt (${state.sessionId.slice(0,8)}… -> ${sessionId.slice(0,8)}…)`,'warn');
      state.sessionId = sessionId;
    },
    error:(err) => log(`media session error: ${err?.message || err}`,'error'),
  });
  state.pcStateSub = state.tracks.peerConnectionState$.subscribe((s) => {
    log(`media connection: ${s}`, s === 'failed' ? 'error' : 'info');
    if (s === 'connected') setStatus(state.share ? 'Sharing' : 'Connected','ok');
    if (s === 'failed') { setStatus('Media failed','bad'); toast('Media connection failed. The app will keep trying; restrictive networks may require TURN.'); }
  });
  log('media engine ready'); return state.tracks;
}

async function startShare() {
  if (state.share || state.budgetBlocked) return;
  const qualityId = $('quality').value; const q = QUALITY[qualityId] || QUALITY['720p60']; const wantAudio = $('withAudio').checked;
  let media;
  try {
    log(`requesting screen at ${q.label}${wantAudio ? ' with audio' : ''}`);
    media = await navigator.mediaDevices.getDisplayMedia({
      video:{ width:{ideal:q.width}, height:{ideal:q.height}, frameRate:{ideal:q.fps} },
      audio: wantAudio ? { echoCancellation:false, noiseSuppression:false, autoGainControl:false } : false,
      systemAudio: wantAudio ? 'include' : 'exclude',
      surfaceSwitching:'include',
      selfBrowserSurface:'exclude',
    });
  } catch (err) {
    if (err?.name === 'NotAllowedError') log('screen picker cancelled'); else { log(`screen capture failed: ${err.message}`,'error'); toast(err.message || 'Could not start sharing.'); }
    return;
  }
  const videoTrack = media.getVideoTracks()[0]; const audioTrack = media.getAudioTracks()[0] || null;
  if (!videoTrack) { media.getTracks().forEach(t=>t.stop()); toast('No video track was captured.'); return; }
  if (wantAudio && !audioTrack) toast('Screen is sharing, but the browser did not provide audio. In Chrome/Edge, select a tab or screen and enable “Share audio”.');
  try { videoTrack.contentHint = $('contentHint').value; } catch {}
  if (audioTrack) { try { audioTrack.contentHint = 'music'; } catch {} log(`captured shared audio (${audioTrack.label || 'system/tab audio'})`); }
  const settings = videoTrack.getSettings(); log(`captured ${settings.width || '?'}x${settings.height || '?'} @ ${Math.round(settings.frameRate || 0)}fps`);
  videoTrack.addEventListener('ended', () => { if (state.share) stopShare().catch(()=>{}); }, {once:true});

  const tracks = initTracks(); const streamId = `${state.participantId}-${randomId(3)}`;
  const share = {streamId,media,subs:[],videoMeta:null,audioMeta:null,profile:qualityId,encodings$:null}; state.share = share;
  setSharingUi(true); setStatus('Publishing','warn');
  showLocalTile({id:streamId,ownerId:state.participantId,ownerName:`${state.name} (you)`,profile:qualityId,audio:Boolean(audioTrack)},media);

  const announce = async () => {
    if (state.share !== share || !share.videoMeta?.trackName || !share.videoMeta?.sessionId) return;
    const stream = {id:streamId,sessionId:share.videoMeta.sessionId,videoTrackName:share.videoMeta.trackName,audioTrackName:share.audioMeta?.trackName || null,profile:qualityId,audio:Boolean(share.audioMeta)};
    await apiCall(`/api/rooms/${state.roomId}/stream/upsert`,{method:'POST',body:envelope({stream})});
    log(`announced to room (session ${stream.sessionId.slice(0,8)}…)${stream.audio ? ' + audio' : ''}`); setStatus('Sharing','ok');
  };
  state.reannounce = announce;
  const encodings$ = new BehaviorSubject([{maxBitrate:q.bitrate,maxFramerate:q.fps}]); share.encodings$ = encodings$;
  const videoSource$ = new ReplaySubject(1); log(`publishing video at up to ${(q.bitrate/1e6).toFixed(1)} Mbps`);
  share.subs.push(tracks.push(videoSource$,{sendEncodings$:encodings$}).subscribe({
    next:(meta)=>{ share.videoMeta=meta; log(`video published (${meta.trackName})`); announce().catch(err=>log(`announce failed: ${err.message}`,'error')); },
    error:(err)=>{ log(`video publish failed: ${err?.message || err}`,'error'); toast(`Video publish failed: ${err?.message || err}`); }
  }));
  if (audioTrack) {
    const audioSource$ = new ReplaySubject(1);
    share.subs.push(tracks.push(audioSource$).subscribe({
      next:(meta)=>{ share.audioMeta=meta; log(`audio published (${meta.trackName})`); announce().catch(err=>log(`audio announce failed: ${err.message}`,'warn')); },
      error:(err)=>{ log(`audio publish failed: ${err?.message || err}`,'warn'); toast('Video is live, but shared audio failed to publish.'); }
    }));
    audioSource$.next(audioTrack);
  }
  videoSource$.next(videoTrack);
  setTimeout(()=>{ if (state.share===share && !share.videoMeta) { log('no publish confirmation after 15s','error'); toast('Publishing stalled. Open Activity log for details.'); } },15000);
}

function setSharingUi(sharing) {
  $('shareBtn').classList.toggle('hidden',sharing); $('stopBtn').classList.toggle('hidden',!sharing);
  $('quality').disabled=sharing; $('contentHint').disabled=sharing; $('withAudio').disabled=sharing;
}
async function stopShare() {
  const share=state.share; if(!share)return; state.share=null; state.reannounce=null;
  for(const sub of share.subs){try{sub.unsubscribe();}catch{}} try{share.encodings$?.complete();}catch{}
  share.media.getTracks().forEach(t=>{try{t.stop();}catch{}}); removeTile(share.streamId); setSharingUi(false); setStatus('Connected','ok');
  try{await apiCall(`/api/rooms/${state.roomId}/stream/remove`,{method:'POST',body:envelope({streamId:share.streamId})});}catch(err){log(`stop announce failed: ${err.message}`,'warn');}
  log('stopped sharing');
}

const sameTarget=(a,b)=>a&&b&&a.sessionId===b.sessionId&&a.videoTrackName===b.videoTrackName&&a.audioTrackName===b.audioTrackName;
async function addStream(ann){ if(state.joining.has(ann.id))return; state.joining.add(ann.id); try{await addStreamInner(ann);}finally{state.joining.delete(ann.id);} }
async function addStreamInner(ann){
  state.streams.set(ann.id,ann); if(ann.ownerId===state.participantId){renderPeople();return;}
  const ready=Boolean(ann.sessionId&&ann.videoTrackName); const existing=state.subs.get(ann.id);
  if(!state.watching.has(ann.id)){ if(existing)await teardownSubscription(ann.id,{keepTile:true}); showIdleTile(ann,ready); renderPeople(); return; }
  if(existing){ if(sameTarget(existing.target,ann)){renderPeople();return;} log(`${ann.ownerName} media changed — resubscribing`,'warn'); await teardownSubscription(ann.id,{keepTile:true}); }
  if(!ready){showIdleTile(ann,false);renderPeople();return;} await subscribe(ann); renderPeople();
}
async function subscribe(ann){
  log(`watching ${ann.ownerName}`); const tracks=initTracks(); const videoMedia=new MediaStream();
  const entry={videoMedia,audioMedia:null,subs:[],stall:null,target:{sessionId:ann.sessionId,videoTrackName:ann.videoTrackName,audioTrackName:ann.audioTrackName},strikes:0}; state.subs.set(ann.id,entry);
  const tile=showLiveTile(ann,videoMedia); tile.note.textContent='Connecting…'; tile.note.classList.remove('hidden');
  entry.stall=setTimeout(()=>{if(videoMedia.getVideoTracks().length)return;log(`no video from ${ann.ownerName} after 15s`,'error');tile.note.textContent='No video after 15s — media path stalled. Retrying automatically.';},15000);
  entry.subs.push(tracks.pull(of({trackName:ann.videoTrackName,sessionId:ann.sessionId,location:'remote'})).subscribe({
    next:(track)=>{clearTimeout(entry.stall);for(const old of videoMedia.getVideoTracks())videoMedia.removeTrack(old);videoMedia.addTrack(track);tile.video.srcObject=videoMedia;tile.video.play().catch(()=>{});tile.note.classList.add('hidden');tile.lastFrameAt=Date.now();log(`receiving video from ${ann.ownerName}`);},
    error:(err)=>{clearTimeout(entry.stall);log(`video pull failed for ${ann.ownerName}: ${err?.message||err}`,'error');tile.note.textContent=`Video failed: ${err?.message||err}`;tile.note.classList.remove('hidden');}
  }));
  if(ann.audioTrackName){
    entry.subs.push(tracks.pull(of({trackName:ann.audioTrackName,sessionId:ann.sessionId,location:'remote'})).subscribe({
      next:(track)=>{ entry.audioMedia=new MediaStream([track]); tile.audio.srcObject=entry.audioMedia; tile.audioBtn.classList.remove('hidden'); tile.audioBtn.textContent=state.audioUnlocked?'🔊':'🔇'; tile.audio.muted=!state.audioUnlocked; if(state.audioUnlocked) tile.audio.play().catch(()=>{}); log(`receiving shared audio from ${ann.ownerName}`); },
      error:(err)=>{log(`audio pull failed for ${ann.ownerName}: ${err?.message||err}`,'warn');tile.audioBtn.classList.remove('hidden');tile.audioBtn.textContent='⚠';}
    }));
  }
}
async function watchStream(streamId){const ann=state.streams.get(streamId);if(!ann||state.watching.has(streamId)||state.budgetBlocked)return;state.watching.add(streamId);reportWatching();await addStream(ann);}
async function unwatchStream(streamId){if(!state.watching.has(streamId))return;const ann=state.streams.get(streamId);state.watching.delete(streamId);reportWatching();await teardownSubscription(streamId,{keepTile:true});if(ann)showIdleTile(ann,Boolean(ann.sessionId&&ann.videoTrackName));log(`stopped watching ${ann?.ownerName||streamId}`);}
async function teardownSubscription(streamId,{keepTile=false}={}){const entry=state.subs.get(streamId);if(entry){clearTimeout(entry.stall);for(const sub of entry.subs){try{sub.unsubscribe();}catch{}}state.subs.delete(streamId);}const tile=state.tiles.get(streamId);if(tile){try{tile.video.srcObject=null;tile.audio.srcObject=null;}catch{}if(!keepTile)removeTile(streamId);}}
async function dropStream(streamId,{silent=false}={}){const ann=state.streams.get(streamId);state.streams.delete(streamId);if(state.watching.delete(streamId))reportWatching();await teardownSubscription(streamId);removeTile(streamId);if(!silent&&ann&&ann.ownerId!==state.participantId)log(`${ann.ownerName} stopped sharing`);renderPeople();}

function ensureTile(ann,isLocal=false){
  let entry=state.tiles.get(ann.id);if(entry)return entry;
  const card=document.createElement('div');card.className=`tile${isLocal?' local':''}`;
  card.innerHTML=`<video autoplay playsinline muted></video><audio autoplay></audio><div class="tile-idle hidden"><div class="idle-avatar"></div><div class="idle-name"></div><div class="idle-sub"></div><button class="primary idle-watch">Watch stream</button></div><div class="tile-note hidden"></div><div class="tile-bar"><span class="tile-name"></span><span class="tile-actions"><span class="tile-meta"></span><button class="tile-action-btn tile-audio hidden" title="Shared audio">🔇</button><button class="tile-action-btn tile-stop hidden">Close</button></span></div>`;
  entry={card,video:card.querySelector('video'),audio:card.querySelector('audio'),audioBtn:card.querySelector('.tile-audio'),note:card.querySelector('.tile-note'),idle:card.querySelector('.tile-idle'),statsTimer:null,chromeTimer:null,lastFrameAt:0};
  const revealChrome=()=>{if(card.classList.contains('idle'))return;card.classList.add('chrome-visible');clearTimeout(entry.chromeTimer);entry.chromeTimer=setTimeout(()=>card.classList.remove('chrome-visible'),1600);};
  card.addEventListener('pointerenter',revealChrome);card.addEventListener('pointermove',revealChrome);card.addEventListener('pointerleave',()=>{clearTimeout(entry.chromeTimer);card.classList.remove('chrome-visible');});
  entry.audio.muted=true;
  card.querySelector('.idle-watch').addEventListener('click',e=>{e.stopPropagation();watchStream(ann.id).catch(err=>log(err.message,'error'));});
  card.querySelector('.tile-stop').addEventListener('click',e=>{e.stopPropagation();unwatchStream(ann.id).catch(err=>log(err.message,'error'));});
  entry.audioBtn.addEventListener('click',e=>{e.stopPropagation();toggleTileAudio(ann.id);});
  card.addEventListener('click',()=>{if(!card.classList.contains('idle'))card.classList.toggle('big');});
  $('grid').appendChild(card);state.tiles.set(ann.id,entry);renderGrid();return entry;
}
function showIdleTile(ann,ready){const e=ensureTile(ann,false);clearInterval(e.statsTimer);e.statsTimer=null;e.video.srcObject=null;e.audio.srcObject=null;e.card.classList.add('idle');e.card.classList.remove('big');e.note.classList.add('hidden');e.idle.classList.remove('hidden');e.card.querySelector('.tile-stop').classList.add('hidden');e.audioBtn.classList.add('hidden');const name=ann.ownerName||'Someone';e.idle.querySelector('.idle-avatar').textContent=name.slice(0,1).toUpperCase();e.idle.querySelector('.idle-name').textContent=name;e.idle.querySelector('.idle-sub').textContent=ready?`${(QUALITY[ann.profile]||QUALITY['720p60']).label}${ann.audio?' · Audio':''}`:'Starting…';const b=e.idle.querySelector('.idle-watch');b.disabled=!ready||state.budgetBlocked;b.textContent=ready?'Watch Stream':'Starting…';e.card.querySelector('.tile-name').textContent=`${name} is live`;e.card.querySelector('.tile-meta').textContent='';return e;}
function showLiveTile(ann,media){const e=ensureTile(ann,false);e.card.classList.remove('idle');e.idle.classList.add('hidden');e.card.querySelector('.tile-stop').classList.remove('hidden');e.video.srcObject=media;e.video.muted=true;e.video.play().catch(()=>{});e.card.querySelector('.tile-name').textContent=ann.ownerName||'Someone';e.lastFrameAt=0;clearInterval(e.statsTimer);startTileStats(e,ann);return e;}
function showLocalTile(ann,media){const e=ensureTile(ann,true);e.card.classList.remove('idle');e.idle.classList.add('hidden');e.card.querySelector('.tile-stop').classList.add('hidden');e.audioBtn.classList.add('hidden');e.video.srcObject=media;e.video.muted=true;e.video.play().catch(()=>{});e.card.querySelector('.tile-name').textContent=ann.ownerName;e.lastFrameAt=Date.now();clearInterval(e.statsTimer);startTileStats(e,ann);return e;}
function startTileStats(e,ann){const meta=e.card.querySelector('.tile-meta');const fallback=(QUALITY[ann.profile]||QUALITY['720p60']).label;let frames=0,last=performance.now();const onFrame=()=>{if(!state.tiles.has(ann.id))return;frames++;e.lastFrameAt=Date.now();e.video.requestVideoFrameCallback?.(onFrame);};e.video.requestVideoFrameCallback?.(onFrame);e.statsTimer=setInterval(()=>{if(!state.tiles.has(ann.id)){clearInterval(e.statsTimer);return;}const now=performance.now(),fps=Math.round(frames*1000/Math.max(1,now-last));frames=0;last=now;const w=e.video.videoWidth,h=e.video.videoHeight;meta.textContent=w?`${w}x${h} · ${fps} FPS${ann.audio?' · Audio':''}`:fallback;if(fps>0)e.lastFrameAt=Date.now();},2000);}
function removeTile(id){const e=state.tiles.get(id);if(!e)return;clearInterval(e.statsTimer);clearTimeout(e.chromeTimer);try{e.video.srcObject=null;e.audio.srcObject=null;}catch{}e.card.remove();state.tiles.delete(id);renderGrid();}
function renderGrid(){const count=state.tiles.size;$('empty').classList.toggle('hidden',count>0);$('grid').classList.toggle('hidden',count===0);$('grid').classList.remove('count-1','count-2','count-many');$('grid').classList.add(count===1?'count-1':count===2?'count-2':'count-many');}
function renderPeople(){const owners=new Set([...state.streams.values()].map(s=>s.ownerId));$('peopleCount').textContent=String(state.people.size);const list=$('people');list.innerHTML='';for(const p of state.people.values()){const row=document.createElement('div');row.className='person';const you=p.id===state.participantId?' (you)':'';const initial=(p.name||'?').slice(0,1).toUpperCase();row.innerHTML=`<span class="person-avatar${owners.has(p.id)?' live':''}">${escapeHtml(initial)}</span><span class="person-name">${escapeHtml(p.name)}${you}</span>`;list.appendChild(row);}const me=state.people.get(state.participantId);if(me)$('myName').value=me.name;$('myName').closest('.member-footer')?.querySelector('.me-avatar')?.replaceChildren(document.createTextNode((state.name||'Y').slice(0,1).toUpperCase()));}

function toggleTileAudio(id){const tile=state.tiles.get(id);if(!tile||!tile.audio.srcObject)return;state.audioUnlocked=true;tile.audio.muted=!tile.audio.muted;if(!tile.audio.muted)tile.audio.play().catch(()=>{});tile.audioBtn.textContent=tile.audio.muted?'🔇':'🔊';tile.audioBtn.classList.toggle('on',!tile.audio.muted);refreshGlobalAudioButton();}
function enableAllAudio(){state.audioUnlocked=true;let count=0;for(const [id,tile] of state.tiles){if(!state.subs.has(id)||!tile.audio.srcObject)continue;tile.audio.muted=false;tile.audio.play().catch(()=>{});tile.audioBtn.textContent='🔊';tile.audioBtn.classList.add('on');count++;}refreshGlobalAudioButton();toast(count?`Shared audio enabled for ${count} stream${count===1?'':'s'}.`:'No watched stream is sharing audio right now.');}
function refreshGlobalAudioButton(){const active=[...state.tiles.entries()].some(([id,t])=>state.subs.has(id)&&t.audio.srcObject&&!t.audio.muted);$('audioBtn').classList.toggle('audio-enabled',active);$('audioBtn').textContent=active?'🔊':'🔇';}

async function watchdog(){
  if(state.leaving||state.budgetBlocked)return;
  for(const [streamId,entry] of [...state.subs]){
    if(!state.watching.has(streamId))continue;const ann=state.streams.get(streamId),tile=state.tiles.get(streamId);if(!ann||!tile||!entry.target?.sessionId)continue;
    const alive=tile.lastFrameAt&&(Date.now()-tile.lastFrameAt<12000);if(alive){entry.strikes=0;continue;}if(!tile.lastFrameAt)continue;entry.strikes=(entry.strikes||0)+1;if(entry.strikes<2)continue;
    entry.strikes=0;log(`no frames from ${ann.ownerName} — rebuilding subscription without dropping watch state`,'warn');
    // IMPORTANT: do not call dropStream here. dropStream removes state.watching,
    // which made the old watchdog silently turn a frozen live tile into an idle tile.
    await teardownSubscription(streamId,{keepTile:true});
    if(state.watching.has(streamId)&&state.streams.has(streamId))await subscribe(state.streams.get(streamId));
  }
}

function estimateEgress(){let bps=0;for(const id of state.watching){const s=state.streams.get(id);if(s)bps+=(QUALITY[s.profile]||QUALITY['720p60']).bitrate;}return bps;}
async function tickBudget(){const bps=estimateEgress(),gbph=(bps/8)*3600/1e9;let budget=state.budget;try{budget=await apiCall('/api/budget');state.budget=budget;}catch{}const el=$('budget');if(!budget){el.textContent='idle';return;}const pct=budget.percent??0;el.textContent=`${budget.usedGb.toFixed(1)} / ${budget.capGb} GB${bps?` · ${gbph.toFixed(1)} GB/h`:''}`;el.className=`budget ${budget.blocked||pct>=95?'bad':pct>=75?'warn':''}`;applyBudgetBlock(Boolean(budget.blocked),budget);}
function applyBudgetBlock(blocked,budget){if(blocked===state.budgetBlocked)return;state.budgetBlocked=blocked;$('shareBtn').disabled=blocked||!state.participantId;$('budgetBanner').classList.toggle('hidden',!blocked);if(blocked){$('budgetBanner').textContent=`Bandwidth cap reached: ${budget.usedGb.toFixed(1)} of ${budget.capGb} GB used in the last ${budget.windowDays} days. New media is paused to protect the account.`;if(state.share)stopShare().catch(()=>{});}for(const [id,t] of state.tiles){if(!t.card.classList.contains('idle'))continue;const a=state.streams.get(id),b=t.idle.querySelector('.idle-watch');b.disabled=blocked||!(a?.sessionId&&a?.videoTrackName);}}
async function poll(){if(state.leaving||!state.participantId)return;try{const snap=await apiCall(`/api/rooms/${state.roomId}/snapshot`);state.people=new Map((snap.participants||[]).map(p=>[p.id,p]));const incoming=new Map((snap.streams||[]).map(s=>[s.id,s]));for(const id of [...state.streams.keys()])if(!incoming.has(id))await dropStream(id);for(const s of incoming.values()){const sub=state.subs.get(s.id);const correct=s.ownerId===state.participantId||(sub&&sameTarget(sub.target,s));if(!correct||!state.streams.has(s.id))await addStream(s);else state.streams.set(s.id,s);}renderPeople();}catch{}}

function applySidebar(hidden){$('room').classList.toggle('no-members',hidden);try{localStorage.setItem('simpleshare-hide-members',hidden?'1':'0');}catch{}}
function leaveRoom(){state.leaving=true;clearSocketTimers();clearInterval(state.pollTimer);clearInterval(state.watchdogTimer);clearInterval(state.budgetTimer);stopShare().catch(()=>{});try{state.ws?.close();}catch{}location.href='/';}
async function boot(){
  const params=new URLSearchParams(location.search);if(params.get('debug')==='1'){setLogLevel('debug');$('logPanel').classList.add('open');}
  const config=await fetch('/api/config').then(r=>r.json()).catch(()=>({roomApiUrl:''}));state.apiBase=normalizeBase(config.roomApiUrl);const roomId=params.get('room');
  if(!roomId){$('home').classList.remove('hidden');return;}if(!state.apiBase){$('home').classList.remove('hidden');toast('ROOM_API_URL is not set in Vercel.');return;}
  state.roomId=roomId;state.name=localStorage.getItem('simpleshare-name')||`Guest ${randomId(1).toUpperCase()}`;$('room').classList.remove('hidden');$('inviteLink').value=location.href;$('myName').value=state.name;try{applySidebar(localStorage.getItem('simpleshare-hide-members')==='1');}catch{}
  setStatus('Connecting','warn');log(`room ${roomId}`);
  try{const health=await apiCall('/health');log(`backend ok (build ${health.build})`);if(!health.realtimeConfigured)throw new Error('Worker is missing Cloudflare Realtime credentials.');}catch(err){log(`backend check failed: ${err.message}`,'error');setStatus('Backend down','bad');$('logPanel').classList.add('open');return;}
  try{await joinRoom();await connectSocket();initTracks();renderPeople();renderGrid();state.pollTimer=setInterval(()=>poll().catch(()=>{}),3000);state.watchdogTimer=setInterval(()=>watchdog().catch(err=>log(`watchdog: ${err.message}`,'warn')),8000);state.budgetTimer=setInterval(()=>tickBudget().catch(()=>{}),15000);tickBudget().catch(()=>{});}catch(err){log(`could not join: ${err.message}`,'error');setStatus('Join failed','bad');$('logPanel').classList.add('open');}
}

$('createBtn')?.addEventListener('click',()=>{const u=new URL(location.href);u.search='';u.searchParams.set('room',randomId(12));location.href=u.toString();});
$('shareBtn')?.addEventListener('click',()=>startShare().catch(err=>log(err.message,'error')));$('stopBtn')?.addEventListener('click',()=>stopShare());
$('settingsBtn')?.addEventListener('click',()=>$('settingsPanel').classList.toggle('hidden'));
$('membersBtn')?.addEventListener('click',()=>applySidebar(!$('room').classList.contains('no-members')));
$('audioBtn')?.addEventListener('click',enableAllAudio);
$('copyBtn')?.addEventListener('click',async()=>{await navigator.clipboard.writeText($('inviteLink').value).catch(()=>{});toast('Invite link copied');});
$('copyBtnSettings')?.addEventListener('click',async()=>{await navigator.clipboard.writeText($('inviteLink').value).catch(()=>{});toast('Invite link copied');});
$('myName')?.addEventListener('change',(e)=>{const next=String(e.target.value||'').trim().slice(0,28);if(!next)return;state.name=next;localStorage.setItem('simpleshare-name',next);if(state.ws?.readyState===WebSocket.OPEN)state.ws.send(JSON.stringify({type:'rename',name:next}));renderPeople();});
$('quality')?.addEventListener('change',()=>{const q=QUALITY[$('quality').value];log(`quality set to ${q.label}`);});
$('leaveBtn')?.addEventListener('click',leaveRoom);$('leaveDockBtn')?.addEventListener('click',leaveRoom);$('logToggle')?.addEventListener('click',()=>$('logPanel').classList.toggle('open'));
window.addEventListener('beforeunload',()=>{state.leaving=true;clearSocketTimers();try{state.ws?.close();}catch{}});

boot();
