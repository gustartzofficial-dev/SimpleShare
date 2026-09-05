/*
 * SimpleShare browser/capture compatibility + UI polish layer.
 *
 * Keeps media transport/signaling in app.js untouched. This file only adapts
 * browser capture APIs and augments the UI around the existing room lifecycle.
 */

const compatMediaDevices = navigator.mediaDevices;
const compatIsGecko = /(?:Firefox|Fennec)\//i.test(navigator.userAgent) ||
  (/Gecko\//i.test(navigator.userAgent) && !/like Gecko/i.test(navigator.userAgent));

const COMPAT_AVATAR_KEY = 'simpleshare-avatar-v1';
const COMPAT_AVATAR_MAX = 55000;
const compatAvatarByParticipant = new Map();
const compatNameByParticipant = new Map();
let compatRoomSocket = null;
let compatNextCaptureMode = 'screen';
let compatCameraDispatch = false;
let compatLocalAvatar = '';
let compatDecorateQueued = false;

try { compatLocalAvatar = localStorage.getItem(COMPAT_AVATAR_KEY) || ''; } catch {}

function compatIdealNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (value && typeof value === 'object') {
    const candidate = value.ideal ?? value.max;
    if (typeof candidate === 'number' && Number.isFinite(candidate)) return candidate;
  }
  return undefined;
}

function compatInstallCaptureAdapter() {
  if (!compatMediaDevices || typeof compatMediaDevices.getDisplayMedia !== 'function') return;

  const nativeDisplayMedia = compatMediaDevices.getDisplayMedia.bind(compatMediaDevices);
  const nativeUserMedia = typeof compatMediaDevices.getUserMedia === 'function'
    ? compatMediaDevices.getUserMedia.bind(compatMediaDevices)
    : null;

  const getDisplayMediaCompat = async (options = {}) => {
    const captureMode = compatNextCaptureMode;
    compatNextCaptureMode = 'screen';

    if (captureMode === 'camera') {
      if (!nativeUserMedia) {
        throw new DOMException('Camera capture is not supported by this browser.', 'NotSupportedError');
      }

      const requested = options && typeof options.video === 'object' ? options.video : {};
      const width = compatIdealNumber(requested.width);
      const height = compatIdealNumber(requested.height);
      const frameRate = compatIdealNumber(requested.frameRate);
      const video = { facingMode: { ideal: 'user' } };
      if (width) video.width = { ideal: width };
      if (height) video.height = { ideal: height };
      if (frameRate) video.frameRate = { ideal: frameRate };

      // Camera stays video-only by design. Screen/window audio remains a separate
      // feature and microphone permission is never requested implicitly.
      return nativeUserMedia({ video, audio: false });
    }

    if (!compatIsGecko) return nativeDisplayMedia(options);

    // Gecko is happiest when the browser owns the picker and we apply quality
    // preferences after capture. Chromium-only top-level hints are intentionally
    // omitted here so Firefox never rejects an otherwise valid capture request.
    const requested = options && typeof options.video === 'object' ? options.video : {};
    const preferred = {};
    const width = compatIdealNumber(requested.width);
    const height = compatIdealNumber(requested.height);
    const frameRate = compatIdealNumber(requested.frameRate);
    if (width) preferred.width = { ideal: width };
    if (height) preferred.height = { ideal: height };
    if (frameRate) preferred.frameRate = { ideal: frameRate };

    const stream = await nativeDisplayMedia({ video: true, audio: false });
    const videoTrack = stream.getVideoTracks()[0];
    if (videoTrack && Object.keys(preferred).length) {
      try { await videoTrack.applyConstraints(preferred); }
      catch (error) {
        console.warn('[SimpleShare] Firefox capture quality preference was not applied:', error);
      }
    }
    return stream;
  };

  try {
    Object.defineProperty(compatMediaDevices, 'getDisplayMedia', {
      configurable: true,
      writable: true,
      value: getDisplayMediaCompat,
    });
  } catch {
    try { compatMediaDevices.getDisplayMedia = getDisplayMediaCompat; } catch {}
  }
}

function compatCameraIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 6.75h9.25A2.25 2.25 0 0 1 16 9v6a2.25 2.25 0 0 1-2.25 2.25H4.5A2.25 2.25 0 0 1 2.25 15V9A2.25 2.25 0 0 1 4.5 6.75Zm11.5 3.1 4.08-2.36a1 1 0 0 1 1.5.86v7.3a1 1 0 0 1-1.5.86L16 14.15v-4.3Z" fill="currentColor"/></svg>';
}

