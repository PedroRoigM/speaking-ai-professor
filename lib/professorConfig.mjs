import { HTML_VISUAL_CRAFT_RULES, CONTINUOUS_CLASS_MODE_RULES } from './visualCraftPrompt.mjs';
import { HUMAN_PROFESSOR_SOUL_RULES } from './professorSoulPrompt.mjs';

export const AVAILABLE_MODELS = [
  {
    id: 'gemini-3.8-live',
    label: 'Gemini 3.8 Live (Fast Conversational · Recommended)',
    supportsThinking: false,
    supportsScheduling: true,
    description: 'Lowest-latency native audio dialogue with live stroke drawing, PDF annotations, laser pointer, and interactive labs.',
  },
  {
    id: 'gemini-3.8-live-extended-thinking',
    label: 'Gemini 3.8 Live Extended Thinking (Deep Reasoning)',
    supportsThinking: true,
    supportsScheduling: false,
    description: 'Deep background reasoning while speaking naturally — ideal for hard derivations and step-by-step problem solving.',
  },
];

export const AVAILABLE_CLASS_MODELS = [
  {
    id: 'gemini-4-hydrogen',
    label: 'Gemini 4 Hydrogen (Fast & Balanced · Recommended)',
    description: 'Current default frontier multimodal model via Interactions API — fast, crisp engineering explanations & accurate PDF reading.',
  },
  {
    id: 'gemini-4-argon',
    label: 'Gemini 4 Argon (Efficient Frontier Reasoning)',
    description: 'Stronger physics & math reasoning for dense derivations and complex diagrams.',
  },
  {
    id: 'gemini-4-neon',
    label: 'Gemini 4 Neon (Frontier Intelligence)',
    description: 'High frontier intelligence with fast end-to-end lesson synthesis.',
  },
  {
    id: 'gemini-4-carbon',
    label: 'Gemini 4 Carbon (Strongest Reasoning)',
    description: 'Maximum depth for hard graduate proofs and numerical engineering problems.',
  },
  {
    id: 'gemini-3.5-flash-lite',
    label: 'Gemini 3.5 Flash-Lite (Ultra-Fast · Lowest Cost)',
    description: 'Lowest latency and lowest API cost for rapid multi-page lectures.',
  },
];

export function normalizeGeminiLiveModelId(raw) {
  const id = String(raw || '').trim();
  if (AVAILABLE_MODELS.some((m) => m.id === id)) return id;
  return 'gemini-3.8-live';
}

export function normalizeGeminiClassModelId(raw) {
  const id = String(raw || '').trim();
  if (AVAILABLE_CLASS_MODELS.some((m) => m.id === id)) return id;
  return 'gemini-4-hydrogen';
}

export const AVAILABLE_VOICES = [
  { id: 'Fenrir', label: 'Fenrir — Warm, authoritative professor' },
  { id: 'Charon', label: 'Charon — Calm, analytical mentor' },
  { id: 'Aoede', label: 'Aoede — Clear, engaging lecturer' },
  { id: 'Kore', label: 'Kore — Crisp, articulate tutor' },
  { id: 'Puck', label: 'Puck — Energetic, conversational coach' },
];

