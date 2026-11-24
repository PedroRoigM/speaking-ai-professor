import { buildSystemInstruction, getProfessorToolDeclarations } from './professorConfig.mjs';
import { HUMAN_PROFESSOR_SOUL_RULES, resolveProsodyProfile } from './professorSoulPrompt.mjs';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

export const RECOMMENDED_LOCAL_MODELS = [
  {
    id: 'qwen3.5:9b',
    label: 'Qwen 3.5 9B — Recomendado M4 Pro (MLX 100% GPU · Visión + Pizarra · ~7.6 GB)',
    note: 'Máxima velocidad (~38-45 tok/s en M4 Pro) sin saturar los 24 GB de RAM unificada',
  },
  {
    id: 'gemma4:12b',
    label: 'Gemma 4 12B — Alternativa MLX GPU (Visión + STEM · ~7.7 GB)',
    note: 'Excelente razonamiento físico/matemático en M4 Pro 24 GB (~32-40 tok/s)',
  },
  {
    id: 'qwen3.5-27b:latest',
    label: 'Qwen 3.5 27B — Solo dudas profundas (~16 GB · más lento, sin visión)',
    note: 'Evítalo en Clase Continua (ocupa 16 GB y es ~2.5x más lento en memoria unificada)',
  },
];

function convertType(t) {
  return String(t || 'string').toLowerCase();
}

function compactSchema(node, keyName = '', depth = 0) {
  if (!node || typeof node !== 'object') return {};
  if (keyName === 'primitives' || keyName === 'diagram_primitives') {
    return {
      type: 'array',
      description: 'CAD primitives in 0..960x0..540 (kind: ground|axes|plot_curve|body|wheel|cg_marker|vector|dimension|spring|damper|angle_arc|moment_arc|callout)',
      items: { type: 'object' },
    };
  }
  const out = { type: convertType(node.type) };
  // Keep descriptions only at top-level or important fields so local models stay blazing fast
  if (node.description && depth <= 1) {
    out.description = String(node.description).slice(0, 120);
  }
  if (node.properties) {
    out.properties = {};
    for (const [k, v] of Object.entries(node.properties)) {
      out.properties[k] = compactSchema(v, k, depth + 1);
    }
  }
  if (node.items) out.items = compactSchema(node.items, keyName, depth + 1);
  if (node.required) out.required = node.required;
  return out;
}

const CLASS_MODE_TOOL_NAMES = new Set([
  'open_pdf_page',
  'annotate_pdf_page',
  'start_blank_canvas_problem',
  'append_problem_step',
  'return_to_pdf',
  'draw_live_scene',
  'point_to_stage_element',
  'verify_math_python',
  'search_study_materials',
  'class_progress',
]);

export function getOllamaTools({ classMode = false } = {}) {
  const decls = getProfessorToolDeclarations()[0]?.functionDeclarations || [];
  const filtered = classMode ? decls.filter((fn) => CLASS_MODE_TOOL_NAMES.has(fn.name)) : decls;
  return filtered.map((fn) => ({
    type: 'function',
    function: {
      name: fn.name,
      description: String(fn.description || '').split('.')[0].slice(0, 140),
      parameters: compactSchema(fn.parameters, '', 0),
    },
  }));
}

