import assert from 'node:assert/strict';
import sharp from 'sharp';
import { PDFDocument, PDFName, PDFRawStream, rgb } from 'pdf-lib';
import { convertFiles, jpegOrientation, RUNGS } from '../src/convert.js';
import { hooks, photo, pdfText } from './helpers.mjs';

const KB = 1000, MB = 1000 * 1000;
const base = { size: 'a4', orientation: 'portrait', margin: 'small', fit: 'fit', combine: false };
const t0 = Date.now();
let n = 0;
const test = async (name, fn) => { const t = Date.now(); await fn(); n++; console.log(`ok - ${name} (${((Date.now() - t) / 1000).toFixed(1)}s)`); };
const run = async (files, o = {}, h = hooks()) => (await convertFiles(files, { ...base, ...o }, h)).filter((r) => r.bytes);
const fmt = (b) => (b > MB ? (b / MB).toFixed(2) + ' MB' : Math.round(b / KB) + ' KB');

async function makePhotoPdf(pages, fmtName = 'jpeg', alpha = false, w = 2000, h = 1400) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) {
    const p = d.addPage([595, 842]);
    const bytes = await photo(w, h, i + 1, fmtName, alpha);
    const img = fmtName === 'png' ? await d.embedPng(bytes) : await d.embedJpg(bytes);
    p.drawImage(img, { x: 30, y: 200, width: 535, height: 535 * h / w });
    p.drawText(`PDFify searchable text page ${i + 1}`, { x: 40, y: 780, size: 18 });
  }
  return new Uint8Array(await d.save());
}

const jpegPdf = await makePhotoPdf(4);
console.log(`fixture: 4-page JPEG PDF = ${fmt(jpegPdf.length)}`);

await test('EXIF orientation is read', async () => {
  const buf = await sharp(await photo(64, 48)).withMetadata({ orientation: 6 }).jpeg().toBuffer();
  assert.equal(jpegOrientation(new Uint8Array(buf)), 6);
  assert.equal(jpegOrientation(await photo(64, 48)), 1);
});

await test('no target: output untouched, method none', async () => {
  const [r] = await run([{ name: 'a.pdf', bytes: jpegPdf }]);
  assert.equal(r.report.method, 'none');
  assert.equal(r.report.reached, true);
});

await test('already under the limit: nothing is degraded', async () => {
  const [r] = await run([{ name: 'a.pdf', bytes: jpegPdf }], { targetBytes: 50 * MB });
  assert.equal(r.report.method, 'none');
});

const rungs = {};
for (const target of [4 * MB, 2 * MB, 900 * KB]) {
  await test(`JPEG PDF -> ${fmt(target)}: fits, text kept, images recompressed`, async () => {
    const [r] = await run([{ name: 'a.pdf', bytes: jpegPdf }], { targetBytes: target });
    console.log(`     ${fmt(r.report.originalBytes)} -> ${fmt(r.bytes.length)}  ${r.report.rung.dpi}dpi q${r.report.rung.q} (${r.report.rung.label}), ${r.report.recoded} images`);
    assert.ok(r.bytes.length <= target, `${r.bytes.length} > ${target}`);
    assert.equal(r.report.method, 'recompress');
    assert.equal(r.report.reached, true);
    assert.ok(r.report.recoded >= 4);
    assert.ok(pdfText(r.bytes).includes('PDFify searchable text page 3'), 'text must survive');
    assert.equal((await PDFDocument.load(r.bytes)).getPageCount(), 4);
    rungs[target] = RUNGS.indexOf(RUNGS.find((x) => x.dpi === r.report.rung.dpi));
  });
}
await test('tighter targets use harsher settings (and never harsher than needed)', async () => {
  assert.ok(rungs[4 * MB] <= rungs[2 * MB] && rungs[2 * MB] <= rungs[900 * KB]);
  assert.ok(rungs[4 * MB] < rungs[900 * KB]);
});

await test('PNG (Flate + predictor) images inside a PDF are recompressed', async () => {
  const pdf = await makePhotoPdf(3, 'png', false, 1500, 1000);
  console.log(`     fixture ${fmt(pdf.length)}`);
  const [r] = await run([{ name: 'p.pdf', bytes: pdf }], { targetBytes: 900 * KB });
  assert.ok(r.bytes.length <= 900 * KB && r.report.method === 'recompress' && r.report.recoded >= 3);
  assert.ok(pdfText(r.bytes).includes('searchable text page 2'));
});

