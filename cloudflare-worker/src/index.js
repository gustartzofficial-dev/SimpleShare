import { routePartyTracksRequest } from "partytracks/server";

const ROOM_RE = /^[A-Za-z0-9_-]{20,80}$/;
const PARTICIPANT_RE = /^[a-f0-9-]{20,80}$/i;
const MAX_PARTICIPANTS = 10;
const RTC_BASE = 'https://rtc.live.cloudflare.com/v1/apps';

// Connection lifecycle timing.
//
// GRACE_MS must be LONGER than the client's full reconnect ladder, otherwise a
// participant gets swept while its browser is still politely backing off, and
// every subsequent /socket returns 401 with no way for the browser to see the
// status code. The client ladder now tops out around 45s, so 60s here.
const GRACE_MS = 60_000;
// A participant that joined but never opened a socket at all.
const NEVER_CONNECTED_MS = 45_000;
// How often the room wakes to sweep, account egress, and ping clients.
//
// The tick used to be a flat 15s regardless of what the room was doing. Every
// wake is a billed Durable Object request, and a room where nobody is sharing
// has nothing to account for -- egress is zero, so a fast tick buys nothing but
// requests. Split it: fast while media is actually flowing or a sweep is
// pending, slow otherwise. `armAlarm` only ever moves the alarm EARLIER, so
// anything that starts media must arm the active cadence explicitly.
const TICK_ACTIVE_MS = 15_000;
const TICK_IDLE_MS = 60_000;
// Reported by /health.
const TICK_MS = TICK_ACTIVE_MS;
// When no stream has viewers, the budget total cannot move, so re-reading it
// from BudgetTracker on every tick is pure waste. Cache it this long.
const BUDGET_IDLE_REFRESH_MS = 300_000;

const json = (data, status = 200, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
});

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization,X-Room,X-Participant-Id,X-Participant-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function randomId(bytes = 16) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map(v => v.toString(16).padStart(2, '0')).join('');
}

function safeName(value) {
  const s = String(value || '').trim().replace(/\s+/g, ' ').slice(0, 28);
  return s || `Guest ${randomId(2).toUpperCase()}`;
}

async function readJson(request) {
  try { return await request.json(); } catch { return {}; }
}

// Ceilings used for accounting. Deliberately the MAXIMUM each profile can send,
// so we overestimate and cut off early rather than late.
const PROFILE_BPS = { '720p30': 2_500_000, '720p60': 4_000_000, '1080p60': 8_000_000 };

const budgetStub = (env) => env.BUDGET.get(env.BUDGET.idFromName('global'));

/*
  Hard spending guard.

  Cloudflare bills on YOUR ACCOUNT'S BILLING CYCLE, not the calendar month --
  the start date is whenever the first purchase on the account happened. So a
  calendar-month counter is unsafe: it could reset on the 1st while Cloudflare's
  window still holds most of a month's usage, letting a single billing period
  accumulate close to double the cap.

  Instead this tracks a ROLLING 31-DAY TOTAL in daily buckets. Since every
  monthly billing window is at most 31 days, keeping every rolling 31-day window
  under the cap guarantees every billing window is under it too -- whatever date
  the cycle happens to start on. No configuration, no guessing.

  Trade-off: usage ages out gradually over 31 days rather than vanishing at a
  reset, so this is more conservative than a true monthly allowance.
*/
export class BudgetTracker {
  constructor(ctx, env) { this.ctx = ctx; this.env = env; }

  static dayKey(ms) { return new Date(ms).toISOString().slice(0, 10); }

  async buckets() {
    return (await this.ctx.storage.get('daily')) || {};
  }

  // Sum of the trailing WINDOW_DAYS days, inclusive of today.
  summarize(daily) {
    const windowDays = 31;
    const now = Date.now();
    const cutoff = now - (windowDays - 1) * 86_400_000;
    const cutoffKey = BudgetTracker.dayKey(cutoff);
    let bytes = 0;
    for (const [day, value] of Object.entries(daily)) {
      if (day >= cutoffKey) bytes += Number(value) || 0;
    }
    return { bytes, windowDays, windowStart: cutoffKey, today: BudgetTracker.dayKey(now) };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const capGb = Math.max(1, Number(this.env.MONTHLY_EGRESS_CAP_GB || 900));
    let daily = await this.buckets();

    if (url.pathname === '/add' && request.method === 'POST') {
      const body = await readJson(request);
      const bytes = Number(body.bytes);
      if (Number.isFinite(bytes) && bytes > 0) {
        const today = BudgetTracker.dayKey(Date.now());
        daily[today] = (Number(daily[today]) || 0) + bytes;
        // Keep ~45 days so the trailing window always has full history,
        // and the record can never grow without bound.
        const keepFrom = BudgetTracker.dayKey(Date.now() - 45 * 86_400_000);
        for (const day of Object.keys(daily)) if (day < keepFrom) delete daily[day];
        await this.ctx.storage.put('daily', daily);
      }
    }

    if (url.pathname === '/reset' && request.method === 'POST') {
      daily = {};
      await this.ctx.storage.put('daily', daily);
    }

    const { bytes, windowDays, windowStart, today } = this.summarize(daily);
    const usedGb = bytes / 1e9;
    return json({
      usedGb: Math.round(usedGb * 1000) / 1000,
      capGb,
      remainingGb: Math.max(0, Math.round((capGb - usedGb) * 1000) / 1000),
      percent: Math.min(100, Math.round((usedGb / capGb) * 1000) / 10),
      blocked: usedGb >= capGb,
      windowDays,
      windowStart,
      today,
      basis: 'rolling',
    });
  }
}

