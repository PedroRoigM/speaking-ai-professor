/**
 * Speaking AI Professor — Mobile Edition (Strictly Gemini Cloud · Zero Local Models)
 * Reuses the exact deterministic 12-template parametric SVG chalkboard & Unicode math compiler.
 */
import {
  BLUEPRINT_TEMPLATES,
  buildParametricBlueprintSvg,
  renderMathExpressionHtml,
  formatInlineMathHtml,
} from './vendor/stageRenderer.js';

const $ = (id) => document.getElementById(id);

const STORAGE_KEY = 'sap_mobile_settings_v1';
const GEMINI_INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions';

const ALLOWED_CLOUD_MODELS = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-4-hydrogen'];

const DEFAULT_SETTINGS = {
  apiKey: '',
  model: 'gemini-3.5-flash',
  language: 'es',
  rate: 1.0,
  theme: 'warm',
  muted: false,
};

function loadSettings() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    const merged = { ...DEFAULT_SETTINGS, ...raw };
    if (!ALLOWED_CLOUD_MODELS.includes(merged.model)) {
      merged.model = DEFAULT_SETTINGS.model;
    }
    return merged;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

const state = {
  settings: loadSettings(),
  pdfjs: null,
  pdfDoc: null,
  pdfName: '',
  totalPages: 0,
  currentPage: 1,
  isDemoMode: false,

  // Playback / Class Engine
  playing: false,
  paused: false,
  generationId: 0,
  pagePlanCache: new Map(),
  inFlightPlans: new Map(),
  activeBoard: null,
  currentPageText: '',
  currentPageImageB64: '',
  speechAbort: null,
  micActive: false,
  recognition: null,
};

// ---------------- Toast & UI Helpers ----------------
let toastTimer = null;
function showToast(msg, ms = 3200) {
  const el = $('toastEl');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, ms);
}

function setCaption(role, text) {
  $('captionRole').textContent = role;
  $('captionText').textContent = text;
}

function setLiveDot(mode) {
  const dot = $('liveDot');
  dot.classList.remove('speaking', 'thinking');
  if (mode === 'speaking') dot.classList.add('speaking');
  else if (mode === 'thinking') dot.classList.add('thinking');
}

function setKeepScreenOn(on) {
  try {
    window.AndroidNativeUI?.setKeepScreenOn?.(Boolean(on));
  } catch {}
}

function applyTheme(theme) {
  const valid = ['warm', 'sepia', 'slate'].includes(theme) ? theme : 'warm';
  document.documentElement.setAttribute('data-theme', valid);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    meta.setAttribute('content', valid === 'slate' ? '#11161F' : valid === 'sepia' ? '#F3EAD8' : '#F7F5F0');
  }
  document.querySelectorAll('#themePills .m-pill').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.theme === valid);
  });
}

function updateTopCloudPill() {
  const shortModel = state.settings.model.replace('gemini-', '');
  const hasKey = Boolean(state.settings.apiKey.trim());
  $('cloudPill').textContent = hasKey ? `☁️ Gemini ${shortModel}` : '☁️ Gemini Cloud · Falta API Key';
  const banner = $('apiKeyPromptBanner');
  if (banner) {
    banner.style.display = hasKey ? 'none' : 'flex';
  }
}

function syncTransportUi() {
  const hasDoc = Boolean(state.pdfDoc || state.isDemoMode);
  const playBtn = $('playPauseBtn');
  playBtn.disabled = !hasDoc;
  if (state.playing && !state.paused) {
    playBtn.textContent = '⏸ Pausar';
    playBtn.className = 'm-btn m-btn-amber m-btn-play';
  } else if (state.paused) {
    playBtn.textContent = '▶ Reanudar';
    playBtn.className = 'm-btn m-btn-emerald m-btn-play';
  } else {
    playBtn.textContent = '▶ Dar clase';
    playBtn.className = 'm-btn m-btn-emerald m-btn-play';
  }

  $('prevPageBtn').disabled = !hasDoc || state.currentPage <= 1;
  $('nextPageBtn').disabled = !hasDoc || state.currentPage >= state.totalPages;
  $('pageJumpBtn').disabled = !hasDoc || state.totalPages <= 1;
  $('pageJumpBtn').textContent = hasDoc ? `Pág ${state.currentPage}/${state.totalPages}` : 'Pág — / —';
  $('skipBeatBtn').disabled = !(state.playing && !state.paused);
  $('muteVoiceBtn').textContent = state.settings.muted ? '🔇' : '🔊';
  $('muteVoiceBtn').title = state.settings.muted ? 'Voz silenciada' : 'Voz activada';
}

// ---------------- Native Android TTS + Web Speech + Silent Fallback ----------------
let ttsCounter = 1;
const pendingNativeTts = new Map();

window.__onAndroidTtsDone = (uttId) => {
  const resolver = pendingNativeTts.get(String(uttId));
  if (resolver) {
    pendingNativeTts.delete(String(uttId));
    resolver();
  }
};

window.__onAndroidTtsError = (uttId) => {
  const resolver = pendingNativeTts.get(String(uttId));
  if (resolver) {
    pendingNativeTts.delete(String(uttId));
    resolver();
  }
};

function stopAllSpeech() {
  try {
    window.AndroidNativeTTS?.stop?.();
  } catch {}
  try {
    window.speechSynthesis?.cancel?.();
  } catch {}
  for (const resolve of pendingNativeTts.values()) {
    try { resolve(); } catch {}
  }
  pendingNativeTts.clear();
  if (state.speechAbort) {
    const abortFn = state.speechAbort;
    state.speechAbort = null;
    abortFn();
  }
  setLiveDot('idle');
}

function estimateReadingMs(text, rate = 1.0) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean).length;
  return Math.max(2200, Math.min(18000, Math.round((words / 2.65) * (1000 / Math.max(0.7, rate)))));
}

