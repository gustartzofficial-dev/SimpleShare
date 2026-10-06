import { test, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { roomFixture } from './helpers/room-fixture.mjs';
async function sharing(page) {
  await page.addInitScript(() => {
    window.audioCaptures = [];
    window.audioCaptureMode = 'ok';
    navigator.mediaDevices.getDisplayMedia = async () => {
      const isExtra = window.audioCaptures.length > 0;
      if (isExtra && window.audioCaptureMode === 'cancel')
        throw new DOMException('Cancelled', 'NotAllowedError');
      const canvas = document.createElement('canvas');
      canvas.width = 320;
      canvas.height = 180;
      canvas.getContext('2d').fillRect(0, 0, 320, 180);
      const media = canvas.captureStream(20);
      if (isExtra && window.audioCaptureMode === 'monitor') {
        const video = media.getVideoTracks()[0];
        video.getSettings = () => ({ displaySurface: 'monitor' });
      }
      if (!(isExtra && window.audioCaptureMode === 'missing')) {
        const ctx = new AudioContext();
        const osc = ctx.createOscillator();
        const dest = ctx.createMediaStreamDestination();
        osc.frequency.value = isExtra ? 880 : 440;
        osc.connect(dest);
        osc.start();
        ctx.resume();
        media.addTrack(dest.stream.getAudioTracks()[0]);
      }
      window.audioCaptures.push(media);
      if (isExtra && window.audioCaptureMode === 'defer')
        await new Promise((resolve) => {
          window.finishAudioPicker = resolve;
        });
      return media;
    };
  });
  await roomFixture(page);
  await page.locator('#shareBtn').click();
  await expect(page.locator('#stopBtn')).toBeVisible();
  await page.locator('#settingsBtn').click();
  await expect(page.locator('#addExtraAudioBtn')).toBeEnabled();
  return page.evaluate(() => {
    const share = globalThis.__roomFixture.state.share;
    return { video: share.media.getVideoTracks()[0].id, audio: share.audioMixer.track.id };
  });
}
test('secondary audio mixes, replaces and removes without replacing outgoing media @desktop', async ({
  page,
}) => {
  const original = await sharing(page);
  await page.locator('#addExtraAudioBtn').click();
  await expect(page.locator('#extraAudioStatus')).toContainText('Added:');
  await page.locator('#primaryMixSlider').evaluate((input) => {
    input.value = '35';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.locator('#extraMixSlider').evaluate((input) => {
    input.value = '75';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const levels = await page.evaluate(async () => {
    const mix = globalThis.__roomFixture.state.share.audioMixer;
    const context = new AudioContext();
    const analyser = context.createAnalyser();
    analyser.fftSize = 2048;
    const source = context.createMediaStreamSource(new MediaStream([mix.track]));
    source.connect(analyser);
    await context.resume();
    const sample = async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const values = new Float32Array(analyser.fftSize);
      analyser.getFloatTimeDomainData(values);
      return Math.sqrt(values.reduce((sum, n) => sum + n * n, 0) / values.length);
    };
    try {
      mix.setLevels(1, 0);
      const primary = await sample();
      mix.setLevels(0, 1);
      const secondary = await sample();
      mix.setLevels(0, 0);
      const muted = await sample();
      return { primary, secondary, muted };
    } finally {
      mix.setLevels(0.35, 0.75);
      source.disconnect();
      await context.close();
    }
  });
  expect(levels.primary).toBeGreaterThan(0.01);
  expect(levels.secondary).toBeGreaterThan(0.01);
  expect(levels.muted).toBeLessThan(0.001);

  await expect(page.locator('#primaryMixValue')).toHaveText('35%');
  await expect(page.locator('#extraMixValue')).toHaveText('75%');
  await page.locator('#addExtraAudioBtn').click();
  expect(
    await page.evaluate(() =>
      window.audioCaptures[1].getTracks().every((t) => t.readyState === 'ended'),
    ),
  ).toBe(true);
  await page.locator('#removeExtraAudioBtn').click();
  expect(
    await page.evaluate(() =>
      window.audioCaptures[2].getTracks().every((t) => t.readyState === 'ended'),
    ),
  ).toBe(true);
  expect(
    await page.evaluate(() => {
      const share = globalThis.__roomFixture.state.share;
      return { video: share.media.getVideoTracks()[0].id, audio: share.audioMixer.track.id };
    }),
  ).toEqual(original);
  const a11y = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(a11y.violations).toEqual([]);
  await page.screenshot({ path: 'work/qa/secondary-audio-settings.png' });
  await page.locator('#settingsCloseBtn').click();
  await page.locator('#stopBtn').click();
  expect(
    await page.evaluate(() =>
      window.audioCaptures.every((s) => s.getTracks().every((t) => t.readyState === 'ended')),
    ),
  ).toBe(true);
});
for (const mode of ['cancel', 'missing', 'monitor'])
  test(`secondary audio ${mode} leaves the main share intact @desktop`, async ({ page }) => {
    const original = await sharing(page);
    await page.evaluate((mode) => {
      window.audioCaptureMode = mode;
    }, mode);
    await page.locator('#addExtraAudioBtn').click();
    await expect(page.locator('#addExtraAudioBtn')).toBeEnabled();
    expect(
      await page.evaluate(() => {
        const share = globalThis.__roomFixture.state.share;
        return {
          video: share.media.getVideoTracks()[0].id,
          audio: share.audioMixer.track.id,
          extra: share.audioMixer.extraTrack,
        };
      }),
    ).toEqual({ ...original, extra: null });
    expect(
      await page.evaluate(() =>
        window.audioCaptures
          .slice(1)
          .every((s) => s.getTracks().every((t) => t.readyState === 'ended')),
      ),
    ).toBe(true);
  });
test('stopping during the additional picker releases late capture @desktop', async ({ page }) => {
  await sharing(page);
  await page.evaluate(() => {
    window.audioCaptureMode = 'defer';
  });
  await page.locator('#addExtraAudioBtn').click();
  await page.waitForFunction(() => typeof window.finishAudioPicker === 'function');
  await page.evaluate(() => globalThis.__roomFixture.stopShare());
  await page.evaluate(() => window.finishAudioPicker());
  await expect
    .poll(() =>
      page.evaluate(() =>
        window.audioCaptures.every((s) => s.getTracks().every((t) => t.readyState === 'ended')),
      ),
    )
    .toBe(true);
  expect(await page.evaluate(() => globalThis.__roomFixture.state.share)).toBe(null);
});
