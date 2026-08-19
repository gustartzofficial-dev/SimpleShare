import "webrtc-adapter";
import { PartyTracks, setLogLevel } from "partytracks/client";
import { ReplaySubject, BehaviorSubject, of } from "rxjs";

/*
  SimpleShare — one path, no modes, no fallbacks.

  Screen -> PartyTracks.push() -> metadata -> Durable Object -> other browser
  -> PartyTracks.pull() -> MediaStreamTrack -> <video>

  That is the whole application. Everything else here is UI or logging.
  There is deliberately no peer-to-peer path and no raw-SDP path: having
  three architectures live in one file is what made the old version
  impossible to debug.
*/

const QUALITY = {
  '720p30':  { label: '720p 30fps',  width: 1280, height: 720,  fps: 30, bitrate: 2_500_000 },
  '720p60':  { label: '720p 60fps',  width: 1280, height: 720,  fps: 60, bitrate: 4_000_000 },
  '1080p60': { label: '1080p 60fps', width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
};

const $ = (id) => document.getElementById(id);

const state = {
  apiBase: '',
  roomId: '',
  participantId: '',
  token: '',
  name: '',
  ws: null,
  heartbeat: null,
  reconnectAttempts: 0,
  pollTimer: null,
  tracks: null,        // PartyTracks instance
  leaving: false,
  share: null,         // active local share
  people: new Map(),   // participantId -> participant
  streams: new Map(),  // streamId -> announcement
  subs: new Map(),     // streamId -> { media, subs[], stall, target }
  joining: new Set(),  // streamIds currently being (re)subscribed
  watching: new Set(), // streamIds this viewer has actually opened
  tiles: new Map(),    // streamId -> { card, video, note }
};

/* ---------- logging: every step is visible, always ---------- */

function log(message, level = 'info') {
  const line = document.createElement('div');
  line.className = `log-line log-${level}`;
  line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
  const body = $('logBody');
  if (body) {
    body.appendChild(line);
    body.scrollTop = body.scrollHeight;
  }
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[SimpleShare] ${message}`);
}

function setStatus(text, tone = '') {
  const el = $('status');
  if (!el) return;
  el.textContent = text;
  el.className = `status ${tone}`;
}

function toast(message) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 4500);
}

/* ---------- helpers ---------- */

function randomId(bytes = 8) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function normalizeBase(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

async function apiCall(path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`${state.apiBase}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await response.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(data.error || `${path} failed (${response.status})`);
  return data;
}

const envelope = (extra = {}) => ({
  room: state.roomId,
  participantId: state.participantId,
  token: state.token,
  ...extra,
});

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ---------- room join + websocket ---------- */

const sessionKey = () => `simpleshare-session-${state.roomId}`;

function savedSession() {
  try {
    const raw = sessionStorage.getItem(sessionKey());
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return parsed?.participantId && parsed?.token ? parsed : null;
  } catch { return null; }
}

async function joinRoom() {
  // Send any identity this tab already holds. Without this every refresh minted
  // a new participant, leaving ghost members behind until their grace period
  // expired -- and ten ghosts made the room report itself full.
  const previous = savedSession();
  const result = await apiCall(`/api/rooms/${state.roomId}/join`, {
    method: 'POST',
    body: {
      name: state.name,
      mode: 'cloud',
      participantId: previous?.participantId,
      token: previous?.token,
    },
  });
  state.participantId = result.participantId;
  state.token = result.token;
  try {
    sessionStorage.setItem(sessionKey(), JSON.stringify({
      participantId: result.participantId,
      token: result.token,
    }));
  } catch {}
  state.people = new Map((result.snapshot?.participants || []).map(p => [p.id, p]));
  for (const s of result.snapshot?.streams || []) state.streams.set(s.id, s);
  log(result.resumed ? `rejoined room as ${state.name}` : `joined room as ${state.name}`);
  renderPeople();
}

function connectSocket() {
  return new Promise((resolve, reject) => {
    const base = state.apiBase.replace(/^http/i, 'ws');
    const url = `${base}/api/rooms/${state.roomId}/socket?id=${encodeURIComponent(state.participantId)}&token=${encodeURIComponent(state.token)}`;
    const ws = new WebSocket(url);
    state.ws = ws;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { ws.close(); } catch {}
      reject(new Error('Room socket timed out.'));
    }, 10000);

    ws.onopen = () => {
      clearTimeout(timer);
      state.reconnectAttempts = 0;
      log('room socket connected');
      reportWatching();
      setStatus('Connected', 'ok');
      $('shareBtn').disabled = false;
      clearInterval(state.heartbeat);
      state.heartbeat = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
      }, 20000);
      if (!settled) { settled = true; resolve(); }
    };

    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      handleMessage(msg).catch(err => log(`socket handler: ${err.message}`, 'error'));
    };

    ws.onclose = (e) => {
      if (state.leaving) return;
      // Close code and reason matter: 1006 is an abnormal close (network),
      // 1001 is the server going away, and a clean 1000 means we asked for it.
      log(`room socket closed (code ${e.code}${e.reason ? `, ${e.reason}` : ''})`, 'warn');
      setStatus('Reconnecting', 'warn');
      scheduleReconnect();
    };

    ws.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Room socket failed.'));
    };
  });
}

