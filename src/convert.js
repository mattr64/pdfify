// Core conversion logic. No DOM access here, so it can be tested in Node.
// Nothing in this file ever executes uploaded content: files are sniffed by
// their bytes, then either parsed as data (PDF), decoded as pixels (images)
// or drawn as plain text.

import { PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFArray, PDFDict, PDFRef, StandardFonts, decodePDFRawStream, degrees, rgb } from 'pdf-lib';

// ---------- limits ----------
export const LIMITS = {
  maxFileBytes: 50 * 1024 * 1024, // per file
  maxFiles: 30,
  maxPdfPages: 300,
  maxImagePixels: 150e6,
  maxImageLongSide: 5000, // downscale anything bigger than this before embedding
  maxTextBytes: 2 * 1024 * 1024,
  maxTextPages: 500,
};

// ---------- page sizes ----------
const IN = 72;
const MM = 72 / 25.4;
// Defined as portrait (short side x long side), in PDF points.
export const PAGE_SIZES = [
  { id: '6x4', label: '6 × 4 in', note: 'photo print', w: 4 * IN, h: 6 * IN },
  { id: '7x5', label: '7 × 5 in', note: 'photo print', w: 5 * IN, h: 7 * IN },
  { id: '10x8', label: '10 × 8 in', note: 'photo print', w: 8 * IN, h: 10 * IN },
  { id: 'a6', label: 'A6', note: '105 × 148 mm', w: 105 * MM, h: 148 * MM },
  { id: 'a5', label: 'A5', note: '148 × 210 mm', w: 148 * MM, h: 210 * MM },
  { id: 'a4', label: 'A4', note: '210 × 297 mm', w: 210 * MM, h: 297 * MM },
  { id: 'a3', label: 'A3', note: '297 × 420 mm', w: 297 * MM, h: 420 * MM },
  { id: 'letter', label: 'US Letter', note: '8.5 × 11 in', w: 8.5 * IN, h: 11 * IN },
  { id: 'legal', label: 'US Legal', note: '8.5 × 14 in', w: 8.5 * IN, h: 14 * IN },
];

export const MARGINS = { none: 0, small: 0.03, medium: 0.06 }; // fraction of the short side

export class UserError extends Error {}

// ---------- sniffing ----------
const ascii = (b, start, len) => String.fromCharCode(...b.subarray(start, start + len));
const TEXT_EXTENSIONS = new Set(['txt', 'md', 'csv', 'log']);

export function detectKind(bytes, name = '') {
  if (!bytes || bytes.length === 0) throw new UserError('The file is empty.');
  if (bytes.length > LIMITS.maxFileBytes) {
    throw new UserError(`The file is larger than ${LIMITS.maxFileBytes / 1024 / 1024} MB.`);
  }
  const b = bytes;
  const head = ascii(b, 0, Math.min(b.length, 1024));

  if (head.includes('%PDF-')) return { kind: 'pdf', label: 'PDF' };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { kind: 'image', format: 'jpeg', mime: 'image/jpeg', label: 'JPEG' };
  if (b[0] === 0x89 && ascii(b, 1, 3) === 'PNG') return { kind: 'image', format: 'png', mime: 'image/png', label: 'PNG' };
  if (ascii(b, 0, 4) === 'GIF8') return { kind: 'image', format: 'gif', mime: 'image/gif', label: 'GIF' };
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return { kind: 'image', format: 'webp', mime: 'image/webp', label: 'WebP' };
  if (b[0] === 0x42 && b[1] === 0x4d) return { kind: 'image', format: 'bmp', mime: 'image/bmp', label: 'BMP' };
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand === 'avif' || brand === 'avis') return { kind: 'image', format: 'avif', mime: 'image/avif', label: 'AVIF' };
    throw new UserError('HEIC/video files are not supported. Export the photo as JPEG or PNG first.');
  }

  // Things we recognise and refuse, with a helpful message.
  if (b[0] === 0x4d && b[1] === 0x5a) throw new UserError('This is a program file, not a document. It was not opened.');
  if (b[0] === 0x7f && ascii(b, 1, 3) === 'ELF') throw new UserError('This is a program file, not a document. It was not opened.');
  if (b[0] === 0x50 && b[1] === 0x4b) {
    throw new UserError('Word, Excel, PowerPoint and zip files are not supported. Export it to PDF from the original app first.');
  }
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) {
    throw new UserError('Legacy Office files are not supported. Export it to PDF from the original app first.');
  }

  // Plain text: whitelisted extension AND genuinely text (no NUL bytes, valid UTF-8).
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  if (TEXT_EXTENSIONS.has(ext)) {
    const sample = b.subarray(0, Math.min(b.length, 8192));
    if (!sample.includes(0)) {
      try {
        new TextDecoder('utf-8', { fatal: true }).decode(sample);
        return { kind: 'text', label: 'Text' };
      } catch {
        /* a multi-byte char cut at the sample edge is fine, anything else isn't */
        const tail = sample.subarray(0, sample.length - 3);
        try {
          new TextDecoder('utf-8', { fatal: true }).decode(tail);
          return { kind: 'text', label: 'Text' };
        } catch { /* fall through */ }
      }
    }
  }
  throw new UserError('Unsupported file type. Use a PDF, image (JPEG, PNG, WebP, GIF, BMP, AVIF) or plain text (.txt, .md, .csv, .log).');
}

