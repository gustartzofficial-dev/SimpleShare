import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
async function ready(page, path) {
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished)));
}
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
