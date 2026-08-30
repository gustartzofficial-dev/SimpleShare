import "webrtc-adapter";
import { PartyTracks, setLogLevel } from "partytracks/client";
import { ReplaySubject, BehaviorSubject, of } from "rxjs";

const $ = (id) => document.getElementById(id);


const THEMES = [
  { id:'default', name:'SimpleShare' },
  { id:'teamspeak', name:'TeamSpeak 3' },
  { id:'ios', name:'iOS Glass' },
  { id:'xp', name:'Windows XP' },
  { id:'win98', name:'Windows 98' },
  { id:'skype', name:'Old Skype' },
  { id:'terminal', name:'CRT Terminal' },
  { id:'aqua', name:'Mac OS X Aqua' },
  { id:'steam', name:'Steam Classic · Premium' },
  { id:'youtube', name:'YouTube 2012' },
  { id:'holo', name:'Android Holo' },
];

const PREMIUM_THEMES = new Set(['steam']);
// Retired themes still stored in someone's localStorage must not leave them on
// a theme that no longer has any CSS.
const RETIRED_THEMES = new Set(['ps3','wii','ds','psp']);
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

// The log used to be permanently pinned bottom-right, on top of the dock and
// the stage in several themes. It is a drawer now: hidden unless asked for,
// remembered between sessions, and forced open when something actually breaks.
// AFK — the 💀 button in the CRT theme.
//
// The camera is you: the view pushes back from the monitor as if you rolled
// the chair away, glances left, glances right, then settles back in. It is
// pure CSS 3D on the room element -- perspective on <body>, an animated
// transform on .room. No WebGL, no three.js, nothing to download. The GPU
// composites a transform on one layer, so it stays smooth even mid-stream.
const AFK_MS = 7600;
function stepAway() {
  if (document.body.classList.contains('afk-away')) return;
  const scene = $('afkScene'), caption = scene?.querySelector('.afk-caption span');
  if (caption) caption.textContent = '';
  document.body.classList.add('afk-away');
  scene?.classList.add('on');
  log('user stepped away from the desk', 'debug');
  try { sfxPlay('room-leave'); } catch {}

  // Type the caption out one character at a time, in keeping with the theme.
  const line = 'USER AWAY FROM KEYBOARD';
  let i = 0;
  const typer = setInterval(() => {
    if (!caption || i > line.length) return clearInterval(typer);
    caption.textContent = line.slice(0, i++);
  }, 55);

  setTimeout(() => {
    document.body.classList.remove('afk-away');
    scene?.classList.remove('on');
    clearInterval(typer);
    try { sfxPlay('room-join'); } catch {}
  }, AFK_MS);
}

function setLogVisible(visible, {expand=false}={}) {
  const panel = $('logPanel'); if (!panel) return;
  panel.classList.toggle('visible', visible);
  if (expand) panel.classList.add('open');
  $('logBtn')?.setAttribute('aria-pressed', String(visible));
  try { localStorage.setItem('simpleshare-log', visible ? '1' : '0'); } catch {}
}
const openLog = () => setLogVisible(true, {expand:true});

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
  focusedId:null,
  apiBase: '', roomId: '', participantId: '', token: '', name: '',
  ws: null, socketSeq: 0, heartbeat: null, reconnectTimer: null, reconnectAttempts: 0,
  pollTimer: null, watchdogTimer: null, budgetTimer: null,
  tracks: null, tracksSessionSub: null, pcStateSub: null,
  leaving: false, share: null, reannounce: null, sessionId: '',
  people: new Map(), streams: new Map(), subs: new Map(), joining: new Set(), watching: new Set(), tiles: new Map(),
  subAttempts: new Map(),
  budget: null, budgetBlocked: false, audioUnlocked: false, audioMuted: false, volume: 0.8,
  pollInFlight: false, peopleRenderKey: '', lastSnapshotAt: 0,
  appliedRev: 0, lastInboundAt: 0, livenessTimer: null,
  pcRecoverTimer: null, pcFailures: 0, resettingTracks: false, hiddenTicks: 0,
  probeTimer: null, hiddenAt: 0,
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
  if (!response.ok) {
    const err = new Error(data.error || `${path} failed (${response.status})`);
    err.code = data.code || null; err.status = response.status; err.fallback = data.fallback || null;
    throw err;
  }
  return data;
}
const envelope = (extra = {}) => ({ room:state.roomId, participantId:state.participantId, token:state.token, ...extra });
const sessionKey = () => `simpleshare-session-${state.roomId}`;
function savedSession() { try { const p = JSON.parse(sessionStorage.getItem(sessionKey()) || 'null'); return p?.participantId && p?.token ? p : null; } catch { return null; } }
function streamName(ann) { return state.people.get(ann?.ownerId)?.name || ann?.ownerName || 'Someone'; }
function activePeople() { return [...state.people.values()].filter(p => !p.disconnectedAt); }
function scheduleImmediateSync(reason = 'event') { clearTimeout(scheduleImmediateSync._t); scheduleImmediateSync._t = setTimeout(() => syncSnapshot(reason).catch(err => log(`snapshot sync: ${err.message}`, 'warn')), 80); }

// Returns true when the server handed us a DIFFERENT identity than we had --
// i.e. our old one was swept. The caller has to rebuild the media session in
// that case, because PartyTracks bakes the auth headers in at construction.
async function joinRoom() {
  // Everything already in the room arrives as "new" in the first snapshot.
  sfxQuiet(1800);
  const previous = savedSession();
  const result = await apiCall(`/api/rooms/${state.roomId}/join`, { method:'POST', body:{ name:state.name, mode:'cloud', participantId:previous?.participantId, token:previous?.token } });
  const changed = Boolean(state.participantId) && state.participantId !== result.participantId;
  state.participantId = result.participantId; state.token = result.token;
  try { sessionStorage.setItem(sessionKey(), JSON.stringify({participantId:state.participantId, token:state.token})); } catch {}
  if (changed) {
    state.appliedRev = 0;
    state.people = new Map((result.snapshot?.participants || []).map(p => [p.id,p]));
  } else {
    await reconcileSnapshot(result.snapshot || {}, result.resumed ? 'rejoin' : 'join');
  }
  log(result.resumed ? `rejoined room as ${state.name}` : `joined room as ${state.name}`);
  renderPeople();
  await purgeOrphanedOwnStreams();
  return changed;
}

// A reload or crash while sharing never reached stopShare, and because the
// identity resumes from sessionStorage the server never swept the participant
// either -- so the dead stream record survived. Clear anything the room still
// thinks we are publishing that we are not.
async function purgeOrphanedOwnStreams() {
  if (!state.participantId) return;
  const mine = state.share?.streamId || null;
  for (const [id, ann] of [...state.streams]) {
    if (ann.ownerId !== state.participantId || id === mine) continue;
    log(`clearing a stale stream left over from a previous session (${id})`,'warn');
    try {
      await apiCall(`/api/rooms/${state.roomId}/stream/remove`,{method:'POST',body:envelope({streamId:id})});
    } catch (err) { log(`could not clear ${id}: ${err.message}`,'warn'); }
    await dropStream(id,{silent:true});
  }
}

function reportWatching() {
  if (state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type:'watching', streamIds:[...state.watching] }));
}
function clearSocketTimers() {
  clearInterval(state.heartbeat); state.heartbeat = null;
  clearInterval(state.livenessTimer); state.livenessTimer = null;
  clearTimeout(state.reconnectTimer); state.reconnectTimer = null;
  clearTimeout(state.probeTimer); state.probeTimer = null;
}

// Coming back from a hidden/frozen tab, an OPEN readyState proves nothing: the
// socket may have been half-open the whole time the OS had us suspended. Demand
// an actual reply before trusting it.
function probeSocket(reason = 'wake') {
  if (state.leaving) return;
  const ws = state.ws;
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    if (state.reconnectTimer) return;
    state.reconnectAttempts = 0;
    log(`socket is not open after ${reason} — reconnecting now`,'warn');
    recoverConnection().catch(err => { log(`reconnect failed: ${err.message}`,'warn'); scheduleReconnect(); });
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) return;
  state.lastInboundAt = Date.now();
  try { ws.send(JSON.stringify({type:'ping'})); }
  catch { try { ws.close(4000,'send-failed'); } catch {} return; }
  clearTimeout(state.probeTimer);
  state.probeTimer = setTimeout(() => {
    if (state.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - state.lastInboundAt < 6000) return;
    log(`no reply to the ${reason} ping — cycling the socket`,'warn');
    try { ws.close(4000,'stale-after-wake'); } catch {}
  }, 7000);
}

// While hidden, requestVideoFrameCallback stops firing, so lastFrameAt goes
// stale even though media is arriving fine. Restart every clock on the way back
// in so the watchdog re-measures instead of acting on frozen numbers.
function grantWatchdogGrace() {
  const now = Date.now();
  for (const tile of state.tiles.values()) if (tile.lastFrameAt) tile.lastFrameAt = now;
  for (const entry of state.subs.values()) entry.subscribedAt = now;
}
function connectSocket() {
  const seq = ++state.socketSeq;
  return new Promise((resolve, reject) => {
    const base = state.apiBase.replace(/^http/i,'ws');
    const url = `${base}/api/rooms/${state.roomId}/socket?id=${encodeURIComponent(state.participantId)}&token=${encodeURIComponent(state.token)}`;
    const ws = new WebSocket(url); state.ws = ws; let settled = false;
    const timer = setTimeout(() => { if (!settled && state.ws === ws) { settled = true; try { ws.close(); } catch {} reject(new Error('Room socket timed out.')); } }, 10000);
    ws.onopen = () => {
      if (state.ws !== ws || seq !== state.socketSeq) { try { ws.close(); } catch {} return; }
      clearTimeout(timer); settled = true; state.reconnectAttempts = 0;
      clearInterval(state.heartbeat); clearInterval(state.livenessTimer);
      state.lastInboundAt = Date.now();
      state.heartbeat = setInterval(() => { if (state.ws === ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({type:'ping'})); }, 15000);
      // DEAD SOCKET DETECTION. readyState stays OPEN on a half-open TCP
      // connection (wifi -> cellular handoff, VPN flap, sleep/wake, NAT rebind)
      // so the UI happily said "Connected" while the server had already swept
      // us. Any inbound frame counts as proof of life; 50s of silence does not.
      state.livenessTimer = setInterval(() => {
        if (state.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - state.lastInboundAt <= 50000) return;
        log('socket went silent for 50s — forcing a reconnect','warn');
        try { ws.close(4000,'stale'); } catch {}
      }, 5000);
      log('room socket connected'); reportWatching(); setStatus(state.share ? 'Sharing' : 'Connected','ok');
      $('shareBtn').disabled = state.budgetBlocked;
      // No scheduleImmediateSync here any more. The Durable Object pushes a full
      // snapshot frame the instant it accepts the socket, so fetching one over
      // HTTP as well was a duplicate -- and on a flaky connection that reconnect
      // loop was doubling up requests exactly when the network could least
      // afford it. Anything genuinely missed is caught by the rev on server-ping.
      resolve();
    };
    ws.onmessage = (e) => {
      if (state.ws !== ws) return;
      state.lastInboundAt = Date.now();
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      handleMessage(msg).catch(err => log(`socket handler: ${err.message}`,'error'));
    };
    ws.onerror = () => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error('Room socket failed.')); } };
    ws.onclose = (e) => {
      clearTimeout(timer); if (state.ws !== ws || seq !== state.socketSeq || state.leaving) return;
      clearInterval(state.heartbeat); state.heartbeat = null;
      clearInterval(state.livenessTimer); state.livenessTimer = null;
      log(`room socket closed (code ${e.code}${e.reason ? `, ${e.reason}` : ''})`,'warn'); setStatus('Reconnecting','warn'); scheduleReconnect();
    };
  });
}
function scheduleReconnect() {
  if (state.leaving || state.reconnectTimer || P2P.active) return;
  state.reconnectAttempts += 1;
  const n = state.reconnectAttempts;
  // Retry forever. The old ladder gave up after 6 tries (~28s) and called
  // location.reload(), which for a sharer means getDisplayMedia is gone and
  // they have to re-pick their screen -- a self-inflicted outage on top of a
  // blip that had usually already healed.
  const delay = Math.min(600 * (2 ** Math.min(n - 1, 5)), 15000) + Math.floor(Math.random()*400);
  log(`reconnecting in ${(delay/1000).toFixed(1)}s (attempt ${n})`);
  if (n === 8) toast('Still trying to reconnect…');
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    recoverConnection().catch(err => {
      // Retrying a Durable Object that is out of budget will never succeed. The
      // old ladder retried forever, which is how the room "died" instead of
      // telling you anything useful.
      if (isQuotaFailure(err)) { enterP2PMode('reconnect').catch(e => log(`p2p fallback failed: ${e.message}`,'error')); return; }
      log(`reconnect failed: ${err.message}`,'warn'); scheduleReconnect();
    });
  }, delay);
}