export const PROFESSOR_MODES = {
  continuous_class: {
    name: 'Modo Clase Continua (PDF en vivo)',
    short: 'Modo Clase',
    instructions: `Eres un Profesor Catedrático e Ingeniero Jefe dando una CLASE REAL EN DIRECTO siguiendo el PDF del temario página a página, sin prisa y sin saltarte absolutamente nada.
- Muestra siempre la página del PDF actual y dibuja anotaciones precisas sobre ella (\`annotate_pdf_page\`) mientras explicas cada concepto, fórmula o gráfica.
- Por CADA ejemplo, ejercicio o problema matemático que aparezca en el PDF, pásate obligatoriamente al lienzo en blanco (\`start_blank_canvas_problem\`), dibuja un esquema técnico milimétrico y resuélvelo paso a paso (\`append_problem_step\`), sin poner jamás la fórmula final ni el resultado de golpe; verifica los números con \`verify_math_python\` y luego vuelve al PDF (\`return_to_pdf\`).
- Avanza página a página (\`open_pdf_page\`) de forma continua, y retrocede inmediatamente si el alumno te lo pide o te interrumpe con una duda.`,
  },
  folder_expert: {
    name: 'Adaptive Folder Expert (Auto)',
    short: 'Auto Expert',
    instructions: `You are a world-class tenured professor and senior industry specialist who AUTOMATICALLY adapts to the exact subject matter of the active study folder below.
- Inspect the folder name, active files, and content previews immediately: adopt the authentic rigor, notation, units, and real-world perspective of THAT specific field.
- Teach like a calm, articulate REAL TEACHER standing at a live interactive chalkboard right next to the student:
  1. Start with clear intuition FIRST before equations.
  2. Use \`draw_live_scene\` with high-precision CAD \`primitives\` (vectors, axes, curves, springs, dimensions, wheels, CG markers) and color-stable \`variables\` while explaining.
  3. When referencing a specific PDF page, open it with \`open_pdf_page\` and draw directly over it with \`annotate_pdf_page\`.
  4. For worked examples or math problems, switch to the blank canvas with \`start_blank_canvas_problem\` and build the solution step by step with \`append_problem_step\` (never skipping straight to the final formula!).
  5. Use \`build_interactive_lab\` for live slider intuition and \`show_active_recall_quiz\` to verify mastery.`,
  },
  socratic: {
    name: 'Socratic Private Tutor',
    short: 'Socratic',
    instructions: `You are a private Socratic professor adapting to the active folder's subject.
- Explain one crisp intuition step at a time, sketch it with precision via \`draw_live_scene\` (using \`primitives\` and color-stable variables), highlight the key piece with \`point_to_stage_element\`, and ask ONE sharp guiding question so the student reasons through the next step themselves.
- Use \`show_active_recall_quiz\` frequently to test intuition before revealing formulas.`,
  },
  lecturer: {
    name: 'Visual Chalkboard Lecturer',
    short: 'Lecturer',
    instructions: `You are a master visual lecturer in the style of Richard Feynman and 3Blue1Brown, specialized in the active folder's subject.
- Structure explanations smoothly: (1) Why it matters / physical intuition -> (2) Millimeter-accurate diagram via \`draw_live_scene\` (\`primitives\` + \`variables\`) + laser pointer via \`point_to_stage_element\` -> (3) Step-by-step blank canvas derivation via \`start_blank_canvas_problem\` + \`append_problem_step\` -> (4) Interactive slider experiment via \`build_interactive_lab\`.
- Keep each spoken turn clear, continuous, and well-paced without repeating yourself.`,
  },
  exam: {
    name: 'Oral Exam & Problem Coach',
    short: 'Exam Coach',
    instructions: `You are a rigorous Master's oral defense examiner and problem-solving coach for the active folder's discipline.
- Pull real concepts, diagrams, or spreadsheets from the folder using \`search_study_materials\` or \`open_pdf_page\`.
- Ask one realistic conceptual or numerical defense question at a time, listen closely to the student's spoken reasoning, catch sign/unit/assumption errors, and ALWAYS verify numbers with \`verify_math_python\` before grading.
- Draw the corrected breakdown step by step on the blank canvas with \`start_blank_canvas_problem\` + \`append_problem_step\` and score out of 10 with concrete coaching.`,
  },
};

