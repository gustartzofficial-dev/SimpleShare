import { test, expect } from '@playwright/test';
import { roomFixture, addScreens } from './helpers/room-fixture.mjs';
test.setTimeout(60000);
async function fits(page) {
  const result = await page.evaluate(() => {
    const main = document.querySelector('.grid-main'),
      grid = document.querySelector('#grid');
    return {
      page: document.documentElement.scrollHeight <= innerHeight + 1,
      width: document.documentElement.scrollWidth <= innerWidth,
      main: main.scrollHeight <= main.clientHeight + 1,
      grid: grid.scrollHeight <= grid.clientHeight + 1,
    };
  });
  expect(result).toEqual({ page: true, width: true, main: true, grid: true });
}
test('screen controls fade away and reveal on hover or tap', async ({ page }, info) => {
  await roomFixture(page);
  const tile = page.locator('.tile').first(),
    bar = tile.locator('.tile-bar');
  await page.mouse.move(0, 0);
  await expect(bar).toHaveCSS('opacity', '0');
  if (info.project.name === 'webkit-phone') {
    await tile.locator('video').tap();
    await expect(bar).toHaveCSS('opacity', '1');
    await expect(bar).toHaveCSS('opacity', '0', { timeout: 5000 });
  } else {
    await tile.hover();
    await expect(bar).toHaveCSS('opacity', '1');
    await page.mouse.move(0, 0);
    await expect(bar).toHaveCSS('opacity', '0');
    await tile.focus();
    await expect(bar).toHaveCSS('opacity', '1');
  }
});
test('volume is a click-open slider with mute and Escape dismissal', async ({ page }) => {
  await roomFixture(page);
  await addScreens(page, 1, { audio: true });
  const tile = page.locator('.tile').last();
  await tile.focus();
  await expect(tile.locator('.tile-volume')).not.toBeVisible();
  await tile.locator('.tile-audio').click();
  await expect(tile.locator('.tile-volume')).toBeVisible();
  await expect(tile.locator('.tile-audio')).toHaveAttribute('aria-expanded', 'true');
  await tile.locator('.tile-volume-range').fill('35');
  expect(await tile.locator('audio').evaluate((a) => a.volume)).toBeCloseTo(0.35);
  await expect(tile.locator('.tile-volume-value')).toHaveText('35%');
  await tile.locator('.tile-mute').click();
  expect(await tile.locator('audio').evaluate((a) => a.muted)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(tile.locator('.tile-volume')).not.toBeVisible();
  await expect(tile.locator('.tile-audio')).toHaveAttribute('aria-expanded', 'false');
});
test('focus puts the selected screen above compact thumbnails without scrollbars', async ({
  page,
}, info) => {
  await roomFixture(page);
  await addScreens(page, 2);
  await page.evaluate(() => globalThis.__roomFixture.setFocus('test-1'));
  const main = page.locator('#gridMain .tile'),
    rail = page.locator('#gridRail .tile');
  await expect(main).toHaveCount(1);
  await expect(rail).toHaveCount(2);
  const a = await main.boundingBox(),
    b = await rail.first().boundingBox();
  expect(a.height).toBeGreaterThan(b.height * 2);
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
  await fits(page);
  await rail.first().locator('video').click();
  await expect(page.locator('#gridMain .tile-name')).toHaveText('Alex · Sample screen');
  await page.screenshot({
    path: 'work/qa/focus-refined-' + info.project.name + '.png',
    animations: 'disabled',
  });
});
test('idle single screen keeps its full stage height and watch action', async ({ page }) => {
  await roomFixture(page);
  await addScreens(page, 1, { idle: true });
  await page.evaluate(() => globalThis.__roomFixture.dropStream('preview-art'));
  const tile = page.locator('.tile'),
    idle = tile.locator('.tile-idle');
  expect((await tile.boundingBox()).height).toBeGreaterThan(180);
  expect((await idle.boundingBox()).height).toBeGreaterThan(180);
  await expect(tile.locator('.idle-name')).toHaveText('Screen 1');
  await expect(tile.locator('.idle-watch')).toBeVisible();
  await fits(page);
});
test('many focus thumbnails use page buttons instead of a scrolling rail', async ({ page }) => {
  await roomFixture(page);
  await addScreens(page, 9);
  await page.evaluate(() => globalThis.__roomFixture.setFocus('preview-art'));
  await expect(page.locator('#gridPages')).toBeVisible();
  await page.locator('#nextScreensBtn').click();
  await expect(page.locator('#screenPage')).toContainText('2 /');
  await fits(page);
  await page.setViewportSize({ width: 844, height: 390 });
  await fits(page);
});
test('room header uses the brand icon without the wordmark', async ({ page }) => {
  await roomFixture(page);
  await expect(page.locator('.topbar .room-brand')).toHaveAccessibleName('SimpleShare home');
  await expect(page.locator('.topbar .room-brand')).toHaveText('');
});
test('@desktop snapshot and stream removal cannot erase active local capture', async ({
  page,
}, info) => {
  test.skip(info.project.name === 'webkit-phone', 'Desktop capture regression');
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        const media = canvas.captureStream(15);
        window.localCapture = media.getVideoTracks()[0];
        return media;
      },
    });
  });
  await roomFixture(page);
  await page.locator('#shareBtn').click();
  await expect(page.locator('.tile.local')).toHaveCount(1);
  await page.evaluate(async () => {
    const f = globalThis.__roomFixture,
      id = f.state.share.streamId;
    f.state.streams.set(id, { id, ownerId: f.state.participantId });
    await f.reconcileSnapshot({ rev: 99, participants: [], streams: [] }, 'test');
    await f.dropStream(id);
  });
  await expect(page.locator('.tile.local')).toHaveCount(1);
  expect(await page.evaluate(() => window.localCapture.readyState)).toBe('live');
  await page.locator('#stopBtn').click();
  await expect(page.locator('.tile.local')).toHaveCount(0);
  expect(await page.evaluate(() => window.localCapture.readyState)).toBe('ended');
});
test('landscape waiting screens keep their Watch action inside the tile', async ({ page }) => {
  await roomFixture(page);
  await addScreens(page, 6, { idle: true });
  await page.evaluate(() => globalThis.__roomFixture.dropStream('preview-art'));
  await page.setViewportSize({ width: 844, height: 390 });
  await fits(page);
  const cards = page.locator('#gridMain .tile:visible');
  for (let i = 0; i < (await cards.count()); i++) {
    const card = await cards.nth(i).boundingBox();
    const action = await cards.nth(i).locator('.idle-watch').boundingBox();
    expect(action.y).toBeGreaterThanOrEqual(card.y);
    expect(action.y + action.height).toBeLessThanOrEqual(card.y + card.height);
  }
});
