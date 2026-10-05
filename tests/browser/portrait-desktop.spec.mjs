import { test, expect } from '@playwright/test';
import { roomFixture, addScreens } from './helpers/room-fixture.mjs';
test('portrait desktop stacks bounded screen cards and keeps focus thumbnails adjacent @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1080, height: 1800 });
  await roomFixture(page);
  await addScreens(page, 1, { idle: true });
  await expect(page.locator('#grid')).toHaveClass(/portrait-desktop/);
  const cards = page.locator('#gridMain .tile');
  const a = await cards.nth(0).boundingBox(),
    b = await cards.nth(1).boundingBox();
  expect(Math.abs(a.x - b.x)).toBeLessThan(2);
  expect(b.y).toBeGreaterThanOrEqual(a.y + a.height);
  expect(a.width / a.height).toBeGreaterThan(1.65);
  await expect(page.locator('.tile.idle .idle-watch')).toBeVisible();
  await page.screenshot({ path: 'work/qa/portrait-desktop-stack.png' });
  await page.evaluate(() => globalThis.__roomFixture.setFocus('preview-art'));
  const main = await page.locator('#gridMain .tile').boundingBox(),
    rail = await page.locator('#gridRail').boundingBox();
  expect(rail.y - main.y - main.height).toBeLessThan(15);
  expect(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight + 1)).toBe(
    true,
  );
  await page.screenshot({ path: 'work/qa/portrait-desktop.png' });
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(page.locator('#grid')).not.toHaveClass(/portrait-desktop/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('#grid')).not.toHaveClass(/portrait-desktop/);
});