// Backoff, then give up and re-join cleanly rather than looping forever.
// The old build retried the same dead credentials every 2s indefinitely.
function scheduleReconnect() {
  if (state.leaving) return;
  state.reconnectAttempts = (state.reconnectAttempts || 0) + 1;

  if (state.reconnectAttempts > 6) {
    log('could not restore the room socket — rejoining from scratch', 'error');
    toast('Connection lost. Reloading the room…');
    setTimeout(() => location.reload(), 1200);
    return;
  }

  const delay = Math.min(1000 * state.reconnectAttempts, 6000);
  log(`reconnecting in ${Math.round(delay / 1000)}s (attempt ${state.reconnectAttempts}/6)`);
  setTimeout(() => {
    connectSocket().catch(err => {
      log(`reconnect failed: ${err.message}`, 'warn');
      scheduleReconnect();
    });
  }, delay);
}

async function handleMessage(msg) {
  if (msg.type === 'snapshot') {
    state.people = new Map((msg.participants || []).map(p => [p.id, p]));
    const incoming = new Map((msg.streams || []).map(s => [s.id, s]));
    for (const id of [...state.streams.keys()]) if (!incoming.has(id)) await dropStream(id);
    for (const s of incoming.values()) await addStream(s);
    renderPeople();
    return;
  }
  if (msg.type === 'participant-joined' || msg.type === 'participant-updated') {
    state.people.set(msg.participant.id, msg.participant);
    renderPeople();
    return;
  }
  if (msg.type === 'participant-left') {
    state.people.delete(msg.participantId);
    for (const id of msg.removedStreams || []) await dropStream(id);
    renderPeople();
    return;
  }
  if (msg.type === 'stream-upsert') { await addStream(msg.stream); return; }
  if (msg.type === 'stream-remove') { await dropStream(msg.streamId); return; }
}

/* ---------- PartyTracks ---------- */

function initTracks() {
  if (state.tracks) return state.tracks;
  state.tracks = new PartyTracks({
    prefix: `${state.apiBase}/partytracks`,
    headers: new Headers({
      'x-room': state.roomId,
      'x-participant-id': state.participantId,
      'x-participant-token': state.token,
    }),
  });
  // Hold a permanent subscription to session$. It is shareReplay({refCount:true}),
  // so without a standing subscriber the whole peer connection is torn down the
  // moment the last push/pull unsubscribes -- and the next one gets a brand new
  // sessionId, invalidating whatever we already announced to the room.
  state.tracks.session$.subscribe({
    next: ({ sessionId }) => {
      if (state.sessionId && state.sessionId !== sessionId) {
        log(`media session rebuilt (${state.sessionId.slice(0, 8)}… → ${sessionId.slice(0, 8)}…)`, 'warn');
        // Our own published metadata is now stale; republish it.
        if (state.share?.videoMeta) state.reannounce?.();
      }
      state.sessionId = sessionId;
    },
    error: (err) => log(`media session error: ${err?.message || err}`, 'error'),
  });

  state.tracks.peerConnectionState$.subscribe((s) => {
    log(`media connection: ${s}`, s === 'failed' ? 'error' : 'info');
    if (s === 'connected') setStatus(state.share ? 'Sharing' : 'Connected', 'ok');
    if (s === 'failed') {
      setStatus('Media failed', 'bad');
      toast('Media connection failed — usually a firewall or NAT problem.');
    }
  });
  log('media engine ready');
  return state.tracks;
}

/* ---------- sharing ---------- */

