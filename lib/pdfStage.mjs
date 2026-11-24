import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const BIN_CANDIDATES = {
  pdftoppm: ['/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm', 'pdftoppm'],
  pdftotext: ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', 'pdftotext'],
  pdfinfo: ['/opt/homebrew/bin/pdfinfo', '/usr/local/bin/pdfinfo', 'pdfinfo'],
};

async function runPoppler(tool, args, opts = {}) {
  const candidates = BIN_CANDIDATES[tool] || [tool];
  let lastErr = null;
  for (const bin of candidates) {
    try {
      return await execFileAsync(bin, args, {
        maxBuffer: 25 * 1024 * 1024,
        timeout: 25000,
        ...opts,
      });
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`${tool} failed: ${lastErr?.message || 'binary not found'}`);
}

function decodeXmlEntities(str) {
  return String(str || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)));
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

export function detectProblemOrExample(pageText) {
  const raw = String(pageText || '');
  const low = raw
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');

  // Strip casual prose idioms ("por ejemplo", "for example") so normal conceptual slides don't falsely trigger a 2nd LLM pass!
  const lowNoCasual = low.replace(/\b(por ejemplo|for example|a modo de ejemplo)\b/g, ' ');

  const cues = [];
  if (/(?:^|\n)\s*(?:ejemplo|example|ejercicio|exercise|problema|problem|caso practico|aplicacion practica)\b/.test(lowNoCasual) ||
      /\b(ejemplo|example|ejercicio|exercise|problema|problem)\s*(?:n[°º.]?\s*)?\d+/.test(lowNoCasual)) {
    cues.push('explicit_example_heading');
  } else if (/\b(ejercicio|exercise|problema|problem|caso practico|aplicacion practica)\b/.test(lowNoCasual)) {
    cues.push('example_keyword');
  }
  if (/\b(calcular|calcula|calcule|determinar|determina|hallar|obtener|resuelve|resolver|demostrar|deducir)\b/.test(lowNoCasual)) {
    cues.push('calculation_prompt');
  }
  if (/\b(datos|solucion|solution|enunciado|supongamos|dado un)\b/.test(lowNoCasual)) {
    cues.push('problem_data');
  }
  // Numeric values with engineering units (e.g. "1200 kg", "2.65 m", "9.81 m/s", "500 mm")
  const unitHits = raw.match(/\b\d+(?:[.,]\d+)?\s*(?:kg|mm|cm|m\/s|km\/h|rad|deg|°|N|Nm|N·m|kN|MPa|Hz|rpm|bar|g)\b/gi) || [];
  if (unitHits.length >= 2) {
    cues.push('numeric_engineering_values');
  }
  // Equations with '='
  const eqHits = raw.match(/[A-Za-zα-ωΔΣ][^=\n]{0,24}=\s*[^\n]{2,40}/g) || [];
  if (eqHits.length >= 2) {
    cues.push('multiple_equations');
  }

  const hasMathEvidence =
    cues.includes('numeric_engineering_values') ||
    cues.includes('calculation_prompt') ||
    cues.includes('problem_data');

  const hasExampleProblem =
    cues.includes('explicit_example_heading') ||
    (cues.includes('example_keyword') && hasMathEvidence) ||
    (cues.includes('calculation_prompt') && cues.includes('numeric_engineering_values')) ||
    (cues.includes('problem_data') && cues.includes('numeric_engineering_values'));

  return {
    hasExampleProblem,
    hasEquations: eqHits.length > 0,
    cues,
  };
}

export class PdfStageService {
  constructor({ library, cacheDir }) {
    this.library = library;
    this.cacheDir = path.join(cacheDir, 'pdf-stage');
    this.layoutCache = new Map(); // key: `${doc.id}:${page}` -> layout
    this.textCache = new Map(); // key: `${doc.id}:${page}` -> { page, totalPages, text }
    this.pageCountCache = new Map(); // key: doc.id -> number
    this.inFlightPrefetch = new Set();
  }

  async init() {
    await fs.mkdir(this.cacheDir, { recursive: true });
  }

  setLibrary(library, cacheDir) {
    this.library = library;
    this.cacheDir = path.join(cacheDir, 'pdf-stage');
    this.layoutCache.clear();
    this.textCache.clear();
    this.pageCountCache.clear();
    this.inFlightPrefetch.clear();
  }

