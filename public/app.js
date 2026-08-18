const { Room, RoomEvent, Track, VideoQuality } = window.LivekitClient;

const els = {
  home: document.querySelector('#home'), room: document.querySelector('#room'), createRoom: document.querySelector('#createRoom'),
  leaveRoom: document.querySelector('#leaveRoom'), statusPill: document.querySelector('#statusPill'), statusText: document.querySelector('#statusPill b'),
  participantCount: document.querySelector('#participantCount'), shareScreen: document.querySelector('#shareScreen'), emptyShareButton: document.querySelector('#emptyShareButton'),
  stopSharing: document.querySelector('#stopSharing'), inviteLink: document.querySelector('#inviteLink'), copyInvite: document.querySelector('#copyInvite'),
  peopleList: document.querySelector('#peopleList'), emptyState: document.querySelector('#emptyState'), streamGrid: document.querySelector('#streamGrid'),
  focusView: document.querySelector('#focusView'), focusMount: document.querySelector('#focusMount'), backToGrid: document.querySelector('#backToGrid'),
  endedPanel: document.querySelector('#endedPanel'), audioUnlock: document.querySelector('#audioUnlock'), toast: document.querySelector('#toast'),
  streamCardTemplate: document.querySelector('#streamCardTemplate'), shareQuality: document.querySelector('#shareQuality'), includeAudio: document.querySelector('#includeAudio'),
  qualityCost: document.querySelector('#qualityCost'),
};

const PROFILES = {
  '720p30': { label: '720p · 30 FPS', width: 1280, height: 720, fps: 30, bitrate: 1_800_000, estimate: '~0.8 GB/viewer/hour max', layers: [{ width: 640, height: 360, encoding: { maxBitrate: 350_000, maxFramerate: 15 } }] },
  '720p60': { label: '720p · 60 FPS', width: 1280, height: 720, fps: 60, bitrate: 3_000_000, estimate: '~1.35 GB/viewer/hour max', layers: [{ width: 640, height: 360, encoding: { maxBitrate: 500_000, maxFramerate: 20 } }] },
  '1080p60': { label: '1080p · 60 FPS', width: 1920, height: 1080, fps: 60, bitrate: 5_500_000, estimate: '~2.5 GB/viewer/hour max', layers: [
    { width: 640, height: 360, encoding: { maxBitrate: 350_000, maxFramerate: 15 } },
    { width: 1280, height: 720, encoding: { maxBitrate: 1_800_000, maxFramerate: 30 } },
  ] },
};

const state = { roomId: null, livekit: null, identity: null, streams: new Map(), audioTracks: new Map(), focusedKey: null, statsTimer: null, localShare: null };

function show(view) { els.home.classList.toggle('active', view === 'home'); els.room.classList.toggle('active', view === 'room'); }
function setStatus(text, mode='') { els.statusText.textContent = text; els.statusPill.classList.remove('connected','sharing','reconnecting'); if (mode) els.statusPill.classList.add(mode); }
function toast(text) { els.toast.textContent = text; els.toast.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => els.toast.classList.remove('show'), 2200); }
function makeRoomId() { const bytes = crypto.getRandomValues(new Uint8Array(18)); return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''); }
function shortIdentity(identity) { const clean = (identity || '').replaceAll('-',''); return `Guest ${clean.slice(0,4).toUpperCase() || 'USER'}`; }
function participantLabel(p) { if (!p) return 'Guest'; if (p === state.livekit?.localParticipant) return 'You'; return p.name || shortIdentity(p.identity); }
function participantInitial(p) { const s = participantLabel(p); return s === 'You' ? 'Y' : s.replace('Guest ','').slice(0,2); }
function streamKey(p, pub) { return `${p.identity}:${pub.trackSid || pub.trackName || 'screen'}`; }
function isLocalSharing() { return Boolean(state.localShare); }
function profileFromPublication(pub) { const match = String(pub?.trackName || '').match(/^screen:(720p30|720p60|1080p60)$/); return PROFILES[match?.[1]] || PROFILES['720p30']; }

