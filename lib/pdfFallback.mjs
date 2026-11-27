import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

let pdfjsLibPromise = null;

async function getPdfJs() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import('pdfjs-dist/legacy/build/pdf.mjs').then((mod) => {
      // Silence harmless standard font warnings in Node
      if (mod?.GlobalWorkerOptions) {
        try {
          const workerUrl = new URL('../node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs', import.meta.url).href;
          mod.GlobalWorkerOptions.workerSrc = workerUrl;
        } catch {}
      }
      return mod;
    });
  }
  return pdfjsLibPromise;
}

async function openPdfDocument(fullPath) {
  const pdfjs = await getPdfJs();
  const buf = await fs.readFile(fullPath);
  const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const loadingTask = pdfjs.getDocument({
    data,
    useSystemFonts: true,
    disableFontFace: true,
    isEvalSupported: false,
    verbosity: 0,
  });
  const doc = await loadingTask.promise;
  const close = async () => {
    try {
      if (typeof doc?.destroy === 'function') await doc.destroy();
    } catch {}
    try {
      if (typeof loadingTask?.destroy === 'function') await loadingTask.destroy();
    } catch {}
  };
  return { doc, close };
}

function normalizeMatchText(str) {
  return String(str || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9=+−\-/().·×αβγδεθλμπωσΔΣ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function getPdfPageCountJs(fullPath) {
  const { doc, close } = await openPdfDocument(fullPath);
  try {
    return Math.max(1, Number(doc.numPages) || 1);
  } finally {
    await close();
  }
}

export async function extractAllPdfPagesJs(fullPath) {
  const { doc, close } = await openPdfDocument(fullPath);
  try {
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const tc = await page.getTextContent();
      let lastY = null;
      let out = '';
      for (const item of tc.items || []) {
        if (!('str' in item)) continue;
        const y = Array.isArray(item.transform) ? item.transform[5] : null;
        if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) {
          out += '\n';
        } else if (out && !out.endsWith(' ') && !out.endsWith('\n')) {
          out += ' ';
        }
        out += item.str;
        lastY = y;
      }
      pages.push(out.trim());
    }
    return pages.length ? pages : ['(PDF had no extractable text; may be scanned images)'];
  } finally {
    await close();
  }
}

/**
 * Pure-JS fallback for Poppler `pdftotext -bbox-layout`:
 * Returns normalized 0..1000 viewBox layout lines & word boxes + page text with zero external binaries.
 */
export async function extractPdfPageLayoutJs(fullPath, pageNumber) {
  const { doc, close } = await openPdfDocument(fullPath);
  try {
    const safePage = Math.max(1, Math.min(doc.numPages || 1, Number(pageNumber) || 1));
    const page = await doc.getPage(safePage);
    const vp = page.getViewport({ scale: 1 });
    const rawW = vp.width || 960;
    const rawH = vp.height || 540;
    const vbW = 1000;
    const vbH = Math.round((rawH / rawW) * 1000);
    const scaleX = vbW / rawW;
    const scaleY = vbH / rawH;

    const tc = await page.getTextContent();
    const rawWords = [];
    for (const item of tc.items || []) {
      const text = String(item?.str || '').trim();
      if (!text || !Array.isArray(item.transform)) continue;
      const tx = item.transform[4] || 0;
      const ty = item.transform[5] || 0;
      const fontH = Math.max(8, Math.hypot(item.transform[2] || 0, item.transform[3] || 0) || item.height || 12);
      const width = Math.max(6, Number(item.width) || text.length * fontH * 0.5);
      const x = Math.max(0, Math.round(tx * scaleX));
      const y = Math.max(0, Math.round((rawH - ty - fontH) * scaleY));
      const w = Math.max(4, Math.round(width * scaleX));
      const h = Math.max(8, Math.round(fontH * scaleY));
      rawWords.push({ text, norm: normalizeMatchText(text), x, y, w, h });
    }

    // Group words into horizontal lines by Y proximity
    rawWords.sort((a, b) => a.y - b.y || a.x - b.x);
    const lines = [];
    for (const wd of rawWords) {
      let line = lines.find((l) => Math.abs(l.yMin - wd.y) <= Math.max(10, wd.h * 0.65));
      if (!line) {
        line = { xMin: wd.x, yMin: wd.y, xMax: wd.x + wd.w, yMax: wd.y + wd.h, words: [] };
        lines.push(line);
      }
      line.words.push(wd);
      line.xMin = Math.min(line.xMin, wd.x);
      line.yMin = Math.min(line.yMin, wd.y);
      line.xMax = Math.max(line.xMax, wd.x + wd.w);
      line.yMax = Math.max(line.yMax, wd.y + wd.h);
    }

    const finalLines = lines.map((l) => {
      l.words.sort((a, b) => a.x - b.x);
      const text = l.words.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
      return {
        text,
        norm: normalizeMatchText(text),
        x: l.xMin,
        y: l.yMin,
        w: Math.max(10, l.xMax - l.xMin),
        h: Math.max(10, l.yMax - l.yMin),
        words: l.words,
      };
    });

    const pageText = finalLines.map((l) => l.text).join('\n').trim();
    return {
      vbW,
      vbH,
      lines: finalLines,
      text: pageText,
      totalPages: doc.numPages || 1,
    };
  } finally {
    await close();
  }
}
