// The legacy build includes polyfills, so it works on browsers that are a few versions behind.
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url';
import { convertFiles, detectKind, LIMITS, MARGINS, NATIVE_SIZES, PAGE_SIZES, TARGET_PRESETS, UserError } from './convert.js';

const $ = (id) => document.getElementById(id);
const drop = $('drop'), input = $('file'), list = $('files'), go = $('go');
const progress = $('progress'), statusEl = $('status'), results = $('results');
const sizesEl = $('sizes'), targetsEl = $('targets'), customBox = $('customBox'), customMb = $('customMb');

/** @type {{name:string, size?:number, bytes?:Uint8Array, label?:string, error?:string}[]} */
let queue = [];
let selectedSize = 'a4';
let selectedTarget = 'none';
let objectUrls = [];

// Decimal units everywhere (1 MB = 1,000,000 bytes), matching how the targets are enforced.
const fmtSize = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e7 ? 1 : 2)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);

// ---------- page size picker ----------
sizesEl.innerHTML = [...PAGE_SIZES, ...NATIVE_SIZES].map(
  (s) => `<label><input type="radio" name="size" value="${s.id}" ${s.id === selectedSize ? 'checked' : ''}>
    <span>${s.label}</span><small>${s.note}</small></label>`
).join('');
sizesEl.addEventListener('change', (e) => { selectedSize = e.target.value; updatePreview(); });
const isNative = () => NATIVE_SIZES.some((n) => n.id === selectedSize);
document.querySelectorAll('input[name=orientation],input[name=margin]').forEach((el) => el.addEventListener('change', updatePreview));

function opt(name) { return document.querySelector(`input[name=${name}]:checked`).value; }

function updatePreview() {
  const native = NATIVE_SIZES.find((x) => x.id === selectedSize);
  // Relative sizes follow each source, so orientation doesn't apply.
  document.querySelectorAll('input[name=orientation]').forEach((el) => { el.disabled = !!native; });
  $('orientationSet').disabled = !!native;
  $('marginSet').disabled = !!native; // relative sizes are exactly x% of the source, no margins
  $('nativeHint').hidden = !native;
  if (native) {
    const box = $('pagePreview');
    box.style.width = '56px'; box.style.height = '40px';
    box.style.boxShadow = '0 2px 10px #0004';
    $('previewLabel').textContent = `${native.label} (each page follows its source)`;
    return;
  }
  const s = PAGE_SIZES.find((x) => x.id === selectedSize);
  const o = opt('orientation');
  const landscape = o === 'landscape';
  const w = landscape ? s.h : s.w, h = landscape ? s.w : s.h;
  const scale = 70 / Math.max(w, h);
  const box = $('pagePreview');
  box.style.width = `${w * scale}px`;
  box.style.height = `${h * scale}px`;
  const m = (MARGINS[opt('margin')] ?? 0) * Math.min(w, h) * scale;
  box.style.boxShadow = `0 2px 10px #0004, inset 0 0 0 ${m}px #fff, inset 0 0 0 ${m + 1}px #d0d4de`;
  $('previewLabel').textContent = `${s.label} ${o === 'auto' ? '(follows each page)' : o}`;
}
updatePreview();

// ---------- target size picker ----------
const TARGET_OPTIONS = [
  { id: 'none', label: 'No limit', note: 'keep quality' },
  ...TARGET_PRESETS.map((t) => ({ id: t.id, label: t.label, note: 'max file size' })),
  { id: 'custom', label: 'Custom', note: 'your own limit' },
];
targetsEl.innerHTML = TARGET_OPTIONS.map(
  (t) => `<label><input type="radio" name="target" value="${t.id}" ${t.id === selectedTarget ? 'checked' : ''}>
    <span>${t.label}</span><small>${t.note}</small></label>`
).join('');
targetsEl.addEventListener('change', (e) => {
  selectedTarget = e.target.value;
  customBox.hidden = selectedTarget !== 'custom';
  if (!customBox.hidden) customMb.focus();
});