// Read pixel dimensions from the header without decoding (guards against decompression bombs).
export function peekImageSize(b, format) {
  try {
    if (format === 'png') return { w: ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0, h: ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0 };
    if (format === 'gif') return { w: b[6] | (b[7] << 8), h: b[8] | (b[9] << 8) };
    if (format === 'bmp') {
      const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
      return { w: Math.abs(dv.getInt32(18, true)), h: Math.abs(dv.getInt32(22, true)) };
    }
    if (format === 'webp') {
      const chunk = ascii(b, 12, 4);
      if (chunk === 'VP8 ') return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff };
      if (chunk === 'VP8L') {
        const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
        return { w: (bits & 0x3fff) + 1, h: ((bits >>> 14) & 0x3fff) + 1 };
      }
      if (chunk === 'VP8X') return { w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
    }
    if (format === 'jpeg') {
      let i = 2;
      while (i < b.length - 9) {
        if (b[i] !== 0xff) { i++; continue; }
        const m = b[i + 1];
        if (m === 0xff) { i++; continue; }
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
        if (m === 0xd9) break;
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
          return { h: (b[i + 5] << 8) | b[i + 6], w: (b[i + 7] << 8) | b[i + 8] };
        }
        i += 2 + ((b[i + 2] << 8) | b[i + 3]);
      }
    }
  } catch { /* fall through */ }
  return null;
}

// ---------- layout helpers ----------
function resolvePage(sizeId, orientation, srcIsLandscape) {
  const size = PAGE_SIZES.find((s) => s.id === sizeId);
  if (!size) throw new UserError('Unknown page size.');
  const landscape = orientation === 'landscape' || (orientation === 'auto' && srcIsLandscape);
  return landscape ? { w: size.h, h: size.w } : { w: size.w, h: size.h };
}

function contentArea(page, marginKey) {
  const m = (MARGINS[marginKey] ?? 0) * Math.min(page.w, page.h);
  return { x: m, y: m, w: page.w - 2 * m, h: page.h - 2 * m };
}

// ---------- size targets ----------
// Decimal units on purpose: 900 KB = 900,000 bytes is a little *under* 900 KiB,
// so a file that passes here also passes a limit checked either way.
export const TARGET_PRESETS = [
  { id: '900kb', label: '900 KB', bytes: 900_000 },
  { id: '2mb', label: '2 MB', bytes: 2_000_000 },
  { id: '4mb', label: '4 MB', bytes: 4_000_000 },
];

// From gentlest to harshest, 24 fine steps. `dpi` caps image resolution relative to the output page,
// `q` is the JPEG quality. The search finds the gentlest step that fits the target, so the result
// lands close to the limit instead of far under it.
const RUNG_COUNT = 24;
export const RUNGS = Array.from({ length: RUNG_COUNT }, (_, i) => {
  const t = i / (RUNG_COUNT - 1);
  return {
    dpi: Math.round(300 * Math.pow(50 / 300, t)), // 300 -> 50, geometric
    q: Math.round((0.9 - 0.6 * t) * 100) / 100, // 0.90 -> 0.30
    label: t < 0.15 ? 'excellent' : t < 0.35 ? 'high' : t < 0.55 ? 'good' : t < 0.75 ? 'reduced' : t < 0.9 ? 'low' : 'very low',
  };
});
const MIN_RECODE_BYTES = 12 * 1024; // don't bother with tiny images
const MIN_GAIN = 0.92; // only swap an image if the new one is at least 8% smaller
const MAX_RASTER_PX = 5000;
const MAX_RASTER_AREA = 36e6;
const tick = () => new Promise((r) => setTimeout(r, 0));

