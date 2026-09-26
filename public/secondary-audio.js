// SimpleShare secondary audio mixer
// Adds an optional second display-capture audio source and mixes it locally
// with the primary shared window/tab audio into ONE outgoing WebRTC audio track.
// This keeps the existing PartyTracks/P2P publishing code unchanged.

(() => {
  const mediaDevices = navigator.mediaDevices;
  if (!mediaDevices?.getDisplayMedia || mediaDevices.getDisplayMedia.__simpleShareSecondaryAudio) return;

  const originalGetDisplayMedia = mediaDevices.getDisplayMedia.bind(mediaDevices);
  let activeMix = null;

  const $ = (id) => document.getElementById(id);
  const clamp = (n, min, max) => Math.min(max, Math.max(min, n));
  const readPercent = (id, fallback) => clamp(Number($(id)?.value ?? fallback) || 0, 0, 100) / 100;

  function setStatus(message, tone = '') {
    const el = $('secondaryAudioStatus');
    if (!el) return;
    el.textContent = message;
    el.dataset.tone = tone;
  }

  function persist(id, key) {
    const el = $(id);
    if (!el) return;
    try {
      const saved = localStorage.getItem(key);
      if (saved !== null) {
        if (el.type === 'checkbox') el.checked = saved === '1';
        else el.value = saved;
      }
    } catch {}
    el.addEventListener(el.type === 'range' ? 'input' : 'change', () => {
      try { localStorage.setItem(key, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value); } catch {}
    });
  }

  function injectControls() {
    const withAudio = $('withAudio');
    if (!withAudio || $('withExtraAudio')) return;
    const anchor = withAudio.closest('.switch-row');
    if (!anchor?.parentNode) return;

    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <label class="switch-row" id="extraAudioSwitchRow">
        <span><strong>Add a second audio source</strong><small>After choosing your game/window, SimpleShare will ask for another tab/window to mix in, such as YouTube Music or Spotify.</small></span>
        <input type="checkbox" id="withExtraAudio" />
      </label>
      <div class="settings-row volume-row" id="primaryMixRow">
        <label for="primaryMixSlider">Game / window audio</label>
        <div class="volume-control"><input id="primaryMixSlider" type="range" min="0" max="100" value="100" aria-label="Primary shared audio level" /><span id="primaryMixValue">100%</span></div>
      </div>
      <div class="settings-row volume-row" id="extraMixRow">
        <label for="extraMixSlider">Extra audio</label>
        <div class="volume-control"><input id="extraMixSlider" type="range" min="0" max="100" value="60" aria-label="Additional shared audio level" /><span id="extraMixValue">60%</span></div>
      </div>
      <div class="settings-row settings-note" id="secondaryAudioStatus">Extra audio is off.</div>
    `;

    const nodes = [...wrap.children];
    let cursor = anchor;
    for (const node of nodes) {
      cursor.insertAdjacentElement('afterend', node);
      cursor = node;
    }

    persist('withExtraAudio', 'simpleshare-extra-audio');
    persist('primaryMixSlider', 'simpleshare-primary-mix');
    persist('extraMixSlider', 'simpleshare-extra-mix');

    const updateLabels = () => {
      if ($('primaryMixValue')) $('primaryMixValue').textContent = `${$('primaryMixSlider')?.value ?? 100}%`;
      if ($('extraMixValue')) $('extraMixValue').textContent = `${$('extraMixSlider')?.value ?? 60}%`;
      if (activeMix) {
        const now = activeMix.ctx.currentTime;
        try { activeMix.primaryGain?.gain.setTargetAtTime(readPercent('primaryMixSlider', 100), now, 0.015); } catch {}
        try { activeMix.secondaryGain?.gain.setTargetAtTime(readPercent('extraMixSlider', 60), now, 0.015); } catch {}
      }
    };
    $('primaryMixSlider')?.addEventListener('input', updateLabels);
    $('extraMixSlider')?.addEventListener('input', updateLabels);
    $('withExtraAudio')?.addEventListener('change', () => setStatus($('withExtraAudio').checked ? 'Extra audio will be selected after the main share.' : 'Extra audio is off.'));
    updateLabels();
    setStatus($('withExtraAudio')?.checked ? 'Extra audio will be selected after the main share.' : 'Extra audio is off.');
  }

  function setCaptureToggleDisabled(disabled) {
    const el = $('withExtraAudio');
    if (el) el.disabled = disabled;
  }

  async function captureAdditionalAudio() {
    setStatus('Choose the music/audio source in the second picker…', 'working');
    let stream;
    try {
      stream = await originalGetDisplayMedia({
        // Browsers require a visual surface even though SimpleShare only keeps
        // the audio from this second picker. Keep the hidden video lightweight.
        video: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 5, max: 10 } },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        systemAudio: 'include',
        windowAudio: 'window',
        surfaceSwitching: 'include',
        selfBrowserSurface: 'exclude',
      });
    } catch (err) {
      if (err?.name === 'NotAllowedError' || err?.name === 'AbortError') {
        setStatus('Extra audio picker cancelled. Main stream will continue.');
        return null;
      }
      console.warn('[SimpleShare] additional audio capture failed', err);
      setStatus('Could not capture the extra audio source. Main stream will continue.', 'warn');
      return null;
    }

    const track = stream.getAudioTracks()[0] || null;
    if (!track) {
      stream.getTracks().forEach(t => { try { t.stop(); } catch {} });
      setStatus('That source provided no audio. Try a browser tab with “Share tab audio” enabled.', 'warn');
      return null;
    }

    // The second video is never published. Disabling it keeps the capture alive
    // while avoiding unnecessary frame production/compositing work.
    for (const video of stream.getVideoTracks()) video.enabled = false;
    try { track.contentHint = 'music'; } catch {}
    return { stream, track };
  }

  async function mixAudio(primaryStream, extra) {
    const primaryTrack = primaryStream.getAudioTracks()[0] || null;
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) throw new Error('Web Audio API is unavailable in this browser.');

    const ctx = new AudioContextCtor({ latencyHint: 'interactive', sampleRate: 48000 });
    const destination = ctx.createMediaStreamDestination();
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 3;
    limiter.ratio.value = 12;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.18;
    limiter.connect(destination);

    let primaryGain = null;
    let secondaryGain = null;

    if (primaryTrack) {
      const source = ctx.createMediaStreamSource(new MediaStream([primaryTrack]));
      primaryGain = ctx.createGain();
      primaryGain.gain.value = readPercent('primaryMixSlider', 100);
      source.connect(primaryGain).connect(limiter);
    }

    const extraSource = ctx.createMediaStreamSource(new MediaStream([extra.track]));
    secondaryGain = ctx.createGain();
    secondaryGain.gain.value = readPercent('extraMixSlider', 60);
    extraSource.connect(secondaryGain).connect(limiter);

    try { await ctx.resume(); } catch {}

    const mixedTrack = destination.stream.getAudioTracks()[0];
    if (!mixedTrack) throw new Error('Could not create the mixed audio output track.');
    try { mixedTrack.contentHint = 'music'; } catch {}

    const returned = new MediaStream([...primaryStream.getVideoTracks(), mixedTrack]);
    let cleaned = false;
    const nativeStop = mixedTrack.stop.bind(mixedTrack);

    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      activeMix = null;
      try { primaryTrack?.stop(); } catch {}
      for (const track of extra.stream.getTracks()) { try { track.stop(); } catch {} }
      try { ctx.close(); } catch {}
      setCaptureToggleDisabled(false);
      setStatus('Extra audio stopped.');
    };

    // SimpleShare stops every track on its returned stream when sharing ends.
    // Hook the mixed output's stop so the hidden second capture and AudioContext
    // are torn down at the same time instead of leaking in the background.
    try {
      mixedTrack.stop = () => {
        cleanup();
        nativeStop();
      };
    } catch {}

    const primaryVideo = primaryStream.getVideoTracks()[0];
    primaryVideo?.addEventListener('ended', cleanup, { once: true });
    extra.track.addEventListener('ended', () => {
      setStatus(primaryTrack ? 'Extra audio source ended; game/window audio is still live.' : 'Extra audio source ended.', 'warn');
    }, { once: true });

    activeMix = { ctx, primaryGain, secondaryGain, cleanup };
    setStatus(`Mixing ${primaryTrack ? 'game/window + ' : ''}extra audio into one shared track.`, 'ok');
    return returned;
  }

  async function wrappedGetDisplayMedia(constraints) {
    // Always let SimpleShare's original main picker happen first.
    const primary = await originalGetDisplayMedia(constraints);
    if (!$('withExtraAudio')?.checked) return primary;

    setCaptureToggleDisabled(true);
    const extra = await captureAdditionalAudio();
    if (!extra) {
      setCaptureToggleDisabled(false);
      return primary;
    }

    try {
      return await mixAudio(primary, extra);
    } catch (err) {
      console.warn('[SimpleShare] audio mixer setup failed', err);
      for (const track of extra.stream.getTracks()) { try { track.stop(); } catch {} }
      setCaptureToggleDisabled(false);
      setStatus('Audio mixer failed; continuing with the main share audio only.', 'warn');
      return primary;
    }
  }

  wrappedGetDisplayMedia.__simpleShareSecondaryAudio = true;
  mediaDevices.getDisplayMedia = wrappedGetDisplayMedia;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', injectControls, { once: true });
  else injectControls();
})();
