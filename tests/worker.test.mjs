import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomHub, BudgetTracker } from '../cloudflare-worker/src/profile-worker.js';
import worker from '../cloudflare-worker/src/index.js';
class Storage {
  values = new Map();
  alarm = null;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    this.values.set(key, structuredClone(value));
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(value) {
    this.alarm = value;
  }
  async deleteAlarm() {
    this.alarm = null;
  }
  async deleteAll() {
    this.values.clear();
  }
}
function fixture() {
  const storage = new Storage();
  const sockets = [];
  const ctx = {
    storage,
    blockConcurrencyWhile: (callback) => callback(),
    getWebSockets: () => sockets,
    setWebSocketAutoResponse() {},
    acceptWebSocket(socket) {
      sockets.push(socket);
    },
  };
  const budget = new BudgetTracker({ storage: new Storage() }, { MONTHLY_EGRESS_CAP_GB: '900' });
  const env = {
    MONTHLY_EGRESS_CAP_GB: '900',
    CF_REALTIME_APP_ID: 'test-app',
    CF_REALTIME_APP_SECRET: 'test-secret',
    FALLBACK_TURN_DISABLED: '1',
    ALLOWED_ORIGINS: 'https://app.example',
    BUDGET: {
      idFromName: (name) => name,
      get: () => ({ fetch: (input, init) => budget.fetch(new Request(input, init)) }),
    },
  };
  const room = new RoomHub(ctx, env);
  env.ROOMS = {
    idFromName: (name) => name,
    get: () => ({
      fetch: (input, init) =>
        room.fetch(input instanceof Request ? input : new Request(input, init)),
    }),
  };
  return { room, env, storage, sockets, budget, ctx };
}
const request = (path, body, method = 'POST', headers = {}) =>
  new Request('https://room' + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  });
const join = async (room, name = 'Guest') => (await room.fetch(request('/join', { name }))).json();
const register = async (room, person, sessionId) =>
  room.fetch(request('/register-session', { ...person, sessionId }));
const announce = async (room, person, id, sessionId) =>
  room.fetch(
    request('/stream-upsert', {
      ...person,
      stream: { id, sessionId, videoTrackName: 'video', profile: '720p60' },
    }),
  );

