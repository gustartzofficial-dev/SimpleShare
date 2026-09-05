/*
 * SimpleShare Gecko audio bridge
 *
 * Firefox/Zen currently return display video without a display-audio track.
 * This layer keeps the normal Gecko screen picker, then optionally captures a
 * user-selected loopback INPUT device (Stereo Mix, VB-CABLE, Pulse/PipeWire
 * monitor, BlackHole, etc.) with getUserMedia() and adds that audio track to
 * the display MediaStream before app.js receives it.
 *
 * It deliberately does not alter PartyTracks, P2P, room signaling or stream
 * publication. Chromium browsers are untouched.
 */

const ssGeckoAudioIsGecko = /(?:Firefox|Fennec)\//i.test(navigator.userAgent) ||
  (/Gecko\//i.test(navigator.userAgent) && !/like Gecko/i.test(navigator.userAgent));

if (ssGeckoAudioIsGecko && navigator.mediaDevices?.getDisplayMedia && navigator.mediaDevices?.getUserMedia) {
  const mediaDevices = navigator.mediaDevices;
  const wrappedDisplayMedia = mediaDevices.getDisplayMedia.bind(mediaDevices);
  const getUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);
  const STORAGE_KEY = 'simpleshare-gecko-audio-source-v1';
  const WARNED_KEY = 'simpleshare-gecko-audio-warning-v1';

  let configuredSource = ssLoadSource();
  let wantedAudio = Boolean(document.getElementById('withAudio')?.checked);
  let ui = null;

  function ssLoadSource() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
      if (!parsed || typeof parsed !== 'object') return null;
      const deviceId = String(parsed.deviceId || '');
      const label = String(parsed.label || '').slice(0, 180);
      return deviceId ? { deviceId, label } : null;
    } catch {
      return null;
    }
  }

  function ssSaveSource(source) {
    configuredSource = source?.deviceId ? {
      deviceId: String(source.deviceId),
      label: String(source.label || '').slice(0, 180),
    } : null;
    try {
      if (configuredSource) localStorage.setItem(STORAGE_KEY, JSON.stringify(configuredSource));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {}
    ssRenderSourceState();
  }

  function ssLooksLikeLoopback(label) {
    return /(stereo\s*mix|mixagem\s*est[eé]reo|what\s*u\s*hear|wave\s*out|loopback|blackhole|soundflower|vb-?audio|vb-?cable|cable\s*(output|out)|voicemeeter\s*(output|aux|vaio)|monitor\s+(of|de|do)|pulse.*monitor|pipewire.*monitor|output\s*monitor|speaker.*monitor)/i.test(String(label || ''));
  }

  function ssCleanLabel(label) {
    return String(label || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  }

  function ssToast(message, delay = 0) {
    setTimeout(() => {
      const toast = document.getElementById('toast');
      if (!toast) return;
      toast.textContent = message;
      toast.classList.add('show');
      clearTimeout(ssToast._timer);
      ssToast._timer = setTimeout(() => toast.classList.remove('show'), 4200);
    }, delay);
  }

  function ssSetStatus(message, tone = '') {
    if (!ui?.status) return;
    ui.status.textContent = message;
    ui.status.dataset.tone = tone;
  }

  async function ssEnumerateAudioInputs() {
    try {
      const devices = await mediaDevices.enumerateDevices();
      return devices.filter(device => device.kind === 'audioinput' && device.deviceId);
    } catch {
      return [];
    }
  }

  async function ssResolveConfiguredSource() {
    const devices = await ssEnumerateAudioInputs();
    if (!devices.length) return configuredSource;

    if (configuredSource?.deviceId) {
      const exact = devices.find(device => device.deviceId === configuredSource.deviceId);
      if (exact) {
        const label = ssCleanLabel(exact.label || configuredSource.label);
        if (label && label !== configuredSource.label) ssSaveSource({ deviceId: exact.deviceId, label });
        return { deviceId: exact.deviceId, label };
      }
      if (configuredSource.label) {
        const byName = devices.find(device => ssCleanLabel(device.label) === configuredSource.label);
        if (byName) {
          const next = { deviceId: byName.deviceId, label: ssCleanLabel(byName.label) };
          ssSaveSource(next);
          return next;
        }
      }
    }

    // Safe convenience: auto-select only a device whose label strongly looks
    // like a loopback source. Never silently fall back to the default mic.
    const loopback = devices.find(device => ssLooksLikeLoopback(device.label));
    if (loopback) {
      const next = { deviceId: loopback.deviceId, label: ssCleanLabel(loopback.label) };
      ssSaveSource(next);
      return next;
    }
    return null;
  }

  async function ssCaptureBridgeTrack() {
    const source = await ssResolveConfiguredSource();
    if (!source?.deviceId) {
      ssSetStatus('No loopback source selected. Use Scan / choose source first.', 'warn');
      ssToast('Firefox/Zen need a loopback audio input. Open Stream settings and choose Stereo Mix, CABLE Output, a monitor source, or similar.', 80);
      return null;
    }

    try {
      const audioStream = await getUserMedia({
        video: false,
        audio: {
          deviceId: { exact: source.deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 },
        },
      });
      const track = audioStream.getAudioTracks()[0] || null;
      if (!track) {
        audioStream.getTracks().forEach(t => t.stop());
        throw new Error('The selected source returned no audio track.');
      }
      try { track.contentHint = 'music'; } catch {}
      const label = ssCleanLabel(track.label || source.label || 'selected audio source');
      ssSetStatus(`Ready: ${label}`, ssLooksLikeLoopback(label) ? 'ok' : 'warn');
      return track;
    } catch (error) {
      console.warn('[SimpleShare] Gecko audio bridge capture failed:', error);
      ssSetStatus('Selected audio source is unavailable. Scan again.', 'bad');
      ssToast('Firefox/Zen audio bridge could not open the selected source. Scan the audio sources again in Stream settings.', 80);
      return null;
    }
  }

  // Wrap compat.js's Gecko-aware getDisplayMedia. compat.js already strips the
  // unsupported Gecko display-audio request; this wrapper adds an independent
  // loopback audio track back to the returned stream when the user requested it.
  const bridgedDisplayMedia = async (options = {}) => {
    const wantsAudio = Boolean(options?.audio);
    const stream = await wrappedDisplayMedia(options);
    if (!wantsAudio) return stream;

    const videoTrack = stream.getVideoTracks()[0];
    const surface = videoTrack?.getSettings?.().displaySurface || 'unknown';

    // Keep SimpleShare's existing privacy policy: full-monitor sharing never
    // gets a whole-system loopback track attached. Window/browser sharing may
    // use the explicitly configured bridge, with the UI warning that loopback
    // sources can include audio outside the selected window.
    if (surface === 'monitor') {
      ssSetStatus('Audio bridge disabled for full-monitor sharing.', 'warn');
      ssToast('For Firefox/Zen audio, share an app window rather than the entire monitor. SimpleShare keeps full-system audio blocked for privacy.', 100);
      return stream;
    }

    const audioTrack = await ssCaptureBridgeTrack();
    if (audioTrack) stream.addTrack(audioTrack);
    return stream;
  };

  try {
    Object.defineProperty(mediaDevices, 'getDisplayMedia', {
      configurable: true,
      writable: true,
      value: bridgedDisplayMedia,
    });
  } catch {
    try { mediaDevices.getDisplayMedia = bridgedDisplayMedia; } catch {}
  }

  function ssInstallStyles() {
    if (document.getElementById('ss-gecko-audio-styles')) return;
    const style = document.createElement('style');
    style.id = 'ss-gecko-audio-styles';
    style.textContent = `
      .ss-gecko-audio-row{align-items:flex-start!important}
      .ss-gecko-audio-control{min-width:190px;display:grid;gap:6px}
      .ss-gecko-audio-line{display:flex;gap:6px;align-items:center}
      .ss-gecko-audio-line select{min-width:0!important;flex:1;width:100%}
      .ss-gecko-audio-scan{flex:0 0 auto;white-space:nowrap}
      .ss-gecko-audio-status{display:block;font-size:10px;line-height:1.35;color:var(--dim,#949ba4)}
      .ss-gecko-audio-status[data-tone="ok"]{color:var(--green,#23a55a)}
      .ss-gecko-audio-status[data-tone="warn"]{color:var(--yellow,#f0b232)}
      .ss-gecko-audio-status[data-tone="bad"]{color:#ff7b7f}
      .ss-gecko-audio-warning{display:block;margin-top:4px;font-size:10px;line-height:1.35;color:var(--yellow,#f0b232)}
      html[data-theme="terminal"] .ss-gecko-audio-status,
      html[data-theme="terminal"] .ss-gecko-audio-warning{font-family:ui-monospace,SFMono-Regular,Consolas,monospace!important;text-shadow:0 0 8px rgba(83,255,123,.16)}
      html[data-theme="win98"] .ss-gecko-audio-line select,
      html[data-theme="win98"] .ss-gecko-audio-scan{border-radius:0!important}
      @media(max-width:560px){
        .ss-gecko-audio-control{width:100%;min-width:0}
        .ss-gecko-audio-line{align-items:stretch}
      }
    `;
    document.head.appendChild(style);
  }

  async function ssRefreshSourceList({ unlockLabels = false } = {}) {
    if (!ui?.select) return;
    if (unlockLabels) {
      ui.scan.disabled = true;
      ui.scan.textContent = 'Scanning…';
      let probe = null;
      try {
        // Firefox reveals device labels after audio permission. The probe is
        // stopped immediately and is never attached to the call.
        probe = await getUserMedia({ video: false, audio: true });
      } catch (error) {
        if (error?.name !== 'NotAllowedError') console.warn('[SimpleShare] audio source scan:', error);
      } finally {
        probe?.getTracks().forEach(track => track.stop());
        ui.scan.disabled = false;
        ui.scan.textContent = 'Scan';
      }
    }

    const devices = await ssEnumerateAudioInputs();
    const previous = configuredSource?.deviceId || '';
    ui.select.replaceChildren();

    const none = document.createElement('option');
    none.value = '';
    none.textContent = devices.length ? 'Choose audio input…' : 'No labelled audio inputs yet';
    ui.select.appendChild(none);

    for (const device of devices) {
      const option = document.createElement('option');
      option.value = device.deviceId;
      const label = ssCleanLabel(device.label) || 'Audio input';
      option.textContent = ssLooksLikeLoopback(label) ? `↻ ${label}` : label;
      option.dataset.label = label;
      ui.select.appendChild(option);
    }

    let selected = devices.find(device => device.deviceId === previous);
    if (!selected && configuredSource?.label) {
      selected = devices.find(device => ssCleanLabel(device.label) === configuredSource.label);
    }
    if (!selected) selected = devices.find(device => ssLooksLikeLoopback(device.label));

    if (selected) {
      ui.select.value = selected.deviceId;
      const next = { deviceId: selected.deviceId, label: ssCleanLabel(selected.label) };
      if (!configuredSource || next.deviceId !== configuredSource.deviceId || next.label !== configuredSource.label) ssSaveSource(next);
    } else if (configuredSource) {
      // Keep the remembered source even when labels are temporarily hidden;
      // getUserMedia({deviceId: exact}) may still be able to open it.
      const remembered = document.createElement('option');
      remembered.value = configuredSource.deviceId;
      remembered.textContent = `Remembered: ${configuredSource.label || 'audio source'}`;
      remembered.dataset.label = configuredSource.label || '';
      ui.select.appendChild(remembered);
      ui.select.value = configuredSource.deviceId;
    }

    ssRenderSourceState();
  }

  function ssRenderSourceState() {
    if (!ui) return;
    const source = configuredSource;
    if (!source) {
      ssSetStatus('Not configured. Scan and choose a loopback source.', 'warn');
      return;
    }
    const label = source.label || 'remembered audio source';
    if (ssLooksLikeLoopback(label)) {
      ssSetStatus(`Ready: ${label}`, 'ok');
    } else {
      ssSetStatus(`Selected: ${label} — verify this is your intended loopback/input source.`, 'warn');
    }
  }

  function ssInstallSettingsUi() {
    const withAudio = document.getElementById('withAudio');
    const switchRow = withAudio?.closest('.switch-row');
    if (!withAudio || !switchRow || document.getElementById('ssGeckoAudioSource')) return;

    wantedAudio = Boolean(withAudio.checked);
    withAudio.addEventListener('change', () => { wantedAudio = Boolean(withAudio.checked); });

    const textHost = switchRow.querySelector('span');
    const oldNote = textHost?.querySelector('.compat-firefox-note');
    if (oldNote) {
      oldNote.textContent = 'Firefox/Zen do not expose screen audio through getDisplayMedia. SimpleShare can bridge a separate loopback audio input below.';
    }

    const row = document.createElement('div');
    row.className = 'settings-row ss-gecko-audio-row';
    row.innerHTML = `
      <label for="ssGeckoAudioSource">Firefox / Zen audio</label>
      <div class="ss-gecko-audio-control">
        <div class="ss-gecko-audio-line">
          <select id="ssGeckoAudioSource" aria-label="Firefox or Zen audio bridge source"></select>
          <button id="ssGeckoAudioScan" class="compat-pfp-button ss-gecko-audio-scan" type="button">Scan</button>
        </div>
        <small id="ssGeckoAudioStatus" class="ss-gecko-audio-status"></small>
        <small class="ss-gecko-audio-warning">Use a loopback source such as Stereo Mix, CABLE Output, “Monitor of …” or BlackHole. Loopback audio can include sound outside the window you share.</small>
      </div>`;
    switchRow.insertAdjacentElement('afterend', row);

    ui = {
      row,
      select: row.querySelector('#ssGeckoAudioSource'),
      scan: row.querySelector('#ssGeckoAudioScan'),
      status: row.querySelector('#ssGeckoAudioStatus'),
    };

    ui.scan.addEventListener('click', () => ssRefreshSourceList({ unlockLabels: true }));
    ui.select.addEventListener('change', () => {
      const option = ui.select.selectedOptions?.[0];
      const deviceId = ui.select.value;
      if (!deviceId) {
        ssSaveSource(null);
        return;
      }
      ssSaveSource({ deviceId, label: ssCleanLabel(option?.dataset.label || option?.textContent || '') });
    });

    mediaDevices.addEventListener?.('devicechange', () => ssRefreshSourceList().catch(() => {}));
    ssRefreshSourceList().catch(() => ssRenderSourceState());
  }

  function ssRestoreRequestedAudioForRealScreenClicks() {
    const shareButton = document.getElementById('shareBtn');
    const withAudio = document.getElementById('withAudio');
    if (!shareButton || !withAudio) return;

    // compat.js temporarily clears the checkbox in its Gecko capture listener.
    // That was correct when Gecko could only be video-only, but would prevent
    // app.js from asking this bridge for audio. Its listener was installed
    // first; this one runs immediately after it and restores the user's real
    // preference before app.js's normal click handler executes.
    shareButton.addEventListener('click', event => {
      // Camera sharing calls shareBtn.click() programmatically. Leave audio off
      // for that synthetic click so camera remains video-only by design.
      if (!event.isTrusted) return;
      withAudio.checked = wantedAudio;
    }, { capture: true });
  }

  function ssWarnOnce() {
    try {
      if (localStorage.getItem(WARNED_KEY) === '1') return;
      localStorage.setItem(WARNED_KEY, '1');
    } catch {}
    // Keep this inline rather than a startup toast; the settings note explains
    // the limitation without interrupting the user every time they enter.
  }

  ssInstallStyles();
  ssInstallSettingsUi();
  ssRestoreRequestedAudioForRealScreenClicks();
  ssWarnOnce();
}