function updateQualityCost() { els.qualityCost.textContent = PROFILES[els.shareQuality.value]?.estimate || ''; }
els.shareQuality.addEventListener('change', updateQualityCost); updateQualityCost();

function updateShellUi() {
  if (!state.livekit) return;
  const count = state.livekit.remoteParticipants.size + 1, streamCount = state.streams.size, localSharing = isLocalSharing();
  els.participantCount.textContent = `${count} ${count === 1 ? 'person' : 'people'}`;
  els.shareScreen.classList.toggle('hidden', localSharing); els.stopSharing.classList.toggle('hidden', !localSharing); els.emptyShareButton.disabled = localSharing;
  els.shareQuality.disabled = localSharing; els.includeAudio.disabled = localSharing;
  if (localSharing) setStatus(`You’re live · ${streamCount} ${streamCount === 1 ? 'stream' : 'streams'}`, 'sharing');
  else if (streamCount) setStatus(`${streamCount} live ${streamCount === 1 ? 'stream' : 'streams'}`, 'sharing'); else setStatus('Room ready','connected');
  renderPeople(); renderStreamLayout();
}

function renderPeople() {
  if (!state.livekit) return;
  const participants = [state.livekit.localParticipant, ...state.livekit.remoteParticipants.values()]; els.peopleList.replaceChildren();
  for (const p of participants) {
    const item = document.createElement('div'); item.className = 'person-row';
    item.innerHTML = `<span class="person-avatar">${participantInitial(p)}</span><span class="person-name">${participantLabel(p)}</span>${p.isScreenShareEnabled ? '<span class="person-live">LIVE</span>' : '<span class="person-dot"></span>'}`;
    els.peopleList.appendChild(item);
  }
}

function renderStreamLayout() {
  const has = state.streams.size > 0, focused = Boolean(state.focusedKey && state.streams.has(state.focusedKey));
  els.endedPanel.classList.add('hidden'); els.emptyState.classList.toggle('hidden', has || focused); els.streamGrid.classList.toggle('hidden', !has || focused); els.focusView.classList.toggle('hidden', !focused);
  if (!focused) { els.streamGrid.classList.toggle('single-stream', state.streams.size === 1); els.streamGrid.classList.toggle('two-streams', state.streams.size === 2); }
  syncRemoteDelivery();
}

function applyViewerQuality(entry) {
  if (entry.isLocal || typeof entry.publication?.setVideoQuality !== 'function') return;
  const choice = entry.viewerQuality || 'auto';
  let q = VideoQuality.HIGH;
  if (choice === 'low') q = VideoQuality.LOW;
  if (choice === 'medium') q = VideoQuality.MEDIUM;
  entry.publication.setVideoQuality(q);
}

function syncRemoteDelivery() {
  for (const [key, entry] of state.streams) {
    if (entry.isLocal || typeof entry.publication?.setEnabled !== 'function') continue;
    const enabled = !state.focusedKey || state.focusedKey === key;
    entry.publication.setEnabled(enabled);
    if (enabled) applyViewerQuality(entry);
  }
}

function makeStreamCard(key, participant, track, publication, isLocal=false) {
  const fragment = els.streamCardTemplate.content.cloneNode(true), card = fragment.querySelector('.stream-card'), video = fragment.querySelector('video');
  const loading = fragment.querySelector('.stream-loading'), title = fragment.querySelector('.stream-copy strong'), avatar = fragment.querySelector('.stream-avatar');
  const expand = fragment.querySelector('.expand-stream'), quality = fragment.querySelector('.quality-badge'), qualitySelect = fragment.querySelector('.viewer-quality');
  const profile = profileFromPublication(publication);
  card.dataset.streamKey = key; title.textContent = isLocal ? 'Your stream' : `${participantLabel(participant)}’s stream`; avatar.textContent = participantInitial(participant); quality.textContent = profile.label;
  video.muted = isLocal; track.attach(video); video.addEventListener('loadeddata', () => loading.classList.add('hidden')); video.play().catch(() => {});
  expand.addEventListener('click', e => { e.stopPropagation(); focusStream(key); }); card.querySelector('.stream-video-wrap').addEventListener('dblclick', () => focusStream(key));
  if (isLocal) qualitySelect.classList.add('hidden');
  else {
    if (profile.height < 1080) qualitySelect.querySelector('option[value="high1080"]')?.remove();
    qualitySelect.addEventListener('change', () => {
      const entry = state.streams.get(key); if (!entry) return;
      entry.viewerQuality = qualitySelect.value === '360' ? 'low' : qualitySelect.value === '720' && profile.height >= 1080 ? 'medium' : 'auto';
      if (qualitySelect.value === '1080') entry.viewerQuality = 'auto';
      applyViewerQuality(entry);
    });
  }
  return { key, participant, publication, track, card, video, isLocal, viewerQuality: 'auto', profile };
}