function compatFullscreenIcon() {
  return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function compatInjectStyles() {
  const style = document.createElement('style');
  style.id = 'simpleshare-compat-styles';
  style.textContent = `
    html {
      --compat-accent: var(--blurple, #5865f2);
      --compat-accent-text: #fff;
      --compat-bubble-bg: rgba(20,21,24,.76);
      --compat-chip-bg: var(--bg-3, #2b2d31);
      --compat-chip-text: var(--text, #f2f3f5);
      --compat-border: rgba(255,255,255,.09);
      --compat-shadow: 0 9px 28px rgba(0,0,0,.28);
      --compat-radius: 999px;
      --compat-control-radius: 10px;
      --compat-avatar-bg: var(--bg-5, #383a40);
      --compat-live: var(--red, #da373c);
      --compat-profile-surface: rgba(0,0,0,.12);
    }

    /* Collapsing members must reclaim the column in every layout. */
    #room.room.no-members {
      grid-template-columns: minmax(0,1fr) !important;
      grid-template-areas: "top" "stage" !important;
      width: 100% !important;
      max-width: none !important;
    }
    #room.room.no-members .people-panel { display: none !important; }
    #room.room.no-members > .topbar,
    #room.room.no-members > .stage,
    #room.room.no-members > .premium-shell {
      grid-column: 1 / -1 !important;
      width: 100% !important;
      max-width: none !important;
    }
    #room.room.no-members .call-dock,
    #room.room.no-members .settings-panel { left: 50% !important; }
    #room.room.no-members .steam-premium-sidebar { display: none !important; }
    #room.room.no-members .steam-premium-workspace {
      grid-template-columns: minmax(0,1fr) !important;
    }
    #room.room.no-members .premium-slot-stage,
    #room.room.no-members .steam-premium-main { min-width: 0 !important; width: 100% !important; }

    .compat-camera-dock {
      background: var(--compat-accent) !important;
      color: var(--compat-accent-text) !important;
    }
    .compat-camera-dock:hover:not(:disabled) { filter: brightness(1.08); }
    .compat-camera-dock svg { width: 20px; height: 20px; display: block; }

    .compat-people-bubbles {
      position: absolute;
      top: 14px;
      left: 50%;
      transform: translateX(-50%);
      z-index: 13;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 7px;
      max-width: min(820px, calc(100% - 28px));
      padding: 7px 9px;
      overflow-x: auto;
      scrollbar-width: none;
      border: 1px solid var(--compat-border);
      border-radius: var(--compat-radius);
      background: var(--compat-bubble-bg);
      box-shadow: var(--compat-shadow);
      backdrop-filter: blur(14px) saturate(1.08);
      -webkit-backdrop-filter: blur(14px) saturate(1.08);
    }
    .compat-people-bubbles::-webkit-scrollbar { display: none; }
    .compat-person-bubble {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-width: 0;
      max-width: 180px;
      padding: 4px 9px 4px 4px;
      border: 1px solid var(--compat-border);
      border-radius: var(--compat-radius);
      background: var(--compat-chip-bg);
      color: var(--compat-chip-text);
      box-shadow: inset 0 1px 0 rgba(255,255,255,.025);
      white-space: nowrap;
    }
    .compat-person-avatar,
    .compat-pfp-preview {
      position: relative;
      flex: 0 0 auto;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: var(--compat-avatar-bg);
      color: var(--compat-chip-text);
      background-position: center;
      background-size: cover;
      background-repeat: no-repeat;
      font-weight: 800;
    }
    .compat-person-avatar { width: 28px; height: 28px; font-size: 12px; }
    .compat-person-avatar.live::after {
      content: '';
      position: absolute;
      right: -1px;
      bottom: -1px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--compat-live);
      border: 2px solid var(--compat-chip-bg);
      z-index: 2;
    }
    .compat-person-name {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      font-size: 12px;
      font-weight: 650;
    }
    .compat-firefox-note {
      color: var(--yellow, #f0b232) !important;
      margin-top: 5px !important;
    }

    /* Fullscreen is deliberately independent of the auto-hiding tile bar. */
    .tile > .compat-fullscreen {
      position: absolute !important;
      top: 10px !important;
      right: 10px !important;
      z-index: 9 !important;
      width: 36px !important;
      height: 36px !important;
      min-width: 36px !important;
      padding: 0 !important;
      display: grid !important;
      place-items: center !important;
      border: 1px solid rgba(255,255,255,.13) !important;
      border-radius: var(--compat-control-radius) !important;
      background: rgba(18,19,22,.78) !important;
      color: #fff !important;
      box-shadow: 0 5px 16px rgba(0,0,0,.28) !important;
      opacity: .9 !important;
      pointer-events: auto !important;
      backdrop-filter: blur(8px);
      -webkit-backdrop-filter: blur(8px);
      transition: opacity .15s ease, transform .15s ease, background .15s ease !important;
    }
    .tile > .compat-fullscreen:hover {
      opacity: 1 !important;
      transform: translateY(-1px) !important;
      background: rgba(35,36,40,.96) !important;
    }
    .tile > .compat-fullscreen svg { width: 18px; height: 18px; display: block; }

    .tile:fullscreen,
    .tile:-webkit-full-screen {
      width: 100vw !important;
      height: 100vh !important;
      max-width: none !important;
      max-height: none !important;
      aspect-ratio: auto !important;
      border: 0 !important;
      border-radius: 0 !important;
      background: #000 !important;
    }
    .tile:fullscreen video,
    .tile:-webkit-full-screen video {
      width: 100% !important;
      height: 100% !important;
      object-fit: contain !important;
      background: #000 !important;
    }
    .tile:fullscreen .tile-bar,
    .tile:-webkit-full-screen .tile-bar {
      opacity: 1 !important;
      transform: none !important;
    }

    .compat-pfp-row { align-items: center !important; }
    .compat-pfp-control {
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 8px;
      min-width: 190px;
      padding: 7px;
      border: 1px solid var(--compat-border);
      border-radius: 9px;
      background: var(--compat-profile-surface);
    }
    .compat-pfp-preview {
      width: 38px;
      height: 38px;
      border: 1px solid var(--compat-border);
      font-size: 13px;
      cursor: pointer;
    }
    .compat-pfp-actions { display: flex; gap: 6px; }
    .compat-pfp-button {
      min-height: 31px;
      padding: 5px 9px;
      border: 1px solid var(--compat-border);
      border-radius: 6px;
      background: var(--bg-2, #232428);
      color: var(--text, #f2f3f5);
      font-size: 11px;
      font-weight: 650;
    }
    .compat-pfp-button:hover { background: var(--hover, #3f4147); }
    .compat-pfp-remove { color: #ff9b9f; }
    .compat-pfp-help {
      display: block;
      margin-top: 4px;
      color: var(--dim, #949ba4);
      font-size: 10px;
      line-height: 1.3;
    }

    .person-avatar[data-compat-avatar="1"],
    .me-avatar[data-compat-avatar="1"],
    .idle-avatar[data-compat-avatar="1"],
    .compat-person-avatar[data-compat-avatar="1"],
    .compat-pfp-preview[data-compat-avatar="1"] {
      background-position: center !important;
      background-size: cover !important;
      background-repeat: no-repeat !important;
      color: transparent !important;
      text-shadow: none !important;
    }

    /* TeamSpeak 3 */
    html[data-theme="teamspeak"] {
      --compat-accent: #3f74a8;
      --compat-bubble-bg: rgba(31,37,43,.94);
      --compat-chip-bg: #313940;
      --compat-chip-text: #e8edf2;
      --compat-border: rgba(148,174,196,.22);
      --compat-radius: 5px;
      --compat-control-radius: 5px;
      --compat-avatar-bg: #46515b;
      --compat-profile-surface: rgba(255,255,255,.025);
    }
    html[data-theme="teamspeak"] .compat-people-bubbles { box-shadow: 0 5px 18px rgba(0,0,0,.35); }

    /* iOS glass */
    html[data-theme="ios"] {
      --compat-accent: rgba(85,135,255,.92);
      --compat-bubble-bg: rgba(20,31,45,.54);
      --compat-chip-bg: rgba(255,255,255,.105);
      --compat-chip-text: #f7fbff;
      --compat-border: rgba(255,255,255,.18);
      --compat-shadow: 0 14px 38px rgba(0,0,0,.28);
      --compat-profile-surface: rgba(255,255,255,.07);
    }
    html[data-theme="ios"] .compat-people-bubbles,
    html[data-theme="ios"] .compat-pfp-control { backdrop-filter: blur(24px) saturate(1.35); -webkit-backdrop-filter: blur(24px) saturate(1.35); }

    /* Windows XP */
    html[data-theme="xp"] {
      --compat-accent: #2f73df;
      --compat-bubble-bg: linear-gradient(#f4f7ff,#dce7fb);
      --compat-chip-bg: linear-gradient(#fff,#e7effb);
      --compat-chip-text: #13335f;
      --compat-border: #7c9dcc;
      --compat-radius: 7px;
      --compat-control-radius: 5px;
      --compat-avatar-bg: #5a8edc;
      --compat-profile-surface: #e7effb;
    }
    html[data-theme="xp"] .compat-people-bubbles,
    html[data-theme="xp"] .compat-person-bubble { font-family: Tahoma,"Segoe UI",sans-serif; }
    html[data-theme="xp"] .compat-people-bubbles { background: linear-gradient(#f4f7ff,#dce7fb); }
    html[data-theme="xp"] .compat-person-bubble { background: linear-gradient(#fff,#e7effb); }

    /* Windows 98 */
    html[data-theme="win98"] {
      --compat-accent: #000080;
      --compat-bubble-bg: #c0c0c0;
      --compat-chip-bg: #d4d0c8;
      --compat-chip-text: #000;
      --compat-border: #808080;
      --compat-radius: 0px;
      --compat-control-radius: 0px;
      --compat-avatar-bg: #000080;
      --compat-profile-surface: #d4d0c8;
      --compat-shadow: 2px 2px 0 #000;
    }
    html[data-theme="win98"] .compat-people-bubbles,
    html[data-theme="win98"] .compat-person-bubble,
    html[data-theme="win98"] .compat-pfp-control,
    html[data-theme="win98"] .compat-pfp-button {
      box-shadow: inset 1px 1px #fff, inset -1px -1px #404040 !important;
      font-family: "MS Sans Serif",Tahoma,sans-serif;
    }

    /* Old Skype */
    html[data-theme="skype"] {
      --compat-accent: #00aff0;
      --compat-bubble-bg: rgba(0,83,122,.88);
      --compat-chip-bg: #fff;
      --compat-chip-text: #17465e;
      --compat-border: rgba(255,255,255,.25);
      --compat-avatar-bg: #00aff0;
      --compat-profile-surface: rgba(255,255,255,.08);
    }

    /* CRT terminal */
    html[data-theme="terminal"] {
      --compat-accent: #53ff7b;
      --compat-accent-text: #051407;
      --compat-bubble-bg: rgba(0,14,4,.92);
      --compat-chip-bg: rgba(0,28,8,.94);
      --compat-chip-text: #72ff92;
      --compat-border: rgba(91,255,126,.38);
      --compat-radius: 2px;
      --compat-control-radius: 2px;
      --compat-avatar-bg: #103d1c;
      --compat-live: #72ff92;
      --compat-profile-surface: rgba(0,30,9,.7);
    }
    html[data-theme="terminal"] .compat-people-bubbles,
    html[data-theme="terminal"] .compat-person-bubble,
    html[data-theme="terminal"] .compat-pfp-control { font-family: ui-monospace,SFMono-Regular,Consolas,monospace; text-shadow: 0 0 8px rgba(83,255,123,.25); }

    /* Mac OS X Aqua */
    html[data-theme="aqua"] {
      --compat-accent: #2788e9;
      --compat-bubble-bg: rgba(230,240,249,.86);
      --compat-chip-bg: rgba(255,255,255,.9);
      --compat-chip-text: #20374b;
      --compat-border: rgba(71,112,148,.32);
      --compat-shadow: 0 10px 30px rgba(19,46,70,.26);
      --compat-avatar-bg: #4b9ce8;
      --compat-profile-surface: rgba(255,255,255,.34);
    }
    html[data-theme="aqua"] .compat-people-bubbles { background: linear-gradient(rgba(255,255,255,.93),rgba(210,226,241,.88)); }

    /* Steam classic */
    html[data-theme="steam"] {
      --compat-accent: #6b8e23;
      --compat-bubble-bg: rgba(24,31,37,.96);
      --compat-chip-bg: #26343e;
      --compat-chip-text: #d7e2e8;
      --compat-border: rgba(122,153,171,.22);
      --compat-radius: 3px;
      --compat-control-radius: 3px;
      --compat-avatar-bg: #49606e;
      --compat-profile-surface: #1f2a32;
    }

    /* YouTube 2012 */
    html[data-theme="youtube"] {
      --compat-accent: #cc181e;
      --compat-bubble-bg: rgba(250,250,250,.96);
      --compat-chip-bg: #fff;
      --compat-chip-text: #222;
      --compat-border: rgba(0,0,0,.16);
      --compat-shadow: 0 3px 10px rgba(0,0,0,.2);
      --compat-radius: 4px;
      --compat-control-radius: 3px;
      --compat-avatar-bg: #666;
      --compat-profile-surface: #f4f4f4;
    }

    /* Android Holo */
    html[data-theme="holo"] {
      --compat-accent: #33b5e5;
      --compat-accent-text: #071013;
      --compat-bubble-bg: rgba(8,8,8,.94);
      --compat-chip-bg: #161616;
      --compat-chip-text: #f1f1f1;
      --compat-border: rgba(51,181,229,.34);
      --compat-radius: 2px;
      --compat-control-radius: 2px;
      --compat-avatar-bg: #17485a;
      --compat-profile-surface: #111;
    }

    @media (max-width: 640px) {
      .compat-people-bubbles { top: 10px; max-width: calc(100% - 20px); }
      .compat-person-bubble { padding-right: 5px; }
      .compat-person-name { display: none; }
      .compat-pfp-row { align-items: flex-start !important; }
      .compat-pfp-control { min-width: 0; width: 100%; justify-content: flex-start; }
    }
  `;
  document.head.appendChild(style);
}

function compatSetAudioTemporarilyOff() {
  const checkbox = document.getElementById('withAudio');
  if (!checkbox) return () => {};
  const wasChecked = checkbox.checked;
  checkbox.checked = false;
  return () => { checkbox.checked = wasChecked; };
}

function compatInstallCaptureControls() {
  const shareButton = document.getElementById('shareBtn');
  const stopButton = document.getElementById('stopBtn');
  const dock = document.querySelector('.call-dock');
  if (!shareButton || !stopButton || !dock) return;

  const existing = document.getElementById('cameraBtn');
  if (existing) existing.remove();

  const cameraButton = document.createElement('button');
  cameraButton.id = 'cameraBtn';
  cameraButton.type = 'button';
  cameraButton.className = 'dock-btn compat-camera-dock';
  cameraButton.title = 'Share camera';
  cameraButton.setAttribute('aria-label', 'Share camera');
  cameraButton.innerHTML = compatCameraIcon();
  dock.insertBefore(cameraButton, shareButton);

  const updateCameraButton = () => {
    const sharing = shareButton.classList.contains('hidden') || !stopButton.classList.contains('hidden');
    cameraButton.classList.toggle('hidden', sharing);
    cameraButton.disabled = shareButton.disabled || !compatMediaDevices || typeof compatMediaDevices.getUserMedia !== 'function';
  };

  shareButton.addEventListener('click', () => {
    if (!compatCameraDispatch) compatNextCaptureMode = 'screen';
    if (!compatIsGecko && !compatCameraDispatch) return;
    const restoreAudio = compatSetAudioTemporarilyOff();
    queueMicrotask(restoreAudio);
  }, { capture: true });

  cameraButton.addEventListener('click', () => {
    if (cameraButton.disabled || shareButton.classList.contains('hidden')) return;
    compatNextCaptureMode = 'camera';
    compatCameraDispatch = true;
    const restoreAudio = compatSetAudioTemporarilyOff();
    try { shareButton.click(); }
    finally {
      compatCameraDispatch = false;
      queueMicrotask(restoreAudio);
    }
  });

  const buttonObserver = new MutationObserver(updateCameraButton);
  buttonObserver.observe(shareButton, { attributes: true, attributeFilter: ['class', 'disabled'] });
  buttonObserver.observe(stopButton, { attributes: true, attributeFilter: ['class'] });
  updateCameraButton();

  if (compatIsGecko) {
    const audioToggle = document.getElementById('withAudio');
    const copy = audioToggle?.closest('.switch-row')?.querySelector('span');
    if (copy && !copy.querySelector('.compat-firefox-note')) {
      const note = document.createElement('small');
      note.className = 'compat-firefox-note';
      note.textContent = 'Firefox/Gecko display sharing is video-only in the browser today; screen video remains supported.';
      copy.appendChild(note);
    }
    shareButton.title = 'Share screen (Firefox optimized)';
    shareButton.setAttribute('aria-label', 'Share screen');
  }
}

function compatNormalizeName(value) {
  return String(value || '').replace(/\s*\(you\)\s*$/i, '').trim();
}

function compatOwnName() {
  const value = document.getElementById('displayName')?.value || document.getElementById('myName')?.value || '';
  return compatNormalizeName(value);
}

function compatAvatarForName(name) {
  const clean = compatNormalizeName(name);
  if (!clean) return '';
  if (clean === compatOwnName() && compatLocalAvatar) return compatLocalAvatar;
  for (const [id, participantName] of compatNameByParticipant) {
    if (compatNormalizeName(participantName) !== clean) continue;
    const avatar = compatAvatarByParticipant.get(id);
    if (avatar) return avatar;
  }
  return '';
}

function compatApplyAvatar(node, avatar) {
  if (!node) return;
  if (avatar) {
    node.style.backgroundImage = `url(${JSON.stringify(avatar).slice(1,-1)})`;
    node.dataset.compatAvatar = '1';
  } else {
    node.style.removeProperty('background-image');
    delete node.dataset.compatAvatar;
  }
}

function compatScheduleDecorate() {
  if (compatDecorateQueued) return;
  compatDecorateQueued = true;
  queueMicrotask(() => {
    compatDecorateQueued = false;
    compatDecorateAvatars();
    compatSyncPeopleBubbles();
    compatRefreshPfpPreview();
  });
}

function compatDecorateAvatars() {
  for (const row of document.querySelectorAll('#people .person')) {
    const name = row.querySelector('.person-name')?.textContent || '';
    compatApplyAvatar(row.querySelector('.person-avatar'), compatAvatarForName(name));
  }

  const me = document.querySelector('.member-footer .me-avatar');
  compatApplyAvatar(me, compatLocalAvatar);

  for (const tile of document.querySelectorAll('.tile')) {
    const name = tile.querySelector('.idle-name')?.textContent || tile.querySelector('.tile-name')?.textContent || '';
    compatApplyAvatar(tile.querySelector('.idle-avatar'), compatAvatarForName(name));
  }
}

let compatBubbleHost = null;
function compatSyncPeopleBubbles() {
  const people = document.getElementById('people');
  const host = compatBubbleHost || document.getElementById('peopleBubbles');
  if (!people || !host) return;

  const rows = [...people.querySelectorAll('.person')];
  host.replaceChildren();
  for (const row of rows) {
    const sourceAvatar = row.querySelector('.person-avatar');
    const sourceName = row.querySelector('.person-name');
    if (!sourceAvatar || !sourceName) continue;

    const fullName = sourceName.textContent || 'Participant';
    const bubble = document.createElement('div');
    bubble.className = 'compat-person-bubble';
    bubble.title = fullName;

    const avatar = document.createElement('span');
    avatar.className = `compat-person-avatar${sourceAvatar.classList.contains('live') ? ' live' : ''}`;
    avatar.textContent = sourceAvatar.textContent || '?';
    compatApplyAvatar(avatar, compatAvatarForName(fullName));

    const name = document.createElement('span');
    name.className = 'compat-person-name';
    name.textContent = fullName;

    bubble.append(avatar, name);
    host.appendChild(bubble);
  }
  host.classList.toggle('hidden', host.childElementCount === 0);
}

function compatInstallPeopleBubbles() {
  const stage = document.querySelector('.stage');
  const people = document.getElementById('people');
  const room = document.getElementById('room');
  if (!stage || !people || !room) return;

  try { localStorage.setItem('simpleshare-hide-members', '1'); } catch {}
  room.classList.add('no-members');

  document.getElementById('peopleBubbles')?.remove();
  const host = document.createElement('div');
  host.className = 'compat-people-bubbles hidden';
  host.id = 'peopleBubbles';
  host.setAttribute('aria-label', 'People in this call');
  stage.appendChild(host);
  compatBubbleHost = host;

  const peopleObserver = new MutationObserver(compatScheduleDecorate);
  peopleObserver.observe(people, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ['class'],
  });

  const grid = document.getElementById('grid');
  if (grid) {
    const gridObserver = new MutationObserver(compatScheduleDecorate);
    gridObserver.observe(grid, { childList: true, subtree: true, characterData: true });
  }

  compatScheduleDecorate();
}

