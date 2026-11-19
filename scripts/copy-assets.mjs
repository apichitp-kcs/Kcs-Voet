// Copies shared assets (fonts, logos) into voter/ and desktop/renderer/.
// Run after `npm install`:  npm run assets
import { cpSync, mkdirSync } from 'node:fs';

const root = new URL('../', import.meta.url);
const p = (rel) => new URL(rel, root);
const fonts = ['thai', 'latin'].flatMap((s) => [400, 500, 600, 700].map((w) => `prompt-${s}-${w}-normal.woff2`));

for (const dest of ['voter/fonts/', 'desktop/renderer/fonts/']) {
  mkdirSync(p(dest), { recursive: true });
  for (const f of fonts) cpSync(p(`node_modules/@fontsource/prompt/files/${f}`), p(dest + f));
}
mkdirSync(p('desktop/renderer/assets/'), { recursive: true });
for (const f of ['kcs-logo-transparent.png', 'kcs-logo-white.png', 'kcs-mark.png']) {
  cpSync(p(`assets/${f}`), p(`desktop/renderer/assets/${f}`));
}
console.log('assets copied');