function addStream(participant, track, publication, isLocal=false) {
  if (!track || track.kind !== Track.Kind.Video || publication.source !== Track.Source.ScreenShare) return;
  const key = streamKey(participant, publication), existing = state.streams.get(key); if (existing?.track === track) return; if (existing) removeStream(key);
  const entry = makeStreamCard(key, participant, track, publication, isLocal); state.streams.set(key, entry); els.streamGrid.appendChild(entry.card); updateShellUi();
}
function removeStream(key) { const e = state.streams.get(key); if (!e) return; try { e.track.detach(e.video); } catch {} e.card.remove(); state.streams.delete(key); if (state.focusedKey === key) { state.focusedKey = null; els.focusMount.replaceChildren(); } updateShellUi(); }
function removeStreamsForParticipant(p) { for (const [k,e] of [...state.streams]) if (e.participant.identity === p.identity) removeStream(k); removeAudioForParticipant(p); }
function focusStream(key) { const e = state.streams.get(key); if (!e) return; state.focusedKey = key; els.focusMount.replaceChildren(e.card); e.card.classList.add('focused-card'); renderStreamLayout(); }
function returnToGrid() { const e = state.streams.get(state.focusedKey); if (e) { e.card.classList.remove('focused-card'); els.streamGrid.appendChild(e.card); } state.focusedKey = null; els.focusMount.replaceChildren(); renderStreamLayout(); }

function addRemoteAudio(participant, track, publication) { const key = `${participant.identity}:${publication.trackSid || 'audio'}`; removeAudio(key); const audio = document.createElement('audio'); audio.autoplay = true; audio.playsInline = true; audio.hidden = true; document.body.appendChild(audio); track.attach(audio); state.audioTracks.set(key,{participant,track,audio}); audio.play().catch(() => els.audioUnlock.classList.remove('hidden')); }
function removeAudio(key) { const e = state.audioTracks.get(key); if (!e) return; try { e.track.detach(e.audio); } catch {} e.audio.remove(); state.audioTracks.delete(key); }
function removeAudioForParticipant(p) { for (const [k,e] of [...state.audioTracks]) if (e.participant.identity === p.identity) removeAudio(k); }

function resyncPublishedScreens() {
  if (!state.livekit) return;
  const participants = [state.livekit.localParticipant, ...state.livekit.remoteParticipants.values()], liveKeys = new Set();
  for (const p of participants) for (const pub of p.trackPublications.values()) {
    if (pub.source !== Track.Source.ScreenShare || pub.isMuted) continue; const key = streamKey(p,pub); liveKeys.add(key); if (pub.track && !state.streams.has(key)) addStream(p,pub.track,pub,p === state.livekit.localParticipant);
  }
  for (const key of [...state.streams.keys()]) if (!liveKeys.has(key)) removeStream(key); updateShellUi();
}

async function fetchJoinToken(roomId) { const r = await fetch('/api/token',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({room:roomId})}); const b = await r.json().catch(()=>({})); if (!r.ok) throw new Error(b.error || 'Could not enter the room.'); return b; }

