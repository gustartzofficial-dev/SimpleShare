import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { roomFixture, addScreens } from './helpers/room-fixture.mjs';
async function ready(page, path) {
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
}

test('WebKit phone owner announcement fits without hiding room controls', async ({ page }) => {
  await roomFixture(page);
  await page.evaluate(() =>
    globalThis.__roomFixture.handleMessage({
      type: 'server-ping',
      budget: {
        usedGb: 0,
        capGb: 900,
        percent: 0,
        blocked: false,
        announcement: {
          id: 'phone-message',
          text: 'A heads-up for everyone. '.repeat(35),
          expiresAt: Date.now() + 60000,
        },
      },
    }),
  );
  await expect(page.locator('#globalAnnouncement')).toBeVisible();
  await expect(page.locator('#settingsBtn')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'work/qa/announcement-phone.png', fullPage: true });
  await page.getByRole('button', { name: 'Dismiss announcement' }).click();
  await expect(page.locator('#globalAnnouncement')).toBeHidden();
});

test('WebKit phone zero volume stays muted through a replacement and master-volume change', async ({
  page,
}) => {
  await roomFixture(page);
  await addScreens(page, 1, { audio: true });
  const tile = page.locator('.tile').last();
  await tile.focus();
  await tile.locator('.tile-audio').click();
  await tile.locator('.tile-volume-range').fill('0');
  await page.evaluate(() => {
    const f = globalThis.__roomFixture,
      tile = f.state.tiles.get('test-0');
    f.applyGlobalVolume(1);
    f.receiveSharedAudio(tile, tile.audio.srcObject);
  });
  expect(
    await page.evaluate(() => {
      const tile = globalThis.__roomFixture.state.tiles.get('test-0');
      return {
        muted: tile.audio.muted,
        volume: tile.playbackVolume,
        slider: tile.volumeRange.value,
      };
    }),
  ).toEqual({ muted: true, volume: 0, slider: '0' });
});

test('WebKit phone landing is usable in portrait and landscape', async ({ page }) => {
  await ready(page, '/');
  await expect(page.locator('#createBtn')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 844, height: 390 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('WebKit phone viewer has usable members, settings, and focus controls', async ({ page }) => {
  await ready(page, '/?demo=1');
  await expect(page.locator('#shareBtn')).toBeDisabled();
  await page.locator('#membersBtn').click();
  await expect(page.locator('#peoplePanel')).toBeVisible();
  await page.locator('#membersCloseBtn').click();
  await page.locator('#settingsBtn').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await page.locator('#settingsCloseBtn').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({
    path: 'work/qa/room-webkit-phone.png',
    fullPage: true,
    animations: 'disabled',
  });
});
for (const path of ['/', '/?demo=1'])
  test('WebKit phone accessibility ' + path, async ({ page }) => {
    await ready(page, path);
    const result = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze();
    expect(
      result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
    ).toEqual([]);
  });

test('WebKit phone audio-source settings explain capture support without overflow', async ({
  page,
}) => {
  await ready(page, '/?demo=1');
  await page.locator('#settingsBtn').click();
  await page.locator('#shareAudioSources').scrollIntoViewIfNeeded();
  await expect(page.locator('#addExtraAudioBtn')).toBeDisabled();
  await expect(page.locator('#extraAudioStatus')).toContainText('supported desktop browser');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'work/qa/secondary-audio-phone.png' });
});
