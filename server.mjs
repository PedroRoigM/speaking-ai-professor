import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import {
  GoogleGenAI,
  Modality,
  FunctionResponseScheduling,
  StartSensitivity,
  EndSensitivity,
} from '@google/genai';
import { StudyLibrary } from './lib/studyLibrary.mjs';
import { PdfStageService } from './lib/pdfStage.mjs';
import { ClassDirector } from './lib/classDirector.mjs';
import { LookaheadClassEngine } from './lib/classTimeline.mjs';
import { verifyMathPython } from './lib/mathVerifier.mjs';
import { LocalVoiceEngine, LOCAL_VOICES } from './lib/localVoice.mjs';
import {
  LocalProfessorSession,
  RECOMMENDED_LOCAL_MODELS,
  getOllamaStatus,
  getOllamaRunningGpuInfo,
  pullOllamaModel,
} from './lib/localProfessor.mjs';
import {
  AVAILABLE_MODELS,
  AVAILABLE_CLASS_MODELS,
  AVAILABLE_VOICES,
  PROFESSOR_MODES,
  buildSystemInstruction,
  getProfessorToolDeclarations,
  normalizeGeminiLiveModelId,
  normalizeGeminiClassModelId,
} from './lib/professorConfig.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const LOCAL_ENV_PATH = path.join(__dirname, '.env');
const GLOBAL_CONFIG_DIR = path.join(os.homedir(), '.config', 'speaking-professor');
const GLOBAL_ENV_PATH = path.join(GLOBAL_CONFIG_DIR, '.env');
const CACHE_ROOT = path.join(os.homedir(), '.cache', 'speaking-professor');

// Parse CLI flags: node server.mjs [--dir /path/to/folder] [--port 3456] [--open]
function parseArgs(argv) {
  const opts = { dir: '', port: 0, open: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if ((arg === '--dir' || arg === '-d') && argv[i + 1]) {
      opts.dir = argv[++i];
    } else if ((arg === '--port' || arg === '-p') && argv[i + 1]) {
      opts.port = Number(argv[++i]) || 0;
    } else if (arg === '--open') {
      opts.open = true;
    } else if (!arg.startsWith('-') && !opts.dir) {
      opts.dir = arg;
    }
  }
  return opts;
}

const cli = parseArgs(process.argv.slice(2));
const EXAMPLES_DIR = path.join(__dirname, 'examples');
async function resolveDefaultTargetDir() {
  if (cli.dir) return path.resolve(cli.dir);
  if (process.env.TARGET_DIR) return path.resolve(process.env.TARGET_DIR);
  const cwd = path.resolve(process.cwd());
  if (cwd !== __dirname) return cwd;
  try {
    await fs.access(EXAMPLES_DIR);
    return EXAMPLES_DIR;
  } catch {
    return __dirname;
  }
}
let TARGET_DIR = await resolveDefaultTargetDir();
let PORT = cli.port || Number(process.env.PORT || 3456);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

let runtimeApiKey = process.env.GEMINI_API_KEY || '';

async function readEnvFile(filePath) {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
      if (key === 'GEMINI_API_KEY' && val && val !== 'your_gemini_api_key_here' && !runtimeApiKey) {
        runtimeApiKey = val;
      }
      if (key === 'PORT' && !cli.port && Number(val) > 0) {
        PORT = Number(val);
      }
    }
  } catch {
    // Missing env file is normal
  }
}

async function loadAllEnv() {
  await readEnvFile(LOCAL_ENV_PATH);
  await readEnvFile(GLOBAL_ENV_PATH);
}

async function saveApiKey(newKey) {
  const clean = String(newKey || '').trim();
  if (!clean) throw new Error('API key cannot be empty');
  runtimeApiKey = clean;
  const content = `# Global Gemini API key for Speaking AI Professor\nGEMINI_API_KEY=${clean}\n`;
  try {
    await fs.mkdir(GLOBAL_CONFIG_DIR, { recursive: true, mode: 0o700 });
    await fs.writeFile(GLOBAL_ENV_PATH, content, { mode: 0o600 });
  } catch {
    await fs.writeFile(LOCAL_ENV_PATH, content, { mode: 0o600 });
  }
}