// The browser WebSocket API never exposes the HTTP status of a failed upgrade,
// so a 401 from an expired token was indistinguishable from "network is down"
// and the client would retry a dead token until it gave up. Re-joining over
// plain HTTP first gives us a real status code and a valid identity.
async function recoverConnection() {
  if (state.leaving) return;
  const identityChanged = await joinRoom();
  if (identityChanged) {
    log('previous identity was swept — rebuilding the media session','warn');
    await resetTracks({ silent:true });
  }
  await connectSocket();
  await resumeAfterReconnect();
}

async function resumeAfterReconnect() {
  if (state.share) {
    try { await state.reannounce?.(); } catch (err) { log(`re-announce failed: ${err.message}`,'warn'); }
  }
  for (const id of [...state.watching]) {
    if (state.subs.has(id)) continue;
    const ann = state.streams.get(id);
    if (ann) await addStream(ann).catch(err => log(`resubscribe failed: ${err.message}`,'warn'));
  }
  reportWatching();
}

/* ---- presence sounds ------------------------------------------------------
   Synthesized with WebAudio rather than shipped as audio files: no binary
   assets in the repo, no extra network fetches, and nothing to fail to load
   before the first event fires. Six distinct cues, deliberately built on
   different shapes so they stay tellable apart at low volume:
     stream-start  rising 4-note triangle arpeggio  (brightest, most attention)
     stream-stop   falling 3-note triangle
     room-join     rising 2-note sine
     room-leave    falling 2-note sine, filtered darker
     viewer-join   single high sine blip           (quietest, most frequent)
     viewer-leave  single low sine blip
--------------------------------------------------------------------------- */
const SFX = {
  ctx: null,
  master: null,
  convolver: null,
  wet: null,
  enabled: localStorage.getItem('simpleshare-sfx') !== 'off',
  volume: Math.min(1, Math.max(0, Number(localStorage.getItem('simpleshare-sfx-volume') ?? 0.45))),
  muteUntil: 0,
  lastAt: new Map(),
};

function sfxContext() {
  if (SFX.ctx) return SFX.ctx;
  const Ctor = window.AudioContext || window.webkitAudioContext;
  if (!Ctor) return null;
  try {
    SFX.ctx = new Ctor();
    SFX.master = SFX.ctx.createGain();
    // 0.55 ceiling: these are ambient cues, not alerts. Even at 100% in the
    // settings they should sit under a conversation, never over it. Measured
    // output lands between -30 and -13 dBFS across the set.
    SFX.master.gain.value = SFX.volume * 0.55;
    // Safety limiter. The levels are already gentle by design, but a reverb bus
    // plus overlapping cues is exactly the kind of thing that surprises you, and
    // a cue that clips is worse than no cue at all.
    const limiter = SFX.ctx.createDynamicsCompressor();
    limiter.threshold.value = -6;
    limiter.knee.value = 6;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    SFX.master.connect(limiter);
    limiter.connect(SFX.ctx.destination);
  } catch { SFX.ctx = null; }
  return SFX.ctx;
}

// Autoplay policy: a context created before any gesture starts suspended.
function sfxUnlock() {
  const ctx = sfxContext();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

function sfxSetEnabled(on) {
  SFX.enabled = Boolean(on);
  localStorage.setItem('simpleshare-sfx', SFX.enabled ? 'on' : 'off');
  if (SFX.enabled) { sfxUnlock(); sfxPlay('room-join', {force:true}); }
}

function sfxSetVolume(v) {
  SFX.volume = Math.min(1, Math.max(0, Number(v) || 0));
  localStorage.setItem('simpleshare-sfx-volume', String(SFX.volume));
  if (SFX.master) SFX.master.gain.value = SFX.volume * 0.55;
}

// Suppresses the burst of events that arrives with the first snapshot -- joining
// a busy room should not fire a chime for every person and stream already there.
function sfxQuiet(ms = 1500) { SFX.muteUntil = Date.now() + ms; }

// A synthetic impulse response gives the whole set a room to sit in. Without it
// the tones read as beeps no matter how they are tuned; with it they read as an
// instrument in a space. Generated rather than downloaded: no asset, no fetch.
function sfxReverb(ctx) {
  if (SFX.convolver) return SFX.convolver;
  const seconds = 1.9, len = Math.floor(ctx.sampleRate * seconds);
  const buffer = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / len;
      // Exponential decay with a slight pre-delay ramp, low-passed progressively
      // so the tail darkens as it fades the way a real room does.
      const decay = Math.pow(1 - t, 2.6);
      const white = (Math.random() * 2 - 1) * decay;
      lp += (white - lp) * (0.35 - 0.25 * t);
      data[i] = lp * (i < ctx.sampleRate * 0.006 ? i / (ctx.sampleRate * 0.006) : 1);
    }
  }
  SFX.convolver = ctx.createConvolver();
  // Explicit rather than relying on the default: without power normalization a
  // 1.9s noise tail multiplies the signal enormously.
  SFX.convolver.normalize = true;
  SFX.convolver.buffer = buffer;
  SFX.wet = ctx.createGain();
  SFX.wet.gain.value = 0.34;
  SFX.convolver.connect(SFX.wet);
  SFX.wet.connect(SFX.master);
  return SFX.convolver;
}

// Partials of a struck string: harmonics slightly sharp of exact multiples, and
// each one decaying faster than the last. That falling-brightness envelope is
// what separates a piano-ish tone from a sine beep.
const SFX_PARTIALS = [
  { mul:1.0,  amp:1.00, decay:1.0 },
  { mul:2.0,  amp:0.42, decay:1.7 },
  { mul:3.01, amp:0.18, decay:2.6 },
  { mul:4.02, amp:0.09, decay:3.6 },
  { mul:5.04, amp:0.04, decay:4.8 },
];

function sfxNote(ctx, { freq, at = 0, dur = 1.2, peak = 0.16 }) {
  const t0 = ctx.currentTime + at;
  const dry = ctx.createGain();
  dry.gain.value = 1;
  dry.connect(SFX.master);
  dry.connect(sfxReverb(ctx));
  for (const p of SFX_PARTIALS) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * p.mul, t0);
    const level = peak * p.amp;
    // 6ms attack: soft enough to avoid a click, fast enough to feel struck.
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.linearRampToValueAtTime(level, t0 + 0.006);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur / p.decay);
    osc.connect(gain); gain.connect(dry);
    osc.start(t0); osc.stop(t0 + dur + 0.05);
  }
}

/* Cue design. Spectral distance is a poor guide here -- every cue is deliberately
   the same instrument, so magnitude spectra overlap by construction and a cosine
   metric saturates around 0.6 no matter how they are tuned. What actually carries
   identification is contour, note count, register and length, so the set is
   verified on those four axes instead: every pair differs on at least two.

     stream-start  rising 4 notes, low-mid, longest   G3 D4 G4 B4
     stream-stop   falling 3 notes, low               F4 C4 F3
     room-join     rising 2 notes, upper              C5 G5
     room-leave    falling 2 notes, mid-upper         Bb4 F4
     viewer-join   single note, high, quietest        C6
     viewer-leave  falling 2 notes, low, quietest     A3 E3                     */
const SFX_PATTERNS = {
  'stream-start': (ctx) => {
    sfxNote(ctx, { freq:196.00, at:0,     dur:1.3, peak:0.18 });
    sfxNote(ctx, { freq:293.66, at:0.095, dur:1.3, peak:0.17 });
    sfxNote(ctx, { freq:392.00, at:0.190, dur:1.5, peak:0.16 });
    sfxNote(ctx, { freq:493.88, at:0.285, dur:1.9, peak:0.15 });
  },
  'stream-stop': (ctx) => {
    sfxNote(ctx, { freq:349.23, at:0,     dur:1.0, peak:0.15 });
    sfxNote(ctx, { freq:261.63, at:0.100, dur:1.2, peak:0.15 });
    sfxNote(ctx, { freq:174.61, at:0.200, dur:1.8, peak:0.16 });
  },
  'room-join': (ctx) => {
    sfxNote(ctx, { freq:523.25, at:0,     dur:1.0, peak:0.14 });
    sfxNote(ctx, { freq:783.99, at:0.090, dur:1.5, peak:0.13 });
  },
  'room-leave': (ctx) => {
    sfxNote(ctx, { freq:466.16, at:0,     dur:1.0, peak:0.13 });
    sfxNote(ctx, { freq:349.23, at:0.090, dur:1.5, peak:0.14 });
  },
  // The two most frequent events, so the quietest and shortest by a wide margin.
  'viewer-join':  (ctx) => sfxNote(ctx, { freq:1046.50, at:0, dur:0.8, peak:0.095 }),
  'viewer-leave': (ctx) => {
    sfxNote(ctx, { freq:220.00, at:0,     dur:0.7, peak:0.095 });
    sfxNote(ctx, { freq:164.81, at:0.075, dur:0.9, peak:0.090 });
  },
};

function sfxPlay(name, { force = false } = {}) {
  if (!SFX.enabled || !SFX_PATTERNS[name]) return;
  if (!force && Date.now() < SFX.muteUntil) return;
  if (!force && document.hidden && name.startsWith('viewer-')) return;
  // Ten people opening a tile at once should be one chime, not ten.
  const now = Date.now();
  if (!force && now - (SFX.lastAt.get(name) || 0) < 400) return;
  SFX.lastAt.set(name, now);
  const ctx = sfxContext();
  if (!ctx) return;
  if (ctx.state === 'suspended') { ctx.resume().catch(() => {}); return; }
  try { SFX_PATTERNS[name](ctx); } catch (err) { log(`sound failed: ${err.message}`,'warn'); }
}