function pageLongPt(sizeId) {
  const s = PAGE_SIZES.find((x) => x.id === sizeId);
  return Math.max(s.w, s.h);
}
const rungMaxSide = (opts, rung) => Math.round((pageLongPt(opts.size) / 72) * rung.dpi);

// ---------- JPEG orientation (EXIF) ----------
export function jpegOrientation(b) {
  if (b[0] !== 0xff || b[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 < b.length) {
    if (b[i] !== 0xff) return 1;
    const m = b[i + 1];
    if (m === 0xda || m === 0xd9) return 1;
    const len = (b[i + 2] << 8) | b[i + 3];
    if (m === 0xe1 && ascii(b, i + 4, 6) === 'Exif\0\0') {
      const t = i + 10;
      const le = b[t] === 0x49;
      const u16 = (o) => (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]);
      const u32 = (o) => (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0 : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0);
      const ifd = t + u32(t + 4);
      if (ifd + 2 > b.length) return 1;
      const n = u16(ifd);
      for (let k = 0; k < n; k++) {
        const e = ifd + 2 + k * 12;
        if (e + 12 > b.length) break;
        if (u16(e) === 0x0112) return u16(e + 8) || 1;
      }
      return 1;
    }
    i += 2 + len;
  }
  return 1;
}

// ---------- recompressing images inside a PDF ----------
const N = (s) => PDFName.of(s);
const nameStr = (o) => (o instanceof PDFName ? o.toString() : null);

function imageFilter(dict) {
  const f = dict.lookup(N('Filter'));
  if (f instanceof PDFName) return nameStr(f);
  if (f instanceof PDFArray && f.size() === 1) return nameStr(f.lookup(0));
  return null;
}

// Number of colour channels if this is a plain 8-bit gray/RGB image we can safely re-encode, else 0.
function simpleChannels(dict) {
  if (dict.lookup(N('ImageMask'))?.toString() === 'true') return 0;
  if (dict.has(N('Decode'))) return 0;
  if (dict.lookup(N('Mask')) instanceof PDFArray) return 0; // colour-key mask
  const bpc = dict.lookup(N('BitsPerComponent'));
  if (!(bpc instanceof PDFNumber) || bpc.asNumber() !== 8) return 0;
  const cs = dict.lookup(N('ColorSpace'));
  const simple = { '/DeviceRGB': 3, '/CalRGB': 3, '/DeviceGray': 1, '/CalGray': 1 };
  if (cs instanceof PDFName) return simple[cs.toString()] ?? 0;
  if (cs instanceof PDFArray && cs.size() >= 1) {
    const first = nameStr(cs.lookup(0));
    if (first in simple) return simple[first];
    if (first === '/ICCBased' && cs.size() >= 2) {
      const prof = cs.lookup(1);
      const n = prof?.dict?.lookup(N('N'));
      if (n instanceof PDFNumber && (n.asNumber() === 3 || n.asNumber() === 1)) return n.asNumber();
    }
  }
  return 0;
}