test('sessions resume without duplicate participants and tokens stay private', async () => {
  const { room } = fixture();
  const person = await join(room, 'Alex');
  const resumed = await room
    .fetch(request('/join', { ...person, name: 'Alex again' }))
    .then((r) => r.json());
  assert.equal(resumed.participantId, person.participantId);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.snapshot.participants.length, 1);
  assert.equal('token' in resumed.snapshot.participants[0], false);
});
test('prototype keys cannot authenticate', async () => {
  const { room } = fixture();
  const result = await room
    .fetch(request('/auth', { participantId: 'toString' }))
    .then((r) => r.json());
  assert.equal(result.ok, false);
});
test('room cap includes reserved reconnecting members', async () => {
  const { room } = fixture();
  for (let i = 0; i < 10; i++) await join(room);
  const state = await room.getState();
  const first = Object.values(state.participants)[0];
  first.disconnectedAt = Date.now();
  await room.putState(state);
  const response = await room.fetch(request('/join', { name: 'Overflow' }));
  assert.equal(response.status, 409);
});
test('abandoned joins are swept by the alarm', async () => {
  const { room, ctx } = fixture();
  await join(room);
  assert.notEqual(await ctx.storage.getAlarm(), null);
  const state = await room.getState();
  for (const p of Object.values(state.participants)) p.joinedAt = Date.now() - 60000;
  await room.putState(state);
  await room.alarm();
  assert.equal(Object.keys((await room.getState()).participants).length, 0);
});
test('snapshot requires participant authentication', async () => {
  const { room } = fixture();
  const person = await join(room);
  assert.equal((await room.fetch(request('/snapshot', null, 'GET'))).status, 401);
  assert.equal(
    (
      await room.fetch(
        request('/snapshot', null, 'GET', {
          'x-participant-id': person.participantId,
          'x-participant-token': person.token,
        }),
      )
    ).status,
    200,
  );
});
test('one participant cannot overwrite another screen or publish from their session', async () => {
  const { room } = fixture();
  const a = await join(room, 'A'),
    b = await join(room, 'B');
  await register(room, a, 'session-a');
  await register(room, b, 'session-b');
  assert.equal((await announce(room, a, 'shared-id', 'session-a')).status, 200);
  assert.equal((await announce(room, b, 'shared-id', 'session-b')).status, 403);
  assert.equal((await announce(room, b, 'different-id', 'session-a')).status, 403);
  assert.equal((await room.getState()).streams['shared-id'].ownerId, a.participantId);
});
test('one screen per participant evicts obsolete announcements', async () => {
  const { room } = fixture();
  const a = await join(room);
  await register(room, a, 'session-a');
  await announce(room, a, 'first', 'session-a');
  await announce(room, a, 'second', 'session-a');
  assert.deepEqual(Object.keys((await room.getState()).streams), ['second']);
});
test('leave immediately removes participant, streams, and session permissions', async () => {
  const { room } = fixture();
  const a = await join(room);
  await register(room, a, 'session-a');
  await announce(room, a, 'screen', 'session-a');
  assert.equal((await room.fetch(request('/leave', a))).status, 200);
  const state = await room.getState();
  assert.equal(Object.keys(state.participants).length, 0);
  assert.equal(Object.keys(state.streams).length, 0);
  assert.equal(Object.keys(state.sessions).length, 0);
});
test('remote subscriptions are restricted to announced room streams', async () => {
  const { room } = fixture();
  const a = await join(room);
  assert.equal(
    (await room.fetch(request('/can-pull', { ...a, remoteSessionIds: ['other-room'] }))).status,
    200,
  );
  const check = await room
    .fetch(request('/can-pull', { ...a, remoteSessionIds: ['other-room'] }))
    .then((r) => r.json());
  assert.equal(check.ok, false);
});
test('a session cannot be claimed twice and per-person session count is bounded', async () => {
  const { room } = fixture();
  const a = await join(room),
    b = await join(room);
  await register(room, a, 's0');
  assert.equal((await register(room, b, 's0')).status, 403);
  for (let i = 1; i < 12; i++) await register(room, a, 's' + i);
  assert.equal((await register(room, a, 'overflow')).status, 429);
});
test('meter-only alarms do not create snapshot revision drift', async () => {
  const { room, sockets } = fixture();
  const a = await join(room);
  sockets.push({
    readyState: 1,
    deserializeAttachment: () => ({ participantId: a.participantId }),
    send() {},
  });
  const before = (await room.getState()).rev;
  await room.alarm();
  assert.equal((await room.getState()).rev, before);
});
test('accounting counts potential viewers without trusting client Watch reports', async () => {
  const { room, budget } = fixture();
  const a = await join(room),
    b = await join(room);
  await register(room, a, 'session');
  await announce(room, a, 'screen', 'session');
  const state = await room.getState();
  state.lastAccountedAt = Date.now() - 30000;
  await room.accountEgress(state);
  const summary = await budget.fetch(new Request('https://budget/state')).then((r) => r.json());
  assert.ok(summary.usedGb >= 0.014);
  assert.equal(state.participants[b.participantId].watching, undefined);
});
test('failed accounting preserves pending bytes and reports a blocked meter', async () => {
  const { room, env } = fixture();
  const a = await join(room);
  await join(room);
  await register(room, a, 'session');
  await announce(room, a, 'screen', 'session');
  env.BUDGET.get = () => ({
    fetch: async () => {
      throw new Error('Unavailable');
    },
  });
  const state = await room.getState();
  state.lastAccountedAt = Date.now() - 30000;
  await room.accountEgress(state);
  assert.ok(state.pendingEgressBytes > 0);
  assert.equal((await room.budgetSummary()).blocked, true);
});
test('rolling usage includes the partially overlapping 31st previous date', async () => {
  const { budget } = fixture();
  const oldest = new Date(Date.now() - 31 * 86400000).toISOString().slice(0, 10);
  const old = new Date(Date.now() - 33 * 86400000).toISOString().slice(0, 10);
  const future = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  await budget.ctx.storage.put('daily', { [oldest]: 1e9, [old]: 7e9, [future]: 9e9 });
  const summary = await budget.fetch(new Request('https://budget/state')).then((r) => r.json());
  assert.equal(summary.usedGb, 1);
  assert.equal(summary.basis, 'rolling');
  assert.equal(summary.accountingBucketDays, 32);
});
test('invalid cap values use a safe finite default', async () => {
  const { budget } = fixture();
  budget.env.MONTHLY_EGRESS_CAP_GB = 'bad';
  assert.equal(
    (await budget.fetch(new Request('https://budget/state')).then((r) => r.json())).capGb,
    900,
  );
});
test('CORS restricts origins, including preflight', async () => {
  const { env } = fixture();
  for (const method of ['GET', 'OPTIONS'])
    assert.equal(
      (
        await worker.fetch(
          new Request('https://worker/health', {
            method,
            headers: { origin: 'https://evil.example' },
          }),
          env,
        )
      ).status,
      403,
    );
  const valid = await worker.fetch(
    new Request('https://worker/health', { headers: { origin: 'https://app.example' } }),
    env,
  );
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get('Access-Control-Allow-Origin'), 'https://app.example');
});
test('debug session creation requires an operator token', async () => {
  const { env } = fixture();
  assert.equal((await worker.fetch(new Request('https://worker/debug/realtime'), env)).status, 404);
});
test('invalid and oversized JSON is rejected at the API boundary', async () => {
  const { env } = fixture();
  const url = 'https://worker/api/rooms/1234567890abcdef12345678/join';
  assert.equal(
    (await worker.fetch(new Request(url, { method: 'POST', body: 'null' }), env)).status,
    400,
  );
  assert.equal(
    (
      await worker.fetch(
        new Request(url, { method: 'POST', body: JSON.stringify({ name: 'a'.repeat(70000) }) }),
        env,
      )
    ).status,
    413,
  );
});
test('media mutation requires ownership of the session', async () => {
  const { room, env } = fixture();
  const a = await join(room),
    b = await join(room);
  await register(room, a, 'a-session');
  const response = await worker.fetch(
    new Request('https://worker/partytracks/sessions/a-session/tracks/close', {
      method: 'PUT',
      headers: {
        'x-room': '1234567890abcdef12345678',
        'x-participant-id': b.participantId,
        'x-participant-token': b.token,
      },
      body: '{}',
    }),
    env,
  );
  assert.equal(response.status, 401);
});
test('TURN credentials require a joined participant', async () => {
  const { env } = fixture();
  const response = await worker.fetch(
    new Request('https://worker/partytracks/generate-ice-servers'),
    env,
  );
  assert.equal(response.status, 400);
});
test('media proxy rejects unknown routes', async () => {
  const { env } = fixture();
  assert.equal(
    (await worker.fetch(new Request('https://worker/partytracks/anything'), env)).status,
    404,
  );
});
test('a new media session is registered before being returned', async () => {
  const { room, env } = fixture();
  const a = await join(room);
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ sessionId: 'created-session' }), {
      headers: { 'content-type': 'application/json' },
    });
  try {
    const response = await worker.fetch(
      new Request('https://worker/partytracks/sessions/new', {
        method: 'POST',
        headers: {
          'x-room': '1234567890abcdef12345678',
          'x-participant-id': a.participantId,
          'x-participant-token': a.token,
        },
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal((await room.getState()).sessions['created-session'], a.participantId);
  } finally {
    globalThis.fetch = original;
  }
});
test('a failed usage service blocks new media instead of failing open', async () => {
  const fresh = (await import('../cloudflare-worker/src/index.js?fail-closed')).default;
  const { env } = fixture();
  env.BUDGET.get = () => ({
    fetch: async () => {
      throw new Error('meter down');
    },
  });
  const response = await fresh.fetch(
    new Request('https://worker/partytracks/sessions/new', { method: 'POST' }),
    env,
  );
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /temporarily unavailable/);
});

