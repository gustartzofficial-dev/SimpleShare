import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
let bundle;
export async function roomFixture(page) {
  if (!bundle) {
    const source = await readFile(new URL('../../../public/app.js', import.meta.url), 'utf8');
    const result = await build({
      stdin: {
        contents:
          source +
          '\nglobalThis.__roomFixture={state,ensureTile,showIdleTile,showLocalTile,setFocus,reconcileSnapshot,dropStream,renderGrid,watchdog,PartyTracks,of};',
        resolveDir: fileURLToPath(new URL('../../../public/', import.meta.url)),
      },
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'browser',
      target: 'es2022',
    });
    bundle = result.outputFiles[0].text;
  }
  await page.route('**/app.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: bundle }),
  );
  await page.goto('/?demo=1', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => Boolean(globalThis.__roomFixture));
  await page.evaluate(() => document.fonts.ready);
}
export async function addScreens(page, count, { idle = false, audio = false } = {}) {
  await page.evaluate(
    ({ count, idle, audio }) => {
      const f = globalThis.__roomFixture;
      for (let i = 0; i < count; i++) {
        const ann = {
          id: 'test-' + i,
          ownerId: 'guest-' + i,
          ownerName: 'Screen ' + (i + 1),
          profile: '720p60',
          sessionId: 'test-session-' + i,
          videoTrackName: 'test-track',
          audio,
        };
        f.state.streams.set(ann.id, ann);
        const tile = idle ? f.showIdleTile(ann, true) : f.ensureTile(ann);
        tile.video.poster = f.state.tiles.get('preview-art').video.poster;
        tile.card.querySelector('.tile-name').textContent = ann.ownerName;
        if (audio) {
          if (typeof MediaStream === 'function') tile.audio.srcObject = new MediaStream();
          else Object.defineProperty(tile.audio, 'srcObject', { value: {}, writable: true });
          tile.audioBtn.classList.remove('hidden');
        }
      }
      f.renderGrid();
    },
    { count, idle, audio },
  );
}
