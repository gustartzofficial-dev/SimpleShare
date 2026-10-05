import { test, expect } from '@playwright/test';
import { roomFixture } from './helpers/room-fixture.mjs';
test('an idle media engine is disposed instead of creating another disconnected allocation @desktop', async ({
  page,
}) => {
  await roomFixture(page);
  expect(
    await page.evaluate(() => {
      const { state, releaseIdleEngine } = globalThis.__roomFixture;
      const seen = [];
      state.share = null;
      state.watching.clear();
      state.subs.clear();
      state.tracks = {};
      state.tracksSessionSub = { unsubscribe: () => seen.push('session') };
      state.pcStateSub = { unsubscribe: () => seen.push('state') };
      state.pcSub = { unsubscribe: () => seen.push('pc') };
      releaseIdleEngine();
      return { seen, engine: state.tracks };
    }),
  ).toEqual({ seen: ['session', 'state', 'pc'], engine: null });
});
test('terminal media authorization failure is surfaced once without an unhandled rejection @desktop', async ({
  page,
}) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await roomFixture(page);
  await page.route('**/partytracks/**', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Room membership expired' }),
    }),
  );
  await page.evaluate(() => {
    const f = globalThis.__roomFixture;
    f.state.apiBase = location.origin;
    f.initTracks();
  });
  await expect(page.locator('#status')).toContainText('Media unavailable');
  expect(errors).toEqual([]);
});

test('a failed room announcement retries without resetting the publisher @desktop', async ({
  page,
}) => {
  await roomFixture(page);
  let calls = 0;
  await page.route('**/api/rooms/*/stream/upsert', (route) => {
    calls++;
    return route.fulfill({
      status: calls === 1 ? 503 : 200,
      contentType: 'application/json',
      body: JSON.stringify(calls === 1 ? { error: 'Temporary outage' } : { ok: true }),
    });
  });
  await page.evaluate(() => {
    const f = globalThis.__roomFixture;
    f.state.apiBase = location.origin;
    f.state.roomId = '1234567890abcdef12345678';
    f.state.share = {
      streamId: 'local',
      profile: '720p60',
      videoMeta: { sessionId: 'new-session', trackName: 'video' },
      audioMeta: null,
    };
    f.scheduleAnnounce(f.state.share);
  });
  await expect(page.locator('#status')).toContainText('Sharing');
  expect(calls).toBe(2);
  expect(await page.evaluate(() => globalThis.__roomFixture.state.share.streamId)).toBe('local');
});

test('media session creation sends an explicit JSON object @desktop', async ({ page }) => {
  await roomFixture(page);
  const creation = page.waitForRequest((request) =>
    request.url().includes('/partytracks/sessions/new'),
  );
  await page.route('**/partytracks/**', (route) =>
    route.fulfill({
      status: 401,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Test boundary' }),
    }),
  );
  await page.evaluate(() => {
    const f = globalThis.__roomFixture;
    f.state.apiBase = location.origin;
    f.initTracks();
  });
  const request = await creation;
  expect(request.method()).toBe('POST');
  expect(request.postDataJSON()).toEqual({});
  expect(request.headers()['content-type']).toBe('application/json');
  await expect(page.locator('#status')).toContainText('Media unavailable');
});
