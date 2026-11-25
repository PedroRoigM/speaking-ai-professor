import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { GoogleGenAI } from '@google/genai';
import { searchWeb, fetchWebPage, buildSlideSearchQuery } from './webSearch.mjs';
import { normalizeGeminiClassModelId } from './professorConfig.mjs';

const OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
const AGENT_CACHE_VERSION = 'web-agent-v1';
const DISK_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Specialized Query-Planning Agent prompt with explicit few-shot GOOD vs. BAD search examples.
 */
const QUERY_PLANNER_SYSTEM_PROMPT = `Eres un Agente Especialista en Búsqueda Bibliográfica y Verificación Técnica.
Tu ÚNICA misión es transformar un concepto o duda procedente de unos apuntes en 2 consultas de búsqueda web quirúrgicas, técnicas y repetibles (1 en el idioma de los apuntes y 1 en inglés técnico académico para acceder a fuentes universitarias/IEEE/SAE/NIST/Wikipedia EN).

PAUTAS DE BUENAS BÚSQUEDAS (OBLIGATORIAS):
- Usa términos técnicos exactos, leyes físicas, nombres propios de teoremas y símbolos escritos en texto (ej. "coefficient of friction", "Steiner parallel axis theorem", "longitudinal load transfer braking").
- Incluye el dominio de conocimiento (ej. "vehicle dynamics", "thermodynamics", "control theory", "organic chemistry") para desambiguar.
- NUNCA copies frases conversacionales del alumno ni referencias internas ("diapositiva 3", "mis apuntes", "explica esto").
- Mantén cada consulta entre 4 y 9 palabras clave de alta señal.

EJEMPLOS DE CONTRASTE:
- MAL: "explica por que en la pagina 3 baja mu con el peso"
- BIEN:
  · q1 (ES): "sensibilidad carga vertical neumatico coeficiente adherencia viscoelasticidad"
  · q2 (EN): "tire load sensitivity friction coefficient vertical load viscoelasticity vehicle dynamics"

- MAL: "formula de steiner inercias coche"
- BIEN:
  · q1 (ES): "teorema de Steiner ejes paralelos momento de inercia demostracion"
  · q2 (EN): "parallel axis theorem moment of inertia rigid body derivation"

- MAL: "como funciona la frenada transferencia peso"
- BIEN:
  · q1 (ES): "transferencia longitudinal de carga en frenada altura centro de gravedad batalla"
  · q2 (EN): "longitudinal weight transfer braking center of gravity height wheelbase"

RESPONDE ÚNICAMENTE JSON VÁLIDO:
{"notes_intent":"Resumen en 1 frase del objetivo exacto de los apuntes","queries":[{"q":"consulta 1 en idioma original","lang":"es"},{"q":"query 2 in technical English","lang":"en"}]}`;

/**
 * Specialized Fact-Checking & Anti-Drift Synthesis Agent prompt.
 * Guarantees triangulation, source traceability, convention-conflict detection, and ZERO deviation from notes.
 */