  async getQuickPageCount(doc) {
    if (Array.isArray(doc.pages)) return doc.pages.length;
    if (this.pageCountCache.has(doc.id)) return this.pageCountCache.get(doc.id);
    if (doc.fullPath) {
      try {
        const { stdout } = await runPoppler('pdfinfo', [doc.fullPath], { timeout: 6000 });
        const m = stdout.match(/^Pages:\s*(\d+)/im);
        if (m) {
          const count = Math.max(1, parseInt(m[1], 10));
          this.pageCountCache.set(doc.id, count);
          return count;
        }
      } catch {}
    }
    const pages = await this.library.ensureExtracted(doc);
    this.pageCountCache.set(doc.id, pages.length);
    return pages.length;
  }

  async listPdfs() {
    const pdfs = [];
    for (const doc of this.library.docs.values()) {
      if (doc.ext !== '.pdf') continue;
      let pageCount = null;
      try {
        pageCount = await this.getQuickPageCount(doc);
      } catch {
        pageCount = 1;
      }
      pdfs.push({
        id: doc.id,
        name: doc.name,
        relPath: doc.relPath,
        size: doc.size,
        active: doc.active,
        pageCount: pageCount || 1,
      });
    }
    const depthOf = (rel) => String(rel || '').split(path.sep).length;
    pdfs.sort(
      (a, b) =>
        Number(b.active) - Number(a.active) ||
        depthOf(a.relPath) - depthOf(b.relPath) ||
        b.pageCount - a.pageCount ||
        a.name.localeCompare(b.name),
    );
    return pdfs;
  }

  resolvePdfDoc(idOrName) {
    const pdfs = Array.from(this.library.docs.values()).filter((d) => d.ext === '.pdf');
    if (!pdfs.length) return null;

    if (idOrName) {
      const q = String(idOrName).trim().toLowerCase();
      const byId = pdfs.find((d) => d.id.toLowerCase() === q);
      if (byId) return byId;
      const exact = pdfs.find((d) => d.name.toLowerCase() === q || d.relPath.toLowerCase() === q);
      if (exact) return exact;
      const partial = pdfs.find((d) => d.name.toLowerCase().includes(q) || d.relPath.toLowerCase().includes(q));
      if (partial) return partial;
    }

    // Default to root-level active PDFs first (typically the main lecture slides/textbook)
    const active = pdfs.filter((d) => d.active);
    const pool = active.length ? active : pdfs;
    const depthOf = (rel) => String(rel || '').split(path.sep).length;
    return pool.sort(
      (a, b) => depthOf(a.relPath) - depthOf(b.relPath) || (b.pages?.length || b.size) - (a.pages?.length || a.size),
    )[0];
  }

  async getPageCount(doc) {
    return await this.getQuickPageCount(doc);
  }

  async getPageText(doc, page) {
    const totalPages = await this.getQuickPageCount(doc);
    const clamped = Math.max(1, Math.min(totalPages, Math.floor(Number(page) || 1)));
    const cacheKey = `${doc.id}:${clamped}`;
    if (this.textCache.has(cacheKey)) {
      return this.textCache.get(cacheKey);
    }
    if (Array.isArray(doc.pages) && doc.pages[clamped - 1] != null) {
      const res = {
        page: clamped,
        totalPages: doc.pages.length,
        text: doc.pages[clamped - 1] || '',
      };
      this.textCache.set(cacheKey, res);
      return res;
    }
    // Single-page fast extraction (instant even on 100MB+ PDFs!)
    if (doc.fullPath && doc.ext === '.pdf') {
      try {
        const { stdout } = await runPoppler('pdftotext', ['-layout', '-f', String(clamped), '-l', String(clamped), doc.fullPath, '-'], {
          timeout: 10000,
        });
        const res = {
          page: clamped,
          totalPages,
          text: String(stdout || '').replace(/\f/g, '').trim(),
        };
        this.textCache.set(cacheKey, res);
        return res;
      } catch {}
    }
    const pages = await this.library.ensureExtracted(doc);
    const safeIdx = Math.max(1, Math.min(pages.length, clamped));
    const res = {
      page: safeIdx,
      totalPages: pages.length,
      text: pages[safeIdx - 1] || '',
    };
    this.textCache.set(cacheKey, res);
    return res;
  }

