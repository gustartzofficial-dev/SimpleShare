/*
 * SimpleShare Firefox / Zen seamless audio bridge
 *
 * Gecko does not currently return display-audio tracks from getDisplayMedia().
 * This compatibility layer keeps Firefox's normal screen/window picker and,
 * when "Share window audio" is enabled, automatically looks for a safe-looking
 * loopback INPUT exposed by the OS (Stereo Mix, PipeWire/Pulse monitor,
 * VB-CABLE, BlackHole, etc.). It then adds that audio track to the same
 * MediaStream app.js already publishes.
 *
 * Design goals:
 * - Chromium path stays completely untouched.
 * - Never silently capture the default microphone.
 * - Existing PartyTracks / P2P / Worker / signaling code stays untouched.
 * - One-time setup should be as automatic as Firefox permits.
 * - SimpleShare's own received audio is muted locally while loopback capture is
 *   active, preventing a SimpleShare -> speakers -> loopback feedback cycle.
 * - External apps such as Discord cannot be selectively removed from a broad
 *   OS loopback source by browser JavaScript; the settings UI states this.
 */

const ssGeckoAudioIsGecko = /(?:Firefox|Fennec)\//i.test(navigator.userAgent) ||
  (/Gecko\//i.test(navigator.userAgent) && !/like Gecko/i.test(navigator.userAgent));

if (ssGeckoAudioIsGecko && navigator.mediaDevices?.getDisplayMedia && navigator.mediaDevices?.getUserMedia) {
  const mediaDevices = navigator.mediaDevices;
  const wrappedDisplayMedia = mediaDevices.getDisplayMedia.bind(mediaDevices);
  const getUserMedia = mediaDevices.getUserMedia.bind(mediaDevices);

  const STORAGE_KEY = 'simpleshare-gecko-audio-source-v2';
  const OLD_STORAGE_KEY = 'simpleshare-gecko-audio-source-v1';
  const FIRST_AUTO_TOAST_KEY = 'simpleshare-gecko-audio-auto-toast-v1';

  const platform = String(navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || '');
  const isWindows = /win/i.test(platform);
  const isLinux = /linux/i.test(platform);

  let configuredSource = ssLoadSource();
  let wantedAudio = Boolean(document.getElementById('withAudio')?.checked);
  let permissionProbeAttempted = false;
  let sourceRefreshPromise = null;
  let ui = null;

  let echoGuardActive = false;
  let echoGuardObserver = null;
  const echoGuardPriorMuted = new Map();

  function ssLoadSource() {
    const read = (key) => {
      try {
        const parsed = JSON.parse(localStorage.getItem(key) || 'null');
        if (!parsed || typeof parsed !== 'object') return null;
        const deviceId = String(parsed.deviceId || '');
        const label = ssCleanLabel(parsed.label || '');
        return deviceId ? { deviceId, label } : null;
      } catch {
        return null;
      }
    };
    const current = read(STORAGE_KEY);
    if (current) return current;
    const old = read(OLD_STORAGE_KEY);
    if (old) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(old)); } catch {}
      return old;
    }
    return null;
  }

  function ssSaveSource(source) {
    configuredSource = source?.deviceId ? {
      deviceId: String(source.deviceId),
      label: ssCleanLabel(source.label || ''),
    } : null;
    try {
      if (configuredSource) localStorage.setItem(STORAGE_KEY, JSON.stringify(configuredSource));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {}
    ssRenderSourceState();
  }

  function ssCleanLabel(label) {
    return String(label || '').replace(/\s+/g, ' ').trim().slice(0, 180);
  }

  function ssLooksLikeMicrophone(label) {
    return /(microphone|mic\b|mikrofon|microfone|webcam|camera mic|headset mic|headset microphone|input microphone|built[ -]?in mic)/i.test(String(label || ''));
  }

  function ssLoopbackScore(label) {
    const value = ssCleanLabel(label).toLowerCase();
    if (!value || ssLooksLikeMicrophone(value)) return -1000;

    let score = 0;
    if (/monitor\s+(of|de|do)\b/.test(value)) score += 150;
    if (/\b(stereo\s*mix|mixagem\s*est[eé]reo|what\s*u\s*hear|wave\s*out)\b/.test(value)) score += 145;
    if (/\b(loopback|output\s*monitor|speaker.*monitor)\b/.test(value)) score += 135;
    if (/\b(cable\s*(output|out)|vb-?audio|vb-?cable)\b/.test(value)) score += 130;
    if (/\b(voicemeeter\s*(output|aux|vaio)|blackhole|soundflower)\b/.test(value)) score += 125;
    if (/pulse.*monitor|pipewire.*monitor|alsa_output.*monitor/.test(value)) score += 140;
    if (/\bmonitor\b/.test(value)) score += 50;

    // Prefer physical/default playback monitors over communication/headset
    // loopbacks when otherwise tied. This only breaks ties between sources
    // already identified as loopbacks; it never turns a normal input into one.
    if (/default|speaker|speakers|lautsprecher|alto-?falante/.test(value)) score += 5;
    if (/communication|communications/.test(value)) score -= 8;
    return score;
  }

  function ssIsLoopback(label) {
    return ssLoopbackScore(label) >= 80;
  }

  function ssToast(message, delay = 0, duration = 4300) {
    setTimeout(() => {
      const toast = document.getElementById('toast');
      if (!toast) return;
      toast.textContent = message;
      toast.classList.add('show');
      clearTimeout(ssToast._timer);
      ssToast._timer = setTimeout(() => toast.classList.remove('show'), duration);
    }, delay);
  }

  function ssSetStatus(message, tone = '') {
    if (!ui?.status) return;
    ui.status.textContent = message;
    ui.status.dataset.tone = tone;
  }

  async function ssEnumerateDevices() {
    try {
      return await mediaDevices.enumerateDevices();
    } catch {
      return [];
    }
  }

  function ssAudioInputs(devices) {
    return devices.filter(device => device.kind === 'audioinput' && device.deviceId);
  }

  function ssBestLoopback(devices) {
    const candidates = ssAudioInputs(devices)
      .map(device => ({ device, label: ssCleanLabel(device.label), score: ssLoopbackScore(device.label) }))
      .filter(item => item.score >= 80)
      .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
    return candidates[0] || null;
  }

  function ssFindRemembered(devices) {
    if (!configuredSource?.deviceId) return null;
    const inputs = ssAudioInputs(devices);
    const exact = inputs.find(device => device.deviceId === configuredSource.deviceId);
    if (exact) return exact;
    if (!configuredSource.label) return null;
    const wanted = ssCleanLabel(configuredSource.label).toLowerCase();
    return inputs.find(device => ssCleanLabel(device.label).toLowerCase() === wanted) || null;
  }

  async function ssUnlockDeviceLabels() {
    if (permissionProbeAttempted) return false;
    permissionProbeAttempted = true;
    ssSetStatus('One-time Firefox audio-device permission…', 'warn');
    let probe = null;
    try {
      // This is only a permission/label probe. It is stopped immediately and
      // is never added to the share. We still refuse to use it as the bridge
      // unless its label later identifies it as an actual loopback source.
      probe = await getUserMedia({ video: false, audio: true });
      return true;
    } catch (error) {
      if (error?.name !== 'NotAllowedError') {
        console.warn('[SimpleShare] Firefox audio-device permission probe:', error);
      }
      return false;
    } finally {
      probe?.getTracks().forEach(track => {
        try { track.stop(); } catch {}
      });
    }
  }

  async function ssResolveAutomaticSource({ allowPermissionPrompt = false } = {}) {
    let devices = await ssEnumerateDevices();

    const remembered = ssFindRemembered(devices);
    if (remembered) {
      const next = {
        deviceId: remembered.deviceId,
        label: ssCleanLabel(remembered.label || configuredSource?.label),
      };
      if (next.label && (next.deviceId !== configuredSource?.deviceId || next.label !== configuredSource?.label)) {
        ssSaveSource(next);
      }
      return next;
    }

    let best = ssBestLoopback(devices);
    if (best) {
      const next = { deviceId: best.device.deviceId, label: best.label };
      ssSaveSource(next);
      return next;
    }

    const inputs = ssAudioInputs(devices);
    const labelsHidden = !inputs.length || inputs.some(device => !ssCleanLabel(device.label));
    if (allowPermissionPrompt && labelsHidden) {
      const unlocked = await ssUnlockDeviceLabels();
      if (unlocked) {
        devices = await ssEnumerateDevices();
        const retryRemembered = ssFindRemembered(devices);
        if (retryRemembered) {
          const next = {
            deviceId: retryRemembered.deviceId,
            label: ssCleanLabel(retryRemembered.label || configuredSource?.label),
          };
          ssSaveSource(next);
          return next;
        }
        best = ssBestLoopback(devices);
        if (best) {
          const next = { deviceId: best.device.deviceId, label: best.label };
          ssSaveSource(next);
          return next;
        }
      }
    }

    return configuredSource?.deviceId ? configuredSource : null;
  }

  async function ssRefreshSourceList({ unlockLabels = false, keepAdvanced = true } = {}) {
    if (sourceRefreshPromise) return sourceRefreshPromise;
    sourceRefreshPromise = (async () => {
      if (unlockLabels) await ssUnlockDeviceLabels();
      const devices = await ssEnumerateDevices();
      const inputs = ssAudioInputs(devices);

      if (ui?.select) {
        const previousId = configuredSource?.deviceId || '';
        ui.select.replaceChildren();

        const auto = document.createElement('option');
        auto.value = '';
        auto.textContent = 'Automatic (recommended)';
        ui.select.appendChild(auto);

        for (const device of inputs) {
          const label = ssCleanLabel(device.label) || 'Audio input';
          const option = document.createElement('option');
          option.value = device.deviceId;
          option.dataset.label = label;
          option.textContent = ssIsLoopback(label) ? `↻ ${label}` : label;
          ui.select.appendChild(option);
        }

        const remembered = ssFindRemembered(devices);
        if (remembered) {
          ui.select.value = remembered.deviceId;
        } else if (previousId && configuredSource) {
          const opt = document.createElement('option');
          opt.value = previousId;
          opt.dataset.label = configuredSource.label || '';
          opt.textContent = `Remembered: ${configuredSource.label || 'audio source'}`;
          ui.select.appendChild(opt);
          ui.select.value = previousId;
        } else {
          ui.select.value = '';
        }
      }

      const source = await ssResolveAutomaticSource({ allowPermissionPrompt: false });
      if (source?.deviceId) {
        ssSetStatus(`Automatic · ${source.label || 'remembered loopback source'}`, ssIsLoopback(source.label) ? 'ok' : 'warn');
      } else {
        ssSetStatus('Automatic detection will run when you first share with audio.', 'warn');
      }
      if (!keepAdvanced) ssSetAdvanced(false);
      return source;
    })().finally(() => { sourceRefreshPromise = null; });
    return sourceRefreshPromise;
  }

  function ssRememberOriginalMute(audio) {
    if (!echoGuardPriorMuted.has(audio)) echoGuardPriorMuted.set(audio, Boolean(audio.muted));
  }

  function ssApplyEchoGuard() {
    if (!echoGuardActive) return;
    for (const audio of document.querySelectorAll('#grid audio, #room .tile audio')) {
      ssRememberOriginalMute(audio);
      if (!audio.muted) {
        try { audio.muted = true; } catch {}
      }
    }
  }

  function ssEchoGuardEvent(event) {
    if (!echoGuardActive) return;
    const audio = event.target;
    if (!(audio instanceof HTMLMediaElement) || audio.tagName !== 'AUDIO') return;
    if (!audio.closest?.('#grid, #room .tile')) return;
    ssRememberOriginalMute(audio);
    if (!audio.muted) queueMicrotask(() => {
      if (echoGuardActive) {
        try { audio.muted = true; } catch {}
      }
    });
  }

  function ssStartEchoGuard() {
    if (echoGuardActive) return;
    echoGuardActive = true;
    ssApplyEchoGuard();
    const grid = document.getElementById('grid');
    if (grid) {
      echoGuardObserver = new MutationObserver(ssApplyEchoGuard);
      echoGuardObserver.observe(grid, { childList: true, subtree: true });
    }
    document.addEventListener('play', ssEchoGuardEvent, true);
    document.addEventListener('volumechange', ssEchoGuardEvent, true);
    document.documentElement.classList.add('ss-gecko-echo-guard');
  }

  function ssStopEchoGuard() {
    if (!echoGuardActive) return;
    echoGuardActive = false;
    echoGuardObserver?.disconnect();
    echoGuardObserver = null;
    document.removeEventListener('play', ssEchoGuardEvent, true);
    document.removeEventListener('volumechange', ssEchoGuardEvent, true);
    document.documentElement.classList.remove('ss-gecko-echo-guard');
    for (const [audio, wasMuted] of echoGuardPriorMuted) {
      if (!audio.isConnected) continue;
      try { audio.muted = wasMuted; } catch {}
    }
    echoGuardPriorMuted.clear();
  }

  function ssBindEchoGuardLifetime(stream, bridgeTrack) {
    const stop = () => ssStopEchoGuard();
    bridgeTrack?.addEventListener('ended', stop, { once: true });
    stream.getVideoTracks()[0]?.addEventListener('ended', stop, { once: true });
    try { stream.addEventListener?.('inactive', stop, { once: true }); } catch {}
  }

  async function ssCaptureBridgeTrack(source) {
    if (!source?.deviceId) return null;

    ssStartEchoGuard();
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
      return track;
    } catch (error) {
      ssStopEchoGuard();
      console.warn('[SimpleShare] Firefox / Zen audio bridge capture failed:', error);
      ssSetStatus('Audio source could not be opened. Use Change / Rescan.', 'bad');
      return null;
    }
  }

  async function ssPrepareSourceForShare() {
    const source = await ssResolveAutomaticSource({ allowPermissionPrompt: true });
    if (!source?.deviceId) {
      ssSetStatus('No loopback/system-audio input was found.', 'bad');
      ssSetAdvanced(true);
      return null;
    }
    const label = source.label || 'remembered loopback source';
    ssSetStatus(`Automatic · ${label}`, ssIsLoopback(label) ? 'ok' : 'warn');
    return source;
  }

  // Wrap compat.js's Gecko-aware getDisplayMedia. On the first audio share we
  // resolve the loopback source BEFORE Firefox opens the display picker. If
  // Firefox has hidden device labels, this may produce a one-time audio-device
  // permission prompt. Later shares reuse the remembered source automatically.
  const bridgedDisplayMedia = async (options = {}) => {
    const wantsAudio = Boolean(options?.audio);
    let source = null;

    if (wantsAudio) {
      source = await ssPrepareSourceForShare();
      if (!source) {
        ssToast('Firefox/Zen could not find a safe system-audio source. Screen video will still share; open Stream settings to choose a source.', 50, 5200);
      }
    }

    const stream = await wrappedDisplayMedia(options);
    if (!wantsAudio || !source) return stream;

    const videoTrack = stream.getVideoTracks()[0];
    const surface = videoTrack?.getSettings?.().displaySurface || 'unknown';

    // Preserve SimpleShare's privacy rule: a broad loopback source plus a full
    // monitor share is effectively whole-PC audio capture. Keep it disabled.
    if (surface === 'monitor') {
      ssSetStatus('Audio stays off for full-monitor sharing. Share an app window instead.', 'warn');
      ssToast('Firefox/Zen audio works with an app/window share. Full-monitor loopback audio stays blocked so other apps are not exposed.', 80, 5000);
      return stream;
    }

    const bridgeTrack = await ssCaptureBridgeTrack(source);
    if (!bridgeTrack) {
      ssToast('Screen video is live, but Firefox/Zen could not open the selected audio source. Use Change / Rescan in Stream settings.', 80, 5200);
      return stream;
    }

    stream.addTrack(bridgeTrack);
    ssBindEchoGuardLifetime(stream, bridgeTrack);
    const label = ssCleanLabel(bridgeTrack.label || source.label || 'system audio');
    ssSetStatus(`Live · ${label} · SimpleShare echo guard on`, 'ok');

    // Only announce the automatic choice once. Subsequent shares should feel
    // normal, not like a compatibility workflow.
    try {
      if (localStorage.getItem(FIRST_AUTO_TOAST_KEY) !== '1') {
        localStorage.setItem(FIRST_AUTO_TOAST_KEY, '1');
        ssToast(`Firefox/Zen audio connected automatically: ${label}`, 140, 3300);
      }
    } catch {}
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
      .ss-gecko-audio-control{min-width:210px;display:grid;gap:6px}
      .ss-gecko-audio-summary{display:flex;gap:7px;align-items:center;min-width:0}
      .ss-gecko-audio-status{display:block;flex:1;min-width:0;font-size:10px;line-height:1.35;color:var(--dim,#949ba4);overflow-wrap:anywhere}
      .ss-gecko-audio-status[data-tone="ok"]{color:var(--green,#23a55a)}
      .ss-gecko-audio-status[data-tone="warn"]{color:var(--yellow,#f0b232)}
      .ss-gecko-audio-status[data-tone="bad"]{color:#ff7b7f}
      .ss-gecko-audio-change,.ss-gecko-audio-scan{flex:0 0 auto;white-space:nowrap}
      .ss-gecko-audio-advanced{display:grid;gap:6px;padding-top:2px}
      .ss-gecko-audio-line{display:flex;gap:6px;align-items:center}
      .ss-gecko-audio-line select{min-width:0!important;flex:1;width:100%}
      .ss-gecko-audio-help{display:block;font-size:10px;line-height:1.35;color:var(--dim,#949ba4)}
      .ss-gecko-audio-discord{display:block;font-size:10px;line-height:1.35;color:var(--yellow,#f0b232)}
      .ss-gecko-audio-advanced.hidden{display:none!important}
      html.ss-gecko-echo-guard .ss-gecko-audio-status::before{content:'◉ ';}
      html[data-theme="terminal"] .ss-gecko-audio-status,
      html[data-theme="terminal"] .ss-gecko-audio-help,
      html[data-theme="terminal"] .ss-gecko-audio-discord{font-family:ui-monospace,SFMono-Regular,Consolas,monospace!important;text-shadow:0 0 8px rgba(83,255,123,.16)}
      html[data-theme="win98"] .ss-gecko-audio-line select,
      html[data-theme="win98"] .ss-gecko-audio-change,
      html[data-theme="win98"] .ss-gecko-audio-scan{border-radius:0!important}
      @media(max-width:560px){
        .ss-gecko-audio-control{width:100%;min-width:0}
        .ss-gecko-audio-line{align-items:stretch}
      }
    `;
    document.head.appendChild(style);
  }

  function ssSetAdvanced(open) {
    if (!ui?.advanced || !ui?.change) return;
    ui.advanced.classList.toggle('hidden', !open);
    ui.change.textContent = open ? 'Hide' : 'Change';
    ui.change.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  function ssRenderSourceState() {
    if (!ui) return;
    const source = configuredSource;
    if (!source) {
      ssSetStatus('Automatic detection ready.', 'warn');
      return;
    }
    const label = source.label || 'remembered audio source';
    ssSetStatus(`Automatic · ${label}`, ssIsLoopback(label) ? 'ok' : 'warn');
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
      oldNote.textContent = 'Firefox/Zen audio compatibility is automatic when a loopback/system-audio input is available.';
    }

    const row = document.createElement('div');
    row.className = 'settings-row ss-gecko-audio-row';
    row.innerHTML = `
      <label for="ssGeckoAudioSource">Firefox / Zen audio</label>
      <div class="ss-gecko-audio-control">
        <div class="ss-gecko-audio-summary">
          <small id="ssGeckoAudioStatus" class="ss-gecko-audio-status">Automatic detection ready.</small>
          <button id="ssGeckoAudioChange" class="compat-pfp-button ss-gecko-audio-change" type="button" aria-expanded="false">Change</button>
        </div>
        <div id="ssGeckoAudioAdvanced" class="ss-gecko-audio-advanced hidden">
          <div class="ss-gecko-audio-line">
            <select id="ssGeckoAudioSource" aria-label="Firefox or Zen audio bridge source"></select>
            <button id="ssGeckoAudioScan" class="compat-pfp-button ss-gecko-audio-scan" type="button">Rescan</button>
          </div>
          <small class="ss-gecko-audio-help">SimpleShare auto-detects Stereo Mix, CABLE Output, PipeWire/Pulse “Monitor of …”, BlackHole and similar loopback sources. It never silently falls back to your microphone.</small>
          <small class="ss-gecko-audio-discord">Echo guard automatically mutes SimpleShare's own received audio while you share. Discord is a separate app: if Discord plays through the same output being looped back, Firefox cannot remove only Discord. Route Discord to a different output device if you hear delayed voices.</small>
        </div>
      </div>`;
    switchRow.insertAdjacentElement('afterend', row);

    ui = {
      row,
      status: row.querySelector('#ssGeckoAudioStatus'),
      change: row.querySelector('#ssGeckoAudioChange'),
      advanced: row.querySelector('#ssGeckoAudioAdvanced'),
      select: row.querySelector('#ssGeckoAudioSource'),
      scan: row.querySelector('#ssGeckoAudioScan'),
    };

    ui.change.addEventListener('click', () => {
      const open = ui.advanced.classList.contains('hidden');
      ssSetAdvanced(open);
      if (open) ssRefreshSourceList({ unlockLabels: false }).catch(() => {});
    });

    ui.scan.addEventListener('click', async () => {
      ui.scan.disabled = true;
      ui.scan.textContent = 'Scanning…';
      permissionProbeAttempted = false;
      try {
        await ssRefreshSourceList({ unlockLabels: true });
      } finally {
        ui.scan.disabled = false;
        ui.scan.textContent = 'Rescan';
      }
    });

    ui.select.addEventListener('change', () => {
      const deviceId = ui.select.value;
      if (!deviceId) {
        // "Automatic" means forget the manual pin and re-run auto scoring.
        ssSaveSource(null);
        ssResolveAutomaticSource({ allowPermissionPrompt: false }).then(source => {
          if (source) ssRefreshSourceList({ unlockLabels: false }).catch(() => {});
        });
        return;
      }
      const option = ui.select.selectedOptions?.[0];
      ssSaveSource({ deviceId, label: ssCleanLabel(option?.dataset.label || option?.textContent || '') });
    });

    mediaDevices.addEventListener?.('devicechange', () => {
      ssRefreshSourceList({ unlockLabels: false }).catch(() => {});
    });

    ssRenderSourceState();
    // Background detection is silent: no permission prompt on page load.
    ssRefreshSourceList({ unlockLabels: false, keepAdvanced: true }).catch(() => {});
  }

  function ssRestoreRequestedAudioForRealScreenClicks() {
    const shareButton = document.getElementById('shareBtn');
    const withAudio = document.getElementById('withAudio');
    if (!shareButton || !withAudio) return;

    // compat.js temporarily clears this checkbox for Gecko because native
    // display audio is unsupported. Its capture listener runs first; restore
    // the user's preference immediately afterwards so app.js requests audio
    // from this bridge. Camera sharing uses a synthetic click and stays video-only.
    shareButton.addEventListener('click', event => {
      if (!event.isTrusted) return;
      withAudio.checked = wantedAudio;
    }, { capture: true });
  }

  function ssPlatformHint() {
    if (isWindows) return 'Windows: Stereo Mix is the simplest zero-install source when the audio driver exposes it.';
    if (isLinux) return 'Linux: PipeWire/Pulse “Monitor of …” sources are preferred automatically when Firefox exposes them.';
    return '';
  }

  ssInstallStyles();
  ssInstallSettingsUi();
  ssRestoreRequestedAudioForRealScreenClicks();

  const hint = ssPlatformHint();
  if (hint && ui?.advanced) {
    const small = document.createElement('small');
    small.className = 'ss-gecko-audio-help';
    small.textContent = hint;
    ui.advanced.appendChild(small);
  }
}