function readRequestBody(req, maxBytes = 35 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

function cacheDirFor(dirPath) {
  const hash = crypto.createHash('sha1').update(path.resolve(dirPath)).digest('hex').slice(0, 12);
  return path.join(CACHE_ROOT, hash);
}

let library;
let pdfStage;
let activeCacheDir;

async function initLibraryFor(dirPath) {
  activeCacheDir = cacheDirFor(dirPath);
  try {
    await fs.mkdir(activeCacheDir, { recursive: true });
  } catch {
    activeCacheDir = path.join(__dirname, '.cache');
    await fs.mkdir(activeCacheDir, { recursive: true });
  }
  library = new StudyLibrary({ workspaceRoot: dirPath, cacheDir: activeCacheDir });
  await library.init();
  if (!pdfStage) {
    pdfStage = new PdfStageService({ library, cacheDir: activeCacheDir });
    await pdfStage.init();
  } else {
    pdfStage.setLibrary(library, activeCacheDir);
    await pdfStage.init();
  }
}

const voiceEngine = new LocalVoiceEngine({ appDir: __dirname });

await loadAllEnv();
await initLibraryFor(TARGET_DIR);
const voiceCaps = await voiceEngine.init();
if (voiceCaps.kokoro) {
  // Pre-compile Kokoro MLX Metal GPU shaders asynchronously on boot so the 1st sentence has zero cold-start delay!
  voiceEngine.warmup();
}
const [initialOllama, initialGpuPs] = await Promise.all([getOllamaStatus(), getOllamaRunningGpuInfo()]);

process.on('SIGINT', () => {
  voiceEngine.shutdown();
  process.exit(0);
});
process.on('SIGTERM', () => {
  voiceEngine.shutdown();
  process.exit(0);
});

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    const pathname = decodeURIComponent(url.pathname);

    if (req.method === 'GET' && pathname === '/api/health') {
      const [ollama, gpuPs, pdfs] = await Promise.all([
        getOllamaStatus(),
        getOllamaRunningGpuInfo(),
        pdfStage.listPdfs(),
      ]);
      return sendJson(res, 200, {
        ok: true,
        ollamaRunning: ollama.running,
        ollamaModels: ollama.models.map((m) => m.name),
        gpuLoaded: gpuPs,
        voiceCapabilities: voiceEngine.capabilities,
        pdfCount: pdfs.length,
        workspaceRoot: library.workspaceRoot,
      });
    }

    if (req.method === 'GET' && pathname === '/api/config') {
      const [ollama, pdfs] = await Promise.all([getOllamaStatus(), pdfStage.listPdfs()]);
      return sendJson(res, 200, {
        hasApiKey: Boolean(runtimeApiKey),
        models: AVAILABLE_MODELS,
        classModels: AVAILABLE_CLASS_MODELS,
        voices: AVAILABLE_VOICES,
        localVoices: LOCAL_VOICES,
        recommendedLocalModels: RECOMMENDED_LOCAL_MODELS,
        ollama,
        voiceCapabilities: voiceEngine.capabilities,
        modes: Object.entries(PROFESSOR_MODES).map(([id, m]) => ({ id, name: m.name, short: m.short })),
        domainProfile: library.domainProfile,
        workspaceRoot: library.workspaceRoot,
        pdfs,
      });
    }

    if (req.method === 'GET' && pathname === '/api/pdfs') {
      const pdfs = await pdfStage.listPdfs();
      return sendJson(res, 200, { pdfs });
    }

    if (req.method === 'GET' && pathname === '/api/pdf/page-image') {
      const docId = url.searchParams.get('id') || '';
      const page = Number(url.searchParams.get('page') || 1);
      const doc = pdfStage.resolvePdfDoc(docId);
      if (!doc) return sendJson(res, 404, { error: 'PDF not found' });
      const pngPath = await pdfStage.renderDisplayPng(doc, page);
      const data = await fs.readFile(pngPath);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'public, max-age=3600',
      });
      return res.end(data);
    }

    if (req.method === 'GET' && pathname === '/api/pdf/page-info') {
      const docId = url.searchParams.get('id') || '';
      const page = Number(url.searchParams.get('page') || 1);
      const doc = pdfStage.resolvePdfDoc(docId);
      if (!doc) return sendJson(res, 404, { error: 'PDF not found' });
      const bundle = await pdfStage.getPageBundle(doc, page, { includeVision: false });
      return sendJson(res, 200, {
        docId: bundle.docId,
        name: bundle.name,
        page: bundle.page,
        totalPages: bundle.totalPages,
        vbW: bundle.vbW,
        vbH: bundle.vbH,
        imageUrl: bundle.imageUrl,
        hasExampleProblem: bundle.hasExampleProblem,
      });
    }

    if (req.method === 'GET' && pathname === '/api/ollama/status') {
      const ollama = await getOllamaStatus();
      return sendJson(res, 200, { ollama, voiceCapabilities: voiceEngine.capabilities });
    }

    if (req.method === 'POST' && pathname === '/api/voice/test') {
      const body = JSON.parse((await readRequestBody(req, 1024 * 16)).toString('utf8') || '{}');
      const voiceId = String(body.voiceId || 'kokoro:em_alex');
      const language = String(body.language || 'es');
      const sampleText =
        language === 'en'
          ? 'Audio check complete. Your professor is ready to begin the class.'
          : 'Prueba de audio correcta. Tu profesor está listo para empezar la clase.';
      const audio = await voiceEngine.synthesize(sampleText, { voiceId, language });
      return sendJson(res, 200, {
        ok: Boolean(audio.ok && audio.pcmBase64),
        engine: audio.engine || 'unknown',
        sampleRate: audio.sampleRate || 24000,
        pcmBase64: audio.pcmBase64 || '',
      });
    }

    if (req.method === 'POST' && pathname === '/api/ollama/pull') {
      const body = JSON.parse((await readRequestBody(req, 1024 * 16)).toString('utf8') || '{}');
      const modelName = String(body.model || '').trim();
      if (!modelName) return sendJson(res, 400, { error: 'Missing model name' });
      res.writeHead(200, {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
      });
      try {
        await pullOllamaModel(modelName, (evt) => {
          res.write(JSON.stringify(evt) + '\n');
        });
        res.write(JSON.stringify({ status: 'done', ok: true }) + '\n');
      } catch (err) {
        res.write(JSON.stringify({ error: err.message }) + '\n');
      }
      return res.end();
    }

    if (req.method === 'POST' && pathname === '/api/apikey') {
      const body = JSON.parse((await readRequestBody(req, 1024 * 16)).toString('utf8') || '{}');
      await saveApiKey(body.apiKey);
      return sendJson(res, 200, { ok: true, hasApiKey: true });
    }

    if (req.method === 'POST' && pathname === '/api/folder') {
      const body = JSON.parse((await readRequestBody(req, 1024 * 16)).toString('utf8') || '{}');
      const requested = String(body.folderPath || '').trim().replace(/^~/, os.homedir());
      if (!requested) return sendJson(res, 400, { error: 'Folder path is required' });
      await initLibraryFor(requested);
      TARGET_DIR = library.workspaceRoot;
      const pdfs = await pdfStage.listPdfs();
      return sendJson(res, 200, {
        ok: true,
        workspaceRoot: library.workspaceRoot,
        domainProfile: library.domainProfile,
        files: library.listFiles(),
        pdfs,
      });
    }

    if (req.method === 'GET' && pathname === '/api/materials') {
      await library.scanWorkspace();
      const pdfs = await pdfStage.listPdfs();
      return sendJson(res, 200, {
        files: library.listFiles(),
        domainProfile: library.domainProfile,
        workspaceRoot: library.workspaceRoot,
        pdfs,
      });
    }

    if (req.method === 'POST' && pathname === '/api/materials/toggle') {
      const body = JSON.parse((await readRequestBody(req, 1024 * 16)).toString('utf8') || '{}');
      const updated = library.toggleFile(body.id, body.active);
      if (!updated) return sendJson(res, 404, { error: 'File not found' });
      return sendJson(res, 200, { ok: true, id: updated.id, active: updated.active });
    }

    if (req.method === 'POST' && pathname === '/api/upload') {
      const body = JSON.parse((await readRequestBody(req, 40 * 1024 * 1024)).toString('utf8') || '{}');
      if (!body.filename || !body.base64) {
        return sendJson(res, 400, { error: 'Missing filename or base64 data' });
      }
      const buffer = Buffer.from(body.base64, 'base64');
      const added = await library.addUploadedFile({ filename: body.filename, buffer });
      const pdfs = await pdfStage.listPdfs();
      return sendJson(res, 200, {
        ok: true,
        file: added,
        files: library.listFiles(),
        domainProfile: library.domainProfile,
        pdfs,
      });
    }

    const relFile = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
    const safePath = path.resolve(PUBLIC_DIR, relFile);
    if (!safePath.startsWith(PUBLIC_DIR)) {
      res.writeHead(403);
      return res.end('Forbidden');
    }

    try {
      const data = await fs.readFile(safePath);
      const ext = path.extname(safePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      res.end(data);
    } catch {
      res.writeHead(404);
      res.end('Not found');
    }
  } catch (err) {
    console.error('[HTTP error]', err);
    sendJson(res, 500, { error: err.message || 'Internal server error' });
  }
});