const VERIFIER_SYSTEM_PROMPT = `Eres un Agente Auditor de Verificación Técnica y Fidelidad Docente.
Recibes: (A) la intención y extracto de los apuntes originales del alumno, y (B) evidencia recuperada de fuentes web fiables con su Tier (Tier 1 = universitaria/científica/estándar, Tier 2 = referencia enciclopédica/técnica, Tier 3 = general).

GUARDARRAÍLES INNEGOCIABLES:
1. FIDELIDAD MILIMÉTRICA A LOS APUNTES: Los apuntes originales mandan SIEMPRE en alcance, objetivos didácticos, ejes, convenios de signos y notación. NUNCA propongas fórmulas extra que no pertenezcan a este tema ni desvíes la clase a temarios paralelos.
2. TRIANGULACIÓN OBLIGATORIA:
   - Marca "confidence": "high" y "status": "verified" SOLO si los hechos clave coinciden en ≥ 2 dominios independientes O provienen de al menos 1 fuente Tier 1 académica/científica sin contradicción.
   - Si solo hay 1 fuente Tier 2/3 o cobertura parcial, usa "confidence": "medium" y "status": "partial".
   - Si la evidencia no aporta respaldo fiable para el punto exacto de los apuntes, devuelve "status": "insufficient", "confidence": "low" y listas vacías (CERO invención).
3. CONFLICTOS DE CONVENCIÓN O NOTACIÓN: Si la web usa otra convención (ej. eje Z hacia abajo SAE vs. Z hacia arriba ISO, o l_f/l_r en vez de a/b), anótalo en "convention_differences" indicando que el profesor DEBE mantener la notación de los apuntes y solo aclarar la equivalencia si evita confusión.
4. BLOQUEO DE DESVÍOS: Todo lo que encontraste en internet pero se sale del objetivo de esta página/consulta anótalo brevemente en "out_of_scope_blocked" para recordarle al profesor que NO debe meterse ahí.
5. TRAZABILIDAD: Cada elemento de "verified_facts" debe citar los dominios exactos que lo respaldan en "supported_by". Redacta en el idioma indicado (español claro por defecto), conciso y sin URLs largas en las frases.

RESPONDE ÚNICAMENTE JSON VÁLIDO:
{
  "status": "verified",
  "confidence": "high",
  "notes_intent": "Qué pretende enseñar exactamente el apunte original",
  "verified_facts": [
    {"claim": "Hecho físico/técnico contrastado", "supported_by": ["dominio1", "dominio2"]}
  ],
  "helpful_enrichment": [
    "Intuición física breve o ejemplo real que refuerza directamente lo que dicen los apuntes"
  ],
  "convention_differences": [],
  "out_of_scope_blocked": []
}`;

function parseJsonSafe(raw) {
  const txt = String(raw || '').trim();
  if (!txt) return null;
  const cleaned = txt
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
  for (const candidate of [cleaned, cleaned.replace(/,\s*([}\]])/g, '$1')]) {
    try {
      return JSON.parse(candidate);
    } catch {}
    const i = candidate.indexOf('{');
    const j = candidate.lastIndexOf('}');
    if (i !== -1 && j > i) {
      try {
        return JSON.parse(candidate.slice(i, j + 1));
      } catch {}
    }
  }
  return null;
}

function buildDeterministicFallbackQueries(topic, folderName = '', language = 'es') {
  const cleanTopic = String(topic || '')
    .replace(/[^\p{L}\p{N}\s\-μΔαβθωλρσ_./]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 95);
  const cleanFolder = String(folderName || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);

  if (!cleanTopic) return [];
  const primary =
    cleanFolder && !cleanTopic.toLowerCase().includes(cleanFolder.toLowerCase().slice(0, 8))
      ? `${cleanTopic} ${cleanFolder}`.trim()
      : cleanTopic;

  const queries = [{ q: primary.slice(0, 120), lang: language === 'en' ? 'en' : 'es' }];
  // Add a tighter core-concept query without folder noise if long
  const words = cleanTopic.split(/\s+/).filter((w) => w.length >= 3);
  if (words.length >= 4) {
    queries.push({ q: words.slice(0, 6).join(' '), lang: 'en' });
  }
  return queries;
}

/**
 * Dedicated Web Research & Fact-Checking Subagent.
 * Orchestrates: Query Planning -> Multi-Source Authority Search -> Deep Reading -> Triangulated Verification & Anti-Drift Audit.
 */
export class WebResearchAgent {
  constructor({ cacheDir = '', getRuntimeConfig }) {
    this.cacheDir = cacheDir ? path.join(cacheDir, 'web-research-cache') : '';
    this.getRuntimeConfig = getRuntimeConfig || (() => ({ engine: 'local', localModel: 'gemma4:12b', language: 'es' }));
  }

  setCacheDir(cacheDir) {
    this.cacheDir = cacheDir ? path.join(cacheDir, 'web-research-cache') : '';
  }