/* ==================================================================== *
   P2P FALLBACK MODE

   Why this exists: the Durable Object is not just the SFU coordinator,
   it is the signaling layer. When its daily free-tier budget runs out,
   /join and /socket both fail, so the room does not degrade -- it dies.
   "Just use peer-to-peer" is not enough on its own, because P2P still
   needs somewhere to exchange SDP.

   So this mode swaps BOTH layers at once:
     signaling  RoomHub (Durable Object)  ->  D1 + short polling
     media      Cloudflare Realtime SFU   ->  direct RTCPeerConnection

   D1 has a separate daily allowance from Durable Objects, so it is still
   answering when RoomHub is not. Media never reaches Cloudflare at all,
   which means this mode generates zero egress and cannot cost money.

   What you give up: the sharer uploads one copy per viewer instead of
   one copy total, and there is no TURN relay, so a peer behind symmetric
   NAT fails outright rather than falling back to a relay.
 * ==================================================================== */
const P2P_ICE = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];

// Public MQTT brokers, tried in order. No account, no API key, no card, no
// company that can bill anyone. They exist for exactly this: a rendezvous point
// so two browsers can find each other. Media never goes near them -- only the
// SDP handshake does, and that is encrypted (see roomKey below).
const P2P_BROKERS = [
  'wss://broker.emqx.io:8084/mqtt',
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://test.mosquitto.org:8081/',
];
const P2P_HELLO_MS = 3000;   // presence announce interval
const P2P_GONE_MS  = 12000;  // silence after which a peer is considered gone

const P2P = {
  active:false, rev:0, mq:null, key:null, topic:'', brokerIndex:0,
  peers:new Map(),            // participantId -> { id, name, stream, firstSeen, at }
  joinedAt:0, signature:'',
  out:new Map(), in:new Map(),
  helloTimer:null, reapTimer:null,
};

// Connection teardown. These were lost when the D1 transport was swapped for
// MQTT -- they lived inside the replaced block and were never re-added, so
// p2pOfferTo threw ReferenceError on its first line and every offer died
// silently. Syntax checks cannot catch that; the build now scans for it.
function p2pCloseOut(peerId) {
  const entry = P2P.out.get(peerId);
  if (!entry) return;
  try { entry.pc.close(); } catch {}
  P2P.out.delete(peerId);
}
function p2pCloseIn(ownerId) {
  const entry = P2P.in.get(ownerId);
  if (!entry) return;
  try { entry.pc.close(); } catch {}
  P2P.in.delete(ownerId);
}
function p2pCloseAllOutbound() {
  for (const peerId of [...P2P.out.keys()]) p2pCloseOut(peerId);
}

/* ---- minimal MQTT 3.1.1 over WebSocket -----------------------------------
   Hand-written rather than pulled from npm. The whole client is ~70 lines
   because we only need QoS 0 publish/subscribe, and adding a dependency here
   would mean a bundler change on a path that has to work when everything else
   has already failed. ------------------------------------------------------ */
const mqLen = (n) => { const o=[]; do { let b=n%128; n=Math.floor(n/128); if(n>0)b|=128; o.push(b); } while(n>0); return o; };
const mqStr = (v) => { const b=new TextEncoder().encode(v); return [b.length>>8, b.length&255, ...b]; };
const mqPacket = (type, flags, body) => new Uint8Array([(type<<4)|flags, ...mqLen(body.length), ...body]);

function mqParse(buf) {
  const packets = []; let i = 0;
  while (i < buf.length) {
    if (buf.length - i < 2) break;
    const type = buf[i] >> 4;
    let mult = 1, len = 0, j = i + 1, b;
    do {
      if (j >= buf.length) return [packets, buf.slice(i)];
      b = buf[j++]; len += (b & 127) * mult; mult *= 128;
    } while (b & 128);
    if (buf.length < j + len) return [packets, buf.slice(i)];
    packets.push({ type, body: buf.slice(j, j + len) });
    i = j + len;
  }
  return [packets, buf.slice(i)];
}

function mqttConnect(url, onMessage) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, ['mqtt']);
    ws.binaryType = 'arraybuffer';
    let rest = new Uint8Array(0), settled = false, pingTimer = null, packetId = 1;
    const fail = (why) => { if (settled) return; settled = true; clearInterval(pingTimer); try { ws.close(); } catch {} reject(new Error(why)); };
    const timer = setTimeout(() => fail('broker timed out'), 7000);

    const client = {
      ws,
      publish(topic, bytes) {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send(mqPacket(3, 0, [...mqStr(topic), ...bytes]));
      },
      subscribe(topic) {
        if (ws.readyState !== WebSocket.OPEN) return;
        const id = packetId++ & 0xffff;
        ws.send(mqPacket(8, 2, [id >> 8, id & 255, ...mqStr(topic), 0]));
      },
      close() { clearInterval(pingTimer); try { ws.close(); } catch {} },
    };

    ws.onopen = () => {
      const clientId = `ss${randomId(10)}`;              // 22 chars, within spec
      ws.send(mqPacket(1, 0, [...mqStr('MQTT'), 4, 0x02, 0, 60, ...mqStr(clientId)]));
    };
    ws.onerror = () => fail('broker connection failed');
    ws.onclose = () => { clearInterval(pingTimer); if (!settled) fail('broker closed the connection'); else onMessage(null, null); };
    ws.onmessage = (e) => {
      const chunk = new Uint8Array(e.data);
      const joined = new Uint8Array(rest.length + chunk.length);
      joined.set(rest); joined.set(chunk, rest.length);
      const [packets, remainder] = mqParse(joined);
      rest = remainder;
      for (const pkt of packets) {
        if (pkt.type === 2) {                            // CONNACK
          if (pkt.body[1] !== 0) return fail(`broker refused the connection (code ${pkt.body[1]})`);
          clearTimeout(timer); settled = true;
          pingTimer = setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(mqPacket(12, 0, [])); }, 30000);
          resolve(client);
        } else if (pkt.type === 3) {                     // PUBLISH (QoS 0)
          const tLen = (pkt.body[0] << 8) | pkt.body[1];
          const topic = new TextDecoder().decode(pkt.body.slice(2, 2 + tLen));
          onMessage(topic, pkt.body.slice(2 + tLen));
        }
      }
    };
  });
}

/* ---- payload secrecy -----------------------------------------------------
   Public brokers say plainly that anything you publish is visible to anyone.
   SDP contains your IP addresses, so it does not go out in the clear. The room
   id is already the shared secret -- it is what the invite link carries and the
   only thing that grants entry -- so both the key and the topic name are
   derived from it. The broker sees an opaque topic and opaque bytes, and never
   learns the room id itself. ---------------------------------------------- */
const sha256 = async (text) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const toHex = (bytes) => [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');

async function p2pDeriveRoom(roomId) {
  P2P.key = await crypto.subtle.importKey('raw', await sha256(`simpleshare-key/${roomId}`), { name:'AES-GCM' }, false, ['encrypt','decrypt']);
  P2P.topic = toHex(await sha256(`simpleshare-topic/${roomId}`)).slice(0, 24);
}
async function p2pSeal(obj) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name:'AES-GCM', iv }, P2P.key, new TextEncoder().encode(JSON.stringify(obj))));
  const out = new Uint8Array(12 + ct.length); out.set(iv); out.set(ct, 12); return out;
}
async function p2pOpen(bytes) {
  const plain = await crypto.subtle.decrypt({ name:'AES-GCM', iv: bytes.slice(0, 12) }, P2P.key, bytes.slice(12));
  return JSON.parse(new TextDecoder().decode(plain));
}

const p2pRoomTopic = () => `ss/${P2P.topic}/room`;
const p2pPeerTopic = (id) => `ss/${P2P.topic}/p/${id}`;

async function p2pPublish(topic, obj) {
  if (!P2P.mq) { log(`cannot publish ${obj.k || '?'} — no broker connection`, 'error'); return; }
  try {
    P2P.mq.publish(topic, await p2pSeal(obj));
    if (obj.k && obj.k !== 'hello') log(`-> sent ${obj.k}`, 'debug');
  } catch (err) { log(`publish ${obj.k || '?'} failed: ${err.message}`, 'error'); }
}
const p2pSend = (target, signal) => p2pPublish(p2pPeerTopic(target), { from: state.participantId, ...signal });
const p2pPeerName = (id) => state.people.get(id)?.name || P2P.peers.get(id)?.name || 'peer';

// Presence is just a heartbeat everyone can hear. No server holds the roster;
// each client rebuilds it from who has spoken recently.
function p2pHello() {
  return p2pPublish(p2pRoomTopic(), {
    k:'hello', id:state.participantId, name:state.name,
    stream: state.share ? { id:state.share.streamId, profile:state.share.profile, audio:state.share.media.getAudioTracks().length > 0 } : null,
  });
}

async function p2pOnRoomMessage(msg) {
  if (msg.k === 'hello') {
    if (msg.id === state.participantId) return;
    const known = P2P.peers.get(msg.id);
    P2P.peers.set(msg.id, {
      id:msg.id, name:safeP2PName(msg.name), stream:msg.stream || null,
      firstSeen: known?.firstSeen || Date.now(), at: Date.now(),
    });
    p2pRebuild();
  } else if (msg.k === 'gone') {
    P2P.peers.delete(msg.id); p2pCloseOut(msg.id); p2pCloseIn(msg.id); p2pRebuild();
  }
}
const safeP2PName = (v) => String(v || '').trim().replace(/\s+/g, ' ').slice(0, 28) || 'Guest';

function p2pReap() {
  const cutoff = Date.now() - P2P_GONE_MS;
  let changed = false;
  for (const [id, peer] of P2P.peers) {
    if (peer.at >= cutoff) continue;
    P2P.peers.delete(id); p2pCloseOut(id); p2pCloseIn(id); changed = true;
  }
  if (changed) p2pRebuild();
}

// Fold the heartbeat table into the same shape RoomHub used to return, so all
// the existing rendering and reconciliation code works untouched.
// A P2P announcement has to carry the same identity fields an SFU one does.
// sameTarget() compares sessionId/videoTrackName/audioTrackName to decide
// whether media actually changed; without them every comparison was
// "p2p:abc" === undefined, so every presence tick counted as a change and
// tore down a subscription that was still in the middle of connecting.
// These are synthetic but stable, which is the whole point.
function p2pStreamAnnouncement(ownerId, ownerName, stream) {
  return {
    id: stream.id || `${ownerId}-share`,
    ownerId, ownerName,
    profile: stream.profile,
    audio: Boolean(stream.audio),
    sessionId: `p2p:${ownerId}`,
    videoTrackName: 'p2p-video',
    audioTrackName: stream.audio ? 'p2p-audio' : null,
    mode: 'p2p', p2p: true,
  };
}