export class RoomHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    // Answer client heartbeats in the runtime itself so a ping does not have to
    // wake the Durable Object. Must match the client's exact serialization.
    try {
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(JSON.stringify({ type: 'ping' }), JSON.stringify({ type: 'pong' }))
      );
    } catch {}
  }

  // A participant can only ever have ONE live stream. The client used to mint a
  // fresh random streamId on every startShare, and nothing removed the previous
  // record -- so a reload, tab crash, or re-share left the old entry orphaned in
  // the room forever, pointing at a session that no longer exists. Viewers saw
  // two, three, four tiles from one person with only the newest one working.
  // Evicting here makes the server authoritative regardless of client version.
  evictOtherStreams(state, ownerId, keepStreamId) {
    const dropped = [];
    for (const [id, stream] of Object.entries(state.streams)) {
      if (id === keepStreamId || stream.ownerId !== ownerId) continue;
      delete state.streams[id];
      dropped.push(id);
    }
    return dropped;
  }

  async getState() {
    const state = (await this.ctx.storage.get('state')) || { participants: {}, streams: {}, sessions: {} };
    if (typeof state.rev !== 'number') state.rev = 0;
    return state;
  }

  // Every mutation bumps a monotonic revision. Clients use it to discard
  // snapshots that were already in flight when a newer event overtook them --
  // the race that used to tear down a subscription the socket had just built.
  async putState(state) {
    state.rev = (state.rev || 0) + 1;
    await this.ctx.storage.put('state', state);
    return state.rev;
  }

  // The DO has a single alarm slot, so a plain setAlarm can push a pending
  // sweep further out. Only ever move the alarm EARLIER.
  async armAlarm(ms) {
    try {
      const at = Date.now() + ms;
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > at) await this.ctx.storage.setAlarm(at);
    } catch {}
  }

  sockets() {
    return this.ctx.getWebSockets();
  }

  send(ws, payload) {
    try { ws.send(JSON.stringify(payload)); } catch {}
  }

  broadcast(payload, exceptId = null) {
    const message = JSON.stringify(payload);
    for (const ws of this.sockets()) {
      const attachment = ws.deserializeAttachment() || {};
      if (exceptId && attachment.participantId === exceptId) continue;
      try { ws.send(message); } catch {}
    }
  }

  publicSnapshot(state) {
    return {
      rev: state.rev || 0,
      participants: Object.values(state.participants).map(({ token, ...p }) => p),
      streams: Object.values(state.streams),
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const method = request.method.toUpperCase();

    if (method === 'POST' && url.pathname === '/join') {
      const body = await readJson(request);
      const state = await this.getState();
      const now = Date.now();
      const liveSocketIds = new Set(this.sockets().map(ws => (ws.deserializeAttachment() || {}).participantId).filter(Boolean));

      // Sweep ghosts. A participant is gone if it has no live socket AND either
      // its grace period expired, or it never opened a socket at all within 30s.
      for (const [id, p] of Object.entries(state.participants)) {
        if (liveSocketIds.has(id)) continue;
        const expired = p.disconnectedAt ? (now - p.disconnectedAt > GRACE_MS) : (now - p.joinedAt > NEVER_CONNECTED_MS);
        if (!expired) continue;
        delete state.participants[id];
        for (const [streamId, stream] of Object.entries(state.streams)) if (stream.ownerId === id) delete state.streams[streamId];
        for (const [sid, owner] of Object.entries(state.sessions)) if (owner === id) delete state.sessions[sid];
      }

      // RESUME. Every page refresh used to mint a brand-new participant via
      // crypto.randomUUID(), so reloading piled up ghost members -- and once ten
      // accumulated, /join returned "Room is full" and the room looked dead.
      // A client that presents a still-valid id + token keeps its identity.
      const resumeId = typeof body.participantId === 'string' ? body.participantId : '';
      const resumeToken = typeof body.token === 'string' ? body.token : '';
      const existing = resumeId ? state.participants[resumeId] : null;
      if (existing && existing.token === resumeToken) {
        existing.joinedAt = now;
        delete existing.disconnectedAt;
        if (body.name) existing.name = safeName(body.name);
        await this.putState(state);
        return json({
          participantId: resumeId,
          token: resumeToken,
          resumed: true,
          mode: 'cloud',
          snapshot: this.publicSnapshot(state),
        });
      }

      // Members inside their grace window don't count toward the cap; they are
      // reconnecting, not occupying a seat.
      const active = Object.values(state.participants).filter(p => !p.disconnectedAt).length;
      // FORCED TO CLOUD. The old logic made room mode sticky to whatever the FIRST
      // participant requested, so a single direct-mode join permanently locked the
      // room out of the Cloudflare Realtime SFU path for everyone else. Direct
      // (P2P) mode is retired; every room is a cloud room.
      const roomMode = 'cloud';
      const limit = MAX_PARTICIPANTS;
      if (active >= limit) return json({ error: `Room is full (${limit} participants maximum in ${roomMode} mode).` }, 409);
      const participantId = crypto.randomUUID();
      const token = randomId(24);
      state.participants[participantId] = {
        id: participantId,
        token,
        name: safeName(body.name),
        joinedAt: now,
        mode: roomMode,
      };
      await this.putState(state);
      return json({ participantId, token, mode: roomMode, snapshot: this.publicSnapshot(state) });
    }

    if (method === 'POST' && url.pathname === '/auth') {
      const body = await readJson(request);
      const state = await this.getState();
      const p = state.participants[body.participantId];
      const ok = Boolean(p && p.token === body.token);
      const ownsSession = !body.sessionId || state.sessions[body.sessionId] === body.participantId;
      return json({ ok: ok && ownsSession, participant: ok ? { id: p.id, name: p.name, mode: p.mode } : null });
    }

    if (method === 'POST' && url.pathname === '/register-session') {
      const body = await readJson(request);
      const state = await this.getState();
      const p = state.participants[body.participantId];
      if (!p || p.token !== body.token) return json({ error: 'Unauthorized' }, 401);
      if (typeof body.sessionId !== 'string' || !body.sessionId) return json({ error: 'Invalid session' }, 400);
      state.sessions[body.sessionId] = body.participantId;
      await this.putState(state);
      return json({ ok: true });
    }

    if (method === 'POST' && url.pathname === '/can-pull') {
      const body = await readJson(request);
      const state = await this.getState();
      const p = state.participants[body.participantId];
      if (!p || p.token !== body.token) return json({ ok: false }, 401);
      const allowed = new Set(Object.values(state.streams).map(s => s.sessionId).filter(Boolean));
      const sessions = Array.isArray(body.remoteSessionIds) ? body.remoteSessionIds : [];
      return json({ ok: sessions.every(id => allowed.has(id)) });
    }

    if (method === 'POST' && url.pathname === '/stream-upsert') {
      const body = await readJson(request);
      const state = await this.getState();
      const participant = state.participants[body.participantId];
      if (!participant || participant.token !== body.token) return json({ error: 'Unauthorized' }, 401);
      const streamId = String(body.stream?.id || '').slice(0, 100);
      if (!streamId) return json({ error: 'Invalid stream.' }, 400);
      const stream = {
        id: streamId,
        ownerId: participant.id,
        ownerName: participant.name,
        mode: participant.mode,
        sessionId: typeof body.stream.sessionId === 'string' ? body.stream.sessionId : null,
        videoTrackName: typeof body.stream.videoTrackName === 'string' ? body.stream.videoTrackName : null,
        audioTrackName: typeof body.stream.audioTrackName === 'string' ? body.stream.audioTrackName : null,
        profile: ['720p30', '720p60', '1080p60'].includes(body.stream.profile) ? body.stream.profile : '720p30',
        audio: Boolean(body.stream.audio),
        startedAt: Date.now(),
      };
      const superseded = this.evictOtherStreams(state, participant.id, streamId);
      state.streams[streamId] = stream;
      const rev = await this.putState(state);
      for (const id of superseded) this.broadcast({ type:'stream-remove', streamId: id, rev });
      this.broadcast({ type:'stream-upsert', stream, rev });
      await this.armAlarm(TICK_ACTIVE_MS);
      return json({ ok:true, stream, rev, superseded });
    }

    if (method === 'POST' && url.pathname === '/stream-remove') {
      const body = await readJson(request);
      const state = await this.getState();
      const participant = state.participants[body.participantId];
      if (!participant || participant.token !== body.token) return json({ error: 'Unauthorized' }, 401);
      const streamId = String(body.streamId || '');
      if (state.streams[streamId]?.ownerId !== participant.id) return json({ error:'Stream not found.' }, 404);
      delete state.streams[streamId];
      const rev = await this.putState(state);
      this.broadcast({ type:'stream-remove', streamId, rev });
      return json({ ok:true, rev });
    }

    if (url.pathname === '/socket') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected websocket', { status: 426 });
      const participantId = url.searchParams.get('id') || '';
      const token = url.searchParams.get('token') || '';
      const state = await this.getState();
      const participant = state.participants[participantId];
      if (!participant || participant.token !== token) return new Response('Unauthorized', { status: 401 });

      if (participant.disconnectedAt) {
        delete participant.disconnectedAt;
        await this.putState(state);
      }
      if (!state.lastAccountedAt) { state.lastAccountedAt = Date.now(); await this.putState(state); }
      await this.armAlarm(TICK_ACTIVE_MS);

      // A reconnecting browser can leave a half-open socket behind that the
      // runtime has not reaped yet. Two live sockets for one participant means
      // duplicated broadcasts, and the stale one's close event later races the
      // fresh one's liveness check. Retire it explicitly.
      for (const old of this.sockets()) {
        if ((old.deserializeAttachment() || {}).participantId !== participantId) continue;
        try { old.close(4001, 'superseded by a newer connection'); } catch {}
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.serializeAttachment({ participantId });
      this.ctx.acceptWebSocket(server);
      // Ship the budget with the opening snapshot so a fresh client never has to
      // fetch /api/budget even once. Cached, so this is usually free.
      this.send(server, { type: 'snapshot', ...this.publicSnapshot(state), budget: await this.budgetSummary() });
      this.broadcast({ type: 'participant-joined', rev: state.rev || 0, participant: { id: participant.id, name: participant.name, joinedAt: participant.joinedAt, mode: participant.mode } }, participantId);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (method === 'GET' && url.pathname === '/snapshot') {
      const state = await this.getState();
      return json(this.publicSnapshot(state));
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws, raw) {
    const attachment = ws.deserializeAttachment() || {};
    const participantId = attachment.participantId;
    if (!participantId) return;
    let msg;
    try { msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw)); } catch { return; }
    const state = await this.getState();
    const participant = state.participants[participantId];
    if (!participant) return;

    if (msg.type === 'ping') {
      this.send(ws, { type: 'pong', at: Date.now() });
      return;
    }

    // Viewers report which streams they actually have open. Billing is per
    // stream-viewer, so with opt-in watching the old "everyone sees everything"
    // assumption massively overestimated cost.
    if (msg.type === 'watching') {
      const ids = Array.isArray(msg.streamIds) ? msg.streamIds.slice(0, 20).map(v => String(v).slice(0, 100)) : [];
      const before = new Set(Array.isArray(participant.watching) ? participant.watching : []);
      const after = new Set(ids);
      const opened = ids.filter(id => !before.has(id));
      const closed = [...before].filter(id => !after.has(id));
      participant.watching = ids;
      if (!opened.length && !closed.length) return;
      const rev = await this.putState(state);
      // Watcher changes were previously stored and never announced, so peers only
      // learned about them from the next 2.5s poll -- far too coarse to drive a
      // join/leave chime. Announce the delta instead.
      this.broadcast({
        type: 'watching-changed', rev,
        participantId: participant.id,
        participantName: participant.name,
        opened, closed,
      }, participant.id);
      // A viewer opening a tile is what makes a stream billable, so accounting
      // has to be at the fast cadence from this moment, not from the next tick.
      if (opened.length) await this.armAlarm(TICK_ACTIVE_MS);
      return;
    }

    if (msg.type === 'rename') {
      participant.name = safeName(msg.name);
      const rev = await this.putState(state);
      this.broadcast({ type: 'participant-updated', rev, participant: { id: participant.id, name: participant.name, joinedAt: participant.joinedAt, mode: participant.mode } });
      return;
    }

    if (msg.type === 'stream-upsert') {
      const streamId = String(msg.stream?.id || '').slice(0, 100);
      if (!streamId) return;
      const stream = {
        id: streamId,
        ownerId: participantId,
        ownerName: participant.name,
        mode: participant.mode,
        sessionId: typeof msg.stream.sessionId === 'string' ? msg.stream.sessionId : null,
        videoTrackName: typeof msg.stream.videoTrackName === 'string' ? msg.stream.videoTrackName : null,
        audioTrackName: typeof msg.stream.audioTrackName === 'string' ? msg.stream.audioTrackName : null,
        profile: ['720p30', '720p60', '1080p60'].includes(msg.stream.profile) ? msg.stream.profile : '720p30',
        audio: Boolean(msg.stream.audio),
        startedAt: Date.now(),
      };
      const superseded = this.evictOtherStreams(state, participant.id, streamId);
      state.streams[streamId] = stream;
      const rev = await this.putState(state);
      for (const id of superseded) this.broadcast({ type: 'stream-remove', streamId: id, rev });
      this.broadcast({ type: 'stream-upsert', stream, rev });
      await this.armAlarm(TICK_ACTIVE_MS);
      return;
    }

    if (msg.type === 'stream-remove') {
      const streamId = String(msg.streamId || '');
      if (state.streams[streamId]?.ownerId !== participantId) return;
      delete state.streams[streamId];
      const rev = await this.putState(state);
      this.broadcast({ type: 'stream-remove', streamId, rev });
      return;
    }

    if (msg.type === 'signal' && PARTICIPANT_RE.test(String(msg.target || ''))) {
      const target = String(msg.target);
      const packet = { type: 'signal', from: participantId, signal: msg.signal };
      for (const peer of this.sockets()) {
        const a = peer.deserializeAttachment() || {};
        if (a.participantId === target) this.send(peer, packet);
      }
      return;
    }

    if (msg.type === 'quality-request' && PARTICIPANT_RE.test(String(msg.target || ''))) {
      const target = String(msg.target);
      const packet = { type: 'quality-request', from: participantId, quality: msg.quality || 'auto' };
      for (const peer of this.sockets()) {
        const a = peer.deserializeAttachment() || {};
        if (a.participantId === target) this.send(peer, packet);
      }
    }
  }

  async removeParticipant(participantId) {
    const state = await this.getState();
    if (!state.participants[participantId]) return;
    delete state.participants[participantId];
    const removedStreams = [];
    for (const [id, stream] of Object.entries(state.streams)) {
      if (stream.ownerId === participantId) {
        removedStreams.push(id);
        delete state.streams[id];
      }
    }
    for (const [sid, owner] of Object.entries(state.sessions)) if (owner === participantId) delete state.sessions[sid];
    const rev = await this.putState(state);
    this.broadcast({ type: 'participant-left', participantId, removedStreams, rev });
  }

  // A closed socket used to delete the participant immediately. That made every
  // reconnect return 401 (the token no longer matched anyone) AND killed every
  // PartyTracks request, which retries 401s forever without surfacing an error.
  // One brief network blip therefore bricked the whole session silently.
  // Now a disconnect starts a 25s grace period instead.
  // `closingWs` matters: during webSocketClose the runtime may still list the
  // socket that is going away in getWebSockets(). Without excluding it, the
  // liveness check saw "still live", never set disconnectedAt, and the alarm --
  // which only sweeps participants that HAVE disconnectedAt -- never collected
  // them. That is where the permanent ghosts and "Room is full" came from.
  async markDisconnected(participantId, closingWs = null) {
    const stillLive = this.sockets().some(ws =>
      ws !== closingWs &&
      ws.readyState === 1 && // OPEN
      (ws.deserializeAttachment() || {}).participantId === participantId
    );
    if (stillLive) return;
    const state = await this.getState();
    const p = state.participants[participantId];
    if (!p || p.disconnectedAt) return;
    p.disconnectedAt = Date.now();
    await this.putState(state);
    await this.armAlarm(TICK_MS);
  }

  // Estimated egress since the last tick: every live stream costs
  // (its bitrate x number of viewers). The sender itself is free -- Cloudflare
  // only bills traffic going OUT to clients.
  async accountEgress(state) {
    const now = Date.now();
    const last = state.lastAccountedAt || now;
    state.lastAccountedAt = now;
    const seconds = Math.max(0, Math.min(180, (now - last) / 1000));
    if (seconds <= 0) return;

    let bitsPerSecond = 0;
    for (const stream of Object.values(state.streams)) {
      if (!stream.sessionId || !stream.videoTrackName) continue;
      // Count only participants who actually have this stream open.
      let viewers = 0;
      for (const p of Object.values(state.participants)) {
        if (p.id === stream.ownerId) continue;
        if (Array.isArray(p.watching) && p.watching.includes(stream.id)) viewers += 1;
      }
      if (!viewers) continue;
      bitsPerSecond += (PROFILE_BPS[stream.profile] || PROFILE_BPS['720p30']) * viewers;
    }
    this.billing = bitsPerSecond > 0;
    if (bitsPerSecond <= 0) return;

    const bytes = (bitsPerSecond / 8) * seconds;
    try {
      // BudgetTracker answers /add with the full rolling summary. We used to
      // throw that away and let every client fetch the same numbers back over
      // /api/budget on its own 15s timer. Keep it instead and push it out on
      // the socket -- one DO call for the whole room rather than one per person.
      const response = await budgetStub(this.env).fetch('https://budget/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bytes }),
      });
      this.budgetCache = await response.json();
      this.budgetCacheAt = Date.now();
    } catch {}
  }

  // The value clients render. Refreshed for free whenever media is flowing
  // (accountEgress already round-trips to BudgetTracker); otherwise re-read at
  // most once every BUDGET_IDLE_REFRESH_MS, because an idle room's total is
  // constant by definition.
  async budgetSummary() {
    const now = Date.now();
    if (this.budgetCache && now - (this.budgetCacheAt || 0) < BUDGET_IDLE_REFRESH_MS) return this.budgetCache;
    try {
      const response = await budgetStub(this.env).fetch('https://budget/');
      this.budgetCache = await response.json();
      this.budgetCacheAt = now;
    } catch {}
    return this.budgetCache || null;
  }

  async alarm() {
    const state = await this.getState();
    await this.accountEgress(state);
    await this.putState(state);
    // Server -> client keepalive. Browsers throttle setInterval to roughly once
    // a minute in a hidden tab, so a client-only heartbeat is not enough to keep
    // intermediate proxies from idling the connection out. Inbound frames are
    // not throttled, so this is what actually holds a backgrounded tab open.
    //
    // It now also carries `rev` and `budget`, which is what lets the client stop
    // polling. Outbound WebSocket frames are not billed, so both ride along for
    // free: the client compares `rev` to what it has applied and only fetches a
    // snapshot when they actually diverge, and reads the budget straight off
    // this message instead of hitting /api/budget on a timer.
    this.broadcast({
      type: 'server-ping',
      at: Date.now(),
      rev: state.rev || 0,
      budget: await this.budgetSummary(),
    });

    const liveIds = new Set(this.sockets().map(ws => (ws.deserializeAttachment() || {}).participantId).filter(Boolean));
    const cutoff = Date.now() - GRACE_MS;
    let changed = false, stillPending = false;
    for (const [id, p] of Object.entries(state.participants)) {
      if (liveIds.has(id)) {
        if (p.disconnectedAt) { delete p.disconnectedAt; changed = true; }
        continue;
      }
      if (!p.disconnectedAt) continue;
      if (p.disconnectedAt < cutoff) {
        delete state.participants[id];
        const removedStreams = [];
        for (const [sid, stream] of Object.entries(state.streams)) {
          if (stream.ownerId === id) { removedStreams.push(sid); delete state.streams[sid]; }
        }
        for (const [sid, owner] of Object.entries(state.sessions)) if (owner === id) delete state.sessions[sid];
        this.broadcast({ type: 'participant-left', participantId: id, removedStreams, rev: (state.rev || 0) + 1 });
        changed = true;
      } else stillPending = true;
    }
    if (changed) await this.putState(state);

    // Rooms are ephemeral: once the last person is gone, wipe the room outright
    // rather than leaving state behind for whoever opens the link next.
    if (Object.keys(state.participants).length === 0 && this.sockets().length === 0) {
      await this.ctx.storage.deleteAll();
      return;
    }
    // Keep ticking while anyone is here, so accounting stays current. Fast only
    // when it earns its keep: billable media in flight, or a disconnect waiting
    // out its grace period.
    const occupied = Object.keys(state.participants).length > 0 || this.sockets().length > 0;
    const next = (this.billing || stillPending) ? TICK_ACTIVE_MS : TICK_IDLE_MS;
    if (occupied || stillPending) await this.armAlarm(next);
  }

  async webSocketClose(ws) {
    const { participantId } = ws.deserializeAttachment() || {};
    if (participantId) await this.markDisconnected(participantId, ws);
  }

  async webSocketError(ws) {
    const { participantId } = ws.deserializeAttachment() || {};
    if (participantId) await this.markDisconnected(participantId, ws);
  }
}


