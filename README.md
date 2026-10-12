# PDFify

Resize a PDF to a chosen page size, or turn an image / text file into a PDF at that size. Runs 100% in the browser, so files are never uploaded.

## Features
- Sizes: 6×4, 7×5, 10×8, A6, A5, A4, A3, US Letter, US Legal. Portrait, landscape or auto (per page).
- **Relative sizes:** *Original size*, *75%* and *50%*. PDFs keep each page's own size (× the factor); images use their real physical size (pixels ÷ the DPI stored in the file, or 72 DPI if there is none); text files use A4. Margins and orientation don't apply to these.
- Inputs: PDF, JPEG, PNG, **HEIC/HEIF** (iPhone photos), WebP, GIF, BMP, AVIF, plain text (.txt .md .csv .log). HEIC is decoded by a WebAssembly build of libheif (LGPL-3.0) that is only downloaded when a HEIC file is added.
- Options: margin, fit or fill (images), combine many files into one PDF.
- **Maximum file size:** 900 KB, 2 MB, 4 MB or a custom limit (decimal units, so 900 KB = 900,000 bytes). If the result is over the limit it is shrunk in this order, stopping at the first step that fits:
  1. Rebuild only (lossless).
  2. Recompress the images, including those inside PDFs, at the *gentlest* of 24 quality steps that fits. Text and vectors are untouched and stay selectable.
  3. Last resort, PDFs only: render pages to pictures (text is no longer selectable).
  If the limit can't be met, you get the closest result and are told so, never a silent miss.
- Not supported: Word/Excel/PowerPoint (export to PDF first), password-protected PDFs.

## Why it's safe
- Files are identified by their **bytes**, never their name or MIME type. A `.exe` renamed `.pdf` is rejected.
- Uploaded content is only ever parsed as data (PDF structure), decoded as pixels (images) or drawn as text. Nothing is executed, and PDF JavaScript is never carried over (pages are re-drawn, not copied).
- Size, page-count and megapixel limits stop decompression-bomb style files.
- No server is involved, so there is nothing to attack and nothing stored.
- `vercel.json` adds a strict Content-Security-Policy (no inline or third-party scripts) and other hardening headers.

## Run locally
```
npm install
npm run dev      # http://localhost:5173
npm test         # conversion + size-target tests (needs poppler's pdftoppm/pdftotext)
```

## Deploy to Vercel
1. Put this folder in a GitHub repo.
2. In Vercel: **Add New → Project**, import the repo. Framework preset is detected as Vite; no settings needed.
3. Deploy.

Or from a terminal: `npx vercel --prod`.