await test('transparent images: masks are left alone so transparency survives', async () => {
  const pdf = await makePhotoPdf(2, 'png', true, 1500, 1000);
  const [r] = await run([{ name: 'alpha.pdf', bytes: pdf }], { targetBytes: 900 * KB });
  const out = await PDFDocument.load(r.bytes);
  let withMask = 0, maskIsDct = 0;
  for (const [, o] of out.context.enumerateIndirectObjects()) {
    if (!(o instanceof PDFRawStream) || o.dict.lookup(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    const sm = o.dict.lookup(PDFName.of('SMask'));
    if (sm) { withMask++; if (sm.dict.lookup(PDFName.of('Filter'))?.toString() === '/DCTDecode') maskIsDct++; }
  }
  assert.ok(withMask >= 2, 'images keep their SMask');
  assert.equal(maskIsDct, 0, 'masks must not be turned into JPEG');
  assert.ok(r.bytes.length < pdf.length);
});

await test('vector-only PDF over the limit falls back to page rendering', async () => {
  const d = await PDFDocument.create();
  let s = 7; const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let i = 0; i < 5; i++) {
    const p = d.addPage([595, 842]);
    for (let k = 0; k < 30000; k++) p.drawRectangle({ x: rnd() * 580, y: rnd() * 830, width: 2 + rnd() * 6, height: 2 + rnd() * 6, color: rgb(rnd(), rnd(), rnd()) });
    p.drawText('vector text', { x: 50, y: 50 });
  }
  const bytes = new Uint8Array(await d.save());
  console.log(`     fixture ${fmt(bytes.length)}`);
  assert.ok(bytes.length > 900 * KB, 'fixture must exceed the target');
  const [r] = await run([{ name: 'vec.pdf', bytes }], { targetBytes: 900 * KB });
  console.log(`     -> ${fmt(r.bytes.length)} via ${r.report.method}`);
  assert.equal(r.report.method, 'raster');
  assert.equal(r.report.textKept, false);
  assert.ok(r.bytes.length <= 900 * KB);
  assert.equal((await PDFDocument.load(r.bytes)).getPageCount(), 5);
});

await test('impossible target: best effort, honestly reported', async () => {
  const [r] = await run([{ name: 'a.pdf', bytes: jpegPdf }], { targetBytes: 20 * KB });
  console.log(`     asked 20 KB, got ${fmt(r.bytes.length)} via ${r.report.method}`);
  assert.equal(r.report.reached, false);
  assert.ok(r.bytes.length < r.report.originalBytes / 4);
});

await test('photos -> PDF (combined) hit 2 MB and 900 KB, at 6x4 too', async () => {
  const files = [];
  for (let i = 0; i < 3; i++) files.push({ name: `shot${i}.jpg`, bytes: await photo(3000, 2000, i + 10) });
  for (const [size, orientation] of [['a4', 'portrait'], ['6x4', 'landscape']]) {
    for (const target of [2 * MB, 900 * KB]) {
      const [r] = await run(files, { size, orientation, combine: true, targetBytes: target });
      console.log(`     ${size} ${orientation} ${fmt(target)}: ${fmt(r.report.originalBytes)} -> ${fmt(r.bytes.length)} @ ${r.report.rung?.dpi ?? '-'}dpi`);
      assert.ok(r.bytes.length <= target && r.report.reached);
      assert.equal(r.pages, 3);
    }
  }
});

await test('mixed batch: PDF + image + text, combined under 2 MB', async () => {
  const files = [
    { name: 'doc.pdf', bytes: jpegPdf },
    { name: 'pic.jpg', bytes: await photo(2500, 1700, 99) },
    { name: 'notes.txt', bytes: new TextEncoder().encode('hello from the text file\n'.repeat(40)) },
  ];
  const [r] = await run(files, { combine: true, targetBytes: 2 * MB });
  assert.ok(r.bytes.length <= 2 * MB && r.report.reached);
  assert.equal(r.pages, 4 + 1 + 1);
  assert.ok(pdfText(r.bytes).includes('hello from the text file'));
});

await test('per-file mode applies the target to each file separately', async () => {
  const files = [{ name: 'one.pdf', bytes: jpegPdf }, { name: 'two.jpg', bytes: await photo(3000, 2000, 5) }];
  const res = await run(files, { targetBytes: 900 * KB });
  assert.equal(res.length, 2);
  for (const r of res) assert.ok(r.bytes.length <= 900 * KB, `${r.name} ${r.bytes.length}`);
});

console.log(`\n${n} target tests passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
