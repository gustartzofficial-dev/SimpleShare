import { routePartyTracksRequest } from 'partytracks/server';

const ROOM_RE = /^[A-Za-z0-9_-]{20,80}$/;
const PARTICIPANT_RE = /^[a-f0-9-]{20,80}$/i;
const MAX_PARTICIPANTS = 10;
const RTC_BASE = 'https://rtc.live.cloudflare.com/v1/apps';
const GRACE_MS = 60_000;
const NEVER_CONNECTED_MS = 45_000;
const TICK_ACTIVE_MS = 15_000;
const TICK_IDLE_MS = 60_000;
const TICK_MS = TICK_ACTIVE_MS;
const BUDGET_IDLE_REFRESH_MS = 300_000;
const fallbackTurn = (env) => {
  if (String(env.FALLBACK_TURN_DISABLED || '') === '1') return [];
  const urls = String(
    env.FALLBACK_TURN_URLS ||
      'turn:openrelay.metered.ca:443,turn:openrelay.metered.ca:443?transport=tcp,turns:openrelay.metered.ca:443?transport=tcp',
  )
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);
  if (!urls.length) return [];
  return [
    {
      urls,
      username: String(env.FALLBACK_TURN_USER || 'openrelayproject'),
      credential: String(env.FALLBACK_TURN_PASS || 'openrelayproject'),
    },
  ];
};

const quotaHint = (m) =>
  /exceeded allowed volume|daily request limit|free tier|too many subrequests/i.test(
    String(m || ''),
  );

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...extra },
  });

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || '*';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Access-Control-Allow-Headers':
      'Content-Type,Authorization,X-Room,X-Participant-Id,X-Participant-Token',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function randomId(bytes = 16) {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return [...b].map((v) => v.toString(16).padStart(2, '0')).join('');
}

function safeName(value) {
  const s = String(value || '')
    .trim()
    .replace(/\s+/g, ' ')
    .slice(0, 28);
  return s || `Guest ${randomId(2).toUpperCase()}`;
}

async function readJson(request) {
  if (!request.body) return {};
  const reader = request.body.getReader();
  let length = 0;
  const chunks = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > 65536) {
      await reader.cancel();
      throw Object.assign(new Error('Request too large.'), { status: 413 });
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const body = JSON.parse(new TextDecoder().decode(bytes));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw Object.assign(new Error('Expected a JSON object.'), { status: 400 });
  }
}
const PROFILE_BPS = { '720p30': 2_500_000, '720p60': 4_000_000, '1080p60': 8_000_000 };

const budgetStub = (env) => env.BUDGET.get(env.BUDGET.idFromName('global'));