async function recompressPdfImages(src, opts, hooks, rung, stats) {
  if (!hooks.recodeImage) return;
  const ctx = src.context;
  const entries = ctx.enumerateIndirectObjects();
  const isImage = (o) => o instanceof PDFRawStream && nameStr(o.dict.lookup(N('Subtype'))) === '/Image';

  // Soft/hard masks are images too, but touching them would corrupt transparency.
  const maskRefs = new Set();
  for (const [, obj] of entries) {
    if (!isImage(obj)) continue;
    for (const key of ['SMask', 'Mask']) {
      const v = obj.dict.get(N(key));
      if (v instanceof PDFRef) maskRefs.add(v.tag);
    }
  }

  const maxLongSide = rungMaxSide(opts, rung);
  for (const [ref, obj] of entries) {
    if (!isImage(obj) || maskRefs.has(ref.tag)) continue;
    if (obj.contents.length < MIN_RECODE_BYTES) continue;
    const channels = simpleChannels(obj.dict);
    if (!channels) continue;
    const w = obj.dict.lookup(N('Width'))?.asNumber?.();
    const h = obj.dict.lookup(N('Height'))?.asNumber?.();
    if (!w || !h || w * h > LIMITS.maxImagePixels) continue;

    try {
      const filter = imageFilter(obj.dict);
      let job;
      if (filter === '/DCTDecode') {
        job = { jpeg: obj.contents, width: w, height: h, channels };
      } else {
        const pixels = decodePDFRawStream(obj).decode();
        if (pixels.length !== w * h * channels) continue;
        job = { pixels, width: w, height: h, channels };
      }
      const out = await hooks.recodeImage({ ...job, maxLongSide, quality: rung.q });
      if (!out || out.bytes.length >= obj.contents.length * MIN_GAIN) continue;

      const dict = obj.dict.clone(ctx);
      dict.set(N('Width'), PDFNumber.of(out.width));
      dict.set(N('Height'), PDFNumber.of(out.height));
      dict.set(N('ColorSpace'), N('DeviceRGB'));
      dict.set(N('BitsPerComponent'), PDFNumber.of(8));
      dict.set(N('Filter'), N('DCTDecode'));
      dict.delete(N('DecodeParms'));
      ctx.assign(ref, PDFRawStream.of(dict, out.bytes));
      stats.recoded++;
      stats.touched++;
    } catch {
      /* leave this image alone */
    }
  }
}

// ---------- PDF ----------
async function loadPdf(bytes) {
  let src;
  try {
    src = await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (e && /encrypt/i.test(e.name + e.message)) {
      throw new UserError('This PDF is password-protected. Remove the password first, then try again.');
    }
    throw new UserError('This PDF could not be read. It may be damaged.');
  }
  const count = src.getPageCount();
  if (count === 0) throw new UserError('This PDF has no pages.');
  if (count > LIMITS.maxPdfPages) throw new UserError(`This PDF has more than ${LIMITS.maxPdfPages} pages.`);
  return src;
}

async function appendPdf(out, file, opts, hooks, mode) {
  const src = await loadPdf(file.bytes);
  if (mode.tier === 'recompress') await recompressPdfImages(src, opts, hooks, mode.rung, mode.stats);
  const pages = src.getPages();

  // Use the visible area (CropBox if present, else MediaBox).
  const boxes = pages.map((p) => {
    const c = p.getCropBox();
    return { left: c.x, bottom: c.y, right: c.x + c.width, top: c.y + c.height };
  });
  // Embed one page at a time: blank pages have no content stream and pdf-lib
  // refuses to embed them, so those come through as blank pages instead.
  const embedded = [];
  for (let i = 0; i < pages.length; i++) {
    if (!pages[i].node.Contents()) { embedded.push(null); continue; }
    embedded.push((await out.embedPages([pages[i]], [boxes[i]]))[0]);
  }

  pages.forEach((p, i) => {
    const emb = embedded[i];
    const rot = (((p.getRotation().angle % 360) + 360) % 360);
    const quarter = rot === 90 || rot === 270;
    const box = boxes[i];
    const bw = box.right - box.left, bh = box.top - box.bottom;
    const vw = quarter ? bh : bw;
    const vh = quarter ? bw : bh;
    const size = resolvePage(opts.size, opts.orientation, vw > vh);
    const page = out.addPage([size.w, size.h]);
    if (!emb) return;
    const area = contentArea(size, opts.margin);
    const s = Math.min(area.w / vw, area.h / vh);
    const cx = area.x + (area.w - vw * s) / 2;
    const cy = area.y + (area.h - vh * s) / 2;
    let x = cx, y = cy;
    if (rot === 90) y = cy + emb.width * s;
    if (rot === 180) { x = cx + emb.width * s; y = cy + emb.height * s; }
    if (rot === 270) x = cx + emb.height * s;
    // rotate: PDF /Rotate is clockwise, pdf-lib's rotate is counter-clockwise
    page.drawPage(emb, { x, y, xScale: s, yScale: s, rotate: degrees(-rot) });
  });
  return pages.length;
}