function buildCompactLocalSystemPrompt({ mode, language, domainProfile, filesList, topic }) {
  const folderName = domainProfile?.folderName || 'Estudio';
  const langRule =
    language === 'en'
      ? 'Speak in natural, clear English.'
      : language === 'es'
        ? 'Habla siempre en español (Castellano) claro, natural y sereno.'
        : 'Habla en el mismo idioma que el alumno o los apuntes (español por defecto).';

  const topFiles = (filesList || [])
    .filter((f) => f.active)
    .slice(0, 10)
    .map((f) => f.name)
    .join(', ');

  const isClass = mode === 'continuous_class';
  const roleDesc =
    mode === 'socratic'
      ? 'Eres un profesor socrático privado: explica con intuición, dibuja y haz una pregunta guía cada vez.'
      : mode === 'exam'
        ? 'Eres un examinador oral de Máster: evalúa con rigor, verifica cálculos con verify_math_python y corrige en la pizarra.'
        : isClass
          ? 'Eres un Profesor Catedrático impartiendo una CLASE CONTINUA REAL sobre el PDF, sin prisa y sin saltarte ningún detalle, fórmula ni ejemplo.'
          : 'Eres un Profesor Catedrático experto en esta carpeta, explicando con intuición física y precisión visual.';

  return `${roleDesc}
CARPETA ACTIVA: "${folderName}" | Archivos: ${topFiles || '(sin archivos)'}${topic ? ` | Enfoque: ${topic}` : ''}

REGLAS DE VOZ Y ESTILO DOCENTE (OBLIGATORIAS):
- ${langRule}
- Tu texto hablado será leído por síntesis de voz: escribe SOLO habla natural, culta y directa, sin Markdown (**), sin listas, sin <svg> y sin LaTeX crudo ($ o \\frac).
- PROHIBIDO abusar de coletillas repetitivas ("A ver...", "Fíjate...", "Mira...", "Mira esto...", "Bueno...", "Vamos a ver...", "En esta diapositiva...", "Es importante destacar..."). Entra directamente en el mecanismo físico y el porqué técnico con naturalidad y claridad.
- Usa 3–5 frases claras y precisas por bloque; no repitas lo que acabas de decir tras llamar a una herramienta visual.

PRECISIÓN VISUAL EN AULA DOBLE PANTALLA (PDF IZQUIERDA + PIZARRA DERECHA · COLORES ESTABLES):
- cyan=geometría/cotas/ejes, amber=fuerzas/cargas/aceleraciones, emerald=reacciones/resultados, rose=oposición/fricción/errores.
- El alumno tiene el PDF a la izquierda y tu PIZARRA VIVA a la derecha: NO te dediques a subrayar ni rodear frases sin parar sobre el PDF. Usa \`annotate_pdf_page\` solo de forma muy puntual si señalas un dato concreto de la diapositiva.
- Tu herramienta principal de profesor es DIBUJAR en la PIZARRA derecha (\`draw_live_scene\` o \`start_blank_canvas_problem\`) con \`primitives\` CAD en 0..960×0..540 (ground, axes, plot_curve, body[chassis/rect/circle/ring], top_car, front_car, wheel, cg_marker, vector, dimension, spring, damper, angle_arc, moment_arc, polyline, callout, note) + \`variables\`.
- En fórmulas HTML (\`equation_html\` / \`formula_html\`): usa fracciones verticales <span class="frac"><span class="num">a</span><span class="den">b</span></span>, <sub>, <sup>, spans var-cyan/var-amber/var-emerald/var-rose y símbolos Unicode (×, −, ·, Δ, α, θ, ω, Σ, ⇒).

REGLA DE ORO PARA EJEMPLOS Y PROBLEMAS MATEMÁTICOS:
- Por CADA ejemplo, ejercicio o demostración matemática que aparezca en el PDF: DETENTE, llama a \`start_blank_canvas_problem\` (cambia a lienzo en blanco con datos, incógnita y esquema técnico), y resuélvelo POCO A POCO llamando a \`append_problem_step\` UNA SOLA VEZ por paso (Paso 1: ley física de partida -> Pasos intermedios: despejes sin saltos -> Paso final: sustitución numérica verificada con \`verify_math_python\`, marcando \`is_final_step: true\`). PROHIBIDO saltar a la fórmula final directamente.
- Al terminar el problema, llama a \`return_to_pdf\` para volver a la página del PDF.
${isClass ? '- En Modo Clase Continua: recorre toda la página sin prisa anotando encima; al completarla llama a `class_progress(action: "next_page")` o `open_pdf_page`. Si el alumno pide retroceder, usa `open_pdf_page(delta: -1)`.' : ''}`;
}

export function normalizeToolArgs(rawArgs) {
  let obj = rawArgs;
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj);
    } catch {
      return {};
    }
  }
  if (!obj || typeof obj !== 'object') return {};
  const out = Array.isArray(obj) ? [...obj] : { ...obj };
  if (!Array.isArray(out)) {
    for (const [k, v] of Object.entries(out)) {
      if (typeof v === 'string' && ((v.startsWith('[') && v.endsWith(']')) || (v.startsWith('{') && v.endsWith('}')))) {
        try {
          out[k] = JSON.parse(v);
        } catch {
          // Leave as plain string
        }
      }
    }
  }
  return out;
}

const capabilityCache = new Map();

