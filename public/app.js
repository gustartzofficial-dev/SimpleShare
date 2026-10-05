import { setPlaybackVolume, resumePlayback, releasePlayback } from './lib/audio-volume.js';
import { createDirectTransport } from './lib/direct.js';
import 'webrtc-adapter';
import { PartyTracks, setLogLevel } from 'partytracks/client';
import { ReplaySubject, BehaviorSubject, of } from 'rxjs';

import { storage, parseRoomInvite, canonicalInvite, ROOM_RE } from './lib/room.js';
import {
  playSound,
  quietSounds,
  unlockSounds,
  setSoundsEnabled,
  soundsEnabled,
} from './lib/sounds.js';
import { icon, setupAppearance } from './lib/ui.js';
const $ = (id) => document.getElementById(id);
const openLog = () => setLogVisible(true);
let capturePending = false;
let booting = false;
function setLogVisible(on) {
  $('logPanel').hidden = !on;
  $('logBtn').setAttribute('aria-expanded', String(on));
  if (on) $('logClose').focus();
}

const QUALITY = {
  '720p30': { label: '720p 30fps', width: 1280, height: 720, fps: 30, bitrate: 2_500_000 },
  '720p60': { label: '720p 60fps', width: 1280, height: 720, fps: 60, bitrate: 4_000_000 },
  '1080p60': { label: '1080p 60fps', width: 1920, height: 1080, fps: 60, bitrate: 8_000_000 },
};

const state = {
  focusedId: null,
  tilePage: 0,
  apiBase: '',
  roomId: '',
  participantId: '',
  token: '',
  name: '',
  ws: null,
  socketSeq: 0,
  heartbeat: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  pollTimer: null,
  watchdogTimer: null,
  budgetTimer: null,
  tracks: null,
  tracksSessionSub: null,
  pcStateSub: null,
  leaving: false,
  demo: false,
  share: null,
  reannounce: null,
  sessionId: '',
  people: new Map(),
  streams: new Map(),
  subs: new Map(),
  joining: new Set(),
  watching: new Set(),
  tiles: new Map(),
  subAttempts: new Map(),
  budget: null,
  budgetBlocked: false,
  audioUnlocked: false,
  audioMuted: false,
  volume: 0.8,
  pollInFlight: false,
  peopleRenderKey: '',
  lastSnapshotAt: 0,
  appliedRev: 0,
  lastInboundAt: 0,
  livenessTimer: null,
  pcRecoverTimer: null,
  pcFailures: 0,
  resettingTracks: false,
  hiddenTicks: 0,
  probeTimer: null,
  hiddenAt: 0,
};

function log(message, level = 'info') {
  const body = $('logBody');
  if (body) {
    const line = document.createElement('div');
    line.className = `log-line log-${level}`;
    line.textContent = `${new Date().toLocaleTimeString()}  ${message}`;
    body.appendChild(line);
    while (body.children.length > 200) body.firstElementChild.remove();
    body.scrollTop = body.scrollHeight;
  }
  const fn = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
  fn(`[SimpleShare] ${message}`);
}
function toast(message) {
  const el = $('toast');
  if (!el) return;
  el.textContent = message;
  el.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('show'), 4500);
}
function setStatus(text, tone = '') {
  const el = $('status');
  if (el) {
    el.textContent = text;
    el.className = `status ${tone}`;
  }
}
function randomId(bytes = 8) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
}
function normalizeBase(value) {
  const raw = String(value || '')
    .trim()
    .replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error();
    return url.origin + url.pathname.replace(/\/+$/, '');
  } catch {
    return '';
  }
}
function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
async function apiCall(path, { method = 'GET', body = null } = {}) {
  const response = await fetch(`${state.apiBase}${path}`, {
    method,
    headers: {
      ...(body ? { 'content-type': 'application/json' } : {}),
      ...(state.participantId && !P2P.active
        ? { 'x-participant-id': state.participantId, 'x-participant-token': state.token }
        : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(12000),
  });
  const text = await response.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { raw: text };
  }
  if (!response.ok) {
    const err = new Error(data.error || `${path} failed (${response.status})`);
    err.code = data.code || null;
    err.status = response.status;
    err.fallback = data.fallback || null;
    throw err;
  }
  return data;
}
const envelope = (extra = {}) => ({
  room: state.roomId,
  participantId: state.participantId,
  token: state.token,
  ...extra,
});
const sessionKey = () => `simpleshare-session-${state.roomId}`;
function savedSession() {
  try {
    const p = JSON.parse(sessionStorage.getItem(sessionKey()) || 'null');
    return p?.participantId && p?.token ? p : null;
  } catch {
    return null;
  }
}
function streamName(ann) {
  return state.people.get(ann?.ownerId)?.name || ann?.ownerName || 'Someone';
}
function activePeople() {
  return [...state.people.values()].filter((p) => !p.disconnectedAt);
}
function scheduleImmediateSync(reason = 'event') {
  clearTimeout(scheduleImmediateSync._t);
  scheduleImmediateSync._t = setTimeout(
    () => syncSnapshot(reason).catch((err) => log(`snapshot sync: ${err.message}`, 'warn')),
    80,
  );
}
async function joinRoom() {
  sfxQuiet(1800);
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
  const changed = Boolean(state.participantId) && state.participantId !== result.participantId;
  state.participantId = result.participantId;
  state.token = result.token;
  try {
    sessionStorage.setItem(
      sessionKey(),
      JSON.stringify({ participantId: state.participantId, token: state.token }),
    );
  } catch {}
  if (changed) {
    state.appliedRev = 0;
    state.people = new Map((result.snapshot?.participants || []).map((p) => [p.id, p]));
  } else {
    await reconcileSnapshot(result.snapshot || {}, result.resumed ? 'rejoin' : 'join');
  }
  log(result.resumed ? `rejoined room as ${state.name}` : `joined room as ${state.name}`);
  renderPeople();
  await purgeOrphanedOwnStreams();
  return changed;
}
async function purgeOrphanedOwnStreams() {
  if (!state.participantId) return;
  const mine = state.share?.streamId || null;
  for (const [id, ann] of [...state.streams]) {
    if (ann.ownerId !== state.participantId || id === mine) continue;
    log(`clearing a stale stream left over from a previous session (${id})`, 'warn');
    try {
      await apiCall(`/api/rooms/${state.roomId}/stream/remove`, {
        method: 'POST',
        body: envelope({ streamId: id }),
      });
    } catch (err) {
      log(`could not clear ${id}: ${err.message}`, 'warn');
    }
    await dropStream(id, { silent: true });
  }
}

function reportWatching() {
  if (state.ws?.readyState === WebSocket.OPEN)
    state.ws.send(JSON.stringify({ type: 'watching', streamIds: [...state.watching] }));
}
function clearSocketTimers() {
  clearInterval(state.heartbeat);
  state.heartbeat = null;
  clearInterval(state.livenessTimer);
  state.livenessTimer = null;
  clearTimeout(state.reconnectTimer);
  state.reconnectTimer = null;
  clearTimeout(state.probeTimer);
  state.probeTimer = null;
}
function probeSocket(reason = 'wake') {
  if (P2P.active) {
    if (!P2P.mq) p2pBrokerLost();
    else p2pHello().catch(() => {});
    return;
  }
  if (state.leaving || !state.participantId || !state.apiBase) return;
  const ws = state.ws;
  if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
    if (state.reconnectTimer) return;
    state.reconnectAttempts = 0;
    log(`socket is not open after ${reason} — reconnecting now`, 'warn');
    recoverConnection().catch((err) => {
      log(`reconnect failed: ${err.message}`, 'warn');
      scheduleReconnect();
    });
    return;
  }
  if (ws.readyState !== WebSocket.OPEN) return;
  state.lastInboundAt = Date.now();
  try {
    ws.send(JSON.stringify({ type: 'ping' }));
  } catch {
    try {
      ws.close(4000, 'send-failed');
    } catch {}
    return;
  }
  clearTimeout(state.probeTimer);
  state.probeTimer = setTimeout(() => {
    if (state.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - state.lastInboundAt < 6000) return;
    log(`no reply to the ${reason} ping — cycling the socket`, 'warn');
    try {
      ws.close(4000, 'stale-after-wake');
    } catch {}
  }, 7000);
}
function grantWatchdogGrace() {
  const now = Date.now();
  for (const tile of state.tiles.values()) if (tile.lastFrameAt) tile.lastFrameAt = now;
  for (const entry of state.subs.values()) entry.subscribedAt = now;
}
function connectSocket() {
  const seq = ++state.socketSeq;
  return new Promise((resolve, reject) => {
    const base = state.apiBase.replace(/^http/i, 'ws');
    const url = `${base}/api/rooms/${state.roomId}/socket?id=${encodeURIComponent(state.participantId)}&token=${encodeURIComponent(state.token)}`;
    const ws = new WebSocket(url);
    state.ws = ws;
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled && state.ws === ws) {
        settled = true;
        try {
          ws.close();
        } catch {}
        reject(new Error('Room socket timed out.'));
      }
    }, 10000);
    ws.onopen = () => {
      if (state.ws !== ws || seq !== state.socketSeq) {
        try {
          ws.close();
        } catch {}
        return;
      }
      clearTimeout(timer);
      settled = true;
      state.reconnectAttempts = 0;
      clearInterval(state.heartbeat);
      clearInterval(state.livenessTimer);
      state.lastInboundAt = Date.now();
      state.heartbeat = setInterval(() => {
        if (state.ws === ws && ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ type: 'ping' }));
      }, 15000);
      state.livenessTimer = setInterval(() => {
        if (state.ws !== ws || ws.readyState !== WebSocket.OPEN) return;
        if (Date.now() - state.lastInboundAt <= 50000) return;
        log('socket went silent for 50s — forcing a reconnect', 'warn');
        try {
          ws.close(4000, 'stale');
        } catch {}
      }, 5000);
      log('room socket connected');
      reportWatching();
      setStatus(state.share ? 'Sharing' : 'Connected', 'ok');
      updateCaptureAvailability();
      resolve();
    };
    ws.onmessage = (e) => {
      if (state.ws !== ws) return;
      state.lastInboundAt = Date.now();
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      handleMessage(msg).catch((err) => log(`socket handler: ${err.message}`, 'error'));
    };
    ws.onerror = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error('Room socket failed.'));
      }
    };
    ws.onclose = (e) => {
      clearTimeout(timer);
      if (!settled) {
        settled = true;
        reject(new Error('Room connection closed before it opened.'));
      }
      if (state.ws !== ws || seq !== state.socketSeq || state.leaving) return;
      clearInterval(state.heartbeat);
      state.heartbeat = null;
      clearInterval(state.livenessTimer);
      state.livenessTimer = null;
      updateCaptureAvailability();
      log(`room socket closed (code ${e.code}${e.reason ? `, ${e.reason}` : ''})`, 'warn');
      setStatus('Reconnecting', 'warn');
      scheduleReconnect();
    };
  });
}
function scheduleReconnect() {
  if (state.leaving || state.reconnectTimer || P2P.active) return;
  state.reconnectAttempts += 1;
  const n = state.reconnectAttempts;
  const delay = Math.min(600 * 2 ** Math.min(n - 1, 5), 15000) + Math.floor(Math.random() * 400);
  log(`reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${n})`);
  if (n === 8) toast('Still trying to reconnect…');
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    recoverConnection().catch((err) => {
      if (isQuotaFailure(err)) {
        showRoomError(
          'The room service is at capacity. Try again later, or invite everyone using a direct room link.',
        );
        return;
      }
      log(`reconnect failed: ${err.message}`, 'warn');
      scheduleReconnect();
    });
  }, delay);
}
let recoveryPromise = null;
function recoverConnection() {
  if (recoveryPromise) return recoveryPromise;
  recoveryPromise = performRecovery().finally(() => {
    recoveryPromise = null;
  });
  return recoveryPromise;
}
async function performRecovery() {
  if (P2P.active) return;
  if (state.leaving) return;
  const identityChanged = await joinRoom();
  if (identityChanged) {
    log('previous identity was swept — rebuilding the media session', 'warn');
    await resetTracks({ silent: true });
  }
  await connectSocket();
  await resumeAfterReconnect();
  $('roomError').classList.add('hidden');
}