// Last resort: draw each page to a picture and place that. Smallest files, but text is no longer selectable.
async function appendPdfRaster(out, file, opts, hooks, mode) {
  if (!hooks.openRaster) throw new UserError('Page rendering is not available here.');
  let handle = mode.raster.get(file);
  if (!handle) {
    await loadPdf(file.bytes); // same validation (encrypted / broken / page limits) as the normal path
    handle = await hooks.openRaster(file.bytes);
    mode.raster.set(file, handle);
  }
  for (let i = 0; i < handle.numPages; i++) {
    const { w: pw, h: ph } = handle.pageSize(i);
    const size = resolvePage(opts.size, opts.orientation, pw > ph);
    const page = out.addPage([size.w, size.h]);
    const area = contentArea(size, opts.margin);
    const s = Math.min(area.w / pw, area.h / ph);
    const placedW = pw * s, placedH = ph * s;
    let widthPx = Math.round((placedW / 72) * mode.rung.dpi);
    widthPx = Math.max(64, Math.min(MAX_RASTER_PX, widthPx));
    const heightPx = widthPx * (ph / pw);
    if (widthPx * heightPx > MAX_RASTER_AREA) widthPx = Math.floor(Math.sqrt(MAX_RASTER_AREA * (pw / ph)));
    const jpg = await handle.render(i, widthPx, mode.rung.q);
    const img = await out.embedJpg(jpg.bytes);
    page.drawImage(img, { x: area.x + (area.w - placedW) / 2, y: area.y + (area.h - placedH) / 2, width: placedW, height: placedH });
    mode.stats.touched++;
    mode.stats.rasterPages++;
    if (i % 4 === 3) await tick();
  }
  return handle.numPages;
}

// ---------- images ----------
async function appendImage(out, file, info, opts, hooks, mode) {
  const bytes = file.bytes;
  const peek = peekImageSize(bytes, info.format);
  if (peek && (peek.w < 1 || peek.h < 1 || peek.w * peek.h > LIMITS.maxImagePixels)) {
    throw new UserError(`This image is too large to process (over ${Math.round(LIMITS.maxImagePixels / 1e6)} megapixels).`);
  }
  const profile = mode.tier === 'original' ? null : { maxLongSide: rungMaxSide(opts, mode.rung), quality: mode.rung.q, jpeg: true };

  let img;
  // Untouched JPEGs go straight in: lossless, instant, and never bigger than the original.
  if (!profile && info.format === 'jpeg' && jpegOrientation(bytes) === 1 && peek && Math.max(peek.w, peek.h) <= LIMITS.maxImageLongSide) {
    try { img = await out.embedJpg(bytes); } catch { img = null; }
  }
  if (!img) {
    if (!hooks.decodeImage) throw new UserError('Image decoding is not available here.');
    let decoded;
    try {
      decoded = await hooks.decodeImage(bytes, info, profile);
    } catch {
      throw new UserError('This image could not be decoded. It may be damaged or in an unsupported variant.');
    }
    img = decoded.type === 'jpg' ? await out.embedJpg(decoded.bytes) : await out.embedPng(decoded.bytes);
    if (profile) mode.stats.touched++;
  }
  const size = resolvePage(opts.size, opts.orientation, img.width > img.height);
  const page = out.addPage([size.w, size.h]);

  if (opts.fit === 'fill') {
    // Cover the whole page; overflow falls outside the page and is cropped.
    const s = Math.max(size.w / img.width, size.h / img.height);
    const w = img.width * s, h = img.height * s;
    page.drawImage(img, { x: (size.w - w) / 2, y: (size.h - h) / 2, width: w, height: h });
  } else {
    const area = contentArea(size, opts.margin);
    const s = Math.min(area.w / img.width, area.h / img.height);
    const w = img.width * s, h = img.height * s;
    page.drawImage(img, { x: area.x + (area.w - w) / 2, y: area.y + (area.h - h) / 2, width: w, height: h });
  }
  return 1;
}

// ---------- text ----------
const CHAR_MAP = { '‘': "'", '’': "'", '“': '"', '”': '"', '–': '-', '—': '-', '…': '...', '•': '*', ' ': ' ' };
function toWinAnsiSafe(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if (CHAR_MAP[ch]) out += CHAR_MAP[ch];
    else if (ch === '\t') out += '    ';
    else if ((c >= 0x20 && c <= 0x7e) || (c >= 0xa1 && c <= 0xff)) out += ch;
    else out += '?';
  }
  return out;
}

function wrapLine(line, cols) {
  if (line.length <= cols) return [line];
  const rows = [];
  let rest = line;
  while (rest.length > cols) {
    let cut = rest.lastIndexOf(' ', cols);
    if (cut <= 0) cut = cols;
    rows.push(rest.slice(0, cut).replace(/\s+$/, ''));
    rest = rest.slice(cut).replace(/^ /, '');
  }
  rows.push(rest);
  return rows;
}

