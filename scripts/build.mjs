import { appendFile, cp, mkdir, readFile, rm } from 'node:fs/promises';
import { build } from 'esbuild';

const root = new URL('../', import.meta.url);
const dist = new URL('../dist/', import.meta.url);

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await cp(new URL('../public/index.html', import.meta.url), new URL('../dist/index.html', import.meta.url));
await cp(new URL('../public/styles.css', import.meta.url), new URL('../dist/styles.css', import.meta.url));
await cp(new URL('../public/ux-v2.css', import.meta.url), new URL('../dist/ux-v2.css', import.meta.url));
await cp(new URL('../public/ux-v2.js', import.meta.url), new URL('../dist/ux-v2.js', import.meta.url));

// Keep the hotfix separate in source so it is easy to remove/review, but append
// it to the already-loaded UX v2 stylesheet in dist. No index.html change is
// required and the fix always wins the cascade because it is appended last.
const layoutFix = await readFile(new URL('../public/layout-fix.css', import.meta.url), 'utf8');
await appendFile(
  new URL('../dist/ux-v2.css', import.meta.url),
  `\n\n/* ---- SimpleShare layout hotfix ---- */\n${layoutFix}\n`,
  'utf8'
);

await build({
  // entry.js loads compat.js before app.js. This keeps the existing signaling,
  // PartyTracks and fallback code unchanged while allowing browser-specific
  // capture behavior and UI additions to be layered on top.
  entryPoints: [new URL('../public/entry.js', import.meta.url).pathname],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  outfile: new URL('../dist/app.js', import.meta.url).pathname,
  minify: true,
  sourcemap: false,
});
