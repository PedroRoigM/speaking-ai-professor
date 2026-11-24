import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { verifyMathPython } from './mathVerifier.mjs';
import { WebResearchAgent } from './webResearchAgent.mjs';
import { getOllamaModelCapabilities } from './localProfessor.mjs';
import { HUMAN_PROFESSOR_SOUL_RULES, resolveProsodyProfile } from './professorSoulPrompt.mjs';
import { normalizeGeminiClassModelId } from './professorConfig.mjs';

const LESSON_CACHE_VERSION = 'v7-faithful-masterclass';

const VALID_BLUEPRINT_TEMPLATES = new Set([
  'car_side',
  'car_top',
  'car_front',
  'quarter_car',
  'force_balance',
  'power_balance',
  'tire_load_curve',
  'tire_slip_curve',
  'friction_circle',
  'inertia_body',
  'xy_graph',
  'comparison',
]);

function resolveBlueprintTemplateName(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return '';
  if (VALID_BLUEPRINT_TEMPLATES.has(s)) return s;
  if (/power|vmax|v_max|resist|extern/.test(s)) return 'power_balance';
  if (/force|fbd|cuerpo|equilib|inclin/.test(s)) return 'force_balance';
  if (/graph|plot|curv|chart|xy/.test(s)) return 'xy_graph';
  if (/side|perfil|braking|fren|pitch/.test(s)) return 'car_side';
  if (/top|plan|planta|yaw|ackermann/.test(s)) return 'car_top';
  if (/front|roll|camber|caida/.test(s)) return 'car_front';
  if (/quarter|susp|muelle|damper/.test(s)) return 'quarter_car';
  if (/load|sensibilidad/.test(s)) return 'tire_load_curve';
  if (/slip|deriva|pacejka/.test(s)) return 'tire_slip_curve';
  if (/friction|kamm|adherencia|circle/.test(s)) return 'friction_circle';
  if (/inertia|steiner|ejes/.test(s)) return 'inertia_body';
  if (/compar|vs|versus/.test(s)) return 'comparison';
  return '';
}

function inferProsodyTag(explicitTag, spokenText, defaultTag = 'warm') {
  if (explicitTag && typeof explicitTag === 'string') return explicitTag.trim().toLowerCase();
  const low = String(spokenText || '').toLowerCase();
  if (/\?\s*$/.test(low)) return 'question';
  if (/(ojo|cuidado|trampa|clave|fundamental|quédate con|fíjate bien|párate un segundo)/.test(low)) return 'key_insight';
  if (/(exacto|ahí está|todo encaja|qué bonito|brutal|fíjate qué fácil)/.test(low)) return 'aha';
  return defaultTag;
}

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';

const VALID_BOARD_PRIMITIVE_KINDS = new Set([
  'ground',
  'axes',
  'plot_curve',
  'body',
  'wheel',
  'cg_marker',
  'vector',
  'dimension',
  'spring',
  'damper',
  'angle_arc',
  'moment_arc',
  'callout',
  'top_car',
  'front_car',
  'note',
  'formula_box',
  'text_box',
  'polyline',
  'curve',
  'path',
]);

function sanitizeBoardPrimitives(rawList) {
  if (!Array.isArray(rawList)) return [];
  const out = [];
  for (const p of rawList.slice(0, 16)) {
    if (!p || typeof p !== 'object') continue;
    const kind = String(p.kind || '').trim().toLowerCase();
    if (!VALID_BOARD_PRIMITIVE_KINDS.has(kind)) continue;
    const clean = { ...p, kind };
    if (clean.color && !['cyan', 'amber', 'emerald', 'rose', 'slate'].includes(String(clean.color).toLowerCase())) {
      clean.color = 'cyan';
    }
    out.push(clean);
  }
  return out;
}

const LATEX_CTRL_CMD_RE = /^(?:frac|forall|times|theta|text|tan|to|tau|rho|right|rightarrow|Rightarrow|rad|beta|bar|bmod|neq|nu|nabla|natural)\b/;

function repairJsonStringLiterals(str) {
  let out = '';
  let inStr = false;
  for (let i = 0; i < str.length; i++) {
    const ch = str[i];
    if (!inStr) {
      if (ch === '"') inStr = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      inStr = false;
      out += ch;
      continue;
    }
    if (ch === '\n') {
      out += '\\n';
      continue;
    }
    if (ch === '\r') {
      out += '\\r';
      continue;
    }
    if (ch === '\t') {
      out += '\\t';
      continue;
    }
    if (ch === '\\') {
      const next = str[i + 1];
      if (next == null) {
        out += '\\\\';
        continue;
      }
      if (next === '"' || next === '\\' || next === '/') {
        out += '\\' + next;
        i++;
        continue;
      }
      if (next === 'u' && /^[0-9a-fA-F]{4}/.test(str.slice(i + 2, i + 6))) {
        out += str.slice(i, i + 6);
        i += 5;
        continue;
      }
      // Protect LaTeX commands starting with f/t/r/b/n (e.g. \frac, \times, \theta, \rho, \beta, \neq)
      // from being mangled into ASCII form-feed/tab/CR/backspace/newline!
      if ('ftrbn'.includes(next) && LATEX_CTRL_CMD_RE.test(str.slice(i + 1, i + 18))) {
        out += '\\\\' + next;
        i++;
        continue;
      }
      if ('bfnrt'.includes(next)) {
        out += '\\' + next;
        i++;
        continue;
      }
      // Illegal JSON escape like \cdot, \Delta, \alpha, \sqrt, \perp, \quad -> escape the backslash!
      out += '\\\\' + next;
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function repairJsonQuirks(str) {
  let s = String(str || '');
  // Convert accidental unescaped double-quoted HTML attributes inside JSON strings into single quotes
  s = s.replace(/(<\w+\b[^>]*?)\s+(class|style|id)="([^"]*)"/gi, "$1 $2='$3'");
  // Escape illegal LaTeX backslashes (\cdot, \Delta, \frac, \alpha, \quad...) & raw newlines inside JSON strings!
  s = repairJsonStringLiterals(s);
  // Remove trailing commas before } or ]
  s = s.replace(/,\s*([}\]])/g, '$1');
  return s;
}

function parseLooseJson(raw) {
  const txt = String(raw || '').trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {}
  // Strip markdown code fences or stray think tags
  const cleaned = txt
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  const repaired = repairJsonQuirks(cleaned);
  for (const candidate of [cleaned, repaired]) {
    try {
      return JSON.parse(candidate);
    } catch {}
    const first = candidate.indexOf('{');
    const last = candidate.lastIndexOf('}');
    if (first !== -1 && last > first) {
      try {
        return JSON.parse(candidate.slice(first, last + 1));
      } catch {}
    }
  }
  // Partial-beat salvage: even if output truncated before final "]}", recover every complete beat object!
  const salvagedBeats = [];
  const salvageParser = new IncrementalBeatStreamParser((beatObj) => salvagedBeats.push(beatObj));
  salvageParser.push(repaired);
  if (salvagedBeats.length) {
    const hasProbMatch = repaired.match(/"has_problem"\s*:\s*(true|false)/i);
    return {
      has_problem: hasProbMatch ? hasProbMatch[1].toLowerCase() === 'true' : false,
      beats: salvagedBeats,
    };
  }
  return null;
}

/**
 * Incremental zero-dependency JSON parser that extracts each completed object inside
 * `"beats": [ { ... }, { ... } ]` the exact millisecond its closing `}` streams out of Ollama.
 * Enables overlapped Kokoro TTS + ~3-4s time-to-first-beat!
 */
export class IncrementalBeatStreamParser {
  constructor(onBeat) {
    this.onBeat = onBeat;
    this.buf = '';
    this.scanPos = 0;
    this.foundBeatsArray = false;
    this.beatsFinished = false;
    this.inString = false;
    this.escape = false;
    this.depth = 0;
    this.objStart = -1;
    this.emittedCount = 0;
  }