async function startShare() {
  if (state.share) return;
  const qualityId = $('quality').value;
  const q = QUALITY[qualityId] || QUALITY['720p30'];

  let media;
  try {
    log(`requesting screen at ${q.label}`);
    media = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width:     { ideal: q.width },
        height:    { ideal: q.height },
        frameRate: { ideal: q.fps },
      },
      audio: $('withAudio').checked,
    });
  } catch (err) {
    if (err?.name === 'NotAllowedError') log('screen picker cancelled');
    else {
      log(`screen capture failed: ${err.message}`, 'error');
      toast(err.message || 'Could not start sharing.');
    }
    return;
  }

  const videoTrack = media.getVideoTracks()[0];
  const audioTrack = media.getAudioTracks()[0] || null;
  if (!videoTrack) { toast('No video track was captured.'); return; }

  // THE SLIDESHOW FIX.
  // A screen-share track with no contentHint makes Chrome default to
  // degradationPreference "maintain-resolution": under any pressure it holds
  // full resolution and throws away framerate, which is exactly how you get a
  // crisp 4fps slideshow. "motion" flips it to maintain-framerate.
  const hint = $('contentHint').value;
  try {
    videoTrack.contentHint = hint;
    log(`content hint: ${hint} (${hint === 'motion' ? 'smooth framerate' : 'sharp detail'})`);
  } catch { log('content hint not supported by this browser', 'warn'); }

  const settings = videoTrack.getSettings();
  log(`captured screen ${settings.width || '?'}x${settings.height || '?'} @ ${Math.round(settings.frameRate || 0)}fps`);
  videoTrack.addEventListener('ended', () => {
    log('screen share ended by the browser');
    stopShare().catch(() => {});
  });

  const tracks = initTracks();
  const streamId = `${state.participantId}-${randomId(3)}`;
  const share = { streamId, media, subs: [], videoMeta: null, audioMeta: null, profile: qualityId };
  state.share = share;

  $('shareBtn').classList.add('hidden');
  $('stopBtn').classList.remove('hidden');
  $('quality').disabled = true;
  $('withAudio').disabled = true;
  $('contentHint').disabled = true;
  setStatus('Publishing', 'warn');

  showTile({
    id: streamId,
    ownerId: state.participantId,
    ownerName: `${state.name} (you)`,
    profile: qualityId,
  }, media, true);

  const announce = async () => {
    if (!share.videoMeta?.trackName || !share.videoMeta?.sessionId) return;
    const stream = {
      id: streamId,
      sessionId: share.videoMeta.sessionId,
      videoTrackName: share.videoMeta.trackName,
      audioTrackName: share.audioMeta?.trackName || null,
      profile: qualityId,
      audio: Boolean(share.audioMeta),
    };
    await apiCall(`/api/rooms/${state.roomId}/stream/upsert`, {
      method: 'POST',
      body: envelope({ stream }),
    });
    log(`announced to room (session ${stream.sessionId.slice(0, 8)}…)`);
    setStatus('Sharing', 'ok');
  };

  // Encodings are back. Without an explicit maxBitrate the browser caps screen
  // share far below what these profiles need, which starves the picture even
  // when the network is fine. Still a single layer -- no simulcast.
  const encodings$ = new BehaviorSubject([{
    maxBitrate: q.bitrate,
    maxFramerate: q.fps,
  }]);
  share.encodings$ = encodings$;
  log(`bitrate ceiling: ${Math.round(q.bitrate / 100000) / 10} Mbps`);

  const videoSource$ = new ReplaySubject(1);
  log('publishing video track…');
  state.reannounce = () => announce().catch(err => log(`re-announce failed: ${err.message}`, 'error'));

  share.subs.push(tracks.push(videoSource$, { sendEncodings$: encodings$ }).subscribe({
    next: (meta) => {
      log(`video published (track ${meta.trackName})`);
      share.videoMeta = meta;
      announce().catch(err => log(`announce failed: ${err.message}`, 'error'));
    },
    error: (err) => {
      log(`video publish failed: ${err?.message || err}`, 'error');
      toast(`Publish failed: ${err?.message || err}`);
    },
  }));

  let audioSource$ = null;
  if (audioTrack) {
    audioSource$ = new ReplaySubject(1);
    share.subs.push(tracks.push(audioSource$).subscribe({
      next: (meta) => {
        log(`audio published (track ${meta.trackName})`);
        share.audioMeta = meta;
        announce().catch(() => {});
      },
      error: (err) => log(`audio publish failed: ${err?.message || err}`, 'warn'),
    }));
  }

  videoSource$.next(videoTrack);
  if (audioSource$ && audioTrack) audioSource$.next(audioTrack);

  setTimeout(() => {
    if (state.share === share && !share.videoMeta) {
      log('no publish confirmation after 15s — the track never reached the SFU', 'error');
      toast('Publishing stalled. Open the log panel for details.');
    }
  }, 15000);
}

