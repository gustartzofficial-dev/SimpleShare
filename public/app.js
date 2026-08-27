import "webrtc-adapter";
import { PartyTracks, setLogLevel } from "partytracks/client";
import { ReplaySubject, BehaviorSubject, of } from "rxjs";

const $ = (id) => document.getElementById(id);


const THEMES = [
  { id:'default', name:'SimpleShare' },
  { id:'ios', name:'iOS Glass' },
  { id:'xp', name:'Windows XP' },
  { id:'win98', name:'Windows 98' },
  { id:'skype', name:'Old Skype' },
  { id:'terminal', name:'CRT Terminal' },
  { id:'aqua', name:'Mac OS X Aqua' },
  { id:'ps3', name:'PlayStation 3 XMB · Premium' },
  { id:'wii', name:'Wii Menu · Premium' },
  { id:'steam', name:'Steam Classic · Premium' },
  { id:'youtube', name:'YouTube 2012' },
  { id:'holo', name:'Android Holo' },
  { id:'ds', name:'Nintendo DS / DSi · Premium' },
];

const PREMIUM_THEMES = new Set(['ps3','wii','steam','ds']);
const premiumAnchors = new Map();

function premiumNodes() {
  const room = $('room');
  if (!room) return [];
  return [
    room.querySelector('.topbar'),
    room.querySelector('.stage'),
    room.querySelector('.people-panel'),
    room.querySelector('.call-dock'),
    $('settingsPanel'),
  ].filter(Boolean);
}

function ensurePremiumAnchors() {
  const room = $('room');
  if (!room || premiumAnchors.size) return;
  for (const node of premiumNodes()) {
    const anchor = document.createComment(`premium-anchor:${node.id || node.className}`);
    node.parentNode.insertBefore(anchor, node);
    premiumAnchors.set(node, anchor);
  }
}

function restorePremiumNodes() {
  for (const [node, anchor] of premiumAnchors) {
    if (anchor?.parentNode) anchor.parentNode.insertBefore(node, anchor.nextSibling);
  }
}

function buildPremiumShell(themeId) {
  const shell = document.createElement('section');
  shell.className = `premium-shell premium-${themeId}`;
  shell.dataset.premiumTheme = themeId;

  if (themeId === 'ps3') {
    shell.innerHTML = `
      <div class="ps3-premium-bg" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="ps3-premium-system">
        <div class="ps3-premium-clock">SimpleShare &nbsp; · &nbsp; LIVE ROOM</div>
        <div class="premium-slot premium-slot-top"></div>
      </div>
      <nav class="ps3-premium-xmb" aria-label="XMB themed navigation">
        <span><b>♙</b>Users</span><span><b>⚙</b>Settings</span><span><b>▧</b>Photo</span><span><b>♫</b>Music</span><span class="selected"><b>▶</b>Video</span><span><b>◇</b>Game</span><span><b>◎</b>Network</span><span><b>☻</b>Friends</span>
      </nav>
      <div class="ps3-premium-body">
        <aside class="ps3-premium-items" aria-hidden="true"><strong>SimpleShare</strong><span>Live Broadcast</span><span>Participants</span><span>Room Settings</span></aside>
        <div class="premium-slot premium-slot-stage"></div>
      </div>
      <div class="ps3-premium-lower"><div class="premium-slot premium-slot-people"></div><div class="premium-slot premium-slot-dock"></div></div>
      <div class="premium-slot premium-slot-settings"></div>`;
  } else if (themeId === 'wii') {
    shell.innerHTML = `
      <div class="wii-premium-top"><div class="premium-slot premium-slot-top"></div></div>
      <div class="wii-premium-channels" aria-hidden="true">
        <div><b>DISC</b><small>CHANNEL</small></div><div><b>Mii</b><small>CHANNEL</small></div><div><b>PHOTO</b><small>CHANNEL</small></div><div><b>SHOP</b><small>CHANNEL</small></div>
      </div>
      <div class="wii-premium-main"><div class="wii-live-label"><span>SimpleShare Channel</span><small>LIVE</small></div><div class="premium-slot premium-slot-stage"></div></div>
      <div class="wii-premium-secondary"><div class="premium-slot premium-slot-people"></div></div>
      <footer class="wii-premium-footer"><div class="wii-round">Wii</div><div class="premium-slot premium-slot-dock"></div><div class="wii-round">✉</div></footer>
      <div class="premium-slot premium-slot-settings"></div>`;
  } else if (themeId === 'steam') {
    shell.innerHTML = `
      <header class="steam-premium-title"><strong>SimpleShare</strong><span>View</span><span>Friends</span><span>Games</span><span>Help</span><div class="premium-slot premium-slot-top"></div></header>
      <nav class="steam-premium-nav" aria-label="Steam themed navigation"><b>STORE</b><b>LIBRARY</b><b>COMMUNITY</b><b class="selected">BROADCAST</b></nav>
      <div class="steam-premium-workspace">
        <aside class="steam-premium-sidebar"><div class="steam-library-title">FRIENDS & ROOMS</div><div class="premium-slot premium-slot-people"></div></aside>
        <main class="steam-premium-main"><div class="steam-broadcast-head"><small>NOW PLAYING</small><strong>SimpleShare Broadcast</strong><span>LIVE</span></div><div class="premium-slot premium-slot-stage"></div><div class="premium-slot premium-slot-dock"></div></main>
      </div>
      <div class="premium-slot premium-slot-settings"></div>`;
  } else if (themeId === 'ds') {
    shell.innerHTML = `
      <div class="ds-console" aria-label="Nintendo DSi inspired call layout">
        <section class="ds-half ds-top-half">
          <div class="ds-top-deck">
            <div class="ds-speaker ds-speaker-left" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
            <div class="ds-screen ds-top-screen">
              <div class="ds-status"><span>SimpleShare</span><b>LIVE</b><span>● ● ●</span></div>
              <div class="premium-slot premium-slot-stage"></div>
            </div>
            <div class="ds-speaker ds-speaker-right" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>
          </div>
          <span class="ds-camera" aria-hidden="true"></span>
        </section>
        <div class="ds-hinge" aria-hidden="true"><i></i><span>NINTENDO DSi</span><i></i></div>
        <section class="ds-half ds-bottom-half">
          <div class="ds-bottom-deck">
            <div class="ds-left-controls" aria-hidden="true">
              <div class="ds-dpad"><i class="up"></i><i class="right"></i><i class="down"></i><i class="left"></i><b></b></div>
            </div>
            <div class="ds-screen ds-touch-screen">
              <div class="premium-slot premium-slot-top"></div>
              <div class="ds-touch-body">
                <div class="premium-slot premium-slot-people"></div>
                <div class="premium-slot premium-slot-dock"></div>
              </div>
            </div>
            <div class="ds-right-controls" aria-hidden="true">
              <div class="ds-buttons"><b class="x">X</b><b class="a">A</b><b class="b">B</b><b class="y">Y</b></div>
            </div>
          </div>
          <div class="ds-lower-hardware" aria-hidden="true"><span>SELECT</span><i></i><span>START</span><i></i><b>POWER</b></div>
        </section>
      </div>
      <div class="premium-slot premium-slot-settings"></div>`;
  }
  return shell;
}