async function resumeAfterReconnect() {
  if (state.share) {
    try {
      await state.reannounce?.();
    } catch (err) {
      log(`re-announce failed: ${err.message}`, 'warn');
    }
  }
  for (const id of [...state.watching]) {
    if (state.subs.has(id)) continue;
    const ann = state.streams.get(id);
    if (ann) await addStream(ann).catch((err) => log(`resubscribe failed: ${err.message}`, 'warn'));
  }
  reportWatching();
}

const sfxQuiet = quietSounds;
const sfxPlay = playSound;

const {
  P2P,
  p2pShutdown,
  p2pHello,
  p2pRebuild,
  p2pBrokerLost,
  p2pAnnounceShare,
  subscribeP2P,
  p2pCloseAllOutbound,
  enterP2PMode,
} = createDirectTransport({
  state,
  $,
  log,
  randomId,
  setStatus,
  toast,
  updateCaptureAvailability,
  QUALITY,
  escapeHtml,
  showLocalTile,
  showLiveTile,
  showIdleTile,
  ensureTile,
  renderPeople,
  renderGrid,
  dropStream,
  addStream,
  removeTile,
  reportWatching,
  startTileStats,
  setPlaybackVolume,
  resumePlayback,
  refreshGlobalAudioButton,
  reconcileSnapshot,
});

const isQuotaFailure = (err) =>
  err?.code === 'do-quota' ||
  /exceeded allowed volume|daily request limit|durable objects free tier/i.test(
    String(err?.message || ''),
  );

async function reconcileSnapshot(snapshot, reason = 'snapshot') {
  if (P2P.active && reason !== 'p2p') {
    log(`ignored ${reason} snapshot — peer-to-peer roster is authoritative`, 'debug');
    return;
  }
  const rev = Number(snapshot.rev || 0);
  if (rev && state.appliedRev && rev <= state.appliedRev) return;
  state.appliedRev = Math.max(state.appliedRev || 0, rev);
  state.lastSnapshotAt = Date.now();
  const peopleBefore = new Set(state.people.keys());
  state.people = new Map((snapshot.participants || []).map((p) => [p.id, p]));
  for (const id of state.people.keys())
    if (!peopleBefore.has(id) && id !== state.participantId) sfxPlay('room-join');
  for (const id of peopleBefore)
    if (!state.people.has(id) && id !== state.participantId) sfxPlay('room-leave');
  const incoming = new Map((snapshot.streams || []).map((s) => [s.id, s]));
  for (const id of [...state.streams.keys()])
    if (!incoming.has(id) && id !== state.share?.streamId) await dropStream(id, { silent: true });
  for (const ann of incoming.values()) {
    const previous = state.streams.get(ann.id);
    const sub = state.subs.get(ann.id);
    const watched = state.watching.has(ann.id);
    const mediaChanged = watched && (!sub || !sameTarget(sub.target, ann));
    const announcementChanged =
      !previous ||
      previous.sessionId !== ann.sessionId ||
      previous.videoTrackName !== ann.videoTrackName ||
      previous.audioTrackName !== ann.audioTrackName ||
      previous.profile !== ann.profile ||
      previous.ownerName !== ann.ownerName;
    if (mediaChanged || announcementChanged || !state.tiles.has(ann.id)) await addStream(ann);
    else state.streams.set(ann.id, ann);
  }
  if (state.share && !state.tiles.has(state.share.streamId)) restoreLocalTile();
  renderPeople();
  refreshVisibleNames();
  if (reason !== 'poll') log(`room state synchronized (${reason})`);
}
async function handleMessage(msg) {
  if (msg.type === 'pong') return;
  if (msg.type === 'server-ping') {
    if (msg.budget) applyBudget(msg.budget);
    if (typeof msg.rev === 'number' && msg.rev > (state.appliedRev || 0)) {
      log(
        `room revision drift (have ${state.appliedRev || 0}, server ${msg.rev}) — resyncing`,
        'debug',
      );
      syncSnapshot('rev-drift').catch(() => {});
    }
    return;
  }
  if (msg.type === 'snapshot') {
    if (msg.budget) applyBudget(msg.budget);
    await reconcileSnapshot(msg, 'socket');
    return;
  }
  if (typeof msg.rev === 'number') state.appliedRev = Math.max(state.appliedRev || 0, msg.rev);
  if (msg.type === 'watching-changed') {
    const relevant = (id) => {
      const st = state.streams.get(id);
      return Boolean(st && (st.ownerId === state.participantId || state.watching.has(id)));
    };
    if (msg.participantId !== state.participantId) {
      if ((msg.opened || []).some(relevant)) sfxPlay('viewer-join');
      if ((msg.closed || []).some(relevant)) sfxPlay('viewer-leave');
    }
    const person = state.people.get(msg.participantId);
    if (person) {
      const closed = new Set(msg.closed || []);
      person.watching = [
        ...new Set([
          ...(person.watching || []).filter((id) => !closed.has(id)),
          ...(msg.opened || []),
        ]),
      ];
      renderPeople();
    }
    return;
  }
  if (msg.type === 'participant-joined' || msg.type === 'participant-updated') {
    const isNew = msg.type === 'participant-joined' && !state.people.has(msg.participant.id);
    state.people.set(msg.participant.id, msg.participant);
    if (isNew && msg.participant.id !== state.participantId) sfxPlay('room-join');
    renderPeople();
    refreshVisibleNames();
    return;
  }
  if (msg.type === 'participant-left') {
    const known = state.people.has(msg.participantId);
    state.people.delete(msg.participantId);
    if (known && msg.participantId !== state.participantId) sfxPlay('room-leave');
    for (const id of msg.removedStreams || []) await dropStream(id, { viaOwnerLeaving: true });
    renderPeople();
    refreshVisibleNames();
    return;
  }
  if (msg.type === 'stream-upsert') {
    await addStream(msg.stream);
    return;
  }
  if (msg.type === 'stream-remove') {
    await dropStream(msg.streamId);
  }
}
async function reportIceOutcome(pc) {
  if (!pc || pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') return;
  try {
    const stats = await pc.getStats();
    const local = new Map(),
      remote = new Map(),
      pairs = [];
    stats.forEach((r) => {
      if (r.type === 'local-candidate') local.set(r.id, r);
      else if (r.type === 'remote-candidate') remote.set(r.id, r);
      else if (r.type === 'candidate-pair') pairs.push(r);
    });
    const mine = [...new Set([...local.values()].map((c) => c.candidateType))];
    log(`local candidates gathered: ${mine.join(', ') || 'NONE'}`, 'error');
    if (!mine.includes('srflx') && !mine.includes('relay')) {
      log(
        'no server-reflexive candidate — STUN got no reply, so UDP is very likely blocked on this network',
        'error',
      );
    }
    if (!pairs.length) {
      log('no candidate pairs were formed at all', 'error');
      return;
    }
    const tally = {};
    for (const p of pairs) tally[p.state] = (tally[p.state] || 0) + 1;
    log(
      `candidate pairs: ${Object.entries(tally)
        .map(([k, v]) => `${v} ${k}`)
        .join(', ')}`,
      'error',
    );
    for (const p of pairs.slice(0, 5)) {
      const l = local.get(p.localCandidateId),
        r = remote.get(p.remoteCandidateId);
      log(
        `  ${l?.candidateType || '?'}/${l?.protocol || '?'} -> ${r?.candidateType || '?'} : ${p.state}` +
          (p.requestsSent ? ` (sent ${p.requestsSent}, received ${p.responsesReceived || 0})` : ''),
        'error',
      );
    }
    if (pairs.every((p) => !p.responsesReceived)) {
      log(
        'every path sent checks and got nothing back — a relay (TURN) is required for this network',
        'error',
      );
    }
    openLog();
  } catch (err) {
    log(`could not read ICE stats: ${err.message}`, 'debug');
  }
}
function watchMediaCalls() {
  if (window.__ssFetchWrapped) return;
  window.__ssFetchWrapped = true;
  const original = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input?.url || '';
    if (!url.includes('/partytracks/')) return original(input, init);
    if (url.includes('/generate-ice-servers')) {
      const headers = new Headers(init?.headers);
      headers.set('x-room', state.roomId);
      headers.set('x-participant-id', state.participantId);
      headers.set('x-participant-token', state.token);
      init = { ...init, headers };
    }
    const label = url.split('/partytracks/')[1]?.split('?')[0] || 'partytracks';
    try {
      const response = await original(input, init);
      if (!response.ok) {
        let detail = '';
        try {
          detail = (await response.clone().text()).slice(0, 200);
        } catch {}
        log(`media call ${label} -> ${response.status} ${detail}`, 'error');
      } else {
        log(`media call ${label} -> ${response.status}`, 'debug');
      }
      return response;
    } catch (err) {
      log(`media call ${label} failed: ${err.message}`, 'error');
      throw err;
    }
  };
}
const connMode = () => (new URLSearchParams(location.search).get('p2p') === '1' ? 'p2p' : 'auto');
function renderConnModeNote() {
  const note = $('connModeNote');
  if (!note) return;
  note.textContent =
    connMode() === 'p2p'
      ? 'Direct rooms use encrypted signaling through public brokers and a public relay when needed. Your upload grows with each viewer. Everyone must use the same direct invite link. Availability is not guaranteed.'
      : 'Media is relayed by Cloudflare. One upload regardless of viewer count, and a relay for peers behind strict NAT. Counts against your bandwidth cap.';
}

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
  state.tracksSessionSub = state.tracks.session$.subscribe({
    next: ({ sessionId }) => {
      if (state.sessionId && state.sessionId !== sessionId)
        log(
          `media session rebuilt (${state.sessionId.slice(0, 8)}… -> ${sessionId.slice(0, 8)}…)`,
          'warn',
        );
      state.sessionId = sessionId;
    },
    error: (err) => log(`media session error: ${err?.message || err}`, 'error'),
  });
  try {
    state.pcSub = state.tracks.peerConnection$?.subscribe?.((pc) => {
      if (!pc || pc.__ssProbed) return;
      pc.__ssProbed = true;
      const servers = (pc.getConfiguration?.() || {}).iceServers || [];
      if (!servers.length) {
        log(
          'ICE SERVERS: none configured — /partytracks/generate-ice-servers returned nothing usable',
          'error',
        );
      } else {
        const urls = servers.flatMap((x) => [].concat(x.urls || []));
        log(
          `ICE servers: ${urls.length} (${urls.filter((u) => String(u).startsWith('turn')).length} turn, ${urls.filter((u) => String(u).startsWith('stun')).length} stun)`,
        );
        log(`ICE server list: ${urls.slice(0, 4).join(', ')}`, 'debug');
      }

      const seen = new Set();
      pc.addEventListener('icecandidate', (e) => {
        if (e.candidate) {
          seen.add(e.candidate.type || '?');
          return;
        }
        log(`ICE gathering complete: ${[...seen].join(', ') || 'NO CANDIDATES AT ALL'}`);
        if (!seen.has('srflx') && !seen.has('relay')) {
          log(
            'only host candidates — STUN did not answer, so the SFU cannot be reached from behind NAT',
            'error',
          );
        }
      });
      pc.addEventListener('icecandidateerror', (e) => {
        log(`ICE error ${e.errorCode} from ${e.url || 'unknown'}: ${e.errorText || ''}`, 'warn');
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        log(`ICE: ${pc.iceConnectionState}`, 'debug');
        if (pc.iceConnectionState === 'checking') setTimeout(() => reportIceOutcome(pc), 10000);
      });
      pc.addEventListener('icegatheringstatechange', () =>
        log(`ICE gathering: ${pc.iceGatheringState}`, 'debug'),
      );
    });
  } catch (err) {
    log(`could not attach media diagnostics: ${err.message}`, 'debug');
  }

  state.pcStateSub = state.tracks.peerConnectionState$.subscribe((s) => {
    log(`media connection: ${s}`, s === 'failed' ? 'error' : 'info');
    clearTimeout(state.pcRecoverTimer);
    state.pcRecoverTimer = null;
    if (s === 'connected') {
      state.pcFailures = 0;
      setStatus(state.share ? 'Sharing' : 'Connected', 'ok');
      return;
    }
    if (s === 'disconnected') {
      setStatus('Media unstable', 'warn');
      state.pcRecoverTimer = setTimeout(() => {
        if (state.leaving) return;
        log('media still disconnected after 8s — rebuilding', 'warn');
        resetTracks().catch((err) => log(`media reset failed: ${err.message}`, 'error'));
      }, 8000);
      return;
    }
    if (s === 'failed') {
      setStatus('Media failed', 'bad');
      state.pcFailures = (state.pcFailures || 0) + 1;
      const delay = Math.min(1000 * state.pcFailures, 10000);
      if (state.pcFailures === 1) toast('Media connection dropped — rebuilding it now.');
      else if (state.pcFailures === 3)
        toast('Media keeps failing. This network probably needs TURN enabled.');
      state.pcRecoverTimer = setTimeout(() => {
        if (state.leaving) return;
        resetTracks().catch((err) => log(`media reset failed: ${err.message}`, 'error'));
      }, delay);
    }
  });
  log('media engine ready');
  return state.tracks;
}
async function resetTracks({ silent = false } = {}) {
  if (P2P.active) return;
  if (state.leaving || state.resettingTracks) return;
  state.resettingTracks = true;
  sfxQuiet(2500);
  try {
    if (!silent) log('rebuilding media engine', 'warn');
    const watched = [...state.watching];
    for (const id of [...state.subs.keys()]) await teardownSubscription(id, { keepTile: true });
    const share = state.share;
    if (share) {
      for (const sub of share.subs) {
        try {
          sub.unsubscribe();
        } catch {}
      }
      share.subs = [];
      share.videoMeta = null;
      share.audioMeta = null;
      try {
        share.encodings$?.complete();
      } catch {}
      share.encodings$ = null;
    }
    try {
      state.tracksSessionSub?.unsubscribe();
    } catch {}
    try {
      state.pcStateSub?.unsubscribe();
    } catch {}
    try {
      state.pcSub?.unsubscribe();
    } catch {}
    state.pcSub = null;
    state.tracksSessionSub = null;
    state.pcStateSub = null;
    state.tracks = null;
    state.sessionId = '';
    initTracks();
    if (share && state.share === share) await publishShare(share);
    for (const id of watched) {
      const ann = state.streams.get(id);
      if (ann)
        await addStream(ann).catch((err) => log(`resubscribe failed: ${err.message}`, 'warn'));
    }
  } finally {
    state.resettingTracks = false;
  }
}