function p2pRebuild() {
  const participants = [
    { id:state.participantId, name:state.name, joinedAt:P2P.joinedAt, mode:'p2p' },
    // joinedAt must be when we FIRST saw them, not the last heartbeat. Using
    // the heartbeat made the roster differ on every tick for no reason.
    ...[...P2P.peers.values()].map(p => ({ id:p.id, name:p.name, joinedAt:p.firstSeen, mode:'p2p' })),
  ];
  const streams = [];
  for (const peer of P2P.peers.values()) {
    if (peer.stream) streams.push(p2pStreamAnnouncement(peer.id, peer.name, peer.stream));
  }
  if (state.share) {
    streams.push(p2pStreamAnnouncement(state.participantId, state.name, {
      id: state.share.streamId, profile: state.share.profile,
      audio: state.share.media.getAudioTracks().length > 0,
    }));
  }
  // Presence arrives every few seconds from every peer. Reconciling an
  // identical roster that many times is pure churn, so only do it when
  // something actually differs.
  const signature = JSON.stringify([participants.map(p => [p.id, p.name]), streams]);
  if (signature === P2P.signature) return;
  P2P.signature = signature;
  reconcileSnapshot({ rev: ++P2P.rev, participants, streams }, 'p2p').catch(err => log(`p2p reconcile: ${err.message}`, 'warn'));
}

// Only the SHARER ever creates an offer. That removes glare entirely -- there
// is no case where both sides offer at once, so no perfect-negotiation dance
// and no politeness tie-breaking is needed.
async function p2pOfferTo(peerId) {
  if (!state.share || peerId === state.participantId) return;
  p2pCloseOut(peerId);
  const pc = new RTCPeerConnection({ iceServers: P2P_ICE });
  const entry = { pc, queue: [] };
  P2P.out.set(peerId, entry);
  for (const track of state.share.media.getTracks()) pc.addTrack(track, state.share.media);
  // Mesh means one encoder per viewer, so the cap is per connection. That is
  // also the upside: a peer on a bad line can be given less without touching
  // what everyone else receives.
  const q = QUALITY[state.share.profile] || QUALITY['720p60'];
  for (const sender of pc.getSenders()) {
    if (sender.track?.kind !== 'video') continue;
    try { const params = sender.getParameters(); params.encodings = [{ maxBitrate:q.bitrate, maxFramerate:q.fps }]; await sender.setParameters(params); } catch {}
  }
  entry.seen = new Set();
  pc.onicecandidate = (e) => {
    if (!e.candidate) { log(`ICE gathering done for ${p2pPeerName(peerId)}: ${[...entry.seen].join(', ') || 'NO CANDIDATES'}`); return; }
    entry.seen.add(e.candidate.type || '?');
    p2pSend(peerId, { k:'ice', cand:e.candidate.toJSON() });
  };
  pc.oniceconnectionstatechange = () => log(`ICE -> ${pc.iceConnectionState} (to ${p2pPeerName(peerId)})`, 'debug');
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') log(`sending directly to ${p2pPeerName(peerId)}`);
    if (pc.connectionState === 'failed') { log(`direct route to ${p2pPeerName(peerId)} failed — no relay in P2P mode`, 'error'); p2pCloseOut(peerId); }
  };
  log(`building offer for ${p2pPeerName(peerId)} (${pc.getSenders().length} tracks)`);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await p2pSend(peerId, { k:'offer', sdp:offer.sdp });
  log(`offer sent to ${p2pPeerName(peerId)}`);
}

async function p2pAcceptOffer(ownerId, sdp) {
  const ann = [...state.streams.values()].find(a => a.ownerId === ownerId);
  const entry = ann ? state.subs.get(ann.id) : null;
  // No entry means we never asked to watch. Ignore rather than auto-play.
  if (!ann) { log(`offer from ${p2pPeerName(ownerId)} but no stream announced by them`, 'warn'); return; }
  if (!entry) { log(`offer from ${ann.ownerName} but we are not watching that stream`, 'warn'); return; }
  p2pCloseIn(ownerId);
  const pc = new RTCPeerConnection({ iceServers: P2P_ICE });
  const conn = { pc, queue: [] };
  P2P.in.set(ownerId, conn);
  const tile = state.tiles.get(ann.id);
  pc.ontrack = (e) => {
    if (!tile) return;
    clearTimeout(entry.stall);
    if (e.track.kind === 'video') {
      for (const old of entry.videoMedia.getVideoTracks()) entry.videoMedia.removeTrack(old);
      entry.videoMedia.addTrack(e.track);
      tile.video.srcObject = entry.videoMedia; tile.video.play().catch(()=>{});
      tile.note.classList.add('hidden'); tile.lastFrameAt = Date.now();
      log(`receiving video from ${ann.ownerName} (direct)`);
    } else {
      entry.audioMedia = new MediaStream([e.track]);
      tile.audio.srcObject = entry.audioMedia;
      tile.audioBtn.classList.remove('hidden'); tile.volumeWrap.classList.remove('hidden');
      if (!state.audioMuted) { tile.audio.muted = false; tile.audio.volume = state.volume; tile.audio.play().catch(()=>{ tile.audio.muted = true; }); }
    }
  };
  conn.seen = new Set();
  pc.onicecandidate = (e) => {
    if (!e.candidate) { log(`ICE gathering done for ${ann.ownerName}: ${[...conn.seen].join(', ') || 'NO CANDIDATES'}`); return; }
    conn.seen.add(e.candidate.type || '?');
    p2pSend(ownerId, { k:'ice', cand:e.candidate.toJSON() });
  };
  pc.oniceconnectionstatechange = () => log(`ICE -> ${pc.iceConnectionState} (from ${ann.ownerName})`, 'debug');
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'connected') log(`direct connection to ${ann.ownerName} established`);
    if (pc.connectionState !== 'failed' || !tile) return;
    log(`direct route from ${ann.ownerName} failed`, 'error');
    tile.note.textContent = 'No direct route to this peer.'; tile.note.classList.remove('hidden');
  };
  await pc.setRemoteDescription({ type:'offer', sdp });
  log(`accepted offer from ${ann.ownerName}, ${conn.queue.length} queued candidates`);
  for (const cand of conn.queue.splice(0)) { try { await pc.addIceCandidate(cand); } catch {} }
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await p2pSend(ownerId, { k:'answer', sdp:answer.sdp });
  log(`answer sent to ${ann.ownerName}`);
}

async function p2pOnSignal(from, raw) {
  let sig; try { sig = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return; }
  if (sig.k !== 'ice') log(`<- got ${sig.k} from ${p2pPeerName(from)}`, 'debug');
  if (sig.k === 'want')  {
    if (!state.share) { log(`${p2pPeerName(from)} asked to watch, but we are not sharing`, 'warn'); return; }
    try { await p2pOfferTo(from); }
    catch (err) { log(`could not offer to ${p2pPeerName(from)}: ${err.message}`, 'error'); }
    return;
  }
  if (sig.k === 'bye')   { p2pCloseOut(from); return; }
  if (sig.k === 'offer') { await p2pAcceptOffer(from, sig.sdp); return; }
  if (sig.k === 'answer') {
    const out = P2P.out.get(from);
    if (!out) { log(`answer from ${p2pPeerName(from)} with no matching connection`, 'warn'); return; }
    if (out.pc.signalingState === 'stable') { log(`answer from ${p2pPeerName(from)} ignored (already stable)`, 'warn'); return; }
    await out.pc.setRemoteDescription({ type:'answer', sdp:sig.sdp });
    for (const cand of out.queue.splice(0)) { try { await out.pc.addIceCandidate(cand); } catch {} }
    return;
  }
  if (sig.k === 'ice') {
    const conn = P2P.out.get(from) || P2P.in.get(from);
    if (!conn) return;
    // Candidates routinely arrive before the description they belong to.
    if (!conn.pc.remoteDescription) { conn.queue.push(sig.cand); return; }
    try { await conn.pc.addIceCandidate(sig.cand); } catch {}
  }
}

// Same shape as an SFU subscription entry, so teardownSubscription, the
// watchdog and the tile code all work unchanged. `subs` holds an object with
// an unsubscribe() method rather than an rxjs subscription.
async function subscribeP2P(ann) {
  log(`watching ${ann.ownerName} (direct)`);
  const videoMedia = new MediaStream();
  const entry = {
    videoMedia, audioMedia:null, stall:null, strikes:0, subscribedAt:Date.now(),
    attempt:(state.subAttempts.get(ann.id) || 0) + 1,
    target:{ sessionId:`p2p:${ann.ownerId}`, videoTrackName:'p2p-video', audioTrackName: ann.audio ? 'p2p-audio' : null },
    subs:[{ unsubscribe:() => { p2pSend(ann.ownerId, { k:'bye' }); p2pCloseIn(ann.ownerId); } }],
  };
  state.subs.set(ann.id, entry);
  state.subAttempts.set(ann.id, entry.attempt);
  const tile = showLiveTile(ann, videoMedia);
  tile.note.textContent = 'Connecting directly…'; tile.note.classList.remove('hidden');
  entry.stall = setTimeout(() => {
    if (entry.videoMedia.getVideoTracks().length) return;
    log(`no direct route to ${ann.ownerName} after 20s`, 'error');
    tile.note.textContent = 'No direct route — this network may need a relay.';
  }, 20000);
  await p2pSend(ann.ownerId, { k:'want' });
}

async function p2pAnnounceShare(share) {
  await p2pHello();
  p2pRebuild();
  log('announced to room (peer-to-peer)');
  setStatus('Sharing · P2P', 'ok');
  // Anyone already watching needs a fresh offer against the new capture.
  for (const id of P2P.peers.keys()) if (P2P.out.has(id)) await p2pOfferTo(id);
}

async function p2pConnectBroker() {
  let lastError = null;
  for (let attempt = 0; attempt < P2P_BROKERS.length; attempt++) {
    const url = P2P_BROKERS[(P2P.brokerIndex + attempt) % P2P_BROKERS.length];
    const host = new URL(url).host;
    try {
      log(`connecting to rendezvous ${host}`);
      const client = await mqttConnect(url, (topic, bytes) => {
        if (topic === null) { if (P2P.active) p2pBrokerLost(); return; }
        p2pOpen(bytes).then(msg => {
          if (topic === p2pRoomTopic()) return p2pOnRoomMessage(msg);
          if (msg.from && msg.from !== state.participantId) return p2pOnSignal(msg.from, msg);
        }).catch(err => {
          // A decrypt failure is expected -- another room sharing the topic.
          // Anything else is a real fault on the exact path we cannot see into,
          // and swallowing it silently is what made this undiagnosable.
          if (err?.name === 'OperationError') return;
          log(`signal handler: ${err.message}`, 'error');
        });
      });
      P2P.brokerIndex = (P2P.brokerIndex + attempt) % P2P_BROKERS.length;
      P2P.mq = client;
      client.subscribe(p2pRoomTopic());
      client.subscribe(p2pPeerTopic(state.participantId));
      log(`rendezvous ready (${host})`);
      return;
    } catch (err) { lastError = err; log(`${host} unavailable: ${err.message}`, 'warn'); }
  }
  throw lastError || new Error('no rendezvous broker reachable');
}