/* ==================================================================== *
   P2P FALLBACK — signaling that touches no Durable Object.

   The Durable Object IS the signaling layer: /join and /socket both live
   inside RoomHub. So when DO requests run out, the room does not merely
   lose its SFU -- it loses the ability to introduce two browsers to each
   other at all, which is exactly what peer-to-peer needs.

   Durable Objects and D1 have SEPARATE daily budgets on the free plan
   (100,000 DO requests, 100,000 D1 rows written). This path therefore
   still works after the DO budget is gone. It swaps the WebSocket for
   short polling, because holding a socket open requires a DO.

   Media in this mode never touches Cloudflare Realtime, so it generates
   no egress and cannot cost money. The trade is that the sharer uploads
   one copy per viewer, and there is no TURN relay, so peers behind
   symmetric NAT will fail rather than fall back.
 * ==================================================================== */
const P2P_STALE_MS = 45_000;
const P2P_SIGNAL_TTL_MS = 120_000;
const P2P_HEARTBEAT_MS = 6_000;

const p2pQuotaHint = (m) => /exceeded allowed volume|daily request limit|free tier|too many subrequests/i.test(String(m || ''));

async function p2pSnapshot(env, room) {
  const [people, streams] = await env.DB.batch([
    env.DB.prepare('SELECT id, name, joined_at AS joinedAt FROM p2p_participants WHERE room=?1 ORDER BY joined_at').bind(room),
    env.DB.prepare('SELECT id, owner_id AS ownerId, owner_name AS ownerName, profile, audio, started_at AS startedAt FROM p2p_streams WHERE room=?1').bind(room),
  ]);
  return {
    participants: (people.results || []).map(p => ({ ...p, mode: 'p2p' })),
    streams: (streams.results || []).map(s => ({ ...s, audio: Boolean(s.audio), mode: 'p2p', p2p: true })),
  };
}