function mountPremiumTheme(themeId) {
  const room = $('room');
  if (!room) return;
  ensurePremiumAnchors();
  const old = room.querySelector(':scope > .premium-shell');
  if (old) { restorePremiumNodes(); old.remove(); }
  room.classList.remove('premium-mounted');
  if (!PREMIUM_THEMES.has(themeId)) return;

  const shell = buildPremiumShell(themeId);
  room.appendChild(shell);
  const top = room.querySelector('.topbar');
  const stage = room.querySelector('.stage');
  const people = room.querySelector('.people-panel');
  const dock = room.querySelector('.call-dock');
  const settings = $('settingsPanel');
  shell.querySelector('.premium-slot-top')?.appendChild(top);
  shell.querySelector('.premium-slot-stage')?.appendChild(stage);
  shell.querySelector('.premium-slot-people')?.appendChild(people);
  shell.querySelector('.premium-slot-dock')?.appendChild(dock);
  shell.querySelector('.premium-slot-settings')?.appendChild(settings);
  room.classList.add('premium-mounted');
}

function playThemeEntry(themeId) {
  const root = document.documentElement;
  const token = `theme-enter-${themeId}`;
  for (const cls of [...root.classList]) if (cls === 'theme-enter' || cls.startsWith('theme-enter-')) root.classList.remove(cls);
  void root.offsetWidth;
  root.classList.add('theme-enter', token);
  clearTimeout(playThemeEntry._t);
  playThemeEntry._t = setTimeout(() => root.classList.remove('theme-enter', token), 1100);
}

let windowsDesktopActive = false;
let desktopClockTimer = null;

function isWindowsDesktopTheme(themeId = document.documentElement.dataset.theme) {
  return themeId === 'xp' || themeId === 'win98';
}
function updateDesktopClock() {
  const clock = $('desktopClock');
  if (!clock) return;
  clock.textContent = new Date().toLocaleTimeString([], {hour:'numeric', minute:'2-digit'});
}
function minimizeToWindowsDesktop() {
  if (!isWindowsDesktopTheme()) return;
  const desktop = $('windowsDesktop');
  const room = $('room');
  if (!desktop || !room || room.classList.contains('hidden')) return;
  windowsDesktopActive = true;
  document.documentElement.classList.add('windows-desktop-active');
  desktop.classList.remove('hidden');
  room.classList.add('windows-app-minimized');
  $('desktopStartMenu')?.classList.add('hidden');
  $('desktopWindow')?.classList.add('hidden');
  updateDesktopClock();
  clearInterval(desktopClockTimer);
  desktopClockTimer = setInterval(updateDesktopClock, 30000);
  log(`SimpleShare minimized to ${document.documentElement.dataset.theme === 'xp' ? 'Windows XP' : 'Windows 98'} desktop`);
}
function restoreWindowsDesktop({silent=false}={}) {
  if (!windowsDesktopActive && $('windowsDesktop')?.classList.contains('hidden')) return;
  windowsDesktopActive = false;
  document.documentElement.classList.remove('windows-desktop-active');
  $('windowsDesktop')?.classList.add('hidden');
  $('room')?.classList.remove('windows-app-minimized');
  $('desktopStartMenu')?.classList.add('hidden');
  $('desktopWindow')?.classList.add('hidden');
  clearInterval(desktopClockTimer); desktopClockTimer = null;
  if (!silent) log('SimpleShare restored from desktop');
}
function toggleDesktopStartMenu() {
  $('desktopStartMenu')?.classList.toggle('hidden');
}
function desktopAppContent(app) {
  const xp = document.documentElement.dataset.theme === 'xp';
  const apps = {
    computer: {
      title:'My Computer',
      body:`<div class="fake-explorer-toolbar">Back &nbsp; Forward &nbsp; Up &nbsp; Search</div><div class="fake-drive-grid"><div>💾<strong>Local Disk (C:)</strong><small>${xp?'37.2 GB free':'1.44 MB definitely enough'}</small></div><div>📀<strong>SimpleShare (S:)</strong><small>Connected room</small></div><div>🖥️<strong>Shared Screens</strong><small>${state?.streams?.size ?? 0} live source(s)</small></div></div>`
    },
    documents: {
      title:'My Documents',
      body:`<div class="fake-explorer-toolbar">File &nbsp; Edit &nbsp; View &nbsp; Favorites</div><div class="fake-file-list"><div>📁 My Pictures</div><div>📁 My Music</div><div>📄 definitely_not_passwords.txt</div><div>📄 SimpleShare invite.url</div></div>`
    },
    internet: {
      title:'Internet Explorer',
      body:`<div class="fake-browser-bar">Address&nbsp; <span>http://simpleshare.local/</span></div><div class="fake-browser-page"><strong>Welcome to the Internet</strong><p>Your browser is already doing the hard part.</p><button type="button" data-desktop-restore="1">Return to SimpleShare</button></div>`
    },
    recycle: {
      title:'Recycle Bin',
      body:`<div class="fake-explorer-toolbar">File &nbsp; Edit &nbsp; View</div><div class="fake-recycle">🗑️<strong>Recycle Bin is empty.</strong><small>The PSP theme is not coming back.</small></div>`
    },
    shutdown: {
      title: xp ? 'Turn off computer' : 'Shut Down Windows',
      body:`<div class="fake-shutdown"><strong>${xp?'Turn off computer':'Shut Down Windows'}</strong><p>This desktop is an easter egg, so the browser refuses to power off.</p><button type="button" data-desktop-restore="1">Restore SimpleShare</button></div>`
    }
  };
  return apps[app] || apps.computer;
}
function openDesktopApp(app) {
  const win = $('desktopWindow');
  if (!win) return;
  const info = desktopAppContent(app);
  $('desktopWindowTitle').textContent = info.title;
  $('desktopWindowBody').innerHTML = info.body;
  win.classList.remove('hidden');
  $('desktopStartMenu')?.classList.add('hidden');
  win.querySelectorAll('[data-desktop-restore="1"]').forEach(btn=>btn.addEventListener('click',()=>restoreWindowsDesktop()));
}