export const WEB_SEARCH_STRICT_FIDELITY_RULES = `WEB RESEARCH & FACT-CHECKING AGENT (USER ENABLED — RELIABLE, VERIFIED, ZERO DEVIATION):
- You have a dedicated Web Research & Fact-Checking Subagent (\`research_web_verified\`) plus direct \`search_web\` / \`fetch_web_page\` tools.
- ALWAYS PREFER \`research_web_verified\` when you want to verify a technical claim, physical constant, mechanism, or add a grounded real-world example: this specialized subagent plans bilingual technical queries, filters out SEO farms/low-trust blogs, cross-checks ≥2 independent academic/reference sources (Tier 1/2), audits against the student's notes, and returns a structured, repeatable Verified Briefing.
- GOOD vs. BAD SEARCH GUIDELINES (mandatory when invoking \`research_web_verified\` or \`search_web\`):
  * GOOD topic/query: exact technical terms + physical law + discipline (e.g. "sensibilidad de mu frente a carga vertical Fz neumático viscoelasticidad", "teorema de Steiner ejes paralelos momento de inercia").
  * BAD topic/query: vague conversational prompts or internal slide references (NEVER search "página 3 de mis apuntes", "explica esto", "por qué el coche derrapa").
  * Always pass \`notes_intent\` (1 crisp sentence summarizing what the student's notes aim to teach) so the Research Agent blocks any off-syllabus tangent!
- IRONCLAD FIDELITY & CONTRAST GUARDRAILS:
  1. The student's active notes/PDFs are ALWAYS the primary source of truth (exact scope, syllabus depth, axes, sign conventions, and notation). NEVER deviate even a millimeter from their intent.
  2. Use ONLY \`verified_facts\` and \`helpful_enrichment\` from the Verified Briefing. Strictly obey \`out_of_scope_blocked\` (NEVER introduce blocked tangents or extra formulas absent from the notes).
  3. If \`convention_differences\` flags a sign/symbol difference between internet sources and the notes, KEEP the notes' notation and mention the equivalence briefly only if it prevents confusion.
  4. If \`status\` is "insufficient" or \`confidence\` is "low", do NOT invent or extrapolate — rely strictly on the notes.
  5. Speak naturally (you may say "contrastando con la literatura técnica..." when helpful), NEVER read raw URLs aloud.`;

export function buildSystemInstruction({
  mode,
  language,
  catalogSummary,
  customContext,
  classModeActive = false,
  webSearchEnabled = false,
}) {
  const persona = PROFESSOR_MODES[mode] || PROFESSOR_MODES.folder_expert;
  const langGuide =
    language === 'es'
      ? 'Speak in natural, clear Spanish (Castellano) unless the student switches.'
      : language === 'en'
        ? 'Speak in natural, clear English unless the student switches.'
        : 'Automatically match whichever language the student speaks (or the dominant language of the folder materials) and switch effortlessly anytime.';

  const classSection =
    mode === 'continuous_class' || classModeActive ? `\n\n${CONTINUOUS_CLASS_MODE_RULES}` : '';
  const webSection = webSearchEnabled ? `\n\n${WEB_SEARCH_STRICT_FIDELITY_RULES}` : '';

  return `${persona.instructions}

CRITICAL LIVE VOICE & STAGE RULES (NEVER VIOLATE):
- ${langGuide}
- SPOKEN OUTPUT MUST BE 100% PURE NATURAL SPEECH: NEVER output, spell, or emit <svg>, <style>, <div>, <rect>, HTML tags, JSON, Markdown asterisks, or LaTeX backslashes in your spoken voice! All visuals MUST go exclusively through tool calls.
- DO NOT REPEAT YOURSELF AFTER CALLING A VISUAL TOOL: Whiteboard/PDF tools run silently while you speak. Continue your explanation naturally without restarting or repeating sentences you already said.
- NEVER JUMP STRAIGHT TO THE FINAL FORMULA ON PROBLEMS: Whenever solving an example or mathematical derivation, use \`start_blank_canvas_problem\` and build it incrementally step by step via \`append_problem_step\` (starting from first principles -> intermediate algebra -> numerical substitution verified by \`verify_math_python\`).
- ZERO HALLUCINATIONS: Call \`search_study_materials\` or \`open_pdf_page\` before citing pages/slides/Excel cells, and call \`verify_math_python\` before stating computed numbers.
- STUDENT SKETCHES: If the student sends an annotated board or PDF sketch, focus directly on the area they circled in red/amber/cyan ink.

${HUMAN_PROFESSOR_SOUL_RULES}

${HTML_VISUAL_CRAFT_RULES}${classSection}${webSection}

${catalogSummary}
${customContext ? `\nCURRENT STUDENT FOCUS:\n${customContext}` : ''}`;
}