async function p2pAuth(env, room, id, token) {
  if (!id || !token) return null;
  return env.DB.prepare('SELECT id, name FROM p2p_participants WHERE room=?1 AND id=?2 AND token=?3')
    .bind(room, String(id), String(token)).first();
}

// Swept opportunistically rather than on a schedule -- there is no alarm here,
// and running it on every sync would burn row writes for nothing.
async function p2pSweep(env, room, now) {
  try {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM p2p_participants WHERE room=?1 AND last_seen<?2').bind(room, now - P2P_STALE_MS),
      env.DB.prepare('DELETE FROM p2p_streams WHERE room=?1 AND owner_id NOT IN (SELECT id FROM p2p_participants WHERE room=?1)').bind(room),
      env.DB.prepare('DELETE FROM p2p_signals WHERE created_at<?1').bind(now - P2P_SIGNAL_TTL_MS),
    ]);
  } catch {}
}

async function p2pHandle(request, env, action, cors) {
  if (!env.DB) return json({ error: 'P2P fallback is not configured: no D1 binding on this Worker.', code: 'p2p-unconfigured' }, 501, cors);
  const body = await readJson(request);
  const room = String(body.room || '');
  if (!ROOM_RE.test(room)) return json({ error: 'Invalid room.' }, 400, cors);
  const now = Date.now();

  if (action === 'join') {
    const name = safeName(body.name);
    await p2pSweep(env, room, now);
    // Resume keeps your identity across a reload, same contract as RoomHub.
    const resumeId = String(body.participantId || ''), resumeToken = String(body.token || '');
    if (resumeId && resumeToken) {
      const r = await env.DB.prepare('UPDATE p2p_participants SET last_seen=?3, name=?4 WHERE room=?1 AND id=?2 AND token=?5')
        .bind(room, resumeId, now, name, resumeToken).run();
      if ((r.meta?.changes || 0) > 0) {
        return json({ participantId: resumeId, token: resumeToken, resumed: true, mode: 'p2p', cursor: 0, ...(await p2pSnapshot(env, room)) }, 200, cors);
      }
    }
    const row = await env.DB.prepare('SELECT COUNT(*) AS c FROM p2p_participants WHERE room=?1').bind(room).first();
    if ((row?.c || 0) >= MAX_PARTICIPANTS) return json({ error: `Room is full (${MAX_PARTICIPANTS} participants maximum).` }, 409, cors);
    const participantId = crypto.randomUUID(), token = randomId(24);
    await env.DB.prepare('INSERT INTO p2p_participants (room,id,name,token,joined_at,last_seen) VALUES (?1,?2,?3,?4,?5,?5)')
      .bind(room, participantId, name, token, now).run();
    return json({ participantId, token, mode: 'p2p', cursor: 0, ...(await p2pSnapshot(env, room)) }, 200, cors);
  }

  const me = await p2pAuth(env, room, body.participantId, body.token);
  if (!me) return json({ error: 'Unauthorized', code: 'p2p-unauthorized' }, 401, cors);

  // ONE request per poll does everything: heartbeat, presence, streams, and
  // draining this participant's signal inbox. Splitting them would multiply
  // the request count by four for no benefit.
  if (action === 'sync') {
    const cursor = Number(body.cursor) || 0;
    const [, inbox] = await env.DB.batch([
      // Conditional so a poll that changes nothing writes no rows.
      env.DB.prepare('UPDATE p2p_participants SET last_seen=?3 WHERE room=?1 AND id=?2 AND last_seen<?4')
        .bind(room, me.id, now, now - P2P_HEARTBEAT_MS),
      env.DB.prepare('SELECT seq, sender, payload FROM p2p_signals WHERE room=?1 AND target=?2 AND seq>?3 ORDER BY seq LIMIT 60')
        .bind(room, me.id, cursor),
    ]);
    const signals = inbox.results || [];
    if (Math.random() < 0.12) await p2pSweep(env, room, now);
    return json({
      cursor: signals.length ? signals[signals.length - 1].seq : cursor,
      signals,
      ...(await p2pSnapshot(env, room)),
    }, 200, cors);
  }

  if (action === 'signal') {
    const target = String(body.target || '');
    if (!target) return json({ error: 'No target.' }, 400, cors);
    const payload = JSON.stringify(body.signal || {});
    if (payload.length > 64_000) return json({ error: 'Signal too large.' }, 413, cors);
    await env.DB.prepare('INSERT INTO p2p_signals (room,target,sender,payload,created_at) VALUES (?1,?2,?3,?4,?5)')
      .bind(room, target, me.id, payload, now).run();
    return json({ ok: true }, 200, cors);
  }

  if (action === 'stream') {
    if (body.remove) {
      await env.DB.prepare('DELETE FROM p2p_streams WHERE room=?1 AND owner_id=?2').bind(room, me.id).run();
      return json({ ok: true }, 200, cors);
    }
    const profile = ['720p30', '720p60', '1080p60'].includes(body.stream?.profile) ? body.stream.profile : '720p30';
    const id = `${me.id}-share`;
    await env.DB.batch([
      // One stream per participant, same invariant RoomHub enforces.
      env.DB.prepare('DELETE FROM p2p_streams WHERE room=?1 AND owner_id=?2').bind(room, me.id),
      env.DB.prepare('INSERT INTO p2p_streams (room,id,owner_id,owner_name,profile,audio,started_at) VALUES (?1,?2,?3,?4,?5,?6,?7)')
        .bind(room, id, me.id, me.name, profile, body.stream?.audio ? 1 : 0, now),
    ]);
    return json({ ok: true, streamId: id }, 200, cors);
  }

  if (action === 'leave') {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM p2p_participants WHERE room=?1 AND id=?2').bind(room, me.id),
      env.DB.prepare('DELETE FROM p2p_streams WHERE room=?1 AND owner_id=?2').bind(room, me.id),
      env.DB.prepare('DELETE FROM p2p_signals WHERE room=?1 AND (target=?2 OR sender=?2)').bind(room, me.id),
    ]);
    return json({ ok: true }, 200, cors);
  }

  return json({ error: 'Unknown P2P endpoint.' }, 404, cors);
}

