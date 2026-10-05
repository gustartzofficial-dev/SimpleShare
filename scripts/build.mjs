import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
const root = new URL('../', import.meta.url);
const dist = new URL('../dist/', import.meta.url);
await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const name of ['index.html', 'styles.css', 'favicon.svg'])
  await cp(new URL('public/' + name, root), new URL(name, dist));
await cp(new URL('licenses/', root), new URL('licenses/', dist), { recursive: true });
await cp(new URL('THIRD_PARTY_NOTICES.md', root), new URL('THIRD_PARTY_NOTICES.md', dist));
await mkdir(new URL('fonts/', dist), { recursive: true });
await cp(
  new URL('node_modules/@fontsource-variable/geist/files/geist-latin-wght-normal.woff2', root),
  new URL('fonts/geist-latin.woff2', dist),
);
const iconNames = new Set([
  'speaker-high',
  'speaker-slash',
  'warning-circle',
  'arrows-out-simple',
  'speaker-low',
  'corners-out',
  'sun',
  'moon',
]);
for (const file of ['public/index.html', 'public/app.js', 'public/lib/ui.js'])
  for (const match of (await readFile(new URL(file, root), 'utf8')).matchAll(/ph-([a-z-]+)/g))
    iconNames.add(match[1]);
await mkdir(new URL('icons/', dist), { recursive: true });
let iconCss =
  '\n.ph{display:inline-block;width:1em;height:1em;background:currentColor;vertical-align:-.125em;mask-size:contain;mask-repeat:no-repeat;mask-position:center}\n';
for (const name of iconNames) {
  await cp(
    new URL('node_modules/@phosphor-icons/core/assets/regular/' + name + '.svg', root),
    new URL('icons/' + name + '.svg', dist),
  );
  iconCss += '.ph-' + name + '{mask-image:url("/icons/' + name + '.svg")}\n';
}
await writeFile(
  new URL('styles.css', dist),
  (await readFile(new URL('styles.css', dist), 'utf8')) + iconCss,
);
await build({
  entryPoints: [fileURLToPath(new URL('public/entry.js', root))],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['es2022'],
  outfile: fileURLToPath(new URL('app.js', dist)),
  minify: true,
});
console.log('Built SimpleShare to dist/ with local fonts and icons.');