/** Returns bytes, 0 for no limit, or null if the custom value is unusable. */
function targetBytes() {
  if (selectedTarget === 'none') return 0;
  if (selectedTarget === 'custom') {
    const mb = parseFloat(customMb.value);
    if (!Number.isFinite(mb) || mb < 0.02 || mb > 500) return null;
    return Math.round(mb * 1e6);
  }
  return TARGET_PRESETS.find((t) => t.id === selectedTarget).bytes;
}

// ---------- adding files ----------
async function addFiles(fileList) {
  for (const f of fileList) {
    if (queue.length >= LIMITS.maxFiles) break;
    const entry = { name: f.name, size: f.size };
    try {
      if (f.size > LIMITS.maxFileBytes) throw new UserError(`Larger than ${LIMITS.maxFileBytes / 1e6} MB.`);
      entry.bytes = new Uint8Array(await f.arrayBuffer()); // read as data only
      entry.label = detectKind(entry.bytes, f.name).label;
    } catch (e) {
      entry.error = e instanceof UserError ? e.message : 'Could not read this file.';
    }
    queue.push(entry);
  }
  renderQueue();
}

function renderQueue() {
  list.innerHTML = '';
  queue.forEach((f, i) => {
    const li = document.createElement('li');
    if (f.error) li.className = 'bad';
    const name = document.createElement('span'); name.className = 'name'; name.textContent = f.name;
    li.append(name);
    if (f.error) {
      const e = document.createElement('span'); e.className = 'err'; e.textContent = f.error; li.append(e);
    } else {
      const b = document.createElement('span'); b.className = 'badge'; b.textContent = `${f.label} · ${fmtSize(f.size)}`; li.append(b);
    }
    const x = document.createElement('button'); x.className = 'x'; x.textContent = '×'; x.title = 'Remove';
    x.onclick = () => { queue.splice(i, 1); renderQueue(); };
    li.append(x);
    list.append(li);
  });
  go.disabled = !queue.some((f) => !f.error);
}

