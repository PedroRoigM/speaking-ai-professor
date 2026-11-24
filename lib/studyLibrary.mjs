import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SUPPORTED_EXTS = new Set(['.pdf', '.md', '.txt', '.html', '.htm', '.csv', '.json', '.xlsx', '.pptx', '.docx']);
const IGNORE_DIRS = new Set([
  'node_modules',
  '.git',
  '.agents',
  '.cache',
  'Speaking_AI_Professor',
  '__pycache__',
  '.venv',
  'venv',
  'dist',
  'build',
]);

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

const OFFICE_EXTRACT_PY = `
import json, sys, zipfile, xml.etree.ElementTree as ET, re

path = sys.argv[1]
ext = sys.argv[2].lower()
pages = []

with zipfile.ZipFile(path, 'r') as z:
    names = z.namelist()
    if ext == '.pptx':
        slides = sorted(
            [n for n in names if re.match(r'^ppt/slides/slide\\d+\\.xml$', n)],
            key=lambda s: int(re.search(r'(\\d+)', s).group(1))
        )
        for idx, s in enumerate(slides, 1):
            root = ET.fromstring(z.read(s))
            texts = [el.text.strip() for el in root.iter() if el.tag.endswith('}t') and el.text and el.text.strip()]
            pages.append(f"[Slide {idx}]\\n" + " ".join(texts))
    elif ext == '.docx':
        if 'word/document.xml' in names:
            root = ET.fromstring(z.read('word/document.xml'))
            paras = []
            for p in root.iter():
                if p.tag.endswith('}p'):
                    txt = "".join(t.text for t in p.iter() if t.tag.endswith('}t') and t.text)
                    if txt.strip():
                        paras.append(txt.strip())
            full = "\\n".join(paras)
            for i in range(0, max(1, len(full)), 3000):
                pages.append(full[i:i+3000])
    elif ext == '.xlsx':
        shared = []
        if 'xl/sharedStrings.xml' in names:
            sroot = ET.fromstring(z.read('xl/sharedStrings.xml'))
            for si in sroot.iter():
                if si.tag.endswith('}si'):
                    shared.append("".join(t.text for t in si.iter() if t.tag.endswith('}t') and t.text))
        sheet_names = {}
        if 'xl/workbook.xml' in names:
            wroot = ET.fromstring(z.read('xl/workbook.xml'))
            idx = 1
            for sh in wroot.iter():
                if sh.tag.endswith('}sheet'):
                    sheet_names[idx] = sh.attrib.get('name', f'Sheet{idx}')
                    idx += 1
        sheets = sorted(
            [n for n in names if re.match(r'^xl/worksheets/sheet\\d+\\.xml$', n)],
            key=lambda s: int(re.search(r'(\\d+)', s).group(1))
        )
        for s in sheets:
            num = int(re.search(r'(\\d+)', s).group(1))
            sname = sheet_names.get(num, f'Sheet {num}')
            root = ET.fromstring(z.read(s))
            rows_out = [f"[Excel Sheet: {sname}]"]
            for row in root.iter():
                if row.tag.endswith('}row'):
                    vals = []
                    for c in row:
                        if not c.tag.endswith('}c'):
                            continue
                        ctype = c.attrib.get('t')
                        ref = c.attrib.get('r', '')
                        f_el = next((ch for ch in c if ch.tag.endswith('}f')), None)
                        v_el = next((ch for ch in c if ch.tag.endswith('}v')), None)
                        val = ''
                        if v_el is not None and v_el.text is not None:
                            if ctype == 's':
                                try:
                                    val = shared[int(v_el.text)]
                                except Exception:
                                    val = v_el.text
                            else:
                                val = v_el.text
                        if f_el is not None and f_el.text:
                            vals.append(f"{ref}:{val} (={f_el.text})")
                        elif val != '':
                            vals.append(f"{ref}:{val}")
                    if vals:
                        rows_out.append(" | ".join(vals))
                    if len(rows_out) > 220:
                        rows_out.append("... (truncated additional rows)")
                        break
            pages.append("\\n".join(rows_out))

if not pages:
    pages = ["(No extractable text found)"]
print(json.dumps(pages))
`;