function applyTheme(themeId, {announce=false}={}) {
  const theme = THEMES.find(t=>t.id===themeId) || THEMES[0];
  if (windowsDesktopActive && !isWindowsDesktopTheme(theme.id)) restoreWindowsDesktop({silent:true});
  document.documentElement.dataset.theme = theme.id;
  mountPremiumTheme(theme.id);
  try { localStorage.setItem('simpleshare-theme', theme.id); } catch {}
  const btn = $('themeDiceBtn');
  if (btn) { btn.dataset.theme = theme.id; btn.title = `Theme dice · ${theme.name}`; btn.setAttribute('aria-label', `Roll a random visual theme. Current theme: ${theme.name}`); }
  requestAnimationFrame(() => playThemeEntry(theme.id));
  if (announce) { toast(`🎲 ${theme.name}`); log(`theme rolled: ${theme.name}`); }
  return theme;
}
function rollTheme() {
  const current = document.documentElement.dataset.theme || 'default';
  const choices = THEMES.filter(t=>t.id!==current);
  const next = choices[Math.floor(Math.random()*choices.length)] || THEMES[0];
  const btn = $('themeDiceBtn');
  btn?.classList.remove('rolling');
  void btn?.offsetWidth;
  btn?.classList.add('rolling');
  applyTheme(next.id,{announce:true});
  setTimeout(()=>btn?.classList.remove('rolling'),520);
}
const QUALITY = {
  '720p30':  { label: '720p 30fps',  width: 1280, height: 720,  fps: 30, bitrate: 2_500_000 },
  '720p60':  { label: '720p 60fps',  width: 1280, height: 720,  fps: 60, bitrate: 4_000_000 },
  '1080p60': { label: '1080p 60fps', width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
};

applyTheme(localStorage.getItem('simpleshare-theme') || 'default');
const state = {
  apiBase: '', roomId: '', participantId: '', token: '', name: '',
  ws: null, socketSeq: 0, heartbeat: null, reconnectTimer: null, reconnectAttempts: 0,
  pollTimer: null, watchdogTimer: null, budgetTimer: null,
  tracks: null, tracksSessionSub: null, pcStateSub: null,
  leaving: false, share: null, reannounce: null, sessionId: '',
  people: new Map(), streams: new Map(), subs: new Map(), joining: new Set(), watching: new Set(), tiles: new Map(),
  budget: null, budgetBlocked: false, audioUnlocked: false, audioMuted: false, volume: 0.8,
  pollInFlight: false, peopleRenderKey: '', lastSnapshotAt: 0,
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
function streamName(ann) { return state.people.get(ann?.ownerId)?.name || ann?.ownerName || 'Someone'; }
function activePeople() { return [...state.people.values()].filter(p => !p.disconnectedAt); }
function scheduleImmediateSync(reason = 'event') { clearTimeout(scheduleImmediateSync._t); scheduleImmediateSync._t = setTimeout(() => syncSnapshot(reason).catch(err => log(`snapshot sync: ${err.message}`, 'warn')), 80); }

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
      resolve(); scheduleImmediateSync('socket-open');
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

async function reconcileSnapshot(snapshot, reason = 'snapshot') {
  state.lastSnapshotAt = Date.now();
  state.people = new Map((snapshot.participants || []).map(p => [p.id,p]));
  const incoming = new Map((snapshot.streams || []).map(s => [s.id,s]));
  for (const id of [...state.streams.keys()]) if (!incoming.has(id)) await dropStream(id, {silent:true});
  for (const ann of incoming.values()) {
    const previous = state.streams.get(ann.id);
    const sub = state.subs.get(ann.id);
    const watched = state.watching.has(ann.id);
    const mediaChanged = watched && (!sub || !sameTarget(sub.target, ann));
    const announcementChanged = !previous || previous.sessionId!==ann.sessionId || previous.videoTrackName!==ann.videoTrackName || previous.audioTrackName!==ann.audioTrackName || previous.profile!==ann.profile || previous.ownerName!==ann.ownerName;
    if (mediaChanged || announcementChanged || !state.tiles.has(ann.id)) await addStream(ann);
    else state.streams.set(ann.id, ann);
  }
  renderPeople();
  refreshVisibleNames();
  if (reason !== 'poll') log(`room state synchronized (${reason})`);
}
async function handleMessage(msg) {
  if (msg.type === 'snapshot') { await reconcileSnapshot(msg, 'socket'); return; }
  if (msg.type === 'participant-joined' || msg.type === 'participant-updated') { state.people.set(msg.participant.id,msg.participant); renderPeople(); refreshVisibleNames(); return; }
  if (msg.type === 'participant-left') { state.people.delete(msg.participantId); for (const id of msg.removedStreams || []) await dropStream(id); renderPeople(); refreshVisibleNames(); return; }
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
      video:{ width:{ideal:q.width}, height:{ideal:q.height}, frameRate:{ideal:q.fps}, displaySurface:'window' },
      audio: wantAudio ? { echoCancellation:false, noiseSuppression:false, autoGainControl:false } : false,
      // Privacy-first audio: ask modern Chromium for the selected window/tab only.
      // Full-system audio is deliberately excluded so a window share cannot leak other apps.
      systemAudio:'exclude',
      windowAudio: wantAudio ? 'window' : 'exclude',
      surfaceSwitching:'include',
      selfBrowserSurface:'exclude',
    });
  } catch (err) {
    if (err?.name === 'NotAllowedError') log('screen picker cancelled'); else { log(`screen capture failed: ${err.message}`,'error'); toast(err.message || 'Could not start sharing.'); }
    return;
  }
  const videoTrack = media.getVideoTracks()[0]; let audioTrack = media.getAudioTracks()[0] || null;
  if (!videoTrack) { media.getTracks().forEach(t=>t.stop()); toast('No video track was captured.'); return; }
  const settings = videoTrack.getSettings();
  const surface = settings.displaySurface || 'unknown';
  if (surface === 'monitor' && audioTrack) {
    // Some browsers ignore windowAudio/systemAudio hints. Never allow a monitor share
    // to silently fall back to whole-PC sound: drop that track client-side.
    try { media.removeTrack(audioTrack); audioTrack.stop(); } catch {}
    audioTrack = null;
    toast('Full-screen system audio was blocked to prevent other apps leaking into this stream. Share the app window or browser tab for localized audio.');
    log('blocked monitor/system audio track to prevent audio bleed', 'warn');
  }
  if (wantAudio && !audioTrack) toast(surface === 'monitor' ? 'For localized audio, share the specific app window or browser tab.' : 'This browser did not provide audio for that source. Chrome/Edge work best for window/tab audio.');
  try { videoTrack.contentHint = $('contentHint').value; } catch {}
  if (audioTrack) { try { audioTrack.contentHint = 'music'; } catch {} log(`captured localized audio (${audioTrack.label || `${surface} audio`})`); }
  log(`captured ${settings.width || '?'}x${settings.height || '?'} @ ${Math.round(settings.frameRate || 0)}fps · ${surface}`);
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
      next:(track)=>{
        entry.audioMedia=new MediaStream([track]); tile.audio.srcObject=entry.audioMedia; tile.audioBtn.classList.remove('hidden'); tile.volumeWrap.classList.remove('hidden');
        tile.audio.volume=state.volume; tile.audio.muted=state.audioMuted; tile.audioBtn.textContent=tile.audio.muted?'🔇':'🔊'; tile.audioBtn.classList.toggle('on',!tile.audio.muted);
        tile.audio.play().then(()=>{state.audioUnlocked=true;refreshGlobalAudioButton();}).catch(()=>{
          tile.audio.muted=true; tile.audioBtn.textContent='🔇'; tile.audioBtn.classList.remove('on');
          toast(`Audio from ${streamName(ann)} is available — click the speaker once to enable it.`); refreshGlobalAudioButton();
        });
        log(`receiving shared audio from ${streamName(ann)}`);
      },
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
  card.innerHTML=`<video autoplay playsinline muted></video><audio autoplay></audio><div class="tile-idle hidden"><div class="idle-avatar"></div><div class="idle-name"></div><div class="idle-sub"></div><button class="primary idle-watch">Watch stream</button></div><div class="tile-note hidden"></div><div class="tile-bar"><span class="tile-name"></span><span class="tile-actions"><span class="tile-meta"></span><label class="tile-volume hidden" title="Stream volume"><span>🔉</span><input class="tile-volume-range" type="range" min="0" max="100" value="80" aria-label="Stream volume"></label><button class="tile-action-btn tile-audio hidden" title="Mute shared audio">🔊</button><button class="tile-action-btn tile-stop hidden">Close</button></span></div>`;
  entry={card,video:card.querySelector('video'),audio:card.querySelector('audio'),audioBtn:card.querySelector('.tile-audio'),volumeWrap:card.querySelector('.tile-volume'),volumeRange:card.querySelector('.tile-volume-range'),note:card.querySelector('.tile-note'),idle:card.querySelector('.tile-idle'),statsTimer:null,lastFrameAt:0};
  entry.audio.muted=state.audioMuted; entry.audio.volume=state.volume; if(entry.volumeRange)entry.volumeRange.value=String(Math.round(state.volume*100));
  card.querySelector('.idle-watch').addEventListener('click',e=>{e.stopPropagation();watchStream(ann.id).catch(err=>log(err.message,'error'));});
  card.querySelector('.tile-stop').addEventListener('click',e=>{e.stopPropagation();unwatchStream(ann.id).catch(err=>log(err.message,'error'));});
  entry.audioBtn.addEventListener('click',e=>{e.stopPropagation();toggleTileAudio(ann.id);});
  entry.volumeRange?.addEventListener('click',e=>e.stopPropagation());
  entry.volumeRange?.addEventListener('input',e=>{e.stopPropagation();const v=Math.max(0,Math.min(100,Number(e.target.value)||0))/100;entry.audio.volume=v;if(v>0&&entry.audio.muted){entry.audio.muted=false;entry.audio.play().catch(()=>{});}entry.audioBtn.textContent=entry.audio.muted?'🔇':'🔊';entry.audioBtn.classList.toggle('on',!entry.audio.muted);});
  card.addEventListener('click',()=>{if(!card.classList.contains('idle'))card.classList.toggle('big');});
  $('grid').appendChild(card);state.tiles.set(ann.id,entry);renderGrid();return entry;
}
function showIdleTile(ann,ready){const e=ensureTile(ann,false);clearInterval(e.statsTimer);e.statsTimer=null;e.video.srcObject=null;e.audio.srcObject=null;e.card.classList.add('idle');e.card.classList.remove('big');e.note.classList.add('hidden');e.idle.classList.remove('hidden');e.card.querySelector('.tile-stop').classList.add('hidden');e.audioBtn.classList.add('hidden');e.volumeWrap.classList.add('hidden');const name=streamName(ann);e.idle.querySelector('.idle-avatar').textContent=name.slice(0,1).toUpperCase();e.idle.querySelector('.idle-name').textContent=name;e.idle.querySelector('.idle-sub').textContent=ready?`${(QUALITY[ann.profile]||QUALITY['720p60']).label}${ann.audio?' · Audio':''}`:'Starting…';const b=e.idle.querySelector('.idle-watch');b.disabled=!ready||state.budgetBlocked;b.textContent=ready?'Watch Stream':'Starting…';e.card.querySelector('.tile-name').textContent=`${name} is live`;e.card.querySelector('.tile-meta').textContent='';return e;}
function showLiveTile(ann,media){const e=ensureTile(ann,false);e.card.classList.remove('idle');e.idle.classList.add('hidden');e.card.querySelector('.tile-stop').classList.remove('hidden');e.video.srcObject=media;e.video.muted=true;e.video.play().catch(()=>{});e.card.querySelector('.tile-name').textContent=streamName(ann);e.lastFrameAt=0;clearInterval(e.statsTimer);startTileStats(e,ann);if(luckyGame.active)queueMicrotask(rehomeLuckyGame);return e;}
function showLocalTile(ann,media){const e=ensureTile(ann,true);e.card.classList.remove('idle');e.idle.classList.add('hidden');e.card.querySelector('.tile-stop').classList.add('hidden');e.audioBtn.classList.add('hidden');e.volumeWrap.classList.add('hidden');e.video.srcObject=media;e.video.muted=true;e.video.play().catch(()=>{});e.card.querySelector('.tile-name').textContent=ann.ownerName;e.lastFrameAt=Date.now();clearInterval(e.statsTimer);startTileStats(e,ann);if(luckyGame.active)queueMicrotask(rehomeLuckyGame);return e;}
function startTileStats(e,ann){const meta=e.card.querySelector('.tile-meta');const fallback=(QUALITY[ann.profile]||QUALITY['720p60']).label;let frames=0,last=performance.now();const onFrame=()=>{if(!state.tiles.has(ann.id))return;frames++;e.lastFrameAt=Date.now();e.video.requestVideoFrameCallback?.(onFrame);};e.video.requestVideoFrameCallback?.(onFrame);e.statsTimer=setInterval(()=>{if(!state.tiles.has(ann.id)){clearInterval(e.statsTimer);return;}const now=performance.now(),fps=Math.round(frames*1000/Math.max(1,now-last));frames=0;last=now;const w=e.video.videoWidth,h=e.video.videoHeight;meta.textContent=w?`${w}x${h} · ${fps} FPS${ann.audio?' · Audio':''}`:fallback;if(fps>0)e.lastFrameAt=Date.now();},2000);}
function removeTile(id){const e=state.tiles.get(id);if(!e)return;clearInterval(e.statsTimer);try{e.video.srcObject=null;e.audio.srcObject=null;}catch{}e.card.remove();state.tiles.delete(id);renderGrid();if(luckyGame.active)queueMicrotask(rehomeLuckyGame);}
function renderGrid(){const count=state.tiles.size;$('empty').classList.toggle('hidden',count>0);$('grid').classList.toggle('hidden',count===0);$('grid').classList.remove('count-1','count-2','count-many');$('grid').classList.add(count===1?'count-1':count===2?'count-2':'count-many');}