function p2pBrokerLost() {
  if (!P2P.active || state.leaving) return;
  log('rendezvous connection dropped — trying the next broker', 'warn');
  setStatus('Reconnecting · P2P', 'warn');
  P2P.mq = null;
  P2P.brokerIndex += 1;
  setTimeout(() => {
    if (!P2P.active || state.leaving) return;
    p2pConnectBroker()
      .then(() => { setStatus(state.share ? 'Sharing · P2P' : 'Connected · P2P', 'ok'); return p2pHello(); })
      .catch(err => { log(`rendezvous unreachable: ${err.message}`, 'error'); setStatus('P2P offline', 'bad'); p2pBrokerLost(); });
  }, 2000 + Math.floor(Math.random() * 2000));
}

async function enterP2PMode(reason) {
  if (P2P.active) return;
  P2P.active = true;
  log(`switching to peer-to-peer (${reason})`, 'warn');

  // Shut down everything that depends on the Worker or its Durable Object.
  clearInterval(state.pollTimer); state.pollTimer = null;
  clearInterval(state.budgetTimer); state.budgetTimer = null;
  clearInterval(state.heartbeat); state.heartbeat = null;
  clearInterval(state.livenessTimer); state.livenessTimer = null;
  clearTimeout(state.reconnectTimer); state.reconnectTimer = null;
  state.socketSeq++;
  try { state.ws?.close(4002, 'p2p-fallback'); } catch {}
  state.ws = null;
  state.appliedRev = 0;

  // No SFU means no egress, so there is nothing left for the guard to guard.
  state.budgetBlocked = false;
  $('budgetBanner').classList.add('hidden');
  $('shareBtn').disabled = false;
  $('budget').textContent = 'P2P · no server, no cost';
  $('budget').className = 'budget';

  // Identity is self-assigned. There is no server to issue one.
  state.participantId = state.participantId || crypto.randomUUID();
  state.token = 'p2p';
  P2P.joinedAt = Date.now();
  P2P.signature = '';
  await p2pDeriveRoom(state.roomId);
  await p2pConnectBroker();

  setStatus('Connected · P2P', 'ok');
  log(`joined over peer-to-peer as ${state.name}`);
  toast('Running peer-to-peer. Signaling goes through a public broker, media goes straight between browsers, and nothing here can bill you.');

  await p2pHello();
  p2pRebuild();
  P2P.helloTimer = setInterval(() => p2pHello().catch(() => {}), P2P_HELLO_MS);
  P2P.reapTimer = setInterval(p2pReap, 4000);
}

function p2pShutdown() {
  clearInterval(P2P.helloTimer); clearInterval(P2P.reapTimer);
  p2pCloseAllOutbound();
  for (const id of [...P2P.in.keys()]) p2pCloseIn(id);
  try { p2pPublish(p2pRoomTopic(), { k:'gone', id:state.participantId }); } catch {}
  setTimeout(() => { try { P2P.mq?.close(); } catch {} }, 150);
}

// True when a failure means "the Durable Object is out of budget" rather than
// "something went wrong".
// Deliberately narrow. Falling back on any error at all would let a momentary
// blip put one person on P2P while everyone else stayed on the SFU -- and those
// are two separate rooms that cannot see each other. Only an unambiguous quota
// signal from the Worker counts.
const isQuotaFailure = (err) => err?.code === 'do-quota'
  || /exceeded allowed volume|daily request limit|durable objects free tier/i.test(String(err?.message || ''));

async function reconcileSnapshot(snapshot, reason = 'snapshot') {
  // STALE SNAPSHOT GUARD. The 2.5s poll and the WebSocket are independent, so a
  // GET /snapshot issued before a stream-upsert can resolve after it. The old
  // code then deleted every stream missing from that stale list -- tearing down
  // a subscription the socket had just correctly built, which the next poll
  // rebuilt, which is the flapping. Revisions are monotonic per mutation.
  const rev = Number(snapshot.rev || 0);
  if (rev && state.appliedRev && rev <= state.appliedRev) return;
  state.appliedRev = Math.max(state.appliedRev || 0, rev);
  state.lastSnapshotAt = Date.now();
  const peopleBefore = new Set(state.people.keys());
  state.people = new Map((snapshot.participants || []).map(p => [p.id,p]));
  // The poll fallback is the only presence signal while the socket is down, so
  // diff here too. sfxPlay is rate-limited, so a socket event and a snapshot
  // describing the same change collapse into a single chime.
  for (const id of state.people.keys()) if (!peopleBefore.has(id) && id !== state.participantId) sfxPlay('room-join');
  for (const id of peopleBefore) if (!state.people.has(id) && id !== state.participantId) sfxPlay('room-leave');
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
  if (msg.type === 'pong') return;
  if (msg.type === 'server-ping') {
    if (msg.budget) applyBudget(msg.budget);
    // REVISION DRIFT is what replaced the 2.5s poll. Every mutation bumps the
    // room's rev, so if the server's rev is ahead of what we have applied, we
    // missed a broadcast and need a snapshot. If it matches -- the normal case,
    // essentially always -- we send nothing at all. One free inbound frame does
    // the job that 1,440 HTTP requests an hour used to do badly.
    if (typeof msg.rev === 'number' && msg.rev > (state.appliedRev || 0)) {
      log(`room revision drift (have ${state.appliedRev || 0}, server ${msg.rev}) — resyncing`,'debug');
      syncSnapshot('rev-drift').catch(() => {});
    }
    return;
  }
  if (msg.type === 'snapshot') { if (msg.budget) applyBudget(msg.budget); await reconcileSnapshot(msg, 'socket'); return; }
  // Incremental events advance the revision too, so a snapshot that predates
  // them is correctly rejected above.
  if (typeof msg.rev === 'number') state.appliedRev = Math.max(state.appliedRev || 0, msg.rev);
  if (msg.type === 'watching-changed') {
    // Only chime for streams we actually care about -- our own, or one we have
    // open. Otherwise a busy room is nothing but blips.
    const relevant = (id) => { const st = state.streams.get(id); return Boolean(st && (st.ownerId === state.participantId || state.watching.has(id))); };
    if (msg.participantId !== state.participantId) {
      if ((msg.opened || []).some(relevant)) sfxPlay('viewer-join');
      if ((msg.closed || []).some(relevant)) sfxPlay('viewer-leave');
    }
    const person = state.people.get(msg.participantId);
    if (person) {
      const closed = new Set(msg.closed || []);
      person.watching = [...new Set([...(person.watching || []).filter(id => !closed.has(id)), ...(msg.opened || [])])];
      renderPeople();
    }
    return;
  }
  if (msg.type === 'participant-joined' || msg.type === 'participant-updated') {
    // participant-updated is also a rename, which must not chime.
    const isNew = msg.type === 'participant-joined' && !state.people.has(msg.participant.id);
    state.people.set(msg.participant.id,msg.participant);
    if (isNew && msg.participant.id !== state.participantId) sfxPlay('room-join');
    renderPeople(); refreshVisibleNames(); return;
  }
  if (msg.type === 'participant-left') {
    const known = state.people.has(msg.participantId);
    state.people.delete(msg.participantId);
    if (known && msg.participantId !== state.participantId) sfxPlay('room-leave');
    for (const id of msg.removedStreams || []) await dropStream(id, {viaOwnerLeaving:true});
    renderPeople(); refreshVisibleNames(); return;
  }
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
    clearTimeout(state.pcRecoverTimer); state.pcRecoverTimer = null;
    if (s === 'connected') {
      state.pcFailures = 0;
      setStatus(state.share ? 'Sharing' : 'Connected','ok');
      return;
    }
    // `disconnected` is usually transient -- ICE often repairs itself within a
    // few seconds, so don't tear anything down yet.
    if (s === 'disconnected') {
      setStatus('Media unstable','warn');
      state.pcRecoverTimer = setTimeout(() => {
        if (state.leaving) return;
        log('media still disconnected after 8s — rebuilding','warn');
        resetTracks().catch(err => log(`media reset failed: ${err.message}`,'error'));
      }, 8000);
      return;
    }
    // `failed` is terminal for that peer connection. Nothing used to act on it:
    // initTracks() memoized state.tracks forever, so the watchdog's "rebuild
    // subscription" reused the same dead session and could never recover.
    if (s === 'failed') {
      setStatus('Media failed','bad');
      state.pcFailures = (state.pcFailures || 0) + 1;
      const delay = Math.min(1000 * state.pcFailures, 10000);
      if (state.pcFailures === 1) toast('Media connection dropped — rebuilding it now.');
      else if (state.pcFailures === 3) toast('Media keeps failing. This network probably needs TURN enabled.');
      state.pcRecoverTimer = setTimeout(() => {
        if (state.leaving) return;
        resetTracks().catch(err => log(`media reset failed: ${err.message}`,'error'));
      }, delay);
    }
  });
  log('media engine ready'); return state.tracks;
}

// Tear the PartyTracks session down and build a fresh one, then restore
// everything that was running on it. Publishing does NOT need a new screen
// prompt: the captured MediaStreamTracks are still live on state.share.media.
async function resetTracks({ silent = false } = {}) {
  // "Rebuild the media engine" is a PartyTracks concept. In P2P mode there is
  // no engine to rebuild -- the watchdog re-offers per peer instead.
  if (P2P.active) return;
  if (state.leaving || state.resettingTracks) return;
  state.resettingTracks = true;
  sfxQuiet(2500);
  try {
    if (!silent) log('rebuilding media engine','warn');
    const watched = [...state.watching];
    for (const id of [...state.subs.keys()]) await teardownSubscription(id, {keepTile:true});
    const share = state.share;
    if (share) {
      for (const sub of share.subs) { try { sub.unsubscribe(); } catch {} }
      share.subs = []; share.videoMeta = null; share.audioMeta = null;
      try { share.encodings$?.complete(); } catch {}
      share.encodings$ = null;
    }
    try { state.tracksSessionSub?.unsubscribe(); } catch {}
    try { state.pcStateSub?.unsubscribe(); } catch {}
    state.tracksSessionSub = null; state.pcStateSub = null;
    state.tracks = null; state.sessionId = '';
    initTracks();
    if (share && state.share === share) await publishShare(share);
    for (const id of watched) {
      const ann = state.streams.get(id);
      if (ann) await addStream(ann).catch(err => log(`resubscribe failed: ${err.message}`,'warn'));
    }
  } finally {
    state.resettingTracks = false;
  }
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

  // Deterministic, not random. A random suffix meant every startShare created a
  // NEW room record while the previous one was left behind -- reload while
  // sharing, share again, and you now have two. One id per participant means a
  // re-share overwrites in place.
  const streamId = `${state.participantId}-share`;
  const share = {streamId,media,subs:[],videoMeta:null,audioMeta:null,profile:qualityId,encodings$:null,publishAttempts:0}; state.share = share;
  state.reannounce = () => announceShare(share);
  setSharingUi(true); setStatus('Publishing','warn');
  showLocalTile({id:streamId,ownerId:state.participantId,ownerName:`${state.name} (you)`,profile:qualityId,audio:Boolean(audioTrack)},media);
  if (P2P.active) { await p2pAnnounceShare(share); return; }
  await publishShare(share);
}