function compatRequestTileFullscreen(tile) {
  if (document.fullscreenElement === tile || document.webkitFullscreenElement === tile) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (!exit) return Promise.resolve();
    try { return Promise.resolve(exit.call(document)); } catch (error) { return Promise.reject(error); }
  }
  const request = tile.requestFullscreen || tile.webkitRequestFullscreen;
  if (!request) return Promise.reject(new Error('Fullscreen is not supported by this browser.'));
  try { return Promise.resolve(request.call(tile)); } catch (error) { return Promise.reject(error); }
}

function compatInstallFullscreenButtons() {
  const grid = document.getElementById('grid');
  if (!grid) return;

  const enhance = () => {
    for (const tile of grid.querySelectorAll('.tile')) {
      // Remove the v1 button if a live update happened without a full reload.
      for (const old of tile.querySelectorAll('.tile-actions .compat-fullscreen')) old.remove();
      if ([...tile.children].some(child => child.classList?.contains('compat-fullscreen'))) continue;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tile-action-btn compat-fullscreen';
      button.innerHTML = compatFullscreenIcon();
      button.title = 'Enter fullscreen';
      button.setAttribute('aria-label', 'Enter fullscreen');
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        compatRequestTileFullscreen(tile).catch((error) => {
          console.warn('[SimpleShare] fullscreen request failed:', error);
        });
      });
      tile.appendChild(button);
    }
  };

  const updateLabels = () => {
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    for (const button of grid.querySelectorAll('.compat-fullscreen')) {
      const tile = button.closest('.tile');
      const isActive = Boolean(active && tile === active);
      button.title = isActive ? 'Exit fullscreen' : 'Enter fullscreen';
      button.setAttribute('aria-label', isActive ? 'Exit fullscreen' : 'Enter fullscreen');
    }
  };

  const gridObserver = new MutationObserver(enhance);
  gridObserver.observe(grid, { childList: true, subtree: true });
  document.addEventListener('fullscreenchange', updateLabels);
  document.addEventListener('webkitfullscreenchange', updateLabels);
  enhance();
}