async function roomStub(env, room) {
  const id = env.ROOMS.idFromName(room);
  return env.ROOMS.get(id);
}

async function verify(env, room, participantId, token, sessionId = null) {
  const stub = await roomStub(env, room);
  const response = await stub.fetch('https://room/auth', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantId, token, sessionId }),
  });
  return response.json();
}

async function publishRealtimeSdp(request, env, room, participantId, token) {
  const appId = String(env.CF_REALTIME_APP_ID || env.CALLS_APP_ID || '').trim();
  const appToken = String(env.CF_REALTIME_APP_TOKEN || env.CF_REALTIME_APP_SECRET || env.CALLS_APP_SECRET || '').trim();
  if (!appId || !appToken) return json({ error: 'Cloudflare Realtime credentials are not configured on this Worker.' }, 500);

  const auth = await verify(env, room, participantId, token);
  if (!auth.ok) return json({ error: 'Unauthorized' }, 401);

  const offerSdp = await request.text();
  if (!offerSdp || !offerSdp.startsWith('v=0')) {
    return json({ error: 'Invalid WebRTC SDP offer.', sdpLength: offerSdp.length }, 400);
  }

  const base = `${RTC_BASE}/${encodeURIComponent(appId)}`;
  const headers = { 'Authorization': `Bearer ${appToken}` };

  const sessionResponse = await fetch(`${base}/sessions/new`, { method: 'POST', headers });
  const sessionText = await sessionResponse.text();
  let sessionData;
  try { sessionData = JSON.parse(sessionText); } catch { sessionData = { error: sessionText || `Cloudflare Realtime returned ${sessionResponse.status}` }; }
  if (!sessionResponse.ok || !sessionData.sessionId) {
    const upstream = sessionData.errorDescription || sessionData.error || sessionData.message || `Cloudflare Realtime returned ${sessionResponse.status}`;
    return json({ error:`Realtime session ${sessionResponse.status}: ${upstream}`, upstreamStatus:sessionResponse.status }, sessionResponse.status || 502);
  }

  const publishBody = {
    sessionDescription: { type: 'offer', sdp: offerSdp },
    autoDiscover: true,
  };
  const trackResponse = await fetch(`${base}/sessions/${encodeURIComponent(sessionData.sessionId)}/tracks/new`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(publishBody),
  });
  const trackText = await trackResponse.text();
  let trackData;
  try { trackData = JSON.parse(trackText); } catch { trackData = { error: trackText || `Cloudflare Realtime returned ${trackResponse.status}` }; }
  if (!trackResponse.ok) {
    const upstream = trackData.errorDescription || trackData.error || trackData.message || `Cloudflare Realtime returned ${trackResponse.status}`;
    return json({
      ...trackData,
      error:`Realtime publish ${trackResponse.status}: ${upstream}`,
      upstreamStatus:trackResponse.status,
      requestShape:{ sessionDescriptionType:'offer', sdpLength:offerSdp.length, autoDiscover:true },
    }, trackResponse.status);
  }

  const stub = await roomStub(env, room);
  await stub.fetch('https://room/register-session', {
    method: 'POST',
    headers: { 'content-type':'application/json' },
    body: JSON.stringify({ participantId, token, sessionId: sessionData.sessionId }),
  });

  return json({ sessionId: sessionData.sessionId, ...trackData });
}