async function captureShare() {
  if (state.share || state.budgetBlocked || state.leaving) return;
  const qualityId = $('quality').value;
  const q = QUALITY[qualityId] || QUALITY['720p60'];
  const wantAudio = $('withAudio').checked;
  let media;
  try {
    log(`requesting screen at ${q.label}${wantAudio ? ' with audio' : ''}`);
    media = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: wantAudio
        ? { echoCancellation: false, noiseSuppression: false, autoGainControl: false }
        : false,
      systemAudio: 'exclude',
      windowAudio: wantAudio ? 'window' : 'exclude',
      surfaceSwitching: 'include',
      selfBrowserSurface: 'exclude',
    });
  } catch (err) {
    if (err?.name === 'NotAllowedError') log('screen picker cancelled');
    else {
      log(`screen capture failed: ${err.message}`, 'error');
      toast(err.message || 'Could not start sharing.');
    }
    return;
  }
  if (state.leaving || state.budgetBlocked) {
    media.getTracks().forEach((track) => track.stop());
    return;
  }
  const videoTrack = media.getVideoTracks()[0];
  let audioTrack = media.getAudioTracks()[0] || null;
  if (!videoTrack) {
    media.getTracks().forEach((t) => t.stop());
    toast('No video track was captured.');
    return;
  }
  try {
    await videoTrack.applyConstraints({
      width: { ideal: q.width },
      height: { ideal: q.height },
      frameRate: { ideal: q.fps },
    });
  } catch {
    log('The browser chose its own capture quality.', 'warn');
  }
  const settings = videoTrack.getSettings();
  const surface = settings.displaySurface || 'unknown';
  if (surface === 'monitor' && audioTrack) {
    try {
      media.removeTrack(audioTrack);
      audioTrack.stop();
    } catch {}
    audioTrack = null;
    toast(
      'Full-screen system audio was blocked to prevent other apps leaking into this stream. Share the app window or browser tab for localized audio.',
    );
    log('blocked monitor/system audio track to prevent audio bleed', 'warn');
  }
  if (wantAudio && !audioTrack)
    toast(
      surface === 'monitor'
        ? 'For localized audio, share the specific app window or browser tab.'
        : 'This browser did not provide audio for that source. Chrome/Edge work best for window/tab audio.',
    );
  try {
    videoTrack.contentHint = $('contentHint').value;
  } catch {}
  if (audioTrack) {
    try {
      audioTrack.contentHint = 'music';
    } catch {}
    log(`captured localized audio (${audioTrack.label || `${surface} audio`})`);
  }
  log(
    `captured ${settings.width || '?'}x${settings.height || '?'} @ ${Math.round(settings.frameRate || 0)}fps · ${surface}`,
  );
  videoTrack.addEventListener(
    'ended',
    () => {
      if (state.share) stopShare().catch(() => {});
    },
    { once: true },
  );
  const streamId = `${state.participantId}-share`;
  const share = {
    streamId,
    media,
    subs: [],
    videoMeta: null,
    audioMeta: null,
    profile: qualityId,
    encodings$: null,
    publishAttempts: 0,
  };
  state.share = share;
  state.reannounce = () => announceShare(share);
  setSharingUi(true);
  setStatus('Publishing', 'warn');
  showLocalTile(
    {
      id: streamId,
      ownerId: state.participantId,
      ownerName: `${state.name} (you)`,
      profile: qualityId,
      audio: Boolean(audioTrack),
    },
    media,
  );
  if (state.demo) {
    setStatus('Local preview', 'ok');
    return;
  }
  if (P2P.active) {
    await p2pAnnounceShare(share);
    return;
  }
  await publishShare(share);
}
let announceTimer = null;
function scheduleAnnounce(share) {
  clearTimeout(announceTimer);
  announceTimer = setTimeout(() => {
    announceShare(share).catch((err) => log(`announce failed: ${err.message}`, 'error'));
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
  await apiCall(`/api/rooms/${state.roomId}/stream/upsert`, {
    method: 'POST',
    body: envelope({ stream }),
  });
  if (state.share !== share || state.leaving) return;
  log(
    `announced to room (session ${stream.sessionId.slice(0, 8)}…)${stream.audio ? ' + audio' : ''}`,
  );
  setStatus('Sharing', 'ok');
}
async function publishShare(share) {
  const tracks = initTracks();
  const q = QUALITY[share.profile] || QUALITY['720p60'];
  const videoTrack = share.media.getVideoTracks()[0];
  const audioTrack = share.media.getAudioTracks()[0] || null;
  if (!videoTrack || videoTrack.readyState === 'ended') {
    log('cannot publish: the screen capture has ended', 'error');
    await stopShare();
    return;
  }
  clearTimeout(share.publishTimer);
  share.publishAttempts = (share.publishAttempts || 0) + 1;
  const attempt = share.publishAttempts;
  const encodings$ = new BehaviorSubject([{ maxBitrate: q.bitrate, maxFramerate: q.fps }]);
  share.encodings$ = encodings$;
  const videoSource$ = new ReplaySubject(1);
  log(`publishing video at up to ${(q.bitrate / 1e6).toFixed(1)} Mbps`);
  share.subs.push(
    tracks.push(videoSource$, { sendEncodings$: encodings$ }).subscribe({
      next: (meta) => {
        if (state.share !== share || share.publishAttempts !== attempt) return;
        share.videoMeta = meta;
        log(`video published (${meta.trackName})`);
        scheduleAnnounce(share);
      },
      error: (err) => {
        if (state.share !== share) return;
        stopShare().catch(() => {});
        log(`video publish failed: ${err?.message || err}`, 'error');
        toast(`Video publish failed: ${err?.message || err}`);
      },
    }),
  );
  if (audioTrack && audioTrack.readyState !== 'ended') {
    const audioSource$ = new ReplaySubject(1);
    share.subs.push(
      tracks.push(audioSource$).subscribe({
        next: (meta) => {
          if (state.share !== share || share.publishAttempts !== attempt) return;
          share.audioMeta = meta;
          log(`audio published (${meta.trackName})`);
          scheduleAnnounce(share);
        },
        error: (err) => {
          log(`audio publish failed: ${err?.message || err}`, 'warn');
          toast('Video is live, but shared audio failed to publish.');
        },
      }),
    );
    audioSource$.next(audioTrack);
  }
  videoSource$.next(videoTrack);
  share.publishTimer = setTimeout(async () => {
    if (state.share !== share || share.videoMeta || share.publishAttempts !== attempt) return;
    try {
      const budget = await apiCall('/api/budget');
      applyBudget(budget);
      if (budget?.blocked) {
        log(
          `bandwidth cap reached: ${budget.usedGb} of ${budget.capGb} GB in the last ${budget.windowDays} days — the server is refusing new media sessions`,
          'error',
        );
        toast('Bandwidth cap reached. Sharing is paused by the estimated usage guard.');
        openLog();
        stopShare().catch(() => {});
        return;
      }
    } catch {}
    log(
      `no publish confirmation after 15s (attempt ${attempt}) — rebuilding the media engine`,
      'error',
    );
    if (attempt >= 4) {
      toast(
        'Couldn’t publish your screen. Capture has stopped. Check the activity log and try again.',
      );
      openLog();
      await stopShare();
      return;
    }
    resetTracks().catch((err) => log(`media reset failed: ${err.message}`, 'error'));
  }, 15000);
}

function setSharingUi(sharing) {
  $('selfStatus').textContent = sharing ? 'You · Sharing your screen' : 'You · In the room';
  $('sharingHelp').textContent = sharing
    ? 'Stop sharing to change your capture preferences.'
    : 'Quality preferences apply to the next share. Audio availability depends on your browser.';
  $('connMode').disabled = sharing || state.demo;
  $('shareBtn').classList.toggle('hidden', sharing);
  $('stopBtn').classList.toggle('hidden', !sharing);
  $('quality').disabled = sharing;
  $('contentHint').disabled = sharing;
  $('withAudio').disabled = sharing;
}
async function stopShare() {
  const share = state.share;
  if (!share) return;
  state.share = null;
  state.reannounce = null;
  clearTimeout(announceTimer);
  announceTimer = null;
  clearTimeout(share.publishTimer);
  for (const sub of share.subs) {
    try {
      sub.unsubscribe();
    } catch {}
  }
  try {
    share.encodings$?.complete();
  } catch {}
  share.media.getTracks().forEach((t) => {
    try {
      t.stop();
    } catch {}
  });
  removeTile(share.streamId);
  setSharingUi(false);
  setStatus('Connected', 'ok');
  if (P2P.active) {
    p2pCloseAllOutbound();
    await p2pHello().catch(() => {});
    p2pRebuild();
  } else if (!state.demo && !state.leaving)
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

const sameTarget = (a, b) =>
  a &&
  b &&
  a.sessionId === b.sessionId &&
  a.videoTrackName === b.videoTrackName &&
  a.audioTrackName === b.audioTrackName;
async function addStream(ann) {
  if (state.joining.has(ann.id)) return;
  state.joining.add(ann.id);
  try {
    await addStreamInner(ann);
  } finally {
    state.joining.delete(ann.id);
  }
}
async function addStreamInner(ann) {
  const isNewStream = !state.streams.has(ann.id);
  state.streams.set(ann.id, ann);
  if (isNewStream && ann.ownerId !== state.participantId) sfxPlay('stream-start');
  if (ann.ownerId === state.participantId || ann.id === state.share?.streamId) {
    if (state.share && ann.id === state.share.streamId && !state.tiles.has(ann.id))
      restoreLocalTile();
    renderPeople();
    return;
  }
  const ready = ann.p2p ? true : Boolean(ann.sessionId && ann.videoTrackName);
  const existing = state.subs.get(ann.id);
  if (!state.watching.has(ann.id)) {
    if (existing) await teardownSubscription(ann.id, { keepTile: true });
    showIdleTile(ann, ready);
    renderPeople();
    return;
  }
  if (existing) {
    if (sameTarget(existing.target, ann)) {
      renderPeople();
      return;
    }
    log(`${ann.ownerName} media changed — resubscribing`, 'warn');
    await teardownSubscription(ann.id, { keepTile: true });
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
  if (ann.p2p || P2P.active) return subscribeP2P(ann);
  log(`watching ${ann.ownerName}`);
  const tracks = initTracks();
  const videoMedia = new MediaStream();
  const prior = state.subAttempts.get(ann.id) || 0;
  const entry = {
    videoMedia,
    audioMedia: null,
    subs: [],
    stall: null,
    target: {
      sessionId: ann.sessionId,
      videoTrackName: ann.videoTrackName,
      audioTrackName: ann.audioTrackName,
    },
    strikes: 0,
    subscribedAt: Date.now(),
    attempt: prior + 1,
  };
  state.subs.set(ann.id, entry);
  state.subAttempts.set(ann.id, entry.attempt);
  const tile = showLiveTile(ann, videoMedia);
  tile.note.textContent = 'Connecting…';
  tile.note.classList.remove('hidden');
  entry.stall = setTimeout(() => {
    if (videoMedia.getVideoTracks().length) return;
    log(`no video from ${ann.ownerName} after 15s`, 'error');
    tile.note.textContent = 'No video yet — retrying…';
  }, 15000);
  entry.subs.push(
    tracks
      .pull(of({ trackName: ann.videoTrackName, sessionId: ann.sessionId, location: 'remote' }))
      .subscribe({
        next: (track) => {
          clearTimeout(entry.stall);
          for (const old of videoMedia.getVideoTracks()) videoMedia.removeTrack(old);
          videoMedia.addTrack(track);
          tile.video.srcObject = videoMedia;
          tile.video.play().catch(() => {});
          tile.note.classList.add('hidden');
          tile.lastFrameAt = Date.now();
          state.subAttempts.delete(ann.id);
          log(`receiving video from ${ann.ownerName}`);
        },
        error: (err) => {
          clearTimeout(entry.stall);
          log(`video pull failed for ${ann.ownerName}: ${err?.message || err}`, 'error');
          tile.note.textContent = `Video failed: ${err?.message || err}`;
          tile.note.classList.remove('hidden');
        },
      }),
  );
  if (ann.audioTrackName) {
    entry.subs.push(
      tracks
        .pull(of({ trackName: ann.audioTrackName, sessionId: ann.sessionId, location: 'remote' }))
        .subscribe({
          next: (track) => {
            entry.audioMedia = new MediaStream([track]);
            tile.audio.srcObject = entry.audioMedia;
            tile.audioBtn.classList.remove('hidden');
            closeTileVolume(tile);
            setPlaybackVolume(tile, state.volume);
            tile.audio.muted = state.audioMuted;
            tile.audioBtn.innerHTML = tile.audio.muted
              ? icon('speaker-slash')
              : icon('speaker-high');
            tile.audioBtn.classList.toggle('on', !tile.audio.muted);
            tile.audio
              .play()
              .then(() => {
                state.audioUnlocked = true;
                refreshGlobalAudioButton();
              })
              .catch(() => {
                tile.audio.muted = true;
                tile.audioBtn.innerHTML = icon('speaker-slash');
                tile.audioBtn.classList.remove('on');
                toast(
                  `Audio from ${streamName(ann)} is available — click the speaker once to enable it.`,
                );
                refreshGlobalAudioButton();
              });
            log(`receiving shared audio from ${streamName(ann)}`);
          },
          error: (err) => {
            log(`audio pull failed for ${ann.ownerName}: ${err?.message || err}`, 'warn');
            tile.audioBtn.classList.remove('hidden');
            tile.audioBtn.innerHTML = icon('warning-circle');
          },
        }),
    );
  }
}
async function watchStream(streamId) {
  const ann = state.streams.get(streamId);
  if (!ann || state.watching.has(streamId) || state.budgetBlocked) return;
  if (state.watching.size >= 3) {
    toast('You can watch up to 3 screens at once. Close one to watch another.');
    return;
  }
  state.watching.add(streamId);
  reportWatching();
  try {
    await addStream(ann);
  } catch (error) {
    state.watching.delete(streamId);
    reportWatching();
    showIdleTile(ann, true);
    throw error;
  }
}
async function unwatchStream(streamId) {
  if (!state.watching.has(streamId)) return;
  const ann = state.streams.get(streamId);
  state.watching.delete(streamId);
  state.subAttempts.delete(streamId);
  reportWatching();
  await teardownSubscription(streamId, { keepTile: true });
  if (ann) showIdleTile(ann, Boolean(ann.sessionId && ann.videoTrackName));
  log(`stopped watching ${ann?.ownerName || streamId}`);
}
async function teardownSubscription(streamId, { keepTile = false } = {}) {
  const entry = state.subs.get(streamId);
  if (entry) {
    clearTimeout(entry.stall);
    for (const sub of entry.subs) {
      try {
        sub.unsubscribe();
      } catch {}
    }
    state.subs.delete(streamId);
  }
  const tile = state.tiles.get(streamId);
  if (tile) {
    try {
      tile.video.srcObject = null;
      tile.audio.srcObject = null;
    } catch {}
    if (!keepTile) removeTile(streamId);
  }
}
async function dropStream(streamId, { silent = false, viaOwnerLeaving = false } = {}) {
  const ann = state.streams.get(streamId);
  if (streamId === state.share?.streamId) {
    state.streams.delete(streamId);
    if (!state.tiles.has(streamId)) restoreLocalTile();
    if (!P2P.active && !state.leaving)
      state.reannounce?.().catch((error) => log(error.message, 'warn'));
    return;
  }
  state.streams.delete(streamId);
  state.subAttempts.delete(streamId);
  if (ann && !viaOwnerLeaving && ann.ownerId !== state.participantId) sfxPlay('stream-stop');
  if (state.watching.delete(streamId)) reportWatching();
  await teardownSubscription(streamId);
  removeTile(streamId);
  if (!silent && ann && ann.ownerId !== state.participantId)
    log(`${ann.ownerName} stopped sharing`);
  renderPeople();
}

function restoreLocalTile() {
  const share = state.share;
  if (!share) return;
  showLocalTile(
    {
      id: share.streamId,
      ownerId: state.participantId,
      ownerName: state.name + ' (you)',
      profile: share.profile,
      audio: share.media.getAudioTracks().length > 0,
    },
    share.media,
  );
}
function closeTileVolume(entry) {
  entry.volumeWrap.classList.add('hidden');
  entry.audioBtn.setAttribute('aria-expanded', 'false');
}
function revealTileControls(entry) {
  clearTimeout(entry.controlsTimer);
  entry.card.classList.add('controls-visible');
  entry.controlsTimer = setTimeout(() => {
    if (
      !entry.card.querySelector(':focus-visible') &&
      entry.volumeWrap.classList.contains('hidden')
    )
      entry.card.classList.remove('controls-visible');
  }, 2200);
}
function ensureTile(ann, isLocal = false) {
  let entry = state.tiles.get(ann.id);
  if (entry) return entry;
  const card = document.createElement('div');
  card.tabIndex = 0;
  card.setAttribute('aria-label', streamName(ann) + ' screen');
  card.className = `tile${isLocal ? ' local' : ''}`;
  const volumeId = 'volume-' + randomId(6);
  card.innerHTML = `<video aria-label="Shared screen" autoplay playsinline muted></video><audio autoplay></audio><div class="tile-idle hidden"><div class="idle-avatar"></div><div class="idle-name"></div><div class="idle-sub"></div><button class="primary idle-watch">Watch stream</button></div><div class="tile-note hidden"></div><div class="tile-bar"><span class="tile-name"></span><span class="tile-actions"><span class="tile-meta"></span><div id="${volumeId}" class="tile-volume hidden" role="group" aria-label="Shared audio volume"><label>Volume <output class="tile-volume-value">80%</output><input class="tile-volume-range" type="range" min="0" max="100" value="80" aria-label="Stream volume"></label><button class="tile-action-btn tile-mute" aria-label="Mute shared audio">${icon('speaker-high')}</button></div><button class="tile-action-btn tile-audio hidden" aria-label="Audio volume" title="Audio volume" aria-expanded="false" aria-controls="${volumeId}">${icon('speaker-high')}</button><button class="tile-action-btn tile-focus" title="Focus this stream" aria-label="Focus this stream" aria-pressed="false">${icon('arrows-out-simple')}</button><button class="tile-action-btn tile-fullscreen" aria-label="Full screen" title="Full screen">${icon('corners-out')}</button><button class="tile-action-btn tile-stop hidden">Close</button></span></div>`;
  entry = {
    card,
    video: card.querySelector('video'),
    audio: card.querySelector('audio'),
    audioBtn: card.querySelector('.tile-audio'),
    volumeWrap: card.querySelector('.tile-volume'),
    volumeRange: card.querySelector('.tile-volume-range'),
    muteBtn: card.querySelector('.tile-mute'),
    volumeValue: card.querySelector('.tile-volume-value'),
    note: card.querySelector('.tile-note'),
    idle: card.querySelector('.tile-idle'),
    statsTimer: null,
    lastFrameAt: 0,
    lastMediaTime: -1,
  };
  card.querySelector('.tile-fullscreen').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (card.requestFullscreen) await card.requestFullscreen();
      else if (entry.video.webkitEnterFullscreen) entry.video.webkitEnterFullscreen();
      else toast('Full screen isn’t available in this browser.');
    } catch {
      toast('Couldn’t enter full screen.');
    }
  });
  entry.video.addEventListener('loadedmetadata', () => syncFocusRatio(entry));
  entry.video.addEventListener('resize', () => syncFocusRatio(entry));
  entry.audio.muted = state.audioMuted;
  setPlaybackVolume(entry, state.volume);
  if (entry.volumeRange) entry.volumeRange.value = String(Math.round(state.volume * 100));
  card.querySelector('.idle-watch').addEventListener('click', (e) => {
    e.stopPropagation();
    watchStream(ann.id).catch((err) => log(err.message, 'error'));
  });
  card.querySelector('.tile-stop').addEventListener('click', (e) => {
    e.stopPropagation();
    unwatchStream(ann.id).catch((err) => log(err.message, 'error'));
  });
  entry.audioBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = entry.volumeWrap.classList.contains('hidden');
    for (const other of state.tiles.values()) closeTileVolume(other);
    if (opening) {
      revealTileControls(entry);
      entry.volumeWrap.classList.remove('hidden');
      entry.audioBtn.setAttribute('aria-expanded', 'true');
      resumePlayback();
      entry.volumeRange.focus({ preventScroll: true });
    }
  });
  entry.muteBtn.addEventListener('click', (event) => {
    event.stopPropagation();
    toggleTileAudio(ann.id);
  });
  entry.volumeWrap.addEventListener('pointerdown', (event) => event.stopPropagation());
  card.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse') revealTileControls(entry);
  });
  card.addEventListener('pointerleave', (event) => {
    if (event.pointerType === 'mouse' && entry.volumeWrap.classList.contains('hidden'))
      card.classList.remove('controls-visible');
  });
  card.addEventListener('click', (event) => {
    if (event.target.closest('button,input,.tile-volume')) return;
    if (card.classList.contains('thumbnail')) {
      setFocus(ann.id);
      return;
    }
    revealTileControls(entry);
  });
  card.addEventListener('keydown', (event) => {
    if (event.target !== card) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (card.classList.contains('thumbnail')) setFocus(ann.id);
      else revealTileControls(entry);
    }
  });
  entry.volumeRange?.addEventListener('click', (e) => e.stopPropagation());
  entry.volumeRange?.addEventListener('input', (e) => {
    e.stopPropagation();
    const v = Math.max(0, Math.min(100, Number(e.target.value) || 0)) / 100;
    setPlaybackVolume(entry, v);
    resumePlayback();
    if (v > 0 && entry.audio.muted) {
      entry.audio.muted = false;
      entry.audio.play().catch(() => {});
    }
    entry.audioBtn.innerHTML = entry.audio.muted ? icon('speaker-slash') : icon('speaker-high');
    entry.audioBtn.classList.toggle('on', !entry.audio.muted);
    entry.volumeValue.textContent = Math.round(v * 100) + '%';
    setTileAudioState(entry, entry.audio.muted);
    refreshGlobalAudioButton();
  });

  card.querySelector('.tile-focus').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFocus(ann.id);
  });
  $('gridMain').appendChild(card);
  state.tiles.set(ann.id, entry);
  renderGrid();
  return entry;
}
function showIdleTile(ann, ready) {
  const e = ensureTile(ann, false);
  clearInterval(e.statsTimer);
  e.statsTimer = null;
  e.video.srcObject = null;
  e.audio.srcObject = null;
  e.card.classList.add('idle');
  closeTileVolume(e);
  e.note.classList.add('hidden');
  e.idle.classList.remove('hidden');
  e.card.querySelector('.tile-stop').classList.add('hidden');
  e.audioBtn.classList.add('hidden');
  e.volumeWrap.classList.add('hidden');
  const name = streamName(ann);
  e.idle.querySelector('.idle-avatar').textContent = name.slice(0, 1).toUpperCase();
  e.idle.querySelector('.idle-name').textContent = name;
  e.idle.querySelector('.idle-sub').textContent = ready
    ? `${(QUALITY[ann.profile] || QUALITY['720p60']).label}${ann.audio ? ' · Audio' : ''}`
    : 'Starting…';
  const b = e.idle.querySelector('.idle-watch');
  b.disabled = !ready || state.budgetBlocked;
  b.textContent = ready ? 'Watch Stream' : 'Starting…';
  e.card.querySelector('.tile-name').textContent = `${name} is live`;
  e.card.querySelector('.tile-meta').textContent = '';
  return e;
}
function showLiveTile(ann, media) {
  const e = ensureTile(ann, false);
  e.card.classList.remove('idle');
  e.idle.classList.add('hidden');
  e.card.querySelector('.tile-stop').classList.remove('hidden');
  e.video.srcObject = media;
  e.video.muted = true;
  e.video.play().catch(() => {});
  e.card.querySelector('.tile-name').textContent = streamName(ann);
  e.lastFrameAt = 0;
  clearInterval(e.statsTimer);
  startTileStats(e, ann);
  return e;
}
function showLocalTile(ann, media) {
  const e = ensureTile(ann, true);
  e.card.classList.remove('idle');
  e.idle.classList.add('hidden');
  e.card.querySelector('.tile-stop').classList.add('hidden');
  e.audioBtn.classList.add('hidden');
  e.volumeWrap.classList.add('hidden');
  e.video.srcObject = media;
  e.video.muted = true;
  e.video.play().catch(() => {});
  e.card.querySelector('.tile-name').textContent = ann.ownerName;
  e.lastFrameAt = Date.now();
  clearInterval(e.statsTimer);
  startTileStats(e, ann);
  return e;
}
function startTileStats(e, ann) {
  const generation = (e.statsGeneration || 0) + 1;
  e.statsGeneration = generation;
  if (e.frameCallbackId != null) e.video.cancelVideoFrameCallback?.(e.frameCallbackId);
  const meta = e.card.querySelector('.tile-meta');
  const fallback = (QUALITY[ann.profile] || QUALITY['720p60']).label;
  const hasRVFC = typeof e.video.requestVideoFrameCallback === 'function';
  let frames = 0,
    last = performance.now();
  e.lastMediaTime = -1;
  const onFrame = () => {
    if (!state.tiles.has(ann.id) || e.statsGeneration !== generation) return;
    frames++;
    e.lastFrameAt = Date.now();
    e.frameCallbackId = e.video.requestVideoFrameCallback(onFrame);
  };
  if (hasRVFC) e.frameCallbackId = e.video.requestVideoFrameCallback(onFrame);
  e.statsTimer = setInterval(() => {
    if (!state.tiles.has(ann.id)) {
      clearInterval(e.statsTimer);
      return;
    }
    const now = performance.now(),
      fps = Math.round((frames * 1000) / Math.max(1, now - last));
    frames = 0;
    last = now;
    const w = e.video.videoWidth,
      h = e.video.videoHeight;
    meta.textContent = w ? `${w}x${h} · ${fps} FPS${ann.audio ? ' · Audio' : ''}` : fallback;
    if (fps > 0) e.lastFrameAt = Date.now();
    const t = e.video.currentTime;
    if (t !== e.lastMediaTime) {
      e.lastMediaTime = t;
      e.lastFrameAt = Date.now();
    }
  }, 2000);
}
function removeTile(id) {
  const e = state.tiles.get(id);
  if (!e) return;
  if (state.focusedId === id) state.focusedId = null;
  clearTimeout(e.controlsTimer);
  clearInterval(e.statsTimer);
  e.statsGeneration++;
  if (e.frameCallbackId != null) e.video.cancelVideoFrameCallback?.(e.frameCallbackId);
  try {
    e.video.srcObject = null;
    e.audio.srcObject = null;
  } catch {}
  releasePlayback(e);
  e.card.remove();
  state.tiles.delete(id);
  renderGrid();
}
function setFocus(streamId) {
  const next = streamId && state.tiles.has(streamId) ? streamId : null;
  if (state.focusedId === next) return;
  state.focusedId = next;
  state.tilePage = 0;
  renderGrid();
}
function toggleFocus(streamId) {
  setFocus(state.focusedId === streamId ? null : streamId);
}
function syncFocusRatio(entry) {
  if (!entry?.video) return;
  const w = entry.video.videoWidth,
    h = entry.video.videoHeight;
  if (w > 0 && h > 0) entry.card.style.setProperty('--ar', `${w} / ${h}`);
}