// Hidden "I'm Feeling Lucky" falling-block minigame -----------------------
const LUCKY_COLS=10,LUCKY_ROWS=20;
const LUCKY_SHAPES={
  I:[[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
  J:[[1,0,0],[1,1,1],[0,0,0]],
  L:[[0,0,1],[1,1,1],[0,0,0]],
  O:[[1,1],[1,1]],
  S:[[0,1,1],[1,1,0],[0,0,0]],
  T:[[0,1,0],[1,1,1],[0,0,0]],
  Z:[[1,1,0],[0,1,1],[0,0,0]],
};
const LUCKY_COLORS={I:'#42d7e8',J:'#5d7cff',L:'#ff9b42',O:'#f5d442',S:'#5ed06f',T:'#b66cff',Z:'#f05d67'};
const luckyGame={active:false,paused:false,over:false,board:null,piece:null,next:null,queue:[],hold:null,canHold:true,bag:[],score:0,lines:0,level:1,combo:-1,highScore:Number(localStorage.getItem('simpleshare_lucky_high')||0),timer:null,host:null,canvas:null,ctx:null,nextCanvas:null,nextCtx:null,holdCanvas:null,holdCtx:null,message:null,clearFlash:0,fitObserver:null};
function luckyEmptyBoard(){return Array.from({length:LUCKY_ROWS},()=>Array(LUCKY_COLS).fill(''));}
function luckyShuffle(a){for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;}
function luckyType(){if(!luckyGame.bag.length)luckyGame.bag=luckyShuffle(Object.keys(LUCKY_SHAPES));return luckyGame.bag.pop();}
function luckyCloneShape(type){return LUCKY_SHAPES[type].map(r=>r.slice());}
function luckyNewPiece(type=luckyType()){const shape=luckyCloneShape(type);return{type,shape,x:Math.floor((LUCKY_COLS-shape[0].length)/2),y:-1};}
function luckyRotate(shape){return shape[0].map((_,x)=>shape.map(row=>row[x]).reverse());}
function luckyCollides(piece,x=piece.x,y=piece.y,shape=piece.shape){for(let r=0;r<shape.length;r++)for(let c=0;c<shape[r].length;c++)if(shape[r][c]){const bx=x+c,by=y+r;if(bx<0||bx>=LUCKY_COLS||by>=LUCKY_ROWS)return true;if(by>=0&&luckyGame.board[by][bx])return true;}return false;}
function luckyMerge(){const p=luckyGame.piece;for(let r=0;r<p.shape.length;r++)for(let c=0;c<p.shape[r].length;c++)if(p.shape[r][c]){const y=p.y+r,x=p.x+c;if(y>=0&&y<LUCKY_ROWS)luckyGame.board[y][x]=p.type;}}
function luckyClearLines(){let cleared=0;for(let y=LUCKY_ROWS-1;y>=0;y--){if(luckyGame.board[y].every(Boolean)){luckyGame.board.splice(y,1);luckyGame.board.unshift(Array(LUCKY_COLS).fill(''));cleared++;y++;}}if(cleared){luckyGame.combo++;const table=[0,100,300,500,800];luckyGame.score+=table[cleared]*luckyGame.level+Math.max(0,luckyGame.combo)*50*luckyGame.level;luckyGame.lines+=cleared;luckyGame.level=Math.floor(luckyGame.lines/10)+1;luckyGame.clearFlash=Date.now()+180;}else luckyGame.combo=-1;luckyMaybeHighScore();luckyUpdateHud();return cleared;}
function luckyFillQueue(){while(luckyGame.queue.length<4)luckyGame.queue.push(luckyNewPiece());luckyGame.next=luckyGame.queue[0]||null;}function luckySpawn(){luckyFillQueue();luckyGame.piece=luckyGame.queue.shift();luckyFillQueue();luckyGame.canHold=true;luckyGame.piece.x=Math.floor((LUCKY_COLS-luckyGame.piece.shape[0].length)/2);luckyGame.piece.y=-1;if(luckyCollides(luckyGame.piece)){luckyGame.over=true;luckyGame.paused=true;luckyMaybeHighScore();luckyShowMessage(`GAME OVER<br><small>${luckyGame.score} points · press R to restart</small>`);}luckyDrawNext();luckyDrawHold();}
function luckyLock(){luckyMerge();luckyClearLines();luckySpawn();luckyDraw();luckySchedule();}
function luckyDrop(manual=false){if(!luckyGame.active||luckyGame.paused||luckyGame.over)return;if(!luckyCollides(luckyGame.piece,luckyGame.piece.x,luckyGame.piece.y+1)){luckyGame.piece.y++;if(manual)luckyGame.score+=1;luckyUpdateHud();luckyDraw();if(!manual)luckySchedule();}else luckyLock();}
function luckyHardDrop(){if(!luckyGame.active||luckyGame.paused||luckyGame.over)return;let n=0;while(!luckyCollides(luckyGame.piece,luckyGame.piece.x,luckyGame.piece.y+1)){luckyGame.piece.y++;n++;}luckyGame.score+=n*2;luckyUpdateHud();luckyLock();}
function luckyMove(dx){if(!luckyGame.active||luckyGame.paused||luckyGame.over)return;const nx=luckyGame.piece.x+dx;if(!luckyCollides(luckyGame.piece,nx,luckyGame.piece.y)){luckyGame.piece.x=nx;luckyDraw();}}
function luckyTurn(){if(!luckyGame.active||luckyGame.paused||luckyGame.over)return;const rotated=luckyRotate(luckyGame.piece.shape);for(const kick of [0,-1,1,-2,2])if(!luckyCollides(luckyGame.piece,luckyGame.piece.x+kick,luckyGame.piece.y,rotated)){luckyGame.piece.shape=rotated;luckyGame.piece.x+=kick;luckyDraw();return;}}
function luckySpeed(){return Math.max(90,720-(luckyGame.level-1)*58);}
function luckySchedule(){clearTimeout(luckyGame.timer);if(luckyGame.active&&!luckyGame.paused&&!luckyGame.over)luckyGame.timer=setTimeout(()=>luckyDrop(false),luckySpeed());}
function luckyCell(ctx,x,y,size,type,alpha=1){if(!type)return;ctx.save();ctx.globalAlpha=alpha;ctx.fillStyle=LUCKY_COLORS[type]||'#ddd';ctx.fillRect(x*size+1,y*size+1,size-2,size-2);ctx.fillStyle='rgba(255,255,255,.22)';ctx.fillRect(x*size+2,y*size+2,size-4,2);ctx.fillStyle='rgba(0,0,0,.22)';ctx.fillRect(x*size+size-3,y*size+2,1,size-4);ctx.restore();}
function luckyDraw(){const c=luckyGame.canvas,ctx=luckyGame.ctx;if(!c||!ctx)return;const size=c.width/LUCKY_COLS;const inStream=luckyGame.host?.classList.contains('in-stream');ctx.clearRect(0,0,c.width,c.height);if(!inStream){ctx.fillStyle='#08090c';ctx.fillRect(0,0,c.width,c.height);}ctx.strokeStyle=inStream?'rgba(255,255,255,.075)':'rgba(255,255,255,.035)';ctx.lineWidth=1;for(let x=1;x<LUCKY_COLS;x++){ctx.beginPath();ctx.moveTo(x*size,0);ctx.lineTo(x*size,c.height);ctx.stroke();}for(let y=1;y<LUCKY_ROWS;y++){ctx.beginPath();ctx.moveTo(0,y*size);ctx.lineTo(c.width,y*size);ctx.stroke();}for(let y=0;y<LUCKY_ROWS;y++)for(let x=0;x<LUCKY_COLS;x++)luckyCell(ctx,x,y,size,luckyGame.board[y][x]);const p=luckyGame.piece;if(p){let gy=p.y;while(!luckyCollides(p,p.x,gy+1))gy++;for(let r=0;r<p.shape.length;r++)for(let x=0;x<p.shape[r].length;x++)if(p.shape[r][x]){if(gy+r>=0)luckyCell(ctx,p.x+x,gy+r,size,p.type,.16);if(p.y+r>=0)luckyCell(ctx,p.x+x,p.y+r,size,p.type,1);}}if(Date.now()<luckyGame.clearFlash){ctx.fillStyle='rgba(255,255,255,.22)';ctx.fillRect(0,0,c.width,c.height);requestAnimationFrame(luckyDraw);}}
function luckyMiniDraw(c,ctx,p){if(!c||!ctx)return;ctx.clearRect(0,0,c.width,c.height);if(!luckyGame.host?.classList.contains('in-stream')){ctx.fillStyle='#08090c';ctx.fillRect(0,0,c.width,c.height);}if(!p)return;const shape=p.shape,size=Math.min(12,Math.floor(c.width/6)),w=shape[0].length*size,h=shape.length*size,ox=Math.floor((c.width-w)/2),oy=Math.floor((c.height-h)/2);for(let y=0;y<shape.length;y++)for(let x=0;x<shape[y].length;x++)if(shape[y][x]){ctx.fillStyle=LUCKY_COLORS[p.type];ctx.fillRect(ox+x*size+1,oy+y*size+1,size-2,size-2);}}function luckyDrawNext(){luckyMiniDraw(luckyGame.nextCanvas,luckyGame.nextCtx,luckyGame.next);}function luckyDrawHold(){luckyMiniDraw(luckyGame.holdCanvas,luckyGame.holdCtx,luckyGame.hold);}function luckyMaybeHighScore(){if(luckyGame.score>luckyGame.highScore){luckyGame.highScore=luckyGame.score;try{localStorage.setItem('simpleshare_lucky_high',String(luckyGame.highScore));}catch{}}}function luckyHold(){if(!luckyGame.active||luckyGame.paused||luckyGame.over||!luckyGame.canHold)return;const current=luckyGame.piece.type;if(luckyGame.hold){const swap=luckyGame.hold;luckyGame.hold=luckyNewPiece(current);luckyGame.piece=luckyNewPiece(swap.type);}else{luckyGame.hold=luckyNewPiece(current);luckyFillQueue();luckyGame.piece=luckyGame.queue.shift();luckyFillQueue();}luckyGame.piece.x=Math.floor((LUCKY_COLS-luckyGame.piece.shape[0].length)/2);luckyGame.piece.y=-1;luckyGame.canHold=false;luckyDrawHold();luckyDrawNext();luckyDraw();}
function luckyUpdateHud(){const root=luckyGame.host?.querySelector('.lucky-game');if(!root)return;root.querySelector('[data-lucky-score]').textContent=String(luckyGame.score);root.querySelector('[data-lucky-lines]').textContent=String(luckyGame.lines);root.querySelector('[data-lucky-level]').textContent=String(luckyGame.level);root.querySelector('[data-lucky-high]').textContent=String(luckyGame.highScore);root.querySelector('[data-lucky-combo]').textContent=luckyGame.combo>0?`x${luckyGame.combo+1}`:'—';}
function luckyShowMessage(html){if(!luckyGame.message)return;luckyGame.message.innerHTML=html;luckyGame.message.classList.remove('hidden');}
function luckyHideMessage(){luckyGame.message?.classList.add('hidden');}
function luckyRestart(){clearTimeout(luckyGame.timer);luckyGame.board=luckyEmptyBoard();luckyGame.bag=[];luckyGame.queue=[];luckyGame.hold=null;luckyGame.canHold=true;luckyGame.score=0;luckyGame.lines=0;luckyGame.level=1;luckyGame.combo=-1;luckyGame.over=false;luckyGame.paused=false;luckyGame.clearFlash=0;luckyFillQueue();luckySpawn();luckyUpdateHud();luckyHideMessage();luckyDrawHold();luckyDraw();luckySchedule();}
function luckyPause(){if(!luckyGame.active||luckyGame.over)return;luckyGame.paused=!luckyGame.paused;if(luckyGame.paused){clearTimeout(luckyGame.timer);luckyShowMessage('PAUSED');}else{luckyHideMessage();luckySchedule();}}
function luckyLiveTarget(){const entries=[...state.tiles.entries()];const remote=entries.find(([id,t])=>state.subs.has(id)&&!t.card.classList.contains('idle')&&t.video.srcObject);if(remote)return remote[1].card;const any=entries.find(([,t])=>!t.card.classList.contains('idle')&&t.video.srcObject);return any?.[1]?.card||null;}
function luckyFitBoard(){const host=luckyGame.host,c=luckyGame.canvas;if(!host||!c)return;if(!host.classList.contains('in-stream')){c.style.width='144px';c.style.height='288px';return;}const wrap=host.querySelector('.lucky-board-wrap');if(!wrap)return;const r=wrap.getBoundingClientRect();if(!r.width||!r.height)return;const cell=Math.max(6,Math.floor(Math.min(r.width/LUCKY_COLS,r.height/LUCKY_ROWS)));c.style.width=`${cell*LUCKY_COLS}px`;c.style.height=`${cell*LUCKY_ROWS}px`;}
function rehomeLuckyGame(){const host=$('luckyGameHost');if(!host||!luckyGame.active)return;document.querySelectorAll('.tile.lucky-active').forEach(t=>t.classList.remove('lucky-active'));const target=luckyLiveTarget();if(target){if(host.parentNode!==target)target.appendChild(host);host.classList.add('in-stream');target.classList.add('lucky-active');}else{if(host.parentNode!==document.body)document.body.appendChild(host);host.classList.remove('in-stream');}requestAnimationFrame(()=>{luckyFitBoard();luckyDraw();luckyDrawNext();luckyDrawHold();});}
function luckyBuild(){const host=$('luckyGameHost');if(!host)return;host.innerHTML=`<div class="lucky-game" role="application" aria-label="Hidden falling block game"><div class="lucky-stream-hud lucky-hud-left"><div class="lucky-title">LUCKY BLOCKS<small>stream overlay mode</small></div><div class="lucky-stat"><span>SCORE</span><b data-lucky-score>0</b><span>HIGH</span><b data-lucky-high>0</b><span>LINES</span><b data-lucky-lines>0</b><span>LEVEL</span><b data-lucky-level>1</b><span>COMBO</span><b data-lucky-combo>—</b></div><div class="lucky-mini-label">HOLD · C</div><canvas class="lucky-hold" width="72" height="54"></canvas></div><div class="lucky-board-wrap"><canvas class="lucky-canvas" width="300" height="600" aria-label="Game board"></canvas><div class="lucky-message hidden"></div></div><div class="lucky-stream-hud lucky-hud-right"><div class="lucky-mini-label">NEXT</div><canvas class="lucky-next" width="72" height="54"></canvas><div class="lucky-actions"><button type="button" data-lucky-pause>Pause</button><button type="button" data-lucky-restart>Restart</button><button type="button" class="lucky-close" data-lucky-close>Close</button><button type="button" data-lucky-drop>Drop</button></div><div class="lucky-help">← → move · ↑ rotate<br>↓ soft · SPACE hard<br>C hold · P pause · R restart · ESC close</div></div><div class="lucky-touch"><button type="button" data-move="-1">←</button><button type="button" data-rotate>↻</button><button type="button" data-move="1">→</button><button type="button" data-down>↓</button><button type="button" data-hard>⇊</button><button type="button" data-hold>H</button></div></div>`;luckyGame.host=host;luckyGame.canvas=host.querySelector('.lucky-canvas');luckyGame.ctx=luckyGame.canvas.getContext('2d');luckyGame.nextCanvas=host.querySelector('.lucky-next');luckyGame.nextCtx=luckyGame.nextCanvas.getContext('2d');luckyGame.holdCanvas=host.querySelector('.lucky-hold');luckyGame.holdCtx=luckyGame.holdCanvas.getContext('2d');luckyGame.message=host.querySelector('.lucky-message');host.querySelector('[data-lucky-pause]').addEventListener('click',luckyPause);host.querySelector('[data-lucky-restart]').addEventListener('click',luckyRestart);host.querySelector('[data-lucky-close]').addEventListener('click',luckyClose);host.querySelector('[data-lucky-drop]').addEventListener('click',luckyHardDrop);host.querySelector('[data-hold]').addEventListener('click',luckyHold);host.querySelectorAll('[data-move]').forEach(b=>b.addEventListener('click',()=>luckyMove(Number(b.dataset.move))));host.querySelector('[data-rotate]').addEventListener('click',luckyTurn);host.querySelector('[data-down]').addEventListener('click',()=>luckyDrop(true));host.querySelector('[data-hard]').addEventListener('click',luckyHardDrop);if('ResizeObserver'in window){luckyGame.fitObserver?.disconnect?.();luckyGame.fitObserver=new ResizeObserver(()=>{if(luckyGame.active)requestAnimationFrame(()=>{luckyFitBoard();luckyDraw();});});luckyGame.fitObserver.observe(host);}} 
function luckyOpen(){if(!luckyGame.host)luckyBuild();luckyGame.active=true;$('luckyGameHost').classList.remove('hidden');rehomeLuckyGame();luckyRestart();toast(luckyLiveTarget()?'🍀 Lucky game launched on the stream.':'🍀 No live stream — lucky game opened in the corner.');}
function luckyClose(){clearTimeout(luckyGame.timer);luckyGame.active=false;luckyGame.paused=true;document.querySelectorAll('.tile.lucky-active').forEach(t=>t.classList.remove('lucky-active'));const host=$('luckyGameHost');if(host){host.classList.add('hidden');if(host.parentNode!==document.body)document.body.appendChild(host);host.classList.remove('in-stream');}}
function luckyToggle(){if(luckyGame.active)luckyClose();else luckyOpen();}
document.addEventListener('keydown',e=>{if(!luckyGame.active)return;const tag=e.target?.tagName;if(tag==='INPUT'||tag==='TEXTAREA'||tag==='SELECT'||e.target?.isContentEditable)return;const key=e.key;if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown',' ','p','P','c','C','r','R','Escape'].includes(key))e.preventDefault();if(key==='ArrowLeft')luckyMove(-1);else if(key==='ArrowRight')luckyMove(1);else if(key==='ArrowUp')luckyTurn();else if(key==='ArrowDown')luckyDrop(true);else if(key===' ')luckyHardDrop();else if(key==='c'||key==='C')luckyHold();else if(key==='r'||key==='R')luckyRestart();else if(key==='p'||key==='P')luckyPause();else if(key==='Escape')luckyClose();});

function refreshVisibleNames(){
  for(const [id,tile] of state.tiles){
    const ann=state.streams.get(id);
    if(ann && ann.ownerId!==state.participantId){
      const name=streamName(ann); tile.card.querySelector('.tile-name').textContent=name;
      if(tile.card.classList.contains('idle')) tile.idle.querySelector('.idle-name').textContent=name;
    } else if(state.share && id===state.share.streamId) tile.card.querySelector('.tile-name').textContent=`${state.name} (you)`;
  }
}
function renderPeople(){
  const people=activePeople(),owners=new Set([...state.streams.values()].map(s=>s.ownerId));
  const key=people.map(p=>`${p.id}:${p.name}:${owners.has(p.id)?1:0}`).sort().join('|');
  $('peopleCount').textContent=String(people.length);
  if(key!==state.peopleRenderKey){
    state.peopleRenderKey=key; const list=$('people'); list.innerHTML='';
    for(const p of people){const row=document.createElement('div');row.className='person';const you=p.id===state.participantId?' (you)':'';const initial=(p.name||'?').slice(0,1).toUpperCase();row.innerHTML=`<span class="person-avatar${owners.has(p.id)?' live':''}">${escapeHtml(initial)}</span><span class="person-name">${escapeHtml(p.name)}${you}</span>`;list.appendChild(row);}
  }
  const me=state.people.get(state.participantId);if(me&&!me.disconnectedAt){$('myName').value=me.name;if($('displayName'))$('displayName').value=me.name;}
  $('myName').closest('.member-footer')?.querySelector('.me-avatar')?.replaceChildren(document.createTextNode((state.name||'Y').slice(0,1).toUpperCase()));
}
function setTileAudioState(tile,muted){if(!tile||!tile.audio.srcObject)return;tile.audio.muted=muted;tile.audioBtn.textContent=muted?'🔇':'🔊';tile.audioBtn.classList.toggle('on',!muted);if(!muted)tile.audio.play().then(()=>state.audioUnlocked=true).catch(()=>{tile.audio.muted=true;tile.audioBtn.textContent='🔇';tile.audioBtn.classList.remove('on');});}
function toggleTileAudio(id){const tile=state.tiles.get(id);if(!tile||!tile.audio.srcObject)return;setTileAudioState(tile,!tile.audio.muted);refreshGlobalAudioButton();}
function toggleAllAudio(){
  const audible=[...state.tiles.entries()].filter(([id,t])=>state.subs.has(id)&&t.audio.srcObject);
  if(!audible.length){toast('No watched stream is sharing audio right now.');return;}
  const mute=audible.some(([,t])=>!t.audio.muted); state.audioMuted=mute;
  for(const [,tile] of audible)setTileAudioState(tile,mute);
  refreshGlobalAudioButton();
}
function applyGlobalVolume(value){
  state.volume=Math.max(0,Math.min(1,value));try{localStorage.setItem('simpleshare-volume',String(state.volume));}catch{}
  for(const tile of state.tiles.values()){tile.audio.volume=state.volume;if(tile.volumeRange)tile.volumeRange.value=String(Math.round(state.volume*100));}
  if($('volumeValue'))$('volumeValue').textContent=`${Math.round(state.volume*100)}%`;
}
function refreshGlobalAudioButton(){const audioTiles=[...state.tiles.entries()].filter(([id,t])=>state.subs.has(id)&&t.audio.srcObject);const active=audioTiles.some(([,t])=>!t.audio.muted);$('audioBtn').classList.toggle('audio-enabled',active);$('audioBtn').textContent=active?'🔊':'🔇';$('audioBtn').title=active?'Mute all shared audio':'Unmute shared audio';}
async function watchdog(){
  if(state.leaving||state.budgetBlocked)return;
  for(const [streamId,entry] of [...state.subs]){
    if(!state.watching.has(streamId))continue;const ann=state.streams.get(streamId),tile=state.tiles.get(streamId);if(!ann||!tile||!entry.target?.sessionId)continue;
    const alive=tile.lastFrameAt&&(Date.now()-tile.lastFrameAt<12000);if(alive){entry.strikes=0;continue;}if(!tile.lastFrameAt)continue;entry.strikes=(entry.strikes||0)+1;if(entry.strikes<2)continue;
    entry.strikes=0;log(`no frames from ${streamName(ann)} — rebuilding subscription without dropping watch state`,'warn');
    await teardownSubscription(streamId,{keepTile:true});
    if(state.watching.has(streamId)&&state.streams.has(streamId))await subscribe(state.streams.get(streamId));
  }
}
function estimateEgress(){let bps=0;for(const id of state.watching){const s=state.streams.get(id);if(s)bps+=(QUALITY[s.profile]||QUALITY['720p60']).bitrate;}return bps;}
async function tickBudget(){const bps=estimateEgress(),gbph=(bps/8)*3600/1e9;let budget=state.budget;try{budget=await apiCall('/api/budget');state.budget=budget;}catch{}const el=$('budget');if(!budget){el.textContent='idle';return;}const pct=budget.percent??0;el.textContent=`${budget.usedGb.toFixed(1)} / ${budget.capGb} GB${bps?` · ${gbph.toFixed(1)} GB/h`:''}`;el.className=`budget ${budget.blocked||pct>=95?'bad':pct>=75?'warn':''}`;applyBudgetBlock(Boolean(budget.blocked),budget);}
function applyBudgetBlock(blocked,budget){if(blocked===state.budgetBlocked)return;state.budgetBlocked=blocked;$('shareBtn').disabled=blocked||!state.participantId;$('budgetBanner').classList.toggle('hidden',!blocked);if(blocked){$('budgetBanner').textContent=`Bandwidth cap reached: ${budget.usedGb.toFixed(1)} of ${budget.capGb} GB used in the last ${budget.windowDays} days. New media is paused to protect the account.`;if(state.share)stopShare().catch(()=>{});}for(const [id,t] of state.tiles){if(!t.card.classList.contains('idle'))continue;const a=state.streams.get(id),b=t.idle.querySelector('.idle-watch');b.disabled=blocked||!(a?.sessionId&&a?.videoTrackName);}}
async function syncSnapshot(reason='poll'){
  if(state.leaving||!state.participantId||state.pollInFlight)return;
  state.pollInFlight=true;
  try{const snap=await apiCall(`/api/rooms/${state.roomId}/snapshot`);await reconcileSnapshot(snap,reason);}finally{state.pollInFlight=false;}
}
async function poll(){if(document.hidden)return;try{await syncSnapshot('poll');}catch(err){log(`fallback sync failed: ${err.message}`,'warn');}}

function applySidebar(hidden){$('room').classList.toggle('no-members',hidden);try{localStorage.setItem('simpleshare-hide-members',hidden?'1':'0');}catch{}}
function leaveRoom(){state.leaving=true;clearSocketTimers();clearInterval(state.pollTimer);clearInterval(state.watchdogTimer);clearInterval(state.budgetTimer);stopShare().catch(()=>{});try{state.ws?.close();}catch{}location.href='/';}
async function boot(){
  const params=new URLSearchParams(location.search);if(params.get('debug')==='1'){setLogLevel('debug');$('logPanel').classList.add('open');}
  const config=await fetch('/api/config').then(r=>r.json()).catch(()=>({roomApiUrl:''}));state.apiBase=normalizeBase(config.roomApiUrl);const roomId=params.get('room');
  if(!roomId){$('home').classList.remove('hidden');return;}if(!state.apiBase){$('home').classList.remove('hidden');toast('ROOM_API_URL is not set in Vercel.');return;}
  state.roomId=roomId;state.name=localStorage.getItem('simpleshare-name')||`Guest ${randomId(1).toUpperCase()}`;state.volume=Math.max(0,Math.min(1,Number(localStorage.getItem('simpleshare-volume')||0.8)));$('room').classList.remove('hidden');$('inviteLink').value=location.href;$('myName').value=state.name;if($('displayName'))$('displayName').value=state.name;if($('volumeSlider'))$('volumeSlider').value=String(Math.round(state.volume*100));applyGlobalVolume(state.volume);try{applySidebar(localStorage.getItem('simpleshare-hide-members')==='1');}catch{}
  setStatus('Connecting','warn');log(`room ${roomId}`);
  try{const health=await apiCall('/health');log(`backend ok (build ${health.build})`);if(!health.realtimeConfigured)throw new Error('Worker is missing Cloudflare Realtime credentials.');}catch(err){log(`backend check failed: ${err.message}`,'error');setStatus('Backend down','bad');$('logPanel').classList.add('open');return;}
  try{await joinRoom();await connectSocket();initTracks();renderPeople();renderGrid();state.pollTimer=setInterval(()=>poll().catch(()=>{}),2500);state.watchdogTimer=setInterval(()=>watchdog().catch(err=>log(`watchdog: ${err.message}`,'warn')),8000);state.budgetTimer=setInterval(()=>tickBudget().catch(()=>{}),15000);tickBudget().catch(()=>{});}catch(err){log(`could not join: ${err.message}`,'error');setStatus('Join failed','bad');$('logPanel').classList.add('open');}
}

$('createBtn')?.addEventListener('click',()=>{const u=new URL(location.href);u.search='';u.searchParams.set('room',randomId(12));location.href=u.toString();});
$('shareBtn')?.addEventListener('click',()=>startShare().catch(err=>log(err.message,'error')));$('stopBtn')?.addEventListener('click',()=>stopShare());
$('settingsBtn')?.addEventListener('click',()=>$('settingsPanel').classList.toggle('hidden'));
$('themeDiceBtn')?.addEventListener('click',rollTheme);
$('winMinBtn')?.addEventListener('click',(e)=>{e.stopPropagation();minimizeToWindowsDesktop();});
$('desktopRestoreBtn')?.addEventListener('click',()=>restoreWindowsDesktop());
$('desktopRestoreMenu')?.addEventListener('click',()=>restoreWindowsDesktop());
$('desktopStartBtn')?.addEventListener('click',(e)=>{e.stopPropagation();toggleDesktopStartMenu();});
$('desktopWindowClose')?.addEventListener('click',()=>$('desktopWindow')?.classList.add('hidden'));
$('desktopShutDown')?.addEventListener('click',()=>openDesktopApp('shutdown'));
document.querySelectorAll('[data-desktop-app]').forEach(btn=>btn.addEventListener('dblclick',()=>openDesktopApp(btn.dataset.desktopApp)));
document.querySelectorAll('#desktopStartMenu [data-desktop-app]').forEach(btn=>btn.addEventListener('click',()=>openDesktopApp(btn.dataset.desktopApp)));
$('windowsDesktop')?.addEventListener('click',(e)=>{if(!e.target.closest('.desktop-start-menu')&&!e.target.closest('.desktop-start-button'))$('desktopStartMenu')?.classList.add('hidden');});
$('luckyBtn')?.addEventListener('click',luckyToggle);
$('membersBtn')?.addEventListener('click',()=>applySidebar(!$('room').classList.contains('no-members')));
$('audioBtn')?.addEventListener('click',toggleAllAudio);
$('copyBtn')?.addEventListener('click',async()=>{await navigator.clipboard.writeText($('inviteLink').value).catch(()=>{});toast('Invite link copied');});
$('copyBtnSettings')?.addEventListener('click',async()=>{await navigator.clipboard.writeText($('inviteLink').value).catch(()=>{});toast('Invite link copied');});
function commitName(raw){const next=String(raw||'').trim().replace(/\s+/g,' ').slice(0,28);if(!next)return;state.name=next;localStorage.setItem('simpleshare-name',next);$('myName').value=next;if($('displayName'))$('displayName').value=next;if(state.ws?.readyState===WebSocket.OPEN)state.ws.send(JSON.stringify({type:'rename',name:next}));if(state.share&&state.reannounce)setTimeout(()=>state.reannounce().catch(()=>{}),100);renderPeople();refreshVisibleNames();toast(`You are now ${next}`);}
$('myName')?.addEventListener('change',(e)=>commitName(e.target.value));
$('displayName')?.addEventListener('change',(e)=>commitName(e.target.value));
$('displayName')?.addEventListener('keydown',(e)=>{if(e.key==='Enter'){e.preventDefault();commitName(e.target.value);e.target.blur();}});
$('volumeSlider')?.addEventListener('input',(e)=>applyGlobalVolume((Number(e.target.value)||0)/100));
$('quality')?.addEventListener('change',()=>{const q=QUALITY[$('quality').value];log(`quality set to ${q.label}`);});
$('leaveBtn')?.addEventListener('click',leaveRoom);$('leaveDockBtn')?.addEventListener('click',leaveRoom);$('logToggle')?.addEventListener('click',()=>$('logPanel').classList.toggle('open'));
window.addEventListener('focus',()=>scheduleImmediateSync('focus'));
document.addEventListener('visibilitychange',()=>{if(!document.hidden)scheduleImmediateSync('visible');});
document.addEventListener('pointerdown',()=>{state.audioUnlocked=true;for(const [id,tile] of state.tiles){if(state.subs.has(id)&&tile.audio.srcObject&&!state.audioMuted&&tile.audio.muted){tile.audio.muted=false;tile.audio.volume=state.volume;tile.audio.play().catch(()=>{tile.audio.muted=true;});}}refreshGlobalAudioButton();},{once:true,capture:true});
window.addEventListener('beforeunload',()=>{state.leaving=true;clearSocketTimers();try{state.ws?.close();}catch{}});

boot();