export class BudgetTracker {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  static dayKey(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  async buckets() {
    return (await this.ctx.storage.get('daily')) || {};
  }
  summarize(daily) {
    const windowDays = 31;
    const now = Date.now();
    const cutoff = now - windowDays * 86_400_000;
    const cutoffKey = BudgetTracker.dayKey(cutoff);
    let bytes = 0;
    for (const [day, value] of Object.entries(daily)) {
      if (day >= cutoffKey && day <= BudgetTracker.dayKey(now))
        bytes += Math.max(0, Number(value) || 0);
    }
    return { bytes, windowDays, windowStart: cutoffKey, today: BudgetTracker.dayKey(now) };
  }

  async fetch(request) {
    const url = new URL(request.url);
    const configuredCap = Number(this.env.MONTHLY_EGRESS_CAP_GB || 900);
    const capGb = Number.isFinite(configuredCap) && configuredCap > 0 ? configuredCap : 900;
    let daily = await this.buckets();

    if (url.pathname === '/add' && request.method === 'POST') {
      const body = await readJson(request);
      const bytes = Number(body.bytes);
      if (Number.isFinite(bytes) && bytes > 0) {
        const today = BudgetTracker.dayKey(Date.now());
        daily[today] = (Number(daily[today]) || 0) + bytes;
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
      accountingBucketDays: 32,
    });
  }
}

export class RoomHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    try {
      this.ctx.setWebSocketAutoResponse(
        new WebSocketRequestResponsePair(
          JSON.stringify({ type: 'ping' }),
          JSON.stringify({ type: 'pong' }),
        ),
      );
    } catch {}
  }
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
    const state = (await this.ctx.storage.get('state')) || {
      participants: {},
      streams: {},
      sessions: {},
    };
    for (const key of ['participants', 'streams', 'sessions'])
      state[key] = Object.assign(Object.create(null), state[key] || {});
    if (typeof state.rev !== 'number') state.rev = 0;
    return state;
  }
  async putState(state) {
    state.rev = (state.rev || 0) + 1;
    await this.ctx.storage.put('state', state);
    return state.rev;
  }
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
    try {
      ws.send(JSON.stringify(payload));
    } catch {}
  }

  broadcast(payload, exceptId = null) {
    const message = JSON.stringify(payload);
    for (const ws of this.sockets()) {
      const attachment = ws.deserializeAttachment() || {};
      if (exceptId && attachment.participantId === exceptId) continue;
      try {
        ws.send(message);
      } catch {}
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
      const liveSocketIds = new Set(
        this.sockets()
          .map((ws) => (ws.deserializeAttachment() || {}).participantId)
          .filter(Boolean),
      );
      for (const [id, p] of Object.entries(state.participants)) {
        if (liveSocketIds.has(id)) continue;
        const expired = p.disconnectedAt
          ? now - p.disconnectedAt > GRACE_MS
          : now - p.joinedAt > NEVER_CONNECTED_MS;
        if (!expired) continue;
        delete state.participants[id];
        for (const [streamId, stream] of Object.entries(state.streams))
          if (stream.ownerId === id) delete state.streams[streamId];
        for (const [sid, owner] of Object.entries(state.sessions))
          if (owner === id) delete state.sessions[sid];
      }
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
      const active = Object.keys(state.participants).length;
      const roomMode = 'cloud';
      const limit = MAX_PARTICIPANTS;
      if (active >= limit)
        return json(
          { error: `Room is full (${limit} participants maximum in ${roomMode} mode).` },
          409,
        );
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
      await this.armAlarm(TICK_ACTIVE_MS);
      return json({ participantId, token, mode: roomMode, snapshot: this.publicSnapshot(state) });
    }

    if (method === 'POST' && url.pathname === '/leave') {
      const body = await readJson(request);
      return this.ctx.blockConcurrencyWhile(async () => {
        try {
          const state = await this.getState(),
            participant = state.participants[body.participantId];
          if (!participant || participant.token !== body.token)
            return json({ error: 'Unauthorized' }, 401);
          await this.accountEgress(state);
          await this.ctx.storage.put('state', state);
          await this.removeParticipant(participant.id);
          for (const socket of this.sockets())
            if (socket.deserializeAttachment()?.participantId === participant.id)
              try {
                socket.close(1000, 'left room');
              } catch {}
          return json({ ok: true });
        } catch {
          return json({ error: 'Could not leave the room cleanly.' }, 503);
        }
      });
    }

    if (method === 'POST' && url.pathname === '/auth') {
      const body = await readJson(request);
      const state = await this.getState();
      const p = state.participants[body.participantId];
      const ok = Boolean(p && p.token === body.token);
      const ownsSession = !body.sessionId || state.sessions[body.sessionId] === body.participantId;
      return json({
        ok: ok && ownsSession,
        participant: ok ? { id: p.id, name: p.name, mode: p.mode } : null,
      });
    }

    if (method === 'POST' && url.pathname === '/register-session') {
      const body = await readJson(request);
      const state = await this.getState();
      const p = state.participants[body.participantId];
      if (!p || p.token !== body.token) return json({ error: 'Unauthorized' }, 401);
      if (typeof body.sessionId !== 'string' || !body.sessionId)
        return json({ error: 'Invalid session' }, 400);
      if (state.sessions[body.sessionId] && state.sessions[body.sessionId] !== body.participantId)
        return json({ error: 'Session belongs to another participant.' }, 403);
      const owned = Object.keys(state.sessions).filter(
        (id) => state.sessions[id] === body.participantId,
      );
      if (owned.length >= 12)
        return json({ error: 'Too many media sessions. Leave and rejoin the room.' }, 429);
      state.sessions[body.sessionId] = body.participantId;
      await this.putState(state);
      return json({ ok: true });
    }

    if (method === 'POST' && url.pathname === '/can-pull') {
      const body = await readJson(request);
      const state = await this.getState();
      const p = state.participants[body.participantId];
      if (!p || p.token !== body.token) return json({ ok: false }, 401);
      const allowed = new Set(
        Object.values(state.streams)
          .map((s) => s.sessionId)
          .filter(Boolean),
      );
      const sessions = Array.isArray(body.remoteSessionIds) ? body.remoteSessionIds : [];
      return json({ ok: sessions.every((id) => allowed.has(id)) });
    }

    if (method === 'POST' && url.pathname === '/stream-upsert') {
      const body = await readJson(request);
      const state = await this.getState();
      const participant = state.participants[body.participantId];
      if (!participant || participant.token !== body.token)
        return json({ error: 'Unauthorized' }, 401);
      const streamId = String(body.stream?.id || '').slice(0, 100);
      if (!streamId) return json({ error: 'Invalid stream.' }, 400);
      if (state.streams[streamId] && state.streams[streamId].ownerId !== participant.id)
        return json({ error: 'Stream belongs to another participant.' }, 403);
      if (!body.stream.sessionId || state.sessions[body.stream.sessionId] !== participant.id)
        return json({ error: 'Media session does not belong to you.' }, 403);
      const stream = {
        id: streamId,
        ownerId: participant.id,
        ownerName: participant.name,
        mode: participant.mode,
        sessionId: typeof body.stream.sessionId === 'string' ? body.stream.sessionId : null,
        videoTrackName:
          typeof body.stream.videoTrackName === 'string' ? body.stream.videoTrackName : null,
        audioTrackName:
          typeof body.stream.audioTrackName === 'string' ? body.stream.audioTrackName : null,
        profile: ['720p30', '720p60', '1080p60'].includes(body.stream.profile)
          ? body.stream.profile
          : '720p30',
        audio: Boolean(body.stream.audio),
        startedAt: Date.now(),
      };
      const superseded = this.evictOtherStreams(state, participant.id, streamId);
      state.streams[streamId] = stream;
      const rev = await this.putState(state);
      for (const id of superseded) this.broadcast({ type: 'stream-remove', streamId: id, rev });
      this.broadcast({ type: 'stream-upsert', stream, rev });
      await this.armAlarm(TICK_ACTIVE_MS);
      return json({ ok: true, stream, rev, superseded });
    }

    if (method === 'POST' && url.pathname === '/stream-remove') {
      const body = await readJson(request);
      const state = await this.getState();
      const participant = state.participants[body.participantId];
      if (!participant || participant.token !== body.token)
        return json({ error: 'Unauthorized' }, 401);
      const streamId = String(body.streamId || '');
      if (state.streams[streamId]?.ownerId !== participant.id)
        return json({ error: 'Stream not found.' }, 404);
      delete state.streams[streamId];
      const rev = await this.putState(state);
      this.broadcast({ type: 'stream-remove', streamId, rev });
      return json({ ok: true, rev });
    }

    if (url.pathname === '/socket') {
      if (request.headers.get('Upgrade') !== 'websocket')
        return new Response('Expected websocket', { status: 426 });
      const participantId = url.searchParams.get('id') || '';
      const token = url.searchParams.get('token') || '';
      const state = await this.getState();
      const participant = state.participants[participantId];
      if (!participant || participant.token !== token)
        return new Response('Unauthorized', { status: 401 });

      if (participant.disconnectedAt) {
        delete participant.disconnectedAt;
        await this.putState(state);
      }
      if (!state.lastAccountedAt) {
        state.lastAccountedAt = Date.now();
        await this.putState(state);
      }
      await this.armAlarm(TICK_ACTIVE_MS);
      for (const old of this.sockets()) {
        if ((old.deserializeAttachment() || {}).participantId !== participantId) continue;
        try {
          old.close(4001, 'superseded by a newer connection');
        } catch {}
      }

      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.serializeAttachment({ participantId });
      this.ctx.acceptWebSocket(server);
      this.send(server, {
        type: 'snapshot',
        ...this.publicSnapshot(state),
        budget: await this.budgetSummary(),
      });
      this.broadcast(
        {
          type: 'participant-joined',
          rev: state.rev || 0,
          participant: {
            id: participant.id,
            name: participant.name,
            joinedAt: participant.joinedAt,
            mode: participant.mode,
          },
        },
        participantId,
      );
      return new Response(null, { status: 101, webSocket: client });
    }

    if (method === 'GET' && url.pathname === '/snapshot') {
      const state = await this.getState();
      const participant = state.participants[request.headers.get('x-participant-id')];
      if (!participant || participant.token !== request.headers.get('x-participant-token'))
        return json({ error: 'Unauthorized' }, 401);
      return json(this.publicSnapshot(state));
    }

    return new Response('Not found', { status: 404 });
  }

  async webSocketMessage(ws, raw) {
    const attachment = ws.deserializeAttachment() || {};
    const participantId = attachment.participantId;
    if (!participantId) return;
    let msg;
    if ((typeof raw === 'string' ? raw.length : raw.byteLength) > 65536) {
      try {
        ws.close(1009, 'message too large');
      } catch {}
      return;
    }
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    const state = await this.getState();
    const participant = state.participants[participantId];
    if (!participant) return;

    if (msg.type === 'ping') {
      this.send(ws, { type: 'pong', at: Date.now() });
      return;
    }
    if (msg.type === 'watching') {
      const ids = Array.isArray(msg.streamIds)
        ? msg.streamIds.slice(0, 20).map((v) => String(v).slice(0, 100))
        : [];
      const before = new Set(Array.isArray(participant.watching) ? participant.watching : []);
      const after = new Set(ids);
      const opened = ids.filter((id) => !before.has(id));
      const closed = [...before].filter((id) => !after.has(id));
      participant.watching = ids;
      if (!opened.length && !closed.length) return;
      const rev = await this.putState(state);
      this.broadcast(
        {
          type: 'watching-changed',
          rev,
          participantId: participant.id,
          participantName: participant.name,
          opened,
          closed,
        },
        participant.id,
      );
      if (opened.length) await this.armAlarm(TICK_ACTIVE_MS);
      return;
    }

    if (msg.type === 'rename') {
      participant.name = safeName(msg.name);
      const rev = await this.putState(state);
      this.broadcast({
        type: 'participant-updated',
        rev,
        participant: {
          id: participant.id,
          name: participant.name,
          joinedAt: participant.joinedAt,
          mode: participant.mode,
        },
      });
      return;
    }

    if (msg.type === 'stream-upsert') {
      const streamId = String(msg.stream?.id || '').slice(0, 100);
      if (!streamId) return;
      if (state.streams[streamId] && state.streams[streamId].ownerId !== participantId) return;
      if (!msg.stream.sessionId || state.sessions[msg.stream.sessionId] !== participantId) return;
      const stream = {
        id: streamId,
        ownerId: participantId,
        ownerName: participant.name,
        mode: participant.mode,
        sessionId: typeof msg.stream.sessionId === 'string' ? msg.stream.sessionId : null,
        videoTrackName:
          typeof msg.stream.videoTrackName === 'string' ? msg.stream.videoTrackName : null,
        audioTrackName:
          typeof msg.stream.audioTrackName === 'string' ? msg.stream.audioTrackName : null,
        profile: ['720p30', '720p60', '1080p60'].includes(msg.stream.profile)
          ? msg.stream.profile
          : '720p30',
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
      const packet = {
        type: 'quality-request',
        from: participantId,
        quality: msg.quality || 'auto',
      };
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
    for (const [sid, owner] of Object.entries(state.sessions))
      if (owner === participantId) delete state.sessions[sid];
    const rev = await this.putState(state);
    this.broadcast({ type: 'participant-left', participantId, removedStreams, rev });
  }
  async markDisconnected(participantId, closingWs = null) {
    const stillLive = this.sockets().some(
      (ws) =>
        ws !== closingWs &&
        ws.readyState === 1 && // OPEN
        (ws.deserializeAttachment() || {}).participantId === participantId,
    );
    if (stillLive) return;
    const state = await this.getState();
    const p = state.participants[participantId];
    if (!p || p.disconnectedAt) return;
    p.disconnectedAt = Date.now();
    await this.putState(state);
    await this.armAlarm(TICK_MS);
  }
  async accountEgress(state) {
    const now = Date.now();
    const last = state.lastAccountedAt || now;
    state.lastAccountedAt = now;
    const seconds = Math.max(0, (now - last) / 1000);
    if (seconds <= 0) return;

    let bitsPerSecond = 0;
    for (const stream of Object.values(state.streams)) {
      if (!stream.sessionId || !stream.videoTrackName) continue;
      let viewers = 0;
      for (const p of Object.values(state.participants)) {
        if (p.id === stream.ownerId) continue;
        viewers += 1;
      }
      if (!viewers) continue;
      bitsPerSecond +=
        ((PROFILE_BPS[stream.profile] || PROFILE_BPS['720p30']) + (stream.audio ? 128000 : 0)) *
        viewers;
    }
    this.billing = bitsPerSecond > 0;
    state.pendingEgressBytes =
      (Number(state.pendingEgressBytes) || 0) + (bitsPerSecond / 8) * seconds;
    if (state.pendingEgressBytes <= 0) return;
    const bytes = state.pendingEgressBytes;
    try {
      const response = await budgetStub(this.env).fetch('https://budget/add', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bytes }),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) throw new Error('Usage accounting unavailable.');
      this.budgetCache = await response.json();
      state.pendingEgressBytes = 0;
      this.budgetCacheAt = Date.now();
    } catch {
      this.budgetCache = {
        blocked: true,
        unavailable: true,
        usedGb: 0,
        capGb: 0,
        percent: 0,
        windowDays: 31,
      };
      this.budgetCacheAt = Date.now();
    }
  }
  async budgetSummary() {
    const now = Date.now();
    if (this.budgetCache && now - (this.budgetCacheAt || 0) < BUDGET_IDLE_REFRESH_MS)
      return this.budgetCache;
    try {
      const response = await budgetStub(this.env).fetch('https://budget/state');
      this.budgetCache = await response.json();
      this.budgetCacheAt = now;
    } catch {}
    return this.budgetCache || null;
  }

  async alarm() {
    return this.ctx.blockConcurrencyWhile(async () => {
      try {
        await this.runAlarm();
      } catch (error) {
        console.error('Room alarm failed:', error.message);
        await this.armAlarm(TICK_ACTIVE_MS);
      }
    });
  }

  async runAlarm() {
    const state = await this.getState();
    await this.accountEgress(state);
    await this.ctx.storage.put('state', state);
    this.broadcast({
      type: 'server-ping',
      at: Date.now(),
      rev: state.rev || 0,
      budget: await this.budgetSummary(),
    });

    const liveIds = new Set(
      this.sockets()
        .map((ws) => (ws.deserializeAttachment() || {}).participantId)
        .filter(Boolean),
    );
    const cutoff = Date.now() - GRACE_MS;
    let changed = false,
      stillPending = false;
    for (const [id, p] of Object.entries(state.participants)) {
      if (liveIds.has(id)) {
        if (p.disconnectedAt) {
          delete p.disconnectedAt;
          changed = true;
        }
        continue;
      }
      if (!p.disconnectedAt) {
        if (Date.now() - p.joinedAt > NEVER_CONNECTED_MS) {
          p.disconnectedAt = Date.now() - GRACE_MS - 1;
        } else {
          stillPending = true;
          continue;
        }
      }
      if (p.disconnectedAt < cutoff) {
        delete state.participants[id];
        const removedStreams = [];
        for (const [sid, stream] of Object.entries(state.streams)) {
          if (stream.ownerId === id) {
            removedStreams.push(sid);
            delete state.streams[sid];
          }
        }
        for (const [sid, owner] of Object.entries(state.sessions))
          if (owner === id) delete state.sessions[sid];
        this.broadcast({
          type: 'participant-left',
          participantId: id,
          removedStreams,
          rev: (state.rev || 0) + 1,
        });
        changed = true;
      } else stillPending = true;
    }
    if (changed) await this.putState(state);
    if (
      Object.keys(state.participants).length === 0 &&
      this.sockets().length === 0 &&
      !(state.pendingEgressBytes > 0)
    ) {
      await this.ctx.storage.deleteAll();
      return;
    }
    const occupied = Object.keys(state.participants).length > 0 || this.sockets().length > 0;
    const next = this.billing || stillPending ? TICK_ACTIVE_MS : TICK_IDLE_MS;
    if (occupied || stillPending || state.pendingEgressBytes > 0) await this.armAlarm(next);
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
  const appToken = String(
    env.CF_REALTIME_APP_TOKEN || env.CF_REALTIME_APP_SECRET || env.CALLS_APP_SECRET || '',
  ).trim();
  if (!appId || !appToken)
    return json(
      { error: 'Cloudflare Realtime credentials are not configured on this Worker.' },
      500,
    );

  const auth = await verify(env, room, participantId, token);
  if (!auth.ok) return json({ error: 'Unauthorized' }, 401);

  const offerSdp = await request.text();
  if (!offerSdp || !offerSdp.startsWith('v=0')) {
    return json({ error: 'Invalid WebRTC SDP offer.', sdpLength: offerSdp.length }, 400);
  }

  const base = `${RTC_BASE}/${encodeURIComponent(appId)}`;
  const headers = { Authorization: `Bearer ${appToken}` };

  const sessionResponse = await fetch(`${base}/sessions/new`, { method: 'POST', headers });
  const sessionText = await sessionResponse.text();
  let sessionData;
  try {
    sessionData = JSON.parse(sessionText);
  } catch {
    sessionData = {
      error: sessionText || `Cloudflare Realtime returned ${sessionResponse.status}`,
    };
  }
  if (!sessionResponse.ok || !sessionData.sessionId) {
    const upstream =
      sessionData.errorDescription ||
      sessionData.error ||
      sessionData.message ||
      `Cloudflare Realtime returned ${sessionResponse.status}`;
    return json(
      {
        error: `Realtime session ${sessionResponse.status}: ${upstream}`,
        upstreamStatus: sessionResponse.status,
      },
      sessionResponse.status || 502,
    );
  }

  const publishBody = {
    sessionDescription: { type: 'offer', sdp: offerSdp },
    autoDiscover: true,
  };
  const trackResponse = await fetch(
    `${base}/sessions/${encodeURIComponent(sessionData.sessionId)}/tracks/new`,
    {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(publishBody),
    },
  );
  const trackText = await trackResponse.text();
  let trackData;
  try {
    trackData = JSON.parse(trackText);
  } catch {
    trackData = { error: trackText || `Cloudflare Realtime returned ${trackResponse.status}` };
  }
  if (!trackResponse.ok) {
    const upstream =
      trackData.errorDescription ||
      trackData.error ||
      trackData.message ||
      `Cloudflare Realtime returned ${trackResponse.status}`;
    return json(
      {
        ...trackData,
        error: `Realtime publish ${trackResponse.status}: ${upstream}`,
        upstreamStatus: trackResponse.status,
        requestShape: {
          sessionDescriptionType: 'offer',
          sdpLength: offerSdp.length,
          autoDiscover: true,
        },
      },
      trackResponse.status,
    );
  }

  const stub = await roomStub(env, room);
  await stub.fetch('https://room/register-session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ participantId, token, sessionId: sessionData.sessionId }),
  });

  return json({ sessionId: sessionData.sessionId, ...trackData });
}

