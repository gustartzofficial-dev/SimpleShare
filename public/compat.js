/*
 * SimpleShare browser/capture compatibility layer.
 *
 * Deliberately kept outside the signaling/PartyTracks code. It adapts browser
 * capture behavior and augments the UI while the existing app.js continues to
 * own publishing, subscriptions, reconnection and room state.
 */

const compatMediaDevices = navigator.mediaDevices;
const compatIsGecko = /(?:Firefox|Fennec)\//i.test(navigator.userAgent) ||
  (/Gecko\//i.test(navigator.userAgent) && !/like Gecko/i.test(navigator.userAgent));

let compatNextCaptureMode = 'screen';
let compatCameraDispatch = false;

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

      // Camera is intentionally video-only. SimpleShare's shared-audio control
      // remains scoped to screen/window capture and microphone permission is not
      // requested implicitly.
      return nativeUserMedia({ video, audio: false });
    }

    if (!compatIsGecko) return nativeDisplayMedia(options);

    // Firefox/Gecko supports display capture well, but several top-level hints
    // used by Chromium (windowAudio, surfaceSwitching, selfBrowserSurface, etc.)
    // are not consistently implemented there. Ask Firefox for the display using
    // its native picker, then apply quality preferences to the returned track.
    // This keeps the picker maximally compatible without changing WebRTC.
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
      try {
        await videoTrack.applyConstraints(preferred);
      } catch (error) {
        // Capture is already valid. A quality preference failure must never tear
        // down an otherwise usable Firefox share.
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

function compatInjectStyles() {
  const style = document.createElement('style');
  style.id = 'simpleshare-compat-styles';
  style.textContent = `
    .compat-camera-dock {
      background: var(--blurple, #5865f2);
    }
    .compat-camera-dock:hover:not(:disabled) {
      filter: brightness(1.08);
    }
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
      max-width: min(760px, calc(100% - 28px));
      padding: 6px 8px;
      overflow-x: auto;
      scrollbar-width: none;
      border: 1px solid rgba(255,255,255,.08);
      border-radius: 999px;
      background: rgba(20,21,24,.72);
      box-shadow: 0 8px 26px rgba(0,0,0,.24);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
    }
    .compat-people-bubbles::-webkit-scrollbar { display: none; }
    .compat-person-bubble {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-width: 0;
      max-width: 170px;
      padding: 3px 8px 3px 4px;
      border-radius: 999px;
      background: var(--bg-3, #2b2d31);
      color: var(--text, #f2f3f5);
      box-shadow: inset 0 0 0 1px rgba(255,255,255,.04);
      white-space: nowrap;
    }
    .compat-person-avatar {
      position: relative;
      flex: 0 0 auto;
      width: 27px;
      height: 27px;
      display: grid;
      place-items: center;
      border-radius: 50%;
      background: var(--bg-5, #383a40);
      color: var(--text, #fff);
      font-size: 12px;
      font-weight: 800;
    }
    .compat-person-avatar.live::after {
      content: '';
      position: absolute;
      right: -1px;
      bottom: -1px;
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--red, #da373c);
      border: 2px solid var(--bg-3, #2b2d31);
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
    .compat-fullscreen {
      min-width: 30px;
      font-size: 15px;
      line-height: 1;
    }
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
    @media (max-width: 640px) {
      .compat-people-bubbles {
        top: 10px;
        max-width: calc(100% - 20px);
      }
      .compat-person-bubble { padding-right: 4px; }
      .compat-person-name { display: none; }
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

  const cameraButton = document.createElement('button');
  cameraButton.id = 'cameraBtn';
  cameraButton.type = 'button';
  cameraButton.className = 'dock-btn compat-camera-dock';
  cameraButton.title = 'Share camera';
  cameraButton.setAttribute('aria-label', 'Share camera');
  cameraButton.textContent = '◉';
  dock.insertBefore(cameraButton, shareButton);

  const updateCameraButton = () => {
    const sharing = shareButton.classList.contains('hidden') || !stopButton.classList.contains('hidden');
    cameraButton.classList.toggle('hidden', sharing);
    cameraButton.disabled = shareButton.disabled || !compatMediaDevices || typeof compatMediaDevices.getUserMedia !== 'function';
  };

  // This capture-phase listener runs before app.js's normal click handler.
  // Firefox does not currently return display-audio tracks, so temporarily make
  // the existing publisher request video-only. The checkbox is restored as soon
  // as app.js has synchronously read it.
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
    try {
      shareButton.click();
    } finally {
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

function compatInstallPeopleBubbles() {
  const stage = document.querySelector('.stage');
  const people = document.getElementById('people');
  const room = document.getElementById('room');
  if (!stage || !people || !room) return;

  // Keep the detailed member panel available through the existing members
  // button, but start every room with it collapsed. The compact bubbles below
  // become the primary participant list in the stream area.
  try { localStorage.setItem('simpleshare-hide-members', '1'); } catch {}
  room.classList.add('no-members');

  const host = document.createElement('div');
  host.className = 'compat-people-bubbles hidden';
  host.id = 'peopleBubbles';
  host.setAttribute('aria-label', 'People in this call');
  stage.appendChild(host);

  const sync = () => {
    const rows = [...people.querySelectorAll('.person')];
    host.replaceChildren();
    for (const row of rows) {
      const sourceAvatar = row.querySelector('.person-avatar');
      const sourceName = row.querySelector('.person-name');
      if (!sourceAvatar || !sourceName) continue;

      const bubble = document.createElement('div');
      bubble.className = 'compat-person-bubble';
      bubble.title = sourceName.textContent || 'Participant';

      const avatar = document.createElement('span');
      avatar.className = `compat-person-avatar${sourceAvatar.classList.contains('live') ? ' live' : ''}`;
      avatar.textContent = sourceAvatar.textContent || '?';

      const name = document.createElement('span');
      name.className = 'compat-person-name';
      name.textContent = sourceName.textContent || 'Participant';

      bubble.append(avatar, name);
      host.appendChild(bubble);
    }
    host.classList.toggle('hidden', host.childElementCount === 0);
  };

  const peopleObserver = new MutationObserver(sync);
  peopleObserver.observe(people, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class'] });
  sync();
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
      if (tile.querySelector('.compat-fullscreen')) continue;
      const actions = tile.querySelector('.tile-actions');
      if (!actions) continue;

      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'tile-action-btn compat-fullscreen';
      button.textContent = '⛶';
      button.title = 'Enter fullscreen';
      button.setAttribute('aria-label', 'Enter fullscreen');
      button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        compatRequestTileFullscreen(tile).catch((error) => {
          console.warn('[SimpleShare] fullscreen request failed:', error);
        });
      });

      const close = actions.querySelector('.tile-stop');
      actions.insertBefore(button, close || null);
    }
  };

  const updateLabels = () => {
    const active = document.fullscreenElement || document.webkitFullscreenElement;
    for (const button of grid.querySelectorAll('.compat-fullscreen')) {
      const isActive = active && button.closest('.tile') === active;
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
  const observer = new MutationObserver(() => {
    if (!room.classList.contains('hidden') && !room.dataset.compatInitialCollapseDone) {
      room.dataset.compatInitialCollapseDone = '1';
      room.classList.add('no-members');
      try { localStorage.setItem('simpleshare-hide-members', '1'); } catch {}
    }
  });
  observer.observe(room, { attributes: true, attributeFilter: ['class'] });
}

compatInstallCaptureAdapter();
compatInjectStyles();
compatKeepSidebarCollapsedOnEntry();
compatInstallCaptureControls();
compatInstallPeopleBubbles();
compatInstallFullscreenButtons();