async function proxyRealtime(request, env, room, participantId, token, operation, sessionId = null) {
  const appId = String(env.CF_REALTIME_APP_ID || env.CALLS_APP_ID || '').trim();
  const appToken = String(env.CF_REALTIME_APP_TOKEN || env.CF_REALTIME_APP_SECRET || env.CALLS_APP_SECRET || '').trim();
  if (!appId || !appToken) return json({ error: 'Cloudflare Realtime credentials are not configured on this Worker.' }, 500);
  const auth = await verify(env, room, participantId, token, sessionId);
  if (!auth.ok) return json({ error: 'Unauthorized' }, 401);

  const body = request.method === 'GET' ? null : await readJson(request);
  if (operation === 'tracks-new' && Array.isArray(body?.tracks)) {
    const remotes = body.tracks.filter(t => t.location === 'remote').map(t => t.sessionId).filter(Boolean);
    if (remotes.length) {
      const stub = await roomStub(env, room);
      const check = await stub.fetch('https://room/can-pull', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ participantId, token, remoteSessionIds: remotes }),
      }).then(r => r.json());
      if (!check.ok) return json({ error: 'Requested track is not available in this room.' }, 403);
    }
  }

  let path = '';
  let method = request.method;
  if (operation === 'new-session') { path = '/sessions/new'; method = 'POST'; }
  else if (operation === 'tracks-new') path = `/sessions/${sessionId}/tracks/new`;
  else if (operation === 'renegotiate') path = `/sessions/${sessionId}/renegotiate`;
  else if (operation === 'tracks-update') path = `/sessions/${sessionId}/tracks/update`;
  else if (operation === 'tracks-close') path = `/sessions/${sessionId}/tracks/close`;
  else return json({ error: 'Unsupported SFU operation.' }, 400);

  const realtimeUrl = `${RTC_BASE}/${encodeURIComponent(appId)}${path}`;
  const cfResponse = await fetch(realtimeUrl, {
    method,
    headers: {
      'Authorization': `Bearer ${appToken}`,
      'Content-Type': 'application/json',
    },
    body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  const text = await cfResponse.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { error: text || `Cloudflare Realtime returned ${cfResponse.status}` }; }
  if (!cfResponse.ok) {
    const upstream = data.errorDescription || data.error || data.message || `Cloudflare Realtime returned ${cfResponse.status}`;
    const requestShape = body ? {
      hasSessionDescription: Boolean(body.sessionDescription),
      sessionDescriptionType: body.sessionDescription?.type || null,
      sdpLength: typeof body.sessionDescription?.sdp === 'string' ? body.sessionDescription.sdp.length : null,
      trackCount: Array.isArray(body.tracks) ? body.tracks.length : 0,
      autoDiscover: body.autoDiscover === true,
    } : null;
    data = { ...data, error: `Realtime API ${cfResponse.status}: ${upstream}`, upstreamStatus:cfResponse.status, operation, requestShape };
  }

  if (operation === 'new-session' && cfResponse.ok && data.sessionId) {
    const stub = await roomStub(env, room);
    await stub.fetch('https://room/register-session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ participantId, token, sessionId: data.sessionId }),
    });
  }
  return json(data, cfResponse.status);
}