// Announcing was fired directly from both the video and the audio publish
// callback with no debounce, so two upserts could race and the loser could
// clobber audioTrackName. One trailing call settles it.
let announceTimer = null;
function scheduleAnnounce(share) {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    announceShare(share).catch(err => log(`announce failed: ${err.message}`,'error'));
  }, 150);
}
async function announceShare(share) {
  if (state.share !== share || !share.videoMeta?.trackName || !share.videoMeta?.sessionId) return;
  const stream = {
    id: share.streamId,
    sessionId: share.videoMeta.sessionId,
    videoTrackName: share.videoMeta.trackName,
    audioTrackName: share.audioMeta?.trackName || null,
    profile: share.profile,
    audio: Boolean(share.audioMeta),
  };
  await apiCall(`/api/rooms/${state.roomId}/stream/upsert`,{method:'POST',body:envelope({stream})});
  log(`announced to room (session ${stream.sessionId.slice(0,8)}…)${stream.audio ? ' + audio' : ''}`);
  setStatus('Sharing','ok');
}

// Split out of startShare so a media-engine rebuild can replay it against the
// SAME captured tracks. No second screen picker, no interruption for viewers
// beyond one resubscribe.
async function publishShare(share) {
  const tracks = initTracks();
  const q = QUALITY[share.profile] || QUALITY['720p60'];
  const videoTrack = share.media.getVideoTracks()[0];
  const audioTrack = share.media.getAudioTracks()[0] || null;
  if (!videoTrack || videoTrack.readyState === 'ended') {
    log('cannot publish: the screen capture has ended','error');
    await stopShare();
    return;
  }
  share.publishAttempts = (share.publishAttempts || 0) + 1;
  const attempt = share.publishAttempts;
  const encodings$ = new BehaviorSubject([{maxBitrate:q.bitrate,maxFramerate:q.fps}]);
  share.encodings$ = encodings$;
  const videoSource$ = new ReplaySubject(1);
  log(`publishing video at up to ${(q.bitrate/1e6).toFixed(1)} Mbps`);
  share.subs.push(tracks.push(videoSource$,{sendEncodings$:encodings$}).subscribe({
    next:(meta)=>{ share.videoMeta=meta; log(`video published (${meta.trackName})`); scheduleAnnounce(share); },
    error:(err)=>{ log(`video publish failed: ${err?.message || err}`,'error'); toast(`Video publish failed: ${err?.message || err}`); }
  }));
  if (audioTrack && audioTrack.readyState !== 'ended') {
    const audioSource$ = new ReplaySubject(1);
    share.subs.push(tracks.push(audioSource$).subscribe({
      next:(meta)=>{ share.audioMeta=meta; log(`audio published (${meta.trackName})`); scheduleAnnounce(share); },
      error:(err)=>{ log(`audio publish failed: ${err?.message || err}`,'warn'); toast('Video is live, but shared audio failed to publish.'); }
    }));
    audioSource$.next(audioTrack);
  }
  videoSource$.next(videoTrack);
  // A stalled publish used to just print a message. Now it actually retries.
  setTimeout(()=>{
    if (state.share !== share || share.videoMeta || share.publishAttempts !== attempt) return;
    log(`no publish confirmation after 15s (attempt ${attempt}) — rebuilding the media engine`,'error');
    if (attempt >= 4) { toast('Publishing keeps stalling. Open the Activity log; this network may need TURN.'); return; }
    resetTracks().catch(err => log(`media reset failed: ${err.message}`,'error'));
  },15000);
}

function setSharingUi(sharing) {
  $('shareBtn').classList.toggle('hidden',sharing); $('stopBtn').classList.toggle('hidden',!sharing);
  $('quality').disabled=sharing; $('contentHint').disabled=sharing; $('withAudio').disabled=sharing;
}
async function stopShare() {
  const share=state.share; if(!share)return; state.share=null; state.reannounce=null;
  clearTimeout(announceTimer); announceTimer=null;
  for(const sub of share.subs){try{sub.unsubscribe();}catch{}} try{share.encodings$?.complete();}catch{}
  share.media.getTracks().forEach(t=>{try{t.stop();}catch{}}); removeTile(share.streamId); setSharingUi(false); setStatus('Connected','ok');
  if(P2P.active){ p2pCloseAllOutbound(); await p2pHello().catch(()=>{}); p2pRebuild(); }
  else try{await apiCall(`/api/rooms/${state.roomId}/stream/remove`,{method:'POST',body:envelope({streamId:share.streamId})});}catch(err){log(`stop announce failed: ${err.message}`,'warn');}
  log('stopped sharing');
}

