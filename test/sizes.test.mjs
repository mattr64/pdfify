import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { PDFDocument } from 'pdf-lib';
import { convertFiles, detectKind, imageDpi, NATIVE_SIZES, UserError } from '../src/convert.js';
import { hooks, photo } from './helpers.mjs';

const sharp = createRequire(import.meta.url)('sharp');
const KB = 1000, MB = 1000 * 1000;
const base = { size: 'a4', orientation: 'portrait', margin: 'none', fit: 'fit', combine: false };
const fx = (n) => new Uint8Array(fs.readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
const run = async (files, o = {}) => (await convertFiles(files, { ...base, ...o }, hooks())).filter((r) => r.bytes);
const dims = async (bytes) => (await PDFDocument.load(bytes)).getPages().map((p) => [p.getWidth(), p.getHeight()]);
const near = (a, b, tol = 0.05) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const pdfWith = async (sizes) => { const d = await PDFDocument.create(); sizes.forEach(([w, h]) => d.addPage([w, h]).drawText('hi', { x: 10, y: 10 })); return new Uint8Array(await d.save()); };
let n = 0;
const test = async (name, fn) => { const t = Date.now(); await fn(); n++; console.log(`ok - ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); };

// ---------- HEIC ----------
await test('HEIC is recognised by content; AVIF and video are told apart', async () => {
  assert.equal(detectKind(fx('tiny-landscape.heic'), 'IMG_0001.HEIC').format, 'heic');
  assert.equal(detectKind(fx('tiny-landscape.heic'), 'renamed.jpg').format, 'heic');
  const avif = new Uint8Array(await sharp(await photo(64, 48)).avif().toBuffer());
  assert.equal(detectKind(avif, 'a.avif').format, 'avif');
  const mp4 = new Uint8Array([0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70, 0x69, 0x73, 0x6f, 0x6d, 0, 0, 2, 0, 0x69, 0x73, 0x6f, 0x6d, 0x6d, 0x70, 0x34, 0x31, ...new Array(40).fill(0)]);
  assert.throws(() => detectKind(mp4, 'clip.heic'), (e) => e instanceof UserError && /video/.test(e.message));
});

await test('HEIC converts to PDF; rotation is respected (portrait stays portrait)', async () => {
  const [l] = await run([{ name: 'l.heic', bytes: fx('tiny-landscape.heic') }], { orientation: 'auto' });
  const [p] = await run([{ name: 'p.heic', bytes: fx('tiny-portrait.heic') }], { orientation: 'auto' });
  const [lw, lh] = (await dims(l.bytes))[0], [pw, ph] = (await dims(p.bytes))[0];
  assert.ok(lw > lh, 'landscape'); assert.ok(ph > pw, 'portrait');
});

await test('HEIC at original size: page = pixels at 72 dpi', async () => {
  const [r] = await run([{ name: 'p.heic', bytes: fx('tiny-portrait.heic') }], { size: 'original' });
  const [w, h] = (await dims(r.bytes))[0]; near(w, 180); near(h, 240);
});

// ---------- DPI ----------
await test('image DPI is read from JPEG and PNG, null when absent', async () => {
  const jpg300 = new Uint8Array(await sharp(await photo(300, 200)).withMetadata({ density: 300 }).jpeg().toBuffer());
  const png150 = new Uint8Array(await sharp(await photo(300, 200)).withMetadata({ density: 150 }).png().toBuffer());
  near(imageDpi(jpg300, 'jpeg'), 300, 1); near(imageDpi(png150, 'png'), 150, 1);
  assert.equal(imageDpi(await photo(300, 200), 'jpeg') === null || imageDpi(await photo(300, 200), 'jpeg') >= 10, true);
  assert.equal(imageDpi(new Uint8Array([1, 2, 3]), 'jpeg'), null);
  const png25 = new Uint8Array(await sharp(await photo(300, 200)).withMetadata({ density: 25.4 }).png().toBuffer());
  assert.equal(imageDpi(png25, 'png'), null); // implausibly low = unset, so 72 is used
});

// ---------- relative sizes: PDFs ----------
const mixed = await pdfWith([[612, 792], [500, 300]]);
await test('PDF original size: every page keeps its own size', async () => {
  const [r] = await run([{ name: 'm.pdf', bytes: mixed }], { size: 'original', orientation: 'portrait' }); // orientation is ignored
  const [a, b] = await dims(r.bytes);
  near(a[0], 612); near(a[1], 792); near(b[0], 500); near(b[1], 300);
});
await test('PDF 75% and 50% scale each page', async () => {
  for (const [id, f] of [['p75', 0.75], ['p50', 0.5]]) {
    const [r] = await run([{ name: 'm.pdf', bytes: mixed }], { size: id });
    const [a, b] = await dims(r.bytes);
    near(a[0], 612 * f); near(a[1], 792 * f); near(b[0], 500 * f); near(b[1], 300 * f);
  }
});
await test('margins are ignored for relative sizes: the page is exactly the scaled source', async () => {
  const [r] = await run([{ name: 'm.pdf', bytes: mixed }], { size: 'p50', margin: 'medium' });
  const [a] = await dims(r.bytes);
  near(a[0], 306); near(a[1], 396);
});

// ---------- relative sizes: images ----------
await test('images: page is the physical size (pixels / dpi), 72 dpi when unknown', async () => {
  const noDpi = new Uint8Array(await sharp(await photo(600, 400)).png().toBuffer());
  const jpg300 = new Uint8Array(await sharp(await photo(1200, 800)).withMetadata({ density: 300 }).jpeg().toBuffer());
  let [r] = await run([{ name: 'a.png', bytes: noDpi }], { size: 'original' });
  let [w, h] = (await dims(r.bytes))[0]; near(w, 600); near(h, 400);
  [r] = await run([{ name: 'b.jpg', bytes: jpg300 }], { size: 'original' });
  [w, h] = (await dims(r.bytes))[0]; near(w, 288, 0.5); near(h, 192, 0.5);
  [r] = await run([{ name: 'b.jpg', bytes: jpg300 }], { size: 'p50' });
  [w, h] = (await dims(r.bytes))[0]; near(w, 144, 0.5); near(h, 96, 0.5);
});
await test('text files use A4 as their "original"', async () => {
  const [r] = await run([{ name: 't.txt', bytes: new TextEncoder().encode('hello\n'.repeat(30)) }], { size: 'p75' });
  const [w, h] = (await dims(r.bytes))[0]; near(w, 595.28 * 0.75, 0.5); near(h, 841.89 * 0.75, 0.5);
});
await test('output names say which size was used', async () => {
  const [a] = await run([{ name: 'm.pdf', bytes: mixed }], { size: 'original' });
  const [b] = await run([{ name: 'm.pdf', bytes: mixed }], { size: 'p75' });
  assert.match(a.name, /original\.pdf$/); assert.match(b.name, /75pct\.pdf$/);
  assert.equal(NATIVE_SIZES.length, 3);
});

// ---------- relative sizes + size limit ----------
await test('large photo at original size still obeys a size limit (resolution scales with the image)', async () => {
  const big = await photo(3000, 2000, 5);
  const [r] = await run([{ name: 'big.jpg', bytes: big }], { size: 'original', targetBytes: 900 * KB });
  const [w, h] = (await dims(r.bytes))[0];
  near(w, 3000); near(h, 2000); // physical size unchanged
  assert.ok(r.bytes.length <= 900 * KB && r.report.reached, `${r.bytes.length}`);
  console.log(`     3000x2000 original: ${(big.length / MB).toFixed(1)} MB -> ${Math.round(r.bytes.length / KB)} KB @ ${r.report.rung.dpi}dpi`);
});
await test('photo PDF at 50% obeys a size limit and keeps the 50% pages', async () => {
  const d = await PDFDocument.create();
  for (let i = 0; i < 3; i++) { const p = d.addPage([595, 842]); p.drawImage(await d.embedJpg(await photo(2000, 1400, i + 1)), { x: 30, y: 200, width: 535, height: 374 }); p.drawText('text', { x: 40, y: 780 }); }
  const [r] = await run([{ name: 'ph.pdf', bytes: new Uint8Array(await d.save()) }], { size: 'p50', targetBytes: 900 * KB });
  const [w, h] = (await dims(r.bytes))[0]; near(w, 297.5); near(h, 421);
  assert.ok(r.bytes.length <= 900 * KB && r.report.reached);
});

console.log(`\n${n} size/HEIC tests passed`);