test('invalid TURN key preserves STUN discovery and reports the configuration error', async () => {
  const { room, env } = fixture();
  const a = await join(room);
  env.CF_TURN_APP_ID = 'missing-key';
  env.CF_TURN_APP_TOKEN = 'test-turn-token';
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ error: 'cannot find specified key' }), { status: 404 });
  try {
    const response = await worker.fetch(
      new Request('https://worker/partytracks/generate-ice-servers', {
        headers: {
          'x-room': '1234567890abcdef12345678',
          'x-participant-id': a.participantId,
          'x-participant-token': a.token,
        },
      }),
      env,
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.match(body.iceWarning, /TURN credentials/);
    assert.ok(body.iceServers[0].urls.every((url) => url.startsWith('stun:')));
    assert.equal(response.headers.get('x-ss-relay'), 'unavailable');
  } finally {
    globalThis.fetch = original;
  }
});

test('retired sessions can be released without losing membership or exhausting recovery slots', async () => {
  const { room } = fixture();
  const a = await join(room),
    b = await join(room);
  for (let i = 0; i < 20; i++) {
    const sessionId = 'cycle-' + i;
    assert.equal((await register(room, a, sessionId)).status, 200);
    assert.equal((await room.fetch(request('/release-session', { ...b, sessionId }))).status, 403);
    assert.equal((await room.fetch(request('/release-session', { ...a, sessionId }))).status, 200);
  }
  assert.equal(Object.keys((await room.getState()).sessions).length, 0);
});
test('an advertised publisher cannot be released until its announcement is replaced', async () => {
  const { room } = fixture();
  const a = await join(room);
  await register(room, a, 'old');
  await announce(room, a, 'screen', 'old');
  assert.equal(
    (await room.fetch(request('/release-session', { ...a, sessionId: 'old' }))).status,
    409,
  );
  await register(room, a, 'new');
  await announce(room, a, 'screen', 'new');
  const rev = (await room.getState()).rev;
  assert.equal(
    (await room.fetch(request('/release-session', { ...a, sessionId: 'old' }))).status,
    200,
  );
  assert.equal((await room.getState()).rev, rev);
});

