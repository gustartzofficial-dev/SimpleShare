import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const room = '1234567890abcdef12345678';
async function ready(page, path = '/') {
  await page.goto(path);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() =>
    Promise.all(document.getAnimations().map((animation) => animation.finished)),
  );
}
async function assertNoOverflow(page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
}
for (const width of [320, 390, 768, 1440]) {
  test(`home fits ${width}px with working icons`, async ({ page }, info) => {
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await ready(page);
    await expect(
      page.getByRole('heading', { name: 'Good things are better shared.' }),
    ).toBeVisible();
    await assertNoOverflow(page);
    expect(
      await page.locator('#createBtn i').evaluate((element) => getComputedStyle(element).maskImage),
    ).toContain('arrow-up-right.svg');
    await page.screenshot({
      path: `work/qa/home-${info.project.name}-${width}.png`,
      fullPage: true,
      animations: 'disabled',
    });
    expect(errors).toEqual([]);
  });
}
test('invite validation explains failures and keeps navigation local', async ({ page }) => {
  await ready(page);
  await page.locator('#roomLink').fill('javascript:alert(1)');
  await page.getByRole('button', { name: 'Join room', exact: true }).click();
  await expect(page.locator('#joinError')).toContainText('http or https');
  await expect(page.locator('#roomLink')).toBeFocused();
  await page.locator('#roomLink').fill('https://other.example/?room=' + room);
  await page.getByRole('button', { name: 'Join room', exact: true }).click();
  await expect(page).toHaveURL('http://127.0.0.1:4173/?room=' + room);
  await expect(page.locator('#roomError')).toBeVisible();
});
test('create generates a room and missing configuration is actionable', async ({ page }) => {
  await ready(page);
  await page.locator('#createBtn').click();
  await expect(page).toHaveURL(/\?room=[a-f0-9]{24}$/);
  await expect(page.locator('#roomError')).toContainText('ROOM_API_URL');
  await expect(page.locator('#shareBtn')).toBeDisabled();
  await expect(page.locator('#directBtn')).toBeVisible();
});
test('preview is explicitly labelled and does not contact external services', async ({
  page,
}, info) => {
  const external = [];
  page.on('request', (request) => {
    if (!request.url().startsWith('http://127.0.0.1:4173') && !request.url().startsWith('data:'))
      external.push(request.url());
  });
  await ready(page, '/?demo=1');
  await expect(page.locator('#previewBanner')).toBeVisible();
  await expect(page.locator('#streamCount')).toHaveText('1');
  await expect(page.locator('#peopleCount')).toHaveText('3');
  await expect(page.locator('.tile-name')).toContainText('Sample screen');
  await page.screenshot({
    path: `work/qa/room-${info.project.name}-desktop.png`,
    fullPage: true,
    animations: 'disabled',
  });
  expect(external).toEqual([]);
});
test('settings contain focus, close with Escape, and preserve appearance', async ({ page }) => {
  await ready(page, '/?demo=1');
  await page.getByRole('button', { name: 'Open settings', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Dark', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('#settingsBtn')).toBeFocused();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
});
test('blocked browser storage does not prevent the app from loading', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new DOMException('Storage disabled', 'SecurityError');
      },
    });
  });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await ready(page, '/?demo=1');
  await expect(page.locator('#previewBanner')).toBeVisible();
  expect(errors).toEqual([]);
});
test('mobile viewers get a clear unsupported capture state', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      value: undefined,
      configurable: true,
    });
  });
  await ready(page, '/?demo=1');
  await expect(page.locator('#shareBtn')).toBeDisabled();
  await expect(page.locator('#shareBtn')).toHaveAttribute('title', /desktop browser/);
  await expect(page.locator('#peoplePanel')).not.toBeVisible();
  await page.locator('#membersBtn').click();
  await expect(page.locator('#peoplePanel')).toBeVisible();
  await expect(page.locator('#membersBtn')).toHaveAttribute('aria-expanded', 'true');
  await assertNoOverflow(page);
  await page.locator('#settingsBtn').click();
  await expect(page.locator('#sharingHelp')).toContainText('watch shared screens');
  await page.keyboard.press('Escape');
  await page.screenshot({
    path: `work/qa/room-${info.project.name}-phone.png`,
    fullPage: true,
    animations: 'disabled',
  });
});
test('clipboard rejection gives a selected invite instead of a false success', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('Denied');
        },
      },
      configurable: true,
    });
  });
  await ready(page, '/?room=' + room);
  await expect(page.locator('#roomError')).toBeVisible();
  await page.locator('#copyBtn').click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.locator('#toast')).toContainText('Couldn’t copy automatically');
  expect(
    await page
      .locator('#inviteLink')
      .evaluate((input) => input.selectionEnd - input.selectionStart),
  ).toBeGreaterThan(20);
});
test('capture requests are serialized and stopping releases the track', async ({ page }) => {
  await page.addInitScript(() => {
    window.captureCalls = 0;
    window.stoppedTracks = 0;
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        window.captureCalls++;
        await new Promise((resolve) => setTimeout(resolve, 120));
        const canvas = document.createElement('canvas');
        canvas.width = 640;
        canvas.height = 360;
        canvas.getContext('2d').fillRect(0, 0, 640, 360);
        const media = canvas.captureStream(30);
        const track = media.getVideoTracks()[0];
        const stop = track.stop.bind(track);
        track.stop = () => {
          window.stoppedTracks++;
          stop();
        };
        return media;
      },
    });
  });
  await ready(page, '/?demo=1');
  await page.locator('#shareBtn').evaluate((button) => {
    button.click();
    button.click();
  });
  await expect(page.locator('#stopBtn')).toBeVisible();
  expect(await page.evaluate(() => window.captureCalls)).toBe(1);
  await page.locator('#stopBtn').click();
  await expect(page.locator('#shareBtn')).toBeVisible();
  expect(await page.evaluate(() => window.stoppedTracks)).toBe(1);
  await expect(page.locator('#streamCount')).toHaveText('1');
});
test('screen picker cancellation returns to a usable state', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        throw new DOMException('Cancelled', 'NotAllowedError');
      },
    });
  });
  await ready(page, '/?demo=1');
  await page.locator('#shareBtn').click();
  await expect(page.locator('#shareBtn')).toBeEnabled();
  await expect(page.locator('#stopBtn')).not.toBeVisible();
});
test('whole-monitor audio is discarded even if the browser ignores capture hints', async ({
  page,
}) => {
  await page.addInitScript(() => {
    window.audioStopped = false;
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        const canvas = document.createElement('canvas');
        const video = canvas.captureStream().getVideoTracks()[0];
        const settings = video.getSettings.bind(video);
        video.getSettings = () => ({ ...settings(), displaySurface: 'monitor' });
        const ctx = new AudioContext(),
          dest = ctx.createMediaStreamDestination();
        const audio = dest.stream.getAudioTracks()[0];
        const stop = audio.stop.bind(audio);
        audio.stop = () => {
          window.audioStopped = true;
          stop();
        };
        return new MediaStream([video, audio]);
      },
    });
  });
  await ready(page, '/?demo=1');
  await page.locator('#shareBtn').click();
  await expect(page.locator('#stopBtn')).toBeVisible();
  expect(await page.evaluate(() => window.audioStopped)).toBe(true);
  await page.locator('#stopBtn').click();
});
for (const path of ['/', '/?demo=1'])
  for (const theme of ['light', 'dark'])
    test(`accessibility ${path} ${theme}`, async ({ page }) => {
      await page.addInitScript((value) => localStorage.setItem('simpleshare-theme', value), theme);
      await ready(page, path);
      const result = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(
        result.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
      ).toEqual([]);
      if (path.includes('demo')) {
        await page.locator('#settingsBtn').click();
        const settings = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
          .analyze();
        expect(
          settings.violations.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target) })),
        ).toEqual([]);
      }
    });
