// Copies pdf.js data files (fonts, CJK character maps, wasm decoders, ICC profiles) into public/pdfjs
// so they are served from our own domain. Runs automatically before dev and build.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.dirname(require.resolve('pdfjs-dist/package.json'));
const dest = path.resolve('public/pdfjs');
fs.rmSync(dest, { recursive: true, force: true });
for (const dir of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  fs.cpSync(path.join(root, dir), path.join(dest, dir), { recursive: true });
}
console.log('pdf.js assets copied to public/pdfjs');