function compatKeepSidebarCollapsedOnEntry() {
  const room = document.getElementById('room');
  if (!room) return;
  const forceInitialCollapse = () => {
    if (room.classList.contains('hidden') || room.dataset.compatInitialCollapseDone) return;
    room.dataset.compatInitialCollapseDone = '1';
    room.classList.add('no-members');
    try { localStorage.setItem('simpleshare-hide-members', '1'); } catch {}
  };
  const observer = new MutationObserver(forceInitialCollapse);
  observer.observe(room, { attributes: true, attributeFilter: ['class'] });
  forceInitialCollapse();
}

function compatValidAvatar(value) {
  return typeof value === 'string' && value.length <= COMPAT_AVATAR_MAX && /^data:image\/(?:webp|png|jpeg);base64,/i.test(value);
}

function compatIngestParticipant(participant) {
  if (!participant || typeof participant !== 'object') return;
  const id = String(participant.id || '');
  const name = String(participant.name || '');
  if (!id) return;
  if (name) compatNameByParticipant.set(id, name);
  if (Object.prototype.hasOwnProperty.call(participant, 'avatar')) {
    if (compatValidAvatar(participant.avatar)) compatAvatarByParticipant.set(id, participant.avatar);
    else compatAvatarByParticipant.delete(id);
  }
}