drop.addEventListener('click', () => input.click());
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
// Copy the list first: input.files is live and is emptied when we reset the input.
input.addEventListener('change', () => { const picked = [...input.files]; input.value = ''; addFiles(picked); });
['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add('over'); }));
['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove('over'); }));
drop.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
// Stop the browser opening a file dropped outside the drop zone.
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

// ---------- canvas helpers ----------
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}
function canvasToBytes(canvas, mime, quality) {
  return new Promise((res, rej) =>
    canvas.toBlob(async (b) => {
      if (!b) return rej(new Error('encode failed'));
      res(new Uint8Array(await b.arrayBuffer()));
    }, mime, quality));
}
const release = (c) => { c.width = c.height = 0; };

// HEIC/HEIF (iPhone photos): decoded by a small WebAssembly build of libheif, downloaded only when needed.
let heifLib = null;
async function loadHeif() {
  const factory = (await import('libheif-js/libheif-wasm/libheif-bundle.mjs')).default;
  const lib = await factory(); // the module's default export is a factory, not the decoder itself
  for (let i = 0; !lib.HeifDecoder && i < 100; i++) await new Promise((r) => setTimeout(r, 50)); // wasm still starting
  if (!lib.HeifDecoder) throw new Error('HEIC decoder failed to start');
  return lib;
}
async function heicToCanvas(bytes) {
  heifLib ??= await loadHeif();
  const images = new heifLib.HeifDecoder().decode(bytes);
  if (!images || !images.length) throw new Error('no image in file');
  const im = images[0];
  const w = im.get_width(), h = im.get_height();
  if (w * h > LIMITS.maxImagePixels) throw new Error('image too large');
  const canvas = makeCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const data = ctx.createImageData(w, h);
  await new Promise((res, rej) => im.display(data, (d) => (d ? res() : rej(new Error('HEIF processing error')))));
  ctx.putImageData(data, 0, 0);
  return canvas;
}

// ---------- hook: decode an uploaded image (the browser decodes pixels; nothing is executed) ----------
async function decodeImage(bytes, info, profile) {
  let source, sw, sh, cleanup;
  if (info.format === 'heic') {
    const c = await heicToCanvas(bytes);
    source = c; sw = c.width; sh = c.height; cleanup = () => release(c);
  } else {
    const bmp = await createImageBitmap(new Blob([bytes], { type: info.mime }), { imageOrientation: 'from-image' });
    source = bmp; sw = bmp.width; sh = bmp.height; cleanup = () => bmp.close();
  }
  try {
    const long = Math.max(sw, sh);
    let cap = LIMITS.maxImageLongSide;
    if (profile) cap = Math.min(cap, profile.maxLongSide ?? Infinity, profile.scale != null ? long * profile.scale : Infinity);
    const k = Math.min(1, cap / long); // never upscale
    const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    const asPng = !profile && ['png', 'gif', 'bmp', 'webp'].includes(info.format);
    if (!asPng) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    const out = await canvasToBytes(canvas, asPng ? 'image/png' : 'image/jpeg', profile ? profile.quality : 0.95);
    release(canvas);
    return { type: asPng ? 'png' : 'jpg', bytes: out, srcWidth: sw, srcHeight: sh };
  } finally {
    cleanup();
  }
}

// ---------- hook: shrink an image that lives inside a PDF ----------
async function recodeImage(job) {
  let source, sw, sh, srcCanvas = null;
  if (job.jpeg) {
    // PDF viewers ignore EXIF rotation, so we must too ('none') or the picture would turn.
    source = await createImageBitmap(new Blob([job.jpeg], { type: 'image/jpeg' }), { imageOrientation: 'none' });
    sw = source.width; sh = source.height;
  } else {
    sw = job.width; sh = job.height;
    const rgba = new Uint8ClampedArray(sw * sh * 4);
    const px = job.pixels;
    if (job.channels === 3) {
      for (let i = 0, j = 0, n = sw * sh; i < n; i++, j += 4) { rgba[j] = px[i * 3]; rgba[j + 1] = px[i * 3 + 1]; rgba[j + 2] = px[i * 3 + 2]; rgba[j + 3] = 255; }
    } else {
      for (let i = 0, j = 0, n = sw * sh; i < n; i++, j += 4) { rgba[j] = rgba[j + 1] = rgba[j + 2] = px[i]; rgba[j + 3] = 255; }
    }
    srcCanvas = makeCanvas(sw, sh);
    srcCanvas.getContext('2d').putImageData(new ImageData(rgba, sw, sh), 0, 0);
    source = srcCanvas;
  }
  try {
    const k = Math.min(1, job.maxLongSide / Math.max(sw, sh));
    const w = Math.max(1, Math.round(sw * k)), h = Math.max(1, Math.round(sh * k));
    const canvas = makeCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(source, 0, 0, w, h);
    const bytes = await canvasToBytes(canvas, 'image/jpeg', job.quality);
    release(canvas);
    return { bytes, width: w, height: h };
  } finally {
    if (source.close) source.close();
    if (srcCanvas) release(srcCanvas);
  }
}

// ---------- hook: turn PDF pages into pictures (last resort), using pdf.js ----------
async function openRaster(bytes) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({
    data: bytes.slice(), // pdf.js takes ownership of the buffer
    cMapUrl: '/pdfjs/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/pdfjs/standard_fonts/',
    wasmUrl: '/pdfjs/wasm/',
    iccUrl: '/pdfjs/iccs/',
    isEvalSupported: false, // no eval, ever
    enableXfa: false,
  }).promise;
  const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
  }
  return {
    numPages: doc.numPages,
    pageSize: (i) => sizes[i],
    render: async (i, widthPx, quality) => {
      const page = await doc.getPage(i + 1);
      const scale = widthPx / sizes[i].w;
      const viewport = page.getViewport({ scale });
      const canvas = makeCanvas(Math.max(1, Math.ceil(viewport.width)), Math.max(1, Math.ceil(viewport.height)));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvas, canvasContext: ctx, viewport }).promise;
      const out = await canvasToBytes(canvas, 'image/jpeg', quality);
      release(canvas);
      page.cleanup();
      return { bytes: out };
    },
    destroy: () => doc.destroy(),
  };
}

