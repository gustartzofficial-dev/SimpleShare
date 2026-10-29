import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import worker, { BudgetTracker } from '../../cloudflare-worker/src/index.js';
import { roomFixture } from './helpers/room-fixture.mjs';

const password = 'test-only-owner-password-123456789';
async function backend(page) {
  const stored = new Map();
  let queue = Promise.resolve();
  const env = { ADMIN_PASSWORD: password, MONTHLY_EGRESS_CAP_GB: '900' };
  const budget = new BudgetTracker(
    {
      storage: {
        get: async (key) => structuredClone(stored.get(key)),
        put: async (key, value) => {
          if (typeof key === 'object') {
            for (const [name, entry] of Object.entries(key))
              stored.set(name, structuredClone(entry));
          } else stored.set(key, structuredClone(value));
        },
      },
      blockConcurrencyWhile(callback) {
        const run = queue.then(callback);
        queue = run.catch(() => {});
        return run;
      },
    },
    env,
  );
  env.BUDGET = {
    idFromName: (id) => id,
    get: () => ({ fetch: (input, init) => budget.fetch(new Request(input, init)) }),
  };
  await budget.fetch(
    new Request('https://budget/add', { method: 'POST', body: JSON.stringify({ bytes: 950e9 }) }),
  );
  await page.route(/\/admin(?:\/.*)?$/, async (route) => {
    const original = route.request();
    const response = await worker.fetch(
      new Request(original.url(), {
        method: original.method(),
        headers: await original.allHeaders(),
        body: original.postDataBuffer() || undefined,
      }),
      env,
    );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
}
async function signIn(page) {
  await page.goto('/admin');
  await expect(page.locator('#login')).toBeVisible();
  await page.getByLabel('Owner password').fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: false }).click();
  await expect(page.locator('#dashboard')).toBeVisible();
}

test('owner can sign in, match billing day, reset a blocked app, publish/remove a message, and revoke the session @desktop', async ({
  page,
}) => {
  await backend(page);
  await signIn(page);
  await expect(page.locator('#usageState')).toHaveText('Sharing paused');
  await page.getByLabel('Day of the month').fill('18');
  await page.getByRole('button', { name: 'Save billing day' }).click();
  await expect(page.locator('#feedback')).toHaveText('Monthly billing day saved.');
  await page.getByLabel('Type RESET').fill('RESET');
  await page.getByRole('button', { name: 'Reset app counter' }).click();
  await expect(page.locator('#usageState')).toHaveText('Sharing available');
  await expect(page.locator('#used')).toHaveText('0');
  await page.getByLabel('Your message').fill('Maintenance at 21:00.\nYour screens are safe.');
  await page.getByRole('button', { name: 'Publish message' }).click();
  await expect(page.locator('#activeText')).toHaveText(
    'Maintenance at 21:00.\nYour screens are safe.',
  );
  await page.getByRole('button', { name: 'Remove message' }).click();
  await expect(page.locator('#activeMessage')).toBeHidden();
  const cookie = (await page.context().cookies()).find((item) => item.name === 'ss_admin');
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Strict');
  await page.reload();
  await expect(page.locator('#dashboard')).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).some((key) => /admin|password|token/i.test(key)),
    ),
  ).toBe(false);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'work/qa/admin-dashboard.png', fullPage: true });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.locator('#login')).toBeVisible();
  await page.reload();
  await expect(page.locator('#login')).toBeVisible();
});

test('owner sign-in errors stay private and the console fits a narrow screen @desktop', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await backend(page);
  await page.goto('/admin');
  await expect(page.locator('#login')).toBeVisible();
  await page.getByLabel('Owner password').fill('incorrect');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#feedback')).toHaveText('Incorrect password.');
  await expect(page.locator('#password')).toHaveValue('');
  await page.getByLabel('Owner password').fill(password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('#dashboard')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.screenshot({ path: 'work/qa/admin-phone.png', fullPage: true });
});

test('global announcements render as plain text, dismiss per message, expire, and do not block room controls @desktop', async ({
  page,
}) => {
  await roomFixture(page);
  await page.evaluate(async () => {
    globalThis.notice = {
      update: (announcement) =>
        globalThis.__roomFixture.handleMessage({
          type: 'server-ping',
          budget: { usedGb: 0, capGb: 900, percent: 0, blocked: false, announcement },
        }),
    };
    globalThis.notice.update({
      id: 'first',
      text: '<img src=x onerror=alert(1)>\nHello everyone.',
      expiresAt: Date.now() + 60000,
    });
  });
  await expect(page.locator('#globalAnnouncement')).toBeVisible();
  await expect(page.locator('#globalAnnouncementText')).toContainText(
    '<img src=x onerror=alert(1)>',
  );
  await expect(page.locator('#globalAnnouncement img')).toHaveCount(0);
  await page.getByRole('button', { name: 'Dismiss announcement' }).click();
  await expect(page.locator('#globalAnnouncement')).toBeHidden();
  await page.evaluate(() =>
    globalThis.notice.update({ id: 'first', text: 'Same', expiresAt: Date.now() + 60000 }),
  );
  await expect(page.locator('#globalAnnouncement')).toBeHidden();
  await page.evaluate(() =>
    globalThis.notice.update({
      id: 'second',
      text: 'A new announcement',
      expiresAt: Date.now() + 700,
    }),
  );
  await expect(page.locator('#globalAnnouncement')).toBeVisible();
  await expect(page.locator('#globalAnnouncement')).toBeHidden({ timeout: 4000 });
  await page.getByRole('button', { name: 'Open settings' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
});
