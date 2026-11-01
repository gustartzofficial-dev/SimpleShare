import test from 'node:test';
import assert from 'node:assert/strict';
import worker, { BudgetTracker, RoomHub } from '../cloudflare-worker/src/index.js';
import { monthlyPeriod, addUsage } from '../cloudflare-worker/src/usage-period.js';

class Storage {
  values = new Map();
  alarm = null;
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async put(key, value) {
    if (typeof key === 'object') {
      for (const [name, entry] of Object.entries(key))
        this.values.set(name, structuredClone(entry));
    } else this.values.set(key, structuredClone(value));
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(value) {
    this.alarm = value;
  }
  async deleteAll() {
    this.values.clear();
  }
}
function context() {
  let queue = Promise.resolve();
  return {
    storage: new Storage(),
    getWebSockets: () => [],
    blockConcurrencyWhile(callback) {
      const run = queue.then(callback);
      queue = run.catch(() => {});
      return run;
    },
  };
}
function fixture() {
  const env = {
    ADMIN_PASSWORD: 'test-only-owner-password-123456789',
    MONTHLY_EGRESS_CAP_GB: '900',
    ALLOWED_ORIGINS: 'https://frontend.example',
  };
  const ctx = context();
  const budget = new BudgetTracker(ctx, env);
  const stub = { fetch: (input, init) => budget.fetch(new Request(input, init)) };
  env.BUDGET = { idFromName: (id) => id, get: () => stub };
  const call = (path, body, cookie = '', extra = {}) =>
    worker.fetch(
      new Request('https://worker.example' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          origin: 'https://worker.example',
          'content-type': 'application/json',
          'x-admin-action': '1',
          cookie,
          ...extra,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      env,
    );
  const internal = async (path, body) =>
    (
      await stub.fetch('https://budget' + path, {
        method: body === undefined ? 'GET' : 'POST',
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    ).json();
  const login = async () => {
    const result = await call('/admin/api/login', { password: env.ADMIN_PASSWORD });
    assert.equal(result.status, 200);
    return result.headers.get('set-cookie').split(';')[0];
  };
  return { env, ctx, budget, call, internal, login };
}
async function clock(now, work) {
  const original = Date.now;
  let current = Date.parse(now);
  Date.now = () => current;
  try {
    await work((next) => {
      current = Date.parse(next);
    });
  } finally {
    Date.now = original;
  }
}

test('monthly billing boundaries support month end, leap year, and year rollover', () => {
  for (const [now, day, start, end] of [
    ['2026-10-29', 18, '2026-10-18', '2026-11-18'],
    ['2026-11-01', 1, '2026-11-01', '2026-12-01'],
    ['2026-12-31', 1, '2026-12-01', '2027-01-01'],
    ['2028-02-29', 31, '2028-02-29', '2028-03-31'],
    ['2026-02-27', 31, '2026-01-31', '2026-02-28'],
  ]) {
    const result = monthlyPeriod(Date.parse(now), day);
    assert.equal(new Date(result.start).toISOString().slice(0, 10), start);
    assert.equal(new Date(result.end).toISOString().slice(0, 10), end);
  }
});

test('a saturated counter automatically reopens at the exact cycle boundary without an alarm or restart', async () => {
  await clock('2026-10-31T23:59:59Z', async (advance) => {
    const { internal } = fixture();
    assert.equal((await internal('/add', { bytes: 901e9 })).blocked, true);
    advance('2026-11-01T00:00:00Z');
    const next = await internal('/state');
    assert.equal(next.usedGb, 0);
    assert.equal(next.blocked, false);
    assert.equal(next.nextResetAt, '2026-12-01T00:00:00.000Z');
  });
});

test('existing daily history migrates into the correct custom billing cycle', async () => {
  await clock('2026-10-29T12:00:00Z', async () => {
    const { internal, ctx, env } = fixture();
    env.BILLING_RESET_DAY = '18';
    await ctx.storage.put('daily', {
      '2026-09-30': 300e9,
      '2026-10-17': 500e9,
      '2026-10-18': 1e9,
      '2026-10-29': 2e9,
      '2026-11-01': 90e9,
    });
    const result = await internal('/state');
    assert.equal(result.usedGb, 3);
    assert.equal(result.nextResetAt, '2026-11-18T00:00:00.000Z');
  });
});

test('delayed estimates are split across the cycle boundary and manual reset time', () => {
  const now = Date.parse('2026-11-01T00:01:00Z');
  const daily = {};
  addUsage(daily, { bytes: 2e9, from: now - 120000, to: now }, now, monthlyPeriod(now));
  assert.equal(daily['2026-11-01'], 1e9);
  const reset = {};
  addUsage(
    reset,
    { bytes: 2e9, from: now - 120000, to: now },
    now,
    monthlyPeriod(now),
    now - 30000,
  );
  assert.equal(reset['2026-11-01'], 0.5e9);
});

test('manual reset clears the estimate and rejects old pending traffic without moving the billing date', async () => {
  await clock('2026-10-29T12:00:00Z', async (advance) => {
    const { internal, call, login } = fixture();
    const cookie = await login();
    await internal('/add', { bytes: 950e9 });
    const initial = await internal('/state');
    assert.equal(initial.blocked, true);
    assert.equal((await call('/admin/api/reset', { confirm: 'wrong' }, cookie)).status, 400);
    advance('2026-10-29T12:01:00Z');
    assert.equal((await call('/admin/api/reset', { confirm: 'RESET' }, cookie)).status, 200);
    advance('2026-10-29T12:02:00Z');
    await internal('/add', {
      bytes: 100e9,
      from: Date.parse('2026-10-29T12:00:00Z'),
      to: Date.parse('2026-10-29T12:00:59Z'),
    });
    const fresh = await internal('/state');
    assert.equal(fresh.usedGb, 0);
    assert.equal(fresh.blocked, false);
    assert.equal(fresh.nextResetAt, initial.nextResetAt);
    await internal('/add', {
      bytes: 1e9,
      from: Date.parse('2026-10-29T12:01:00Z'),
      to: Date.now(),
    });
    assert.equal((await internal('/state')).usedGb, 1);
  });
});

test('concurrent usage updates are serialized in the budget object', async () => {
  const { internal } = fixture();
  await Promise.all(Array.from({ length: 40 }, () => internal('/add', { bytes: 1e9 })));
  assert.equal((await internal('/state')).usedGb, 40);
});

test('admin assets contain no secrets and use a restrictive CSP without CORS', async () => {
  const { call, env } = fixture();
  for (const path of ['/admin', '/admin/app.js', '/admin/styles.css']) {
    const result = await call(path);
    assert.equal(result.status, 200);
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('access-control-allow-origin'), null);
    assert.match(result.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.equal((await result.text()).includes(env.ADMIN_PASSWORD), false);
  }
});

test('all admin data and actions require authentication, including unknown and guessed endpoints', async () => {
  const { call } = fixture();
  assert.equal((await call('/admin/api/status')).status, 401);
  for (const path of ['reset', 'settings', 'announcement', 'clear-announcement', 'logout'])
    assert.equal((await call('/admin/api/' + path, {})).status, 401);
  assert.equal((await call('/api/admin/reset', {})).status, 403);
  assert.equal((await call('/admin/api/reset', { confirm: 'RESET' }, 'ss_admin=fake')).status, 401);
});

test('password login issues an HttpOnly secure cookie and the JSON response never contains its token', async () => {
  const { call, env } = fixture();
  const result = await call('/admin/api/login', { password: env.ADMIN_PASSWORD });
  const cookie = result.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /; Secure/);
  const body = await result.json();
  assert.equal(body.token, undefined);
  assert.equal(body.ok, true);
});

test('admin login is disabled without an adequately strong configured secret', async () => {
  const { call, env } = fixture();
  env.ADMIN_PASSWORD = '';
  assert.equal((await call('/admin/api/login', { password: '' })).status, 503);
  env.ADMIN_PASSWORD = 'short';
  assert.equal((await call('/admin/api/login', { password: 'short' })).status, 503);
});

test('failed logins are persistently rate limited even when the object is recreated', async () => {
  const { call, env, ctx } = fixture();
  for (let i = 0; i < 5; i++)
    assert.equal((await call('/admin/api/login', { password: 'bad' })).status, 401);
  const replacement = new BudgetTracker(ctx, env);
  env.BUDGET.get = () => ({ fetch: (input, init) => replacement.fetch(new Request(input, init)) });
  assert.equal((await call('/admin/api/login', { password: env.ADMIN_PASSWORD })).status, 429);
});

test('session expiry, logout, and password rotation revoke server-side access', async () => {
  await clock('2026-10-29T12:00:00Z', async (advance) => {
    const { call, login, env } = fixture();
    const first = await login();
    assert.equal((await call('/admin/api/status', undefined, first)).status, 200);
    await call('/admin/api/logout', {}, first);
    assert.equal((await call('/admin/api/status', undefined, first)).status, 401);
    const second = await login();
    advance('2026-10-29T14:00:01Z');
    assert.equal((await call('/admin/api/status', undefined, second)).status, 401);
    const third = await login();
    env.ADMIN_PASSWORD = 'another-test-only-owner-password';
    assert.equal((await call('/admin/api/status', undefined, third)).status, 401);
  });
});

test('cross-origin and form-based admin mutations are rejected even with a valid session', async () => {
  const { call, login } = fixture();
  const cookie = await login();
  for (const headers of [
    { origin: 'https://frontend.example' },
    { origin: '' },
    { 'x-admin-action': '' },
    { 'content-type': 'text/plain' },
  ])
    assert.equal(
      (await call('/admin/api/reset', { confirm: 'RESET' }, cookie, headers)).status,
      403,
    );
});

test('billing day changes persist, validate input, and recalculate the current cycle', async () => {
  await clock('2026-10-29T12:00:00Z', async () => {
    const { call, login, internal, env } = fixture();
    const cookie = await login();
    for (const resetDay of [0, 32, 1.5, '18'])
      assert.equal((await call('/admin/api/settings', { resetDay }, cookie)).status, 400);
    assert.equal((await call('/admin/api/settings', { resetDay: 18 }, cookie)).status, 200);
    env.BILLING_RESET_DAY = '1';
    const result = await internal('/state');
    assert.equal(result.resetDay, 18);
    assert.equal(result.nextResetAt, '2026-11-18T00:00:00.000Z');
  });
});

test('announcements reach separate room pings, public polling, and new arrivals; expiry and removal propagate', async () => {
  await clock('2026-10-29T12:00:00Z', async (advance) => {
    const { call, login, env } = fixture();
    const cookie = await login();
    const published = await call(
      '/admin/api/announcement',
      { text: '<script>not markup</script>\nA heads-up', minutes: 1 },
      cookie,
    );
    assert.equal(published.status, 200);
    const active = (await published.json()).announcement;
    for (let i = 0; i < 2; i++) {
      const ctx = context();
      const packets = [];
      ctx.getWebSockets = () => [
        {
          deserializeAttachment: () => ({ participantId: 'person' }),
          send: (raw) => packets.push(JSON.parse(raw)),
        },
      ];
      const room = new RoomHub(ctx, env);
      await room.runAlarm();
      assert.equal(
        packets.find((packet) => packet.type === 'server-ping').budget.announcement.id,
        active.id,
      );
    }
    const publicRead = () =>
      worker
        .fetch(new Request('https://worker.example/api/announcements'), env)
        .then((result) => result.json());
    assert.equal((await publicRead()).announcement.text, active.text);
    advance('2026-10-29T12:01:01Z');
    assert.equal((await publicRead()).announcement, null);
    await call('/admin/api/announcement', { text: 'Second message', minutes: 60 }, cookie);
    await call('/admin/api/clear-announcement', {}, cookie);
    assert.equal((await publicRead()).announcement, null);
  });
});

test('blocked room and Worker reads immediately refresh after an admin reset', async () => {
  const { call, login, internal, env } = fixture();
  const room = new RoomHub(context(), env);
  await internal('/add', { bytes: 950e9 });
  assert.equal((await room.budgetSummary()).blocked, true);
  const publicRead = () =>
    worker
      .fetch(new Request('https://worker.example/api/budget'), env)
      .then((result) => result.json());
  assert.equal((await publicRead()).blocked, true);
  const cookie = await login();
  await call('/admin/api/reset', { confirm: 'RESET' }, cookie);
  assert.equal((await room.budgetSummary()).blocked, false);
  assert.equal((await publicRead()).blocked, false);
});

test('announcement validation and public endpoints cannot bypass admin ownership', async () => {
  const { call, login, env } = fixture();
  const cookie = await login();
  for (const body of [
    { text: ' ', minutes: 60 },
    { text: 'x'.repeat(1001), minutes: 60 },
    { text: 'Hello', minutes: 0 },
  ])
    assert.equal((await call('/admin/api/announcement', body, cookie)).status, 400);
  assert.equal(
    (
      await worker.fetch(
        new Request('https://worker.example/api/announcement', {
          method: 'POST',
          body: JSON.stringify({ text: 'spoof' }),
        }),
        env,
      )
    ).status,
    404,
  );
  const body = await worker
    .fetch(new Request('https://worker.example/api/budget'), env)
    .then((result) => result.json());
  assert.equal(body.audit, undefined);
});

test('both current and legacy media entry points enforce the counter and reopen after a reset', async () => {
  const { env, internal, login, call } = fixture();
  env.CF_REALTIME_APP_ID = 'test-app';
  env.CF_REALTIME_APP_SECRET = 'test-secret';
  const room = new RoomHub(context(), env);
  env.ROOMS = {
    idFromName: (id) => id,
    get: () => ({ fetch: (input, init) => room.fetch(new Request(input, init)) }),
  };
  await internal('/add', { bytes: 950e9 });
  const request = (path) =>
    worker.fetch(
      new Request('https://worker.example' + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-room': '1234567890abcdef12345678' },
        body: JSON.stringify({ room: '1234567890abcdef12345678' }),
      }),
      env,
    );
  const paths = ['/partytracks/sessions/new', '/api/sfu/session', '/api/sfu/publish'];
  for (const path of paths) assert.equal((await request(path)).status, 503);
  await call('/admin/api/reset', { confirm: 'RESET' }, await login());
  for (const path of paths) assert.equal((await request(path)).status, 401);
});

test('admin request bodies reject malformed JSON and oversized passwords', async () => {
  const { call, env } = fixture();
  assert.equal((await call('/admin/api/login', { password: 'x'.repeat(1025) })).status, 400);
  const response = await worker.fetch(
    new Request('https://worker.example/admin/api/login', {
      method: 'POST',
      headers: {
        origin: 'https://worker.example',
        'content-type': 'application/json',
        'x-admin-action': '1',
      },
      body: 'null',
    }),
    env,
  );
  assert.equal(response.status, 400);
});

test('maintenance warnings require owner access, persist, and reach public room state without blocking media', async () => {
  const { call, login, env, internal, ctx } = fixture();
  assert.equal(
    (await call('/admin/api/maintenance', { enabled: true, text: 'Updates' })).status,
    401,
  );
  const cookie = await login();
  for (const body of [
    { enabled: 'yes', text: 'Updates' },
    { enabled: true, text: '' },
    { enabled: true, text: 'x'.repeat(1001) },
  ])
    assert.equal((await call('/admin/api/maintenance', body, cookie)).status, 400);
  const on = await call(
    '/admin/api/maintenance',
    { enabled: true, text: 'Updates in progress' },
    cookie,
  ).then((r) => r.json());
  assert.equal(on.maintenance.enabled, true);
  assert.equal(on.blocked, false);
  assert.equal((await ctx.storage.get('usage-control')).maintenance.text, 'Updates in progress');
  const publicState = await worker
    .fetch(new Request('https://worker.example/api/announcements'), env)
    .then((r) => r.json());
  assert.equal(publicState.maintenance.id, on.maintenance.id);
  assert.equal(publicState.controlRevision, on.controlRevision);
  const off = await call(
    '/admin/api/maintenance',
    { enabled: false, text: 'Updates in progress' },
    cookie,
  ).then((r) => r.json());
  assert.equal(off.maintenance.enabled, false);
  assert.ok(off.controlRevision > on.controlRevision);
  assert.equal((await internal('/state')).blocked, false);
});