  async callAgentJsonLlm({ systemPrompt, userPrompt, maxTokens = 700, timeoutMs = 22000, signal }) {
    const cfg = this.getRuntimeConfig() || {};

    // Cloud Gemini path (Interactions API v1beta, low temperature for repeatability)
    if (cfg.engine === 'gemini' && cfg.apiKey) {
      const ai = new GoogleGenAI({
        apiKey: cfg.apiKey,
        httpOptions: { apiVersion: 'v1beta', timeout: 14000 },
      });
      const primaryModel = normalizeGeminiClassModelId(cfg.geminiClassModel);
      const candidates = [...new Set(['gemini-3.5-flash-lite', 'gemini-3.5-flash', primaryModel])];
      for (const model of candidates) {
        try {
          const interaction = await Promise.race([
            ai.interactions.create({
              model,
              system_instruction: systemPrompt,
              input: userPrompt,
              store: false,
              generation_config: {
                temperature: 0.05,
                max_output_tokens: Math.max(maxTokens, 900),
              },
            }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 14000)),
          ]);
          const txt =
            interaction?.output_text ||
            (interaction?.steps || [])
              .filter((s) => s?.type === 'model_output' && Array.isArray(s.content))
              .flatMap((s) => s.content.filter((c) => c?.type === 'text' && c.text).map((c) => c.text))
              .join('');
          const parsed = parseJsonSafe(txt);
          if (parsed) return parsed;
        } catch (err) {
          const msg = String(err?.message || err);
          if (/\b(401|403|API_KEY_INVALID|PERMISSION_DENIED)\b/i.test(msg)) break;
        }
      }
      return null;
    }

    // Local Ollama path (temperature 0.05 for deterministic, repeatable verification)
    const model = cfg.localModel || 'gemma4:12b';
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const onOuterAbort = () => ctrl.abort();
    signal?.addEventListener?.('abort', onOuterAbort, { once: true });