function wireRoom(room) {
  room.on(RoomEvent.ParticipantConnected,()=>{ updateShellUi(); toast('Someone joined.'); });
  room.on(RoomEvent.ParticipantDisconnected,p=>{ removeStreamsForParticipant(p); updateShellUi(); });
  room.on(RoomEvent.TrackPublished,()=>queueMicrotask(resyncPublishedScreens));
  room.on(RoomEvent.TrackSubscribed,(track,pub,p)=>{ if (pub.source===Track.Source.ScreenShare && track.kind===Track.Kind.Video) { addStream(p,track,pub,false); toast(`${participantLabel(p)} started streaming.`); } if (pub.source===Track.Source.ScreenShareAudio && track.kind===Track.Kind.Audio) addRemoteAudio(p,track,pub); resyncPublishedScreens(); });
  room.on(RoomEvent.TrackUnsubscribed,(track,pub,p)=>{ if (pub.source===Track.Source.ScreenShare) removeStream(streamKey(p,pub)); if (pub.source===Track.Source.ScreenShareAudio) removeAudio(`${p.identity}:${pub.trackSid||'audio'}`); resyncPublishedScreens(); });
  room.on(RoomEvent.TrackUnpublished,(pub,p)=>{ if (pub.source===Track.Source.ScreenShare) removeStream(streamKey(p,pub)); if (pub.source===Track.Source.ScreenShareAudio) removeAudio(`${p.identity}:${pub.trackSid||'audio'}`); resyncPublishedScreens(); });
  room.on(RoomEvent.LocalTrackPublished,(pub,p)=>{ if (pub.source===Track.Source.ScreenShare && pub.track) addStream(p,pub.track,pub,true); resyncPublishedScreens(); });
  room.on(RoomEvent.LocalTrackUnpublished,(pub,p)=>{ if (pub.source===Track.Source.ScreenShare) removeStream(streamKey(p,pub)); resyncPublishedScreens(); });
  room.on(RoomEvent.TrackMuted,()=>resyncPublishedScreens()); room.on(RoomEvent.TrackUnmuted,()=>resyncPublishedScreens());
  room.on(RoomEvent.Reconnecting,()=>setStatus('Reconnecting…','reconnecting')); room.on(RoomEvent.Reconnected,()=>{resyncPublishedScreens();toast('Connection restored.');});
  room.on(RoomEvent.Disconnected,()=>{ if (state.livekit) setStatus('Disconnected'); });
}

async function connectRoom(roomId) {
  const auth = await fetchJoinToken(roomId); const room = new Room({ adaptiveStream: { pauseVideoInBackground: true }, dynacast: true, disconnectOnPageLeave: true });
  state.livekit = room; state.identity = auth.identity; wireRoom(room); await room.connect(auth.url,auth.token,{autoSubscribe:true}); resyncPublishedScreens(); startStatsLoop();
}

async function startSharing() {
  if (!state.livekit || isLocalSharing()) return;
  const profileKey = els.shareQuality.value, profile = PROFILES[profileKey] || PROFILES['720p30'];
  let media = null;
  try {
    setStatus('Choose what to share…','sharing');
    media = await navigator.mediaDevices.getDisplayMedia({ video: { width: { ideal: profile.width, max: profile.width }, height: { ideal: profile.height, max: profile.height }, frameRate: { ideal: profile.fps, max: profile.fps } }, audio: Boolean(els.includeAudio.checked) });
    const videoTrack = media.getVideoTracks()[0]; if (!videoTrack) throw new Error('No screen track was selected.');
    const videoPub = await state.livekit.localParticipant.publishTrack(videoTrack,{ name:`screen:${profileKey}`, source:Track.Source.ScreenShare, simulcast:true, videoCodec:'vp8', degradationPreference:'maintain-resolution', screenShareEncoding:{maxBitrate:profile.bitrate,maxFramerate:profile.fps}, screenShareSimulcastLayers:profile.layers });
    let audioPub = null; const audioTrack = media.getAudioTracks()[0];
    if (audioTrack) audioPub = await state.livekit.localParticipant.publishTrack(audioTrack,{ name:`screen-audio:${profileKey}`, source:Track.Source.ScreenShareAudio });
    state.localShare = { media, videoTrack, audioTrack, videoPub, audioPub, profileKey };
    videoTrack.addEventListener('ended',()=>stopSharing(),{once:true});
    if (videoPub.track) addStream(state.livekit.localParticipant,videoPub.track,videoPub,true); updateShellUi();
  } catch (error) {
    console.error(error); if (media) for (const t of media.getTracks()) t.stop(); state.localShare = null; updateShellUi(); if (error?.name !== 'NotAllowedError') toast('Could not start screen sharing.');
  }
}