async function stopShare() {
  const share = state.share;
  if (!share) return;
  state.share = null;
  state.reannounce = null;

  for (const sub of share.subs) { try { sub.unsubscribe(); } catch {} }
  try { share.encodings$?.complete(); } catch {}
  share.media.getTracks().forEach(t => { try { t.stop(); } catch {} });
  removeTile(share.streamId);

  $('shareBtn').classList.remove('hidden');
  $('stopBtn').classList.add('hidden');
  $('quality').disabled = false;
  $('withAudio').disabled = false;
  $('contentHint').disabled = false;
  setStatus('Connected', 'ok');

  try {
    await apiCall(`/api/rooms/${state.roomId}/stream/remove`, {
      method: 'POST',
      body: envelope({ streamId: share.streamId }),
    });
  } catch (err) {
    log(`stop announce failed: ${err.message}`, 'warn');
  }
  log('stopped sharing');
}

/* ---------- watching ---------- */

const sameTarget = (a, b) => a && b &&
  a.sessionId === b.sessionId &&
  a.videoTrackName === b.videoTrackName &&
  a.audioTrackName === b.audioTrackName;

async function addStream(ann) {
  // Guard against poll() and the websocket handler racing on the same stream.
  if (state.joining.has(ann.id)) return;
  state.joining.add(ann.id);
  try {
    await addStreamInner(ann);
  } finally {
    state.joining.delete(ann.id);
  }
}

async function addStreamInner(ann) {
  state.streams.set(ann.id, ann);
  if (ann.ownerId === state.participantId) { renderPeople(); return; }

  const ready = Boolean(ann.sessionId && ann.videoTrackName);
  const existing = state.subs.get(ann.id);

  // Not watching this one: show a Discord-style placeholder and pull nothing.
  // No subscription means no SFU egress, so an unwatched stream is free.
  if (!state.watching.has(ann.id)) {
    if (existing) await teardownSubscription(ann.id);
    showIdleTile(ann, ready);
    renderPeople();
    return;
  }

  if (existing) {
    // PartyTracks issues a new sessionId whenever it rebuilds its peer
    // connection. If the announcement no longer matches what we subscribed to,
    // the old subscription is pulling a session that no longer exists.
    if (sameTarget(existing.target, ann)) { renderPeople(); return; }
    log(`${ann.ownerName} reconnected with a new session — resubscribing`, 'warn');
    await teardownSubscription(ann.id);
  }

  if (!ready) {
    showIdleTile(ann, false);
    renderPeople();
    return;
  }

  await subscribe(ann);
  renderPeople();
}

async function subscribe(ann) {
  log(`watching ${ann.ownerName}`);
  const tracks = initTracks();
  const media = new MediaStream();
  const entry = {
    media,
    subs: [],
    stall: null,
    target: { sessionId: ann.sessionId, videoTrackName: ann.videoTrackName, audioTrackName: ann.audioTrackName },
  };
  state.subs.set(ann.id, entry);

  const tile = showLiveTile(ann, media);
  tile.note.textContent = 'Connecting…';
  tile.note.classList.remove('hidden');

  entry.stall = setTimeout(() => {
    if (media.getVideoTracks().length) return;
    log(`no video from ${ann.ownerName} after 15s — media is not reaching this browser`, 'error');
    tile.note.textContent = 'No video after 15s — likely a firewall or NAT issue.';
  }, 15000);

  entry.subs.push(tracks.pull(of({
    trackName: ann.videoTrackName,
    sessionId: ann.sessionId,
    location: 'remote',
  })).subscribe({
    next: (track) => {
      clearTimeout(entry.stall);
      for (const old of media.getVideoTracks()) media.removeTrack(old);
      media.addTrack(track);
      tile.video.srcObject = media;
      tile.video.play().catch(() => {});
      tile.note.classList.add('hidden');
      log(`receiving video from ${ann.ownerName}`);
    },
    error: (err) => {
      clearTimeout(entry.stall);
      log(`pull failed for ${ann.ownerName}: ${err?.message || err}`, 'error');
      tile.note.textContent = `Failed: ${err?.message || err}`;
      tile.note.classList.remove('hidden');
    },
  }));

  if (ann.audioTrackName) {
    entry.subs.push(tracks.pull(of({
      trackName: ann.audioTrackName,
      sessionId: ann.sessionId,
      location: 'remote',
    })).subscribe({
      next: (track) => {
        for (const old of media.getAudioTracks()) media.removeTrack(old);
        media.addTrack(track);
        tile.video.srcObject = media;
        $('unmuteBtn').classList.remove('hidden');
      },
      error: (err) => log(`audio pull failed: ${err?.message || err}`, 'warn'),
    }));
  }
}