function renderGrid() {
  const grid = $('grid'),
    main = $('gridMain'),
    rail = $('gridRail');
  const entries = [...state.tiles],
    count = entries.length;
  $('streamCount').textContent = String(count);
  $('stageHint').textContent = count
    ? 'Choose a screen. Make yourself comfortable.'
    : 'A front row for everyone.';
  $('empty').classList.toggle('hidden', count > 0);
  grid.classList.toggle('hidden', count === 0);
  if (state.focusedId && !state.tiles.has(state.focusedId)) state.focusedId = null;
  const focused = Boolean(state.focusedId),
    others = entries.filter(([id]) => id !== state.focusedId);
  const width = grid.clientWidth || innerWidth;
  const baseColumns = width >= 900 ? 3 : 2;
  const availableRows = Math.max(1, Math.min(2, Math.floor((grid.clientHeight - 30) / 170)));
  const capacity = focused
    ? Math.max(1, Math.min(6, Math.floor((width - 30) / (width < 600 ? 130 : 150))))
    : baseColumns * availableRows;
  const paged = focused ? others : entries;
  const pages = Math.max(1, Math.ceil(paged.length / capacity));
  state.tilePage = Math.max(0, Math.min(state.tilePage, pages - 1));
  const visible = new Set(
    paged.slice(state.tilePage * capacity, (state.tilePage + 1) * capacity).map(([id]) => id),
  );
  grid.classList.toggle('focus-mode', focused);
  grid.classList.toggle('has-rail', focused && others.length > 0);
  document.body.classList.toggle('is-focused', focused);
  for (const [id, tile] of entries) {
    const isMain = focused && id === state.focusedId;
    const parent = focused && !isMain ? rail : main;
    if (tile.card.parentElement !== parent) {
      parent.appendChild(tile.card);
      if (tile.video.srcObject) tile.video.play().catch(() => {});
    }
    tile.card.hidden = !isMain && !visible.has(id);
    tile.card.classList.toggle('big', isMain);
    tile.card.classList.toggle('thumbnail', focused && !isMain);
    const button = tile.card.querySelector('.tile-focus');
    button.setAttribute('aria-pressed', String(isMain));
    button.setAttribute('aria-label', isMain ? 'Return to grid' : 'Focus this stream');
    button.title = isMain ? 'Return to grid' : 'Focus this stream';
  }
  const shown = focused ? 1 : visible.size;
  const columns =
    focused || shown <= 1
      ? 1
      : availableRows === 1
        ? Math.min(baseColumns, shown)
        : shown <= 4
          ? 2
          : 3;
  main.style.setProperty('--columns', columns);
  main.style.setProperty('--rows', focused ? 1 : Math.ceil(shown / columns));
  rail.style.setProperty(
    '--thumbnails',
    Math.max(1, Math.min(capacity, others.length - state.tilePage * capacity)),
  );
  rail.classList.toggle('hidden', !focused || !others.length);
  $('gridPages').classList.toggle('hidden', pages === 1);
  $('screenPage').textContent = state.tilePage + 1 + ' / ' + pages;
  $('prevScreensBtn').disabled = state.tilePage === 0;
  $('nextScreensBtn').disabled = state.tilePage === pages - 1;
}
new ResizeObserver(() => renderGrid()).observe($('grid'));
$('prevScreensBtn').addEventListener('click', () => {
  state.tilePage--;
  renderGrid();
});
$('nextScreensBtn').addEventListener('click', () => {
  state.tilePage++;
  renderGrid();
});
document.addEventListener('pointerdown', (event) => {
  for (const tile of state.tiles.values())
    if (!tile.volumeWrap.contains(event.target) && !tile.audioBtn.contains(event.target))
      closeTileVolume(tile);
});
document.addEventListener(
  'keydown',
  (event) => {
    if (event.key !== 'Escape') return;
    const open = [...state.tiles.values()].find(
      (tile) => !tile.volumeWrap.classList.contains('hidden'),
    );
    if (open) {
      event.stopImmediatePropagation();
      closeTileVolume(open);
      open.audioBtn.focus({ preventScroll: true });
    }
  },
  true,
);
function refreshVisibleNames() {
  for (const [id, tile] of state.tiles) {
    const ann = state.streams.get(id);
    if (ann && ann.ownerId !== state.participantId) {
      const name = streamName(ann);
      tile.card.querySelector('.tile-name').textContent = name;
      if (tile.card.classList.contains('idle'))
        tile.idle.querySelector('.idle-name').textContent = name;
    } else if (state.share && id === state.share.streamId)
      tile.card.querySelector('.tile-name').textContent = `${state.name} (you)`;
  }
}
function renderPeople() {
  const people = activePeople(),
    owners = new Set([...state.streams.values()].map((s) => s.ownerId));
  if (state.share) owners.add(state.participantId);
  const key = people.map((p) => p.id + ':' + p.name + ':' + owners.has(p.id)).join('|');
  $('peopleCount').textContent = String(people.length);
  if (key !== state.peopleRenderKey) {
    state.peopleRenderKey = key;
    $('people').replaceChildren();
    for (const person of people) {
      const row = document.createElement('div');
      row.className = 'person';
      const you = person.id === state.participantId;
      row.innerHTML =
        '<span class="avatar">' +
        escapeHtml((person.name || '?').slice(0, 1).toUpperCase()) +
        '</span><span class="person-info"><span class="person-name">' +
        escapeHtml(person.name) +
        (you ? ' (you)' : '') +
        '</span><span class="person-meta">' +
        (owners.has(person.id) ? 'Sharing a screen' : 'Here to watch') +
        '</span></span>' +
        (owners.has(person.id) ? '<span class="badge">LIVE</span>' : '');
      $('people').appendChild(row);
    }
  }
  $('selfAvatar').textContent = (state.name || 'Y').slice(0, 1).toUpperCase();
}
function setTileAudioState(tile, muted) {
  if (!tile || !tile.audio.srcObject) return;
  tile.audio.muted = muted;
  setPlaybackVolume(tile, tile.playbackVolume ?? state.volume);
  if (!muted) resumePlayback();
  tile.audioBtn.innerHTML = muted ? icon('speaker-slash') : icon('speaker-high');
  tile.audioBtn.classList.toggle('on', !muted);
  tile.muteBtn.innerHTML = muted ? icon('speaker-slash') : icon('speaker-high');
  tile.muteBtn.setAttribute('aria-label', muted ? 'Unmute shared audio' : 'Mute shared audio');
  tile.volumeValue.textContent = Math.round((tile.playbackVolume ?? tile.audio.volume) * 100) + '%';
  if (!muted)
    tile.audio
      .play()
      .then(() => (state.audioUnlocked = true))
      .catch(() => {
        tile.audio.muted = true;
        tile.audioBtn.innerHTML = icon('speaker-slash');
        tile.audioBtn.classList.remove('on');
      });
}
function toggleTileAudio(id) {
  const tile = state.tiles.get(id);
  if (!tile || !tile.audio.srcObject) return;
  setTileAudioState(tile, !tile.audio.muted);
  refreshGlobalAudioButton();
}
function toggleAllAudio() {
  const audible = [...state.tiles.entries()].filter(
    ([id, t]) => state.subs.has(id) && t.audio.srcObject,
  );
  if (!audible.length) {
    toast('No watched stream is sharing audio right now.');
    return;
  }
  const mute = audible.some(([, t]) => !t.audio.muted);
  state.audioMuted = mute;
  for (const [, tile] of audible) setTileAudioState(tile, mute);
  refreshGlobalAudioButton();
}
function applyGlobalVolume(value) {
  state.volume = Math.max(0, Math.min(1, value));
  try {
    storage.set('simpleshare-volume', String(state.volume));
  } catch {}
  for (const tile of state.tiles.values()) {
    tile.audio.volume = state.volume;
    if (tile.volumeRange) tile.volumeRange.value = String(Math.round(state.volume * 100));
    tile.volumeValue.textContent = Math.round(state.volume * 100) + '%';
  }
  if ($('volumeValue')) $('volumeValue').textContent = `${Math.round(state.volume * 100)}%`;
}
function refreshGlobalAudioButton() {
  const audioTiles = [...state.tiles.entries()].filter(
    ([id, t]) => state.subs.has(id) && t.audio.srcObject,
  );
  const active = audioTiles.some(([, t]) => !t.audio.muted);
  $('audioBtn').innerHTML = icon(active ? 'speaker-high' : 'speaker-slash');
  $('audioBtn').title = active ? 'Mute all shared audio' : 'Unmute shared audio';
  $('audioBtn').setAttribute('aria-label', $('audioBtn').title);
}
async function watchdog() {
  if (state.leaving || state.budgetBlocked || state.resettingTracks) return;
  if (document.hidden) return;
  const now = Date.now();
  for (const [streamId, entry] of [...state.subs]) {
    if (!state.watching.has(streamId)) continue;
    const ann = state.streams.get(streamId),
      tile = state.tiles.get(streamId);
    if (!ann || !tile || !entry.target?.sessionId) continue;
    if (tile.lastFrameAt && now - tile.lastFrameAt < 12000) {
      entry.strikes = 0;
      continue;
    }
    const reference = tile.lastFrameAt || entry.subscribedAt || 0;
    if (!reference || now - reference < 12000) continue;
    entry.strikes = (entry.strikes || 0) + 1;
    if (entry.strikes < 2) continue;
    entry.strikes = 0;
    if (entry.attempt >= 3) {
      log(
        `${streamName(ann)} failed ${entry.attempt} subscribe attempts — rebuilding the media engine`,
        'warn',
      );
      state.subAttempts.delete(streamId);
      await resetTracks();
      return;
    }
    log(
      `no frames from ${streamName(ann)} — rebuilding subscription (attempt ${entry.attempt + 1})`,
      'warn',
    );
    await teardownSubscription(streamId, { keepTile: true });
    if (state.watching.has(streamId) && state.streams.has(streamId))
      await subscribe(state.streams.get(streamId));
  }
}
function applyBudget(budget) {
  if (budget) state.budget = budget;
  const b = state.budget;
  const el = $('budget');
  if (!b) {
    el.textContent = 'idle';
    return;
  }
  const pct = b.percent ?? 0;
  el.textContent = `${b.usedGb.toFixed(1)} / ${b.capGb} GB`;
  el.className = `budget ${b.blocked || pct >= 95 ? 'bad' : pct >= 75 ? 'warn' : ''}`;
  applyBudgetBlock(Boolean(b.blocked), b);
}
async function tickBudget() {
  if (!(state.ws && state.ws.readyState === WebSocket.OPEN)) {
    try {
      applyBudget(await apiCall('/api/budget'));
      return;
    } catch {}
  }
  applyBudget(null);
}
function applyBudgetBlock(blocked, budget) {
  if (blocked === state.budgetBlocked) return;
  state.budgetBlocked = blocked;
  updateCaptureAvailability();
  $('budgetBanner').classList.toggle('hidden', !blocked);
  if (blocked) {
    $('budgetBanner').textContent = budget.unavailable
      ? 'Usage protection is temporarily unavailable. Sharing is paused; try again shortly.'
      : `Bandwidth cap reached: ${budget.usedGb.toFixed(1)} of ${budget.capGb} GB used in the last ${budget.windowDays} days. New media is paused to protect the account.`;
    if (state.share) stopShare().catch(() => {});
  }
  for (const [id, t] of state.tiles) {
    if (!t.card.classList.contains('idle')) continue;
    const a = state.streams.get(id),
      b = t.idle.querySelector('.idle-watch');
    b.disabled = blocked || !(a?.sessionId && a?.videoTrackName);
  }
}
async function syncSnapshot(reason = 'poll') {
  if (P2P.active) {
    p2pHello().catch(() => {});
    p2pRebuild();
    return;
  }
  if (state.demo || state.leaving || !state.participantId || state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    const snap = await apiCall(`/api/rooms/${state.roomId}/snapshot`);
    await reconcileSnapshot(snap, reason);
  } finally {
    state.pollInFlight = false;
  }
}
async function poll() {
  if (state.leaving || !state.participantId) return;
  if (state.ws && state.ws.readyState === WebSocket.OPEN) return;
  if (document.hidden) {
    state.hiddenTicks = (state.hiddenTicks || 0) + 1;
    if (state.hiddenTicks % 4) return;
  } else state.hiddenTicks = 0;
  try {
    await syncSnapshot('poll');
  } catch (err) {
    log(`fallback sync failed: ${err.message}`, 'warn');
  }
}