function compatIngestPayload(payload) {
  if (!payload || typeof payload !== 'object') return;
  if (Array.isArray(payload.participants)) payload.participants.forEach(compatIngestParticipant);
  if (Array.isArray(payload.snapshot?.participants)) payload.snapshot.participants.forEach(compatIngestParticipant);
  if (payload.participant) compatIngestParticipant(payload.participant);
  if (payload.type === 'participant-left' && payload.participantId) {
    compatAvatarByParticipant.delete(String(payload.participantId));
    compatNameByParticipant.delete(String(payload.participantId));
  }
  compatScheduleDecorate();
}

function compatInstallProfileTransport() {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async function compatFetch(input, init) {
    let nextInput = input;
    let nextInit = init;
    let href = '';
    try { href = typeof input === 'string' || input instanceof URL ? new URL(input, location.href).href : input?.url || ''; } catch {}
    let pathname = '';
    try { pathname = new URL(href, location.href).pathname; } catch {}
    const isJoin = /\/api\/rooms\/[^/]+\/join\/?$/.test(pathname);
    const isSnapshot = /\/api\/rooms\/[^/]+\/snapshot\/?$/.test(pathname);

    if (isJoin) {
      try {
        if (nextInit && typeof nextInit.body === 'string') {
          const body = JSON.parse(nextInit.body);
          nextInit = { ...nextInit, body: JSON.stringify({ ...body, avatar: compatLocalAvatar || '' }) };
        } else if (input instanceof Request) {
          const clone = input.clone();
          const body = await clone.json();
          nextInput = new Request(input, { body: JSON.stringify({ ...body, avatar: compatLocalAvatar || '' }) });
        }
      } catch {}
    }

    const response = await nativeFetch(nextInput, nextInit);
    if (isJoin || isSnapshot) {
      response.clone().json().then(compatIngestPayload).catch(() => {});
    }
    return response;
  };

  const NativeWebSocket = window.WebSocket;
  if (typeof NativeWebSocket !== 'function') return;

  function CompatWebSocket(...args) {
    const socket = new NativeWebSocket(...args);
    let pathname = '';
    try { pathname = new URL(String(args[0]), location.href).pathname; } catch {}
    if (/\/api\/rooms\/[^/]+\/socket\/?$/.test(pathname)) {
      compatRoomSocket = socket;
      socket.addEventListener('message', (event) => {
        try { compatIngestPayload(JSON.parse(typeof event.data === 'string' ? event.data : '')); } catch {}
      });
      socket.addEventListener('open', () => {
        compatRoomSocket = socket;
        queueMicrotask(compatPublishAvatar);
      });
      socket.addEventListener('close', () => {
        if (compatRoomSocket === socket) compatRoomSocket = null;
      });
    }
    return socket;
  }

  CompatWebSocket.prototype = NativeWebSocket.prototype;
  Object.setPrototypeOf(CompatWebSocket, NativeWebSocket);
  window.WebSocket = CompatWebSocket;
}