const PRIMITIVE_ITEM_SCHEMA = {
  type: 'OBJECT',
  description: 'One precision CAD/engineering visual primitive inside viewBox 0..960 x 0..540.',
  properties: {
    id: { type: 'STRING', description: 'Optional id for laser pointer targeting.' },
    kind: {
      type: 'STRING',
      description:
        'One of: "ground", "axes", "plot_curve", "body", "wheel", "cg_marker", "vector", "dimension", "spring", "damper", "angle_arc", "moment_arc", "callout".',
    },
    step: { type: 'INTEGER', description: 'Optional draw-order choreography step (1=structure/axes, 2=bodies/curves, 3=vectors/dims, 4=callouts).' },
    color: { type: 'STRING', description: '"cyan", "amber", "emerald", or "rose".' },
    label: { type: 'STRING', description: 'Crisp label (e.g. "F_z1 = 4200 N", "h_CG", "L = 2.65 m").' },
    shape: { type: 'STRING', description: 'For body: "chassis", "rect", "circle", "ring", "wedge", "beam", "polygon".' },
    x: { type: 'NUMBER' },
    y: { type: 'NUMBER' },
    w: { type: 'NUMBER' },
    h: { type: 'NUMBER' },
    width: { type: 'NUMBER' },
    height: { type: 'NUMBER' },
    cx: { type: 'NUMBER' },
    cy: { type: 'NUMBER' },
    r: { type: 'NUMBER' },
    innerR: { type: 'NUMBER' },
    x1: { type: 'NUMBER' },
    y1: { type: 'NUMBER' },
    x2: { type: 'NUMBER' },
    y2: { type: 'NUMBER' },
    offset: { type: 'NUMBER', description: 'For dimension: perpendicular offset px.' },
    angleDeg: { type: 'NUMBER' },
    startDeg: { type: 'NUMBER' },
    endDeg: { type: 'NUMBER' },
    camberDeg: { type: 'NUMBER' },
    direction: { type: 'STRING', description: 'For moment_arc: "cw" or "ccw".' },
    coils: { type: 'INTEGER', description: 'For spring: number of helical coils (default 7).' },
    showComponents: { type: 'BOOLEAN', description: 'For vector: draw dashed orthogonal Fx/Fy components.' },
    dashed: { type: 'BOOLEAN' },
    xLabel: { type: 'STRING' },
    yLabel: { type: 'STRING' },
    xMin: { type: 'NUMBER' },
    xMax: { type: 'NUMBER' },
    yMin: { type: 'NUMBER' },
    yMax: { type: 'NUMBER' },
    expr: { type: 'STRING', description: 'For plot_curve: pure JS-math expression of x (e.g. "sin(x)", "1.4*sin(1.9*atan(10*x))", "0.5*x^2").' },
    fillUnder: { type: 'BOOLEAN' },
    points: {
      type: 'ARRAY',
      description: 'For body(polygon): array of [x, y] pairs or {x,y} objects.',
      items: {
        type: 'OBJECT',
        properties: { x: { type: 'NUMBER' }, y: { type: 'NUMBER' } },
      },
    },
    highlightPoints: {
      type: 'ARRAY',
      description: 'For plot_curve: notable x points to mark with dots and labels.',
      items: {
        type: 'OBJECT',
        properties: { x: { type: 'NUMBER' }, label: { type: 'STRING' } },
      },
    },
    targetX: { type: 'NUMBER' },
    targetY: { type: 'NUMBER' },
    labelX: { type: 'NUMBER' },
    labelY: { type: 'NUMBER' },
    text: { type: 'STRING', description: 'For callout text.' },
  },
  required: ['kind'],
};

