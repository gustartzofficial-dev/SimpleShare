// Catch calls to functions that do not exist. `node --check` only validates
// syntax, so deleting a function while leaving its call sites behind passes
// every check and then throws at runtime -- which is exactly how
// p2pCloseOut/p2pCloseIn/p2pCloseAllOutbound shipped broken.
import fs from 'node:fs';
const src = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const defined = new Set();
for (const re of [
  /(?:function|class)\s+([A-Za-z_$][\w$]*)/g,
  /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g,
  /(?:const|let|var)\s*\{([^}]+)\}\s*=/g,
  /\b([A-Za-z_$][\w$]*)\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g,
]) for (const m of src.matchAll(re)) m[1].split(',').forEach(n => defined.add(n.trim().split(':').pop().trim()));

// Only audit our own namespaced helpers; anything else has too much noise
// from built-ins, imported symbols and method calls to be worth flagging.
const called = new Set();
for (const m of src.matchAll(/(?<![.\w$])((?:p2p|mq|mqtt)[A-Za-z0-9_$]*)\s*\(/g)) called.add(m[1]);

const missing = [...called].filter(n => !defined.has(n)).sort();
if (missing.length) {
  console.error(`\n  undefined function(s) called: ${missing.join(', ')}\n`);
  process.exit(1);
}
console.log(`  refs ok (${called.size} helpers checked)`);