async function teardownSubscription(streamId) {
  const entry = state.subs.get(streamId);
  if (!entry) return;
  clearTimeout(entry.stall);
  for (const sub of entry.subs) { try { sub.unsubscribe(); } catch {} }
  state.subs.delete(streamId);
  removeTile(streamId);
}

/* ---------- opt-in watching ---------- */

function reportWatching() {
  if (state.ws?.readyState !== WebSocket.OPEN) return;
  state.ws.send(JSON.stringify({ type: 'watching', streamIds: [...state.watching] }));
}

async function watchStream(streamId) {
  const ann = state.streams.get(streamId);
  if (!ann || state.watching.has(streamId)) return;
  if (state.budgetBlocked) { toast('Bandwidth cap reached — cannot open new streams.'); return; }
  state.watching.add(streamId);
  reportWatching();
  await addStream(ann);
}

async function unwatchStream(streamId) {
  if (!state.watching.has(streamId)) return;
  const ann = state.streams.get(streamId);
  state.watching.delete(streamId);
  reportWatching();
  await teardownSubscription(streamId);
  if (ann) { showIdleTile(ann, Boolean(ann.sessionId && ann.videoTrackName)); renderPeople(); }
  log(`stopped watching ${ann?.ownerName || streamId}`);
}

async function dropStream(streamId, { silent = false } = {}) {
  const ann = state.streams.get(streamId);
  state.streams.delete(streamId);
  if (state.watching.delete(streamId)) reportWatching();
  await teardownSubscription(streamId);
  removeTile(streamId);
  if (!silent && ann && ann.ownerId !== state.participantId) log(`${ann.ownerName} stopped sharing`);
  renderPeople();
}

/* ---------- tiles ---------- */

function ensureTile(ann, isLocal) {
  let entry = state.tiles.get(ann.id);
  if (entry) return entry;

  const card = document.createElement('div');
  card.className = `tile${isLocal ? ' local' : ''}`;
  card.innerHTML = `
    <video autoplay playsinline muted></video>
    <div class="tile-idle hidden">
      <div class="idle-avatar"></div>
      <div class="idle-name"></div>
      <div class="idle-sub"></div>
      <button class="primary idle-watch">Watch stream</button>
    </div>
    <div class="tile-note hidden"></div>
    <div class="tile-bar">
      <span class="tile-name"></span>
      <span class="tile-actions">
        <span class="tile-meta"></span>
        <button class="tile-stop ghost hidden">Close</button>
      </span>
    </div>`;

  entry = {
    card,
    video: card.querySelector('video'),
    note: card.querySelector('.tile-note'),
    idle: card.querySelector('.tile-idle'),
    statsTimer: null,
    lastFrameAt: 0,
  };

  card.querySelector('.idle-watch').addEventListener('click', (e) => {
    e.stopPropagation();
    watchStream(ann.id).catch(err => log(err.message, 'error'));
  });
  card.querySelector('.tile-stop').addEventListener('click', (e) => {
    e.stopPropagation();
    unwatchStream(ann.id).catch(err => log(err.message, 'error'));
  });
  card.addEventListener('click', () => {
    if (!entry.card.classList.contains('idle')) entry.card.classList.toggle('big');
  });

  $('grid').appendChild(card);
  state.tiles.set(ann.id, entry);
  renderGrid();
  return entry;
}

// Discord-style placeholder: we know someone is live, but nothing is pulled
// until the viewer asks for it. An unwatched stream costs nothing.
function showIdleTile(ann, ready) {
  const entry = ensureTile(ann, false);
  clearInterval(entry.statsTimer);
  entry.statsTimer = null;
  entry.video.srcObject = null;
  entry.card.classList.add('idle');
  entry.card.classList.remove('big');
  entry.note.classList.add('hidden');
  entry.idle.classList.remove('hidden');
  entry.card.querySelector('.tile-stop').classList.add('hidden');

  const name = ann.ownerName || 'Someone';
  entry.idle.querySelector('.idle-avatar').textContent = name.slice(0, 1).toUpperCase();
  entry.idle.querySelector('.idle-name').textContent = name;
  entry.idle.querySelector('.idle-sub').textContent = ready
    ? (QUALITY[ann.profile] || QUALITY['720p30']).label
    : 'Starting…';
  const btn = entry.idle.querySelector('.idle-watch');
  btn.disabled = !ready || state.budgetBlocked;
  btn.textContent = ready ? 'Watch stream' : 'Starting…';

  entry.card.querySelector('.tile-name').textContent = `${name} is live`;
  entry.card.querySelector('.tile-meta').textContent = '';
  return entry;
}

