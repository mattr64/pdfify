// Node stand-ins for the browser pieces: sharp encodes JPEGs, pdftoppm renders pages.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import sharp from 'sharp';
import { PDFDocument } from 'pdf-lib';

const require = createRequire(import.meta.url);
async function heicToRgba(bytes) {
  const libheif = require('libheif-js/wasm-bundle');
  const im = new libheif.HeifDecoder().decode(bytes)[0];
  const w = im.get_width(), h = im.get_height();
  const d = await new Promise((res, rej) => im.display({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }, (x) => (x ? res(x) : rej(new Error('heic decode failed')))));
  return { data: Buffer.from(d.data.buffer), width: w, height: h };
}

export const decodeImage = async (bytes, info, profile) => {
  let img, srcWidth, srcHeight;
  if (info.format === 'heic') {
    const { data, width, height } = await heicToRgba(bytes);
    img = sharp(data, { raw: { width, height, channels: 4 } });
    srcWidth = width; srcHeight = height;
  } else {
    const m = await sharp(bytes, { failOn: 'none' }).metadata();
    const swap = (m.orientation ?? 1) >= 5;
    srcWidth = swap ? m.height : m.width; srcHeight = swap ? m.width : m.height;
    img = sharp(bytes, { failOn: 'none' }).rotate();
  }
  if (!profile) {
    const asPng = ['png', 'gif', 'bmp', 'webp'].includes(info.format);
    return asPng
      ? { type: 'png', bytes: new Uint8Array(await img.png().toBuffer()), srcWidth, srcHeight }
      : { type: 'jpg', bytes: new Uint8Array(await img.flatten({ background: '#fff' }).jpeg({ quality: 95 }).toBuffer()), srcWidth, srcHeight };
  }
  const long = Math.max(srcWidth, srcHeight);
  const cap = Math.max(1, Math.min(profile.maxLongSide ?? Infinity, profile.scale != null ? long * profile.scale : Infinity));
  img = img.resize({ width: Math.round(cap), height: Math.round(cap), fit: 'inside', withoutEnlargement: true });
  return { type: 'jpg', bytes: new Uint8Array(await img.flatten({ background: '#fff' }).jpeg({ quality: Math.round(profile.quality * 100) }).toBuffer()), srcWidth, srcHeight };
};

export const recodeImage = async (job) => {
  const input = job.jpeg ? Buffer.from(job.jpeg) : Buffer.from(job.pixels);
  let img = sharp(input, job.jpeg ? {} : { raw: { width: job.width, height: job.height, channels: job.channels } });
  img = img.resize({ width: job.maxLongSide, height: job.maxLongSide, fit: 'inside', withoutEnlargement: true }).toColourspace('srgb').flatten({ background: '#fff' });
  const { data, info } = await img.jpeg({ quality: Math.round(job.quality * 100) }).toBuffer({ resolveWithObject: true });
  return { bytes: new Uint8Array(data), width: info.width, height: info.height };
};

export const openRaster = async (pdfBytes) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfify-'));
  const file = path.join(dir, 'in.pdf');
  fs.writeFileSync(file, pdfBytes);
  const doc = await PDFDocument.load(pdfBytes);
  const sizes = doc.getPages().map((p) => {
    const r = (((p.getRotation().angle % 360) + 360) % 360);
    return r === 90 || r === 270 ? { w: p.getHeight(), h: p.getWidth() } : { w: p.getWidth(), h: p.getHeight() };
  });
  return {
    numPages: sizes.length,
    pageSize: (i) => sizes[i],
    render: async (i, widthPx, quality) => {
      const out = path.join(dir, `p${i}`);
      const r = spawnSync('pdftoppm', ['-jpeg', '-jpegopt', `quality=${Math.round(quality * 100)}`, '-f', String(i + 1), '-l', String(i + 1), '-scale-to-x', String(widthPx), '-scale-to-y', '-1', '-singlefile', file, out]);
      if (r.status !== 0) throw new Error('pdftoppm failed');
      return { bytes: new Uint8Array(fs.readFileSync(out + '.jpg')) };
    },
    destroy: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
};

export const hooks = (extra = {}) => ({ decodeImage, recodeImage, openRaster, ...extra });

// ---- fixtures ----
// Noisy gradients behave like real photos: they compress badly, so they make big files.
export async function photo(w, h, seed = 1, fmt = 'jpeg', alpha = false) {
  const ch = alpha ? 4 : 3;
  const raw = Buffer.alloc(w * h * ch);
  let s = seed * 2654435761 >>> 0;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * ch;
    const n = (rnd() - 0.5) * 60;
    raw[o] = Math.max(0, Math.min(255, 128 + 100 * Math.sin(x / 90 + seed) + n));
    raw[o + 1] = Math.max(0, Math.min(255, 128 + 100 * Math.sin(y / 70) + n));
    raw[o + 2] = Math.max(0, Math.min(255, (x * 255) / w + n));
    if (alpha) raw[o + 3] = x < w / 2 ? 255 : 120;
  }
  const img = sharp(raw, { raw: { width: w, height: h, channels: ch } });
  return new Uint8Array(await (fmt === 'png' ? img.png() : img.jpeg({ quality: 92 })).toBuffer());
}

export const pdfText = (bytes) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfify-'));
  const f = path.join(dir, 'x.pdf');
  fs.writeFileSync(f, bytes);
  const r = spawnSync('pdftotext', [f, '-']);
  fs.rmSync(dir, { recursive: true, force: true });
  return r.stdout.toString();
};
