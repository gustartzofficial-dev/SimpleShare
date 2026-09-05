/*
 * SimpleShare Windows prestige-theme PlayStation emulator integration.
 *
 * This module is deliberately isolated from the call / WebRTC stack. It only
 * augments the existing Windows XP and Windows 98 desktop easter eggs.
 * EmulatorJS is lazy-loaded inside an iframe after the user chooses a game.
 */

const SS_PS1_THEME_IDS = new Set(['xp', 'win98']);
const SS_PS1_DB_NAME = 'simpleshare-ps1';
const SS_PS1_DB_VERSION = 1;
const SS_PS1_STORE = 'files';
const SS_PS1_CDN = 'https://cdn.emulatorjs.org/4.2.1/data/';
const SS_PS1_LOADER = `${SS_PS1_CDN}loader.js`;
const SS_PS1_GAME_EXTENSIONS = ['chd', 'pbp', 'zip', 'bin', 'cue', 'iso', 'img'];

const ps1State = {
  gameFile: null,
  biosRecord: null,
  gameUrl: '',
  biosUrl: '',
  frame: null,
  running: false,
  minimized: false,
  lastStatus: 'Ready',
};

function ps1IsWindowsTheme() {
  return SS_PS1_THEME_IDS.has(document.documentElement.dataset.theme || '');
}

function ps1SetStatus(message, tone = '') {
  ps1State.lastStatus = message;
  const node = document.getElementById('ps1Status');
  if (!node) return;
  node.textContent = message;
  node.dataset.tone = tone;
}

function ps1SetBiosLabel() {
  const node = document.getElementById('ps1BiosStatus');
  if (!node) return;
  if (ps1State.biosRecord?.blob) {
    node.textContent = `BIOS: ${ps1State.biosRecord.name || 'saved locally'}`;
    node.dataset.ready = '1';
  } else {
    node.textContent = 'BIOS: not selected';
    delete node.dataset.ready;
  }
}

function ps1SetGameLabel() {
  const node = document.getElementById('ps1DiscLabel');
  const start = document.getElementById('ps1StartBtn');
  if (!node || !start) return;
  if (ps1State.gameFile) {
    node.textContent = ps1State.gameFile.name;
    node.title = ps1State.gameFile.name;
    start.disabled = false;
    start.textContent = ps1State.running ? 'Restart' : 'Start';
  } else {
    node.textContent = 'No disc inserted';
    node.removeAttribute('title');
    start.disabled = true;
    start.textContent = 'Start';
  }
}

function ps1HashGame(file) {
  const input = `${file?.name || ''}|${file?.size || 0}|${file?.lastModified || 0}`;
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) || 1;
}

function ps1Ext(file) {
  const name = String(file?.name || '');
  const idx = name.lastIndexOf('.');
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : '';
}

function ps1HumanSize(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(value > 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function ps1ScriptValue(value) {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

function ps1OpenDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('IndexedDB unavailable'));
      return;
    }
    const request = indexedDB.open(SS_PS1_DB_NAME, SS_PS1_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(SS_PS1_STORE)) db.createObjectStore(SS_PS1_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open emulator storage'));
  });
}

async function ps1DbGet(key) {
  const db = await ps1OpenDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(SS_PS1_STORE, 'readonly');
      const req = tx.objectStore(SS_PS1_STORE).get(key);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error || new Error('Could not read emulator storage'));
    });
  } finally {
    db.close();
  }
}

async function ps1DbPut(key, value) {
  const db = await ps1OpenDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SS_PS1_STORE, 'readwrite');
      tx.objectStore(SS_PS1_STORE).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Could not save emulator data'));
      tx.onabort = () => reject(tx.error || new Error('Could not save emulator data'));
    });
  } finally {
    db.close();
  }
}

async function ps1DbDelete(key) {
  const db = await ps1OpenDb();
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SS_PS1_STORE, 'readwrite');
      tx.objectStore(SS_PS1_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('Could not update emulator storage'));
    });
  } finally {
    db.close();
  }
}

function ps1RevokeObjectUrls() {
  if (ps1State.gameUrl) URL.revokeObjectURL(ps1State.gameUrl);
  if (ps1State.biosUrl) URL.revokeObjectURL(ps1State.biosUrl);
  ps1State.gameUrl = '';
  ps1State.biosUrl = '';
}