function showLiveTile(ann, media) {
  const entry = ensureTile(ann, false);
  entry.card.classList.remove('idle');
  entry.idle.classList.add('hidden');
  entry.card.querySelector('.tile-stop').classList.remove('hidden');
  entry.video.srcObject = media;
  entry.video.play().catch(() => {});
  entry.card.querySelector('.tile-name').textContent = ann.ownerName || 'Someone';
  entry.lastFrameAt = 0;
  clearInterval(entry.statsTimer);
  startTileStats(entry, ann);
  return entry;
}

// The local preview is always shown -- it never touches the SFU.
function showTile(ann, media, isLocal) {
  const entry = ensureTile(ann, isLocal);
  entry.card.classList.remove('idle');
  entry.idle.classList.add('hidden');
  entry.video.srcObject = media;
  entry.video.play().catch(() => {});
  entry.card.querySelector('.tile-name').textContent = ann.ownerName || 'Someone';
  clearInterval(entry.statsTimer);
  startTileStats(entry, ann);
  return entry;
}

function startTileStats(entry, ann) {
  const meta = entry.card.querySelector('.tile-meta');
  const fallback = (QUALITY[ann.profile] || QUALITY['720p30']).label;
  let frames = 0;
  let last = performance.now();

  const onFrame = () => {
    if (!state.tiles.has(ann.id)) return;
    frames += 1;
    entry.lastFrameAt = Date.now();
    entry.video.requestVideoFrameCallback?.(onFrame);
  };
  entry.video.requestVideoFrameCallback?.(onFrame);

  entry.statsTimer = setInterval(() => {
    if (!state.tiles.has(ann.id)) { clearInterval(entry.statsTimer); return; }
    const now = performance.now();
    const fps = Math.round((frames * 1000) / Math.max(1, now - last));
    frames = 0;
    last = now;
    const w = entry.video.videoWidth;
    const h = entry.video.videoHeight;
    meta.textContent = w ? `${w}x${h} - ${fps} fps` : fallback;
    if (fps > 0) entry.lastFrameAt = Date.now();
  }, 2000);
}

function removeTile(streamId) {
  const tile = state.tiles.get(streamId);
  if (!tile) return;
  clearInterval(tile.statsTimer);
  try { tile.video.srcObject = null; } catch {}
  tile.card.remove();
  state.tiles.delete(streamId);
  renderGrid();
}

function renderGrid() {
  const count = state.tiles.size;
  $('empty').classList.toggle('hidden', count > 0);
  $('grid').classList.toggle('hidden', count === 0);
  // One stream fills the stage; two sit side by side; more go to a grid.
  // Fixed min-widths made a single share render as a small lonely box.
  const grid = $('grid');
  grid.classList.remove('count-1', 'count-2', 'count-many');
  grid.classList.add(count === 1 ? 'count-1' : count === 2 ? 'count-2' : 'count-many');
}

function renderPeople() {
  const owners = new Set([...state.streams.values()].map(s => s.ownerId));
  $('peopleCount').textContent = String(state.people.size);
  const list = $('people');
  list.innerHTML = '';
  for (const p of state.people.values()) {
    const row = document.createElement('div');
    row.className = 'person';
    const you = p.id === state.participantId ? ' (you)' : '';
    row.innerHTML = `<span class="dot${owners.has(p.id) ? ' live' : ''}"></span><span>${escapeHtml(p.name)}${you}</span>`;
    list.appendChild(row);
  }
}

/* ---------- watchdog ----------
   Last line of defence. If a tile is subscribed and the stream is still
   announced, but no frames have arrived for 12s, the subscription is dead --
   almost always a session that was rebuilt underneath us. Tear it down and
   resubscribe rather than showing a frozen picture forever. */

async function watchdog() {
  if (state.leaving || state.budgetBlocked) return;
  for (const [streamId, entry] of [...state.subs]) {
    if (!state.watching.has(streamId)) continue;
    const ann = state.streams.get(streamId);
    const tile = state.tiles.get(streamId);
    if (!ann || !tile) continue;
    if (!entry.target?.sessionId) continue;

    const alive = tile.lastFrameAt && (Date.now() - tile.lastFrameAt < 12_000);
    if (alive) { entry.strikes = 0; continue; }
    if (!tile.lastFrameAt) continue;          // never started; the 15s stall timer owns this case

    entry.strikes = (entry.strikes || 0) + 1;
    if (entry.strikes < 2) continue;          // two consecutive checks, ~16s of silence
    entry.strikes = 0;
    log(`no frames from ${ann.ownerName} for 12s — rebuilding the subscription`, 'warn');
    await dropStream(streamId, { silent: true });
    await addStream(ann);
  }
}