export async function getOllamaModelCapabilities(modelName) {
  const key = String(modelName || '').trim();
  if (!key) return { vision: false, tools: true, thinking: false };
  if (capabilityCache.has(key)) return capabilityCache.get(key);
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: key }),
      signal: AbortSignal.timeout(2500),
    });
    if (!res.ok) return { vision: false, tools: true, thinking: false };
    const data = await res.json();
    const caps = Array.isArray(data.capabilities) ? data.capabilities.map((c) => String(c).toLowerCase()) : [];
    const info = {
      vision: caps.includes('vision'),
      tools: caps.length === 0 || caps.includes('tools'),
      thinking: caps.includes('thinking'),
    };
    capabilityCache.set(key, info);
    return info;
  } catch {
    return { vision: false, tools: true, thinking: false };
  }
}

export async function getOllamaStatus() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return { running: false, models: [] };
    const data = await res.json();
    const rawModels = data.models || [];
    const models = await Promise.all(
      rawModels.map(async (m) => {
        const caps = await getOllamaModelCapabilities(m.name);
        return {
          name: m.name,
          sizeGb: Number(((m.size || 0) / 1e9).toFixed(1)),
          family: m.details?.family || '',
          paramSize: m.details?.parameter_size || '',
          vision: caps.vision,
          tools: caps.tools,
          thinking: caps.thinking,
        };
      }),
    );
    return { running: true, models };
  } catch {
    return { running: false, models: [] };
  }
}

export async function getOllamaRunningGpuInfo() {
  try {
    const res = await fetch(`${OLLAMA_HOST}/api/ps`, { signal: AbortSignal.timeout(1800) });
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models || []).map((m) => {
      const size = Number(m.size || 0);
      const vram = Number(m.size_vram || 0);
      const gpuPct = size > 0 ? Math.round((vram / size) * 100) : 100;
      return {
        name: m.name,
        sizeGb: Number((size / 1e9).toFixed(1)),
        vramGb: Number((vram / 1e9).toFixed(1)),
        gpuPct,
      };
    });
  } catch {
    return [];
  }
}

export async function pullOllamaModel(modelName, onProgress) {
  const res = await fetch(`${OLLAMA_HOST}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelName, stream: true }),
  });
  if (!res.ok) {
    throw new Error(`Ollama pull failed (${res.status}): ${await res.text()}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        onProgress?.(evt);
      } catch {}
    }
  }
}

// Extract completed spoken sentences cleanly while streaming
function popReadySentences(buffer) {
  const sentences = [];
  let rest = buffer;
  // Match true sentence endings (. not inside decimals like 0.45, or !, ?, newline)
  const re = /^([\s\S]*?(?:(?<!\d)\.(?!\d)|[!?\n]+))(?=\s+|$)/;
  while (true) {
    const m = rest.match(re);
    if (!m) break;
    const candidate = m[1].trim();
    const after = rest.slice(m[0].length);
    if (candidate.length < 24 && !/[!?\n]$/.test(candidate) && after.length < 20) {
      break;
    }
    if (candidate) sentences.push(candidate);
    rest = after.trimStart();
  }
  return { sentences, rest };
}

export class LocalProfessorSession {
  constructor({ config, library, voiceEngine, sendClient, executeSharedTool, classDirector }) {
    this.config = config;
    this.library = library;
    this.voiceEngine = voiceEngine;
    this.sendClient = sendClient;
    this.executeSharedTool = executeSharedTool;
    this.classDirector = classDirector;
    this.messages = [];
    this.abortController = null;
    this.pendingImages = [];
    this.pendingStageEvents = [];
    this.qaSegSeq = 1;
    this.ttsQueue = Promise.resolve();
    this.turnToken = 0;
    this.modelSupportsVision = false;
    this.modelSupportsTools = true;
  }

  async init() {
    this.voiceEngine?.warmup?.();
    const model = this.config.localModel || 'gemma4:12b';
    const caps = await getOllamaModelCapabilities(model);
    this.modelSupportsVision = Boolean(caps.vision);
    this.modelSupportsTools = Boolean(caps.tools);
    const systemText = buildCompactLocalSystemPrompt({
      mode: this.config.mode || 'folder_expert',
      language: this.config.language || 'auto',
      domainProfile: this.library.domainProfile,
      filesList: this.library.listFiles(),
      topic: this.config.topic || '',
    });
    this.messages = [
      {
        role: 'system',
        content: systemText,
      },
    ];
  }