async function appendText(out, bytes, opts) {
  if (bytes.length > LIMITS.maxTextBytes) {
    throw new UserError(`Text files are limited to ${LIMITS.maxTextBytes / 1024 / 1024} MB.`);
  }
  const text = new TextDecoder('utf-8').decode(bytes).replace(/\r\n?/g, '\n');
  const font = await out.embedFont(StandardFonts.Courier);
  const size = resolvePage(opts.size, opts.orientation === 'landscape' ? 'landscape' : 'portrait', false);
  const textMargin = Math.max(MARGINS[opts.margin] ?? 0, 0.06);
  const m = textMargin * Math.min(size.w, size.h);
  const fs = Math.max(7, Math.min(11, Math.min(size.w, size.h) / 55));
  const lh = fs * 1.3;
  const cols = Math.max(10, Math.floor((size.w - 2 * m) / (fs * 0.6)));
  const rowsPerPage = Math.max(1, Math.floor((size.h - 2 * m) / lh));

  const rows = toWinAnsiSafe(text).split('\n').flatMap((l) => wrapLine(l, cols));
  let count = 0;
  for (let i = 0; i < Math.max(rows.length, 1); i += rowsPerPage) {
    if (++count > LIMITS.maxTextPages) throw new UserError(`That text would run to more than ${LIMITS.maxTextPages} pages.`);
    const page = out.addPage([size.w, size.h]);
    rows.slice(i, i + rowsPerPage).forEach((row, j) => {
      if (row) page.drawText(row, { x: m, y: size.h - m - fs - j * lh, size: fs, font, color: rgb(0.1, 0.1, 0.1) });
    });
  }
  return count;
}

// ---------- building ----------
function newDoc() {
  return PDFDocument.create({ updateMetadata: false }).then((d) => {
    d.setProducer('PDFify');
    d.setCreator('PDFify');
    return d;
  });
}

function safeBase(name) {
  const base = name.replace(/\.[^.]*$/, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').slice(0, 60);
  return base || 'document';
}

function friendlyError(e) {
  if (e instanceof UserError) return e.message;
  console.error(e);
  return 'This file could not be processed. It may be damaged.';
}

async function appendAny(doc, file, opts, hooks, mode) {
  const info = detectKind(file.bytes, file.name);
  if (info.kind === 'pdf') return mode.tier === 'raster' ? appendPdfRaster(doc, file, opts, hooks, mode) : appendPdf(doc, file, opts, hooks, mode);
  if (info.kind === 'image') return appendImage(doc, file, info, opts, hooks, mode);
  return appendText(doc, file.bytes, opts);
}

async function buildGroup(files, opts, hooks, mode) {
  const doc = await newDoc();
  let pages = 0;
  const failed = [];
  for (const file of files) {
    try {
      pages += await appendAny(doc, file, opts, hooks, mode);
    } catch (e) {
      if (mode.tier === 'raster') throw e; // let the caller abandon this tier
      failed.push({ sourceName: file.name, error: friendlyError(e) });
    }
  }
  const bytes = pages > 0 ? await doc.save() : null;
  return { bytes, pages, failed, touched: mode.stats.touched, recoded: mode.stats.recoded, rasterPages: mode.stats.rasterPages };
}

const freshMode = (tier, rung = null, raster = null) => ({ tier, rung, raster: raster ?? new Map(), stats: { touched: 0, recoded: 0, rasterPages: 0 } });

// Find the gentlest rung whose output fits. Sizes shrink as rungs get harsher, so binary search works.
async function searchRungs(tier, files, opts, hooks, target, raster) {
  let lo = 0, hi = RUNGS.length - 1;
  let found = null, smallest = null, nothingToDo = false;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const rung = RUNGS[mid];
    hooks.onStatus?.(tier === 'raster' ? `Rendering pages at ${rung.dpi} dpi…` : `Recompressing images at ~${rung.dpi} dpi…`);
    await tick();
    const r = await buildGroup(files, opts, hooks, freshMode(tier, rung, raster));
    if (r.touched === 0) { nothingToDo = true; break; }
    const cand = { ...r, rungIndex: mid, rung };
    if (!smallest || r.bytes.length < smallest.bytes.length) smallest = cand;
    if (r.bytes.length <= target) { found = cand; hi = mid - 1; } else { lo = mid + 1; }
  }
  return { found, smallest, nothingToDo };
}