// Short-lived isolate cache so the budget check doesn't add a Durable Object
// round trip to every single media request.
let budgetCache = { at: 0, data: null };

async function budgetState(env) {
  const now = Date.now();
  if (budgetCache.data && now - budgetCache.at < 10_000) return budgetCache.data;
  try {
    const data = await budgetStub(env).fetch('https://budget/state').then(r => r.json());
    budgetCache = { at: now, data };
    return data;
  } catch {
    // Never block media because the meter itself failed.
    return budgetCache.data || { blocked: false, usedGb: 0, capGb: 0, percent: 0, period: null, remainingGb: 0 };
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      if (parts[0] === 'partytracks') {
        const appId = String(env.CF_REALTIME_APP_ID || env.CALLS_APP_ID || '').trim();
        const appToken = String(env.CF_REALTIME_APP_TOKEN || env.CF_REALTIME_APP_SECRET || env.CALLS_APP_SECRET || '').trim();
        if (!appId || !appToken) return json({ error:'Cloudflare Realtime credentials are not configured.' }, 500, cors);

        // PartyTracks fetches /generate-ice-servers with a bare rxjs fromFetch()
        // that bypasses its own fetch wrapper, so it carries NEITHER config.headers
        // NOR apiExtraParams. Requiring x-room here is what produced the 400, which
        // in turn left the RTCPeerConnection with iceServers: undefined (no STUN).
        // The endpoint returns only public STUN URLs (or TURN creds we don't set),
        // so it must not be gated behind room auth.
        const isIceServers = parts[1] === 'generate-ice-servers';

        // HARD SPENDING GUARD. Opening a session or a track is what costs money,
        // so those are refused once the monthly cap is reached. Closing tracks
        // and fetching ICE servers stay allowed, so existing sessions can wind
        // down cleanly instead of hanging.
        const opensMedia = parts[1] === 'sessions' &&
          (parts[2] === 'new' || (parts[3] === 'tracks' && parts[4] === 'new'));
        if (opensMedia) {
          const budget = await budgetState(env);
          if (budget.blocked) {
            return json({
              error: `Bandwidth cap reached: ${budget.usedGb} GB of ${budget.capGb} GB in the last ${budget.windowDays} days. Sharing is paused so the account is never billed. Capacity returns gradually as older usage ages out.`,
              budgetBlocked: true,
              usedGb: budget.usedGb,
              capGb: budget.capGb,
            }, 503, cors);
          }
        }

        if (!isIceServers) {
          const room = request.headers.get('x-room') || '';
          const participantId = request.headers.get('x-participant-id') || '';
          const token = request.headers.get('x-participant-token') || '';
          if (!ROOM_RE.test(room)) return json({ error:'Invalid room.' }, 400, cors);
          const auth = await verify(env, room, participantId, token);
          // Distinct wording so any future 401 is attributable at a glance:
          // PartyTracks' own rejection is the plain string "unauthorized".
          if (!auth.ok) return json({ error:'Unauthorized (SimpleShare room auth)' }, 401, cors);
        }

        // NOTE: we deliberately pass the ORIGINAL request through untouched.
        // Reconstructing it (e.g. to strip x-participant-token) risks losing the
        // Content-Length header, and routePartyTracksRequest only forwards a body
        // when Content-Length > 0 or Transfer-Encoding is present. A dropped body
        // turns tracks/new into a 400 from Cloudflare. Not worth the tidiness.
        const response = await routePartyTracksRequest({
          appId,
          token: appToken,
          request,
          prefix: '/partytracks',
          // THE 401 FIX.
          // Defaults to `process.env.NODE_ENV === "production"`, i.e. ON in a
          // deployed Worker. It sets a `partytracks-session-<id>` JWT cookie with
          // SameSite=Strict on /sessions/new and then requires that cookie on every
          // tracks/new, renegotiate, tracks/update and tracks/close.
          //
          // That cookie can never survive our topology: the PartyTracks client never
          // sets `credentials` on its fetches (so a cross-origin Set-Cookie is
          // discarded and never sent back), SameSite=Strict blocks it cross-site
          // anyway, and we send no Access-Control-Allow-Credentials. Result: every
          // tracks/new hit `if (!cookieHeader) return unauthorizedResponse()` -> 401.
          //
          // Safe to disable because the verify() call above already does this job
          // better: the cookie only proved "same browser that opened the session",
          // while our token proves "authorized member of this room".
          lockSessionToInitiator: false,
          // TURN. Without these, generate-ice-servers returns public STUN only,
          // which cannot traverse symmetric NAT -- the PeerConnection then never
          // completes and the viewer's tile hangs on "Connecting to stream..."
          // forever with no error. Set both as Worker secrets to enable relay.
          // Undefined values are ignored by PartyTracks, so this is safe to ship
          // before the secrets exist.
          turnServerAppId: String(env.CF_TURN_APP_ID || '').trim() || undefined,
          turnServerAppToken: String(env.CF_TURN_APP_TOKEN || '').trim() || undefined,
        });

        // DIAGNOSTICS. Body is passed through byte-identical so client behavior is
        // unchanged; we only log and add response headers. Watch with:
        //   npx wrangler tail simpleshare --format pretty
        if (!response.ok) {
          let peek = '';
          try { peek = (await response.clone().text()).slice(0, 400); } catch {}
          console.log(`[partytracks] ${request.method} ${url.pathname} -> ${response.status} :: ${peek}`);
          const out = new Response(response.body, response);
          for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
          out.headers.set('x-ss-pt-status', String(response.status));
          out.headers.set('x-ss-pt-origin', 'upstream-or-partytracks');
          return out;
        }
        const out = new Response(response.body, response);
        for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
        return out;
      }

      // Ahead of every DO route on purpose: this path must stay reachable
      // precisely when the Durable Object budget is gone.
      if (parts[0] === 'api' && parts[1] === 'p2p' && parts[2]) {
        return p2pHandle(request, env, parts[2], cors);
      }

      if (parts[0] === 'api' && parts[1] === 'rooms' && ROOM_RE.test(parts[2] || '')) {
        const room = parts[2];
        const stub = await roomStub(env, room);
        let path = '/';
        if (parts[3] === 'join') path = '/join';
        else if (parts[3] === 'socket') path = `/socket${url.search}`;
        else if (parts[3] === 'snapshot') path = '/snapshot';
        else if (parts[3] === 'stream' && parts[4] === 'upsert') path = '/stream-upsert';
        else if (parts[3] === 'stream' && parts[4] === 'remove') path = '/stream-remove';
        // Pass the original request through wholesale. Hand-rebuilding it
        // (method + headers + body) can break the WebSocket upgrade handshake.
        const forwarded = new Request(`https://room${path}`, request);
        const response = await stub.fetch(forwarded);
        if (response.status === 101) return response;
        const out = new Response(response.body, response);
        for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
        return out;
      }

      if (parts[0] === 'api' && parts[1] === 'sfu' && parts[2] === 'publish') {
        const room = request.headers.get('x-room') || '';
        const participantId = request.headers.get('x-participant-id') || '';
        const token = request.headers.get('x-participant-token') || '';
        if (!ROOM_RE.test(room)) return json({ error:'Invalid room.' }, 400, cors);
        const response = await publishRealtimeSdp(request, env, room, participantId, token);
        const out = new Response(response.body, response);
        for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
        return out;
      }

      if (parts[0] === 'api' && parts[1] === 'sfu') {
        const bodyForAuth = await readJson(request.clone());
        const room = bodyForAuth.room || request.headers.get('x-room') || '';
        const participantId = bodyForAuth.participantId || request.headers.get('x-participant-id') || '';
        const token = bodyForAuth.token || request.headers.get('x-participant-token') || '';
        if (!ROOM_RE.test(room)) return new Response(JSON.stringify({ error: 'Invalid room.' }), { status: 400, headers: { ...cors, 'content-type': 'application/json' } });

        let operation = null, sessionId = null;
        if (parts[2] === 'session') operation = 'new-session';
        else if (parts[2] === 'sessions' && parts[3]) {
          sessionId = parts[3];
          if (parts[4] === 'tracks' && parts[5] === 'new') operation = 'tracks-new';
          if (parts[4] === 'tracks' && parts[5] === 'update') operation = 'tracks-update';
          if (parts[4] === 'tracks' && parts[5] === 'close') operation = 'tracks-close';
          if (parts[4] === 'renegotiate') operation = 'renegotiate';
        }
        if (!operation) return new Response(JSON.stringify({ error: 'Unknown SFU endpoint.' }), { status: 404, headers: { ...cors, 'content-type': 'application/json' } });

        // Strip auth envelope before forwarding to Realtime.
        const cleanBody = { ...bodyForAuth };
        delete cleanBody.room; delete cleanBody.participantId; delete cleanBody.token;
        const proxiedRequest = new Request(request.url, {
          method: request.method,
          headers: { 'content-type': 'application/json' },
          body: request.method === 'GET' ? undefined : JSON.stringify(cleanBody),
        });
        const response = await proxyRealtime(proxiedRequest, env, room, participantId, token, operation, sessionId);
        const out = new Response(response.body, response);
        for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
        return out;
      }

      // Server-side credential self-test. Talks to Cloudflare Realtime directly,
      // bypassing PartyTracks and the browser entirely. If this returns ok:false
      // the problem is the App ID / App Secret, not the media code.
      if (url.pathname === '/api/budget') {
        return json(await budgetState(env), 200, { ...cors, 'cache-control': 'no-store' });
      }

      if (url.pathname === '/debug/realtime') {
        const appId = String(env.CF_REALTIME_APP_ID || env.CALLS_APP_ID || '').trim();
        const appToken = String(env.CF_REALTIME_APP_TOKEN || env.CF_REALTIME_APP_SECRET || env.CALLS_APP_SECRET || '').trim();
        if (!appId || !appToken) return json({ ok:false, reason:'missing-credentials', hasAppId:Boolean(appId), hasAppToken:Boolean(appToken) }, 200, cors);
        const r = await fetch(`${RTC_BASE}/${encodeURIComponent(appId)}/sessions/new`, {
          method:'POST',
          headers:{ 'Authorization':`Bearer ${appToken}` },
        });
        const text = await r.text();
        let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw:text.slice(0,300) }; }
        return json({
          ok: r.ok && Boolean(parsed.sessionId),
          upstreamStatus: r.status,
          gotSessionId: Boolean(parsed.sessionId),
          appIdLength: appId.length,
          appTokenLength: appToken.length,
          upstream: parsed.sessionId ? '(session created)' : parsed,
        }, 200, cors);
      }

      if (url.pathname === '/health') return json({
        ok:true,
        worker:'simpleshare-room-api',
        build:'presence-sfx-v25-p2p',
        mediaBridge:'partytracks',
        sessionLock:false,
        iceServersAuthExempt:true,
        roomsBinding:Boolean(env.ROOMS),
        directModeRetired:true,
        socketGracePeriodSeconds:GRACE_MS / 1000,
        roomTickSeconds:TICK_ACTIVE_MS / 1000,
        roomIdleTickSeconds:TICK_IDLE_MS / 1000,
        budgetPushedOverSocket:true,
        snapshotPollingRetired:true,
        p2pFallback:Boolean(env.DB),
        revisionedSnapshots:true,
        serverKeepalive:true,
        resumableSessions:true,
        oneStreamPerParticipant:true,
        watcherEvents:true,
        budgetBinding:Boolean(env.BUDGET),
        budgetBasis:'rolling-31-day',
        turnConfigured:Boolean(String(env.CF_TURN_APP_ID || '').trim() && String(env.CF_TURN_APP_TOKEN || '').trim()),
        realtimeConfigured:Boolean(
          String(env.CF_REALTIME_APP_ID || env.CALLS_APP_ID || '').trim() &&
          String(env.CF_REALTIME_APP_TOKEN || env.CF_REALTIME_APP_SECRET || env.CALLS_APP_SECRET || '').trim()
        ),
      }, 200, cors);
      if (url.pathname.startsWith('/api/')) return json({ error:'Unknown SimpleShare API route.' }, 404, cors);
      return new Response('SimpleShare room API', { status: 200, headers: cors });
    } catch (error) {
      const message = error?.message || 'Unexpected error';
      // A Durable Object over its daily free-tier allowance throws here. That is
      // not a bug to report, it is a signal to change transport: tag it so the
      // client can switch to the P2P path instead of showing a dead room.
      if (p2pQuotaHint(message)) {
        return new Response(JSON.stringify({ error: message, code: 'do-quota', fallback: env.DB ? 'p2p' : null }), { status: 503, headers: { ...cors, 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ error: message }), { status: 500, headers: { ...cors, 'content-type': 'application/json' } });
    }
  },
};