function speakText(text) {
  const clean = String(text || '')
    .replace(/[*_`#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return Promise.resolve();

  const langCode = state.settings.language === 'en' ? 'en-US' : 'es-ES';
  const rate = Number(state.settings.rate) || 1.0;

  if (state.settings.muted) {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        state.speechAbort = null;
        resolve();
      };
      const timer = setTimeout(finish, estimateReadingMs(clean, rate));
      state.speechAbort = finish;
    });
  }

  // 1. Prefer Native Android TextToSpeech Bridge (100% reliable on all Android devices!)
  if (window.AndroidNativeTTS && typeof window.AndroidNativeTTS.speak === 'function') {
    return new Promise((resolve) => {
      const uttId = `utt-${ttsCounter++}`;
      let done = false;
      const maxWait = estimateReadingMs(clean, rate) + 12000;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(failsafe);
        pendingNativeTts.delete(uttId);
        state.speechAbort = null;
        setLiveDot('idle');
        resolve();
      };
      const failsafe = setTimeout(finish, maxWait);
      pendingNativeTts.set(uttId, finish);
      state.speechAbort = () => {
        try { window.AndroidNativeTTS.stop(); } catch {}
        finish();
      };
      setLiveDot('speaking');
      try {
        window.AndroidNativeTTS.speak(uttId, clean, langCode, rate);
      } catch {
        finish();
      }
    });
  }

  // 2. Web Speech API fallback (desktop preview / Chrome)
  if ('speechSynthesis' in window && typeof SpeechSynthesisUtterance !== 'undefined') {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(failsafe);
        state.speechAbort = null;
        setLiveDot('idle');
        resolve();
      };
      const failsafe = setTimeout(finish, estimateReadingMs(clean, rate) + 10000);
      state.speechAbort = () => {
        try { window.speechSynthesis.cancel(); } catch {}
        finish();
      };
      const utt = new SpeechSynthesisUtterance(clean);
      utt.lang = langCode;
      utt.rate = rate;
      utt.onend = finish;
      utt.onerror = finish;
      setLiveDot('speaking');
      try {
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(utt);
      } catch {
        finish();
      }
    });
  }

  // 3. Pure subtitle reading timer fallback
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, estimateReadingMs(clean, rate));
    state.speechAbort = () => {
      clearTimeout(timer);
      resolve();
    };
  });
}

// ---------------- PDF.js Local Document Engine ----------------
async function ensurePdfjs() {
  if (!state.pdfjs) {
    const mod = await import('./vendor/pdfjs/pdf.min.mjs');
    const lib = mod?.getDocument ? mod : mod?.default || mod;
    if (lib?.GlobalWorkerOptions) {
      lib.GlobalWorkerOptions.workerSrc = './vendor/pdfjs/pdf.worker.min.mjs';
    }
    state.pdfjs = lib;
  }
  return state.pdfjs;
}

async function openPdfFile(file) {
  if (!file) return;
  stopClass();
  state.isDemoMode = false;
  state.pagePlanCache.clear();
  state.inFlightPlans.clear();

  try {
    showToast(`Cargando ${file.name}...`, 2200);
    const pdfjs = await ensurePdfjs();
    const buf = await file.arrayBuffer();
    const doc = await pdfjs.getDocument({ data: new Uint8Array(buf) }).promise;
    state.pdfDoc = doc;
    state.pdfName = file.name;
    state.totalPages = doc.numPages || 1;
    state.currentPage = 1;

    $('pdfEmptyState').hidden = true;
    $('pdfCanvas').hidden = false;
    $('pdfFileLabel').textContent = file.name;

    await renderPdfPage(1);
    setCaption('Profesor', `Documento cargado (${state.totalPages} págs.). Pulsa «▶ Dar clase» para empezar.`);
    syncTransportUi();
  } catch (err) {
    console.error('[PDF load error]', err);
    showToast(`No se pudo abrir el PDF: ${err.message || err}`);
  }
}

async function extractPdfPageContext(pageNum) {
  if (state.isDemoMode) {
    return {
      text: 'Sensibilidad a la carga vertical del neumático: μ_constante vs μ_real frente a F_z. En un bloque rígido μ es constante, pero en el caucho viscoelástico μ_real desciende al aumentar la carga vertical F_z.',
      imageB64: '',
      needsVision: false,
    };
  }
  if (!state.pdfDoc) return { text: '', imageB64: '', needsVision: false };

  const clamped = Math.max(1, Math.min(state.totalPages, pageNum));
  const page = await state.pdfDoc.getPage(clamped);
  const tc = await page.getTextContent();
  let lastY = null;
  let text = '';
  for (const item of tc.items || []) {
    if (!('str' in item)) continue;
    const y = Array.isArray(item.transform) ? item.transform[5] : null;
    if (lastY !== null && y !== null && Math.abs(y - lastY) > 4) text += '\n';
    else if (text && !text.endsWith(' ') && !text.endsWith('\n')) text += ' ';
    text += item.str;
    lastY = y;
  }
  text = text.trim();

  // Render an offscreen JPEG snapshot for multimodal vision when slide has sparse text or diagrams
  const needsVision =
    text.length < 320 || /(figura|gr[aá]fic|curva|diagrama|esquema|tabla|eje|figure|graph|chart)/i.test(text);
  let imageB64 = '';
  if (needsVision) {
    try {
      const vp0 = page.getViewport({ scale: 1 });
      const scale = Math.min(1.6, 920 / Math.max(vp0.width, vp0.height, 1));
      const vp = page.getViewport({ scale });
      const off = document.createElement('canvas');
      off.width = Math.round(vp.width);
      off.height = Math.round(vp.height);
      const ctx = off.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, off.width, off.height);
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
      const dataUrl = off.toDataURL('image/jpeg', 0.72);
      imageB64 = dataUrl.split(',')[1] || '';
    } catch {}
  }

  return { text, imageB64, needsVision: Boolean(imageB64) };
}

async function renderPdfPage(pageNum) {
  if (!state.pdfDoc) return;
  const clamped = Math.max(1, Math.min(state.totalPages, pageNum));
  state.currentPage = clamped;

  const page = await state.pdfDoc.getPage(clamped);
  const vp0 = page.getViewport({ scale: 1 });
  const targetWidth = Math.min(1200, Math.max(640, (window.innerWidth || 400) * Math.min(2, window.devicePixelRatio || 1.5)));
  const scale = targetWidth / Math.max(1, vp0.width);
  const vp = page.getViewport({ scale });

  const canvas = $('pdfCanvas');
  canvas.width = Math.round(vp.width);
  canvas.height = Math.round(vp.height);
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;

  $('pdfBadge').textContent = `Proyector PDF · Pág. ${clamped}/${state.totalPages}`;
  syncTransportUi();

  const ctxData = await extractPdfPageContext(clamped);
  state.currentPageText = ctxData.text;
  state.currentPageImageB64 = ctxData.imageB64;
}

// ---------------- Animated Parametric Chalkboard ----------------
function animateSvgStrokes(svgEl) {
  if (!svgEl) return;
  const els = svgEl.querySelectorAll('[data-pen="1"]');
  els.forEach((el, idx) => {
    try {
      const len = typeof el.getTotalLength === 'function' ? el.getTotalLength() : 0;
      if (len > 4) {
        el.style.strokeDasharray = `${len}`;
        el.style.strokeDashoffset = `${len}`;
        el.style.transition = 'none';
        requestAnimationFrame(() => {
          el.style.transition = `stroke-dashoffset ${Math.min(900, 320 + idx * 70)}ms cubic-bezier(0.22, 1, 0.36, 1) ${idx * 80}ms`;
          el.style.strokeDashoffset = '0';
        });
      }
    } catch {}
  });
}

function renderChalkboard(board) {
  if (!board || board.action === 'none') return;
  const action = String(board.action || 'new').toLowerCase();
  const tplKey = String(board.template || state.activeBoard?.template || '').toLowerCase();
  if (!tplKey || !BLUEPRINT_TEMPLATES[tplKey]) return;

  if (action === 'append' && state.activeBoard && state.activeBoard.template === tplKey) {
    const mergedLayers = new Set([...(state.activeBoard.layers || []), ...(board.add_layers || board.layers || [])]);
    state.activeBoard = {
      ...state.activeBoard,
      layers: [...mergedLayers],
      center: board.center || state.activeBoard.center || null,
      nodes: board.nodes || state.activeBoard.nodes || null,
      steps: board.steps || state.activeBoard.steps || null,
      left: board.left || state.activeBoard.left || null,
      right: board.right || state.activeBoard.right || null,
      takeaway: board.takeaway || state.activeBoard.takeaway || '',
      formula: board.formula || state.activeBoard.formula || '',
      note: board.note || state.activeBoard.note || '',
    };
  } else {
    state.activeBoard = {
      template: tplKey,
      title: board.title || 'Pizarra Esquemática',
      mode: board.mode || '',
      layers: Array.isArray(board.layers) && board.layers.length ? board.layers : BLUEPRINT_TEMPLATES[tplKey].defaultOrder,
      xLabel: board.xLabel || '',
      yLabel: board.yLabel || '',
      curves: board.curves || null,
      center: board.center || null,
      nodes: board.nodes || null,
      steps: board.steps || null,
      left: board.left || null,
      right: board.right || null,
      takeaway: board.takeaway || '',
      formula: board.formula || '',
      note: board.note || '',
    };
  }

  const b = state.activeBoard;
  const svgMarkup = buildParametricBlueprintSvg(b.title, b.template, b, b.layers);
  const mount = $('boardMount');
  mount.innerHTML = svgMarkup;
  animateSvgStrokes(mount.querySelector('svg'));

  $('boardTitle').textContent = b.title || 'Pizarra Esquemática';
  $('boardStatus').textContent = `${b.layers.length} capa(s) dibujadas`;

  const notesEl = $('boardNotes');
  const noteParts = [];
  if (b.note) noteParts.push(`<div>${formatInlineMathHtml(b.note)}</div>`);
  if (b.formula) noteParts.push(`<div class="wb-formula">${renderMathExpressionHtml(b.formula)}</div>`);
  if (noteParts.length) {
    notesEl.innerHTML = noteParts.join('');
    notesEl.hidden = false;
  } else {
    notesEl.hidden = true;
  }
}

// ---------------- Domain-Adaptive Guardrails (Zero Off-Topic Car Drawings!) ----------------
const UNIVERSAL_TEMPLATES = new Set(['concept_map', 'timeline_flow', 'comparison', 'xy_graph']);
const PHYSICS_ONLY_TEMPLATES = new Set(['force_balance', 'inertia_body']);
const VEHICLE_DOMAIN_RE =
  /\b(veh[ií]cul\w*|neum[aá]tic\w*|suspensi[oó]n\w*|chasis|aerodin[aá]mic\w*|downforce|batalla|gui[ñn]ada|balanceo|cabeceo|pacejka|ackermann|camber|oversteer|understeer|motorsport|automovil\w*|din[aá]mica\s+(?:de\s+)?veh|gt3|roll\s*center|slip\s*angle|friction\s*circle|quarter\s*car)\b/i;
const PHYSICS_DOMAIN_RE =
  /\b(fuerza\s+neta|ley\s+de\s+newton|aceleraci[oó]n|momento\s+de\s+inercia|teorema\s+de\s+steiner|torque|energ[ií]a\s+cin[eé]tica|rozamiento|fricci[oó]n|plano\s+inclinado|cinem[aá]tica|din[aá]mica|termodin[aá]mica|mec[aá]nica\s+cl[aá]sica)\b/i;

function detectMobileDomain(fileName, text) {
  const probe = `${fileName || ''}\n${text || ''}`;
  if (VEHICLE_DOMAIN_RE.test(probe)) return 'vehicle';
  if (PHYSICS_DOMAIN_RE.test(probe)) return 'physics';
  return 'general';
}

function sanitizeMobileBoard(board, domain, fallbackTitle) {
  if (!board || typeof board !== 'object' || board.action === 'none') return board;
  const tpl = String(board.template || '').toLowerCase().trim();
  if (!tpl) return board;
  const allowed =
    UNIVERSAL_TEMPLATES.has(tpl) ||
    domain === 'vehicle' ||
    (domain === 'physics' && PHYSICS_ONLY_TEMPLATES.has(tpl));
  if (allowed) return board;
  const title = String(board.title || fallbackTitle || 'Ideas clave').trim();
  const note = String(board.note || '').trim();
  return {
    ...board,
    template: 'concept_map',
    layers: ['center', 'nodes', ...(note ? ['takeaway'] : [])],
    center: { title: title.slice(0, 42), subtitle: '' },
    nodes: [
      { title: 'Idea clave', detail: (note || title).slice(0, 84), color: 'cyan' },
      { title: 'Contexto del pasaje', detail: title.slice(0, 84), color: 'amber' },
    ],
    takeaway: note.slice(0, 68),
  };
}

// ---------------- Cloud-Only Gemini Interactions API Client ----------------
const GENERAL_PROMPT_ES = `Eres un Profesor Catedrático universitario apasionado y claro dando clase en un AULA DE DOBLE PANTALLA (adapta tu tono 100 % a la materia real del documento: literatura, historia, biología, medicina, derecho, economía, filosofía, etc.).
Elige ÚNICAMENTE UNA de estas 4 plantillas universales en "board.template" (o "action":"none" si es portada pura):
1. "concept_map" -> MAPA CONCEPTUAL RADIAL: center:{title,subtitle}, nodes:[{title,detail,color:"cyan"|"amber"|"emerald"|"rose"}] (2-4 nodos), takeaway (layers: center, nodes, takeaway)
2. "timeline_flow" -> LÍNEA TEMPORAL / SECUENCIA: steps:[{badge,title,detail,color}] (3-4 pasos), takeaway (layers: base, steps, takeaway)
3. "comparison" -> COMPARATIVA 2 COLUMNAS: left:{title,color,points:[...]}, right:{title,color,points:[...]}, takeaway (layers: left, right, takeaway)
4. "xy_graph" -> GRÁFICA X-Y (SOLO si la página tiene una gráfica cuantitativa real)
REGLAS ESTRICTAS:
- Fidelidad absoluta a ESTA página: JAMÁS metas ejemplos de coches, competición ni temas ajenos al PDF. Deja "formula":"" si no hay ecuación.
- Construye 3 beats naturales (2-3 frases habladas en español en "say", cero Markdown, cero coletillas).
- Devuelve ÚNICAMENTE JSON válido:
{"beats":[{"say":"...","board":{"action":"new","template":"concept_map","title":"...","layers":["center","nodes"],"center":{"title":"...","subtitle":""},"nodes":[{"title":"...","detail":"...","color":"cyan"},{"title":"...","detail":"...","color":"amber"}],"takeaway":"...","formula":"","note":"..."}}]}`;

const GENERAL_PROMPT_EN = `You are an engaging university professor teaching live in a DUAL-SCREEN CLASSROOM (adapt 100% to the document's real subject: literature, history, medicine, law, biology, economics, CS, etc.).
Pick ONLY ONE of these 4 universal templates in "board.template" (or "action":"none" for bare covers):
1. "concept_map" (center:{title,subtitle}, nodes:[{title,detail,color}], takeaway; layers: center, nodes, takeaway)
2. "timeline_flow" (steps:[{badge,title,detail,color}], takeaway; layers: base, steps, takeaway)
3. "comparison" (left:{title,color,points:[...]}, right:{title,color,points:[...]}, takeaway; layers: left, right, takeaway)
4. "xy_graph" (ONLY if the slide contains a real quantitative graph)
Stay 100% faithful to THIS page — NEVER introduce unrelated topics (like cars or physics). Return ONLY valid JSON with 3 spoken beats:
{"beats":[{"say":"...","board":{"action":"new","template":"concept_map","title":"...","layers":["center","nodes"],"center":{"title":"...","subtitle":""},"nodes":[{"title":"...","detail":"...","color":"cyan"}],"takeaway":"...","formula":"","note":"..."}}]}`;

const VEHICLE_PROMPT_ES = `Eres un Profesor Catedrático especialista en Dinámica de Vehículos e Ingeniería dando clase en un AULA DE DOBLE PANTALLA (PDF + Pizarra vectorial).
Elige UNA plantilla en "board.template" (car_side, car_top, car_front, quarter_car, force_balance, power_balance, tire_load_curve, tire_slip_curve, friction_circle, inertia_body, xy_graph, comparison, concept_map, timeline_flow; o "action":"none" en portadas) y revela capas progresivamente en 3 beats hablados claros en español (sin Markdown, Unicode limpio en "formula").
Devuelve ÚNICAMENTE JSON válido:
{"beats":[{"say":"...","board":{"action":"new","template":"xy_graph","title":"...","layers":["base","curve1"],"formula":"","note":"..."}}]}`;

const VEHICLE_PROMPT_EN = `You are a senior university professor of Vehicle Dynamics & Engineering teaching live in a DUAL-SCREEN CLASSROOM.
Pick ONE template in "board.template" (car_side, car_top, car_front, quarter_car, force_balance, power_balance, tire_load_curve, tire_slip_curve, friction_circle, inertia_body, xy_graph, comparison, concept_map, timeline_flow) across 3 rich spoken beats (no Markdown, clean Unicode in "formula").
Return ONLY valid JSON:
{"beats":[{"say":"...","board":{"action":"new","template":"xy_graph","title":"...","layers":["base","curve1"],"formula":"","note":"..."}}]}`;

function getMobileClassPrompt(domain, isEn) {
  if (domain === 'vehicle') return isEn ? VEHICLE_PROMPT_EN : VEHICLE_PROMPT_ES;
  return isEn ? GENERAL_PROMPT_EN : GENERAL_PROMPT_ES;
}

function extractJsonObject(raw) {
  const s = String(raw || '').trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : s;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      return JSON.parse(candidate.slice(start, end + 1));
    }
    throw new Error('La respuesta de Gemini no contenía JSON válido');
  }
}

async function callGeminiCloud({ systemInstruction, promptText, imageB64 = '', expectJson = true }) {
  const apiKey = state.settings.apiKey.trim();
  if (!apiKey) {
    throw new Error('MISSING_API_KEY');
  }

  const failoverModels = [
    ...new Set([state.settings.model, 'gemini-3.5-flash', 'gemini-3.5-flash-lite']),
  ];

  const input = imageB64
    ? [
        { type: 'text', text: promptText },
        { type: 'image', data: imageB64, mime_type: 'image/jpeg' },
      ]
    : promptText;

  let lastErr = null;
  for (const model of failoverModels) {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 28000);
    try {
      const body = {
        model,
        system_instruction: systemInstruction,
        input,
        generation_config: {
          temperature: 0.45,
          max_output_tokens: 1800,
        },
      };
      if (expectJson) {
        body.response_mime_type = 'application/json';
      }

      const res = await fetch(GEMINI_INTERACTIONS_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        const errTxt = await res.text().catch(() => '');
        const err = new Error(`Gemini ${model} (${res.status}): ${errTxt.slice(0, 160)}`);
        if (res.status === 401 || res.status === 403) throw err;
        lastErr = err;
        continue;
      }

      const data = await res.json();
      const textOut = (data?.outputs || [])
        .filter((o) => o?.type === 'text' && o.text)
        .map((o) => o.text)
        .join('\n')
        .trim();

      if (!textOut) {
        lastErr = new Error(`Gemini ${model} devolvió respuesta vacía`);
        continue;
      }
      return { text: textOut, model };
    } catch (err) {
      lastErr = err;
      if (String(err?.message || '').includes('(401)') || String(err?.message || '').includes('(403)')) {
        throw err;
      }
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastErr || new Error('No se pudo conectar con Gemini Cloud');
}

async function generatePageLessonPlan(pageNum) {
  if (state.pagePlanCache.has(pageNum)) return state.pagePlanCache.get(pageNum);
  if (state.inFlightPlans.has(pageNum)) return state.inFlightPlans.get(pageNum);

  const task = (async () => {
    const ctx = await extractPdfPageContext(pageNum);
    const isEn = state.settings.language === 'en';
    const domain = detectMobileDomain(state.pdfName, ctx.text);
    const promptText = isEn
      ? `Document: "${state.pdfName || 'Study Notes'}" — Page ${pageNum} of ${state.totalPages}.\nSlide text:\n${ctx.text.slice(0, 2800) || '(Visual/diagram slide — inspect the attached image closely)'}\nTeach this page clearly in 3 synchronized beats.`
      : `Documento: "${state.pdfName || 'Apuntes'}" — Página ${pageNum} de ${state.totalPages}.\nTexto de la diapositiva:\n${ctx.text.slice(0, 2800) || '(Diapositiva visual o gráfica — analiza la imagen adjunta con precisión)'}\nExplica esta página con claridad y profundidad en 3 beats sincronizados.`;

    const { text } = await callGeminiCloud({
      systemInstruction: getMobileClassPrompt(domain, isEn),
      promptText,
      imageB64: ctx.imageB64,
      expectJson: true,
    });
    const parsed = extractJsonObject(text);
    const beats = (Array.isArray(parsed?.beats) ? parsed.beats : [])
      .filter((b) => b && b.say)
      .map((b) => ({
        ...b,
        board: sanitizeMobileBoard(b.board, domain, state.pdfName),
      }));
    if (!beats.length) throw new Error('Sin bloques de explicación generados');
    state.pagePlanCache.set(pageNum, beats);
    return beats;
  })().finally(() => {
    state.inFlightPlans.delete(pageNum);
  });

  state.inFlightPlans.set(pageNum, task);
  return task;
}

// ---------------- Continuous Class Playback Loop ----------------
function stopClass() {
  state.generationId++;
  state.playing = false;
  state.paused = false;
  stopAllSpeech();
  setKeepScreenOn(false);
  syncTransportUi();
}

async function runClassFromPage(startPage) {
  if (!state.settings.apiKey.trim() && !state.isDemoMode) {
    openSettingsModal();
    showToast('Introduce tu API Key gratuita de Google Gemini para iniciar la clase');
    return;
  }

  const myGen = ++state.generationId;
  state.playing = true;
  state.paused = false;
  setKeepScreenOn(true);
  syncTransportUi();

  for (let p = startPage; p <= state.totalPages; p++) {
    if (myGen !== state.generationId) return;

    if (!state.isDemoMode && state.currentPage !== p) {
      await renderPdfPage(p);
    } else if (state.isDemoMode) {
      state.currentPage = p;
      syncTransportUi();
    }

    setLiveDot('thinking');
    setCaption('Profesor', `Preparando página ${p} de ${state.totalPages} con Gemini Cloud...`);

    let beats;
    try {
      beats = state.isDemoMode ? getBuiltInDemoBeats() : await generatePageLessonPlan(p);
    } catch (err) {
      if (myGen !== state.generationId) return;
      setLiveDot('idle');
      if (err.message === 'MISSING_API_KEY') {
        openSettingsModal();
        showToast('Configura tu API Key de Gemini Cloud');
      } else {
        showToast(`Error en Gemini Cloud: ${err.message}`);
        setCaption('Error', err.message);
      }
      state.playing = false;
      state.paused = true;
      setKeepScreenOn(false);
      syncTransportUi();
      return;
    }

    if (myGen !== state.generationId) return;

    // Pre-buffer next page in background while speaking current page
    if (!state.isDemoMode && p + 1 <= state.totalPages) {
      generatePageLessonPlan(p + 1).catch(() => {});
    }

    for (const beat of beats) {
      if (myGen !== state.generationId) return;
      if (beat.board) {
        renderChalkboard(beat.board);
      }
      setCaption('Profesor', beat.say);
      await speakText(beat.say);
      if (myGen !== state.generationId) return;
    }
  }

  if (myGen === state.generationId) {
    state.playing = false;
    state.paused = false;
    setKeepScreenOn(false);
    setLiveDot('idle');
    setCaption('Profesor', '¡Clase completada! Puedes escribir cualquier duda abajo o cambiar de página.');
    syncTransportUi();
  }
}

function getBuiltInDemoBeats() {
  return [
    {
      say: 'En física elemental asumimos que el coeficiente de rozamiento es una constante rígida. Sin embargo, el caucho de un neumático es viscoelástico y su agarre depende de cómo se deforma la huella sobre el asfalto.',
      board: {
        action: 'new',
        template: 'tire_load_curve',
        mode: 'mu_vs_fz',
        title: 'Sensibilidad a la carga vertical: μ frente a F_z',
        layers: ['base', 'curve'],
        formula: '',
        note: 'Al aumentar la carga vertical F_z, μ_real cae por debajo de μ_constante',
      },
    },
    {
      say: 'Al añadir más peso vertical sobre una rueda, la goma se satura y la superficie real de contacto no crece al mismo ritmo. Cada kilo adicional genera algo más de agarre total, pero con menor rendimiento que el anterior.',
      board: {
        action: 'append',
        add_layers: ['transfer'],
        formula: 'μ_real(F_z) < μ_constante',
        note: 'Rendimiento decreciente por cada newton adicional sobre la huella',
      },
    },
    {
      say: 'Por eso aligerar el vehículo y reducir la transferencia lateral de carga en curva aporta siempre agarre neto: una rueda menos cargada trabaja en una zona más alta y eficiente de esta curva.',
      board: {
        action: 'append',
        formula: 'F_y = μ(F_z) · F_z',
        note: 'Menor masa y menor ΔF_z permiten explotar un μ mayor en curva',
      },
    },
  ];
}

// ---------------- Interactive Q&A (Cloud-Only) ----------------
async function askProfessorQuestion(question) {
  const q = String(question || '').trim();
  if (!q) return;

  // Pause ongoing class cleanly
  if (state.playing) {
    state.generationId++;
    state.playing = false;
    state.paused = true;
    stopAllSpeech();
    syncTransportUi();
  }

  if (!state.settings.apiKey.trim()) {
    openSettingsModal();
    showToast('Pega tu API Key gratuita de Google Gemini para preguntar al profesor');
    return;
  }

  setCaption('Tú', q);
  setLiveDot('thinking');

  const isEn = state.settings.language === 'en';
  const qaSys = isEn
    ? `You are a concise, clear university professor answering a student's question about the current slide. Reply ONLY in JSON: {"say":"direct spoken answer (2-4 sentences, no Markdown)","board":null}`
    : `Eres un profesor universitario claro y cercano respondiendo una duda concreta del alumno sobre la diapositiva actual. Responde ÚNICAMENTE JSON válido: {"say":"respuesta hablada directa en español (2-4 frases, sin Markdown)","board":null}. Opcionalmente incluye un objeto "board" con una de las 12 plantillas si ayuda a visualizar la duda.`;

  const promptText = `Documento: "${state.pdfName || 'Lección de muestra'}" (Pág. ${state.currentPage}/${state.totalPages || 1}).\nContexto de la página:\n${(state.currentPageText || '').slice(0, 2200)}\n\nPregunta del alumno: ${q}`;

  try {
    const { text } = await callGeminiCloud({
      systemInstruction: qaSys,
      promptText,
      imageB64: state.currentPageImageB64,
      expectJson: true,
    });
    const parsed = extractJsonObject(text);
    const qaDomain = detectMobileDomain(state.pdfName, state.currentPageText);
    if (parsed?.board && parsed.board.template) {
      renderChalkboard(sanitizeMobileBoard(parsed.board, qaDomain, state.pdfName));
    }
    const answer = parsed?.say || text;
    setCaption('Profesor', answer);
    await speakText(answer);
  } catch (err) {
    setLiveDot('idle');
    showToast(`No se pudo responder: ${err.message}`);
    setCaption('Error', err.message);
  }
}

// ---------------- Optional Non-Blocking Microphone ----------------
function toggleOptionalMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    showToast('Reconocimiento de voz no disponible aquí — puedes escribir tu duda abajo.');
    return;
  }

  if (state.micActive && state.recognition) {
    try { state.recognition.stop(); } catch {}
    state.micActive = false;
    $('micBtn').classList.remove('listening');
    return;
  }

  try {
    const rec = new SR();
    rec.lang = state.settings.language === 'en' ? 'en-US' : 'es-ES';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    state.recognition = rec;
    state.micActive = true;
    $('micBtn').classList.add('listening');

    rec.onresult = (ev) => {
      const transcript = ev.results?.[0]?.[0]?.transcript || '';
      if (transcript.trim()) {
        $('askInput').value = transcript.trim();
        askProfessorQuestion(transcript.trim());
      }
    };
    rec.onerror = (ev) => {
      state.micActive = false;
      $('micBtn').classList.remove('listening');
      if (ev.error === 'not-allowed' || ev.error === 'service-not-allowed') {
        showToast('Micrófono desactivado: sigue usando el cuadro de texto sin problema.');
      }
    };
    rec.onend = () => {
      state.micActive = false;
      $('micBtn').classList.remove('listening');
    };
    rec.start();
  } catch {
    state.micActive = false;
    $('micBtn').classList.remove('listening');
    showToast('No se pudo activar el micrófono — escribe tu duda directamente.');
  }
}

// ---------------- Settings Modal ----------------
function openSettingsModal() {
  $('apiKeyInput').value = state.settings.apiKey || '';
  $('modelSelect').value = state.settings.model;
  $('langSelect').value = state.settings.language;
  $('rateSelect').value = String(state.settings.rate || 1.0);
  applyTheme(state.settings.theme);
  $('settingsModal').hidden = false;
}

function closeSettingsModal() {
  $('settingsModal').hidden = true;
}

// ---------------- Interactive Mobile Tutorial ----------------
const MOBILE_TOUR_KEY = 'sap_mobile_tour_seen_v1';
const MOBILE_TOUR_STEPS = [
  {
    title: '🎓 Tu profesor interactivo en el móvil',
    body: 'Speaking AI Professor lee tus PDFs página a página, te los explica en voz alta y dibuja esquemas en la pizarra en tiempo real — adaptado a cualquier asignatura.',
    tips: [
      'Esta app Android funciona 100 % con Google Gemini Cloud (sin modelos locales) para cuidar la batería y memoria del teléfono.',
      'Puedes probarla al instante sin PDF tocando «✨ Probar lección de muestra».',
    ],
  },
  {
    title: '📂 Abre cualquier PDF de tu móvil',
    body: 'Pulsa «📂 PDF» arriba para cargar apuntes desde Descargas, Google Drive o WhatsApp.',
    tips: [
      'Se adapta al temario real: mapas conceptuales, líneas temporales y comparativas para letras o ciencias, y diagramas técnicos para ingeniería.',
      'Pre-carga la página siguiente en segundo plano para avanzar sin esperas.',
    ],
  },
  {
    title: '🔀 Vista Doble, PDF o Pizarra',
    body: 'En vertical cambia con 1 toque entre «🔀 Doble», «📄 PDF» y «📐 Pizarra». Si giras el móvil en horizontal (o usas tablet), verás PDF y Pizarra 50/50 lado a lado.',
    tips: [
      'Usa «▶ Dar clase» / «⏸ Pausar», «◀ / ▶» para cambiar de página y toca «Pág X/Y» para saltar a cualquier número de página.',
      'Toca «⏭» para pasar al siguiente paso o «🔊 / 🔇» para activar o silenciar la voz.',
    ],
  },
  {
    title: '💬 Pregunta dudas por texto o voz (opcional)',
    body: 'Escribe cualquier duda en la barra inferior para pausar al profesor y recibir una explicación directa sobre la página actual.',
    tips: [
      'El botón «🎤» es totalmente opcional: si prefieres no usar micrófono, puedes estudiar 100 % escribiendo.',
      'Cuando termine de responderte, pulsa «▶ Reanudar» para retomar la clase donde ibas.',
    ],
  },
  {
    title: '⚙ Ajustes: API Key gratuita, Modelo, Voz y Tema',
    body: 'Pulsa «⚙» arriba a la derecha para pegar tu API Key gratuita de Google AI Studio, cambiar de modelo Gemini, ajustar la velocidad de voz o elegir tema visual.',
    tips: [
      'Modelos disponibles: Gemini 3.5 Flash (recomendado y gratis), 3.5 Flash-Lite (ultra rápido) y 4 Hydrogen.',
      'Temas ergonómicos: Papel cálido, Sepia (baja luz azul) y Noche slate.',
    ],
    actions: [
      { label: 'Probar Sepia', run: () => { state.settings.theme = 'sepia'; saveSettings(state.settings); applyTheme('sepia'); } },
      { label: 'Probar Noche', run: () => { state.settings.theme = 'slate'; saveSettings(state.settings); applyTheme('slate'); } },
      { label: 'Abrir Ajustes (API Key)', run: () => { closeMobileTour(); openSettingsModal(); } },
    ],
  },
];

let mobileTourIdx = 0;

function renderMobileTourStep(idx) {
  const total = MOBILE_TOUR_STEPS.length;
  mobileTourIdx = Math.max(0, Math.min(total - 1, idx));
  const st = MOBILE_TOUR_STEPS[mobileTourIdx];
  $('mTourStepBadge').textContent = `Paso ${mobileTourIdx + 1} de ${total}`;
  $('mTourTitle').textContent = st.title;
  $('mTourBody').textContent = st.body;

  const tipsEl = $('mTourTips');
  tipsEl.innerHTML = '';
  for (const t of st.tips || []) {
    const li = document.createElement('li');
    li.textContent = t;
    tipsEl.appendChild(li);
  }

  const actEl = $('mTourActions');
  actEl.innerHTML = '';
  for (const a of st.actions || []) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'm-btn m-btn-ghost m-btn-sm';
    b.textContent = a.label;
    b.addEventListener('click', a.run);
    actEl.appendChild(b);
  }

  const dotsEl = $('mTourDots');
  dotsEl.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const d = document.createElement('button');
    d.type = 'button';
    d.className = `m-tour-dot${i === mobileTourIdx ? ' active' : ''}`;
    d.addEventListener('click', () => renderMobileTourStep(i));
    dotsEl.appendChild(d);
  }

  $('mTourPrevBtn').disabled = mobileTourIdx === 0;
  $('mTourNextBtn').textContent = mobileTourIdx === total - 1 ? '¡Empezar! ✓' : 'Siguiente →';
}