function compatPublishAvatar() {
  const socket = compatRoomSocket;
  if (!socket || socket.readyState !== 1) return;
  try { socket.send(JSON.stringify({ type: 'profile-update', avatar: compatLocalAvatar || '' })); } catch {}
}

function compatRefreshPfpPreview() {
  const preview = document.getElementById('compatPfpPreview');
  if (!preview) return;
  preview.textContent = (compatOwnName() || '?').slice(0,1).toUpperCase();
  compatApplyAvatar(preview, compatLocalAvatar);
  const remove = document.getElementById('compatPfpRemove');
  if (remove) remove.disabled = !compatLocalAvatar;
}

async function compatLoadImage(file) {
  if ('createImageBitmap' in window) return createImageBitmap(file);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    image.src = url;
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('Could not read that image.'));
    });
    return image;
  } finally { URL.revokeObjectURL(url); }
}

async function compatMakeAvatar(file) {
  if (!file || !String(file.type || '').startsWith('image/')) throw new Error('Choose an image file.');
  if (file.size > 12 * 1024 * 1024) throw new Error('That image is too large. Choose one under 12 MB.');

  const image = await compatLoadImage(file);
  const sourceWidth = image.width || image.naturalWidth;
  const sourceHeight = image.height || image.naturalHeight;
  if (!sourceWidth || !sourceHeight) throw new Error('Could not read that image.');

  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 96;
  const ctx = canvas.getContext('2d', { alpha: false });
  const crop = Math.min(sourceWidth, sourceHeight);
  const sx = Math.max(0, (sourceWidth - crop) / 2);
  const sy = Math.max(0, (sourceHeight - crop) / 2);
  ctx.drawImage(image, sx, sy, crop, crop, 0, 0, 96, 96);
  try { image.close?.(); } catch {}

  let avatar = canvas.toDataURL('image/webp', .8);
  if (!compatValidAvatar(avatar)) {
    avatar = canvas.toDataURL('image/jpeg', .72);
  }
  if (!compatValidAvatar(avatar)) throw new Error('Could not compress that profile picture.');
  return avatar;
}