// ---------- convert ----------
go.addEventListener('click', async () => {
  const good = queue.filter((f) => !f.error);
  if (!good.length) return;
  const target = targetBytes();
  results.innerHTML = '';
  if (target === null) {
    results.append(messageRow('Enter a custom size between 0.02 and 500 MB.', true));
    return;
  }
  objectUrls.forEach(URL.revokeObjectURL); objectUrls = [];
  go.disabled = true; progress.hidden = false; progress.value = 0; statusEl.hidden = false; statusEl.textContent = 'Starting…';
  try {
    const out = await convertFiles(
      good.map((f) => ({ name: f.name, bytes: f.bytes })),
      { size: selectedSize, orientation: opt('orientation'), margin: opt('margin'), fit: opt('fit'), combine: $('combine').checked, targetBytes: target },
      {
        decodeImage, recodeImage, openRaster,
        onProgress: (i, n) => { progress.value = i / n; },
        onStatus: (t) => { statusEl.textContent = t; },
      }
    );
    for (const r of out) results.append(resultRow(r));
  } catch (e) {
    console.error(e);
    results.append(messageRow(e instanceof UserError ? e.message : 'Something went wrong while converting.', true));
  } finally {
    progress.hidden = true; statusEl.hidden = true; go.disabled = false;
  }
});

function messageRow(text, bad) {
  const li = document.createElement('li');
  if (bad) li.className = 'bad';
  li.textContent = text;
  return li;
}

function describeReport(rep) {
  if (!rep || !rep.targetBytes) return null;
  const limit = fmtSize(rep.targetBytes);
  const q = rep.rung ? `about ${rep.rung.dpi} dpi, ${rep.rung.label} quality` : '';
  if (rep.reached) {
    if (rep.method === 'none') return { ok: true, text: `Already under ${limit}. Nothing was degraded.` };
    if (rep.method === 'recompress') return { ok: true, text: `Under ${limit}: images were recompressed (${q}). Text stays sharp and selectable.` };
    return { ok: true, text: `Under ${limit}: pages were converted to pictures (${q}) because recompressing wasn't enough. Text is no longer selectable.` };
  }
  const how = rep.method === 'raster' ? 'Pages were converted to pictures at very low quality.'
    : rep.method === 'recompress' ? `Images were compressed as far as ${q}.`
    : "This file couldn't be made any smaller.";
  return { ok: false, text: `Couldn't reach ${limit}. ${how} Try a larger limit, fewer pages, or split the file.` };
}

function resultRow(r) {
  const li = document.createElement('li');
  const name = document.createElement('span'); name.className = 'name'; name.textContent = r.error ? r.sourceName : r.name;
  li.append(name);
  if (r.error) {
    li.className = 'bad';
    const e = document.createElement('span'); e.className = 'err'; e.textContent = r.error; li.append(e);
    return li;
  }
  const meta = document.createElement('span'); meta.className = 'meta';
  const shrunk = r.report && r.report.finalBytes < r.report.originalBytes * 0.98 ? `${fmtSize(r.report.originalBytes)} → ` : '';
  meta.textContent = `${r.pages} page${r.pages === 1 ? '' : 's'} · ${shrunk}${fmtSize(r.bytes.length)}`;
  const url = URL.createObjectURL(new Blob([r.bytes], { type: 'application/pdf' }));
  objectUrls.push(url);
  const a = document.createElement('a'); a.className = 'dl'; a.href = url; a.download = r.name; a.textContent = 'Download';
  li.append(meta, a);
  const note = describeReport(r.report);
  if (note) {
    const p = document.createElement('span'); p.className = note.ok ? 'note ok' : 'note warn'; p.textContent = note.text; li.append(p);
  }
  return li;
}