  async findTopicPage(doc, topicQuery) {
    if (!topicQuery) return 1;
    const res = await this.library.search({ query: topicQuery, filename: doc.name });
    if (res.results?.length) {
      return res.results[0].page || 1;
    }
    return 1;
  }

  async renderDisplayPng(doc, page) {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const p = Math.max(1, Math.floor(Number(page) || 1));
    const stat = await fs.stat(doc.fullPath);
    const prefix = path.join(this.cacheDir, `${doc.id}-${Math.floor(stat.mtimeMs)}-p${p}-hi`);
    const outFile = `${prefix}.png`;

    try {
      await fs.access(outFile);
      return outFile;
    } catch {
      // Cache miss -> render
    }

    await runPoppler('pdftoppm', ['-png', '-r', '160', '-f', String(p), '-l', String(p), '-singlefile', doc.fullPath, prefix]);
    return outFile;
  }

  async renderVisionJpegBase64(doc, page) {
    await fs.mkdir(this.cacheDir, { recursive: true });
    const p = Math.max(1, Math.floor(Number(page) || 1));
    const stat = await fs.stat(doc.fullPath);
    const prefix = path.join(this.cacheDir, `${doc.id}-${Math.floor(stat.mtimeMs)}-p${p}-vis60`);
    const outFile = `${prefix}.jpg`;

    try {
      const existing = await fs.readFile(outFile);
      return existing.toString('base64');
    } catch {
      // Cache miss
    }

    await runPoppler('pdftoppm', [
      '-jpeg',
      '-jpegopt',
      'quality=74',
      '-r',
      '60',
      '-f',
      String(p),
      '-l',
      String(p),
      '-singlefile',
      doc.fullPath,
      prefix,
    ]);
    const buf = await fs.readFile(outFile);
    return buf.toString('base64');
  }

  async extractPageLayout(doc, page) {
    const p = Math.max(1, Math.floor(Number(page) || 1));
    const cacheKey = `${doc.id}:${p}`;
    if (this.layoutCache.has(cacheKey)) {
      return this.layoutCache.get(cacheKey);
    }

    let pageW = 720;
    let pageH = 540;
    const words = [];

    try {
      const { stdout } = await runPoppler('pdftotext', ['-bbox', '-f', String(p), '-l', String(p), doc.fullPath, '-']);
      const pageMatch = stdout.match(/<page\s+width="([\d.]+)"\s+height="([\d.]+)">/i);
      if (pageMatch) {
        pageW = Math.max(1, parseFloat(pageMatch[1]) || 720);
        pageH = Math.max(1, parseFloat(pageMatch[2]) || 540);
      }

      const vbW = 1000;
      const vbH = Math.max(300, Math.round(1000 * (pageH / pageW)));

      const wordRe = /<word\s+xMin="([\d.]+)"\s+yMin="([\d.]+)"\s+xMax="([\d.]+)"\s+yMax="([\d.]+)">([\s\S]*?)<\/word>/gi;
      let m;
      while ((m = wordRe.exec(stdout)) !== null) {
        const text = decodeXmlEntities(m[5]).trim();
        if (!text) continue;
        const x1 = (parseFloat(m[1]) / pageW) * vbW;
        const y1 = (parseFloat(m[2]) / pageH) * vbH;
        const x2 = (parseFloat(m[3]) / pageW) * vbW;
        const y2 = (parseFloat(m[4]) / pageH) * vbH;
        words.push({
          text,
          norm: normalizeMatchText(text),
          x: Math.round(x1 * 10) / 10,
          y: Math.round(y1 * 10) / 10,
          w: Math.max(2, Math.round((x2 - x1) * 10) / 10),
          h: Math.max(2, Math.round((y2 - y1) * 10) / 10),
        });
      }

      // Group words into horizontal reading lines
      const lines = [];
      const sorted = [...words].sort((a, b) => a.y - b.y || a.x - b.x);
      for (const w of sorted) {
        const cy = w.y + w.h / 2;
        const existing = lines.find((ln) => Math.abs(ln.cy - cy) <= Math.max(8, ln.h * 0.65));
        if (existing) {
          existing.words.push(w);
          const xMin = Math.min(existing.x, w.x);
          const yMin = Math.min(existing.y, w.y);
          const xMax = Math.max(existing.x + existing.w, w.x + w.w);
          const yMax = Math.max(existing.y + existing.h, w.y + w.h);
          existing.x = xMin;
          existing.y = yMin;
          existing.w = xMax - xMin;
          existing.h = yMax - yMin;
          existing.cy = yMin + existing.h / 2;
        } else {
          lines.push({
            words: [w],
            x: w.x,
            y: w.y,
            w: w.w,
            h: w.h,
            cy,
          });
        }
      }

      for (const ln of lines) {
        ln.words.sort((a, b) => a.x - b.x);
        ln.text = ln.words.map((w) => w.text).join(' ');
        ln.norm = normalizeMatchText(ln.text);
        ln.x = Math.round(ln.x);
        ln.y = Math.round(ln.y);
        ln.w = Math.round(ln.w);
        ln.h = Math.round(ln.h);
      }
      lines.sort((a, b) => a.y - b.y || a.x - b.x);

      const layout = { pageW, pageH, vbW, vbH, words, lines };
      this.layoutCache.set(cacheKey, layout);
      return layout;
    } catch {
      const vbW = 1000;
      const vbH = 750;
      const fallback = { pageW, pageH, vbW, vbH, words: [], lines: [] };
      this.layoutCache.set(cacheKey, fallback);
      return fallback;
    }
  }