function updateCaptureAvailability() {
  const supported =
    window.isSecureContext && typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  const ready =
    state.demo || (P2P.active && Boolean(P2P.mq)) || state.ws?.readyState === WebSocket.OPEN;
  $('shareBtn').disabled =
    !supported || !ready || state.budgetBlocked || capturePending || state.leaving;
  $('shareBtn').title = supported
    ? 'Choose a screen, window, or tab'
    : 'This browser can watch screens. Use a desktop browser to share.';
  $('captureHint').textContent = supported
    ? 'Your screen stays yours until you share.'
    : 'Watch here. Share from a supported desktop browser.';
  $('sharingHelp').textContent = !supported
    ? 'This browser can watch shared screens. To share your own, open this room on a supported desktop browser.'
    : state.share
      ? 'Stop sharing to change capture preferences.'
      : 'Quality preferences apply to the next share. Audio availability depends on your browser.';
  if (!supported) {
    $('emptyTitle').textContent = 'Your front row is ready.';
    $('emptyText').textContent =
      'Invite someone to share a screen. You can watch here, and share from a supported desktop browser.';
  }
}
async function startShare() {
  if (capturePending || state.share || $('shareBtn').disabled) return;
  capturePending = true;
  updateCaptureAvailability();
  try {
    await captureShare();
    renderPeople();
  } catch (error) {
    log(error.message, 'error');
    toast('Couldn’t share your screen. Capture has stopped. Try again.');
    await stopShare();
  } finally {
    capturePending = false;
    updateCaptureAvailability();
  }
}
function applySidebar(hidden) {
  $('room').classList.toggle('no-members', hidden);
  $('membersBtn').setAttribute('aria-expanded', String(!hidden));
  $('membersBtn').setAttribute('aria-label', hidden ? 'Show people' : 'Hide people');
}
function showRoomError(message) {
  $('roomError').classList.remove('hidden');
  $('roomErrorMessage').textContent = message;
  setStatus('Not connected', 'bad');
  updateCaptureAvailability();
}
function setRoomVisible() {
  $('home').classList.add('hidden');
  $('room').classList.remove('hidden');
  $('myName').value = state.name;
  $('displayName').value = state.name;
  $('roomCode').textContent = state.demo
    ? 'The preview room'
    : `Room ${state.roomId.slice(0, 4)} · ${state.roomId.slice(-4)}`;
  document.title = state.demo
    ? 'Room preview · SimpleShare'
    : `${$('roomCode').textContent} · SimpleShare`;
  $('inviteLink').value = state.demo
    ? location.origin + '/?demo=1'
    : canonicalInvite(location.href, state.roomId, connMode() === 'p2p');
  $('connMode').value = connMode();
  renderConnModeNote();
  state.volume = Math.max(0, Math.min(1, Number(storage.get('simpleshare-volume') ?? 0.8) || 0));
  $('volumeSlider').value = String(Math.round(state.volume * 100));
  applyGlobalVolume(state.volume);
  applySidebar(innerWidth < 768);
  renderPeople();
  renderGrid();
  updateCaptureAvailability();
}
function previewRoom() {
  state.demo = true;
  state.participantId = 'preview-you';
  state.name = 'You';
  state.roomId = 'preview';
  state.people = new Map(
    [
      { id: 'preview-you', name: 'You' },
      { id: 'preview-alex', name: 'Alex' },
      { id: 'preview-jules', name: 'Jules' },
    ].map((person) => [person.id, person]),
  );
  setRoomVisible();
  $('roomLabel').textContent = 'SAMPLE ROOM';
  $('previewBanner').classList.remove('hidden');
  setStatus('Preview', 'ok');
  $('connMode').disabled = true;
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#d76b45';
  ctx.fillRect(0, 0, 1280, 720);
  ctx.fillStyle = '#edbd78';
  ctx.beginPath();
  ctx.arc(1000, 215, 170, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = '#f5d49877';
  for (const radius of [240, 275]) {
    ctx.beginPath();
    ctx.arc(1000, 215, radius, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.fillStyle = '#753d30';
  ctx.beginPath();
  ctx.ellipse(470, 835, 1000, 420, -0.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#323c2c';
  ctx.beginPath();
  ctx.ellipse(1350, 850, 800, 380, 0.3, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#faf0d9';
  ctx.font = '52px Georgia';
  ctx.fillText('same screen.', 96, 322);
  ctx.font = 'italic 66px Georgia';
  ctx.fillText('good company.', 96, 404);
  ctx.font = '16px sans-serif';
  ctx.fillText('ILLUSTRATION · ROOM PREVIEW', 96, 650);
  const ann = {
    id: 'preview-art',
    ownerId: 'preview-alex',
    ownerName: 'Alex · Sample screen',
    profile: '720p30',
    audio: false,
  };
  state.streams.set(ann.id, ann);
  const tile = ensureTile(ann);
  tile.video.poster = canvas.toDataURL();
  tile.card.querySelector('.tile-name').textContent = 'Alex · Sample screen';
  tile.card.querySelector('.tile-meta').textContent = 'Illustration';
  tile.audioBtn.classList.add('hidden');
  tile.volumeWrap.classList.add('hidden');
  tile.card.querySelector('.tile-stop').classList.add('hidden');
  renderPeople();
  renderGrid();
  $('budget').textContent = 'Preview · No network connection';
}
async function boot() {
  if (booting) return;
  booting = true;
  const params = new URLSearchParams(location.search);
  try {
    if (params.get('demo') === '1' && !params.has('room')) {
      previewRoom();
      return;
    }
    if (!params.has('room')) return;
    const room = params.get('room');
    if (!ROOM_RE.test(room || '')) {
      toast('That room link isn’t valid. Paste a new invite below.');
      $('roomLink').focus();
      return;
    }
    state.roomId = room;
    state.name = storage.get('simpleshare-name') || `Guest ${randomId(1).toUpperCase()}`;
    setRoomVisible();
    $('roomError').classList.add('hidden');
    setStatus('Connecting…', 'warn');
    if (params.get('debug') === '1') {
      setLogLevel('debug');
      openLog();
    }
    if (connMode() === 'p2p') {
      try {
        await enterP2PMode('direct-link');
        updateCaptureAvailability();
      } catch (error) {
        p2pShutdown();
        showRoomError('Direct signaling couldn’t connect. Try again, or create a Cloudflare room.');
        log(error.message, 'error');
      }
      return;
    }
    let config;
    try {
      const response = await fetch('/api/config', { signal: AbortSignal.timeout(8000) });
      if (!response.ok) throw new Error('config');
      config = await response.json();
    } catch {
      showRoomError('The app configuration couldn’t load. Check your connection and try again.');
      return;
    }
    state.apiBase = normalizeBase(config.roomApiUrl);
    if (!state.apiBase) {
      showRoomError(
        'This deployment needs a room service. The owner can set ROOM_API_URL. You can also try a direct room and send its new link to everyone.',
      );
      return;
    }
    watchMediaCalls();
    try {
      const health = await apiCall('/health');
      if (!health.realtimeConfigured)
        throw new Error('The room service needs Cloudflare Realtime credentials.');
      await joinRoom();
      initTracks();
      renderPeople();
      renderGrid();
      if (!state.pollTimer) state.pollTimer = setInterval(() => poll().catch(() => {}), 2500);
      if (!state.watchdogTimer)
        state.watchdogTimer = setInterval(
          () => watchdog().catch((error) => log(error.message, 'warn')),
          8000,
        );
      if (!state.budgetTimer)
        state.budgetTimer = setInterval(() => tickBudget().catch(() => {}), 15000);
      await connectSocket();
    } catch (error) {
      log(error.message, 'error');
      showRoomError(
        error.status === 409
          ? 'This room has 10 people already. Ask someone to leave, or create a new room.'
          : error.message || 'Couldn’t connect. Check your connection and try again.',
      );
    }
  } catch (error) {
    log(error.message, 'error');
    showRoomError('Something interrupted the room. Try again.');
  } finally {
    booting = false;
    updateCaptureAvailability();
  }
}
function createRoom() {
  location.href = canonicalInvite(location.href, randomId(12));
}
async function copyInvite() {
  if (state.demo) {
    toast('This is a preview. Create a room to invite your people.');
    return;
  }
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
    await navigator.clipboard.writeText($('inviteLink').value);
    toast('Invite link copied. Bring your people.');
  } catch {
    const panel = $('settingsPanel');
    if (!panel.open) panel.showModal();
    const details = panel.querySelector('details');
    details.open = true;
    $('inviteLink').focus();
    $('inviteLink').select();
    toast('Couldn’t copy automatically. Your invite is selected in settings; copy it there.');
  }
}
function commitName(raw) {
  const name = String(raw || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 28);
  if (!name) {
    $('myName').value = state.name;
    $('displayName').value = state.name;
    return;
  }
  state.name = name;
  storage.set('simpleshare-name', name);
  $('myName').value = name;
  $('displayName').value = name;
  const self = state.people.get(state.participantId);
  if (self) self.name = name;
  if (state.ws?.readyState === WebSocket.OPEN)
    state.ws.send(JSON.stringify({ type: 'rename', name }));
  if (P2P.active) p2pHello().catch(() => {});
  if (state.share && state.reannounce && !state.demo && !P2P.active)
    state.reannounce().catch((error) => log(error.message, 'warn'));
  renderPeople();
  refreshVisibleNames();
}
function clearRoomTimers() {
  clearSocketTimers();
  clearTimeout(state.pcRecoverTimer);
  clearTimeout(scheduleImmediateSync._t);
  clearTimeout(announceTimer);
  for (const timer of ['pollTimer', 'watchdogTimer', 'budgetTimer']) {
    clearInterval(state[timer]);
    state[timer] = null;
  }
}
function notifyLeave() {
  if (!state.apiBase || state.demo || P2P.active || !state.participantId) return;
  fetch(`${state.apiBase}/api/rooms/${state.roomId}/leave`, {
    method: 'POST',
    keepalive: true,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(envelope()),
  }).catch(() => {});
}
async function leaveRoom() {
  if (state.leaving) return;
  state.leaving = true;
  clearRoomTimers();
  notifyLeave();
  // Capture stops synchronously at the beginning of stopShare, before any network call.
  await Promise.race([stopShare(), new Promise((resolve) => setTimeout(resolve, 1000))]);
  if (P2P.active) p2pShutdown();
  for (const id of [...state.subs.keys()]) await teardownSubscription(id);
  try {
    state.ws?.close();
  } catch {}
  location.href = '/';
}
setupAppearance();
$('createBtn').addEventListener('click', createRoom);
$('demoCreateBtn').addEventListener('click', createRoom);
$('joinForm').addEventListener('submit', (event) => {
  event.preventDefault();
  try {
    const invite = parseRoomInvite($('roomLink').value, location.href);
    $('joinError').textContent = '';
    $('roomLink').removeAttribute('aria-invalid');
    location.href = canonicalInvite(location.href, invite.room, invite.direct);
  } catch (error) {
    $('joinError').textContent = error.message;
    $('roomLink').setAttribute('aria-invalid', 'true');
    $('roomLink').focus();
  }
});
$('shareBtn').addEventListener('click', () => startShare());
$('stopBtn').addEventListener('click', () =>
  stopShare()
    .then(() => {
      renderPeople();
      updateCaptureAvailability();
    })
    .catch((error) => log(error.message, 'warn')),
);
const settings = $('settingsPanel');
$('settingsBtn').addEventListener('click', () => settings.showModal());
$('settingsCloseBtn').addEventListener('click', () => settings.close());
settings.addEventListener('click', (event) => {
  if (event.target !== settings) return;
  const bounds = settings.getBoundingClientRect();
  if (
    event.clientX < bounds.left ||
    event.clientX > bounds.right ||
    event.clientY < bounds.top ||
    event.clientY > bounds.bottom
  )
    settings.close();
});
$('membersBtn').addEventListener('click', () =>
  applySidebar(!$('room').classList.contains('no-members')),
);
$('membersCloseBtn').addEventListener('click', () => {
  applySidebar(true);
  $('membersBtn').focus();
});
$('audioBtn').addEventListener('click', toggleAllAudio);
$('leaveDockBtn').addEventListener('click', () => leaveRoom());
for (const id of ['copyBtn', 'copyBtnSettings', 'emptyInviteBtn', 'sidebarInviteBtn'])
  $(id).addEventListener('click', copyInvite);
for (const id of ['myName', 'displayName']) {
  $(id).addEventListener('change', (event) => commitName(event.target.value));
  $(id).addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      commitName(event.target.value);
      event.target.blur();
    }
  });
}
$('volumeSlider').addEventListener('input', (event) =>
  applyGlobalVolume(Number(event.target.value) / 100),
);
$('sfxToggle').checked = soundsEnabled();
$('sfxToggle').addEventListener('change', (event) => {
  setSoundsEnabled(event.target.checked);
  unlockSounds();
  playSound('room-join');
});
$('connMode').addEventListener('change', (event) => {
  if (state.demo) return;
  if (state.share) {
    event.target.value = connMode();
    toast('Stop sharing before changing the connection.');
    return;
  }
  location.href = canonicalInvite(location.href, state.roomId, event.target.value === 'p2p');
});
$('retryBtn').addEventListener('click', () => {
  if (state.participantId && !P2P.active) {
    $('roomError').classList.add('hidden');
    recoverConnection().catch((error) => showRoomError(error.message));
  } else boot();
});
$('directBtn').addEventListener('click', () => {
  location.href = canonicalInvite(location.href, state.roomId, true);
});
$('logBtn').addEventListener('click', () => setLogVisible($('logPanel').hidden));
$('logClose').addEventListener('click', () => {
  setLogVisible(false);
  $('logBtn').focus();
});
$('settingsLogBtn').addEventListener('click', () => {
  settings.close();
  openLog();
});
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (!$('logPanel').hidden) {
      setLogVisible(false);
      $('logBtn').focus();
    } else if (state.focusedId) setFocus(null);
  }
});
window.addEventListener('offline', () => {
  if (state.demo) return;
  setStatus('Offline', 'bad');
  updateCaptureAvailability();
});
function wakeRoom(reason) {
  if (state.demo || !state.roomId || !state.participantId || state.leaving) return;
  grantWatchdogGrace();
  probeSocket(reason);
  scheduleImmediateSync(reason);
}
window.addEventListener('online', () => {
  state.reconnectAttempts = 0;
  wakeRoom('online');
});
window.addEventListener('focus', () => wakeRoom('focus'));
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    state.hiddenAt = Date.now();
    return;
  }
  state.hiddenTicks = 0;
  wakeRoom('visible');
});
document.addEventListener('resume', () => wakeRoom('resume'));
document.addEventListener(
  'pointerdown',
  () => {
    state.audioUnlocked = true;
    unlockSounds();
  },
  { once: true, capture: true },
);
window.addEventListener('pagehide', (event) => {
  if (event.persisted) {
    clearSocketTimers();
    try {
      state.ws?.close();
    } catch {}
    return;
  }
  state.leaving = true;
  clearRoomTimers();
  notifyLeave();
  if (P2P.active) p2pShutdown();
  state.share?.media.getTracks().forEach((track) => track.stop());
  try {
    state.ws?.close();
  } catch {}
});
window.addEventListener('pageshow', (event) => {
  if (!event.persisted || state.demo || !state.participantId) return;
  state.leaving = false;
  state.reconnectAttempts = 0;
  wakeRoom('restored');
});
boot();
