import { cp, mkdir, rm } from 'node:fs/promises';
import { build } from 'esbuild';
const root = new URL('../', import.meta.url);
const dist = new URL('../dist/', import.meta.url);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
await cp(new URL('../public/index.html', import.meta.url), new URL('../dist/index.html', import.meta.url));
await cp(new URL('../public/styles.css', import.meta.url), new URL('../dist/styles.css', import.meta.url));
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