async function fitGroup(files, opts, hooks) {
  const target = opts.targetBytes || 0;
  hooks.onStatus?.('Converting…');
  await tick();
  const base = await buildGroup(files, opts, hooks, freshMode('original'));
  if (!base.bytes) return { failed: base.failed };

  const report = { originalBytes: base.bytes.length, targetBytes: target, method: 'none', reached: true, textKept: true };
  const done = (r, extra) => ({ bytes: r.bytes, pages: r.pages, failed: base.failed, report: { ...report, finalBytes: r.bytes.length, ...extra } });
  if (!target || base.bytes.length <= target) return done(base, {});

  const hasPdf = files.some((f) => { try { return detectKind(f.bytes, f.name).kind === 'pdf'; } catch { return false; } });
  const raster = new Map();
  let best = base, bestInfo = { method: 'none', reached: false };
  try {
    // Tier 2: keep text and vectors, shrink the images.
    const t2 = await searchRungs('recompress', files, opts, hooks, target, raster);
    if (t2.found) return done(t2.found, { method: 'recompress', rung: t2.found.rung, recoded: t2.found.recoded });
    if (t2.smallest && t2.smallest.bytes.length < best.bytes.length) {
      best = t2.smallest;
      bestInfo = { method: 'recompress', rung: t2.smallest.rung, recoded: t2.smallest.recoded, reached: false };
    }

    // Tier 3: turn PDF pages into pictures. Smallest, but text is no longer selectable.
    if (hasPdf && hooks.openRaster) {
      try {
        const t3 = await searchRungs('raster', files, opts, hooks, target, raster);
        if (t3.found) return done(t3.found, { method: 'raster', rung: t3.found.rung, textKept: false });
        if (t3.smallest && t3.smallest.bytes.length < best.bytes.length) {
          best = t3.smallest;
          bestInfo = { method: 'raster', rung: t3.smallest.rung, textKept: false, reached: false };
        }
      } catch (e) {
        console.warn('Page rendering failed', e);
      }
    }
  } finally {
    for (const h of raster.values()) { try { h.destroy?.(); } catch { /* ignore */ } }
  }
  return done(best, { ...bestInfo, reached: false });
}

/**
 * files: [{ name, bytes: Uint8Array }]
 * opts:  { size, orientation: 'portrait'|'landscape'|'auto', margin: 'none'|'small'|'medium', fit: 'fit'|'fill',
 *          combine: boolean, targetBytes?: number }
 * hooks: { decodeImage(bytes, info, profile|null) -> { type: 'jpg'|'png', bytes },
 *          recodeImage({ jpeg|pixels, width, height, channels, maxLongSide, quality }) -> { bytes, width, height } | null,
 *          openRaster(pdfBytes) -> { numPages, pageSize(i) -> {w,h}, render(i, widthPx, quality) -> { bytes }, destroy() },
 *          onProgress(i, total), onStatus(text) }
 * Returns [{ sourceName, name, bytes, pages, report }]; failed files carry `error` instead of bytes.
 */
export async function convertFiles(files, opts, hooks = {}) {
  if (files.length > LIMITS.maxFiles) throw new UserError(`Please convert at most ${LIMITS.maxFiles} files at a time.`);
  const tag = `${opts.size.toUpperCase()}${opts.orientation === 'auto' ? '' : '-' + opts.orientation}`;
  const combine = opts.combine && files.length > 1;
  const groups = combine
    ? [{ sourceName: `${files.length} files`, name: `combined-${tag}.pdf`, files }]
    : files.map((f) => ({ sourceName: f.name, name: `${safeBase(f.name)}-${tag}.pdf`, files: [f] }));

  const ok = [], bad = [];
  for (let i = 0; i < groups.length; i++) {
    hooks.onProgress?.(i, groups.length);
    const g = groups[i];
    try {
      const r = await fitGroup(g.files, opts, hooks);
      if (r.bytes) ok.push({ sourceName: g.sourceName, name: g.name, bytes: r.bytes, pages: r.pages, report: r.report });
      bad.push(...(r.failed ?? []));
    } catch (e) {
      bad.push({ sourceName: g.sourceName, error: friendlyError(e) });
    }
  }
  hooks.onProgress?.(groups.length, groups.length);
  hooks.onStatus?.('');
  return [...ok, ...bad];
}