export class StudyLibrary {
  constructor({ workspaceRoot, cacheDir }) {
    this.workspaceRoot = path.resolve(workspaceRoot);
    this.cacheDir = cacheDir;
    /** @type {Map<string, { id: string, name: string, relPath: string, fullPath: string | null, ext: string, size: number, source: 'workspace' | 'uploaded', active: boolean, pages: string[] | null }>} */
    this.docs = new Map();
    this.domainProfile = null;
  }

  async init() {
    await fs.mkdir(this.cacheDir, { recursive: true });
    await this.scanWorkspace();
    await this.analyzeFolderDomain();
  }

  async switchFolder(newRoot) {
    const resolved = path.resolve(newRoot);
    const stat = await fs.stat(resolved);
    if (!stat.isDirectory()) {
      throw new Error(`Not a directory: ${resolved}`);
    }
    this.workspaceRoot = resolved;
    this.docs.clear();
    this.domainProfile = null;
    await this.scanWorkspace();
    await this.analyzeFolderDomain();
    return {
      workspaceRoot: this.workspaceRoot,
      domainProfile: this.domainProfile,
      files: this.listFiles(),
    };
  }

  async scanWorkspace() {
    const walk = async (dir, depth = 0) => {
      if (depth > 3) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
        if (entry.isFile() && /^(AGENTS|CLAUDE)\.md$/i.test(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (IGNORE_DIRS.has(entry.name)) continue;
          await walk(fullPath, depth + 1);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!SUPPORTED_EXTS.has(ext)) continue;
          try {
            const stat = await fs.stat(fullPath);
            const maxBytes = ext === '.pdf' ? 250 * 1024 * 1024 : 50 * 1024 * 1024;
            if (stat.size > maxBytes) continue;
            const relPath = path.relative(this.workspaceRoot, fullPath);
            const id = crypto.createHash('sha1').update(`${this.workspaceRoot}:${relPath}`).digest('hex').slice(0, 10);
            if (!this.docs.has(id)) {
              // Activate key study files automatically (avoid enabling huge junk JSONs)
              const autoActive =
                ext === '.pdf' ||
                ext === '.pptx' ||
                ext === '.docx' ||
                ext === '.xlsx' ||
                ext === '.md' ||
                ext === '.txt' ||
                (ext === '.html' && !relPath.includes('node_modules'));
              this.docs.set(id, {
                id,
                name: entry.name,
                relPath,
                fullPath,
                ext,
                size: stat.size,
                source: 'workspace',
                active: autoActive,
                pages: null,
              });
            }
          } catch {
            // Skip unreadable
          }
        }
      }
    };
    await walk(this.workspaceRoot, 0);
  }

  async analyzeFolderDomain() {
    const folderName = path.basename(this.workspaceRoot);
    const files = this.listFiles();
    const activeFiles = files.filter((f) => f.active);

    // Sample opening snippets from up to 6 key documents so the professor immediately
    // knows the subject, syllabus, terminology, and language of THIS folder.
    const prioritized = [...activeFiles].sort((a, b) => {
      const rank = (ext) => ({ '.md': 1, '.pdf': 2, '.pptx': 3, '.docx': 4, '.xlsx': 5, '.html': 6 }[ext] || 9);
      return rank(a.ext) - rank(b.ext);
    });

    const previews = [];
    let spanishSignals = 0;
    let englishSignals = 0;

    for (const meta of prioritized.slice(0, 6)) {
      const doc = this.docs.get(meta.id);
      if (!doc || (doc.ext === '.pdf' && doc.size > 30 * 1024 * 1024)) continue;
      try {
        const pages = await this.ensureExtracted(doc);
        const sample = (pages[0] || '').replace(/\s+/g, ' ').trim().slice(0, 480);
        if (sample) {
          previews.push({
            file: doc.name,
            relPath: doc.relPath,
            pages: pages.length,
            snippet: sample,
          });
          const low = ` ${sample.toLowerCase()} `;
          for (const w of [' el ', ' la ', ' de ', ' que ', ' para ', ' con ', ' del ', ' las ', ' los ', ' cálculo ', ' dinámica ']) {
            if (low.includes(w)) spanishSignals++;
          }
          for (const w of [' the ', ' and ', ' with ', ' for ', ' that ', ' this ', ' from ', ' system ', ' chapter ']) {
            if (low.includes(w)) englishSignals++;
          }
        }
      } catch {
        // Non-fatal preview skip
      }
    }

    const folderLow = folderName.toLowerCase();
    if (/[áéíóúñ]/.test(folderLow) || folderLow.includes('dinamica') || folderLow.includes('apuntes')) {
      spanishSignals += 4;
    }

    const detectedLanguage =
      spanishSignals > englishSignals + 2 ? 'es' : englishSignals > spanishSignals + 2 ? 'en' : 'auto';

    // Extract top-level folder / topic cues
    const subfolders = Array.from(
      new Set(
        files
          .map((f) => f.relPath.split(path.sep))
          .filter((parts) => parts.length > 1)
          .map((parts) => parts[0]),
      ),
    ).slice(0, 8);

    const suggestedStarters = this.buildStarterPrompts({ folderName, files: activeFiles, detectedLanguage });

    this.domainProfile = {
      folderName,
      workspaceRoot: this.workspaceRoot,
      totalFiles: files.length,
      activeFiles: activeFiles.length,
      subfolders,
      detectedLanguage,
      previews,
      suggestedStarters,
    };

    return this.domainProfile;
  }

  buildStarterPrompts({ folderName, files, detectedLanguage }) {
    const primaryPdf = files.find((f) => f.ext === '.pdf' || f.ext === '.pptx');
    const primaryExcel = files.find((f) => f.ext === '.xlsx' || f.ext === '.csv');
    const isEs = detectedLanguage === 'es';

    if (isEs) {
      return [
        {
          label: `Explicación visual de ${folderName}`,
          prompt: `Hazme una clase en vivo sobre los conceptos fundamentales de esta carpeta (${folderName}). Dibuja el diagrama principal trazo a trazo en la pizarra mientras me lo explicas y hazme una pregunta rápida de comprobación.`,
        },
        primaryPdf
          ? {
              label: `Recorrer ${primaryPdf.name}`,
              prompt: `Busca en ${primaryPdf.name} el tema principal o las primeras ecuaciones importantes, dibuja el esquema en la pizarra en tiempo real y explícame el porqué de cada término paso a paso.`,
            }
          : {
              label: 'Laboratorio interactivo en vivo',
              prompt: `Constrúyeme un laboratorio interactivo con sliders en la pizarra sobre el concepto más importante de esta carpeta para que podamos mover parámetros juntos mientras me explicas el efecto físico.`,
            },
        primaryExcel
          ? {
              label: `Revisar hoja ${primaryExcel.name}`,
              prompt: `Busca los datos y fórmulas de ${primaryExcel.name}, explícame qué modela y ponme un problema práctico verificando los cálculos en Python.`,
            }
          : {
              label: 'Examen oral rápido',
              prompt: `Hazme un examen oral interactivo basado en los archivos de esta carpeta. Empieza con una pregunta conceptual clave, espera mi respuesta hablada y corrígeme en la pizarra.`,
            },
      ];
    }

    return [
      {
        label: `Visual overview of ${folderName}`,
        prompt: `Give me a live whiteboard class on the core concepts in this folder (${folderName}). Draw the key diagram stroke-by-stroke on the board while explaining the intuition, then test me with a quick check.`,
      },
      primaryPdf
        ? {
            label: `Walk through ${primaryPdf.name}`,
            prompt: `Search ${primaryPdf.name} for its core framework or key equations, sketch it live on the whiteboard, and explain why every piece matters step by step.`,
          }
        : {
            label: 'Build a live interactive lab',
            prompt: `Build a live interactive slider simulation on the stage for the central concept in this folder so we can manipulate variables together while you explain cause and effect.`,
          },
      {
        label: 'Interactive oral quiz',
        prompt: `Act as my private oral exam coach using the files in this folder. Ask one sharp conceptual question at a time, wait for my spoken answer, and draw feedback on the board.`,
      },
    ];
  }

  listFiles() {
    return Array.from(this.docs.values())
      .map((d) => ({
        id: d.id,
        name: d.name,
        relPath: d.relPath,
        ext: d.ext,
        size: d.size,
        source: d.source,
        active: d.active,
        indexed: Array.isArray(d.pages),
        pageCount: Array.isArray(d.pages) ? d.pages.length : null,
      }))
      .sort((a, b) => Number(b.active) - Number(a.active) || a.relPath.localeCompare(b.relPath));
  }

  toggleFile(id, active) {
    const doc = this.docs.get(id);
    if (!doc) return null;
    doc.active = Boolean(active);
    return doc;
  }

  async addUploadedFile({ filename, buffer }) {
    const cleanBase = path.basename(String(filename || 'document.txt').replace(/[\0\r\n]/g, '')).trim() || 'document.txt';
    const ext = path.extname(cleanBase).toLowerCase() || '.txt';
    if (!SUPPORTED_EXTS.has(ext)) {
      throw new Error(`Unsupported file extension: ${ext}`);
    }
    const id = 'up-' + crypto.randomBytes(5).toString('hex');
    const safeName = cleanBase.replace(/[^\w.\- ()]/g, '_');
    const tempPath = path.join(this.cacheDir, `${id}-${safeName}`);
    await fs.writeFile(tempPath, buffer);

    const doc = {
      id,
      name: cleanBase,
      relPath: `Uploaded / ${cleanBase}`,
      fullPath: tempPath,
      ext,
      size: buffer.length,
      source: 'uploaded',
      active: true,
      pages: null,
    };
    this.docs.set(id, doc);
    await this.ensureExtracted(doc);
    await this.analyzeFolderDomain();
    return {
      id: doc.id,
      name: doc.name,
      relPath: doc.relPath,
      ext: doc.ext,
      size: doc.size,
      source: doc.source,
      active: doc.active,
      indexed: true,
      pageCount: doc.pages?.length || 1,
    };
  }

  async extractPdfPages(fullPath) {
    const candidates = ['/opt/homebrew/bin/pdftotext', '/usr/local/bin/pdftotext', 'pdftotext'];
    let lastError = null;
    for (const bin of candidates) {
      try {
        const { stdout } = await execFileAsync(bin, ['-layout', '--', fullPath, '-'], {
          maxBuffer: 40 * 1024 * 1024,
          timeout: 30000,
        });
        const pages = stdout.split('\f').map((p) => p.trim());
        while (pages.length > 1 && pages[pages.length - 1] === '') pages.pop();
        return pages.length ? pages : ['(PDF had no extractable text; may be scanned images)'];
      } catch (err) {
        lastError = err;
      }
    }
    throw new Error(`pdftotext failed: ${lastError?.message || 'not found'}`);
  }

  async extractOfficePages(fullPath, ext) {
    const { stdout } = await execFileAsync('python3', ['-I', '-c', OFFICE_EXTRACT_PY, fullPath, ext], {
      maxBuffer: 25 * 1024 * 1024,
      timeout: 20000,
    });
    const pages = JSON.parse(stdout || '[]');
    return Array.isArray(pages) && pages.length ? pages : ['(Empty document)'];
  }

  async ensureExtracted(doc) {
    if (Array.isArray(doc.pages)) return doc.pages;
    if (!doc.fullPath) return [];

    const cacheFile = path.join(this.cacheDir, `${doc.id}.pages.json`);
    try {
      const stat = await fs.stat(doc.fullPath);
      const cachedRaw = await fs.readFile(cacheFile, 'utf8');
      const cached = JSON.parse(cachedRaw);
      if (cached.mtimeMs === stat.mtimeMs && Array.isArray(cached.pages)) {
        doc.pages = cached.pages;
        return doc.pages;
      }
    } catch {
      // Cache miss
    }

    let pages = [];
    if (doc.ext === '.pdf') {
      pages = await this.extractPdfPages(doc.fullPath);
    } else if (doc.ext === '.xlsx' || doc.ext === '.pptx' || doc.ext === '.docx') {
      pages = await this.extractOfficePages(doc.fullPath, doc.ext);
    } else {
      const raw = await fs.readFile(doc.fullPath, 'utf8');
      const text = doc.ext === '.html' || doc.ext === '.htm' ? stripHtml(raw) : raw;
      const chunkSize = 3000;
      for (let i = 0; i < text.length; i += chunkSize) {
        pages.push(text.slice(i, i + chunkSize));
      }
      if (!pages.length) pages = [''];
    }

    doc.pages = pages;
    try {
      const stat = await fs.stat(doc.fullPath);
      await fs.writeFile(cacheFile, JSON.stringify({ mtimeMs: stat.mtimeMs, pages }), 'utf8');
    } catch {
      // Non-fatal
    }
    return doc.pages;
  }

  async getActiveCatalogSummary() {
    const activeDocs = Array.from(this.docs.values()).filter((d) => d.active);
    const p = this.domainProfile;
    const header = p
      ? `CURRENT STUDY FOLDER: "${p.folderName}" (${p.workspaceRoot})\nSubfolders: ${p.subfolders.join(', ') || '(root only)'}\nDetected primary language in materials: ${p.detectedLanguage}`
      : `CURRENT STUDY FOLDER: ${this.workspaceRoot}`;

    if (!activeDocs.length) {
      return `${header}\nNo study documents are currently selected. Answer from expert domain knowledge and invite the student to drop files anytime.`;
    }

    const lines = activeDocs.map((d) => `- ${d.name} (${d.relPath}, ${(d.size / 1024).toFixed(0)} KB)`);
    const previewLines = (p?.previews || [])
      .slice(0, 5)
      .map((pr) => `  * ${pr.file} (${pr.pages} pages/sections): "${pr.snippet.slice(0, 260)}..."`)
      .join('\n');

    return `${header}

ACTIVE STUDY FILES (searchable verbatim via search_study_materials):
${lines.join('\n')}

CONTENT PREVIEW OF THIS FOLDER (use this to immediately become a world-class expert in this exact subject):
${previewLines}`;
  }

  async search({ query, filename, page }) {
    const activeDocs = Array.from(this.docs.values()).filter((d) => d.active);
    const pool = activeDocs.length ? activeDocs : Array.from(this.docs.values());
    const filtered = filename
      ? pool.filter(
          (d) =>
            d.name.toLowerCase().includes(filename.toLowerCase()) ||
            d.relPath.toLowerCase().includes(filename.toLowerCase()),
        )
      : pool;

    const targetDocs = filtered.length ? filtered : pool;

    if (page && Number.isFinite(Number(page))) {
      const pNum = Math.max(1, Math.floor(Number(page)));
      const excerpts = [];
      for (const doc of targetDocs.slice(0, 3)) {
        try {
          const pages = await this.ensureExtracted(doc);
          if (pNum <= pages.length) {
            excerpts.push({
              file: doc.name,
              page: pNum,
              totalPages: pages.length,
              excerpt: pages[pNum - 1].slice(0, 2600),
            });
          }
        } catch {
          // ignore
        }
      }
      return { query, page: pNum, results: excerpts };
    }

    const terms = String(query || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9_]+/)
      .filter((t) => t.length >= 2);

    const scored = [];
    for (const doc of targetDocs) {
      let pages;
      try {
        pages = await this.ensureExtracted(doc);
      } catch {
        continue;
      }
      for (let i = 0; i < pages.length; i++) {
        const rawPage = pages[i];
        if (!rawPage) continue;
        const norm = rawPage
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');

        let score = 0;
        let matchedTerms = 0;
        for (const t of terms) {
          if (norm.includes(t)) {
            matchedTerms++;
            score += 3;
            const hits = norm.split(t).length - 1;
            score += Math.min(hits, 5);
          }
        }
        if (terms.length > 1 && norm.includes(terms.join(' '))) {
          score += 10;
        }
        if (score > 0) {
          scored.push({
            score: score + matchedTerms * 2,
            file: doc.name,
            relPath: doc.relPath,
            page: i + 1,
            totalPages: pages.length,
            excerpt: rawPage.slice(0, 2200),
          });
        }
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return {
      query,
      totalMatches: scored.length,
      results: scored.slice(0, 4),
    };
  }
}