/* ---------- bandwidth meter ----------
   Cloudflare Realtime charges $0.05/GB of EGRESS with a 1,000 GB/month free
   tier shared between SFU and TURN. Only Cloudflare -> client traffic counts;
   pushing to Cloudflare is free. So the bill is:
       sum over every live stream of (its bitrate x number of viewers)
   These are ceilings, so real usage runs lower -- but the ceiling is what can
   ruin your month, and it was invisible until now. */

function estimateEgress() {
  // Only streams someone actually has open cost anything. This browser can
  // only see its own watch list, so it reports its own share of the bill.
  let bitsPerSecond = 0;
  for (const streamId of state.watching) {
    const stream = state.streams.get(streamId);
    if (!stream) continue;
    bitsPerSecond += (QUALITY[stream.profile] || QUALITY['720p30']).bitrate;
  }
  return bitsPerSecond;
}

// The authoritative number comes from the server, which meters every room.
// The local rate is only shown alongside it as a "how fast are we burning it".
async function tickBudget() {
  const bps = estimateEgress();
  const gbPerHour = (bps / 8) * 3600 / 1e9;

  let budget = state.budget;
  try {
    budget = await apiCall('/api/budget');
    state.budget = budget;
  } catch { /* keep last known */ }

  const el = $('budget');
  if (!budget) { el.textContent = 'idle'; el.className = 'budget'; return; }

  const pct = budget.percent ?? 0;
  const rate = bps > 0 ? ` · ${gbPerHour.toFixed(1)} GB/h` : '';
  el.textContent = `${budget.usedGb.toFixed(1)} / ${budget.capGb} GB${rate}`;
  el.className = `budget ${budget.blocked || pct >= 95 ? 'bad' : pct >= 75 ? 'warn' : ''}`;
  el.title = budget.blocked
    ? `Cap reached for the trailing ${budget.windowDays}-day window. Capacity returns gradually as older usage ages out.`
    : `${budget.remainingGb.toFixed(1)} GB left in the trailing ${budget.windowDays}-day window (since ${budget.windowStart}). Cloudflare bills on your account's billing cycle, not the calendar month, so this tracks a rolling window instead.`;

  applyBudgetBlock(Boolean(budget.blocked), budget);
}

function applyBudgetBlock(blocked, budget) {
  if (blocked === state.budgetBlocked) return;
  state.budgetBlocked = blocked;
  $('shareBtn').disabled = blocked || !state.participantId;
  $('budgetBanner').classList.toggle('hidden', !blocked);
  if (blocked) {
    $('budgetBanner').textContent =
      `Bandwidth cap reached: ${budget.usedGb.toFixed(1)} of ${budget.capGb} GB used in the last ${budget.windowDays} days. Sharing is paused so your Cloudflare account is never billed. Capacity returns gradually each day as older usage ages out of the window.`;
    log(`cap reached: ${budget.usedGb.toFixed(1)}/${budget.capGb} GB over ${budget.windowDays} days — sharing paused`, 'error');
    if (state.share) stopShare().catch(() => {});
  } else {
    log('bandwidth cap cleared — sharing available again');
  }
  for (const [streamId, tile] of state.tiles) {
    if (!tile.card.classList.contains('idle')) continue;
    const ann = state.streams.get(streamId);
    const btn = tile.idle?.querySelector('.idle-watch');
    if (btn) btn.disabled = blocked || !(ann?.sessionId && ann?.videoTrackName);
  }
}

/* ---------- safety net: websockets can miss, polling won't ---------- */

async function poll() {
  if (state.leaving || !state.participantId) return;
  try {
    const snap = await apiCall(`/api/rooms/${state.roomId}/snapshot`);
    state.people = new Map((snap.participants || []).map(p => [p.id, p]));
    const incoming = new Map((snap.streams || []).map(s => [s.id, s]));
    for (const id of [...state.streams.keys()]) if (!incoming.has(id)) await dropStream(id);
    for (const s of incoming.values()) {
      // Compare against the live subscription's target, not state.streams --
      // state.streams gets overwritten with new metadata before we act on it,
      // which is what silently disabled this safety net.
      const sub = state.subs.get(s.id);
      const subscribedCorrectly = s.ownerId === state.participantId || (sub && sameTarget(sub.target, s));
      if (!subscribedCorrectly) await addStream(s);
    }
    renderPeople();
  } catch { /* transient, poll again in 3s */ }
}