async function stopSharing() {
  const share = state.localShare; if (!state.livekit || !share) return; state.localShare = null;
  try { if (share.videoTrack) await state.livekit.localParticipant.unpublishTrack(share.videoTrack,true); } catch {}
  try { if (share.audioTrack) await state.livekit.localParticipant.unpublishTrack(share.audioTrack,true); } catch {}
  for (const t of share.media?.getTracks?.() || []) try { t.stop(); } catch {}
  resyncPublishedScreens(); updateShellUi();
}

function startStatsLoop() {
  clearInterval(state.statsTimer); state.statsTimer = setInterval(()=>{
    for (const entry of state.streams.values()) {
      const badge = entry.card.querySelector('.stream-network'), quality = entry.card.querySelector('.quality-badge'); const bitrate = Number(entry.track.currentBitrate || 0);
      badge.textContent = bitrate > 0 ? (bitrate >= 1e6 ? `${(bitrate/1e6).toFixed(1)} Mbps` : `${Math.round(bitrate/1000)} kbps`) : 'Live';
      const h = entry.video.videoHeight; if (h) quality.textContent = `${h}p · ${entry.profile.fps} FPS cap`;
    }
  },2000);
}

async function leaveRoom() { clearInterval(state.statsTimer); try { if (isLocalSharing()) await stopSharing(); await state.livekit?.disconnect(); } catch {} for (const k of [...state.streams.keys()]) removeStream(k); for (const k of [...state.audioTracks.keys()]) removeAudio(k); state.livekit=null; state.focusedKey=null; els.emptyState.classList.add('hidden'); els.streamGrid.classList.add('hidden'); els.focusView.classList.add('hidden'); els.endedPanel.classList.remove('hidden'); setStatus('Room left'); }
async function enterRoom(roomId) { state.roomId=roomId; show('room'); els.endedPanel.classList.add('hidden'); els.emptyState.classList.remove('hidden'); const u=new URL(location.origin); u.searchParams.set('room',roomId); els.inviteLink.value=u.toString(); history.replaceState({},'',`${location.pathname}?room=${encodeURIComponent(roomId)}`); setStatus('Connecting…'); try { await connectRoom(roomId); } catch(e){ console.error(e); setStatus('Connection error'); toast(e.message || 'Could not connect to the room.'); } }

els.createRoom.addEventListener('click',()=>enterRoom(makeRoomId())); els.shareScreen.addEventListener('click',startSharing); els.emptyShareButton.addEventListener('click',startSharing); els.stopSharing.addEventListener('click',stopSharing); els.backToGrid.addEventListener('click',returnToGrid);
els.copyInvite.addEventListener('click',async()=>{ try { await navigator.clipboard.writeText(els.inviteLink.value); toast('Invite link copied.'); } catch { els.inviteLink.select(); document.execCommand('copy'); toast('Invite link copied.'); } });
els.audioUnlock.addEventListener('click',async()=>{ try { await state.livekit?.startAudio(); } catch {} for (const e of state.audioTracks.values()) await e.audio.play().catch(()=>{}); els.audioUnlock.classList.add('hidden'); });
els.leaveRoom.addEventListener('click',async()=>{ await leaveRoom(); history.replaceState({},'',location.pathname); });
const params=new URLSearchParams(location.search), roomId=params.get('room'); if (roomId && /^[a-zA-Z0-9_-]{20,80}$/.test(roomId)) enterRoom(roomId);