const sameTarget=(a,b)=>a&&b&&a.sessionId===b.sessionId&&a.videoTrackName===b.videoTrackName&&a.audioTrackName===b.audioTrackName;
async function addStream(ann){ if(state.joining.has(ann.id))return; state.joining.add(ann.id); try{await addStreamInner(ann);}finally{state.joining.delete(ann.id);} }
async function addStreamInner(ann){
  const isNewStream=!state.streams.has(ann.id);
  state.streams.set(ann.id,ann);
  if(isNewStream&&ann.ownerId!==state.participantId)sfxPlay('stream-start');
  if(ann.ownerId===state.participantId){renderPeople();return;}
  const ready=ann.p2p?true:Boolean(ann.sessionId&&ann.videoTrackName); const existing=state.subs.get(ann.id);
  if(!state.watching.has(ann.id)){ if(existing)await teardownSubscription(ann.id,{keepTile:true}); showIdleTile(ann,ready); renderPeople(); return; }
  if(existing){ if(sameTarget(existing.target,ann)){renderPeople();return;} log(`${ann.ownerName} media changed — resubscribing`,'warn'); await teardownSubscription(ann.id,{keepTile:true}); }
  if(!ready){showIdleTile(ann,false);renderPeople();return;} await subscribe(ann); renderPeople();
}
async function subscribe(ann){
  if(ann.p2p||P2P.active)return subscribeP2P(ann);
  log(`watching ${ann.ownerName}`); const tracks=initTracks(); const videoMedia=new MediaStream();
  const prior=state.subAttempts.get(ann.id)||0;
  const entry={videoMedia,audioMedia:null,subs:[],stall:null,target:{sessionId:ann.sessionId,videoTrackName:ann.videoTrackName,audioTrackName:ann.audioTrackName},strikes:0,subscribedAt:Date.now(),attempt:prior+1};
  state.subs.set(ann.id,entry); state.subAttempts.set(ann.id,entry.attempt);
  const tile=showLiveTile(ann,videoMedia); tile.note.textContent='Connecting…'; tile.note.classList.remove('hidden');
  entry.stall=setTimeout(()=>{if(videoMedia.getVideoTracks().length)return;log(`no video from ${ann.ownerName} after 15s`,'error');tile.note.textContent='No video yet — retrying…';},15000);
  entry.subs.push(tracks.pull(of({trackName:ann.videoTrackName,sessionId:ann.sessionId,location:'remote'})).subscribe({
    next:(track)=>{clearTimeout(entry.stall);for(const old of videoMedia.getVideoTracks())videoMedia.removeTrack(old);videoMedia.addTrack(track);tile.video.srcObject=videoMedia;tile.video.play().catch(()=>{});tile.note.classList.add('hidden');tile.lastFrameAt=Date.now();state.subAttempts.delete(ann.id);log(`receiving video from ${ann.ownerName}`);},
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
async function unwatchStream(streamId){if(!state.watching.has(streamId))return;const ann=state.streams.get(streamId);state.watching.delete(streamId);state.subAttempts.delete(streamId);reportWatching();await teardownSubscription(streamId,{keepTile:true});if(ann)showIdleTile(ann,Boolean(ann.sessionId&&ann.videoTrackName));log(`stopped watching ${ann?.ownerName||streamId}`);}
async function teardownSubscription(streamId,{keepTile=false}={}){const entry=state.subs.get(streamId);if(entry){clearTimeout(entry.stall);for(const sub of entry.subs){try{sub.unsubscribe();}catch{}}state.subs.delete(streamId);}const tile=state.tiles.get(streamId);if(tile){try{tile.video.srcObject=null;tile.audio.srcObject=null;}catch{}if(!keepTile)removeTile(streamId);}}
async function dropStream(streamId,{silent=false,viaOwnerLeaving=false}={}){const ann=state.streams.get(streamId);state.streams.delete(streamId);state.subAttempts.delete(streamId);
  // Someone leaving the room already plays room-leave; don't stack stream-stop
  // on top of it. Nor for our own stream, which we stopped deliberately.
  if(ann&&!viaOwnerLeaving&&ann.ownerId!==state.participantId)sfxPlay('stream-stop');if(state.watching.delete(streamId))reportWatching();await teardownSubscription(streamId);removeTile(streamId);if(!silent&&ann&&ann.ownerId!==state.participantId)log(`${ann.ownerName} stopped sharing`);renderPeople();}

function ensureTile(ann,isLocal=false){
  let entry=state.tiles.get(ann.id);if(entry)return entry;
  const card=document.createElement('div');card.className=`tile${isLocal?' local':''}`;
  card.innerHTML=`<video autoplay playsinline muted></video><audio autoplay></audio><div class="tile-idle hidden"><div class="idle-avatar"></div><div class="idle-name"></div><div class="idle-sub"></div><button class="primary idle-watch">Watch stream</button></div><div class="tile-note hidden"></div><div class="tile-bar"><span class="tile-name"></span><span class="tile-actions"><span class="tile-meta"></span><label class="tile-volume hidden" title="Stream volume"><span>🔉</span><input class="tile-volume-range" type="range" min="0" max="100" value="80" aria-label="Stream volume"></label><button class="tile-action-btn tile-audio hidden" title="Mute shared audio">🔊</button><button class="tile-action-btn tile-focus" title="Focus this stream" aria-label="Focus this stream">⤢</button><button class="tile-action-btn tile-stop hidden">Close</button></span></div>`;
  entry={card,video:card.querySelector('video'),audio:card.querySelector('audio'),audioBtn:card.querySelector('.tile-audio'),volumeWrap:card.querySelector('.tile-volume'),volumeRange:card.querySelector('.tile-volume-range'),note:card.querySelector('.tile-note'),idle:card.querySelector('.tile-idle'),statsTimer:null,lastFrameAt:0,lastMediaTime:-1};
  entry.video.addEventListener('loadedmetadata',()=>syncFocusRatio(entry));
  entry.video.addEventListener('resize',()=>syncFocusRatio(entry));
  entry.audio.muted=state.audioMuted; entry.audio.volume=state.volume; if(entry.volumeRange)entry.volumeRange.value=String(Math.round(state.volume*100));
  card.querySelector('.idle-watch').addEventListener('click',e=>{e.stopPropagation();watchStream(ann.id).catch(err=>log(err.message,'error'));});
  card.querySelector('.tile-stop').addEventListener('click',e=>{e.stopPropagation();unwatchStream(ann.id).catch(err=>log(err.message,'error'));});
  entry.audioBtn.addEventListener('click',e=>{e.stopPropagation();toggleTileAudio(ann.id);});
  entry.volumeRange?.addEventListener('click',e=>e.stopPropagation());
  entry.volumeRange?.addEventListener('input',e=>{e.stopPropagation();const v=Math.max(0,Math.min(100,Number(e.target.value)||0))/100;entry.audio.volume=v;if(v>0&&entry.audio.muted){entry.audio.muted=false;entry.audio.play().catch(()=>{});}entry.audioBtn.textContent=entry.audio.muted?'🔇':'🔊';entry.audioBtn.classList.toggle('on',!entry.audio.muted);});
  card.addEventListener('click',()=>{if(!card.classList.contains('idle'))toggleFocus(ann.id);});
  card.querySelector('.tile-focus').addEventListener('click',e=>{e.stopPropagation();toggleFocus(ann.id);});
  $('grid').appendChild(card);state.tiles.set(ann.id,entry);renderGrid();return entry;
}
function showIdleTile(ann,ready){const e=ensureTile(ann,false);clearInterval(e.statsTimer);e.statsTimer=null;e.video.srcObject=null;e.audio.srcObject=null;e.card.classList.add('idle');e.card.classList.remove('big');clearFocusIfGone(ann.id);e.note.classList.add('hidden');e.idle.classList.remove('hidden');e.card.querySelector('.tile-stop').classList.add('hidden');e.audioBtn.classList.add('hidden');e.volumeWrap.classList.add('hidden');const name=streamName(ann);e.idle.querySelector('.idle-avatar').textContent=name.slice(0,1).toUpperCase();e.idle.querySelector('.idle-name').textContent=name;e.idle.querySelector('.idle-sub').textContent=ready?`${(QUALITY[ann.profile]||QUALITY['720p60']).label}${ann.audio?' · Audio':''}`:'Starting…';const b=e.idle.querySelector('.idle-watch');b.disabled=!ready||state.budgetBlocked;b.textContent=ready?'Watch Stream':'Starting…';e.card.querySelector('.tile-name').textContent=`${name} is live`;e.card.querySelector('.tile-meta').textContent='';return e;}
function showLiveTile(ann,media){const e=ensureTile(ann,false);e.card.classList.remove('idle');e.idle.classList.add('hidden');e.card.querySelector('.tile-stop').classList.remove('hidden');e.video.srcObject=media;e.video.muted=true;e.video.play().catch(()=>{});e.card.querySelector('.tile-name').textContent=streamName(ann);e.lastFrameAt=0;clearInterval(e.statsTimer);startTileStats(e,ann);if(luckyGame.active)queueMicrotask(rehomeLuckyGame);return e;}
function showLocalTile(ann,media){const e=ensureTile(ann,true);e.card.classList.remove('idle');e.idle.classList.add('hidden');e.card.querySelector('.tile-stop').classList.add('hidden');e.audioBtn.classList.add('hidden');e.volumeWrap.classList.add('hidden');e.video.srcObject=media;e.video.muted=true;e.video.play().catch(()=>{});e.card.querySelector('.tile-name').textContent=ann.ownerName;e.lastFrameAt=Date.now();clearInterval(e.statsTimer);startTileStats(e,ann);if(luckyGame.active)queueMicrotask(rehomeLuckyGame);return e;}
function startTileStats(e,ann){
  const meta=e.card.querySelector('.tile-meta');
  const fallback=(QUALITY[ann.profile]||QUALITY['720p60']).label;
  // requestVideoFrameCallback is not universal (notably absent on some Firefox
  // builds). Where it is missing, lastFrameAt stayed 0 forever and the watchdog
  // could never repair a frozen tile. currentTime advancing is a good enough
  // proxy for "frames are decoding".
  const hasRVFC=typeof e.video.requestVideoFrameCallback==='function';
  let frames=0,last=performance.now();
  e.lastMediaTime=-1;
  const onFrame=()=>{if(!state.tiles.has(ann.id))return;frames++;e.lastFrameAt=Date.now();e.video.requestVideoFrameCallback(onFrame);};
  if(hasRVFC)e.video.requestVideoFrameCallback(onFrame);
  e.statsTimer=setInterval(()=>{
    if(!state.tiles.has(ann.id)){clearInterval(e.statsTimer);return;}
    const now=performance.now(),fps=Math.round(frames*1000/Math.max(1,now-last));
    frames=0;last=now;
    const w=e.video.videoWidth,h=e.video.videoHeight;
    meta.textContent=w?`${w}x${h} · ${fps} FPS${ann.audio?' · Audio':''}`:fallback;
    if(fps>0)e.lastFrameAt=Date.now();
    // Runs regardless of rVFC support: it is also the only liveness signal that
    // survives a backgrounded tab, where rVFC stops firing entirely.
    const t=e.video.currentTime;
    if(t!==e.lastMediaTime){e.lastMediaTime=t;e.lastFrameAt=Date.now();}
  },2000);
}
function removeTile(id){const e=state.tiles.get(id);if(!e)return;if(state.focusedId===id)state.focusedId=null;clearInterval(e.statsTimer);try{e.video.srcObject=null;e.audio.srcObject=null;}catch{}e.card.remove();state.tiles.delete(id);renderGrid();if(luckyGame.active)queueMicrotask(rehomeLuckyGame);}
// FOCUS — exactly one tile at a time.
//
// This was a bare classList.toggle('big'), so every tile could be big at once
// and each one claimed a full row: a scrolling stack of huge screens. Focus is a
// single value now, and focusing another stream releases the previous one
// instead of adding to it.
function setFocus(streamId) {
  const next = streamId && state.tiles.has(streamId) ? streamId : null;
  if (state.focusedId === next) return;
  state.focusedId = next;
  for (const [id, entry] of state.tiles) entry.card.classList.toggle('big', id === next);
  renderGrid();
  if (next) {
    const entry = state.tiles.get(next);
    syncFocusRatio(entry);
    entry.card.scrollIntoView({ block:'nearest', behavior:'smooth' });
  }
}
function toggleFocus(streamId) { setFocus(state.focusedId === streamId ? null : streamId); }
function clearFocusIfGone(streamId) { if (state.focusedId === streamId) setFocus(null); }

// The black bars were letterboxing: the tile was pinned to the viewport and the
// video fitted inside it, so any leftover space painted black. Give the tile the
// video's real aspect ratio instead and let it size itself -- then the frame IS
// the picture and there is no leftover space at all.
function syncFocusRatio(entry) {
  if (!entry?.video) return;
  const w = entry.video.videoWidth, h = entry.video.videoHeight;
  if (w > 0 && h > 0) entry.card.style.setProperty('--ar', `${w} / ${h}`);
}

function renderGrid(){
  const count=state.tiles.size,grid=$('grid');
  $('empty').classList.toggle('hidden',count>0);
  grid.classList.toggle('hidden',count===0);
  grid.classList.remove('count-1','count-2','count-3','count-many');
  grid.classList.add(count===1?'count-1':count===2?'count-2':count===3?'count-3':'count-many');
  // Focus mode is a different layout, not a bigger tile: one stage plus a rail.
  const focused=Boolean(state.focusedId&&state.tiles.has(state.focusedId));
  grid.classList.toggle('focus-mode',focused);
  grid.classList.toggle('has-rail',focused&&count>1);
  document.body.classList.toggle('is-focused',focused);
}

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
  if(state.leaving||state.budgetBlocked||state.resettingTracks)return;
  // NEVER run while hidden. requestVideoFrameCallback is tied to the rendering
  // steps, which browsers pause for a background tab -- so lastFrameAt freezes
  // even though the SFU is still delivering. The watchdog read that as "no
  // frames", tore down every subscription and rebuilt them, on a loop, for as
  // long as the tab stayed in the background. That is a self-inflicted outage
  // and the single biggest reason the app fell apart while you were away.
  if(document.hidden)return;
  const now=Date.now();
  for(const [streamId,entry] of [...state.subs]){
    if(!state.watching.has(streamId))continue;
    const ann=state.streams.get(streamId),tile=state.tiles.get(streamId);
    if(!ann||!tile||!entry.target?.sessionId)continue;
    if(tile.lastFrameAt&&now-tile.lastFrameAt<12000){entry.strikes=0;continue;}
    // The old guard was `if(!tile.lastFrameAt) continue;`, which skipped any
    // tile that had NEVER produced a frame -- exactly the case the "retrying
    // automatically" note claimed to cover. Fall back to when we subscribed.
    const reference=tile.lastFrameAt||entry.subscribedAt||0;
    if(!reference||now-reference<12000)continue;
    entry.strikes=(entry.strikes||0)+1;
    if(entry.strikes<2)continue;
    entry.strikes=0;
    // Repeated failures on one tile mean the session is the problem, not the
    // subscription; rebuild the whole engine instead of looping forever.
    if(entry.attempt>=3){
      log(`${streamName(ann)} failed ${entry.attempt} subscribe attempts — rebuilding the media engine`,'warn');
      state.subAttempts.delete(streamId);
      await resetTracks();
      return;
    }
    log(`no frames from ${streamName(ann)} — rebuilding subscription (attempt ${entry.attempt+1})`,'warn');
    await teardownSubscription(streamId,{keepTile:true});
    if(state.watching.has(streamId)&&state.streams.has(streamId))await subscribe(state.streams.get(streamId));
  }
}
function estimateEgress(){let bps=0;for(const id of state.watching){const s=state.streams.get(id);if(s)bps+=(QUALITY[s.profile]||QUALITY['720p60']).bitrate;}return bps;}
// Render only. The numbers arrive on the socket now; this never touches the
// network. Split out so server-ping, the opening snapshot and the local GB/h
// timer all share one code path.
function applyBudget(budget){
  if(budget)state.budget=budget;
  const bps=estimateEgress(),gbph=(bps/8)*3600/1e9;const b=state.budget;const el=$('budget');
  if(!b){el.textContent='idle';return;}
  const pct=b.percent??0;
  el.textContent=`${b.usedGb.toFixed(1)} / ${b.capGb} GB${bps?` · ${gbph.toFixed(1)} GB/h`:''}`;
  el.className=`budget ${b.blocked||pct>=95?'bad':pct>=75?'warn':''}`;
  applyBudgetBlock(Boolean(b.blocked),b);
}
async function tickBudget(){
  // Was: every client fetching /api/budget every 15s, forever, each fetch a
  // Worker request plus a BudgetTracker request -- six people idling in a room
  // generated ~5,800 requests an hour for a number that only the server can
  // change. The room now pushes it on every server-ping.
  //
  // The only remaining network path is the one case where pushes have stopped:
  // a dead socket. Everything else is a local re-render of the GB/h readout.
  if(!(state.ws&&state.ws.readyState===WebSocket.OPEN)){
    try{applyBudget(await apiCall('/api/budget'));return;}catch{}
  }
  applyBudget(null);
}
function applyBudgetBlock(blocked,budget){if(blocked===state.budgetBlocked)return;state.budgetBlocked=blocked;$('shareBtn').disabled=blocked||!state.participantId;$('budgetBanner').classList.toggle('hidden',!blocked);if(blocked){$('budgetBanner').textContent=`Bandwidth cap reached: ${budget.usedGb.toFixed(1)} of ${budget.capGb} GB used in the last ${budget.windowDays} days. New media is paused to protect the account.`;if(state.share)stopShare().catch(()=>{});}for(const [id,t] of state.tiles){if(!t.card.classList.contains('idle'))continue;const a=state.streams.get(id),b=t.idle.querySelector('.idle-watch');b.disabled=blocked||!(a?.sessionId&&a?.videoTrackName);}}
async function syncSnapshot(reason='poll'){
  if(state.leaving||!state.participantId||state.pollInFlight)return;
  state.pollInFlight=true;
  try{const snap=await apiCall(`/api/rooms/${state.roomId}/snapshot`);await reconcileSnapshot(snap,reason);}finally{state.pollInFlight=false;}
}
async function poll(){
  // THE FALLBACK IS NOW ACTUALLY A FALLBACK.
  //
  // This used to fire every 2.5s unconditionally -- while the socket was open,
  // healthy, and already pushing every change. Six people in a room for four
  // hours was ~35,000 wasted snapshot requests, and each one costs a Worker
  // request AND a Durable Object request. That, not media, is what ate the
  // daily limit.
  //
  // The socket is authoritative. While it is OPEN this function sends nothing.
  // Divergence is caught by the `rev` on every server-ping instead, which is an
  // outbound frame and therefore free.
  if(state.leaving||!state.participantId)return;
  if(state.ws&&state.ws.readyState===WebSocket.OPEN)return;
  // Socket is down: this is the only presence signal we have, so poll properly.
  // Back off in a hidden tab, where nobody is looking at the result anyway.
  if(document.hidden){state.hiddenTicks=(state.hiddenTicks||0)+1;if(state.hiddenTicks%4)return;}
  else state.hiddenTicks=0;
  try{await syncSnapshot('poll');}catch(err){log(`fallback sync failed: ${err.message}`,'warn');}
}

function applySidebar(hidden){$('room').classList.toggle('no-members',hidden);try{localStorage.setItem('simpleshare-hide-members',hidden?'1':'0');}catch{}}
function leaveRoom(){state.leaving=true;if(P2P.active)p2pShutdown();clearSocketTimers();clearTimeout(state.pcRecoverTimer);clearInterval(state.pollTimer);clearInterval(state.watchdogTimer);clearInterval(state.budgetTimer);stopShare().catch(()=>{});try{state.ws?.close();}catch{}location.href='/';}
async function boot(){
  const params=new URLSearchParams(location.search);if(params.get('debug')==='1'){setLogLevel('debug');openLog();}
  // ?p2p=1 forces the fallback without waiting for a quota failure. This is the
  // only way to exercise the path deliberately -- and a fallback you have never
  // exercised is a fallback that does not work.
  const forceP2P = params.get('p2p') === '1';
  const config=await fetch('/api/config').then(r=>r.json()).catch(()=>({roomApiUrl:''}));state.apiBase=normalizeBase(config.roomApiUrl);const roomId=params.get('room');
  if(!roomId){$('home').classList.remove('hidden');return;}if(!state.apiBase){log('no ROOM_API_URL configured — going straight to peer-to-peer','warn');state.roomId=roomId;state.name=localStorage.getItem('simpleshare-name')||`Guest ${randomId(1).toUpperCase()}`;$('room').classList.remove('hidden');$('inviteLink').value=location.href;$('myName').value=state.name;try{await enterP2PMode('no-backend');renderPeople();renderGrid();}catch(e){$('home').classList.remove('hidden');toast(`Could not start peer-to-peer: ${e.message}`);}return;}
  state.roomId=roomId;state.name=localStorage.getItem('simpleshare-name')||`Guest ${randomId(1).toUpperCase()}`;state.volume=Math.max(0,Math.min(1,Number(localStorage.getItem('simpleshare-volume')||0.8)));$('room').classList.remove('hidden');$('inviteLink').value=location.href;$('myName').value=state.name;if($('displayName'))$('displayName').value=state.name;if($('volumeSlider'))$('volumeSlider').value=String(Math.round(state.volume*100));applyGlobalVolume(state.volume);try{applySidebar(localStorage.getItem('simpleshare-hide-members')==='1');}catch{}
  setStatus('Connecting','warn');log(`room ${roomId}`);
  if(forceP2P){
    log('?p2p=1 — forcing peer-to-peer mode','warn');
    try{ await enterP2PMode('forced'); renderPeople(); renderGrid(); return; }
    catch(e){ log(`peer-to-peer failed: ${e.message}`,'error'); setStatus('P2P failed','bad'); openLog(); return; }
  }
  // The backend check is no longer a dead end. If the Worker cannot answer --
  // quota gone, deploy broken, Cloudflare down, no network to it at all -- the
  // room still opens, just peer-to-peer.
  try{
    const health=await apiCall('/health');
    log(`backend ok (build ${health.build})`);
    if(!health.realtimeConfigured)throw new Error('Worker is missing Cloudflare Realtime credentials.');
  }catch(err){
    log(`backend check failed: ${err.message}`,'error');
    if(isQuotaFailure(err)){
      try{ await enterP2PMode('backend-quota'); renderPeople(); renderGrid(); return; }
      catch(e){ log(`peer-to-peer fallback failed: ${e.message}`,'error'); }
    }
    setStatus('Backend down','bad'); openLog(); return;
  }
  try{
    await joinRoom();
  }catch(err){
    if(isQuotaFailure(err)){
      try{ await enterP2PMode('join'); renderPeople(); renderGrid(); return; }
      catch(e){ log(`peer-to-peer fallback failed: ${e.message}`,'error'); setStatus('Join failed','bad'); openLog(); return; }
    }
    log(`could not join: ${err.message}`,'error');setStatus('Join failed','bad');openLog();return;
  }
  // These used to sit AFTER `await connectSocket()` inside the same try, so a
  // single failed socket upgrade permanently skipped the fallback poll, the
  // stall watchdog and the budget meter for the life of the page -- even once
  // the socket reconnected on its own.
  initTracks();renderPeople();renderGrid();
  // pollTimer stays at 2.5s because it is now a no-op whenever the socket is
  // open; the interval only governs how fast we recover once it is not.
  state.pollTimer=setInterval(()=>poll().catch(()=>{}),2500);
  state.watchdogTimer=setInterval(()=>watchdog().catch(err=>log(`watchdog: ${err.message}`,'warn')),8000);
  // Local re-render of the GB/h figure. The budget itself rides the socket.
  state.budgetTimer=setInterval(()=>tickBudget().catch(()=>{}),15000);
  try{
    await connectSocket();
  }catch(err){
    log(`socket connect failed: ${err.message} — retrying`,'warn');setStatus('Reconnecting','warn');scheduleReconnect();
  }
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
if($('sfxToggle')){
  $('sfxToggle').checked=SFX.enabled;
  $('sfxToggle').addEventListener('change',(e)=>{sfxSetEnabled(e.target.checked);log(`presence sounds ${e.target.checked?'on':'off'}`);});
}
if($('sfxSlider')){
  $('sfxSlider').value=String(Math.round(SFX.volume*100));
  if($('sfxValue'))$('sfxValue').textContent=`${Math.round(SFX.volume*100)}%`;
  $('sfxSlider').addEventListener('input',(e)=>{
    const v=(Number(e.target.value)||0)/100;
    sfxSetVolume(v);
    if($('sfxValue'))$('sfxValue').textContent=`${Math.round(v*100)}%`;
  });
  // Preview on release rather than on every input tick.
  $('sfxSlider').addEventListener('change',()=>{sfxUnlock();sfxPlay('viewer-join',{force:true});});
}
$('quality')?.addEventListener('change',()=>{const q=QUALITY[$('quality').value];log(`quality set to ${q.label}`);});
$('leaveBtn')?.addEventListener('click',leaveRoom);$('leaveDockBtn')?.addEventListener('click',leaveRoom);$('logToggle')?.addEventListener('click',()=>$('logPanel').classList.toggle('open'));
$('logClose')?.addEventListener('click',()=>setLogVisible(false));
$('afkBtn')?.addEventListener('click',stepAway);
$('logBtn')?.addEventListener('click',()=>{const on=!$('logPanel').classList.contains('visible');setLogVisible(on,{expand:on});});
try{ if(localStorage.getItem('simpleshare-log')==='1') setLogVisible(true); }catch{}
window.addEventListener('focus',()=>scheduleImmediateSync('focus'));
document.addEventListener('visibilitychange',()=>{
  if(document.hidden){state.hiddenAt=Date.now();return;}
  const away=state.hiddenAt?Math.round((Date.now()-state.hiddenAt)/1000):0;
  if(away>5)log(`back after ${away}s away — verifying the connection`);
  state.hiddenTicks=0;
  grantWatchdogGrace();
  probeSocket('visibility');
  scheduleImmediateSync('visible');
});
// A suspended laptop or a phone that backgrounded the browser comes back with a
// socket the OS quietly killed. Treat regaining the network as a wake-up.
window.addEventListener('online',()=>{
  log('network is back');
  state.reconnectAttempts=0;
  clearTimeout(state.reconnectTimer);state.reconnectTimer=null;
  grantWatchdogGrace();
  probeSocket('online');
  scheduleImmediateSync('online');
});
window.addEventListener('offline',()=>{log('network went offline','warn');setStatus('Offline','bad');});
// Chrome may freeze a backgrounded tab outright. Timers do not run while frozen,
// so on resume every clock we hold is stale.
document.addEventListener('freeze',()=>{state.hiddenAt=Date.now();log('tab frozen by the browser','warn');});
document.addEventListener('resume',()=>{
  log('tab resumed');
  state.reconnectAttempts=0;
  grantWatchdogGrace();
  probeSocket('resume');
});
document.addEventListener('pointerdown',()=>{state.audioUnlocked=true;sfxUnlock();for(const [id,tile] of state.tiles){if(state.subs.has(id)&&tile.audio.srcObject&&!state.audioMuted&&tile.audio.muted){tile.audio.muted=false;tile.audio.volume=state.volume;tile.audio.play().catch(()=>{tile.audio.muted=true;});}}refreshGlobalAudioButton();},{once:true,capture:true});
// `beforeunload` also fires when a page is put into the back/forward cache. It
// set state.leaving = true permanently, so if you navigated away and came back
// the restored page had every reconnect, poll and watchdog path disabled for
// good -- it looked connected and was completely inert. pagehide distinguishes
// the two cases; only a real unload is leaving.
window.addEventListener('pagehide',(e)=>{
  if(e.persisted){clearSocketTimers();return;}
  state.leaving=true;clearSocketTimers();
  // Retire the stream on the way out instead of leaving it for the sweep. A
  // normal fetch is cancelled as the page tears down; keepalive survives it.
  if(state.share&&state.apiBase){
    try{
      fetch(`${state.apiBase}/api/rooms/${state.roomId}/stream/remove`,{
        method:'POST',keepalive:true,
        headers:{'content-type':'application/json'},
        body:JSON.stringify(envelope({streamId:state.share.streamId})),
      }).catch(()=>{});
    }catch{}
  }
  try{state.ws?.close();}catch{}
});
window.addEventListener('keydown',(e)=>{ if(e.key==='Escape'&&state.focusedId)setFocus(null); });
window.addEventListener('pagehide',()=>{ if(P2P.active)try{p2pShutdown();}catch{} });
window.addEventListener('pageshow',(e)=>{
  if(!e.persisted)return;
  log('page restored from the back/forward cache — rebuilding the connection','warn');
  sfxQuiet(2500);
  state.leaving=false;state.reconnectAttempts=0;state.hiddenTicks=0;
  grantWatchdogGrace();
  recoverConnection().catch(err=>{log(`restore failed: ${err.message}`,'warn');scheduleReconnect();});
});

boot();