/* ---------- boot ---------- */

async function boot() {
  const params = new URLSearchParams(location.search);
  if (params.get('debug') === '1') {
    setLogLevel('debug');
    $('logPanel').classList.add('open');
  }

  const config = await fetch('/api/config').then(r => r.json()).catch(() => ({ roomApiUrl: '' }));
  state.apiBase = normalizeBase(config.roomApiUrl);

  const roomId = params.get('room');
  if (!roomId) { $('home').classList.remove('hidden'); return; }
  if (!state.apiBase) {
    $('home').classList.remove('hidden');
    toast('ROOM_API_URL is not set in Vercel.');
    return;
  }

  state.roomId = roomId;
  state.name = localStorage.getItem('simpleshare-name') || `Guest ${randomId(1).toUpperCase()}`;
  $('room').classList.remove('hidden');
  $('inviteLink').value = location.href;
  try { applySidebar(localStorage.getItem('simpleshare-hide-members') === '1'); } catch {}
  $('myName').value = state.name;
  setStatus('Connecting', 'warn');
  log(`room ${roomId}`);

  try {
    const health = await apiCall('/health');
    log(`backend ok (build ${health.build})`);
    if (!health.realtimeConfigured) throw new Error('Worker is missing the Cloudflare Realtime credentials.');
  } catch (err) {
    log(`backend check failed: ${err.message}`, 'error');
    setStatus('Backend down', 'bad');
    $('logPanel').classList.add('open');
    return;
  }

  try {
    await joinRoom();
    await connectSocket();
    initTracks();
    renderPeople();
    renderGrid();
    state.pollTimer = setInterval(poll, 3000);
    state.watchdogTimer = setInterval(() => watchdog().catch(() => {}), 8000);
    state.budgetTimer = setInterval(() => tickBudget().catch(() => {}), 15000);
    tickBudget().catch(() => {});
  } catch (err) {
    log(`could not join: ${err.message}`, 'error');
    setStatus('Join failed', 'bad');
    $('logPanel').classList.add('open');
  }
}

/* ---------- wiring ---------- */

$('createBtn')?.addEventListener('click', () => {
  const url = new URL(location.href);
  url.search = '';
  url.searchParams.set('room', randomId(12));
  location.href = url.toString();
});

$('quality')?.addEventListener('change', () => {
  const q = QUALITY[$('quality').value];
  const viewers = Math.max(1, state.people.size - 1);
  const gbPerHour = (q.bitrate / 8) * 3600 / 1e9 * viewers;
  log(`${q.label} with ${viewers} viewer${viewers === 1 ? '' : 's'} ≈ ${gbPerHour.toFixed(1)} GB/h of Cloudflare egress`);
  if (gbPerHour > 10) toast(`Heads up: ~${gbPerHour.toFixed(0)} GB/h. The free tier is 1,000 GB/month.`);
});

$('shareBtn')?.addEventListener('click', () => startShare());
$('stopBtn')?.addEventListener('click', () => stopShare());

$('copyBtn')?.addEventListener('click', async () => {
  await navigator.clipboard.writeText($('inviteLink').value).catch(() => {});
  toast('Invite link copied');
});

$('myName')?.addEventListener('change', (e) => {
  const next = String(e.target.value || '').trim().slice(0, 28);
  if (!next) return;
  state.name = next;
  localStorage.setItem('simpleshare-name', next);
  if (state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'rename', name: next }));
  }
});

$('unmuteBtn')?.addEventListener('click', () => {
  for (const [id, tile] of state.tiles) {
    if (state.subs.has(id)) { tile.video.muted = false; tile.video.play().catch(() => {}); }
  }
  $('unmuteBtn').classList.add('hidden');
});

$('logToggle')?.addEventListener('click', () => $('logPanel').classList.toggle('open'));

function applySidebar(hidden) {
  $('room').classList.toggle('no-members', hidden);
  $('membersBtn').textContent = hidden ? 'Show members' : 'Hide members';
  try { localStorage.setItem('simpleshare-hide-members', hidden ? '1' : '0'); } catch {}
}

$('membersBtn')?.addEventListener('click', () => {
  applySidebar(!$('room').classList.contains('no-members'));
});

$('leaveBtn')?.addEventListener('click', async () => {
  state.leaving = true;
  await stopShare().catch(() => {});
  try { state.ws?.close(); } catch {}
  location.href = '/';
});

window.addEventListener('beforeunload', () => {
  state.leaving = true;
  try { state.ws?.close(); } catch {}
});

boot();