  /**
   * Resolves a target text phrase from the PDF page into an exact millimeter-accurate
   * bounding box inside the SVG viewBox (0..vbW, 0..vbH).
   */
  resolveTextAnchor(layout, targetText) {
    if (!layout || !targetText) return null;
    const needle = normalizeMatchText(targetText);
    if (!needle) return null;
    const needleTokens = needle.split(' ').filter(Boolean);
    if (!needleTokens.length) return null;

    // 1. Exact contiguous word-sequence match inside a single line (highest precision!)
    let bestBox = null;
    let bestScore = 0;

    for (const ln of layout.lines || []) {
      const ws = ln.words || [];
      if (!ws.length) continue;

      // Exact phrase scan over line words
      for (let i = 0; i < ws.length; i++) {
        let joined = '';
        let matched = 0;
        let xMin = Infinity;
        let yMin = Infinity;
        let xMax = -Infinity;
        let yMax = -Infinity;

        for (let j = i; j < Math.min(ws.length, i + needleTokens.length + 3); j++) {
          const wn = ws[j].norm;
          if (!wn) continue;
          joined = joined ? `${joined} ${wn}` : wn;
          xMin = Math.min(xMin, ws[j].x);
          yMin = Math.min(yMin, ws[j].y);
          xMax = Math.max(xMax, ws[j].x + ws[j].w);
          yMax = Math.max(yMax, ws[j].y + ws[j].h);

          if (joined === needle) {
            return {
              x: Math.round(xMin),
              y: Math.round(yMin),
              w: Math.max(14, Math.round(xMax - xMin)),
              h: Math.max(12, Math.round(yMax - yMin)),
              cx: Math.round((xMin + xMax) / 2),
              cy: Math.round((yMin + yMax) / 2),
              matchedText: ws
                .slice(i, j + 1)
                .map((w) => w.text)
                .join(' '),
            };
          }

          if (joined.includes(needle)) {
            const score = 100 - (j - i);
            if (score > bestScore) {
              bestScore = score;
              bestBox = {
                x: Math.round(xMin),
                y: Math.round(yMin),
                w: Math.max(14, Math.round(xMax - xMin)),
                h: Math.max(12, Math.round(yMax - yMin)),
                cx: Math.round((xMin + xMax) / 2),
                cy: Math.round((yMin + yMax) / 2),
                matchedText: ws
                  .slice(i, j + 1)
                  .map((w) => w.text)
                  .join(' '),
              };
            }
          }

          if (needleTokens.includes(wn)) matched++;
        }

        // Token-overlap fuzzy match within line span
        if (matched > 0 && needleTokens.length >= 2) {
          const endIdx = Math.min(ws.length - 1, i + needleTokens.length + 1);
          const span = ws.slice(i, endIdx + 1);
          const hitWords = span.filter((w) => needleTokens.some((nt) => nt.length >= 2 && (w.norm === nt || w.norm.includes(nt))));
          const ratio = hitWords.length / needleTokens.length;
          if (ratio >= 0.6 && hitWords.length >= 2) {
            const hx1 = Math.min(...hitWords.map((w) => w.x));
            const hy1 = Math.min(...hitWords.map((w) => w.y));
            const hx2 = Math.max(...hitWords.map((w) => w.x + w.w));
            const hy2 = Math.max(...hitWords.map((w) => w.y + w.h));
            const score = 50 + ratio * 40;
            if (score > bestScore) {
              bestScore = score;
              bestBox = {
                x: Math.round(hx1),
                y: Math.round(hy1),
                w: Math.max(14, Math.round(hx2 - hx1)),
                h: Math.max(12, Math.round(hy2 - hy1)),
                cx: Math.round((hx1 + hx2) / 2),
                cy: Math.round((hy1 + hy2) / 2),
                matchedText: hitWords.map((w) => w.text).join(' '),
              };
            }
          }
        }
      }
    }

    // 2. Single-token substring fallback across words
    if (!bestBox && needleTokens.length === 1 && needleTokens[0].length >= 2) {
      const tok = needleTokens[0];
      const w = (layout.words || []).find((wd) => wd.norm === tok) || (layout.words || []).find((wd) => wd.norm.includes(tok));
      if (w) {
        return {
          x: Math.round(w.x),
          y: Math.round(w.y),
          w: Math.max(14, Math.round(w.w)),
          h: Math.max(12, Math.round(w.h)),
          cx: Math.round(w.x + w.w / 2),
          cy: Math.round(w.y + w.h / 2),
          matchedText: w.text,
        };
      }
    }

    return bestBox;
  }