  push(chunk) {
    if (!chunk) return;
    this.buf += chunk;

    if (!this.foundBeatsArray) {
      const m = this.buf.match(/"beats"\s*:\s*\[/);
      if (!m) return;
      this.foundBeatsArray = true;
      this.scanPos = m.index + m[0].length;
    }

    while (this.foundBeatsArray && !this.beatsFinished && this.scanPos < this.buf.length) {
      const ch = this.buf[this.scanPos++];
      if (this.inString) {
        if (this.escape) {
          this.escape = false;
        } else if (ch === '\\') {
          this.escape = true;
        } else if (ch === '"') {
          this.inString = false;
        }
        continue;
      }

      if (ch === '"') {
        this.inString = true;
        continue;
      }
      if (ch === '{') {
        if (this.depth === 0) this.objStart = this.scanPos - 1;
        this.depth++;
      } else if (ch === '}') {
        if (this.depth > 0) this.depth--;
        if (this.depth === 0 && this.objStart !== -1) {
          const objSlice = this.buf.slice(this.objStart, this.scanPos);
          this.objStart = -1;
          const parsed = parseLooseJson(objSlice);
          if (parsed && typeof parsed === 'object') {
            const idx = this.emittedCount++;
            try {
              this.onBeat(parsed, idx);
            } catch {}
          }
        }
      } else if (ch === ']' && this.depth === 0) {
        this.beatsFinished = true;
      }
    }
  }
}

function needsVisionForBundle(bundle) {
  const rawText = String(bundle?.text || '');
  const meaningful = rawText
    .replace(/breno oliveira|dinámica de vehículos de competición|fundamentos de dinámica vehicular|fundamentos de dinámica|universidad nebrija/gi, '')
    .replace(/\b\d{1,3}\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Sparse or diagram/graph slides (e.g. Page 64 μ vs F_z) MUST use Vision so the model sees exact axes & plots!
  if (meaningful.length < 230) return true;
  const nonHeaderLines = (bundle?.layout?.lines || []).filter(
    (l) => l.text && !/breno oliveira|dinámica de vehículos|fundamentos de dinámica|nebrija/i.test(l.text),
  );
  const shortLabelLines = nonHeaderLines.filter((l) => l.text.trim().length <= 26).length;
  if (meaningful.length < 380 && shortLabelLines >= 4) return true;
  if (meaningful.length < 340 && /(figura|gr[aá]fic|curva|diagrama|esquema|tabla|foto|imagen|constante|real|eje)/i.test(meaningful)) {
    return true;
  }
  return false;
}

// 100% STATIC high-craft system prompts (including JSON schema!) so Ollama REUSES Prefix KV-Cache across every page!
const STATIC_DUAL_SCREEN_SYS_ES = `Eres un Profesor Catedrático universitario e Ingeniero especialista (con plantillas de ingeniería, física y dinámica de vehículos listas en pizarra) dando una clase magistral viva en un AULA DE DOBLE PANTALLA:
- IZQUIERDA (PDF): déjalo limpio (0 o máx 1 marca en "pdf_annotations" solo para un dato concreto).
- DERECHA (PIZARRA ESQUEMÁTICA): dibuja SIEMPRE un esquema limpio y 100% FIEL a la diapositiva actual eligiendo UNA de las 12 PLANTILLAS PARAMÉTRICAS en "board.template" (salvo portada pura -> "action":"none") y revelando capas progresivamente ("action":"new" con "layers" -> beats siguientes "action":"append" con "add_layers"). NUNCA inventes "primitives":
  1. "car_side" -> VISTA LATERAL: batalla L, distancias a y b, altura h_CG, reparto estático W_f/W_r, frenada, aceleración, cabeceo/pitch, aero (mode: "static"|"braking"|"accelerating"|"aero"; layers: base, dimensions, cg, loads, forces, moment)
  2. "car_top" -> VISTA EN PLANTA: guiñada/yaw I_zz, giro/curva, Ackermann, ángulos de deriva (mode: "dimensions"|"cornering"|"yaw"|"ackermann"; layers: base, dimensions, cg, forces, moment)
  3. "car_front" -> VISTA FRONTAL: ancho de vía t, balanceo/roll, centro de balanceo RC, caída/camber, transferencia lateral izq/der (mode: "static"|"cornering"|"camber"|"roll_center"; layers: base, dimensions, cg, loads, forces, moment)
  4. "quarter_car" -> SUSPENSIÓN 2-DOF: masa suspendida/no suspendida, muelle k_s, amortiguador c_s, neumático k_t (layers: base, suspension, dimensions, forces)
  5. "force_balance" -> DIAGRAMA DE CUERPO LIBRE SIMPLE: equilibrio longitudinal o plano inclinado α (mode: "horizontal"|"incline"; layers: base, forces, result)
  6. "power_balance" -> GRÁFICA FUERZAS EXTERNAS vs VELOCIDAD Y V_MAX: F_rod, F_aero ∝ V², F_total y curva motriz P/V (layers: base, resistances, traction, vmax)
  7. "tire_load_curve" -> SENSIBILIDAD A LA CARGA DEL NEUMÁTICO:
     · mode: "mu_vs_fz" si el PDF grafica el coeficiente de adherencia μ frente a F_z (μ_constante horizontal y μ_real decreciente)
     · mode: "fy_vs_fz" SOLO si el PDF grafica la fuerza lateral F_y frente a F_z (curva cóncava y transferencia ΔF_z)
     (layers: base, curve, transfer)
  8. "tire_slip_curve" -> CURVA PACEJKA F_y vs ángulo de deriva α (layers: base, curve, compare)
  9. "friction_circle" -> CÍRCULO DE ADHERENCIA / KAMM F_x vs F_y (layers: base, vectors, compare)
  10. "inertia_body" -> INERCIAS 3D Y STEINER (mode: "steiner"|"car_axes"; layers: base, axes, dimensions, callout | car_axes: base, axes, moment)
  11. "xy_graph" -> GRÁFICA X-Y GENÉRICA: pasa siempre "xLabel", "yLabel" y "curves":[{"shape":"quadratic"|"cubic"|"linear"|"linear_down"|"constant"|"constant_high"|"inverse"|"concave"|"peak"|"exponential"|"decay","expr":"opcional","color":"cyan","label":"..."}] (layers: base, curve1, curve2)
  12. "comparison" -> COMPARATIVA 2 COLUMNAS: left:{title,color,points:[...]}, right:{title,color,points:[...]}, takeaway (layers: left, right, takeaway)

FIDELIDAD ABSOLUTA AL PDF QUE SE ESTÁ MOSTRANDO (REGLA CRÍTICA):
- Reproduce EXACTAMENTE los mismos ejes, variables, símbolos y contenido de ESTA página concreta. Si el PDF grafica μ frente a F_z, dibuja μ frente a F_z (mode:"mu_vs_fz"), JAMÁS cambies los ejes a F_y vs F_z ni te adelantes a páginas siguientes.
- NO INVENTES FÓRMULAS que no aparezcan en el PDF: si la página no contiene ninguna ecuación matemática, deja "formula": "" vacío (o pon únicamente la relación cualitativa fiel al texto/gráfica visible, p. ej. "μ_real < μ_constante"). Si el PDF SÍ trae ecuaciones, cópialas con exactitud total sin alterar signos, exponentes ni denominadores.
- En "formula" usa Unicode limpio (ej. "W_f = W · b / L", "ΔF_z = (m · a_x · h_CG) / L"); NO uses barras invertidas LaTeX (\cdot, \frac).

PEDAGOGÍA ORGÁNICA, PROFUNDA Y DE ALTO VALOR (COMO UN GRAN PROFESOR HUMANO):
- Habla en español de España natural y cercano (tuteo / "nosotros"), fluido y apasionado, como un catedrático de pista explicando de verdad por qué pasan las cosas — NO como un resumen robótico.
- Construye 3 beats ricos y bien hilados (3 a 4 frases claras por beat):
  1. Arranca entrando directo en el fenómeno físico de esta página y el contraste con la intuición cotidiana (por qué ocurre a nivel mecánico, de goma, de inercia o de fuerzas).
  2. Desgrana el mecanismo físico y la lectura exacta de la gráfica o ecuación del PDF con un ejemplo mental concreto o numérico sencillo (ej. "si duplicamos la carga vertical...").
  3. Cierra conectando con el beneficio práctico real en competición: qué decisión de diseño, pilotaje o reglaje (pesos, alturas, muelles, aerodinámica) se deduce de esto y por qué importa en el cronómetro.
- PROHIBIDO usar coletillas o plantillas repetitivas: NUNCA uses "A ver", "Fíjate", "Mira", "Mira esto", "Bueno", "Pues bien", "Vamos a ver", "Piensa un segundo", "Iniciamos el bloque", "Observen", "En esta diapositiva", ni repitas "En ingeniería de competición, esta relación..." en cada página. Varía siempre el inicio y el ritmo de forma orgánica.
- En "say" escribe SOLO español hablado natural (cero Markdown, cero LaTeX). Marca "has_problem": true SOLO si hay un ejercicio numérico real con datos concretos por resolver.

RESPONDE ÚNICAMENTE JSON VÁLIDO siguiendo exactamente esta forma:
{"has_problem":false,"beats":[{"prosody":"warm","say":"En física elemental solemos asumir que el coeficiente de rozamiento es una constante fija: si duplicas el peso sobre un bloque rígido, la fuerza de agarre se duplica exactamente. Sin embargo, el caucho de un neumático de competición es un material viscoelástico cuya adherencia depende de la adhesión molecular y de la deformación por histéresis contra las microrrugosidades del asfalto.","board":{"action":"new","template":"tire_load_curve","mode":"mu_vs_fz","title":"Sensibilidad de μ frente a la carga vertical F_z","layers":["base","curve"],"variables":[{"symbol":"μ","label":"Coeficiente de adherencia","color":"cyan"},{"symbol":"F_z","label":"Carga vertical","color":"amber"}],"formula":"","note":"Al crecer F_z, μ_real cae por debajo de μ_constante"},"pdf_annotations":[],"pointer":null},{"prosody":"key_insight","say":"Conforme cargamos más peso vertical sobre la huella, la goma se satura progresivamente y la superficie efectiva de contacto no crece al mismo ritmo que la carga aplicada. Por eso la línea de μ real desciende de manera continua respecto a la horizontal teórica: añadir más carga sigue aumentando el agarre total, pero cada kilo extra rinde menos que el anterior.","board":{"action":"append","add_layers":["transfer"],"formula":"μ_real < μ_constante","note":"Rendimiento decreciente por cada newton adicional de F_z"},"pdf_annotations":[]},{"prosody":"deliberate","say":"Esta característica no lineal explica una regla de oro en el diseño y el reglaje de cualquier coche rápido: aligerar masa y contener la transferencia de carga en curva siempre aporta agarre neto. Cuando un neumático trabaja más descargado opera en una zona más alta de esta curva, logrando una eficiencia de agarre superior por unidad de peso.","board":{"action":"append","formula":"","note":"Menor masa y menos ΔF_z permiten explotar un μ mayor"},"pdf_annotations":[]}]}`;

const STATIC_DUAL_SCREEN_SYS_EN = `You are a brilliant senior university professor and chief race engineer teaching Vehicle Dynamics in a DUAL-SCREEN CLASSROOM:
- LEFT (PDF): keep clean (0-1 "pdf_annotations" max).
- RIGHT (SCHEMATIC BOARD): always pick ONE of the 12 parametric templates in "board.template" (skip bare covers -> "action":"none") and reveal layers progressively ("action":"new" with "layers" -> "action":"append" with "add_layers"). NEVER invent raw pixel primitives:
  car_side(static|braking|accelerating|aero), car_top(dimensions|cornering|yaw|ackermann), car_front(static|cornering|camber|roll_center), quarter_car, force_balance(horizontal|incline), power_balance(base,resistances,traction,vmax), tire_load_curve(mode:"mu_vs_fz"|"fy_vs_fz"), tire_slip_curve, friction_circle, inertia_body(steiner|car_axes), xy_graph(curves:[{shape:"quadratic"|"cubic"|"linear"|"linear_down"|"constant"|"constant_high"|"inverse"|"concave"|"peak",color,label}], layers:base,curve1,curve2), comparison.
STRICT PDF FIDELITY: Match the EXACT axes, symbols, and concepts on THIS page. NEVER invent formulas that are not on the slide (leave "formula":"" when no equation is shown). Teach deeply and organically in 3 rich beats (3-4 natural sentences each): physical micro-mechanism, intuitive mental example, and real motorsport payoff. NEVER repeat robotic openers or verbal crutches. Write clean Unicode math in "formula" (NO LaTeX backslashes). Reply ONLY with valid JSON:
{"has_problem":false,"beats":[{"prosody":"warm","say":"...","board":{"action":"new","template":"tire_load_curve","mode":"mu_vs_fz","title":"...","layers":["base","curve"],"variables":[],"formula":"","note":"..."},"pdf_annotations":[],"pointer":null}]}`;

function polishProfessorSpeech(raw) {
  let s = String(raw || '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`#]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return '';

  // Strip repetitive AI / chatty Spanish opening crutches cleanly so speech sounds cultivated, organic, and direct
  const crutchRe =
    /^(?:(?:a ver|fíjate(?:\s+bien|\s+en\s+esto|\s+en\s+que|\s+que)?|mira(?:\s+esto|\s+bien|\s+que)?|bueno|pues(?:\s+bien)?|vamos\s+a\s+ver|piensa\s+un\s+segundo|entonces\s+bien|en\s+esta\s+diapositiva|en\s+esta\s+página|vale|okey|ok)[,.:;!\s—–-]+)+/i;
  const stripped = s.replace(crutchRe, '').trim();
  if (stripped.length >= 18) {
    s = stripped.charAt(0).toUpperCase() + stripped.slice(1);
  }
  return s;
}

function cleanSpokenText(raw) {
  return polishProfessorSpeech(raw);
}

export class LookaheadClassEngine {
  constructor({ pdfStage, voiceEngine, sendClient, getRuntimeConfig, cacheDir = '', webResearchAgent = null }) {
    this.pdfStage = pdfStage;
    this.voiceEngine = voiceEngine;
    this.sendClient = sendClient;
    this.getRuntimeConfig = getRuntimeConfig; // () => ({ engine, localModel, localVoice, language, apiKey, webSearch, folderName })
    this.lessonCacheDir = cacheDir ? path.join(cacheDir, 'lesson-cache') : '';
    this.webResearchAgent = webResearchAgent || new WebResearchAgent({ cacheDir, getRuntimeConfig });
    this.lastGpuMetrics = null;

    this.active = false;
    this.paused = false;
    this.qaPaused = false;
    this.prebuffering = false;

    this.pdfDoc = null;
    this.pdfId = '';
    this.pdfName = '';
    this.totalPages = 1;

    // Exact playback cursor (what the student is actually watching & hearing RIGHT NOW)
    this.playedPage = 1;
    this.playedSurface = 'pdf';
    this.playedHistory = []; // Rolling summary of what the student has ALREADY heard (used for Q&A!)
    this.currentProblemTitle = '';

    // Producer cursor (runs 2-3 pages AHEAD of playedPage!)
    this.producerNextPage = 1;
    this.producedUpToPage = 0;
    this.producerRunning = false;
    this.producerAbort = null;
    this.generationId = 0;

    // Ready-to-play atomic AV segments waiting to be sent/played
    this.pendingSegments = []; // segments not yet dispatched to client (held during prebuffer or pause)
    this.inFlightSegments = new Map(); // segId -> { page, surface, transcriptText, problemTitle } sent to client, awaiting ack
    this.seqCounter = 1;

    // Persistent annotations per `${docId}:${page}`
    this.pageAnnotations = new Map();

    // Lookahead tuning: start speaking after ~8.5s of audio runway (~2.5-3.5s load!) while streaming 5 pages ahead!
    this.initialPreloadPages = 2;
    this.lookaheadPages = 5;

    // Anti-Freeze Playback Watchdog state
    this.watchdogTimer = null;
    this.activeSegId = null;
    this.activeSegDeadlineAt = 0;
    this.lastActivityAt = Date.now();
    this.stallRecoveryCount = 0;
  }

  startWatchdog() {
    if (this.watchdogTimer) return;
    this.watchdogTimer = setInterval(() => {
      if (!this.active || this.paused || this.qaPaused) return;
      const now = Date.now();

      // 1. Auto-unlock if prebuffering stalled with buffered segments ready
      if (this.prebuffering && this.pendingSegments.length > 0 && !this.producerRunning) {
        this.prebuffering = false;
        this.emitState();
        this.flushPendingToClient();
        this.ensureProducerLoop();
        return;
      }

      if (this.prebuffering) return;

      // 2. Auto-flush any pending segments that haven't been dispatched yet
      if (this.pendingSegments.length > 0 && this.inFlightSegments.size < 12) {
        this.flushPendingToClient();
      }

      // 3. Auto-restart producer if idle and buffer below lookahead target
      if (!this.producerRunning && this.producerNextPage <= this.totalPages) {
        const pagesAhead = this.producedUpToPage - this.playedPage;
        if (pagesAhead < this.lookaheadPages) {
          this.ensureProducerLoop();
        }
      }

      // 4. Detect a stuck playing beat well past its audio duration + grace period -> nudge client!
      if (this.inFlightSegments.size > 0 && this.activeSegDeadlineAt > 0 && now > this.activeSegDeadlineAt) {
        this.stallRecoveryCount++;
        console.warn(
          `[ClassEngine Watchdog] Beat atascado detectado en Pág. ${this.playedPage} (seg=${this.activeSegId}, #${this.stallRecoveryCount}) -> enviando pulso de destrabe`,
        );
        this.activeSegDeadlineAt = now + 12000;
        this.sendClient({
          type: 'timeline_nudge',
          segId: this.activeSegId,
          page: this.playedPage,
          reason: 'Watchdog anti-bloqueo',
        });
      }
    }, 4000);
    if (typeof this.watchdogTimer.unref === 'function') {
      this.watchdogTimer.unref();
    }
  }

  stopWatchdog() {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    this.activeSegId = null;
    this.activeSegDeadlineAt = 0;
  }

  getPublicState() {
    const pagesAhead = Math.max(0, this.producedUpToPage - this.playedPage);
    return {
      active: this.active,
      paused: this.paused,
      qaPaused: this.qaPaused,
      prebuffering: this.prebuffering,
      surface: this.playedSurface,
      pdfId: this.pdfId,
      pdfName: this.pdfName,
      currentPage: this.playedPage,
      totalPages: this.totalPages,
      problemActive: this.playedSurface === 'canvas' && Boolean(this.currentProblemTitle),
      problemTitle: this.currentProblemTitle,
      producedUpToPage: this.producedUpToPage,
      bufferedPagesAhead: pagesAhead,
      queuedSegments: this.pendingSegments.length + this.inFlightSegments.size,
    };
  }

  emitState() {
    this.sendClient({ type: 'class_state', state: this.getPublicState() });
  }

  getAnnotationsFor(docId, page) {
    return this.pageAnnotations.get(`${docId}:${page}`) || [];
  }

  clearAnnotationsFor(docId, page) {
    const dId = docId || this.pdfId;
    const p = Number(page || this.playedPage);
    const key = `${dId}:${p}`;
    this.pageAnnotations.set(key, []);
    this.sendClient({
      type: 'stage_pdf_annotations',
      data: {
        docId: dId,
        page: p,
        vbW: 1000,
        vbH: 750,
        annotations: [],
        newlyAddedCount: 0,
        clearPrevious: true,
      },
    });
  }

  getPlayedContextSummary() {
    const recent = this.playedHistory.slice(-6).join(' ');
    return `Página actual del PDF que está viendo el alumno: Página ${this.playedPage}/${this.totalPages} de "${this.pdfName}" (superficie: ${this.playedSurface}). Último contenido explicado al alumno: ${recent.slice(-900)}`;
  }

  abortProducerOnly() {
    if (this.producerAbort) {
      try {
        this.producerAbort.abort();
      } catch {}
      this.producerAbort = null;
    }
    this.producerRunning = false;
  }

  stop() {
    this.generationId++;
    this.stopWatchdog();
    this.abortProducerOnly();
    this.active = false;
    this.paused = false;
    this.qaPaused = false;
    this.prebuffering = false;
    this.pendingSegments = [];
    this.inFlightSegments.clear();
    this.sendClient({ type: 'timeline_flush' });
    this.emitState();
  }

  pause(reason = 'Clase pausada') {
    this.abortProducerOnly();
    this.paused = true;
    this.prebuffering = false;
    // Put unacknowledged in-flight segments back at the front? Better: pause cleanly and let resume continue from playedPage or remaining pending!
    this.sendClient({ type: 'timeline_pause' });
    this.emitState();
    this.sendClient({ type: 'tool_status', label: `⏸ ${reason}. Pulsa "Reanudar Clase" o di "sigue" para continuar justo donde lo dejamos.` });
  }

  pauseForQuestion() {
    if (!this.active) return;
    // Abort background lookahead immediately so Ollama GPU is 100% free for instant Q&A!
    this.abortProducerOnly();
    this.qaPaused = true;
    this.prebuffering = false;
    this.sendClient({ type: 'timeline_pause' });
    this.emitState();
  }

  async resume() {
    if (!this.pdfDoc) return;
    this.active = true;
    this.paused = false;
    this.qaPaused = false;
    this.lastActivityAt = Date.now();
    this.startWatchdog();
    this.emitState();
    this.sendClient({ type: 'tool_status', label: `▶ Reanudando clase sincronizada desde Página ${this.playedPage}/${this.totalPages}...` });
    this.sendClient({ type: 'timeline_resume' });
    this.flushPendingToClient();
    this.ensureProducerLoop();
  }

  skipCurrentBeat() {
    if (!this.active) return { ok: false, reason: 'No active class' };
    this.paused = false;
    this.qaPaused = false;
    this.lastActivityAt = Date.now();
    this.activeSegDeadlineAt = 0;
    this.sendClient({ type: 'timeline_skip_beat' });
    this.flushPendingToClient();
    this.ensureProducerLoop();
    return { ok: true, page: this.playedPage };
  }

  async skipProblemAndAdvance() {
    if (!this.pdfDoc) return { ok: false, reason: 'No PDF loaded' };
    const nextPage = Math.min(this.totalPages, this.playedPage + 1);
    return await this.jumpToPage({ page: nextPage, startPlaying: true });
  }

  onClientHealthCheck(msg = {}) {
    if (!this.active || this.paused || this.qaPaused) return;
    this.lastActivityAt = Date.now();
    const clientQueueLen = Number(msg.clientQueueLen ?? 0);
    const clientPlaying = Boolean(msg.playingSegId);

    // Self-heal zombie inFlightSegments: if the browser says its queue & player are BOTH completely empty
    // while the server thinks segments are still "in flight", clear the stale entries and resume cleanly!
    if (!clientPlaying && clientQueueLen === 0 && this.inFlightSegments.size > 0) {
      console.warn(
        `[ClassEngine Self-Heal] Sincronizando cola desfasada en Pág. ${this.playedPage} (inFlight=${this.inFlightSegments.size}, pending=${this.pendingSegments.length})`,
      );
      this.inFlightSegments.clear();
      this.activeSegId = null;
      this.activeSegDeadlineAt = 0;
      if (this.pendingSegments.length > 0) {
        this.prebuffering = false;
        this.flushPendingToClient();
        this.ensureProducerLoop();
        this.emitState();
        return;
      }
      // If everything for current page was already consumed & dropped, jump cleanly to next page (or retry current)
      const nextTarget = this.producedUpToPage >= this.playedPage && this.playedPage < this.totalPages ? this.playedPage + 1 : this.playedPage;
      this.jumpToPage({ page: nextTarget, startPlaying: true }).catch(() => {});
      return;
    }

    if (this.pendingSegments.length > 0 && !this.prebuffering) {
      this.flushPendingToClient();
    }
    this.ensureProducerLoop();
  }

  async verifyAndRecover({ autoFix = true } = {}) {
    const cfg = this.getRuntimeConfig();
    let ollamaOk = false;
    let ollamaModels = [];
    try {
      const r = await fetch(`${OLLAMA_HOST}/api/tags`, { signal: AbortSignal.timeout(2500) });
      if (r.ok) {
        const d = await r.json();
        ollamaOk = true;
        ollamaModels = (d.models || []).map((m) => m.name);
      }
    } catch {}

    const report = {
      ok: true,
      active: this.active,
      paused: this.paused,
      qaPaused: this.qaPaused,
      prebuffering: this.prebuffering,
      playedPage: this.playedPage,
      producedUpToPage: this.producedUpToPage,
      totalPages: this.totalPages,
      pendingSegments: this.pendingSegments.length,
      inFlightSegments: this.inFlightSegments.size,
      producerRunning: this.producerRunning,
      ollamaOk,
      model: cfg.localModel || 'gemma4:12b',
      kokoroReady: Boolean(this.voiceEngine?.capabilities?.kokoro),
      actionsTaken: [],
    };

    if (autoFix && this.pdfDoc) {
      this.active = true;
      this.paused = false;
      this.qaPaused = false;
      this.startWatchdog();
      if (this.prebuffering && this.pendingSegments.length > 0) {
        this.prebuffering = false;
        report.actionsTaken.push('desbloqueado prebuffer');
      }
      if (this.pendingSegments.length > 0) {
        this.flushPendingToClient();
        this.sendClient({ type: 'timeline_resume' });
        report.actionsTaken.push(`enviados ${this.inFlightSegments.size} bloques al navegador`);
      } else if (this.inFlightSegments.size > 0) {
        // Re-sync cleanly from current page (hits instant disk cache if already generated!)
        report.actionsTaken.push(`re-sincronizada Pág. ${this.playedPage} desde caché`);
        await this.jumpToPage({ page: this.playedPage, startPlaying: true });
      } else {
        this.producerNextPage = Math.max(this.playedPage, this.producerNextPage);
        this.ensureProducerLoop();
        report.actionsTaken.push(`reactivado productor desde Pág. ${this.producerNextPage}`);
      }
      this.emitState();
    }

    const summary = `✓ Verificación: Ollama=${ollamaOk ? 'OK' : 'OFF'} · Kokoro=${report.kokoroReady ? 'OK' : 'macOS'} · Pág. ${this.playedPage}/${this.totalPages} (Buffer +${Math.max(0, this.producedUpToPage - this.playedPage)} págs)${report.actionsTaken.length ? ` · Acción: ${report.actionsTaken.join(', ')}` : ''}`;
    this.sendClient({ type: 'tool_status', label: summary });
    return { ...report, summary };
  }

  async jumpToPage({ docId, filename, page, delta, startPlaying = true } = {}) {
    const doc =
      (docId && this.pdfStage.resolvePdfDoc(docId)) ||
      (filename && this.pdfStage.resolvePdfDoc(filename)) ||
      this.pdfDoc ||
      this.pdfStage.resolvePdfDoc();
    if (!doc) return { ok: false, error: 'No PDF found.' };

    const total = await this.pdfStage.getPageCount(doc);
    const target = Math.max(
      1,
      Math.min(total, delta != null ? this.playedPage + Math.trunc(Number(delta)) : Math.trunc(Number(page) || 1)),
    );

    // Reset lookahead queue cleanly to the new target page!
    this.generationId++;
    this.abortProducerOnly();
    this.pendingSegments = [];
    this.inFlightSegments.clear();
    this.sendClient({ type: 'timeline_flush' });

    this.pdfDoc = doc;
    this.pdfId = doc.id;
    this.pdfName = doc.name;
    this.totalPages = total;
    this.playedPage = target;
    this.playedSurface = 'pdf';
    this.currentProblemTitle = '';
    this.producerNextPage = target;
    this.producedUpToPage = target - 1;

    const bundle = await this.pdfStage.getPageBundle(doc, target, { includeVision: false });
    this.sendClient({
      type: 'stage_pdf_page',
      data: {
        docId: bundle.docId,
        name: bundle.name,
        page: bundle.page,
        totalPages: bundle.totalPages,
        imageUrl: bundle.imageUrl,
        vbW: bundle.vbW,
        vbH: bundle.vbH,
        hasExampleProblem: bundle.hasExampleProblem,
        reason: `Página ${target}/${total}`,
        annotations: this.getAnnotationsFor(doc.id, target),
      },
    });

    if (startPlaying && this.active) {
      this.paused = false;
      this.qaPaused = false;
      this.prebuffering = true;
      this.activeSegId = null;
      this.activeSegDeadlineAt = 0;
      this.startWatchdog();
      this.emitState();
      this.ensureProducerLoop();
    } else {
      this.emitState();
    }

    return { ok: true, page: target, totalPages: total, filename: doc.name };
  }

  async startClass({ pdfId, docId, filename, startPage, startTopic } = {}) {
    this.generationId++;
    this.abortProducerOnly();
    this.pendingSegments = [];
    this.inFlightSegments.clear();
    this.playedHistory = [];
    this.sendClient({ type: 'timeline_flush' });

    const doc = this.pdfStage.resolvePdfDoc(pdfId || docId || filename);
    if (!doc) {
      this.sendClient({
        type: 'error',
        message: 'No se encontró ningún PDF en esta carpeta. Sube un PDF para usar el Modo Clase Continua.',
      });
      return { ok: false };
    }

    const total = await this.pdfStage.getPageCount(doc);
    let initialPage = Number(startPage);
    if (!Number.isFinite(initialPage) || initialPage < 1) {
      initialPage = startTopic ? await this.pdfStage.findTopicPage(doc, startTopic) : 1;
    }
    initialPage = Math.max(1, Math.min(total, Math.trunc(initialPage)));

    this.active = true;
    this.paused = false;
    this.qaPaused = false;
    this.prebuffering = true;
    this.pdfDoc = doc;
    this.pdfId = doc.id;
    this.pdfName = doc.name;
    this.totalPages = total;
    this.startPageOfClass = initialPage;
    this.lastProducedSummary = '';
    this.playedPage = initialPage;
    this.playedSurface = 'pdf';
    this.currentProblemTitle = '';
    this.producerNextPage = initialPage;
    this.producedUpToPage = initialPage - 1;

    // Immediately show the opening PDF page cleanly while we pre-buffer pages P and P+1!
    const openingBundle = await this.pdfStage.getPageBundle(doc, initialPage, { includeVision: false });
    this.sendClient({
      type: 'stage_pdf_page',
      data: {
        docId: openingBundle.docId,
        name: openingBundle.name,
        page: openingBundle.page,
        totalPages: openingBundle.totalPages,
        imageUrl: openingBundle.imageUrl,
        vbW: openingBundle.vbW,
        vbH: openingBundle.vbH,
        hasExampleProblem: openingBundle.hasExampleProblem,
        reason: `Preparando clase desde Pág. ${initialPage}/${total}...`,
        annotations: this.getAnnotationsFor(doc.id, initialPage),
      },
    });

    const pagesToPreload = Math.min(this.initialPreloadPages, total - initialPage + 1);
    this.sendClient({
      type: 'class_buffer_status',
      prebuffering: true,
      readyPages: 0,
      targetPages: pagesToPreload,
      message: `Preparando clase por adelantado (Págs. ${initialPage}${pagesToPreload > 1 ? ` y ${initialPage + 1}` : ''}) para sincronización exacta sin silencios...`,
    });
    this.emitState();

    // Launch background lookahead producer + anti-freeze watchdog (non-blocking)
    this.activeSegId = null;
    this.activeSegDeadlineAt = 0;
    this.startWatchdog();
    this.ensureProducerLoop();
    return { ok: true, page: initialPage, totalPages: total };
  }

  /**
   * Called by the browser at the EXACT moment a timeline segment starts or finishes playing!
   */
  onClientTimelineEvent(msg) {
    this.lastActivityAt = Date.now();
    if (msg.event === 'start' && msg.segId) {
      const meta = this.inFlightSegments.get(msg.segId);
      if (meta) {
        this.playedPage = meta.page;
        this.playedSurface = meta.surface;
        this.currentProblemTitle = meta.problemTitle || '';
        this.activeSegId = msg.segId;
        this.activeSegDeadlineAt = Date.now() + Math.max(8000, Number(meta.durationMs || 8000)) + 10000;
        this.emitState();
      }
      return;
    }

    if (msg.event === 'end' && msg.segId) {
      if (this.activeSegId === msg.segId) {
        this.activeSegId = null;
        this.activeSegDeadlineAt = 0;
      }
      const meta = this.inFlightSegments.get(msg.segId);
      if (meta) {
        this.playedPage = meta.page;
        this.playedSurface = meta.surface;
        if (meta.transcriptText) {
          this.playedHistory.push(`[Pág.${meta.page}] ${meta.transcriptText}`);
          if (this.playedHistory.length > 24) this.playedHistory.shift();
        }
        this.inFlightSegments.delete(msg.segId);
      }

      // Check if we finished the entire PDF cleanly
      if (
        this.active &&
        !this.producerRunning &&
        this.producerNextPage > this.totalPages &&
        this.pendingSegments.length === 0 &&
        this.inFlightSegments.size === 0
      ) {
        this.active = false;
        this.emitState();
        this.sendClient({
          type: 'tool_status',
          label: `🎓 Fin del documento "${this.pdfName}" (Pág. ${this.totalPages}/${this.totalPages}). ¡Clase completada!`,
        });
        return;
      }

      this.emitState();
      this.flushPendingToClient();
      this.ensureProducerLoop();
    }
  }

  flushPendingToClient() {
    if (!this.active || this.paused || this.qaPaused || this.prebuffering) return;
    // Keep up to 12 segments queued smoothly on the client for 0ms transitions without overloading browser memory
    while (this.pendingSegments.length > 0 && this.inFlightSegments.size < 12) {
      const seg = this.pendingSegments.shift();
      this.inFlightSegments.set(seg.id, {
        page: seg.page,
        surface: seg.surface,
        transcriptText: seg.transcriptText,
        problemTitle: seg.problemTitle || '',
        durationMs: seg.durationMs || 5000,
      });
      this.sendClient({ type: 'timeline_segment', segment: seg });
    }
  }

  ensureProducerLoop() {
    if (!this.active || this.paused || this.qaPaused) return;
    if (this.producerRunning) return;
    if (this.producerNextPage > this.totalPages) return;

    const pagesAhead = this.producedUpToPage - this.playedPage;
    if (!this.prebuffering && pagesAhead >= this.lookaheadPages) {
      return; // Buffer is already full (+3 pages ready ahead!)
    }

    const myGen = this.generationId;
    this.producerRunning = true;
    this.runProducerLoop(myGen).catch((err) => {
      if (err?.name !== 'AbortError') {
        console.error('[LookaheadClassEngine producer error]', err);
        this.sendClient({ type: 'error', message: `Error preparando página ${this.producerNextPage}: ${err.message}` });
      }
      if (myGen === this.generationId) {
        this.producerRunning = false;
        this.prebuffering = false;
        this.emitState();
      }
    });
  }

  async runProducerLoop(myGen) {
    const startPageOfRun = this.playedPage;
    const preloadTarget = Math.min(this.initialPreloadPages, this.totalPages - startPageOfRun + 1);

    while (myGen === this.generationId && this.active && !this.paused && !this.qaPaused) {
      if (this.producerNextPage > this.totalPages) break;
      const pagesAhead = this.producedUpToPage - this.playedPage;
      if (!this.prebuffering && pagesAhead >= this.lookaheadPages) break;

      const targetPage = this.producerNextPage;
      const readyBefore = Math.max(0, this.producedUpToPage - startPageOfRun + 1);
      let beatsEmittedOnThisPage = 0;

      if (this.prebuffering) {
        this.sendClient({
          type: 'class_buffer_status',
          prebuffering: true,
          readyPages: readyBefore,
          targetPages: preloadTarget,
          message: `Preparando Página ${targetPage}/${this.totalPages} (guión, pizarra y voz Kokoro)... [${readyBefore}/${preloadTarget} págs listas]`,
        });
      }

      const onSegmentReady = (seg) => {
        if (myGen !== this.generationId || !this.active || this.paused || this.qaPaused) return;
        beatsEmittedOnThisPage++;
        this.pendingSegments.push(seg);
        if (this.prebuffering) {
          const bufferedNowMs = this.pendingSegments.reduce((acc, s) => acc + (s.durationMs || 0), 0);
          // Fluid ultra-fast start: as soon as >=8.5s of spoken audio (and >=2 beats) are buffered,
          // start playback immediately (~2.5-3.5s!) while the M4 Pro GPU keeps streaming 5 pages ahead!
          if (bufferedNowMs >= 8500 && (beatsEmittedOnThisPage >= 2 || readyBefore >= 1)) {
            this.prebuffering = false;
            this.sendClient({
              type: 'class_buffer_status',
              prebuffering: false,
              readyPages: Math.max(1, readyBefore),
              targetPages: preloadTarget,
              message: `✓ ${Math.round(bufferedNowMs / 1000)}s listos en streaming. ¡Empezando clase mientras se preparan las siguientes páginas!`,
            });
            this.emitState();
            this.flushPendingToClient();
          } else {
            this.sendClient({
              type: 'class_buffer_status',
              prebuffering: true,
              readyPages: readyBefore + Math.min(0.85, beatsEmittedOnThisPage * 0.35),
              targetPages: preloadTarget,
              message: `Preparando Página ${targetPage}/${this.totalPages} (bloque ${beatsEmittedOnThisPage} listo)...`,
            });
          }
        } else {
          // Stream ready beats straight to the browser IMMEDIATELY so the student NEVER waits!
          this.flushPendingToClient();
        }
      };

      try {
        await this.produceCompletePageSegments(targetPage, myGen, { onSegmentReady });
      } catch (err) {
        if (err?.name === 'AbortError' || myGen !== this.generationId) return;
        console.error(`[ClassEngine] Error en Página ${targetPage} (recuperando sin detener clase):`, err.message);
        // Never leave the student in permanent silence: synthesize a smooth fallback beat and keep going!
        const cfg = this.getRuntimeConfig();
        const fbText = `Continuamos con la página ${targetPage} del documento, revisando los conceptos proyectados a la izquierda antes de avanzar.`;
        const fbAudio = await this.synthesizeSegmentAudio(fbText, cfg, { speed: 1.03 });
        if (myGen !== this.generationId) return;
        const bundle = await this.pdfStage.getPageBundle(this.pdfDoc, targetPage, { includeVision: false }).catch(() => null);
        onSegmentReady({
          id: `seg-${this.seqCounter++}`,
          page: targetPage,
          surface: 'split',
          isPageStart: true,
          prosody: 'warm',
          pauseAfterMs: 450,
          onStartEvents: bundle
            ? [
                {
                  type: 'stage_pdf_page',
                  data: {
                    docId: bundle.docId,
                    name: bundle.name,
                    page: bundle.page,
                    totalPages: bundle.totalPages,
                    imageUrl: bundle.imageUrl,
                    vbW: bundle.vbW,
                    vbH: bundle.vbH,
                    hasExampleProblem: false,
                    reason: `Clase en vivo · Página ${bundle.page} de ${bundle.totalPages}`,
                    annotations: [],
                  },
                },
              ]
            : [],
          transcriptText: fbText,
          audioBase64: fbAudio.pcmBase64,
          sampleRate: fbAudio.sampleRate,
          durationMs: fbAudio.durationMs,
        });
      }

      if (myGen !== this.generationId || !this.active || this.paused || this.qaPaused) return;

      this.producedUpToPage = targetPage;
      this.producerNextPage = targetPage + 1;

      const readyNow = Math.max(0, this.producedUpToPage - startPageOfRun + 1);
      const bufferedAudioMs = this.pendingSegments.reduce((acc, s) => acc + (s.durationMs || 0), 0);

      // Start playback as soon as 2 pages are ready OR Page 1 already has >=8.5s of spoken audio ready!
      const hasEnoughRunway = readyNow >= preloadTarget || (readyNow >= 1 && bufferedAudioMs >= 8500);
      if (this.prebuffering && (hasEnoughRunway || this.producerNextPage > this.totalPages)) {
        this.prebuffering = false;
        this.sendClient({
          type: 'class_buffer_status',
          prebuffering: false,
          readyPages: readyNow,
          targetPages: preloadTarget,
          message: `✓ ${readyNow} página(s) listas (${Math.round(bufferedAudioMs / 1000)}s de colchón). ¡Empezando clase!`,
        });
      }

      this.emitState();
      this.flushPendingToClient();
    }

    if (myGen === this.generationId) {
      this.producerRunning = false;
      this.emitState();
    }
  }

  /**
   * Smart best-line fallback matcher when LLM slightly paraphrases target_text
   */
  findBestLineForText(layout, queryText, usedLineIndices = new Set()) {
    const lines = layout?.lines || [];
    if (!lines.length || !queryText) return null;
    const stop = new Set(['el', 'la', 'los', 'las', 'de', 'del', 'en', 'un', 'una', 'y', 'o', 'que', 'por', 'para', 'con', 'se', 'es', 'al', 'su', 'sus', 'como', 'mas', 'este', 'esta', 'the', 'and', 'of', 'in', 'to', 'is', 'a', 'for']);
    const tokens = String(queryText)
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !stop.has(t));
    if (!tokens.length) return null;

    let bestIdx = -1;
    let bestScore = 0;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      // Skip tiny page numbers or author footer lines near bottom
      if (!ln.text || ln.text.length < 4 || ln.y > (layout.vbH || 750) * 0.87) continue;
      // Skip generic top course header if other lines exist
      const low = ln.norm || '';
      if (low.includes('breno oliveira')) continue;
      let score = 0;
      for (const t of tokens) {
        if (low.includes(t)) score += t.length >= 6 ? 3 : 2;
      }
      if (usedLineIndices.has(i)) score *= 0.35;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx === -1 || bestScore < 2) return null;
    usedLineIndices.add(bestIdx);
    const ln = lines[bestIdx];
    return {
      x: ln.x,
      y: ln.y,
      w: ln.w,
      h: ln.h,
      cx: Math.round(ln.x + ln.w / 2),
      cy: Math.round(ln.y + ln.h / 2),
      matchedText: ln.text,
    };
  }

  /**
   * Resolves a list of raw annotation objects against a PDF page's exact pdftotext -bbox layout.
   */
  resolveAnnotationsForBundle(
    bundle,
    rawAnns,
    existingCount,
    fallbackSpeech = '',
    usedLineIndices = new Set(),
    { allowAutoFallback = false } = {},
  ) {
    const resolved = [];
    const { vbW, vbH, layout } = bundle;
    for (const raw of Array.isArray(rawAnns) ? rawAnns : []) {
      if (!raw || typeof raw !== 'object') continue;
      const kind = String(raw.kind || 'highlight').toLowerCase();
      const color = ['cyan', 'amber', 'emerald', 'rose'].includes(raw.color) ? raw.color : 'amber';
      const item = {
        id: `ann-p${bundle.page}-${existingCount + resolved.length}-${Math.random().toString(36).slice(2, 5)}`,
        kind,
        color,
        label: raw.label ? String(raw.label).slice(0, 80) : '',
        target_text: raw.target_text ? String(raw.target_text) : '',
        snapped: false,
      };

      const anchor =
        (raw.target_text ? this.pdfStage.resolveTextAnchor(layout, raw.target_text) : null) ||
        (raw.target_text ? this.findBestLineForText(layout, raw.target_text, usedLineIndices) : null);
      if (anchor) {
        item.x = anchor.x;
        item.y = anchor.y;
        item.w = anchor.w;
        item.h = anchor.h;
        item.cx = anchor.cx;
        item.cy = anchor.cy;
        item.snapped = true;
      } else {
        const clampX = (v) => Math.max(12, Math.min(vbW - 12, Number(v)));
        const clampY = (v) => Math.max(12, Math.min(vbH - 12, Number(v)));
        if (Number.isFinite(Number(raw.x))) item.x = clampX(raw.x);
        if (Number.isFinite(Number(raw.y))) item.y = clampY(raw.y);
        if (Number.isFinite(Number(raw.w))) item.w = Math.max(20, Math.min(vbW, Number(raw.w)));
        if (Number.isFinite(Number(raw.h))) item.h = Math.max(16, Math.min(vbH, Number(raw.h)));
        if (Number.isFinite(Number(raw.x1))) item.x1 = clampX(raw.x1);
        if (Number.isFinite(Number(raw.y1))) item.y1 = clampY(raw.y1);
        if (Number.isFinite(Number(raw.x2))) item.x2 = clampX(raw.x2);
        if (Number.isFinite(Number(raw.y2))) item.y2 = clampY(raw.y2);
      }

      if ((kind === 'arrow' || kind === 'callout') && item.snapped) {
        if (!Number.isFinite(item.x2)) item.x2 = item.cx;
        if (!Number.isFinite(item.y2)) item.y2 = item.cy;
        if (!Number.isFinite(item.x1)) {
          item.x1 = item.cx < vbW * 0.55 ? Math.min(vbW - 110, item.x + item.w + 75) : Math.max(110, item.x - 75);
        }
        if (!Number.isFinite(item.y1)) {
          item.y1 = item.cy > 90 ? item.y - 38 : item.y + item.h + 44;
        }
      }

      if (kind === 'vector') {
        if (!Number.isFinite(item.x1)) item.x1 = item.cx ?? vbW * 0.45;
        if (!Number.isFinite(item.y1)) item.y1 = item.cy ?? vbH * 0.5;
        if (!Number.isFinite(item.x2)) item.x2 = item.x1;
        if (!Number.isFinite(item.y2)) item.y2 = Math.min(vbH - 25, item.y1 + 95);
      }

      if (Number.isFinite(item.x) || (Number.isFinite(item.x1) && Number.isFinite(item.x2))) {
        resolved.push(item);
      }
    }

    // Only add an automatic highlight cue if explicitly allowed (never spam underlines when drawing on the chalkboard!)
    if (allowAutoFallback && resolved.length === 0 && fallbackSpeech && (layout?.lines?.length || 0) >= 2) {
      const autoAnchor = this.findBestLineForText(layout, fallbackSpeech, usedLineIndices);
      if (autoAnchor) {
        const kinds = ['highlight', 'underline', 'circle'];
        const colors = ['amber', 'cyan', 'emerald'];
        resolved.push({
          id: `ann-auto-p${bundle.page}-${existingCount}`,
          kind: kinds[existingCount % kinds.length],
          color: colors[existingCount % colors.length],
          label: '',
          x: autoAnchor.x,
          y: autoAnchor.y,
          w: autoAnchor.w,
          h: autoAnchor.h,
          cx: autoAnchor.cx,
          cy: autoAnchor.cy,
          snapped: true,
        });
      }
    }

    return resolved;
  }

  async synthesizeSegmentAudio(text, cfg, { speed = 1.03 } = {}) {
    const clean = cleanSpokenText(text);
    if (!clean) return { pcmBase64: '', sampleRate: 24000, durationMs: 600 };
    const audio = await this.voiceEngine.synthesize(clean, {
      voiceId: cfg.localVoice || 'kokoro:em_alex',
      language: cfg.language || 'es',
      speed,
    });
    const pcmBase64 = audio.ok && audio.pcmBase64 ? audio.pcmBase64 : '';
    const sr = audio.sampleRate || 24000;
    const pcmBytes = Math.floor(pcmBase64.length * 0.75);
    const durationMs = pcmBytes > 0 ? Math.round((pcmBytes / (sr * 2)) * 1000) : Math.max(1200, clean.length * 55);
    return { pcmBase64, sampleRate: sr, durationMs };
  }

  /**
   * Calls Local Ollama (with real NDJSON streaming + incremental beat extraction!) or Gemini REST
   * to author a synchronized multi-beat script for ONE page.
   */
  async callStructuredLessonLlm({ systemPrompt, userPrompt, visionBase64, myGen, onBeat = null, maxTokens = 1400 }) {
    const cfg = this.getRuntimeConfig();
    this.producerAbort = new AbortController();

    // Cloud Gemini Interactions API (Gemini 4 Hydrogen / Argon / Neon / Carbon / 3.5 Flash-Lite)
    // With automatic transient 503/429 fallback across current non-deprecated models so class never stalls!
    if (cfg.engine === 'gemini' && cfg.apiKey) {
      const ai = new GoogleGenAI({ apiKey: cfg.apiKey });
      const primaryModel = normalizeGeminiClassModelId(cfg.geminiClassModel);
      const fallbackOrder = [...new Set([primaryModel, 'gemini-4-hydrogen', 'gemini-3.5-flash-lite', 'gemini-4-argon'])];
      const input = visionBase64
        ? [
            { type: 'image', data: visionBase64, mime_type: 'image/jpeg' },
            { type: 'text', text: userPrompt },
          ]
        : userPrompt;

      let lastErr = null;
      for (const candidateModel of fallbackOrder) {
        if (myGen !== this.generationId) return null;
        try {
          const interaction = await ai.interactions.create({
            model: candidateModel,
            system_instruction: systemPrompt,
            input,
            store: false,
            generation_config: {
              max_output_tokens: maxTokens,
            },
          });
          if (myGen !== this.generationId) return null;
          const raw = interaction?.output_text || '';
          return parseLooseJson(raw);
        } catch (err) {
          lastErr = err;
          const msg = String(err?.message || err);
          const isTransient = /\b(503|429|500|UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded)\b/i.test(msg);
          if (!isTransient) throw err;
          console.warn(`[ClassEngine Gemini] ${candidateModel} saturado (503/429) — cambiando al siguiente modelo actual...`);
        }
      }
      throw lastErr || new Error('Gemini Interactions API unavailable');
    }

    // Local $0 Ollama streaming JSON call (Prefix KV-Cache friendly + overlapped beat streaming!)
    const model = cfg.localModel || 'qwen3.5:9b';
    const caps = await getOllamaModelCapabilities(model);
    const useVision = Boolean(caps.vision && visionBase64);

    const userMsg = { role: 'user', content: userPrompt };
    if (useVision) userMsg.images = [visionBase64];

    // Note: Do NOT pass `format: "json"` to Ollama — Ollama's Apple Silicon MLX runner (gemma4/qwen3.5)
    // returns HTTP 501 {"error":"structured output is unavailable"} when `format` is set!
    const body = {
      model,
      stream: true,
      keep_alive: '30m',
      messages: [
        { role: 'system', content: systemPrompt },
        userMsg,
      ],
      options: {
        num_gpu: 99,
        num_ctx: cfg.webSearch ? 5120 : 4096,
        num_predict: maxTokens,
        temperature: 0.45,
      },
    };
    if (/qwen3|gemma4|deepseek/i.test(model)) {
      body.think = false;
    }

    const timeoutHandle = setTimeout(() => {
      try {
        this.producerAbort?.abort();
      } catch {}
    }, 65000);

    try {
      let res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: this.producerAbort.signal,
        body: JSON.stringify(body),
      });

      // Auto-fallback if model rejects vision image
      if (!res.ok) {
        const errText = await res.text();
        if (/image input is not supported|mmproj|vision/i.test(errText) && userMsg.images) {
          delete userMsg.images;
          res = await fetch(`${OLLAMA_HOST}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            signal: this.producerAbort.signal,
            body: JSON.stringify(body),
          });
        } else {
          throw new Error(`Ollama JSON error (${res.status}): ${errText.slice(0, 220)}`);
        }
      }
      if (!res.ok) throw new Error(`Ollama JSON error (${res.status})`);
      if (myGen !== this.generationId) return null;

      // Stream NDJSON lines and extract beats incrementally as soon as each beat's `}` closes!
      const parser = onBeat ? new IncrementalBeatStreamParser(onBeat) : null;
      const reader = res.body?.getReader?.();
      if (!reader) {
        const data = await res.json();
        return parseLooseJson(data.message?.content || '');
      }

      const decoder = new TextDecoder();
      let lineBuf = '';
      let fullContent = '';

      while (true) {
        if (myGen !== this.generationId) {
          try { await reader.cancel(); } catch {}
          return null;
        }
        const { value, done } = await reader.read();
        if (done) break;
        lineBuf += decoder.decode(value, { stream: true });
        let nlIdx;
        while ((nlIdx = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, nlIdx).trim();
          lineBuf = lineBuf.slice(nlIdx + 1);
          if (!line) continue;
          try {
            const chunk = JSON.parse(line);
            const delta = chunk.message?.content || '';
            if (delta) {
              fullContent += delta;
              if (parser) parser.push(delta);
            }
            if (chunk.done && chunk.eval_count && chunk.eval_duration) {
              this.lastGpuMetrics = {
                decodeTps: Number((chunk.eval_count / (chunk.eval_duration / 1e9)).toFixed(1)),
                prefillTps:
                  chunk.prompt_eval_count && chunk.prompt_eval_duration
                    ? Number((chunk.prompt_eval_count / (chunk.prompt_eval_duration / 1e9)).toFixed(0))
                    : null,
                evalTokens: chunk.eval_count,
              };
            }
          } catch {}
        }
      }
      if (lineBuf.trim()) {
        try {
          const chunk = JSON.parse(lineBuf.trim());
          const delta = chunk.message?.content || '';
          if (delta) {
            fullContent += delta;
            if (parser) parser.push(delta);
          }
        } catch {}
      }

      return parseLooseJson(fullContent);
    } finally {
      clearTimeout(timeoutHandle);
    }
  }

  async getLessonCachePath(doc, pageNumber, cfg) {
    if (!this.lessonCacheDir || !doc?.fullPath) return '';
    try {
      const stat = await fs.stat(doc.fullPath);
      const modelId = cfg.engine === 'gemini' ? normalizeGeminiClassModelId(cfg.geminiClassModel) : cfg.localModel || 'qwen3.5:9b';
      const webFlag = cfg.webSearch ? 'web1' : 'web0';
      const sig = `${doc.relPath || doc.name}|${Math.floor(stat.mtimeMs)}|p${pageNumber}|${modelId}|${cfg.language || 'es'}|${webFlag}|${LESSON_CACHE_VERSION}`;
      const hash = crypto.createHash('sha1').update(sig).digest('hex').slice(0, 20);
      return path.join(this.lessonCacheDir, `${hash}.json`);
    } catch {
      return '';
    }
  }

  async readCachedPagePlan(cachePath) {
    if (!cachePath) return null;
    try {
      const raw = await fs.readFile(cachePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.plan && Array.isArray(parsed.plan.beats) && parsed.plan.beats.length) {
        return parsed;
      }
    } catch {}
    return null;
  }

  async writeCachedPagePlan(cachePath, payload) {
    if (!cachePath || !payload?.plan?.beats?.length) return;
    try {
      await fs.mkdir(this.lessonCacheDir, { recursive: true });
      await fs.writeFile(cachePath, JSON.stringify(payload), 'utf8');
    } catch {}
  }

  async produceCompletePageSegments(pageNumber, myGen, { onSegmentReady = null } = {}) {
    const t0 = Date.now();
    const cfg = this.getRuntimeConfig();
    const isEn = cfg.language === 'en';
    const webSearchEnabled = Boolean(cfg.webSearch);

    // Smart Adaptive Vision: load fast text+layout first (~40ms), and check persistent disk lesson cache!
    const bundle = await this.pdfStage.getPageBundle(this.pdfDoc, pageNumber, { includeVision: false });
    if (myGen !== this.generationId) return [];

    const cachePath = await this.getLessonCachePath(this.pdfDoc, pageNumber, cfg);
    const cached = await this.readCachedPagePlan(cachePath);
    const useVision = cached ? Boolean(cached.usedVision) : needsVisionForBundle(bundle);
    if (!cached && useVision) {
      bundle.visionBase64 = await this.pdfStage.renderVisionJpegBase64(this.pdfDoc, pageNumber).catch(() => null);
    }
    if (myGen !== this.generationId) return [];

    // Optional Dedicated Web Research & Fact-Checking Agent pass (only when explicitly enabled by the user!)
    let webContextSection = '';
    let pageWebEntry = cached?.webEntry || null;
    if (webSearchEnabled && !cached) {
      if (this.prebuffering) {
        this.sendClient({
          type: 'class_buffer_status',
          prebuffering: true,
          readyPages: Math.max(0, this.producedUpToPage - (this.playedPage || 1) + 1),
          targetPages: this.initialPreloadPages,
          message: `🔎 Agente Investigador contrastando Pág. ${bundle.page}/${bundle.totalPages} en fuentes académicas...`,
        });
      }
      const webLookup = await this.webResearchAgent
        .researchForSlide(bundle, {
          folderName: cfg.folderName || '',
          language: cfg.language || 'es',
        })
        .catch(() => ({ ok: false, contextBlock: '', brief: null }));
      if (myGen !== this.generationId) return [];
      if (webLookup.ok && webLookup.contextBlock) {
        webContextSection = `\n\n${webLookup.contextBlock}`;
        if (webLookup.brief?.sources?.length) {
          pageWebEntry = {
            context: `Pág. ${bundle.page} · ${webLookup.brief.notes_intent || bundle.name}`.slice(0, 120),
            page: bundle.page,
            status: webLookup.brief.status || 'verified',
            confidence: webLookup.brief.confidence || 'medium',
            sources: webLookup.brief.sources,
          };
        }
      }
    }

    // 100% STATIC compact system prompt -> Ollama Prefix KV-Cache hits on Page 2, 3, 4...
    const sysPrompt = isEn ? STATIC_DUAL_SCREEN_SYS_EN : STATIC_DUAL_SCREEN_SYS_ES;

    const isOpeningPage = pageNumber === (this.startPageOfClass || pageNumber);
    const continuityLine = isOpeningPage
      ? 'Página inicial: entrada breve y natural, luego explica el contenido.'
      : `Continuación (vienes de: "${(this.lastProducedSummary || `pág.${pageNumber - 1}`).slice(0, 95)}"). NO saludes ni leas encabezados repetidos; enlaza directo al tema nuevo.`;

    const userPrompt = `PÁGINA ${bundle.page}/${bundle.totalPages} — "${bundle.name}"
${continuityLine}
${bundle.hasExampleProblem ? `Posible ejercicio detectado (${bundle.cues.join(', ')}): pon "has_problem": true solo si hay cálculo o demostración real.` : ''}

TEXTO PÁG. ${bundle.page}:
${bundle.text.slice(0, 1650) || '(Página gráfica — explica y dibuja desde la imagen adjunta)'}${webContextSection}`;

    const segments = [];
    const key = `${bundle.docId}:${bundle.page}`;
    let runningAnnotations = [];
    const usedLineIndices = new Set();
    let hasDrawnBoardOnPage = false;
    let emittedBeatIndex = 0;
    this.pageAnnotations.set(key, runningAnnotations);

    // Ordered parallel Kokoro TTS pipeline: synthesizes Beat 0 WHILE Ollama is still streaming Beat 1/2/3!
    let ttsChain = Promise.resolve();
    const processSingleBeat = (b) => {
      const spoken = cleanSpokenText(b?.say || b?.speech || b?.text || '');
      if (!spoken) return;
      const myBeatIdx = emittedBeatIndex++;

      ttsChain = ttsChain.then(async () => {
        if (myGen !== this.generationId) return;

        const onStartEvents = [];

        // Beat 0 opens THIS PDF page on the left projector screen — page NEVER turns before previous page's voice finishes!
        if (myBeatIdx === 0) {
          onStartEvents.push({
            type: 'stage_pdf_page',
            data: {
              docId: bundle.docId,
              name: bundle.name,
              page: bundle.page,
              totalPages: bundle.totalPages,
              imageUrl: bundle.imageUrl,
              vbW: bundle.vbW,
              vbH: bundle.vbH,
              hasExampleProblem: Boolean(bundle.hasExampleProblem),
              reason: `Clase en vivo · Página ${bundle.page} de ${bundle.totalPages}`,
              annotations: [],
            },
          });
          if (pageWebEntry?.sources?.length) {
            onStartEvents.push({
              type: 'web_sources',
              entry: pageWebEntry,
            });
          }
        }

        // Live Chalkboard update (Right Screen): precision parametric blueprint OR custom CAD primitives!
        let beatHasBoard = false;
        if (b.board && typeof b.board === 'object') {
          const tpl = resolveBlueprintTemplateName(b.board.template);
          const layers = Array.isArray(b.board.layers) ? b.board.layers : [];
          const addLayers = Array.isArray(b.board.add_layers) ? b.board.add_layers : [];
          const cleanPrims = tpl ? [] : sanitizeBoardPrimitives(b.board.primitives);
          const formulaStr = String(b.board.formula || b.board.formula_html || '').trim();
          const noteText = String(b.board.note || '').trim();
          const hasBoardContent =
            Boolean(tpl) ||
            layers.length > 0 ||
            addLayers.length > 0 ||
            cleanPrims.length > 0 ||
            Boolean(formulaStr) ||
            Boolean(noteText);
          const rawAction = String(
            b.board.action || (hasBoardContent ? (hasDrawnBoardOnPage ? 'append' : 'new') : 'none'),
          ).toLowerCase();
          if (rawAction !== 'none' && hasBoardContent) {
            const action = rawAction === 'append' && hasDrawnBoardOnPage ? 'append' : 'new';
            hasDrawnBoardOnPage = true;
            beatHasBoard = true;
            onStartEvents.push({
              type: 'stage_chalkboard_update',
              data: {
                action,
                page: bundle.page,
                source_ref: `${bundle.name} · Pág. ${bundle.page}`,
                badge: `Pizarra técnica · Pág. ${bundle.page}`,
                scene_title: String(b.board.title || b.board.scene_title || '').trim(),
                template: tpl,
                mode: b.board.mode || '',
                layers,
                add_layers: addLayers,
                labels: b.board.labels || {},
                left: b.board.left,
                right: b.board.right,
                takeaway: b.board.takeaway,
                curves: b.board.curves,
                xMin: b.board.xMin,
                xMax: b.board.xMax,
                yMin: b.board.yMin,
                yMax: b.board.yMax,
                xLabel: b.board.xLabel,
                yLabel: b.board.yLabel,
                frontWeightPct: b.board.frontWeightPct,
                steerDeg: b.board.steerDeg,
                rollDeg: b.board.rollDeg,
                camberDeg: b.board.camberDeg,
                variables: Array.isArray(b.board.variables) ? b.board.variables.slice(0, 6) : [],
                primitives: cleanPrims,
                formula: formulaStr,
                formula_html: formulaStr,
                note: noteText,
              },
            });
          }
        }

        // Purposeful PDF annotations (NEVER auto-spam underlines!)
        const newlyResolved = this.resolveAnnotationsForBundle(
          bundle,
          b.pdf_annotations,
          runningAnnotations.length,
          spoken,
          usedLineIndices,
          { allowAutoFallback: false },
        );
        if (newlyResolved.length) {
          runningAnnotations = [...runningAnnotations, ...newlyResolved];
          this.pageAnnotations.set(key, runningAnnotations);
          onStartEvents.push({
            type: 'stage_pdf_annotations',
            data: {
              docId: bundle.docId,
              page: bundle.page,
              vbW: bundle.vbW,
              vbH: bundle.vbH,
              annotations: [...runningAnnotations],
              newlyAddedCount: newlyResolved.length,
              clearPrevious: false,
            },
          });
        }

        // Glowing laser pointer (works on PDF or Chalkboard!)
        if (b.pointer && (b.pointer.target_text || b.pointer.element_id || (b.pointer.x != null && b.pointer.y != null))) {
          const onPdf = b.pointer.on_board ? false : b.pointer.onPdf !== false;
          const anchor = onPdf && b.pointer.target_text ? this.pdfStage.resolveTextAnchor(bundle.layout, b.pointer.target_text) : null;
          if (anchor || b.pointer.element_id || (Number.isFinite(Number(b.pointer.x)) && Number.isFinite(Number(b.pointer.y)))) {
            onStartEvents.push({
              type: 'stage_pointer',
              data: {
                element_id: b.pointer.element_id || undefined,
                x: anchor ? anchor.cx : Number(b.pointer.x),
                y: anchor ? anchor.cy : Number(b.pointer.y),
                vbW: onPdf ? bundle.vbW : 960,
                vbH: onPdf ? bundle.vbH : 540,
                label: String(b.pointer.label || b.pointer.target_text || '').slice(0, 48),
                color: b.pointer.color || 'amber',
                onPdf,
              },
            });
          }
        }

        const prosodyTag = inferProsodyTag(b.prosody, spoken, 'warm');
        const prosody = resolveProsodyProfile(prosodyTag, 'warm');
        const audio = await this.synthesizeSegmentAudio(spoken, cfg, { speed: prosody.speed });
        if (myGen !== this.generationId) return;

        const seg = {
          id: `seg-${this.seqCounter++}`,
          page: bundle.page,
          surface: beatHasBoard ? 'split' : 'pdf',
          isPageStart: myBeatIdx === 0,
          prosody: prosodyTag,
          pauseAfterMs: prosody.pauseAfterMs,
          onStartEvents,
          transcriptText: spoken,
          audioBase64: audio.pcmBase64,
          sampleRate: audio.sampleRate,
          durationMs: audio.durationMs,
        };
        segments.push(seg);
        if (onSegmentReady) onSegmentReady(seg);
      });
    };

    // 1. Obtain page beats:
    //    - Cache HIT -> 0 ms Ollama GPU! Straight to uncontended Kokoro GPU synthesis (~0.5s)!
    //    - Cache MISS -> Adaptive Hybrid Metal GPU Scheduler:
    //        * Urgent mode (prebuffering or <=1 segment in flight): overlap Beat 0 Kokoro immediately for ~3-4s TTFA!
    //        * Background lookahead mode (>=2 segments playing ahead): serialize Ollama GPU -> Kokoro GPU cleanly
    //          so BOTH own 100% of Apple Silicon's 20 Metal GPU cores & 273 GB/s UMA bus with zero queue contention!
    let streamedCount = 0;
    let plan = cached?.plan || null;
    const urgentLatencyMode = this.prebuffering || this.inFlightSegments.size <= 1;
    this.lastGpuMetrics = null;

    if (!plan) {
      plan = await this.callStructuredLessonLlm({
        systemPrompt: sysPrompt,
        userPrompt,
        visionBase64: useVision ? bundle.visionBase64 : null,
        myGen,
        maxTokens: 1650,
        onBeat: urgentLatencyMode
          ? (beatObj) => {
              streamedCount++;
              processSingleBeat(beatObj);
            }
          : null,
      });
      if (myGen !== this.generationId) return [];
    }

    // Process beats in uncontended Kokoro GPU burst (cache hit, background lookahead mode, Gemini REST, or mocks)
    if (streamedCount === 0 && plan && Array.isArray(plan.beats) && plan.beats.length) {
      for (const b of plan.beats) {
        processSingleBeat(b);
      }
    }

    // Wait for all Kokoro TTS segments of this page to finish
    await ttsChain;
    if (myGen !== this.generationId) return [];

    // Safe fallback if model returned empty/malformed JSON
    let usedFallback = false;
    if (segments.length === 0) {
      usedFallback = true;
      console.warn(`[ClassEngine WARNING] Fallback activado en Pág. ${bundle.page} (plan=${plan ? 'sin beats' : 'JSON nulo'})`);
      const nonHeaderLine =
        (bundle.layout?.lines || []).find(
          (l) => l.text && l.text.length >= 6 && !/dinámica de vehículos|breno oliveira|fundamentos de dinámica|universidad nebrija/i.test(l.text),
        )?.text || `Página ${bundle.page}`;
      processSingleBeat({
        prosody: 'warm',
        say: isEn
          ? `On page ${bundle.page}, we examine ${nonHeaderLine}.`
          : `En la página ${bundle.page} analizamos ${nonHeaderLine.slice(0, 110)}.`,
        board: {
          action: 'new',
          template: 'comparison',
          title: nonHeaderLine.slice(0, 58),
          layers: ['left', 'right'],
          left: { title: `Pág. ${bundle.page}`, color: 'cyan', points: [nonHeaderLine.slice(0, 70)] },
          right: { title: 'Clave física', color: 'emerald', points: ['Analiza el equilibrio y las variables principales del PDF'] },
        },
        pdf_annotations: [],
      });
      await ttsChain;
      if (myGen !== this.generationId) return [];
    }

    // 2. Worked example/problem pass — trust LLM when it explicitly returns has_problem: false!
    const shouldSolveProblem =
      plan?.has_problem === true || (bundle.hasExampleProblem && plan?.has_problem !== false);
    let savedProblemPlan = cached?.problemPlan || null;
    if (shouldSolveProblem && myGen === this.generationId) {
      const probRes = await this.produceProblemBlankCanvasSegments(bundle, runningAnnotations, cfg, myGen, {
        onSegmentReady,
        cachedProbPlan: savedProblemPlan,
      });
      if (myGen !== this.generationId) return [];
      segments.push(...probRes.segments);
      if (probRes.probPlan) savedProblemPlan = probRes.probPlan;
    }

    // Persist valid generated storyboard to disk cache so revisits, back-pages & exam reviews load in ~0.5s (0ms LLM!)
    if (!cached && !usedFallback && cachePath && plan?.beats?.length) {
      this.writeCachedPagePlan(cachePath, {
        version: LESSON_CACHE_VERSION,
        page: bundle.page,
        usedVision: useVision,
        webEntry: pageWebEntry,
        plan,
        problemPlan: savedProblemPlan,
        savedAt: Date.now(),
      });
    }

    // Remember a compact topic cue for smooth verbal transitions onto page + 1
    const firstNonHeader = (bundle.layout?.lines || []).find((l) => l.text && !/dinámica de vehículos|breno oliveira|fundamentos de dinámica/i.test(l.text));
    this.lastProducedSummary = firstNonHeader?.text?.slice(0, 110) || `Página ${bundle.page}`;

    // Natural breathing pause after final segment of the page (crisp & fluid)
    if (segments.length) {
      segments[segments.length - 1].pauseAfterMs = Math.max(segments[segments.length - 1].pauseAfterMs || 280, 420);
    }

    const elapsedSec = ((Date.now() - t0) / 1000).toFixed(1);
    const totalAudioSec = (segments.reduce((acc, s) => acc + (s.durationMs || 0), 0) / 1000).toFixed(1);
    const ratio = (Number(totalAudioSec) / Math.max(0.2, Number(elapsedSec))).toFixed(1);
    const gpuTag = cached
      ? '⚡ CACHE HIT · 0ms LLM'
      : this.lastGpuMetrics
        ? `GPU ${this.lastGpuMetrics.decodeTps} tok/s${this.lastGpuMetrics.prefillTps ? ` · prefill ${this.lastGpuMetrics.prefillTps} tok/s` : ''} · ${urgentLatencyMode ? 'stream' : 'uncontended'}`
        : urgentLatencyMode
          ? 'stream'
          : 'uncontended';
    console.log(
      `[ClassEngine] Pág. ${bundle.page}/${bundle.totalPages} en ${elapsedSec}s (vision=${useVision ? 'ON' : 'OFF'} · ${gpuTag} · ${segments.length} beats · ${totalAudioSec}s audio · ${ratio}x tiempo real)`,
    );

    return segments;
  }

  /**
   * Dedicated Blank-Canvas Step-by-Step Problem Solver Pass:
   * - Never skips directly to the final formula!
   * - Builds precision CAD primitives diagram + givens + unknown + incremental steps (Law -> Algebra -> Python-verified Result)
   * - Then returns cleanly to the exact PDF page with previous annotations preserved!
   */
  async produceProblemBlankCanvasSegments(
    bundle,
    savedPdfAnnotations,
    cfg,
    myGen,
    { onSegmentReady = null, cachedProbPlan = null } = {},
  ) {
    const sysPrompt = `Eres un Profesor Catedrático e Ingeniero senior resolviendo paso a paso en la PIZARRA DERECHA el problema/ejemplo del PDF.
REGLAS INNEGOCIABLES:
1. PROHIBIDO saltar a la fórmula o resultado final de golpe. Construye 3 a 5 pasos progresivos: Paso 1 = ley física de partida SIN despejar + porqué; Pasos intermedios = cada despeje sin saltos; Paso final = sustitución numérica SI + expresión Python en "python_verify" + "is_final_step": true + chequeo físico.
2. Usa una plantilla paramétrica esquemática en "template" ("car_side"|"car_top"|"car_front"|"quarter_car"|"force_balance"|"power_balance"|"tire_load_curve"|"tire_slip_curve"|"friction_circle"|"inertia_body"|"xy_graph") con "mode", "layers" y "labels" para el diagrama técnico. NUNCA inventes "primitives".
3. En "equation" escribe matemática limpia (ej. "ΣM_2 = 0 ⇒ F_z1 · L - m · g · b = 0" o "F_z1 = (m · g · b) / L"). El motor la formatea automáticamente con fracciones verticales exactas.
4. En "say" habla directo, claro y natural, SIN coletillas repetitivas ("A ver", "Fíjate", "Mira", "Bueno", "Vamos a ver"). Responde ÚNICAMENTE JSON válido.`;

    const userPrompt = `Extrae y resuelve paso a paso el ejemplo, ejercicio o demostración matemática de la PÁGINA ${bundle.page} de "${bundle.name}":

TEXTO DE LA PÁGINA ${bundle.page}:
${bundle.text.slice(0, 2400)}

Devuelve SOLO este JSON:
{
  "problem_title": "Título claro del ejemplo",
  "statement": "Enunciado breve y fiel al PDF",
  "intro_say": "Entrada directa planteando el problema físico y los datos de partida en la pizarra.",
  "template": "car_side",
  "mode": "static",
  "layers": ["base", "dimensions", "cg", "loads"],
  "given_data": [{ "symbol": "m", "value": "1200", "unit": "kg", "color": "cyan" }],
  "unknown": { "symbol": "ΔF_z", "label": "Lo que buscamos", "color": "amber" },
  "variables": [{ "symbol": "h_CG", "label": "Altura del CG", "color": "cyan" }],
  "steps": [
    {
      "step_number": 1,
      "step_title": "Planteamiento físico inicial",
      "goal": "Qué buscamos en este paso",
      "why_reason": "Por qué elegimos esta ecuación o punto de momentos",
      "equation": "ΣM_2 = 0 ⇒ F_z1 · L - m · g · b = 0",
      "algebraic_detail": "Equilibrio estático tomando momentos respecto al apoyo trasero",
      "python_verify": "",
      "is_final_step": false,
      "say": "Explicación hablada precisa y natural de este paso concreto."
    }
  ],
  "outro_say": "Con el resultado comprobado en la pizarra, continuamos con el siguiente concepto del temario."
}`;

    const prob =
      cachedProbPlan ||
      (await this.callStructuredLessonLlm({
        systemPrompt: sysPrompt,
        userPrompt,
        visionBase64: bundle.visionBase64 || null,
        myGen,
        maxTokens: 1650,
      }));
    if (myGen !== this.generationId || !prob || !Array.isArray(prob.steps) || !prob.steps.length) {
      return { segments: [], probPlan: null };
    }

    const out = [];
    const emitProbSeg = (seg) => {
      out.push(seg);
      if (onSegmentReady) onSegmentReady(seg);
    };
    const title = prob.problem_title || `Ejemplo de Página ${bundle.page}`;

    // Segment A: Draw precision Blueprint diagram + givens/unknown on the right chalkboard!
    const introSpoken =
      cleanSpokenText(prob.intro_say) ||
      `En esta página aparece un ejemplo práctico que conviene resolver con rigor. Planteemos los datos y el esquema físico en la pizarra para desarrollarlo paso a paso.`;
    const introProsody = resolveProsodyProfile('warm');
    const introAudio = await this.synthesizeSegmentAudio(introSpoken, cfg, { speed: introProsody.speed });
    if (myGen !== this.generationId) return { segments: [], probPlan: null };

    const probTpl = resolveBlueprintTemplateName(prob.template);

    emitProbSeg({
      id: `seg-${this.seqCounter++}`,
      page: bundle.page,
      surface: 'canvas',
      problemTitle: title,
      pauseAfterMs: 420,
      onStartEvents: [
        {
          type: 'stage_problem_start',
          data: {
            problem_title: title,
            source_pdf: bundle.name,
            source_page: bundle.page,
            statement: prob.statement || '',
            template: probTpl,
            mode: prob.mode || 'static',
            layers: Array.isArray(prob.layers) ? prob.layers : [],
            labels: prob.labels || {},
            given_data: Array.isArray(prob.given_data) ? prob.given_data : [],
            unknown: prob.unknown || null,
            variables: Array.isArray(prob.variables) ? prob.variables : [],
            primitives: sanitizeBoardPrimitives(prob.primitives),
          },
        },
      ],
      transcriptText: introSpoken,
      audioBase64: introAudio.pcmBase64,
      sampleRate: introAudio.sampleRate,
      durationMs: introAudio.durationMs,
    });

    // Segment B1..Bk: Reveal ONE step at a time, synchronized to THAT exact step's spoken explanation!
    for (let i = 0; i < prob.steps.length; i++) {
      if (myGen !== this.generationId) return { segments: [], probPlan: null };
      const st = prob.steps[i];
      const stepNum = Number(st.step_number) || i + 1;
      const onStartEvents = [];

      // Run real sandboxed Python math verification if requested on this step!
      if (st.python_verify && String(st.python_verify).trim()) {
        const pyRes = await verifyMathPython(String(st.python_verify).trim());
        onStartEvents.push({
          type: 'stage_math',
          data: {
            description: st.step_title || `Verificación Paso ${stepNum}`,
            code: String(st.python_verify).trim(),
            ...pyRes,
          },
        });
      }

      onStartEvents.push({
        type: 'stage_problem_step',
        data: {
          step_number: stepNum,
          step_title: st.step_title || `Paso ${stepNum}`,
          goal: st.goal || '',
          why_reason: st.why_reason || '',
          equation: st.equation || st.equation_html || '',
          equation_html: st.equation || st.equation_html || '',
          algebraic_detail: st.algebraic_detail || '',
          is_final_step: Boolean(st.is_final_step || i === prob.steps.length - 1),
          diagram_primitives: sanitizeBoardPrimitives(st.diagram_primitives),
        },
      });

      const stepSpoken =
        cleanSpokenText(st.say) ||
        `En el paso ${stepNum}, ${st.step_title || ''}: ${st.why_reason || ''}`;
      const isFinalStep = Boolean(st.is_final_step || i === prob.steps.length - 1);
      const stepTag = inferProsodyTag(st.prosody, stepSpoken, isFinalStep ? 'aha' : 'deliberate');
      const stepProsody = resolveProsodyProfile(stepTag, 'deliberate');
      const stepAudio = await this.synthesizeSegmentAudio(stepSpoken, cfg, { speed: stepProsody.speed });
      if (myGen !== this.generationId) return { segments: [], probPlan: null };

      emitProbSeg({
        id: `seg-${this.seqCounter++}`,
        page: bundle.page,
        surface: 'canvas',
        problemTitle: title,
        prosody: stepTag,
        pauseAfterMs: stepProsody.pauseAfterMs,
        onStartEvents,
        transcriptText: stepSpoken,
        audioBase64: stepAudio.pcmBase64,
        sampleRate: stepAudio.sampleRate,
        durationMs: stepAudio.durationMs,
      });
    }

    // Segment C: Smooth wrap-up preserving PDF annotations before advancing to next page
    const outroSpoken =
      cleanSpokenText(prob.outro_say) ||
      `Con este cálculo verificado paso a paso en la pizarra, seguimos adelante con el temario.`;
    const outroAudio = await this.synthesizeSegmentAudio(outroSpoken, cfg);
    if (myGen !== this.generationId) return { segments: [], probPlan: null };

    emitProbSeg({
      id: `seg-${this.seqCounter++}`,
      page: bundle.page,
      surface: 'pdf',
      problemTitle: '',
      pauseAfterMs: 550,
      onStartEvents: [
        {
          type: 'stage_pdf_page',
          data: {
            docId: bundle.docId,
            name: bundle.name,
            page: bundle.page,
            totalPages: bundle.totalPages,
            imageUrl: bundle.imageUrl,
            vbW: bundle.vbW,
            vbH: bundle.vbH,
            hasExampleProblem: true,
            reason: `Problema resuelto en pizarra · "${title}"`,
            annotations: [...savedPdfAnnotations],
          },
        },
      ],
      transcriptText: outroSpoken,
      audioBase64: outroAudio.pcmBase64,
      sampleRate: outroAudio.sampleRate,
      durationMs: outroAudio.durationMs,
    });

    return { segments: out, probPlan: prob };
  }
}