function ps1StopSession({ keepMessage = false } = {}) {
  const frame = ps1State.frame || document.getElementById('ps1Frame');
  if (frame) {
    try {
      const terminate = frame.contentWindow?.EJS_terminate;
      if (typeof terminate === 'function') terminate();
    } catch {}
    frame.remove();
  }
  ps1State.frame = null;
  ps1State.running = false;
  ps1RevokeObjectUrls();

  const viewport = document.getElementById('ps1Viewport');
  const splash = document.getElementById('ps1Splash');
  if (viewport && splash && !viewport.contains(splash)) viewport.appendChild(splash);
  splash?.classList.remove('hidden');
  if (!keepMessage) ps1SetStatus('Ready');
  ps1SetGameLabel();
}

function ps1BuildFrameDocument({ gameUrl, biosUrl, gameName, gameId }) {
  const player = ps1ScriptValue('#game');
  const core = ps1ScriptValue('psx');
  const game = ps1ScriptValue(gameUrl);
  const bios = ps1ScriptValue(biosUrl);
  const dataPath = ps1ScriptValue(SS_PS1_CDN);
  const loader = ps1ScriptValue(SS_PS1_LOADER);
  const title = ps1ScriptValue(gameName);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body,#game{width:100%;height:100%;margin:0;background:#000;overflow:hidden}
body{font-family:Arial,sans-serif}
#game{display:grid;place-items:stretch}
</style>
</head>
<body>
<div id="game"></div>
<script>
window.EJS_player = ${player};
window.EJS_core = ${core};
window.EJS_gameUrl = ${game};
window.EJS_biosUrl = ${bios};
window.EJS_gameName = ${title};
window.EJS_gameID = ${Number(gameId) || 1};
window.EJS_pathtodata = ${dataPath};
window.EJS_startOnLoaded = true;
window.EJS_fullscreenOnLoaded = false;
window.EJS_disableAutoLang = true;
window.EJS_language = 'en-US';
window.EJS_volume = 0.75;
window.EJS_askBeforeExit = false;
window.EJS_ready = function(){
  try { parent.postMessage({type:'simpleshare-ps1-ready'}, '*'); } catch {}
};
window.EJS_onExit = function(){
  try { parent.postMessage({type:'simpleshare-ps1-exit'}, '*'); } catch {}
};
const loader = document.createElement('script');
loader.src = ${loader};
loader.async = true;
loader.onerror = function(){
  try { parent.postMessage({type:'simpleshare-ps1-error',message:'Could not load the emulator engine.'}, '*'); } catch {}
};
document.body.appendChild(loader);
<\/script>
</body>
</html>`;
}

async function ps1StartSession() {
  if (!ps1State.gameFile) {
    ps1SetStatus('Choose a PlayStation game first.', 'warn');
    document.getElementById('ps1GameInput')?.click();
    return;
  }
  if (!ps1State.biosRecord?.blob) {
    ps1SetStatus('Choose a PlayStation BIOS first.', 'warn');
    document.getElementById('ps1BiosInput')?.click();
    return;
  }

  ps1StopSession({ keepMessage: true });
  ps1State.gameUrl = URL.createObjectURL(ps1State.gameFile);
  ps1State.biosUrl = URL.createObjectURL(ps1State.biosRecord.blob);

  const frame = document.createElement('iframe');
  frame.id = 'ps1Frame';
  frame.className = 'ps1-frame';
  frame.title = `PlayStation emulator - ${ps1State.gameFile.name}`;
  frame.allow = 'autoplay; fullscreen; gamepad';
  frame.setAttribute('allowfullscreen', '');
  frame.referrerPolicy = 'no-referrer';
  frame.srcdoc = ps1BuildFrameDocument({
    gameUrl: ps1State.gameUrl,
    biosUrl: ps1State.biosUrl,
    gameName: ps1State.gameFile.name.replace(/\.[^.]+$/, ''),
    gameId: ps1HashGame(ps1State.gameFile),
  });

  const viewport = document.getElementById('ps1Viewport');
  const splash = document.getElementById('ps1Splash');
  if (!viewport) return;
  splash?.classList.add('hidden');
  viewport.appendChild(frame);
  ps1State.frame = frame;
  ps1State.running = true;
  ps1SetStatus(`Booting ${ps1State.gameFile.name}...`);
  ps1SetGameLabel();
}

function ps1OpenWindow() {
  if (!ps1IsWindowsTheme()) return;
  const win = document.getElementById('ps1Window');
  if (!win) return;
  win.classList.remove('hidden');
  ps1State.minimized = false;
  document.getElementById('ps1TaskButton')?.classList.add('active');
  ps1SetBiosLabel();
  ps1SetGameLabel();
  ps1SetStatus(ps1State.running ? `Running ${ps1State.gameFile?.name || 'game'}` : ps1State.lastStatus || 'Ready');
  win.style.zIndex = '12';
}

function ps1MinimizeWindow() {
  const win = document.getElementById('ps1Window');
  if (!win || win.classList.contains('hidden')) return;
  // Do not let hidden emulator audio/CPU continue behind the fake desktop.
  // Keep the selected files in memory so restarting is one click.
  if (ps1State.running) {
    ps1StopSession({ keepMessage: true });
    ps1SetStatus('Suspended - press Start to resume from a fresh boot.', 'warn');
  }
  win.classList.add('hidden');
  ps1State.minimized = true;
  document.getElementById('ps1TaskButton')?.classList.remove('active');
}

function ps1CloseWindow({ forgetGame = true } = {}) {
  const win = document.getElementById('ps1Window');
  ps1StopSession({ keepMessage: true });
  win?.classList.add('hidden');
  win?.classList.remove('maximized');
  if (forgetGame) ps1State.gameFile = null;
  ps1State.minimized = false;
  ps1SetGameLabel();
  ps1SetStatus('Ready');
  document.getElementById('ps1TaskButton')?.classList.add('hidden');
  document.getElementById('ps1TaskButton')?.classList.remove('active');
}

function ps1ToggleMaximize() {
  const win = document.getElementById('ps1Window');
  if (!win) return;
  win.classList.toggle('maximized');
}

async function ps1ToggleFullscreen() {
  const target = document.getElementById('ps1Viewport');
  if (!target) return;
  try {
    if (document.fullscreenElement === target) {
      await document.exitFullscreen();
    } else if (target.requestFullscreen) {
      await target.requestFullscreen();
    }
  } catch (error) {
    ps1SetStatus(`Fullscreen failed: ${error.message}`, 'bad');
  }
}

function ps1ValidateGame(file) {
  const ext = ps1Ext(file);
  if (!SS_PS1_GAME_EXTENSIONS.includes(ext)) {
    throw new Error('Unsupported file type. Use CHD, PBP, ZIP, BIN/CUE, ISO or IMG.');
  }
  if (file.size <= 0) throw new Error('That game file is empty.');
  return ext;
}

async function ps1ChooseGame(file) {
  if (!file) return;
  try {
    const ext = ps1ValidateGame(file);
    ps1StopSession({ keepMessage: true });
    ps1State.gameFile = file;
    ps1SetGameLabel();
    const qualifier = ext === 'cue'
      ? ' CUE files normally need their BIN tracks packaged together in a ZIP.'
      : '';
    ps1SetStatus(`Disc ready: ${file.name} (${ps1HumanSize(file.size)}).${qualifier}`, ext === 'cue' ? 'warn' : '');
  } catch (error) {
    ps1SetStatus(error.message, 'bad');
  }
}

async function ps1ChooseBios(file) {
  if (!file) return;
  try {
    if (file.size < 256 * 1024 || file.size > 4 * 1024 * 1024) {
      ps1SetStatus('That BIOS size looks unusual. A normal PS1 BIOS is typically 512 KB.', 'warn');
    }
    const record = { blob: file.slice(0, file.size, file.type || 'application/octet-stream'), name: file.name, savedAt: Date.now() };
    ps1State.biosRecord = record;
    try {
      await ps1DbPut('bios', record);
      ps1SetStatus(`BIOS saved locally: ${file.name}`);
    } catch {
      ps1SetStatus(`BIOS loaded for this session: ${file.name}`, 'warn');
    }
    ps1SetBiosLabel();
  } catch (error) {
    ps1SetStatus(`BIOS error: ${error.message}`, 'bad');
  }
}

async function ps1ForgetBios() {
  ps1State.biosRecord = null;
  try { await ps1DbDelete('bios'); } catch {}
  ps1StopSession({ keepMessage: true });
  ps1SetBiosLabel();
  ps1SetStatus('Saved BIOS removed.');
}

function ps1InstallDrag() {
  const win = document.getElementById('ps1Window');
  const bar = document.getElementById('ps1Titlebar');
  if (!win || !bar) return;

  let drag = null;
  bar.addEventListener('pointerdown', (event) => {
    if (event.button !== 0 || event.target.closest('button') || win.classList.contains('maximized')) return;
    const rect = win.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    bar.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  bar.addEventListener('pointermove', (event) => {
    if (!drag) return;
    const maxLeft = Math.max(0, innerWidth - win.offsetWidth);
    const maxTop = Math.max(0, innerHeight - win.offsetHeight - 34);
    const left = Math.max(0, Math.min(maxLeft, drag.left + event.clientX - drag.x));
    const top = Math.max(0, Math.min(maxTop, drag.top + event.clientY - drag.y));
    win.style.left = `${left}px`;
    win.style.top = `${top}px`;
    win.style.transform = 'none';
  });
  const end = () => { drag = null; };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('dblclick', (event) => {
    if (!event.target.closest('button')) ps1ToggleMaximize();
  });
}

function ps1InstallStyles() {
  if (document.getElementById('simpleshare-ps1-styles')) return;
  const style = document.createElement('style');
  style.id = 'simpleshare-ps1-styles';
  style.textContent = `
    .ps1-desktop-icon,.ps1-start-entry,.ps1-task-button{display:none!important}
    html[data-theme="xp"] .ps1-desktop-icon,
    html[data-theme="win98"] .ps1-desktop-icon{display:flex!important}
    html[data-theme="xp"] .ps1-start-entry,
    html[data-theme="win98"] .ps1-start-entry{display:flex!important}
    html[data-theme="xp"] .ps1-task-button:not(.hidden),
    html[data-theme="win98"] .ps1-task-button:not(.hidden){display:flex!important}

    .ps1-desktop-glyph{position:relative;width:34px;height:34px;display:grid;place-items:center}
    .ps1-desktop-glyph::before{content:"";position:absolute;width:28px;height:28px;border-radius:50%;background:radial-gradient(circle at 43% 38%,#fff 0 8%,#d4d7dc 9% 42%,#767b83 43% 54%,#181b20 55% 100%);box-shadow:1px 2px 2px rgba(0,0,0,.45)}
    .ps1-desktop-glyph::after{content:"PS";position:relative;font:900 8px/1 Arial,sans-serif;color:#111;text-shadow:0 1px rgba(255,255,255,.45)}

    .ps1-window{width:min(920px,calc(100vw - 120px));height:min(690px,calc(100vh - 92px));min-width:520px;min-height:390px;display:grid!important;grid-template-rows:auto auto auto minmax(0,1fr) auto;overflow:hidden;resize:both}
    .ps1-window.hidden{display:none!important}
    .ps1-window.maximized{left:6px!important;top:6px!important;right:6px!important;bottom:42px!important;width:auto!important;height:auto!important;max-width:none!important;max-height:none!important;transform:none!important;resize:none}
    html[data-theme="win98"] .ps1-window.maximized{bottom:34px!important}

    .ps1-titlebar{cursor:default;user-select:none;touch-action:none}
    .ps1-titlebar strong{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .ps1-title-icon{width:16px;height:16px;display:grid;place-items:center;font:900 8px/1 Arial,sans-serif;background:#111;color:#eee;border:1px solid rgba(255,255,255,.35)}
    .ps1-title-actions{margin-left:auto;display:flex;gap:2px}
    .ps1-title-actions button{display:grid;place-items:center;padding:0;font-weight:700}

    .ps1-menubar{display:flex;align-items:center;gap:2px;padding:2px 5px;min-height:25px;user-select:none}
    .ps1-menubar button{background:transparent!important;border:0!important;box-shadow:none!important;padding:3px 8px!important;font:inherit!important;color:inherit!important}

    .ps1-toolbar{display:flex;align-items:center;gap:5px;padding:5px 6px;border-bottom:1px solid rgba(0,0,0,.25);user-select:none;overflow-x:auto}
    .ps1-toolbar button{min-height:28px;padding:4px 10px;white-space:nowrap}
    .ps1-toolbar .ps1-spacer{flex:1}
    .ps1-toolbar .ps1-disc-label{min-width:0;max-width:270px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}

    .ps1-viewport{position:relative;min-width:0;min-height:0;overflow:hidden;background:#050505;display:grid;place-items:stretch}
    .ps1-viewport:fullscreen{width:100vw;height:100vh;background:#000}
    .ps1-frame{width:100%;height:100%;border:0;display:block;background:#000}
    .ps1-splash{position:absolute;inset:0;display:grid;place-items:center;text-align:center;padding:28px;color:#d8d8d8;background:radial-gradient(circle at 50% 42%,#2c313a 0,#11151b 38%,#050608 75%)}
    .ps1-splash.hidden{display:none!important}
    .ps1-splash-inner{max-width:500px}
    .ps1-disc-art{width:112px;height:112px;margin:0 auto 20px;border-radius:50%;display:grid;place-items:center;background:radial-gradient(circle at 43% 39%,#fff 0 5%,#d9dce1 6% 33%,#9da2aa 34% 49%,#34383f 50% 57%,#090b0f 58% 100%);box-shadow:0 18px 50px rgba(0,0,0,.55),inset 0 0 0 1px rgba(255,255,255,.28)}
    .ps1-disc-art span{width:32px;height:32px;border-radius:50%;display:grid;place-items:center;background:#dadde2;color:#15171b;font:900 11px Arial,sans-serif;border:2px solid #777c84}
    .ps1-splash h3{margin:0 0 8px;font:600 20px/1.2 Arial,sans-serif;color:#f1f1f1}
    .ps1-splash p{margin:0 auto 8px;max-width:460px;font:12px/1.5 Arial,sans-serif;color:#aeb4bd}
    .ps1-splash small{display:block;margin-top:12px;color:#7f8792}

    .ps1-statusbar{display:flex;align-items:center;gap:8px;min-height:24px;padding:2px 6px;font-size:10px;overflow:hidden}
    .ps1-statusbar span{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    #ps1Status{flex:1}
    #ps1Status[data-tone="warn"]{color:#8a5c00}
    #ps1Status[data-tone="bad"]{color:#a11414}
    #ps1BiosStatus[data-ready="1"]::before{content:"● ";color:#16822b}
    #ps1BiosStatus:not([data-ready="1"])::before{content:"○ ";color:#777}

    .ps1-privacy-note{font-size:10px;opacity:.78}
    .ps1-window input[type="file"]{display:none!important}

    html[data-theme="xp"] .ps1-window{background:#ece9d8;border:3px solid #0a4abf;border-radius:7px 7px 2px 2px;box-shadow:5px 9px 28px rgba(0,0,0,.4);font-family:Tahoma,"Trebuchet MS",Arial,sans-serif;color:#111}
    html[data-theme="xp"] .ps1-titlebar{height:30px;background:linear-gradient(#3d95ff,#0c5dda 52%,#0647b7);color:#fff;padding:0 4px 0 7px;text-shadow:1px 1px #123b88;border-radius:4px 4px 0 0}
    html[data-theme="xp"] .ps1-title-actions button{width:22px;height:21px;color:#fff;background:linear-gradient(#68adff,#1764ce 58%,#0e4cad)!important;border:1px solid #dbeeff!important;border-radius:3px!important;box-shadow:inset 0 1px rgba(255,255,255,.35)!important;text-shadow:1px 1px #123a87}
    html[data-theme="xp"] .ps1-title-actions .ps1-close{background:linear-gradient(#ff936e,#d94224 62%,#b92b16)!important}
    html[data-theme="xp"] .ps1-menubar{background:#ece9d8;border-bottom:1px solid #aca899}
    html[data-theme="xp"] .ps1-menubar button:hover{background:#316ac5!important;color:#fff!important}
    html[data-theme="xp"] .ps1-toolbar{background:linear-gradient(#fff,#e8edf3);border-top:1px solid #fff;border-bottom:1px solid #9eb4ca}
    html[data-theme="xp"] .ps1-toolbar button{background:linear-gradient(#fff,#d6d3c8)!important;color:#111!important;border:1px solid #7f9db9!important;border-radius:3px!important;box-shadow:inset 1px 1px #fff!important}
    html[data-theme="xp"] .ps1-toolbar button:active{background:#d6d3c8!important;box-shadow:inset 1px 1px 2px rgba(0,0,0,.22)!important}
    html[data-theme="xp"] .ps1-toolbar button:disabled{color:#888!important;filter:grayscale(1)}
    html[data-theme="xp"] .ps1-viewport{margin:0 5px 4px;border:1px solid #7f9db9;box-shadow:inset 1px 1px 2px rgba(0,0,0,.28)}
    html[data-theme="xp"] .ps1-statusbar{margin:0 4px 4px;background:#ece9d8;border:1px solid #aca899;box-shadow:inset 1px 1px #fff}

    html[data-theme="win98"] .ps1-window{background:#c0c0c0;border:2px solid;border-color:#fff #404040 #404040 #fff;border-radius:0;box-shadow:2px 2px #000;font-family:"MS Sans Serif",Tahoma,Arial,sans-serif;color:#000}
    html[data-theme="win98"] .ps1-titlebar{height:22px;background:#000080;color:#fff;padding:2px 2px 2px 5px;border:0}
    html[data-theme="win98"] .ps1-title-actions button{width:18px;height:18px;color:#000;background:#c0c0c0!important;border:2px solid!important;border-color:#fff #404040 #404040 #fff!important;border-radius:0!important;font:700 11px/1 "MS Sans Serif",Tahoma,sans-serif}
    html[data-theme="win98"] .ps1-title-actions button:active{border-color:#404040 #fff #fff #404040!important}
    html[data-theme="win98"] .ps1-menubar{height:24px;background:#c0c0c0;border-bottom:1px solid #808080}
    html[data-theme="win98"] .ps1-menubar button{border:1px solid transparent!important}
    html[data-theme="win98"] .ps1-menubar button:focus,html[data-theme="win98"] .ps1-menubar button:hover{border:1px dotted #000!important}
    html[data-theme="win98"] .ps1-toolbar{background:#c0c0c0;border-top:1px solid #fff;border-bottom:1px solid #808080;padding:4px}
    html[data-theme="win98"] .ps1-toolbar button{background:#c0c0c0!important;color:#000!important;border:2px solid!important;border-color:#fff #404040 #404040 #fff!important;border-radius:0!important;box-shadow:none!important}
    html[data-theme="win98"] .ps1-toolbar button:active{border-color:#404040 #fff #fff #404040!important}
    html[data-theme="win98"] .ps1-toolbar button:disabled{color:#808080!important;text-shadow:1px 1px #fff}
    html[data-theme="win98"] .ps1-viewport{margin:3px;border:2px solid;border-color:#404040 #fff #fff #404040}
    html[data-theme="win98"] .ps1-statusbar{margin:0 3px 3px;border:2px solid;border-color:#808080 #fff #fff #808080;background:#c0c0c0}
    html[data-theme="win98"] #ps1Status[data-tone="warn"]{color:#806000}
    html[data-theme="win98"] #ps1Status[data-tone="bad"]{color:#800000}

    .ps1-task-button{min-width:190px;max-width:260px;align-items:center;gap:7px;padding:0 10px!important;text-align:left;overflow:hidden}
    .ps1-task-button span:last-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    html[data-theme="xp"] .ps1-task-button{height:29px;border:1px solid #7db2ff!important;border-radius:3px!important;background:linear-gradient(#3f8df4,#1d67dc)!important;color:#fff!important;box-shadow:inset 0 1px rgba(255,255,255,.18)}
    html[data-theme="xp"] .ps1-task-button.active{background:linear-gradient(#1859c6,#1b5fcf)!important;box-shadow:inset 1px 1px 3px #0b3c96!important}
    html[data-theme="win98"] .ps1-task-button{height:24px;background:#c0c0c0!important;color:#000!important;border:2px solid!important;border-color:#fff #404040 #404040 #fff!important;border-radius:0!important;box-shadow:none!important}
    html[data-theme="win98"] .ps1-task-button.active{border-color:#404040 #fff #fff #404040!important}

    @media (max-width:760px){
      .ps1-window{left:8px!important;top:8px!important;width:calc(100vw - 16px)!important;height:calc(100vh - 52px)!important;min-width:0;min-height:0;transform:none!important;resize:none}
      html[data-theme="win98"] .ps1-window{height:calc(100vh - 42px)!important}
      .ps1-toolbar{gap:3px}
      .ps1-toolbar button{padding-left:7px;padding-right:7px}
      .ps1-toolbar .ps1-disc-label,.ps1-privacy-note{display:none}
    }
  `;
  document.head.appendChild(style);
}

function ps1CreateUi() {
  const desktop = document.getElementById('windowsDesktop');
  const icons = desktop?.querySelector('.desktop-icons');
  const startMenu = document.getElementById('desktopStartMenu');
  const taskbar = desktop?.querySelector('.desktop-taskbar');
  const tray = taskbar?.querySelector('.desktop-tray');
  if (!desktop || !icons || !startMenu || !taskbar || !tray || document.getElementById('ps1Window')) return;

  const desktopIcon = document.createElement('button');
  desktopIcon.id = 'ps1DesktopIcon';
  desktopIcon.className = 'desktop-icon ps1-desktop-icon';
  desktopIcon.type = 'button';
  desktopIcon.innerHTML = '<span class="ps1-desktop-glyph" aria-hidden="true"></span><span>PlayStation Emulator</span>';
  desktopIcon.title = 'Double-click to open the PlayStation emulator';
  icons.appendChild(desktopIcon);

  const startEntry = document.createElement('button');
  startEntry.id = 'ps1StartEntry';
  startEntry.className = 'ps1-start-entry';
  startEntry.type = 'button';
  startEntry.innerHTML = '<span aria-hidden="true">💿</span><span>PlayStation Emulator</span>';
  const sep = startMenu.querySelector('.start-menu-sep');
  startMenu.insertBefore(startEntry, sep || null);

  const taskButton = document.createElement('button');
  taskButton.id = 'ps1TaskButton';
  taskButton.className = 'desktop-task-button ps1-task-button hidden';
  taskButton.type = 'button';
  taskButton.innerHTML = '<span aria-hidden="true">💿</span><span>PlayStation Emulator</span>';
  taskbar.insertBefore(taskButton, tray);

  const win = document.createElement('section');
  win.id = 'ps1Window';
  win.className = 'desktop-window ps1-window hidden';
  win.setAttribute('aria-label', 'PlayStation emulator');
  win.innerHTML = `
    <header id="ps1Titlebar" class="desktop-window-titlebar ps1-titlebar">
      <strong><span class="ps1-title-icon" aria-hidden="true">PS</span> PlayStation Emulator</strong>
      <div class="ps1-title-actions">
        <button id="ps1MinBtn" type="button" title="Minimize" aria-label="Minimize">_</button>
        <button id="ps1MaxBtn" type="button" title="Maximize" aria-label="Maximize">□</button>
        <button id="ps1CloseBtn" class="ps1-close" type="button" title="Close" aria-label="Close">×</button>
      </div>
    </header>
    <nav class="ps1-menubar" aria-label="Emulator menu">
      <button id="ps1MenuFile" type="button">File</button>
      <button id="ps1MenuEmulation" type="button">Emulation</button>
      <button id="ps1MenuOptions" type="button">Options</button>
      <button id="ps1MenuHelp" type="button">Help</button>
    </nav>
    <div class="ps1-toolbar">
      <button id="ps1OpenGameBtn" type="button">Open Game</button>
      <button id="ps1BiosBtn" type="button">BIOS</button>
      <button id="ps1StartBtn" type="button" disabled>Start</button>
      <button id="ps1FullscreenBtn" type="button">Fullscreen</button>
      <span class="ps1-spacer"></span>
      <span id="ps1DiscLabel" class="ps1-disc-label">No disc inserted</span>
      <input id="ps1GameInput" type="file" accept=".chd,.pbp,.zip,.bin,.cue,.iso,.img,application/zip,application/octet-stream">
      <input id="ps1BiosInput" type="file" accept=".bin,.rom,application/octet-stream">
    </div>
    <div id="ps1Viewport" class="ps1-viewport">
      <div id="ps1Splash" class="ps1-splash">
        <div class="ps1-splash-inner">
          <div class="ps1-disc-art" aria-hidden="true"><span>PS</span></div>
          <h3>PlayStation Emulator</h3>
          <p>Select your own PlayStation BIOS and game image. The emulator engine is downloaded only when you press Start.</p>
          <p class="ps1-privacy-note">Your BIOS and game are opened locally in this browser. SimpleShare does not upload either file.</p>
          <small>Recommended: PBP or ZIP with BIN/CUE. CHD support can vary by game/core.</small>
        </div>
      </div>
    </div>
    <footer class="ps1-statusbar">
      <span id="ps1Status">Ready</span>
      <span id="ps1BiosStatus">BIOS: not selected</span>
    </footer>
  `;
  desktop.appendChild(win);

  desktopIcon.addEventListener('dblclick', () => {
    taskButton.classList.remove('hidden');
    ps1OpenWindow();
  });
  desktopIcon.addEventListener('click', () => desktopIcon.focus());
  startEntry.addEventListener('click', () => {
    startMenu.classList.add('hidden');
    taskButton.classList.remove('hidden');
    ps1OpenWindow();
  });
  taskButton.addEventListener('click', () => {
    if (win.classList.contains('hidden')) ps1OpenWindow();
    else ps1MinimizeWindow();
  });

  document.getElementById('ps1MinBtn')?.addEventListener('click', ps1MinimizeWindow);
  document.getElementById('ps1MaxBtn')?.addEventListener('click', ps1ToggleMaximize);
  document.getElementById('ps1CloseBtn')?.addEventListener('click', () => ps1CloseWindow({ forgetGame: true }));
  document.getElementById('ps1OpenGameBtn')?.addEventListener('click', () => document.getElementById('ps1GameInput')?.click());
  document.getElementById('ps1BiosBtn')?.addEventListener('click', () => document.getElementById('ps1BiosInput')?.click());
  document.getElementById('ps1StartBtn')?.addEventListener('click', ps1StartSession);
  document.getElementById('ps1FullscreenBtn')?.addEventListener('click', ps1ToggleFullscreen);

  document.getElementById('ps1GameInput')?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    ps1ChooseGame(file);
  });
  document.getElementById('ps1BiosInput')?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    ps1ChooseBios(file);
  });

  // The menu labels behave like real shortcuts instead of decorative text.
  document.getElementById('ps1MenuFile')?.addEventListener('click', () => document.getElementById('ps1GameInput')?.click());
  document.getElementById('ps1MenuEmulation')?.addEventListener('click', ps1StartSession);
  document.getElementById('ps1MenuOptions')?.addEventListener('click', () => document.getElementById('ps1BiosInput')?.click());
  document.getElementById('ps1MenuHelp')?.addEventListener('click', () => {
    ps1SetStatus('Use your own BIOS and game files. Gamepads are handled by the emulator UI.');
  });

  // Right-click the BIOS label to forget the locally stored BIOS without adding
  // another permanently visible button to the prestige-theme toolbar.
  document.getElementById('ps1BiosStatus')?.addEventListener('contextmenu', (event) => {
    if (!ps1State.biosRecord?.blob) return;
    event.preventDefault();
    if (confirm('Forget the BIOS saved in this browser?')) ps1ForgetBios();
  });

  ps1InstallDrag();
}

function ps1InstallLifecycle() {
  // If SimpleShare is restored from the fake desktop, kill the iframe so game
  // audio and emulation cannot continue invisibly behind a call.
  const root = document.documentElement;
  const observer = new MutationObserver(() => {
    const desktopActive = root.classList.contains('windows-desktop-active');
    if (!desktopActive && (ps1State.running || !document.getElementById('ps1Window')?.classList.contains('hidden'))) {
      ps1StopSession({ keepMessage: true });
      document.getElementById('ps1Window')?.classList.add('hidden');
      document.getElementById('ps1TaskButton')?.classList.remove('active');
    }
    if (!ps1IsWindowsTheme()) {
      document.getElementById('ps1Window')?.classList.add('hidden');
      document.getElementById('ps1TaskButton')?.classList.add('hidden');
    }
  });
  observer.observe(root, { attributes: true, attributeFilter: ['class', 'data-theme'] });

  window.addEventListener('message', (event) => {
    if (event.source !== ps1State.frame?.contentWindow) return;
    const type = event.data?.type;
    if (type === 'simpleshare-ps1-ready') {
      ps1State.running = true;
      ps1SetStatus(`Running ${ps1State.gameFile?.name || 'PlayStation game'}`);
      ps1SetGameLabel();
    } else if (type === 'simpleshare-ps1-exit') {
      ps1SetStatus('Emulator stopped.');
      ps1State.running = false;
      ps1SetGameLabel();
    } else if (type === 'simpleshare-ps1-error') {
      ps1State.running = false;
      ps1SetStatus(event.data?.message || 'Emulator failed to load.', 'bad');
      ps1SetGameLabel();
    }
  });

  document.addEventListener('fullscreenchange', () => {
    const btn = document.getElementById('ps1FullscreenBtn');
    if (!btn) return;
    btn.textContent = document.fullscreenElement === document.getElementById('ps1Viewport') ? 'Exit Fullscreen' : 'Fullscreen';
  });

  window.addEventListener('beforeunload', () => ps1RevokeObjectUrls());
}

async function ps1RestoreBios() {
  try {
    const record = await ps1DbGet('bios');
    if (record?.blob instanceof Blob) ps1State.biosRecord = record;
  } catch {}
  ps1SetBiosLabel();
}

function ps1Init() {
  ps1InstallStyles();
  ps1CreateUi();
  ps1InstallLifecycle();
  ps1RestoreBios();
}

ps1Init();