// WebSocket Bridge: Browser <-> Node <-> Local Ollama / Gemini Live API
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (clientWs) => {
  let liveSession = null;
  let localSession = null;
  let activeEngine = 'local'; // 'local' | 'gemini'
  let activeConfig = null;
  let activeModelInfo = AVAILABLE_MODELS[0];
  let resumptionHandle = null;
  let reconnecting = false;
  let closedByUser = false;
  const cancelledToolIds = new Set();

  let svgCaptureBuffer = '';
  let insideLeakedSvg = false;

  const sendClient = (payload) => {
    if (clientWs.readyState === clientWs.OPEN) {
      clientWs.send(JSON.stringify(payload));
    }
  };

  // Lookahead Synchronized Classroom Engine (Adaptive Metal GPU Scheduler + Persistent Disk Lesson Cache!)
  const lookaheadClass = new LookaheadClassEngine({
    pdfStage,
    voiceEngine,
    sendClient,
    cacheDir: activeCacheDir,
    getRuntimeConfig: () => ({
      engine: activeEngine,
      localModel: activeConfig?.localModel || 'qwen3.5:9b',
      geminiClassModel: normalizeGeminiClassModelId(activeConfig?.geminiClassModel),
      localVoice: activeConfig?.localVoice || 'kokoro:em_alex',
      language: activeConfig?.language || 'es',
      apiKey: runtimeApiKey,
    }),
  });

  // Helper to detect instant resume / back-page voice commands during an active class
  async function handleClassVoiceCommand(rawText) {
    const norm = String(rawText || '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .trim();

    if (
      lookaheadClass.active &&
      (lookaheadClass.paused || lookaheadClass.qaPaused) &&
      /^(ok|vale|bien|perfecto|entendido|claro|gracias|si)?[\s,.!]*(sigue|continua|adelante|proseguir|reanuda|reanudar|seguimos|continue|resume|keep going|go on)[\s,.!]*$/.test(
        norm,
      )
    ) {
      await lookaheadClass.resume();
      return { handled: true };
    }

    if (
      lookaheadClass.pdfDoc &&
      /^(vuelve|retrocede|volver|regresa)?[\s,.!]*(a la )?(pagina anterior|diapositiva anterior|pagina atras|atras|previous page|go back)[\s,.!]*$/.test(
        norm,
      )
    ) {
      await lookaheadClass.jumpToPage({ delta: -1, startPlaying: true });
      return { handled: true };
    }

    if (
      lookaheadClass.active &&
      /^(salta|saltar|pasa|siguiente)?[\s,.!]*(este paso|este bloque|esto|beat|paso|next step|skip)[\s,.!]*$/.test(norm)
    ) {
      lookaheadClass.skipCurrentBeat();
      return { handled: true };
    }

    if (
      lookaheadClass.pdfDoc &&
      /^(salta|saltar|pasa|pasar|omite)?[\s,.!]*(el problema|el ejercicio|este ejercicio|este problema|skip problem)[\s,.!]*$/.test(norm)
    ) {
      await lookaheadClass.skipProblemAndAdvance();
      return { handled: true };
    }

    if (
      lookaheadClass.pdfDoc &&
      /^(pasa|pasar|avanza|siguiente|next)?[\s,.!]*(de )?(pagina|diapositiva|page|siguiente pagina|pagina siguiente|next page)[\s,.!]*$/.test(
        norm,
      )
    ) {
      await lookaheadClass.jumpToPage({ delta: +1, startPlaying: true });
      return { handled: true };
    }

    if (
      lookaheadClass.pdfDoc &&
      /^(verifica|comprueba|destraba|recupera|estas atascado|te has parado|check|recover)[\s,.!]*$/.test(norm)
    ) {
      await lookaheadClass.verifyAndRecover({ autoFix: true });
      return { handled: true };
    }

    const pageNumMatch = norm.match(/^(?:ve|ir|salta|vuelve|retrocede|pasa)?\s*(?:a la )?(?:pagina|pag|diapositiva|page)\s*(\d+)[\s,.!]*$/);
    if (lookaheadClass.pdfDoc && pageNumMatch) {
      await lookaheadClass.jumpToPage({ page: Number(pageNumMatch[1]), startPlaying: true });
      return { handled: true };
    }

    return { handled: false };
  }

  // Fallback Director for non-class-mode PDF/problem tool calls (Q&A, Auto-Expert, Socratic, Exam)
  const classDirector = new ClassDirector({
    pdfStage,
    sendClient,
    dispatchBeat: async ({ cueText, visionBase64 }) => {
      if (activeEngine === 'local' && localSession) {
        await localSession.runDirectorBeat({ cueText, visionBase64 });
      } else if (activeEngine === 'gemini' && liveSession) {
        if (visionBase64) {
          liveSession.sendRealtimeInput({
            video: { data: visionBase64, mimeType: 'image/jpeg' },
          });
        }
        liveSession.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: cueText }] }],
          turnComplete: true,
        });
      }
    },
  });

  function handleOutputTranscriptChunk(rawText) {
    if (!rawText) return;
    let chunk = String(rawText);

    if (insideLeakedSvg) {
      svgCaptureBuffer += chunk;
      const endIdx = svgCaptureBuffer.indexOf('</svg>');
      if (endIdx !== -1) {
        const svgMarkup = svgCaptureBuffer.slice(0, endIdx + 6);
        const remainder = svgCaptureBuffer.slice(endIdx + 6);
        insideLeakedSvg = false;
        svgCaptureBuffer = '';
        sendClient({
          type: 'stage_live_scene',
          data: { scene_title: 'Diagrama en vivo', badge: 'Live Chalkboard', svg_code: svgMarkup },
        });
        if (remainder.trim()) sendClient({ type: 'output_transcript', text: remainder });
      }
      return;
    }

    const startIdx = chunk.indexOf('<svg');
    if (startIdx !== -1) {
      const before = chunk.slice(0, startIdx);
      if (before) sendClient({ type: 'output_transcript', text: before });
      const rest = chunk.slice(startIdx);
      const endIdx = rest.indexOf('</svg>');
      if (endIdx !== -1) {
        const svgMarkup = rest.slice(0, endIdx + 6);
        const after = rest.slice(endIdx + 6);
        sendClient({
          type: 'stage_live_scene',
          data: { scene_title: 'Diagrama en vivo', badge: 'Live Chalkboard', svg_code: svgMarkup },
        });
        if (after.trim()) sendClient({ type: 'output_transcript', text: after });
      } else {
        insideLeakedSvg = true;
        svgCaptureBuffer = rest;
      }
      return;
    }

    sendClient({ type: 'output_transcript', text: chunk });
  }

  // Visual tools run silently without causing Gemini Live to repeat itself
  const SILENT_VISUAL_TOOLS = new Set([
    'draw_live_scene',
    'annotate_pdf_page',
    'start_blank_canvas_problem',
    'append_problem_step',
    'point_to_stage_element',
    'build_interactive_lab',
    'update_lab_parameters',
    'write_whiteboard_lesson',
    'show_active_recall_quiz',
    'class_progress',
  ]);

  // Unified tool executor shared by BOTH Local Ollama ($0) and Gemini Live Cloud.
  // When `stageSink` is supplied (Local mode), visual events are buffered onto the synchronized audio timeline!
  async function executeSharedTool(name, args = {}, stageSink = null) {
    const emitStage = (evt) => {
      if (stageSink) stageSink(evt);
      else sendClient(evt);
    };

    try {
      if (name === 'open_pdf_page') {
        const res = await classDirector.openPage({
          filename: args.filename,
          page: args.page,
          delta: args.delta,
          reason: args.reason,
          emit: !stageSink,
        });
        if (res.ok && stageSink) {
          emitStage({
            type: 'stage_pdf_page',
            data: {
              docId: res.docId,
              name: res.filename,
              page: res.page,
              totalPages: res.totalPages,
              imageUrl: `/api/pdf/page-image?id=${encodeURIComponent(res.docId)}&page=${res.page}`,
              vbW: res.vbW,
              vbH: res.vbH,
              hasExampleProblem: res.hasExampleProblem,
              reason: args.reason || '',
              annotations: classDirector.getAnnotationsFor(res.docId, res.page),
            },
          });
        }
        return res;
      }

      if (name === 'annotate_pdf_page') {
        // Sync classDirector activeBundle if lookaheadClass owns the open page
        if (!classDirector.activeBundle && lookaheadClass.pdfDoc) {
          await classDirector.openPage({ docId: lookaheadClass.pdfId, page: lookaheadClass.playedPage, emit: false, includeVision: false });
        }
        const origSend = classDirector.sendClient;
        if (stageSink) {
          classDirector.sendClient = (p) => (p.type?.startsWith('stage_') ? emitStage(p) : sendClient(p));
        }
        try {
          return classDirector.annotateCurrentPage(args);
        } finally {
          classDirector.sendClient = origSend;
        }
      }

      if (name === 'start_blank_canvas_problem') {
        const origSend = classDirector.sendClient;
        if (stageSink) {
          classDirector.sendClient = (p) => (p.type?.startsWith('stage_') ? emitStage(p) : sendClient(p));
        }
        try {
          return classDirector.startProblemCanvas(args);
        } finally {
          classDirector.sendClient = origSend;
        }
      }

      if (name === 'append_problem_step') {
        const origSend = classDirector.sendClient;
        if (stageSink) {
          classDirector.sendClient = (p) => (p.type?.startsWith('stage_') ? emitStage(p) : sendClient(p));
        }
        try {
          return classDirector.appendProblemStep(args);
        } finally {
          classDirector.sendClient = origSend;
        }
      }

      if (name === 'return_to_pdf') {
        const origSend = classDirector.sendClient;
        if (stageSink) {
          classDirector.sendClient = (p) => (p.type?.startsWith('stage_') ? emitStage(p) : sendClient(p));
        }
        try {
          return await classDirector.returnToPdf(args);
        } finally {
          classDirector.sendClient = origSend;
        }
      }

      if (name === 'class_progress') {
        return classDirector.handleClassProgress(args);
      }

      if (name === 'draw_live_scene') {
        classDirector.surface = 'canvas';
        const normalized = { ...args, scene_title: args.scene_title || args.title || 'Pizarra en vivo' };
        emitStage({ type: 'stage_live_scene', data: normalized });
        classDirector.emitState();
        return { ok: true, rendered: true, scene_title: normalized.scene_title };
      }

      if (name === 'point_to_stage_element') {
        const resolved = classDirector.resolvePointerTargetOnPdf(args);
        emitStage({ type: 'stage_pointer', data: resolved });
        return { ok: true, pointed: true };
      }

      if (name === 'build_interactive_lab') {
        classDirector.surface = 'canvas';
        emitStage({ type: 'stage_interactive_lab', data: args });
        classDirector.emitState();
        return { ok: true, rendered: true, title: args.title };
      }

      if (name === 'update_lab_parameters') {
        emitStage({ type: 'stage_lab_update', data: args });
        return { ok: true, updated: args.updates };
      }

      if (name === 'write_whiteboard_lesson') {
        classDirector.surface = 'canvas';
        emitStage({ type: 'stage_lesson_card', data: args });
        classDirector.emitState();
        return { ok: true, rendered: true, title: args.title };
      }

      if (name === 'show_active_recall_quiz') {
        emitStage({ type: 'stage_quiz', data: args });
        return { ok: true, displayed: true };
      }

      if (name === 'search_study_materials') {
        sendClient({ type: 'tool_status', label: `Buscando en tus archivos: "${args.query || ''}"...` });
        const result = await library.search({
          query: args.query,
          filename: args.filename,
          page: args.page,
        });
        sendClient({
          type: 'tool_status',
          label: `Encontrados ${result.results?.length || 0} fragmentos para "${args.query || ''}".`,
        });
        return result;
      }

      if (name === 'class_control') {
        const act = String(args.action || '').toLowerCase();
        if (act === 'next_page') return await lookaheadClass.jumpToPage({ delta: +1, startPlaying: true });
        if (act === 'prev_page') return await lookaheadClass.jumpToPage({ delta: -1, startPlaying: true });
        if (act === 'goto_page' && Number(args.page) >= 1) return await lookaheadClass.jumpToPage({ page: Number(args.page), startPlaying: true });
        if (act === 'skip_beat') return lookaheadClass.skipCurrentBeat();
        if (act === 'skip_problem') return await lookaheadClass.skipProblemAndAdvance();
        if (act === 'pause') {
          lookaheadClass.pause('Clase pausada');
          return { ok: true, paused: true };
        }
        if (act === 'resume') {
          await lookaheadClass.resume();
          return { ok: true, resumed: true };
        }
        if (act === 'verify_recover') return await lookaheadClass.verifyAndRecover({ autoFix: true });
        return { ok: false, error: `Unknown class_control action: ${act}` };
      }

      if (name === 'verify_math_python') {
        sendClient({ type: 'tool_status', label: `Verificando en Python: ${args.description || 'cálculo'}...` });
        const result = await verifyMathPython(args.expression_or_code);
        emitStage({
          type: 'stage_math',
          data: {
            description: args.description || 'Python Math Verification',
            code: args.expression_or_code,
            ...result,
          },
        });
        return result;
      }

      return { ok: false, error: `Unknown tool: ${name}` };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  async function executeGeminiToolCall(call) {
    const { id, name, args = {} } = call;
    const rawResult = await executeSharedTool(name, args);

    if (cancelledToolIds.has(id)) {
      cancelledToolIds.delete(id);
      return;
    }

    if (liveSession) {
      try {
        const { visionBase64, ...cleanResult } =
          rawResult && typeof rawResult === 'object' ? rawResult : { result: rawResult };

        if (visionBase64) {
          liveSession.sendRealtimeInput({
            video: { data: visionBase64, mimeType: 'image/jpeg' },
          });
        }

        const fnResponse = { id, name, response: cleanResult };
        if (activeModelInfo?.supportsScheduling) {
          fnResponse.scheduling = SILENT_VISUAL_TOOLS.has(name)
            ? FunctionResponseScheduling.SILENT
            : FunctionResponseScheduling.WHEN_IDLE;
        }
        liveSession.sendToolResponse({
          functionResponses: [fnResponse],
        });
      } catch (err) {
        console.error('[sendToolResponse error]', err);
      }
    }
  }

  async function connectToGemini(sessionOpts, resumeHandle = null) {
    if (!runtimeApiKey) {
      sendClient({
        type: 'error',
        code: 'NO_API_KEY',
        message: 'No GEMINI_API_KEY configured. Click "API Key" in the top bar once to save your Google AI Studio key globally.',
      });
      return;
    }

    const ai = new GoogleGenAI({
      apiKey: runtimeApiKey,
      apiVersion: 'v1beta',
      httpOptions: { apiVersion: 'v1beta' },
    });
    if (ai.apiClient && typeof ai.apiClient.getWebsocketBaseUrl === 'function') {
      const origGetWsBase = ai.apiClient.getWebsocketBaseUrl.bind(ai.apiClient);
      ai.apiClient.getWebsocketBaseUrl = () => origGetWsBase().replace(/\/+$/, '');
    }
    const modelId = normalizeGeminiLiveModelId(sessionOpts.model);
    const modelInfo = AVAILABLE_MODELS.find((m) => m.id === modelId) || AVAILABLE_MODELS[0];
    activeModelInfo = modelInfo;
    cancelledToolIds.clear();
    insideLeakedSvg = false;
    svgCaptureBuffer = '';
    const catalogSummary = await library.getActiveCatalogSummary();
    const systemText = buildSystemInstruction({
      mode: sessionOpts.mode || 'folder_expert',
      language: sessionOpts.language || 'auto',
      catalogSummary,
      customContext: sessionOpts.topic ? `Student's requested focus: ${sessionOpts.topic}` : '',
      classModeActive: sessionOpts.mode === 'continuous_class',
    });

    const config = {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: sessionOpts.voice || 'Fenrir',
          },
        },
      },
      systemInstruction: {
        parts: [{ text: systemText }],
      },
      tools: getProfessorToolDeclarations(),
      realtimeInputConfig: {
        automaticActivityDetection: {
          startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
          endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
          prefixPaddingMs: 300,
          silenceDurationMs: 950,
        },
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: {
        slidingWindow: {},
      },
      sessionResumption: resumeHandle ? { handle: resumeHandle } : {},
    };

    if (modelInfo.supportsThinking) {
      config.thinkingConfig = {
        thinkingLevel: sessionOpts.thinkingLevel || 'medium',
      };
    }

    sendClient({
      type: 'status',
      state: 'connecting',
      text: resumeHandle ? 'Resuming live session...' : `Connecting to ${modelId}...`,
    });

    try {
      liveSession = await ai.live.connect({
        model: modelId,
        config,
        callbacks: {
          onopen: () => {
            reconnecting = false;
            sendClient({
              type: 'session_started',
              engine: 'gemini',
              model: modelId,
              voice: sessionOpts.voice || 'Fenrir',
              resumed: Boolean(resumeHandle),
              folderName: library.domainProfile?.folderName || path.basename(TARGET_DIR),
            });
          },
          onmessage: (msg) => {
            if (msg.sessionResumptionUpdate?.newHandle) {
              resumptionHandle = msg.sessionResumptionUpdate.newHandle;
            }

            if (msg.goAway) {
              sendClient({ type: 'tool_status', label: 'Refreshing live connection seamlessly...' });
              if (!reconnecting && resumptionHandle && !closedByUser) {
                reconnecting = true;
                try {
                  liveSession?.close();
                } catch {}
                setTimeout(() => {
                  if (!closedByUser && activeConfig) {
                    connectToGemini(activeConfig, resumptionHandle);
                  }
                }, 300);
              }
            }

            if (msg.interactionStatus) {
              sendClient({ type: 'interaction_status', status: msg.interactionStatus });
            }

            if (msg.toolCallCancellation?.ids?.length) {
              for (const cid of msg.toolCallCancellation.ids) {
                cancelledToolIds.add(cid);
              }
            }

            const sc = msg.serverContent;
            if (sc) {
              if (sc.interrupted) {
                insideLeakedSvg = false;
                svgCaptureBuffer = '';
                classDirector.onUserInterrupt();
                sendClient({ type: 'interrupted' });
              }
              if (sc.modelTurn?.parts) {
                for (const part of sc.modelTurn.parts) {
                  if (part.inlineData?.data) {
                    classDirector.onAudioChunkDispatched();
                    sendClient({
                      type: 'audio_out',
                      data: part.inlineData.data,
                      mimeType: part.inlineData.mimeType || 'audio/pcm;rate=24000',
                    });
                  }
                  if (part.text && !part.thought) {
                    handleOutputTranscriptChunk(part.text);
                  }
                }
              }
              if (sc.inputTranscription?.text) {
                if (classDirector.active && !classDirector.qaPaused) {
                  classDirector.onUserInterrupt();
                }
                sendClient({ type: 'input_transcript', text: sc.inputTranscription.text });
              }
              if (sc.outputTranscription?.text) {
                handleOutputTranscriptChunk(sc.outputTranscription.text);
              }
              if (sc.turnComplete) {
                insideLeakedSvg = false;
                svgCaptureBuffer = '';
                sendClient({ type: 'turn_complete' });
                classDirector.onTurnComplete();
              }
            }

            if (msg.toolCall?.functionCalls?.length) {
              for (const call of msg.toolCall.functionCalls) {
                executeGeminiToolCall(call);
              }
            }
          },
          onerror: (err) => {
            console.error('[Gemini Live error]', err);
            sendClient({ type: 'error', message: err?.message || 'Gemini Live connection error' });
          },
          onclose: (evt) => {
            liveSession = null;
            if (!closedByUser && !reconnecting) {
              classDirector.stop();
              sendClient({ type: 'session_closed', reason: evt?.reason || 'Live session closed' });
            }
          },
        },
      });
    } catch (err) {
      console.error('[connectToGemini failed]', err);
      sendClient({
        type: 'error',
        message: `Failed to connect to ${modelId}: ${err?.message || err}.`,
      });
    }
  }

  clientWs.on('message', async (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }

    if (msg.type === 'start') {
      closedByUser = false;
      resumptionHandle = null;
      activeConfig = msg.config || {};
      activeEngine = activeConfig.engine === 'gemini' ? 'gemini' : 'local';
      classDirector.stop();
      lookaheadClass.stop();

      if (liveSession) {
        try { liveSession.close(); } catch {}
        liveSession = null;
      }
      if (localSession) {
        localSession.interrupt();
        localSession = null;
      }

      if (activeEngine === 'local') {
        const ollama = await getOllamaStatus();
        if (!ollama.running) {
          sendClient({
            type: 'error',
            message: 'Ollama no está activo en localhost:11434. Ábrelo con `ollama serve` (o abre la app Ollama) e inténtalo de nuevo.',
          });
          return;
        }
        const chosenModel = activeConfig.localModel || ollama.models[0]?.name || 'gemma4:12b';
        localSession = new LocalProfessorSession({
          config: { ...activeConfig, localModel: chosenModel },
          library,
          voiceEngine,
          sendClient,
          executeSharedTool,
          classDirector,
        });
        await localSession.init();
        sendClient({
          type: 'session_started',
          engine: 'local',
          model: chosenModel,
          voice: activeConfig.localVoice || 'kokoro:em_alex',
          resumed: false,
          folderName: library.domainProfile?.folderName || path.basename(TARGET_DIR),
        });
        return;
      }

      await connectToGemini(activeConfig, null);
      return;
    }

    if (msg.type === 'stop') {
      closedByUser = true;
      classDirector.stop();
      lookaheadClass.stop();
      if (liveSession) {
        try { liveSession.close(); } catch {}
        liveSession = null;
      }
      if (localSession) {
        localSession.interrupt();
        localSession = null;
      }
      sendClient({ type: 'session_closed', reason: 'Stopped by user' });
      return;
    }

    // ---------- Synchronized Lookahead Classroom Controls & Recovery Tools ----------
    if (msg.type === 'timeline_event') {
      lookaheadClass.onClientTimelineEvent(msg);
      return;
    }

    if (msg.type === 'timeline_health_check') {
      lookaheadClass.onClientHealthCheck(msg);
      return;
    }

    if (msg.type === 'class_skip_beat') {
      lookaheadClass.skipCurrentBeat();
      return;
    }

    if (msg.type === 'class_skip_problem') {
      await lookaheadClass.skipProblemAndAdvance();
      return;
    }

    if (msg.type === 'class_verify_recover') {
      await lookaheadClass.verifyAndRecover({ autoFix: true });
      return;
    }

    if (msg.type === 'audio_drained') {
      classDirector.onClientAudioDrained();
      return;
    }

    if (msg.type === 'class_start') {
      if (localSession) localSession.interrupt();
      await lookaheadClass.startClass({
        pdfId: msg.pdfId,
        filename: msg.filename,
        startPage: msg.startPage,
        startTopic: msg.startTopic,
      });
      return;
    }

    if (msg.type === 'class_pause') {
      lookaheadClass.pause('Clase pausada por el alumno');
      if (activeEngine === 'local' && localSession) {
        localSession.interrupt();
      }
      return;
    }

    if (msg.type === 'class_resume') {
      if (localSession) localSession.interrupt();
      await lookaheadClass.resume();
      return;
    }

    if (msg.type === 'clear_pdf_annotations') {
      lookaheadClass.clearAnnotationsFor(msg.docId, msg.page);
      classDirector.clearAnnotationsFor(msg.docId, msg.page);
      return;
    }

    if (msg.type === 'class_nav_page') {
      if (lookaheadClass.active || lookaheadClass.pdfDoc) {
        if (localSession) localSession.interrupt();
        await lookaheadClass.jumpToPage({
          docId: msg.docId,
          filename: msg.filename,
          page: msg.page,
          delta: msg.delta,
          startPlaying: Boolean(msg.explainNow || (lookaheadClass.active && !lookaheadClass.paused && !lookaheadClass.qaPaused)),
        });
        return;
      }
      const opened = await classDirector.openPage({
        docId: msg.docId,
        filename: msg.filename,
        page: msg.page,
        delta: msg.delta,
        reason: msg.reason || 'Navegación manual del alumno',
      });
      if (opened.ok && activeEngine === 'local' && localSession) {
        localSession.messages.push({
          role: 'user',
          content: `[Navegación del alumno] El alumno ha pasado a la Página ${opened.page}/${opened.totalPages} de "${opened.filename}". Texto de la página:\n${opened.pageText.slice(0, 1800)}`,
          ...(opened.visionBase64 && localSession.modelSupportsVision ? { images: [opened.visionBase64] } : {}),
        });
      } else if (opened.ok && activeEngine === 'gemini' && liveSession) {
        if (opened.visionBase64) {
          liveSession.sendRealtimeInput({ video: { data: opened.visionBase64, mimeType: 'image/jpeg' } });
        }
        liveSession.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: `[Alumno movió el PDF a la Página ${opened.page}/${opened.totalPages} de "${opened.filename}"]` }] }],
          turnComplete: false,
        });
      }
      return;
    }

    // ---------- Local Ollama Engine Routing ----------
    if (activeEngine === 'local' && localSession) {
      if (msg.type === 'text' && msg.text) {
        const cmdRes = await handleClassVoiceCommand(msg.text);
        if (cmdRes.handled) return;
        let promptForModel = msg.text;
        if (lookaheadClass.active) {
          lookaheadClass.pauseForQuestion();
          // Give Q&A model exact context of ONLY what the student has already heard up to this second!
          const bundle = await pdfStage.getPageBundle(lookaheadClass.pdfDoc, lookaheadClass.playedPage, {
            includeVision: localSession.modelSupportsVision,
          });
          if (bundle.visionBase64 && localSession.modelSupportsVision) {
            localSession.addPendingImage(bundle.visionBase64);
          }
          await classDirector.openPage({ docId: lookaheadClass.pdfId, page: lookaheadClass.playedPage, emit: false, includeVision: false });
          promptForModel = `[CONTEXTO ACTUAL DE CLASE — ${lookaheadClass.getPlayedContextSummary()}]\nTexto de la Página ${bundle.page}:\n${bundle.text.slice(0, 1400)}\n\nPREGUNTA DEL ALUMNO: ${msg.text}`;
        }
        localSession.handleUserMessage(promptForModel, { alreadyLogged: Boolean(msg.alreadyLogged) });
      } else if (msg.type === 'local_audio_turn' && msg.data) {
        sendClient({ type: 'tool_status', label: 'Transcribiendo voz en local (mlx-whisper)...' });
        const stt = await voiceEngine.transcribePcm16(msg.data, { language: activeConfig?.language || 'auto' });
        if (stt.ok && stt.text) {
          sendClient({ type: 'input_transcript', text: stt.text });
          const cmdRes = await handleClassVoiceCommand(stt.text);
          if (cmdRes.handled) return;
          let promptForModel = stt.text;
          if (lookaheadClass.active) {
            lookaheadClass.pauseForQuestion();
            const bundle = await pdfStage.getPageBundle(lookaheadClass.pdfDoc, lookaheadClass.playedPage, {
              includeVision: localSession.modelSupportsVision,
            });
            if (bundle.visionBase64 && localSession.modelSupportsVision) {
              localSession.addPendingImage(bundle.visionBase64);
            }
            await classDirector.openPage({ docId: lookaheadClass.pdfId, page: lookaheadClass.playedPage, emit: false, includeVision: false });
            promptForModel = `[CONTEXTO ACTUAL DE CLASE — ${lookaheadClass.getPlayedContextSummary()}]\nTexto de la Página ${bundle.page}:\n${bundle.text.slice(0, 1400)}\n\nPREGUNTA DEL ALUMNO: ${stt.text}`;
          }
          localSession.handleUserMessage(promptForModel, { alreadyLogged: true });
        } else {
          sendClient({ type: 'tool_status', label: stt.error || 'No se detectó voz clara.' });
        }
      } else if (msg.type === 'video_frame' && msg.data) {
        localSession.addPendingImage(msg.data);
      } else if (msg.type === 'lab_event' && msg.summary) {
        localSession.messages.push({ role: 'user', content: `[Interactive Lab Update] ${msg.summary}` });
      } else if (msg.type === 'quiz_answer') {
        const summary = `He respondido a la pregunta "${msg.question}" eligiendo "${msg.chosenOption}" (${msg.isCorrect ? 'ACERTÉ' : 'FALLÉ'}). Coméntame brevemente en voz alta por qué.`;
        localSession.handleUserMessage(summary, { alreadyLogged: true });
      } else if (msg.type === 'interrupt') {
        lookaheadClass.pauseForQuestion();
        classDirector.onUserInterrupt();
        localSession.interrupt();
      }
      return;
    }

    if (!liveSession) return;

    try {
      if (msg.type === 'audio_in' && msg.data) {
        liveSession.sendRealtimeInput({
          audio: { data: msg.data, mimeType: 'audio/pcm;rate=16000' },
        });
      } else if (msg.type === 'audio_end') {
        liveSession.sendRealtimeInput({ audioStreamEnd: true });
      } else if (msg.type === 'video_frame' && msg.data) {
        liveSession.sendRealtimeInput({
          video: { data: msg.data, mimeType: msg.mimeType || 'image/jpeg' },
        });
      } else if (msg.type === 'text' && msg.text) {
        const cmdRes = await handleClassVoiceCommand(msg.text);
        if (cmdRes.handled) return;
        let textOut = String(msg.text);
        if (lookaheadClass.active) {
          lookaheadClass.pauseForQuestion();
          textOut = `[${lookaheadClass.getPlayedContextSummary()}]\nPregunta del alumno: ${textOut}`;
        }
        liveSession.sendRealtimeInput({ text: textOut });
      } else if (msg.type === 'lab_event' && msg.summary) {
        liveSession.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: `[Interactive Lab Update] ${msg.summary}` }] }],
          turnComplete: false,
        });
      } else if (msg.type === 'quiz_answer') {
        const summary = `[Student answered "${msg.question}": picked "${msg.chosenOption}" (${msg.isCorrect ? 'CORRECT' : 'INCORRECT'}). React briefly aloud.]`;
        liveSession.sendRealtimeInput({ text: summary });
      } else if (msg.type === 'interrupt') {
        lookaheadClass.pauseForQuestion();
        classDirector.onUserInterrupt();
        liveSession.sendClientContent({
          turns: [{ role: 'user', parts: [{ text: 'Espera un segundo, tengo una pregunta.' }] }],
          turnComplete: true,
        });
      }
    } catch (err) {
      console.error('[Forward to Gemini error]', err);
      sendClient({ type: 'error', message: err.message });
    }
  });

  clientWs.on('close', () => {
    closedByUser = true;
    classDirector.stop();
    lookaheadClass.stop();
    if (liveSession) {
      try { liveSession.close(); } catch {}
      liveSession = null;
    }
    if (localSession) {
      localSession.interrupt();
      localSession = null;
    }
  });
});

