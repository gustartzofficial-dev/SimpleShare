import { routePartyTracksRequest } from "partytracks/server";

const ROOM_RE = /^[A-Za-z0-9_-]{20,80}$/;
const PARTICIPANT_RE = /^[a-f0-9-]{20,80}$/i;
const MAX_PARTICIPANTS = 10;
const RTC_BASE = 'https://rtc.live.cloudflare.com/v1/apps';

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

export class RoomHub {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
  }

  async getState() {
    return (await this.ctx.storage.get('state')) || { participants: {}, streams: {}, sessions: {} };
  }

  async putState(state) {
    await this.ctx.storage.put('state', state);
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
        const expired = p.disconnectedAt ? (now - p.disconnectedAt > 20_000) : (now - p.joinedAt > 30_000);
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
      state.streams[streamId] = stream;
      await this.putState(state);
      this.broadcast({ type:'stream-upsert', stream });
      return json({ ok:true, stream });
    }

    if (method === 'POST' && url.pathname === '/stream-remove') {
      const body = await readJson(request);
      const state = await this.getState();
      const participant = state.participants[body.participantId];
      if (!participant || participant.token !== body.token) return json({ error: 'Unauthorized' }, 401);
      const streamId = String(body.streamId || '');
      if (state.streams[streamId]?.ownerId !== participant.id) return json({ error:'Stream not found.' }, 404);
      delete state.streams[streamId];
      await this.putState(state);
      this.broadcast({ type:'stream-remove', streamId });
      return json({ ok:true });
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
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      server.serializeAttachment({ participantId });
      this.ctx.acceptWebSocket(server);
      this.send(server, { type: 'snapshot', ...this.publicSnapshot(state) });
      this.broadcast({ type: 'participant-joined', participant: { id: participant.id, name: participant.name, joinedAt: participant.joinedAt, mode: participant.mode } }, participantId);
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

    if (msg.type === 'rename') {
      participant.name = safeName(msg.name);
      await this.putState(state);
      this.broadcast({ type: 'participant-updated', participant: { id: participant.id, name: participant.name, joinedAt: participant.joinedAt, mode: participant.mode } });
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
      state.streams[streamId] = stream;
      await this.putState(state);
      this.broadcast({ type: 'stream-upsert', stream });
      return;
    }

    if (msg.type === 'stream-remove') {
      const streamId = String(msg.streamId || '');
      if (state.streams[streamId]?.ownerId !== participantId) return;
      delete state.streams[streamId];
      await this.putState(state);
      this.broadcast({ type: 'stream-remove', streamId });
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
    await this.putState(state);
    this.broadcast({ type: 'participant-left', participantId, removedStreams });
  }

  // A closed socket used to delete the participant immediately. That made every
  // reconnect return 401 (the token no longer matched anyone) AND killed every
  // PartyTracks request, which retries 401s forever without surfacing an error.
  // One brief network blip therefore bricked the whole session silently.
  // Now a disconnect starts a 25s grace period instead.
  async markDisconnected(participantId) {
    const stillLive = this.sockets().some(ws => (ws.deserializeAttachment() || {}).participantId === participantId);
    if (stillLive) return;
    const state = await this.getState();
    const p = state.participants[participantId];
    if (!p) return;
    p.disconnectedAt = Date.now();
    await this.putState(state);
    try { await this.ctx.storage.setAlarm(Date.now() + 22_000); } catch {}
  }

  async alarm() {
    const state = await this.getState();
    const liveIds = new Set(this.sockets().map(ws => (ws.deserializeAttachment() || {}).participantId).filter(Boolean));
    const cutoff = Date.now() - 20_000;
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
        this.broadcast({ type: 'participant-left', participantId: id, removedStreams });
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
    if (stillPending) { try { await this.ctx.storage.setAlarm(Date.now() + 10_000); } catch {} }
  }

  async webSocketClose(ws) {
    const { participantId } = ws.deserializeAttachment() || {};
    if (participantId) await this.markDisconnected(participantId);
  }

  async webSocketError(ws) {
    const { participantId } = ws.deserializeAttachment() || {};
    if (participantId) await this.markDisconnected(participantId);
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
        build:'budget-v16',
        mediaBridge:'partytracks',
        sessionLock:false,
        iceServersAuthExempt:true,
        roomsBinding:Boolean(env.ROOMS),
        directModeRetired:true,
        socketGracePeriodSeconds:20,
        resumableSessions:true,
        turnConfigured:Boolean(String(env.CF_TURN_APP_ID || '').trim() && String(env.CF_TURN_APP_TOKEN || '').trim()),
        realtimeConfigured:Boolean(
          String(env.CF_REALTIME_APP_ID || env.CALLS_APP_ID || '').trim() &&
          String(env.CF_REALTIME_APP_TOKEN || env.CF_REALTIME_APP_SECRET || env.CALLS_APP_SECRET || '').trim()
        ),
      }, 200, cors);
      if (url.pathname.startsWith('/api/')) return json({ error:'Unknown SimpleShare API route.' }, 404, cors);
      return new Response('SimpleShare room API', { status: 200, headers: cors });
    } catch (error) {
      return new Response(JSON.stringify({ error: error?.message || 'Unexpected error' }), { status: 500, headers: { ...cors, 'content-type': 'application/json' } });
    }
  },
};