    try {
      const body = {
        model,
        stream: false,
        keep_alive: '30m',
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        options: {
          num_gpu: 99,
          num_ctx: 6144,
          num_predict: maxTokens,
          temperature: 0.05,
        },
      };
      if (/qwen3|gemma4|deepseek/i.test(model)) {
        body.think = false;
      }

      const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctrl.signal,
      });
      if (!res.ok) return null;
      const data = await res.json();
      return parseJsonSafe(data?.message?.content || '');
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onOuterAbort);
    }
  }

  getDiskCachePath(cacheKey) {
    if (!this.cacheDir) return '';
    const hash = crypto.createHash('sha1').update(`${AGENT_CACHE_VERSION}|${cacheKey}`).digest('hex').slice(0, 20);
    return path.join(this.cacheDir, `${hash}.json`);
  }

  async readDiskCache(cacheKey) {
    const file = this.getDiskCachePath(cacheKey);
    if (!file) return null;
    try {
      const raw = await fs.readFile(file, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.savedAt && Date.now() - parsed.savedAt <= DISK_CACHE_TTL_MS && parsed.brief) {
        return { ...parsed.brief, cached: true };
      }
    } catch {}
    return null;
  }

  async writeDiskCache(cacheKey, brief) {
    const file = this.getDiskCachePath(cacheKey);
    if (!file || !brief || brief.status === 'insufficient') return;
    try {
      await fs.mkdir(this.cacheDir, { recursive: true });
      await fs.writeFile(file, JSON.stringify({ savedAt: Date.now(), brief }), 'utf8');
    } catch {}
  }

  /**
   * Phase 1: Plan 2 surgical technical queries (original language + technical English).
   */
  async planQueries({ topic, notesContext = '', folderName = '', language = 'es', fastMode = false, signal }) {
    const fallback = buildDeterministicFallbackQueries(topic, folderName, language);
    if (fastMode) {
      return {
        notesIntent: String(topic || '').slice(0, 140),
        queries: fallback,
      };
    }

    const userPrompt = `MATERIA / CARPETA: "${folderName || 'Estudio técnico'}"
IDIOMA PREFERENTE: ${language === 'en' ? 'en' : 'es'}
TEMA / DUDA A CONTRASTAR: ${String(topic || '').slice(0, 260)}
${notesContext ? `EXTRACTO DE LOS APUNTES ORIGINALES:\n${String(notesContext).slice(0, 750)}` : ''}`;

    const planned = await this.callAgentJsonLlm({
      systemPrompt: QUERY_PLANNER_SYSTEM_PROMPT,
      userPrompt,
      maxTokens: 260,
      timeoutMs: 12000,
      signal,
    });

    if (planned && Array.isArray(planned.queries) && planned.queries.length) {
      const cleanQueries = planned.queries
        .map((item) => ({
          q: String(item?.q || item || '').trim().slice(0, 120),
          lang: item?.lang === 'en' ? 'en' : language === 'en' ? 'en' : 'es',
        }))
        .filter((x) => x.q.length >= 4)
        .slice(0, 2);
      if (cleanQueries.length) {
        return {
          notesIntent: String(planned.notes_intent || topic || '').slice(0, 180),
          queries: cleanQueries,
        };
      }
    }

    return {
      notesIntent: String(topic || '').slice(0, 180),
      queries: fallback,
    };
  }

  /**
   * Full 4-Phase Research, Cross-Check & Anti-Drift Verification Pipeline.
   */
  async research({
    topic,
    notesContext = '',
    folderName = '',
    language = 'es',
    depth = 'standard', // 'quick' (for Continuous Class lookahead) | 'standard' (for Q&A / deep doubts)
    onProgress = null,
    signal,
  }) {
    const cleanTopic = String(topic || '').trim();
    if (!cleanTopic) {
      return {
        ok: false,
        status: 'insufficient',
        confidence: 'low',
        notes_intent: '',
        verified_facts: [],
        helpful_enrichment: [],
        convention_differences: [],
        out_of_scope_blocked: [],
        sources: [],
        queriesUsed: [],
      };
    }

    const lang = language === 'en' ? 'en' : 'es';
    const cacheKey = `${lang}|${depth}|${folderName.toLowerCase()}|${cleanTopic.toLowerCase()}|${String(notesContext).slice(0, 220).toLowerCase()}`;
    const diskHit = await this.readDiskCache(cacheKey);
    if (diskHit) {
      onProgress?.(`🌐 Verificación web recuperada de caché (${diskHit.sources?.length || 0} fuentes · confianza ${diskHit.confidence}).`);
      return diskHit;
    }

    // Phase 1: Plan focused bilingual queries
    onProgress?.(`🔎 Agente Investigador planificando búsqueda para "${cleanTopic.slice(0, 65)}"...`);
    const plan = await this.planQueries({
      topic: cleanTopic,
      notesContext,
      folderName,
      language: lang,
      fastMode: depth === 'quick',
      signal,
    });

    if (!plan.queries.length) {
      return {
        ok: false,
        status: 'insufficient',
        confidence: 'low',
        notes_intent: plan.notesIntent,
        verified_facts: [],
        helpful_enrichment: [],
        convention_differences: [],
        out_of_scope_blocked: [],
        sources: [],
        queriesUsed: [],
      };
    }

    // Phase 2: Multi-source authority-ranked search (DuckDuckGo + Wikipedia ES/EN + OpenAlex academic)
    onProgress?.(`🌐 Consultando fuentes académicas y técnicas (${plan.queries.map((x) => `"${x.q}"`).join(' · ')})...`);
    const searchRuns = await Promise.all(
      plan.queries.map((item) =>
        searchWeb(item.q, {
          maxResults: 4,
          lang: item.lang,
          includeAcademic: true,
          timeoutMs: depth === 'quick' ? 5500 : 7500,
          signal,
        }),
      ),
    );

    // Deduplicate & keep top diverse authoritative candidates
    const seen = new Set();
    const candidates = [];
    for (const run of searchRuns) {
      for (const r of run?.results || []) {
        const key = r.url.replace(/#.*$/, '').replace(/\/$/, '');
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(r);
      }
    }

    // Sort strictly by Tier asc (1 before 2 before 3), then source diversity
    candidates.sort((a, b) => (a.tier || 3) - (b.tier || 3) || (b.snippet?.length || 0) - (a.snippet?.length || 0));

    const selected = [];
    const domainCount = new Map();
    for (const c of candidates) {
      const cnt = domainCount.get(c.domain) || 0;
      if (cnt >= 1 && selected.length < 3) continue; // Maximize distinct domains for real cross-checking!
      domainCount.set(c.domain, cnt + 1);
      selected.push(c);
      if (selected.length >= 4) break;
    }

    if (!selected.length) {
      return {
        ok: false,
        status: 'insufficient',
        confidence: 'low',
        notes_intent: plan.notesIntent,
        verified_facts: [],
        helpful_enrichment: [],
        convention_differences: [],
        out_of_scope_blocked: [],
        sources: [],
        queriesUsed: plan.queries.map((x) => x.q),
      };
    }

    // Phase 3: Selective deep-reading of top 1-2 authoritative pages to verify beyond snippets
    const readTargets = selected.slice(0, depth === 'quick' ? 1 : 2);
    const deepReads = await Promise.all(
      readTargets.map((src) =>
        fetchWebPage(src.url, {
          maxChars: depth === 'quick' ? 1600 : 2200,
          timeoutMs: 5000,
          signal,
        }).catch(() => ({ ok: false })),
      ),
    );

    const evidenceBlocks = selected.map((src, idx) => {
      const full = idx < deepReads.length && deepReads[idx]?.ok ? deepReads[idx].excerpt : '';
      const body = full ? full.slice(0, 1400) : src.snippet;
      return `[FUENTE ${idx + 1} · Tier ${src.tier || 3} · ${src.domain}] ${src.title}\n${body}`;
    });

    const distinctDomains = new Set(selected.map((s) => s.domain)).size;
    const hasTier1 = selected.some((s) => s.tier === 1);

    // Phase 4: Cross-check, triangulate, and audit against original notes (temperature 0.05)
    onProgress?.(`⚖️ Auditando y contrastando ${selected.length} fuentes (${distinctDomains} dominios independientes)...`);

    const verifierPrompt = `IDIOMA DE SALIDA: ${lang === 'en' ? 'English' : 'Español'}
MATERIA / CARPETA: "${folderName || 'Estudio técnico'}"
INTENCIÓN DE LOS APUNTES ORIGINALES: ${plan.notesIntent}
${notesContext ? `EXTRACTO FIEL DE LOS APUNTES ORIGINALES:\n${String(notesContext).slice(0, 1200)}\n` : ''}
EVIDENCIA RECUPERADA (${selected.length} fuentes, ${distinctDomains} dominios distintos, Tier 1 presente: ${hasTier1 ? 'SÍ' : 'NO'}):
${evidenceBlocks.join('\n\n')}`;

    const audited = await this.callAgentJsonLlm({
      systemPrompt: VERIFIER_SYSTEM_PROMPT,
      userPrompt: verifierPrompt,
      maxTokens: 680,
      timeoutMs: 18000,
      signal,
    });

    const sourcesSummary = selected.map((s) => ({
      title: s.title,
      domain: s.domain,
      url: s.url,
      tier: s.tier || 3,
    }));

    // Build deterministic fallback brief if Verifier LLM couldn't parse JSON
    let brief;
    if (audited && typeof audited === 'object') {
      const rawStatus = ['verified', 'partial', 'conflict_with_notes', 'insufficient'].includes(audited.status)
        ? audited.status
        : distinctDomains >= 2 || hasTier1
          ? 'verified'
          : 'partial';
      // Enforce deterministic triangulation guardrail: cannot claim 'high' confidence without >=2 domains or Tier 1!
      let confidence = ['high', 'medium', 'low'].includes(audited.confidence) ? audited.confidence : 'medium';
      if (confidence === 'high' && distinctDomains < 2 && !hasTier1) {
        confidence = 'medium';
      }
      brief = {
        ok: rawStatus !== 'insufficient',
        status: rawStatus,
        confidence,
        notes_intent: String(audited.notes_intent || plan.notesIntent).slice(0, 220),
        verified_facts: Array.isArray(audited.verified_facts)
          ? audited.verified_facts
              .filter((f) => f && (f.claim || typeof f === 'string'))
              .slice(0, 4)
              .map((f) =>
                typeof f === 'string'
                  ? { claim: f.slice(0, 240), supported_by: sourcesSummary.slice(0, 2).map((s) => s.domain) }
                  : {
                      claim: String(f.claim || '').slice(0, 240),
                      supported_by: Array.isArray(f.supported_by) ? f.supported_by.slice(0, 3) : [],
                    },
              )
          : [],
        helpful_enrichment: Array.isArray(audited.helpful_enrichment)
          ? audited.helpful_enrichment.map((x) => String(x || '').slice(0, 220)).filter(Boolean).slice(0, 3)
          : [],
        convention_differences: Array.isArray(audited.convention_differences)
          ? audited.convention_differences.map((x) => String(x || '').slice(0, 220)).filter(Boolean).slice(0, 2)
          : [],
        out_of_scope_blocked: Array.isArray(audited.out_of_scope_blocked)
          ? audited.out_of_scope_blocked.map((x) => String(x || '').slice(0, 160)).filter(Boolean).slice(0, 3)
          : [],
        sources: sourcesSummary,
        distinctDomains,
        queriesUsed: plan.queries.map((x) => x.q),
      };
    } else {
      brief = {
        ok: true,
        status: distinctDomains >= 2 || hasTier1 ? 'verified' : 'partial',
        confidence: distinctDomains >= 2 || hasTier1 ? 'medium' : 'low',
        notes_intent: plan.notesIntent,
        verified_facts: selected.slice(0, 3).map((s) => ({
          claim: `${s.title}: ${s.snippet.slice(0, 180)}`,
          supported_by: [s.domain],
        })),
        helpful_enrichment: [],
        convention_differences: [],
        out_of_scope_blocked: [],
        sources: sourcesSummary,
        distinctDomains,
        queriesUsed: plan.queries.map((x) => x.q),
      };
    }

    await this.writeDiskCache(cacheKey, brief);
    return brief;
  }

  /**
   * Convenience wrapper for Continuous Class Mode slides: extracts slide intent,
   * runs the full WebResearchAgent in fast balanced mode, and returns a prompt-ready verified brief.
   */
  async researchForSlide(bundle, { folderName = '', language = 'es', onProgress = null, signal } = {}) {
    const topic = buildSlideSearchQuery(bundle, folderName);
    if (!topic) {
      return { ok: false, contextBlock: '', brief: null };
    }
    const brief = await this.research({
      topic,
      notesContext: String(bundle?.text || '').slice(0, 1100),
      folderName,
      language,
      depth: 'quick',
      onProgress,
      signal,
    });
    if (!brief?.ok) {
      return { ok: false, contextBlock: '', brief };
    }
    return {
      ok: true,
      brief,
      contextBlock: formatVerifiedBriefForPrompt(brief),
    };
  }
}