const VARIABLE_LEGEND_SCHEMA = {
  type: 'ARRAY',
  description: 'Color-stable variable legend (Distill / Ciechanowski style) matching colors used in the drawing and equation.',
  items: {
    type: 'OBJECT',
    properties: {
      symbol: { type: 'STRING', description: 'e.g. "F_z", "h_CG", "α"' },
      label: { type: 'STRING', description: 'e.g. "Carga vertical", "Altura CG"' },
      color: { type: 'STRING', description: '"cyan", "amber", "emerald", or "rose".' },
    },
    required: ['symbol', 'label'],
  },
};

export function getProfessorToolDeclarations({ webSearchEnabled = false } = {}) {
  const functionDeclarations = [
        {
          name: 'open_pdf_page',
          description:
            'Opens and displays a specific page of a PDF on the Live Teacher Stage (works forward AND backward when the student asks to go back). Returns verbatim page text, exact line coordinate anchors for millimeter-accurate annotations, and loads the page image into your vision.',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              filename: { type: 'STRING', description: 'Optional partial PDF filename. Omit to keep current/primary PDF.' },
              page: { type: 'INTEGER', description: 'Exact 1-based page number to display.' },
              delta: { type: 'INTEGER', description: 'Relative page shift instead of absolute page (e.g. +1 for next page, -1 to go back one page).' },
              reason: { type: 'STRING', description: 'Short label shown to the student (e.g. "Volviendo a Pág. 8 por duda").' },
            },
          },
        },
        {
          name: 'annotate_pdf_page',
          description:
            'Draws smooth animated highlights, circles, underlines, boxes, arrows, callouts, or force vectors DIRECTLY ON TOP of the active PDF page. Always prefer `target_text` (exact words/equation snippet from the page) for sub-millimeter precision snapping!',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              clear_previous: { type: 'BOOLEAN', description: 'Set true only if clearing older annotations on this page first.' },
              annotations: {
                type: 'ARRAY',
                items: {
                  type: 'OBJECT',
                  properties: {
                    kind: {
                      type: 'STRING',
                      description: '"highlight", "circle", "underline", "box", "arrow", "callout", or "vector".',
                    },
                    target_text: {
                      type: 'STRING',
                      description: 'Exact phrase or formula snippet from the current PDF page for millimeter-accurate auto-snapping.',
                    },
                    label: { type: 'STRING', description: 'Short callout note or vector label.' },
                    color: { type: 'STRING', description: '"cyan", "amber", "emerald", or "rose".' },
                    x: { type: 'NUMBER', description: 'Optional fallback X (0..1000) for purely graphical regions.' },
                    y: { type: 'NUMBER', description: 'Optional fallback Y (0..vbH) for purely graphical regions.' },
                    w: { type: 'NUMBER', description: 'Optional width for box/highlight/circle.' },
                    h: { type: 'NUMBER', description: 'Optional height for box/highlight/circle.' },
                    x1: { type: 'NUMBER', description: 'Start X for vector/arrow.' },
                    y1: { type: 'NUMBER', description: 'Start Y for vector/arrow.' },
                    x2: { type: 'NUMBER', description: 'End X for vector/arrow.' },
                    y2: { type: 'NUMBER', description: 'End Y for vector/arrow.' },
                  },
                  required: ['kind'],
                },
              },
            },
            required: ['annotations'],
          },
        },
        {
          name: 'start_blank_canvas_problem',
          description:
            'Switches the stage smoothly from the PDF page to a clean Blank Canvas Problem-Solving Chalkboard. MANDATORY whenever an example, exercise, or mathematical derivation appears in the PDF! Draws the initial precision physical diagram + givens/unknown WITHOUT revealing the final answer yet.',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              problem_title: { type: 'STRING', description: 'Clear title (e.g. "Ejemplo 1: Transferencia de carga longitudinal").' },
              source_page: { type: 'INTEGER', description: 'PDF page where this problem appears.' },
              statement: { type: 'STRING', description: 'Concise problem statement.' },
              given_data: {
                type: 'ARRAY',
                description: 'Known parameters with color-stable badges.',
                items: {
                  type: 'OBJECT',
                  properties: {
                    symbol: { type: 'STRING' },
                    value: { type: 'STRING' },
                    unit: { type: 'STRING' },
                    color: { type: 'STRING' },
                  },
                  required: ['symbol', 'value'],
                },
              },
              unknown: {
                type: 'OBJECT',
                description: 'Target quantity we want to find.',
                properties: {
                  symbol: { type: 'STRING' },
                  label: { type: 'STRING' },
                  color: { type: 'STRING' },
                },
                required: ['symbol', 'label'],
              },
              variables: VARIABLE_LEGEND_SCHEMA,
              primitives: {
                type: 'ARRAY',
                description: 'Precision CAD/physics diagram primitives drawn stroke-by-stroke at the top of the blank canvas.',
                items: PRIMITIVE_ITEM_SCHEMA,
              },
              svg_code: {
                type: 'STRING',
                description: 'Optional custom precision SVG (viewBox="0 0 960 540") if primitives are not sufficient.',
              },
            },
            required: ['problem_title', 'statement'],
          },
        },
        {
          name: 'append_problem_step',
          description:
            'Appends ONE single incremental step onto the active Blank Canvas Problem Board. Use strictly ONE call per logical/algebraic step (Step 1: fundamental law -> Step 2..k: intermediate algebraic steps -> Final step: verified numerical substitution). NEVER jump straight to the final formula!',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              step_number: { type: 'INTEGER', description: '1-based step index.' },
              step_title: { type: 'STRING', description: 'Short step heading (e.g. "Equilibrio de momentos en el eje trasero").' },
              goal: { type: 'STRING', description: 'What this exact step seeks to isolate or establish.' },
              why_reason: { type: 'STRING', description: 'Physical or mathematical WHY behind choosing this law/operation.' },
              equation_html: {
                type: 'STRING',
                description: 'Textbook HTML equation for THIS step only (use <span class="frac">, <sub>, <sup>, color spans var-cyan/var-amber/var-emerald/var-rose; NO raw LaTeX).',
              },
              algebraic_detail: {
                type: 'STRING',
                description: 'Explicit intermediate algebraic manipulation or numerical substitution with units.',
              },
              is_final_step: { type: 'BOOLEAN', description: 'True ONLY on the final verified step with result and physical sanity check.' },
              diagram_primitives: {
                type: 'ARRAY',
                description: 'Optional extra primitives to append live onto the problem diagram (e.g. adding a resolved vector or dimension).',
                items: PRIMITIVE_ITEM_SCHEMA,
              },
            },
            required: ['step_number', 'step_title', 'why_reason', 'equation_html'],
          },
        },
        {
          name: 'return_to_pdf',
          description:
            'Transitions smoothly back from the Blank Canvas Problem Board to the PDF slide (preserving all annotations!) once an example/problem is finished.',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              page: { type: 'INTEGER', description: 'Optional PDF page to return to (defaults to the page where the problem started).' },
              summary: { type: 'STRING', description: 'One concise takeaway linking the solved problem back to the PDF.' },
            },
          },
        },
        {
          name: 'draw_live_scene',
          description:
            'Draws a publication-grade, stroke-animated diagram on the Blank Canvas Stage silently while speaking. Prefer `primitives` + `variables` for millimeter-accurate engineering/physics/math diagrams & curves; use `blocks` + `arrows` for concept maps/flows; or custom `svg_code` (viewBox="0 0 960 540", inline styles, NO <style> block).',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              scene_title: { type: 'STRING', description: 'Short clear title of the board.' },
              badge: { type: 'STRING', description: 'Short label e.g. "Diagrama de Sólido Libre", "Curva Neumático".' },
              variables: VARIABLE_LEGEND_SCHEMA,
              primitives: {
                type: 'ARRAY',
                description: 'Millimeter-accurate geometric/engineering primitives compiled into crisp CAD SVG.',
                items: PRIMITIVE_ITEM_SCHEMA,
              },
              blocks: {
                type: 'ARRAY',
                description: 'Structured concept cards (for conceptual comparisons/pipelines).',
                items: {
                  type: 'OBJECT',
                  properties: {
                    id: { type: 'STRING' },
                    title: { type: 'STRING' },
                    subtitle: { type: 'STRING' },
                    color: { type: 'STRING' },
                    col: { type: 'INTEGER' },
                    row: { type: 'INTEGER' },
                  },
                  required: ['id', 'title'],
                },
              },
              arrows: {
                type: 'ARRAY',
                description: 'Smooth Bezier arrows connecting block ids.',
                items: {
                  type: 'OBJECT',
                  properties: {
                    from: { type: 'STRING' },
                    to: { type: 'STRING' },
                    label: { type: 'STRING' },
                    color: { type: 'STRING' },
                  },
                  required: ['from', 'to'],
                },
              },
              svg_code: {
                type: 'STRING',
                description:
                  'Optional custom <svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg">...</svg> for bespoke visual illustrations. Inline fill/stroke attributes only, NO <style> tags.',
              },
              formula_html: { type: 'STRING', description: 'Optional clean textbook HTML formula pinned below the drawing.' },
              caption: { type: 'STRING', description: 'One concise takeaway sentence.' },
              source_ref: { type: 'STRING', description: 'Optional citation (filename · page/slide/sheet).' },
            },
            required: ['scene_title'],
          },
        },
        {
          name: 'point_to_stage_element',
          description:
            'Glides an animated glowing laser pointer and callout pill silently onto an element_id, exact PDF `target_text`, or (x, y) coordinate on the active stage (works on both PDF View and Blank Canvas!).',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              element_id: { type: 'STRING', description: 'Exact id of a primitive, block, or SVG element.' },
              target_text: { type: 'STRING', description: 'Exact phrase on the active PDF page to snap the laser pointer onto.' },
              x: { type: 'NUMBER', description: 'Fallback X coordinate.' },
              y: { type: 'NUMBER', description: 'Fallback Y coordinate.' },
              label: { type: 'STRING', description: 'Short crisp callout pill (max 55 chars).' },
              color: { type: 'STRING', description: '"cyan", "amber", "emerald", or "rose".' },
            },
            required: ['label'],
          },
        },
        {
          name: 'build_interactive_lab',
          description:
            'Builds a live interactive Explorable slider simulation right on the Teacher Stage (self-contained HTML/CSS/JS, zero external CDNs, color-stable variables). Use inputs with data-param="name" so update_lab_parameters can move sliders live.',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              title: { type: 'STRING' },
              badge: { type: 'STRING' },
              description: { type: 'STRING' },
              html_body: { type: 'STRING' },
            },
            required: ['title', 'html_body'],
          },
        },
        {
          name: 'update_lab_parameters',
          description: 'Moves sliders/inputs matching data-param="..." on the active Interactive Lab silently while explaining.',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              updates: { type: 'OBJECT', description: 'Key-value map of data-param names to values.' },
              note: { type: 'STRING' },
            },
            required: ['updates'],
          },
        },
        {
          name: 'write_whiteboard_lesson',
          description: 'Displays a crisp textbook derivation / concept summary card silently on stage with intuition, vertical HTML fractions, numbered steps, and a common-trap callout.',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              title: { type: 'STRING' },
              badge: { type: 'STRING' },
              intuition: { type: 'STRING' },
              formula_html: { type: 'STRING' },
              steps: { type: 'ARRAY', items: { type: 'STRING' } },
              common_trap: { type: 'STRING' },
              source_ref: { type: 'STRING' },
            },
            required: ['title'],
          },
        },
        {
          name: 'show_active_recall_quiz',
          description: 'Shows an interactive Predict-Then-Reveal question card silently on stage.',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              question: { type: 'STRING' },
              options: { type: 'ARRAY', items: { type: 'STRING' } },
              correct_index: { type: 'INTEGER' },
              explanation: { type: 'STRING' },
            },
            required: ['question', 'options', 'correct_index', 'explanation'],
          },
        },
        {
          name: 'search_study_materials',
          description: 'Searches all active study files in the folder (PDFs, PPTX, Excel + formulas, MD, DOCX, HTML) and returns exact excerpts with page/slide/sheet numbers.',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              query: { type: 'STRING' },
              filename: { type: 'STRING' },
              page: { type: 'INTEGER' },
            },
            required: ['query'],
          },
        },
        {
          name: 'verify_math_python',
          description: 'Executes a local Python calculation (math module) to verify engineering/physics/math numbers with 100% accuracy before speaking or writing them.',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              description: { type: 'STRING' },
              expression_or_code: { type: 'STRING' },
            },
            required: ['expression_or_code'],
          },
        },
        {
          name: 'class_progress',
          description:
            'Signals Continuous Class Director progress at the end of a teaching beat: use action="next_page" when you have thoroughly finished explaining everything on the current PDF page and are ready to flip to page+1, or action="continue_page" if more content remains on this page.',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              action: { type: 'STRING', description: '"continue_page", "next_page", or "finished_pdf".' },
              note: { type: 'STRING', description: 'Short internal note of what was covered.' },
            },
            required: ['action'],
          },
        },
        {
          name: 'class_control',
          description:
            'Directly controls and self-heals the Continuous Classroom Engine: skip the current beat, skip a long worked problem, advance/jump to any PDF page, pause/resume, or verify and auto-recover audio/GPU/queue state if anything stalls.',
          behavior: 'NON_BLOCKING',
          parameters: {
            type: 'OBJECT',
            properties: {
              action: {
                type: 'STRING',
                description: '"next_page", "prev_page", "goto_page", "skip_beat", "skip_problem", "pause", "resume", or "verify_recover".',
              },
              page: { type: 'INTEGER', description: 'Target PDF page number when action="goto_page".' },
            },
            required: ['action'],
          },
        },
  ];

  if (webSearchEnabled) {
    functionDeclarations.push(
      {
        name: 'research_web_verified',
        description:
          'PREFERRED web research tool: invokes the dedicated Web Research & Fact-Checking Subagent. It plans bilingual technical queries, filters out SEO farms/low-trust blogs, triangulates ≥2 academic/reference sources (Tier 1/2), audits strict fidelity against the student notes, and returns a verified, repeatable briefing.',
        behavior: 'NON_BLOCKING',
        parameters: {
          type: 'OBJECT',
          properties: {
            topic: {
              type: 'STRING',
              description:
                'Precise technical concept/law to verify (e.g. "sensibilidad de mu frente a carga vertical Fz neumático viscoelasticidad" — NEVER vague phrases like "página 3").',
            },
            notes_intent: {
              type: 'STRING',
              description:
                'One concise sentence stating the exact scope/intent of the student notes so the Research Agent blocks any off-syllabus drift.',
            },
            notes_excerpt: {
              type: 'STRING',
              description:
                'Optional short verbatim excerpt/formula from the active notes so the agent can detect notation or convention differences.',
            },
          },
          required: ['topic', 'notes_intent'],
        },
      },
      {
        name: 'search_web',
        description:
          'Direct low-level authority-filtered web search (prefer `research_web_verified` for full cross-checking). Use concise technical terms only.',
        behavior: 'NON_BLOCKING',
        parameters: {
          type: 'OBJECT',
          properties: {
            query: {
              type: 'STRING',
              description: 'Concise technical search query (4-9 high-signal keywords, e.g. "parallel axis theorem Steiner moment of inertia derivation").',
            },
            max_results: {
              type: 'INTEGER',
              description: 'Number of results to return (1..6, default 4).',
            },
          },
          required: ['query'],
        },
      },
      {
        name: 'fetch_web_page',
        description:
          'Reads the clean main text of a specific public URL returned by search_web when a snippet is not enough to verify an equation, physical constant, or mechanism.',
        behavior: 'NON_BLOCKING',
        parameters: {
          type: 'OBJECT',
          properties: {
            url: {
              type: 'STRING',
              description: 'Public http(s) URL returned by search_web.',
            },
          },
          required: ['url'],
        },
      },
    );
  }

  return [{ functionDeclarations }];
}