function openMobileTour(startIdx = 0) {
  $('mobileTourModal').hidden = false;
  renderMobileTourStep(startIdx);
}

function closeMobileTour() {
  $('mobileTourModal').hidden = true;
  try { localStorage.setItem(MOBILE_TOUR_KEY, '1'); } catch {}
}

// ---------------- Event Wiring ----------------
function initApp() {
  applyTheme(state.settings.theme);
  updateTopCloudPill();
  syncTransportUi();

  $('openMobileTourBtn')?.addEventListener('click', () => openMobileTour(0));
  $('closeMobileTourBtn')?.addEventListener('click', closeMobileTour);
  $('mobileTourModal')?.addEventListener('click', (ev) => {
    if (ev.target === $('mobileTourModal')) closeMobileTour();
  });
  $('mTourPrevBtn')?.addEventListener('click', () => renderMobileTourStep(mobileTourIdx - 1));
  $('mTourNextBtn')?.addEventListener('click', () => {
    if (mobileTourIdx >= MOBILE_TOUR_STEPS.length - 1) closeMobileTour();
    else renderMobileTourStep(mobileTourIdx + 1);
  });

  try {
    if (localStorage.getItem(MOBILE_TOUR_KEY) !== '1') {
      setTimeout(() => openMobileTour(0), 350);
    }
  } catch {}

  // View Switcher (Portrait)
  document.querySelectorAll('#viewTabs .m-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const layout = btn.dataset.layout || 'split';
      $('stageContainer').setAttribute('data-layout', layout);
      document.querySelectorAll('#viewTabs .m-tab').forEach((b) => b.classList.toggle('active', b === btn));
    });
  });

  // PDF File Picker
  $('pdfFileInput').addEventListener('change', (ev) => {
    const file = ev.target.files?.[0];
    if (file) openPdfFile(file);
    ev.target.value = '';
  });

  // Built-in Demo Lesson (works immediately even before uploading a PDF or API key!)
  $('demoLessonBtn').addEventListener('click', () => {
    stopClass();
    state.pdfDoc = null;
    state.isDemoMode = true;
    state.pdfName = 'Muestra · Sensibilidad de carga μ(F_z)';
    state.totalPages = 1;
    state.currentPage = 1;
    $('pdfFileLabel').textContent = state.pdfName;
    $('pdfBadge').textContent = 'Lección de muestra · Pág. 1/1';
    $('pdfEmptyState').hidden = false;
    $('pdfCanvas').hidden = true;
    syncTransportUi();
    runClassFromPage(1);
  });

  // Transport controls
  $('playPauseBtn').addEventListener('click', () => {
    if (state.playing && !state.paused) {
      state.generationId++;
      state.playing = false;
      state.paused = true;
      stopAllSpeech();
      setKeepScreenOn(false);
      syncTransportUi();
      setCaption('Pausa', 'Clase en pausa. Pulsa «▶ Reanudar» o pregunta cualquier duda.');
    } else {
      runClassFromPage(state.currentPage);
    }
  });

  $('prevPageBtn').addEventListener('click', async () => {
    if (state.currentPage <= 1) return;
    const wasPlaying = state.playing && !state.paused;
    stopClass();
    await renderPdfPage(state.currentPage - 1);
    if (wasPlaying) runClassFromPage(state.currentPage);
  });

  $('nextPageBtn').addEventListener('click', async () => {
    if (state.currentPage >= state.totalPages) return;
    const wasPlaying = state.playing && !state.paused;
    stopClass();
    await renderPdfPage(state.currentPage + 1);
    if (wasPlaying) runClassFromPage(state.currentPage);
  });

  $('pageJumpBtn').addEventListener('click', async () => {
    const val = window.prompt(`Ir a página (1 - ${state.totalPages}):`, String(state.currentPage));
    const target = Number(val);
    if (!Number.isFinite(target) || target < 1 || target > state.totalPages) return;
    const wasPlaying = state.playing && !state.paused;
    stopClass();
    await renderPdfPage(Math.trunc(target));
    if (wasPlaying) runClassFromPage(state.currentPage);
  });

  $('skipBeatBtn').addEventListener('click', () => {
    if (state.playing && !state.paused) {
      stopAllSpeech();
    }
  });

  $('muteVoiceBtn').addEventListener('click', () => {
    state.settings.muted = !state.settings.muted;
    saveSettings(state.settings);
    if (state.settings.muted) stopAllSpeech();
    syncTransportUi();
    showToast(state.settings.muted ? 'Voz silenciada (solo subtítulos)' : 'Voz activada');
  });

  // Ask Form & Optional Mic
  $('askForm').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const input = $('askInput');
    const q = input.value.trim();
    if (!q) return;
    input.value = '';
    askProfessorQuestion(q);
  });
  $('micBtn').addEventListener('click', toggleOptionalMic);

  // Settings Modal
  $('openSettingsBtn').addEventListener('click', openSettingsModal);
  $('quickApiKeyBtn').addEventListener('click', openSettingsModal);
  $('closeSettingsBtn').addEventListener('click', closeSettingsModal);
  $('settingsModal').addEventListener('click', (ev) => {
    if (ev.target === $('settingsModal')) closeSettingsModal();
  });

  document.querySelectorAll('#themePills .m-pill').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.settings.theme = btn.dataset.theme || 'warm';
      applyTheme(state.settings.theme);
    });
  });

  $('saveSettingsBtn').addEventListener('click', () => {
    state.settings.apiKey = $('apiKeyInput').value.trim();
    state.settings.model = ALLOWED_CLOUD_MODELS.includes($('modelSelect').value)
      ? $('modelSelect').value
      : 'gemini-3.5-flash';
    state.settings.language = $('langSelect').value === 'en' ? 'en' : 'es';
    state.settings.rate = Number($('rateSelect').value) || 1.0;
    saveSettings(state.settings);
    updateTopCloudPill();
    closeSettingsModal();
    showToast('Ajustes de Gemini Cloud guardados');
  });
}

initApp();