function listenWithFallback(startPort, maxTries = 15) {
  let attempt = 0;
  const tryListen = (p) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE' && attempt < maxTries) {
        attempt++;
        tryListen(p + 1);
      } else {
        console.error('[Server listen error]', err);
        process.exit(1);
      }
    });
    server.listen(p, '127.0.0.1', () => {
      const url = `http://localhost:${p}`;
      const dp = library.domainProfile;
      const memGb = Math.round(os.totalmem() / 1024 ** 3);
      const cpuBrand = os.cpus()?.[0]?.model || 'Apple Silicon';
      const loadedGpuStr = initialGpuPs.length
        ? initialGpuPs.map((m) => `${m.name} (${m.gpuPct}% GPU · ${m.vramGb} GB)`).join(', ')
        : 'MLX Metal GPU on demand (100% GPU)';
      console.log(`\n🎓  Speaking AI Professor — Live Classroom Stage (PDF + Precision CAD Board + Local $0)`);
      console.log(`🌐  URL:      ${url}`);
      console.log(`📂  Folder:   ${dp?.workspaceRoot || TARGET_DIR}`);
      console.log(`🧠  Expert:   ${dp?.folderName || path.basename(TARGET_DIR)} (${dp?.activeFiles || 0}/${dp?.totalFiles || 0} study files indexed)`);
      console.log(`⚡  GPU/UMA:  ${cpuBrand} · ${memGb} GB UMA · ${loadedGpuStr} · Disk Lesson Cache ON`);
      console.log(`💻  Local:    Ollama ${initialOllama.running ? `running (${initialOllama.models.map((m) => m.name).join(', ') || 'no models'})` : 'offline'}`);
      console.log(`🔊  TTS/STT:  Kokoro=${voiceCaps.kokoro ? 'READY (Metal GPU · 256MB cache cap)' : 'fallback macOS'} · mlx-whisper=${voiceCaps.whisper ? 'READY' : 'browser STT'}`);
      console.log(`☁️   Cloud:    GEMINI_API_KEY ${runtimeApiKey ? 'configured' : 'optional (not needed in Local mode)'}\n`);
      if (cli.open) {
        execFile('open', [url], () => {});
      }
    });
  };
  tryListen(startPort);
}

listenWithFallback(PORT);