test('media proxy forwards JSON without incoming Content-Length', async () => {
  const { room, env } = fixture();
  const a = await join(room);
  await register(room, a, 'owned');
  const original = globalThis.fetch;
  let sent;
  globalThis.fetch = async (_url, init) => {
    sent = init;
    return Response.json({ ok: true });
  };
  try {
    const response = await worker.fetch(
      new Request('https://worker/partytracks/sessions/owned/tracks/update', {
        method: 'PUT',
        headers: {
          'x-room': '1234567890abcdef12345678',
          'x-participant-id': a.participantId,
          'x-participant-token': a.token,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ tracks: [{ mid: '0' }] }),
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal(JSON.parse(sent.body).tracks[0].mid, '0');
    assert.equal(sent.headers.Authorization, 'Bearer test-secret');
    assert.equal(sent.headers['x-participant-token'], undefined);
  } finally {
    globalThis.fetch = original;
  }
});
test('valid TURN generation identifies the Cloudflare relay accurately', async () => {
  const { room, env } = fixture();
  const a = await join(room);
  env.CF_TURN_APP_ID = 'turn-key';
  env.CF_TURN_APP_TOKEN = 'turn-token';
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    Response.json(
      {
        iceServers: [
          {
            urls: ['turns:turn.cloudflare.com:443?transport=tcp'],
            username: 'synthetic',
            credential: 'synthetic',
          },
        ],
      },
      { status: 201 },
    );
  try {
    const response = await worker.fetch(
      new Request('https://worker/partytracks/generate-ice-servers', {
        headers: {
          'x-room': '1234567890abcdef12345678',
          'x-participant-id': a.participantId,
          'x-participant-token': a.token,
        },
      }),
      env,
    );
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('x-ss-relay'), 'cloudflare');
    assert.equal((await response.json()).iceServers.length, 1);
  } finally {
    globalThis.fetch = original;
  }
});

test('session creation accepts a zero-byte body stream while media mutations reject it', async () => {
  const { room, env } = fixture();
  const a = await join(room);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++;
    assert.deepEqual(JSON.parse(init.body), {});
    return Response.json({ sessionId: 'empty-body-session' });
  };
  const headers = {
    'x-room': '1234567890abcdef12345678',
    'x-participant-id': a.participantId,
    'x-participant-token': a.token,
  };
  try {
    const response = await worker.fetch(
      new Request('https://worker/partytracks/sessions/new', {
        method: 'POST',
        headers,
        body: '',
      }),
      env,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).sessionId, 'empty-body-session');
    assert.equal((await room.getState()).sessions['empty-body-session'], a.participantId);
    const mutation = await worker.fetch(
      new Request('https://worker/partytracks/sessions/empty-body-session/tracks/new', {
        method: 'POST',
        headers,
        body: '',
      }),
      env,
    );
    assert.equal(mutation.status, 400);
    assert.equal(calls, 1);
    const invalid = await worker.fetch(
      new Request('https://worker/partytracks/sessions/new', {
        method: 'POST',
        headers,
        body: 'null',
      }),
      env,
    );
    assert.equal(invalid.status, 400);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = original;
  }
});