  addPendingImage(base64Jpeg) {
    if (!base64Jpeg || !this.modelSupportsVision) return;
    this.pendingImages.push(base64Jpeg);
    if (this.pendingImages.length > 2) this.pendingImages.shift();
  }

  stripAllImagesFromMessages() {
    this.pendingImages = [];
    for (const msg of this.messages) {
      if (msg && msg.images) delete msg.images;
    }
  }

  interrupt() {
    this.turnToken++;
    this.pendingStageEvents = [];
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {}
      this.abortController = null;
    }
    this.sendClient({ type: 'interrupted' });
  }

  queueStageEvent(evt) {
    if (evt) this.pendingStageEvents.push(evt);
  }

  enqueueSpeech(sentenceText, tokenAtEnqueue) {
    const clean = String(sentenceText || '')
      .replace(/[*_`#]+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean && !this.pendingStageEvents.length) return;
    const attachedEvents = this.pendingStageEvents.splice(0);
    this.classDirector?.onAudioChunkDispatched?.();
    this.ttsQueue = this.ttsQueue.then(async () => {
      if (tokenAtEnqueue !== this.turnToken) return;
      try {
        let pcmBase64 = '';
        let sampleRate = 24000;
        let durationMs = 200;
        if (clean) {
          const low = clean.toLowerCase();
          const qaProsodyTag = /\?\s*$/.test(low)
            ? 'question'
            : /(ojo|cuidado|trampa|clave|fundamental|fíjate bien|párate)/.test(low)
              ? 'key_insight'
              : /(exacto|ahí está|todo encaja|qué bonito)/.test(low)
                ? 'aha'
                : 'warm';
          const qaProsody = resolveProsodyProfile(qaProsodyTag, 'warm');
          const audio = await this.voiceEngine.synthesize(clean, {
            voiceId: this.config.localVoice || 'kokoro:em_alex',
            language: this.config.language || 'auto',
            speed: qaProsody.speed,
          });
          if (tokenAtEnqueue !== this.turnToken) return;
          if (audio.ok && audio.pcmBase64 && audio.pcmBase64.length > 64) {
            pcmBase64 = audio.pcmBase64;
            sampleRate = audio.sampleRate || 24000;
            const bytes = Math.floor(pcmBase64.length * 0.75);
            durationMs = Math.round((bytes / (sampleRate * 2)) * 1000);
          } else {
            console.error('[Local TTS empty chunk]', { engine: audio.engine, text: clean.slice(0, 60) });
          }
        }
        const trailingPause = /\?\s*$/.test(clean) ? 580 : 190;
        this.sendClient({
          type: 'timeline_segment',
          segment: {
            id: `qa-${this.qaSegSeq++}`,
            isQa: true,
            pauseAfterMs: trailingPause,
            onStartEvents: attachedEvents,
            transcriptText: clean,
            audioBase64: pcmBase64,
            sampleRate,
            durationMs,
          },
        });
      } catch (err) {
        console.error('[Local TTS error]', err);
      }
    });
  }

  trimHistorySafely() {
    // Strip heavy base64 images from older messages (keep only the latest 1 user image for vision context)
    let seenImages = 0;
    for (let i = this.messages.length - 1; i >= 1; i--) {
      if (this.messages[i].images?.length) {
        seenImages++;
        if (seenImages > 1) {
          delete this.messages[i].images;
        }
      }
    }
    // Keep system prompt + recent 24 messages so multi-page lectures stay fast & sharp on 24 GB RAM
    if (this.messages.length > 28) {
      this.messages = [this.messages[0], ...this.messages.slice(-24)];
    }
  }

  async runDirectorBeat({ cueText, visionBase64 }) {
    if (visionBase64 && this.modelSupportsVision) {
      this.pendingImages = [visionBase64];
    } else {
      this.pendingImages = [];
    }
    await this.handleUserMessage(cueText, { alreadyLogged: true, isDirectorBeat: true });
  }

  async handleUserMessage(text, { alreadyLogged = false, isDirectorBeat = false } = {}) {
    const cleanText = String(text || '').trim();
    if (!cleanText && !this.pendingImages.length) return;

    this.turnToken++;
    const myToken = this.turnToken;
    if (this.abortController) {
      try {
        this.abortController.abort();
      } catch {}
    }
    this.abortController = new AbortController();

    if (!isDirectorBeat) {
      this.classDirector?.onTurnStart?.();
    }

    if (!alreadyLogged && !isDirectorBeat && cleanText) {
      this.sendClient({ type: 'input_transcript', text: cleanText });
    }

    const userMsg = { role: 'user', content: cleanText || 'Analiza esta imagen que te envío.' };
    if (this.pendingImages.length && this.modelSupportsVision) {
      userMsg.images = [...this.pendingImages];
    }
    this.pendingImages = [];
    this.messages.push(userMsg);
    this.trimHistorySafely();

    const tools = this.modelSupportsTools
      ? getOllamaTools({ classMode: this.config.mode === 'continuous_class' || Boolean(this.classDirector?.active) })
      : [];
    const model = this.config.localModel || 'qwen3.5:9b';

    this.sendClient({ type: 'interaction_status', status: 'IN_PROGRESS' });

    try {
      for (let hop = 0; hop < 6; hop++) {
        if (myToken !== this.turnToken) return;

        if (!this.modelSupportsVision) {
          this.stripAllImagesFromMessages();
        }

        const buildRequestBody = () => {
          const b = {
            model,
            messages: this.messages,
            stream: true,
            keep_alive: '30m',
            options: {
              num_gpu: 99,
              num_ctx: 6144,
              temperature: 0.45,
            },
          };
          if (this.modelSupportsTools && tools.length) {
            b.tools = tools;
          }
          if (this.config.localThink) {
            b.think = true;
          } else if (/qwen3|gemma4|deepseek/i.test(model)) {
            b.think = false;
          }
          return b;
        };

        let res = await fetch(`${OLLAMA_HOST}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildRequestBody()),
          signal: this.abortController.signal,
        });

        // Graceful auto-fallback if a model rejects image inputs (missing mmproj) or tools
        if (!res.ok) {
          const errText = await res.text();
          if (/image input is not supported|mmproj|does not support vision/i.test(errText) && this.modelSupportsVision) {
            this.modelSupportsVision = false;
            this.stripAllImagesFromMessages();
            capabilityCache.set(model, { ...(capabilityCache.get(model) || {}), vision: false });
            this.sendClient({
              type: 'tool_status',
              label: `ℹ️ "${model}" no admite imágenes en Ollama; continuando con el texto y coordenadas exactas del PDF (usa gemma4:12b o qwen3.5:9b para visión completa).`,
            });
            res = await fetch(`${OLLAMA_HOST}/api/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(buildRequestBody()),
              signal: this.abortController.signal,
            });
          } else if (/does not support tools/i.test(errText) && this.modelSupportsTools) {
            this.modelSupportsTools = false;
            capabilityCache.set(model, { ...(capabilityCache.get(model) || {}), tools: false });
            res = await fetch(`${OLLAMA_HOST}/api/chat`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(buildRequestBody()),
              signal: this.abortController.signal,
            });
          } else {
            throw new Error(`Ollama error (${res.status}): ${errText.slice(0, 300)}`);
          }
        }

        if (!res.ok) {
          const errText2 = await res.text();
          throw new Error(`Ollama error (${res.status}): ${errText2.slice(0, 300)}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let lineBuf = '';
        let fullContent = '';
        let speechBuf = '';
        let insideThink = false;
        let insideSvg = false;
        let svgBuf = '';
        const collectedToolCalls = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (myToken !== this.turnToken) return;

          lineBuf += decoder.decode(value, { stream: true });
          const lines = lineBuf.split('\n');
          lineBuf = lines.pop() || '';

          for (const line of lines) {
            if (!line.trim()) continue;
            let evt;
            try {
              evt = JSON.parse(line);
            } catch {
              continue;
            }
            const m = evt.message;
            if (!m) continue;

            if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
              collectedToolCalls.push(...m.tool_calls);
            }

            if (m.content) {
              let piece = m.content;
              fullContent += piece;

              if (insideThink) {
                const closeIdx = piece.indexOf('</think>');
                if (closeIdx === -1) continue;
                piece = piece.slice(closeIdx + 8);
                insideThink = false;
              }
              if (piece.includes('<think>')) {
                const openIdx = piece.indexOf('<think>');
                const before = piece.slice(0, openIdx);
                const after = piece.slice(openIdx + 7);
                const closeIdx = after.indexOf('</think>');
                if (closeIdx !== -1) {
                  piece = before + after.slice(closeIdx + 8);
                } else {
                  piece = before;
                  insideThink = true;
                }
              }

              if (insideSvg) {
                svgBuf += piece;
                const endSvg = svgBuf.indexOf('</svg>');
                if (endSvg !== -1) {
                  const svgMarkup = svgBuf.slice(0, endSvg + 6);
                  piece = svgBuf.slice(endSvg + 6);
                  svgBuf = '';
                  insideSvg = false;
                  this.queueStageEvent({
                    type: 'stage_live_scene',
                    data: { scene_title: 'Diagrama en vivo', badge: 'Live Chalkboard', svg_code: svgMarkup },
                  });
                } else {
                  continue;
                }
              }
              if (piece.includes('<svg')) {
                const sIdx = piece.indexOf('<svg');
                const before = piece.slice(0, sIdx);
                const restSvg = piece.slice(sIdx);
                const eIdx = restSvg.indexOf('</svg>');
                if (eIdx !== -1) {
                  this.queueStageEvent({
                    type: 'stage_live_scene',
                    data: { scene_title: 'Diagrama en vivo', badge: 'Live Chalkboard', svg_code: restSvg.slice(0, eIdx + 6) },
                  });
                  piece = before + restSvg.slice(eIdx + 6);
                } else {
                  insideSvg = true;
                  svgBuf = restSvg;
                  piece = before;
                }
              }

              if (piece) {
                speechBuf += piece;
                const { sentences, rest } = popReadySentences(speechBuf);
                speechBuf = rest;
                for (const s of sentences) {
                  this.enqueueSpeech(s, myToken);
                }
              }
            }
          }
        }

        if (speechBuf.trim() && myToken === this.turnToken) {
          this.enqueueSpeech(speechBuf.trim(), myToken);
          speechBuf = '';
        }

        const assistantMsg = { role: 'assistant', content: fullContent };
        if (collectedToolCalls.length) {
          assistantMsg.tool_calls = collectedToolCalls;
        }
        this.messages.push(assistantMsg);

        if (!collectedToolCalls.length) {
          break;
        }

        let newPageVision = null;
        let newPageNotice = '';
        for (const tc of collectedToolCalls) {
          if (myToken !== this.turnToken) return;
          const fnName = tc.function?.name;
          const fnArgs = normalizeToolArgs(tc.function?.arguments || {});
          const rawResult = await this.executeSharedTool(fnName, fnArgs, (stageEvt) => this.queueStageEvent(stageEvt));
          // Never dump raw base64 image string into JSON text tokens!
          const { visionBase64, ...cleanResult } = rawResult && typeof rawResult === 'object' ? rawResult : { result: rawResult };
          if (visionBase64) {
            newPageVision = visionBase64;
            newPageNotice = `Imagen renderizada de la Página ${cleanResult.page} de "${cleanResult.filename || ''}" cargada en tu visión.`;
          }
          this.messages.push({
            role: 'tool',
            tool_name: fnName,
            content: JSON.stringify(cleanResult),
          });
        }

        // If open_pdf_page / return_to_pdf loaded a new PDF page image, pass it natively to vision (only if supported!)
        if (newPageVision && this.modelSupportsVision && myToken === this.turnToken) {
          this.messages.push({
            role: 'user',
            content: `[Sistema Visual] ${newPageNotice} Continúa explicando esta página en voz alta con naturalidad (y anota sobre ella con annotate_pdf_page).`,
            images: [newPageVision],
          });
          this.trimHistorySafely();
        }
      }

      // Flush any trailing visual-only stage events at the exact end of the audio timeline
      if (this.pendingStageEvents.length && myToken === this.turnToken) {
        this.enqueueSpeech('', myToken);
      }

      await this.ttsQueue;
      if (myToken === this.turnToken) {
        this.sendClient({ type: 'turn_complete' });
        this.sendClient({ type: 'interaction_status', status: 'IDLE' });
        this.classDirector?.onTurnComplete?.();
      }
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error('[LocalProfessor error]', err);
      this.sendClient({ type: 'error', message: err.message });
      this.sendClient({ type: 'interaction_status', status: 'IDLE' });
      this.classDirector?.onBeatError?.(err.message);
    }
  }
}