async function proxyRealtime(
  request,
  env,
  room,
  participantId,
  token,
  operation,
  sessionId = null,
) {
  const appId = String(env.CF_REALTIME_APP_ID || env.CALLS_APP_ID || '').trim();
  const appToken = String(
    env.CF_REALTIME_APP_TOKEN || env.CF_REALTIME_APP_SECRET || env.CALLS_APP_SECRET || '',
  ).trim();
  if (!appId || !appToken)
    return json(
      { error: 'Cloudflare Realtime credentials are not configured on this Worker.' },
      500,
    );
  const auth = await verify(env, room, participantId, token, sessionId);
  if (!auth.ok) return json({ error: 'Unauthorized' }, 401);

  const body = request.method === 'GET' ? null : await readJson(request);
  if (operation === 'tracks-new' && Array.isArray(body?.tracks)) {
    const remotes = body.tracks
      .filter((t) => t.location === 'remote')
      .map((t) => t.sessionId)
      .filter(Boolean);
    if (remotes.length) {
      const stub = await roomStub(env, room);
      const check = await stub
        .fetch('https://room/can-pull', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ participantId, token, remoteSessionIds: remotes }),
        })
        .then((r) => r.json());
      if (!check.ok) return json({ error: 'Requested track is not available in this room.' }, 403);
    }
  }

  let path = '';
  let method = request.method;
  if (operation === 'new-session') {
    path = '/sessions/new';
    method = 'POST';
  } else if (operation === 'tracks-new') path = `/sessions/${sessionId}/tracks/new`;
  else if (operation === 'renegotiate') path = `/sessions/${sessionId}/renegotiate`;
  else if (operation === 'tracks-update') path = `/sessions/${sessionId}/tracks/update`;
  else if (operation === 'tracks-close') path = `/sessions/${sessionId}/tracks/close`;
  else return json({ error: 'Unsupported SFU operation.' }, 400);

  const realtimeUrl = `${RTC_BASE}/${encodeURIComponent(appId)}${path}`;
  const cfResponse = await fetch(realtimeUrl, {
    method,
    headers: {
      Authorization: `Bearer ${appToken}`,
      'Content-Type': 'application/json',
    },
    body: body && method !== 'GET' ? JSON.stringify(body) : undefined,
  });
  const text = await cfResponse.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { error: text || `Cloudflare Realtime returned ${cfResponse.status}` };
  }
  if (!cfResponse.ok) {
    const upstream =
      data.errorDescription ||
      data.error ||
      data.message ||
      `Cloudflare Realtime returned ${cfResponse.status}`;
    const requestShape = body
      ? {
          hasSessionDescription: Boolean(body.sessionDescription),
          sessionDescriptionType: body.sessionDescription?.type || null,
          sdpLength:
            typeof body.sessionDescription?.sdp === 'string'
              ? body.sessionDescription.sdp.length
              : null,
          trackCount: Array.isArray(body.tracks) ? body.tracks.length : 0,
          autoDiscover: body.autoDiscover === true,
        }
      : null;
    data = {
      ...data,
      error: `Realtime API ${cfResponse.status}: ${upstream}`,
      upstreamStatus: cfResponse.status,
      operation,
      requestShape,
    };
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
let budgetCache = { at: 0, data: null };

async function budgetState(env) {
  const now = Date.now();
  if (budgetCache.data && now - budgetCache.at < 10_000) return budgetCache.data;
  try {
    const data = await budgetStub(env)
      .fetch('https://budget/state')
      .then((r) => r.json());
    budgetCache = { at: now, data };
    return data;
  } catch {
    return {
      blocked: true,
      unavailable: true,
      usedGb: 0,
      capGb: 0,
      percent: 0,
      remainingGb: 0,
      windowDays: 31,
    };
  }
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request);

    const url = new URL(request.url);
    const allowed = String(env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const origin = request.headers.get('Origin');
    if (origin && allowed.length && !allowed.includes(origin))
      return json({ error: 'Origin not allowed.' }, 403);
    if (Number(request.headers.get('content-length') || 0) > 65536)
      return json({ error: 'Request too large.' }, 413, cors);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const parts = url.pathname.split('/').filter(Boolean);

    try {
      if (parts[0] === 'partytracks') {
        const appId = String(env.CF_REALTIME_APP_ID || env.CALLS_APP_ID || '').trim();
        const appToken = String(
          env.CF_REALTIME_APP_TOKEN || env.CF_REALTIME_APP_SECRET || env.CALLS_APP_SECRET || '',
        ).trim();
        if (!appId || !appToken)
          return json({ error: 'Cloudflare Realtime credentials are not configured.' }, 500, cors);
        const isIceServers = url.pathname === '/partytracks/generate-ice-servers';
        const allowedRoute =
          isIceServers ||
          /^\/partytracks\/sessions\/(?:new|[A-Za-z0-9_-]+\/(?:renegotiate|tracks\/(?:new|update|close)))$/.test(
            url.pathname,
          );
        if (!allowedRoute) return json({ error: 'Unknown media endpoint.' }, 404, cors);
        if (isIceServers ? request.method !== 'GET' : !['POST', 'PUT'].includes(request.method))
          return json({ error: 'Method not allowed.' }, 405, cors);
        const opensMedia =
          parts[1] === 'sessions' &&
          (parts[2] === 'new' || (parts[3] === 'tracks' && parts[4] === 'new'));
        if (opensMedia) {
          const budget = await budgetState(env);
          if (budget.blocked) {
            return json(
              {
                error: budget.unavailable
                  ? 'Usage protection is temporarily unavailable. New media is paused.'
                  : `Bandwidth cap reached: ${budget.usedGb} GB of ${budget.capGb} GB in the last ${budget.windowDays} days. New media is paused. Capacity returns as older usage ages out. This is an estimate; check Cloudflare usage for actual billing.`,
                budgetBlocked: true,
                usedGb: budget.usedGb,
                capGb: budget.capGb,
              },
              503,
              cors,
            );
          }
        }

        const room = request.headers.get('x-room') || '';
        const participantId = request.headers.get('x-participant-id') || '';
        const token = request.headers.get('x-participant-token') || '';
        if (!ROOM_RE.test(room)) return json({ error: 'Invalid room.' }, 400, cors);
        const sessionId = parts[1] === 'sessions' && parts[2] !== 'new' ? parts[2] : null;
        const auth = await verify(env, room, participantId, token, sessionId);
        if (!auth.ok) return json({ error: 'Unauthorized (SimpleShare room auth)' }, 401, cors);
        if (parts[3] === 'tracks' && parts[4] === 'new') {
          const body = await readJson(request.clone());
          const remoteSessionIds = Array.isArray(body.tracks)
            ? body.tracks
                .filter((track) => track?.location === 'remote')
                .map((track) => track.sessionId)
            : [];
          if (remoteSessionIds.length) {
            const stub = await roomStub(env, room);
            const check = await stub
              .fetch('https://room/can-pull', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ participantId, token, remoteSessionIds }),
              })
              .then((response) => response.json());
            if (!check.ok)
              return json({ error: 'Requested stream is not in this room.' }, 403, cors);
          }
        }
        const response = await routePartyTracksRequest({
          appId,
          token: appToken,
          request,
          prefix: '/partytracks',
          lockSessionToInitiator: false,
          turnServerAppId: String(env.CF_TURN_APP_ID || '').trim() || undefined,
          turnServerAppToken: String(env.CF_TURN_APP_TOKEN || '').trim() || undefined,
        });
        if (parts[1] === 'sessions' && parts[2] === 'new' && response.ok) {
          const created = await response.clone().json();
          if (!created.sessionId)
            return json({ error: 'Media service returned no session.' }, 502, cors);
          const stub = await roomStub(env, room);
          const registered = await stub.fetch('https://room/register-session', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ participantId, token, sessionId: created.sessionId }),
          });
          if (!registered.ok)
            return json(
              { error: 'Could not register the media session.' },
              registered.status,
              cors,
            );
        }
        if (!response.ok) {
          let peek = '';
          try {
            peek = (await response.clone().text()).slice(0, 400);
          } catch {}
          console.log(
            `[partytracks] ${request.method} ${url.pathname} -> ${response.status} :: ${peek}`,
          );
          const out = new Response(response.body, response);
          for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
          out.headers.set('x-ss-pt-status', String(response.status));
          out.headers.set('x-ss-pt-origin', 'upstream-or-partytracks');
          return out;
        }
        if (isIceServers) {
          const extra = fallbackTurn(env);
          if (extra.length) {
            try {
              const data = await response.clone().json();
              const existing = Array.isArray(data?.iceServers) ? data.iceServers : [];
              const hasRelay = existing.some((entry) =>
                [].concat(entry?.urls || []).some((u) => String(u).startsWith('turn')),
              );
              const merged = hasRelay ? existing : [...existing, ...extra];
              const patched = json({ ...data, iceServers: merged }, 200, cors);
              patched.headers.set('x-ss-relay', hasRelay ? 'cloudflare' : 'fallback');
              return patched;
            } catch {}
          }
        }
        const out = new Response(response.body, response);
        for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
        return out;
      }

      if (parts[0] === 'api' && parts[1] === 'rooms' && ROOM_RE.test(parts[2] || '')) {
        const room = parts[2];
        const stub = await roomStub(env, room);
        let path = '/';
        if (parts[3] === 'join') path = '/join';
        else if (parts[3] === 'leave') path = '/leave';
        else if (parts[3] === 'socket') path = `/socket${url.search}`;
        else if (parts[3] === 'snapshot') path = '/snapshot';
        else if (parts[3] === 'stream' && parts[4] === 'upsert') path = '/stream-upsert';
        else if (parts[3] === 'stream' && parts[4] === 'remove') path = '/stream-remove';
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
        if (!ROOM_RE.test(room)) return json({ error: 'Invalid room.' }, 400, cors);
        const response = await publishRealtimeSdp(request, env, room, participantId, token);
        const out = new Response(response.body, response);
        for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
        return out;
      }

      if (parts[0] === 'api' && parts[1] === 'sfu') {
        const bodyForAuth = await readJson(request.clone());
        const room = bodyForAuth.room || request.headers.get('x-room') || '';
        const participantId =
          bodyForAuth.participantId || request.headers.get('x-participant-id') || '';
        const token = bodyForAuth.token || request.headers.get('x-participant-token') || '';
        if (!ROOM_RE.test(room))
          return new Response(JSON.stringify({ error: 'Invalid room.' }), {
            status: 400,
            headers: { ...cors, 'content-type': 'application/json' },
          });

        let operation = null,
          sessionId = null;
        if (parts[2] === 'session') operation = 'new-session';
        else if (parts[2] === 'sessions' && parts[3]) {
          sessionId = parts[3];
          if (parts[4] === 'tracks' && parts[5] === 'new') operation = 'tracks-new';
          if (parts[4] === 'tracks' && parts[5] === 'update') operation = 'tracks-update';
          if (parts[4] === 'tracks' && parts[5] === 'close') operation = 'tracks-close';
          if (parts[4] === 'renegotiate') operation = 'renegotiate';
        }
        if (!operation)
          return new Response(JSON.stringify({ error: 'Unknown SFU endpoint.' }), {
            status: 404,
            headers: { ...cors, 'content-type': 'application/json' },
          });
        const cleanBody = { ...bodyForAuth };
        delete cleanBody.room;
        delete cleanBody.participantId;
        delete cleanBody.token;
        const proxiedRequest = new Request(request.url, {
          method: request.method,
          headers: { 'content-type': 'application/json' },
          body: request.method === 'GET' ? undefined : JSON.stringify(cleanBody),
        });
        const response = await proxyRealtime(
          proxiedRequest,
          env,
          room,
          participantId,
          token,
          operation,
          sessionId,
        );
        const out = new Response(response.body, response);
        for (const [k, v] of Object.entries(cors)) out.headers.set(k, v);
        return out;
      }
      if (url.pathname === '/api/budget') {
        return json(await budgetState(env), 200, { ...cors, 'cache-control': 'no-store' });
      }

      if (url.pathname === '/debug/realtime') {
        if (
          !env.DEBUG_TOKEN ||
          request.headers.get('Authorization') !== `Bearer ${env.DEBUG_TOKEN}`
        )
          return json({ error: 'Not found' }, 404, cors);
        const appId = String(env.CF_REALTIME_APP_ID || env.CALLS_APP_ID || '').trim();
        const appToken = String(
          env.CF_REALTIME_APP_TOKEN || env.CF_REALTIME_APP_SECRET || env.CALLS_APP_SECRET || '',
        ).trim();
        if (!appId || !appToken)
          return json(
            {
              ok: false,
              reason: 'missing-credentials',
              hasAppId: Boolean(appId),
              hasAppToken: Boolean(appToken),
            },
            200,
            cors,
          );
        const r = await fetch(`${RTC_BASE}/${encodeURIComponent(appId)}/sessions/new`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${appToken}` },
        });
        const text = await r.text();
        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text.slice(0, 300) };
        }
        return json(
          {
            ok: r.ok && Boolean(parsed.sessionId),
            upstreamStatus: r.status,
            gotSessionId: Boolean(parsed.sessionId),
            appIdLength: appId.length,
            appTokenLength: appToken.length,
            upstream: parsed.sessionId ? '(session created)' : parsed,
          },
          200,
          cors,
        );
      }

      if (url.pathname === '/health')
        return json(
          {
            ok: true,
            worker: 'simpleshare-room-api',
            build: 'simpleshare-6.0.0',
            mediaBridge: 'partytracks',
            sessionLock: false,
            iceServersAuthExempt: false,
            roomsBinding: Boolean(env.ROOMS),
            managedRoomMode: 'cloud',
            socketGracePeriodSeconds: GRACE_MS / 1000,
            roomTickSeconds: TICK_ACTIVE_MS / 1000,
            roomIdleTickSeconds: TICK_IDLE_MS / 1000,
            budgetPushedOverSocket: true,
            snapshotPolling: 'socket-recovery-only',
            p2pFallback: 'explicit-direct-link',
            revisionedSnapshots: true,
            serverKeepalive: true,
            resumableSessions: true,
            oneStreamPerParticipant: true,
            watcherEvents: true,
            budgetBinding: Boolean(env.BUDGET),
            budgetBasis: 'rolling-31-day',
            fallbackRelay: fallbackTurn(env).length > 0,
            turnConfigured: Boolean(
              String(env.CF_TURN_APP_ID || '').trim() && String(env.CF_TURN_APP_TOKEN || '').trim(),
            ),
            realtimeConfigured: Boolean(
              String(env.CF_REALTIME_APP_ID || env.CALLS_APP_ID || '').trim() &&
              String(
                env.CF_REALTIME_APP_TOKEN ||
                  env.CF_REALTIME_APP_SECRET ||
                  env.CALLS_APP_SECRET ||
                  '',
              ).trim(),
            ),
          },
          200,
          cors,
        );
      if (url.pathname.startsWith('/api/'))
        return json({ error: 'Unknown SimpleShare API route.' }, 404, cors);
      return new Response('SimpleShare room API', { status: 200, headers: cors });
    } catch (error) {
      const message = error?.message || 'Unexpected error';
      if (quotaHint(message)) {
        return new Response(JSON.stringify({ error: message, code: 'do-quota', fallback: 'p2p' }), {
          status: 503,
          headers: { ...cors, 'content-type': 'application/json' },
        });
      }
      return new Response(
        JSON.stringify({
          error: error.status ? message : 'The room service encountered an error. Try again.',
        }),
        { status: error.status || 500, headers: { ...cors, 'content-type': 'application/json' } },
      );
    }
  },
};
