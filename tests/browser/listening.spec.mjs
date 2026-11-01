import { test, expect } from '@playwright/test';
import { roomFixture } from './helpers/room-fixture.mjs';

async function attach(page, id = 'listening', ownerId = 'listening-owner') {
  await page.evaluate(
    ({ id, ownerId }) => {
      const f = globalThis.__roomFixture;
      if (!globalThis.testTone) {
        const context = new AudioContext();
        const source = context.createOscillator();
        const output = context.createMediaStreamDestination();
        source.connect(output);
        source.start();
        globalThis.testTone = { context, source, stream: output.stream };
      }
      const ann = { id, ownerId, ownerName: 'Audio test', audio: true };
      f.state.streams.set(id, ann);
      const tile = f.ensureTile(ann);
      f.receiveSharedAudio(tile, new MediaStream(globalThis.testTone.stream.getAudioTracks()));
    },
    { id, ownerId },
  );
}
const audioState = (page, id = 'listening') =>
  page.evaluate((id) => {
    const tile = globalThis.__roomFixture.state.tiles.get(id);
    return { muted: tile.audio.muted, volume: tile.playbackVolume, slider: tile.volumeRange.value };
  }, id);

test('stream mute and zero survive repeated replacement, tile recreation, and page refresh @desktop', async ({
  page,
}) => {
  await roomFixture(page);
  await attach(page);
  const tile = page.locator('.tile').last();
  await tile.focus();
  await tile.locator('.tile-audio').click();
  await tile.locator('.tile-mute').click();
  for (let i = 0; i < 3; i++) await attach(page);
  expect((await audioState(page)).muted).toBe(true);
  await page.evaluate(() => globalThis.__roomFixture.removeTile('listening'));
  await attach(page, 'replacement');
  expect((await audioState(page, 'replacement')).muted).toBe(true);
  await page.reload();
  await page.waitForFunction(() => Boolean(globalThis.__roomFixture));
  await attach(page);
  expect((await audioState(page)).muted).toBe(true);
  await page.locator('.tile').last().focus();
  await page.locator('.tile').last().locator('.tile-audio').click();
  await page.locator('.tile').last().locator('.tile-volume-range').fill('0');
  await page.evaluate(() => globalThis.__roomFixture.applyGlobalVolume(1));
  for (let i = 0; i < 3; i++) await attach(page);
  expect(await audioState(page)).toEqual({ muted: true, volume: 0, slider: '0' });
  await page.reload();
  await page.waitForFunction(() => Boolean(globalThis.__roomFixture));
  await attach(page);
  expect(await audioState(page)).toEqual({ muted: true, volume: 0, slider: '0' });
});

test('master mute does not erase individual choices and stale play failures cannot remute a replacement @desktop', async ({
  page,
}) => {
  await roomFixture(page);
  await attach(page);
  await page.evaluate(async () => {
    const f = globalThis.__roomFixture,
      tile = f.state.tiles.get('listening');
    f.setTileAudioState(tile, true);
    f.toggleAllAudio();
    f.toggleAllAudio();
    if (!tile.audio.muted) throw Error('Master unmute erased per-stream mute');
    let rejectOld;
    tile.audio.play = () =>
      new Promise((resolve, reject) => {
        rejectOld = reject;
      });
    f.setTileAudioState(tile, false);
    tile.audio.play = () => Promise.resolve();
    f.receiveSharedAudio(tile, new MediaStream(globalThis.testTone.stream.getAudioTracks()));
    rejectOld(new Error('Old playback failed'));
    await Promise.resolve();
    await Promise.resolve();
  });
  expect((await audioState(page)).muted).toBe(false);
  await page.evaluate(() => {
    const f = globalThis.__roomFixture,
      tile = f.state.tiles.get('listening');
    tile.audio.play = () => Promise.reject(new Error('Autoplay denied'));
    f.receiveSharedAudio(tile, new MediaStream(globalThis.testTone.stream.getAudioTracks()));
  });
  await expect
    .poll(() =>
      page.evaluate(() => globalThis.__roomFixture.state.tiles.get('listening').audioBlocked),
    )
    .toBe(true);
  await page.evaluate(() => {
    globalThis.__roomFixture.state.tiles.get('listening').audio.play = () => Promise.resolve();
  });
  await page.locator('.tile').last().focus();
  await page.locator('.tile').last().locator('.tile-audio').click();
  await page.getByRole('button', { name: 'Enable shared audio', exact: true }).click();
  expect((await audioState(page)).muted).toBe(false);
  await page.evaluate(() => {
    const f = globalThis.__roomFixture;
    f.toggleAllAudio();
  });
  await attach(page);
  expect((await audioState(page)).muted).toBe(true);
});

test('popup notices leave the viewing stage unchanged and ignore older control revisions @desktop', async ({
  page,
}) => {
  await roomFixture(page);
  const before = await page.locator('.stage').boundingBox();
  await page.evaluate(() =>
    globalThis.__roomFixture.handleMessage({
      type: 'server-ping',
      budget: {
        usedGb: 0,
        capGb: 900,
        blocked: false,
        controlRevision: 5,
        announcement: { id: 'popup', text: 'An owner update', expiresAt: Date.now() + 60000 },
        maintenance: { id: 'maintenance', enabled: true, text: 'Changes in progress.' },
      },
    }),
  );
  await expect(page.locator('#globalAnnouncement')).toBeVisible();
  await expect(page.locator('#maintenanceNotice')).toBeVisible();
  const popup = await page.locator('#maintenanceNotice').boundingBox();
  expect(popup.x).toBeGreaterThan(600);
  expect(popup.y).toBeLessThan(30);
  expect(await page.locator('.stage').boundingBox()).toEqual(before);
  await page.screenshot({ path: 'work/qa/site-popups-desktop.png' });
  await page.evaluate(() =>
    globalThis.__roomFixture.handleMessage({
      type: 'server-ping',
      budget: {
        usedGb: 0,
        capGb: 900,
        blocked: false,
        controlRevision: 6,
        announcement: null,
        maintenance: { enabled: false },
      },
    }),
  );
  await page.evaluate(() =>
    globalThis.__roomFixture.handleMessage({
      type: 'server-ping',
      budget: {
        usedGb: 0,
        capGb: 900,
        blocked: false,
        controlRevision: 5,
        announcement: { id: 'stale', text: 'Old', expiresAt: Date.now() + 60000 },
        maintenance: { enabled: true, id: 'old', text: 'Old' },
      },
    }),
  );
  await expect(page.locator('#globalAnnouncement')).toBeHidden();
  await expect(page.locator('#maintenanceNotice')).toBeHidden();
});

test('homepage polls maintenance and displays a dismissible owner warning @desktop', async ({
  page,
}) => {
  await page.route('**/api/config', (route) =>
    route.fulfill({ json: { roomApiUrl: 'https://test-worker.example' } }),
  );
  await page.route('https://test-worker.example/api/announcements', (route) =>
    route.fulfill({
      json: {
        announcement: null,
        controlRevision: 1,
        maintenance: { id: 'home-warning', enabled: true, text: 'Site updates are underway.' },
      },
    }),
  );
  await page.goto('/');
  await expect(page.locator('#maintenanceNoticeText')).toHaveText('Site updates are underway.');
  await expect(page.locator('#createBtn')).toBeEnabled();
  await page.getByRole('button', { name: 'Dismiss maintenance warning' }).click();
  await expect(page.locator('#maintenanceNotice')).toBeHidden();
});