  summarizeLinesForPrompt(layout, maxLines = 12) {
    if (!layout?.lines?.length) return '';
    return layout.lines
      .filter((ln) => ln.text && ln.text.length >= 2)
      .slice(0, maxLines)
      .map((ln) => `- "${ln.text.slice(0, 76)}"`)
      .join('\n');
  }

  async getPageBundle(doc, page, { includeVision = true } = {}) {
    const totalPages = await this.getQuickPageCount(doc);
    const targetPage = Math.max(1, Math.min(totalPages, Math.floor(Number(page) || 1)));

    // Run text extraction, layout bbox extraction & display PNG rendering IN PARALLEL on multi-core CPU!
    const [info, layout, , visionBase64] = await Promise.all([
      this.getPageText(doc, targetPage),
      this.extractPageLayout(doc, targetPage),
      this.renderDisplayPng(doc, targetPage),
      includeVision ? this.renderVisionJpegBase64(doc, targetPage) : Promise.resolve(null),
    ]);
    const analysis = detectProblemOrExample(info.text);

    // Silently prefetch next 2 pages on idle CPU cores while GPU runs Ollama -> 0ms PDF overhead!
    if (info.page < info.totalPages) {
      this.prefetchPage(doc, info.page + 1);
    }
    if (info.page + 1 < info.totalPages) {
      this.prefetchPage(doc, info.page + 2);
    }

    return {
      docId: doc.id,
      name: doc.name,
      relPath: doc.relPath,
      page: info.page,
      totalPages: info.totalPages,
      text: info.text,
      vbW: layout.vbW,
      vbH: layout.vbH,
      pageW: layout.pageW,
      pageH: layout.pageH,
      imageUrl: `/api/pdf/page-image?id=${encodeURIComponent(doc.id)}&page=${info.page}`,
      layout,
      linesPromptSummary: this.summarizeLinesForPrompt(layout, 6),
      visionBase64,
      ...analysis,
    };
  }

  prefetchPage(doc, page) {
    const key = `${doc.id}:${page}`;
    if (this.inFlightPrefetch.has(key)) return;
    this.inFlightPrefetch.add(key);
    Promise.all([
      this.getPageText(doc, page).catch(() => {}),
      this.renderDisplayPng(doc, page).catch(() => {}),
      this.extractPageLayout(doc, page).catch(() => {}),
    ]).finally(() => {
      this.inFlightPrefetch.delete(key);
    });
  }
}