/**
 * Formats a verified WebResearchAgent briefing into a crisp, guardrail-locked prompt block
 * for the Professor LLM (both Continuous Class and Live Q&A).
 */
export function formatVerifiedBriefForPrompt(brief) {
  if (!brief || !brief.ok) return '';
  const lines = [
    `BRIEFING VERIFICADO POR EL AGENTE INVESTIGADOR WEB (estado: ${brief.status} · confianza: ${brief.confidence} · ${brief.distinctDomains || brief.sources?.length || 0} fuentes independientes):`,
    `Objetivo original de los apuntes: ${brief.notes_intent || '(fiel a la página activa)'}`,
  ];

  if (brief.verified_facts?.length) {
    lines.push('Hechos contrastados:');
    for (const f of brief.verified_facts.slice(0, 4)) {
      const sup = f.supported_by?.length ? ` [${f.supported_by.join(', ')}]` : '';
      lines.push(`- ${f.claim}${sup}`);
    }
  }
  if (brief.helpful_enrichment?.length) {
    lines.push('Ampliación pedagógica permitida (fiel al alcance del apunte):');
    for (const e of brief.helpful_enrichment.slice(0, 3)) {
      lines.push(`- ${e}`);
    }
  }
  if (brief.convention_differences?.length) {
    lines.push('Aviso de notación/convención (CONSERVA SIEMPRE LA DE LOS APUNTES):');
    for (const c of brief.convention_differences.slice(0, 2)) {
      lines.push(`- ${c}`);
    }
  }
  if (brief.out_of_scope_blocked?.length) {
    lines.push(`Temas bloqueados por salirse de los apuntes (NO introducir): ${brief.out_of_scope_blocked.join('; ')}`);
  }
  lines.push(
    'REGLA FINAL: Integra solo lo contrastado que haga más clara esta explicación. PROHIBIDO desviarte de los apuntes, cambiar su notación o leer URLs en voz alta.',
  );
  return lines.join('\n').slice(0, 1650);
}