function compatSetLocalAvatar(avatar) {
  compatLocalAvatar = compatValidAvatar(avatar) ? avatar : '';
  try {
    if (compatLocalAvatar) localStorage.setItem(COMPAT_AVATAR_KEY, compatLocalAvatar);
    else localStorage.removeItem(COMPAT_AVATAR_KEY);
  } catch {}
  compatScheduleDecorate();
  compatPublishAvatar();
}

function compatInstallProfilePictureSetting() {
  const displayName = document.getElementById('displayName');
  const settings = document.getElementById('settingsPanel');
  if (!displayName || !settings || document.getElementById('compatPfpInput')) return;

  const displayRow = displayName.closest('.settings-row');
  if (!displayRow) return;

  const row = document.createElement('div');
  row.className = 'settings-row compat-pfp-row';
  row.innerHTML = `
    <label>Profile picture</label>
    <div>
      <div class="compat-pfp-control">
        <button id="compatPfpPreview" class="compat-pfp-preview" type="button" title="Choose profile picture" aria-label="Choose profile picture">?</button>
        <div class="compat-pfp-actions">
          <button id="compatPfpChoose" class="compat-pfp-button" type="button">Choose image</button>
          <button id="compatPfpRemove" class="compat-pfp-button compat-pfp-remove" type="button">Remove</button>
        </div>
        <input id="compatPfpInput" type="file" accept="image/*" hidden />
      </div>
      <small class="compat-pfp-help">Cropped to a small square avatar. Your picture is remembered on this browser and shared with people in the room.</small>
    </div>`;
  displayRow.insertAdjacentElement('afterend', row);

  const input = row.querySelector('#compatPfpInput');
  const choose = row.querySelector('#compatPfpChoose');
  const preview = row.querySelector('#compatPfpPreview');
  const remove = row.querySelector('#compatPfpRemove');
  const openPicker = () => input.click();
  choose.addEventListener('click', openPicker);
  preview.addEventListener('click', openPicker);
  remove.addEventListener('click', () => compatSetLocalAvatar(''));
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    if (!file) return;
    choose.disabled = true;
    choose.textContent = 'Processing…';
    try { compatSetLocalAvatar(await compatMakeAvatar(file)); }
    catch (error) {
      console.warn('[SimpleShare] profile picture:', error);
      const toast = document.getElementById('toast');
      if (toast) {
        toast.textContent = error.message || 'Could not use that profile picture.';
        toast.classList.add('show');
        setTimeout(() => toast.classList.remove('show'), 2600);
      }
    } finally {
      input.value = '';
      choose.disabled = false;
      choose.textContent = 'Choose image';
    }
  });

  const renameAfter = () => queueMicrotask(() => {
    compatScheduleDecorate();
    compatPublishAvatar();
  });
  displayName.addEventListener('change', renameAfter);
  document.getElementById('myName')?.addEventListener('change', renameAfter);
  compatRefreshPfpPreview();
}

compatInstallCaptureAdapter();
compatInstallProfileTransport();
compatInjectStyles();
compatKeepSidebarCollapsedOnEntry();
compatInstallCaptureControls();
compatInstallPeopleBubbles();
compatInstallFullscreenButtons();
compatInstallProfilePictureSetting();
compatScheduleDecorate();
