import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { PDFDocument } from 'pdf-lib';
import { convertFiles, detectKind, PAGE_SIZES, UserError } from '../src/convert.js';

// --- fixtures ---
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const c = Buffer.alloc(4); c.writeUInt32BE(crc(body));
  return Buffer.concat([len, body, c]);
}
function makePng(w, h) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = x * 5 % 256; raw[o + 1] = y * 5 % 256; raw[o + 2] = 120; }
  return new Uint8Array(Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
async function makePdf(sizes) {
  const d = await PDFDocument.create();
  sizes.forEach(([w, h]) => d.addPage([w, h]).drawText('hi', { x: 10, y: 10 }));
  return new Uint8Array(await d.save());
}
const passthroughPng = async (bytes) => ({ type: 'png', bytes });
const base = { size: 'a4', orientation: 'portrait', margin: 'small', fit: 'fit', combine: false };
const near = (a, b, tol = 0.01) => assert.ok(Math.abs(a - b) <= tol, `${a} !~ ${b}`);
const dims = async (bytes) => { const d = await PDFDocument.load(bytes); return d.getPages().map((p) => [p.getWidth(), p.getHeight()]); };

let n = 0;
const test = async (name, fn) => { await fn(); n++; console.log('ok -', name); };

await test('sniffing is by content, not name', async () => {
  assert.equal(detectKind(await makePdf([[100, 100]]), 'evil.exe').kind, 'pdf');
  assert.equal(detectKind(makePng(4, 4), 'x.pdf').kind, 'image');
  assert.equal(detectKind(new TextEncoder().encode('hello'), 'a.txt').kind, 'text');
});

await test('executables and archives are refused, never processed', async () => {
  for (const [head, ] of [[[0x4d, 0x5a, 0x90, 0, 3, 0]], [[0x7f, 0x45, 0x4c, 0x46, 2, 1]], [[0x50, 0x4b, 3, 4, 0, 0]], [[0xd0, 0xcf, 0x11, 0xe0, 0xa1]]]) {
    assert.throws(() => detectKind(new Uint8Array([...head, ...new Array(64).fill(1)]), 'file.pdf'), UserError);
  }
  assert.throws(() => detectKind(new TextEncoder().encode('#!/bin/sh\nrm -rf /'), 'run.sh'), UserError);
  assert.throws(() => detectKind(new Uint8Array([1, 0, 2, 0, 3]), 'bin.txt'), UserError); // NUL byte, not text
  assert.throws(() => detectKind(new Uint8Array(0), 'e.pdf'), UserError);
});

await test('every size/orientation yields exact page dimensions for a PDF', async () => {
  const pdf = await makePdf([[612, 792], [500, 300]]);
  for (const s of PAGE_SIZES) for (const o of ['portrait', 'landscape']) {
    const [r] = await convertFiles([{ name: 'a.pdf', bytes: pdf }], { ...base, size: s.id, orientation: o });
    const pages = await dims(r.bytes);
    assert.equal(pages.length, 2);
    for (const [w, h] of pages) { near(w, o === 'portrait' ? s.w : s.h); near(h, o === 'portrait' ? s.h : s.w); }
  }
});

await test('6x4 is exactly 432x288pt landscape / 288x432 portrait', async () => {
  const pdf = await makePdf([[600, 400]]);
  const [l] = await convertFiles([{ name: 'a.pdf', bytes: pdf }], { ...base, size: '6x4', orientation: 'landscape' });
  const [w, h] = (await dims(l.bytes))[0]; near(w, 432); near(h, 288);
});

await test('auto orientation follows each page', async () => {
  const [r] = await convertFiles([{ name: 'a.pdf', bytes: await makePdf([[300, 500], [500, 300]]) }], { ...base, orientation: 'auto' });
  const [p1, p2] = await dims(r.bytes);
  assert.ok(p1[1] > p1[0]); assert.ok(p2[0] > p2[1]);
});

await test('rotated source pages convert without error', async () => {
  const d = await PDFDocument.create();
  for (const rot of [0, 90, 180, 270]) {
    const p = d.addPage([400, 200]); p.drawText('rot', { x: 20, y: 20 }); p.setRotation({ type: 'degrees', angle: rot });
  }
  const [r] = await convertFiles([{ name: 'r.pdf', bytes: new Uint8Array(await d.save()) }], { ...base, orientation: 'auto' });
  const pages = await dims(r.bytes);
  assert.equal(pages.length, 4);
  // 0/180 are landscape sources, 90/270 are portrait once rotated
  assert.ok(pages[0][0] > pages[0][1]); assert.ok(pages[1][1] > pages[1][0]);
  assert.ok(pages[2][0] > pages[2][1]); assert.ok(pages[3][1] > pages[3][0]);
});

await test('blank PDF pages are kept as blank pages', async () => {
  const d = await PDFDocument.create(); d.addPage([300, 300]); d.addPage([300, 300]).drawText('x', { x: 5, y: 5 });
  const [r] = await convertFiles([{ name: 'blank.pdf', bytes: new Uint8Array(await d.save()) }], base);
  assert.equal((await dims(r.bytes)).length, 2);
});

await test('images become one page at the chosen size', async () => {
  const [r] = await convertFiles([{ name: 'photo.png', bytes: makePng(60, 40) }], { ...base, size: '6x4', orientation: 'landscape', fit: 'fill' }, { decodeImage: passthroughPng });
  assert.equal(r.pages, 1);
  const [w, h] = (await dims(r.bytes))[0]; near(w, 432); near(h, 288);
});

await test('text files paginate', async () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} ` + 'word '.repeat(30)).join('\n');
  const [r] = await convertFiles([{ name: 'notes.txt', bytes: new TextEncoder().encode(text + ' “quotes” — ☃') }], base);
  assert.ok(r.pages > 3);
});

await test('combine merges everything and reports bad files separately', async () => {
  const out = await convertFiles(
    [{ name: 'a.pdf', bytes: await makePdf([[100, 100]]) }, { name: 'b.png', bytes: makePng(10, 10) }, { name: 'bad.exe', bytes: new Uint8Array([0x4d, 0x5a, 0, 0, 0]) }],
    { ...base, combine: true }, { decodeImage: passthroughPng });
  const ok = out.find((r) => r.bytes);
  assert.equal(ok.pages, 2);
  assert.ok(out.find((r) => r.error));
});

await test('corrupt PDF gives a friendly error', async () => {
  const bytes = new TextEncoder().encode('%PDF-1.7\nthis is not really a pdf');
  const [r] = await convertFiles([{ name: 'broken.pdf', bytes }], base);
  assert.ok(r.error && !r.bytes);
});

console.log(`\n${n} test groups passed`);
