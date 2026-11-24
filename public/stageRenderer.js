// Precision HTML-Studio Visual Art, Parametric Blueprints, Math Compiler & PDF Annotation Renderer
// Embodies: explorable (color-stable variables), impeccable (Read-mode clarity),
// motion-design (3-layer choreography), animate (60fps ease-out, reduced-motion).

import {
  BLUEPRINT_TEMPLATES,
  normalizeTemplateLayers,
  renderBlueprintLayersMarkup,
  buildParametricBlueprintSvg,
  evalSafeExpr,
} from './blueprintTemplates.js';

export { BLUEPRINT_TEMPLATES, normalizeTemplateLayers, renderBlueprintLayersMarkup, buildParametricBlueprintSvg, evalSafeExpr };

export const PALETTE = {
  cyan: { stroke: '#38bdf8', strong: '#0ea5e9', fill: 'rgba(56, 189, 248, 0.13)', text: '#7dd3fc', badgeBg: '#0c2336', pdfStroke: '#0284c7', pdfHl: 'rgba(56, 189, 248, 0.28)' },
  amber: { stroke: '#f59e0b', strong: '#d97706', fill: 'rgba(245, 158, 11, 0.14)', text: '#fcd34d', badgeBg: '#2b1e0a', pdfStroke: '#d97706', pdfHl: 'rgba(250, 204, 21, 0.34)' },
  emerald: { stroke: '#10b981', strong: '#059669', fill: 'rgba(16, 185, 129, 0.13)', text: '#6ee7b7', badgeBg: '#0a271f', pdfStroke: '#059669', pdfHl: 'rgba(16, 185, 129, 0.26)' },
  rose: { stroke: '#f43f5e', strong: '#e11d48', fill: 'rgba(244, 63, 94, 0.14)', text: '#fda4af', badgeBg: '#2e0f19', pdfStroke: '#e11d48', pdfHl: 'rgba(244, 63, 94, 0.25)' },
  slate: { stroke: '#94a3b8', strong: '#64748b', fill: 'rgba(148, 163, 184, 0.11)', text: '#cbd5e1', badgeBg: '#182234', pdfStroke: '#334155', pdfHl: 'rgba(148, 163, 184, 0.25)' },
};

export function getColor(name, fallback = 'cyan') {
  return PALETTE[String(name || '').toLowerCase()] || PALETTE[fallback] || PALETTE.cyan;
}

export function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function sanitizeRichHtml(html) {
  if (typeof document === 'undefined') {
    return String(html || '').replace(/<script[\s\S]*?<\/script>/gi, '');
  }
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  tpl.content.querySelectorAll('script, iframe, object, embed, link, meta, foreignObject').forEach((el) => el.remove());
  tpl.content.querySelectorAll('*').forEach((el) => {
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();
      const val = attr.value.trim().toLowerCase();
      if (name.startsWith('on') || val.startsWith('javascript:')) {
        el.removeAttribute(attr.name);
      }
    }
  });
  return tpl.innerHTML;
}

// ---------------- Bulletproof Math-to-HTML Compiler (LaTeX + Plain Math + HTML Repair) ----------------
function extractBraceGroup(str, startIdx) {
  if (str[startIdx] !== '{') return null;
  let depth = 0;
  for (let i = startIdx; i < str.length; i++) {
    if (str[i] === '{') depth++;
    else if (str[i] === '}') {
      depth--;
      if (depth === 0) {
        return { inner: str.slice(startIdx + 1, i), endIdx: i + 1 };
      }
    }
  }
  return null;
}

function replaceBalancedLatexCommand(str, cmd, numArgs, renderFn) {
  let out = str;
  const token = `\\${cmd}`;
  let guard = 0;
  while (guard++ < 25) {
    const idx = out.indexOf(token);
    if (idx === -1) break;
    let cursor = idx + token.length;
    while (cursor < out.length && /\s/.test(out[cursor])) cursor++;
    const args = [];
    let ok = true;
    for (let a = 0; a < numArgs; a++) {
      while (cursor < out.length && /\s/.test(out[cursor])) cursor++;
      const grp = extractBraceGroup(out, cursor);
      if (!grp) {
        ok = false;
        break;
      }
      args.push(grp.inner);
      cursor = grp.endIdx;
    }
    if (!ok) break;
    out = out.slice(0, idx) + renderFn(...args) + out.slice(cursor);
  }
  return out;
}

function compilePlainMathSegment(rawSeg) {
  let s = String(rawSeg || '').trim();
  if (!s) return '';

  // Strip outer $...$ / \[...\] / \(...\) delimiters
  s = s.replace(/^\$\$?|\$\$?$/g, '').replace(/^\\\[|\\\]$/g, '').replace(/^\\\(|\\\)$/g, '').trim();

  // Strip \left / \right and unwrap \text{...} / \mathrm{...} / \mathbf{...}
  s = s.replace(/\\(?:left|right)\b/g, '');
  s = replaceBalancedLatexCommand(s, 'text', 1, (a) => a);
  s = replaceBalancedLatexCommand(s, 'mathrm', 1, (a) => a);
  s = replaceBalancedLatexCommand(s, 'mathbf', 1, (a) => a);

  // Replace Greek & math commands cleanly BEFORE escaping
  const latexSymbols = [
    [/\\Delta\b|\bDelta\b/g, 'Δ'],
    [/\\Sigma\b|\\sum\b|\bSigma\b/g, 'Σ'],
    [/\\alpha\b/g, 'α'],
    [/\\beta\b/g, 'β'],
    [/\\gamma\b/g, 'γ'],
    [/\\theta\b/g, 'θ'],
    [/\\varphi\b|\\phi\b/g, 'φ'],
    [/\\omega\b/g, 'ω'],
    [/\\Omega\b/g, 'Ω'],
    [/\\mu\b/g, 'μ'],
    [/\\pi\b/g, 'π'],
    [/\\rho\b/g, 'ρ'],
    [/\\lambda\b/g, 'λ'],
    [/\\perp\b/g, '⊥'],
    [/\\cdot\b/g, '·'],
    [/\\times\b/g, '×'],
    [/\\Rightarrow\b|=>/g, '⇒'],
    [/\\rightarrow\b|\\to\b|->/g, '→'],
    [/\\propto\b|\\sim\b/g, '∝'],
    [/\s+~\s+/g, ' ∝ '],
    [/\\approx\b/g, '≈'],
    [/\\neq\b|!=/g, '≠'],
    [/\\leq\b|\\le\b|<=/g, '≤'],
    [/\\geq\b|\\ge\b|>=/g, '≥'],
    [/\\pm\b|\+\-/g, '±'],
    [/\\infty\b/g, '∞'],
    [/\\qquad\b/g, '   |   '],
    [/\\quad\b/g, '   |   '],
    [/\\[,;:!]/g, ' '],
    [/\\%/g, '%'],
    [/\\(?:sin|sen)\b/g, 'sen '],
    [/\\cos\b/g, 'cos '],
    [/\\tan\b/g, 'tan '],
    [/\\vec\{([A-Za-z])\}/g, '$1⃗'],
    [/\\hat\{([A-Za-z])\}/g, '$1̂'],
  ];
  for (const [re, rep] of latexSymbols) s = s.replace(re, rep);
  // Tighten Δ F_z -> ΔF_z and Σ M_y -> ΣM_y for crisp textbook typography
  s = s.replace(/([ΔΣ])\s+([A-Za-z])/g, '$1$2');

  // Clean ASCII multiplication '*' (not '**') and minus '-' between spaces
  s = s.replace(/\s*\*\s*/g, ' · ');
  s = s.replace(/\s+-\s+/g, ' − ');

  // Protect placeholders while compiling nested \frac and \sqrt
  const slots = [];
  const putSlot = (html) => {
    const id = `\uE000${slots.length}\uE001`;
    slots.push(html);
    return id;
  };

  // Recursive \frac{A}{B}
  s = replaceBalancedLatexCommand(s, 'frac', 2, (num, den) =>
    putSlot(`<span class="frac"><span class="num">${compilePlainMathSegment(num)}</span><span class="den">${compilePlainMathSegment(den)}</span></span>`),
  );

  // Recursive \sqrt{A} and plain sqrt(...)
  s = replaceBalancedLatexCommand(s, 'sqrt', 1, (rad) =>
    putSlot(`<span class="sqrt"><span class="sqrt-sym">√</span><span class="sqrt-rad">${compilePlainMathSegment(rad)}</span></span>`),
  );
  s = s.replace(/\bsqrt\(([^()]+)\)/gi, (_, rad) =>
    putSlot(`<span class="sqrt"><span class="sqrt-sym">√</span><span class="sqrt-rad">${compilePlainMathSegment(rad)}</span></span>`),
  );

  // Plain parenthesized fractions: (A) / (B), (A) / token, token / (B)
  s = s.replace(/\(([^()]+)\)\s*\/\s*\(([^()]+)\)/gu, (_, num, den) =>
    putSlot(`<span class="frac"><span class="num">${compilePlainMathSegment(num)}</span><span class="den">${compilePlainMathSegment(den)}</span></span>`),
  );
  s = s.replace(/\(([^()]+)\)\s*\/\s*([\p{L}\p{N}ΔΣ⊥_{}^]+)/gu, (_, num, den) =>
    putSlot(`<span class="frac"><span class="num">${compilePlainMathSegment(num)}</span><span class="den">${compilePlainMathSegment(den)}</span></span>`),
  );
  s = s.replace(/([\p{L}\p{N}ΔΣ⊥_{}^]+)\s*\/\s*\(([^()]+)\)/gu, (_, num, den) =>
    putSlot(`<span class="frac"><span class="num">${compilePlainMathSegment(num)}</span><span class="den">${compilePlainMathSegment(den)}</span></span>`),
  );
  // Simple standalone algebraic ratios like 1/2, b/L, a/L, h_CG/L (skip engineering units like m/s, km/h, N/mm, rad/s!)
  const UNIT_RATIOS = new Set(['m/s', 'm/s2', 'm/s^2', 'km/h', 'n/m', 'n/mm', 'kn/m', 'rad/s', 'kg/m', 'kg/m3', 'kg/m^3', 'g/cm3', 'cv/kg', 'kw/t']);
  s = s.replace(/(?<![\p{L}\p{N}/])([\p{L}\p{N}Δ]+(?:_(?:\{[^}]+\}|[\p{L}\p{N}⊥,]+))?)\s*\/\s*([\p{L}\p{N}Δ]+(?:_(?:\{[^}]+\}|[\p{L}\p{N}⊥,]+))?)(?![\p{L}\p{N}/])/gu, (full, num, den) => {
    if (UNIT_RATIOS.has(`${num}/${den}`.toLowerCase())) return full;
    return putSlot(`<span class="frac"><span class="num">${compilePlainMathSegment(num)}</span><span class="den">${compilePlainMathSegment(den)}</span></span>`);
  });

  // Escape HTML safely before adding <sub>/<sup>
  s = escapeHtml(s);

  // Full Unicode subscripts & superscripts (handles Spanish accents like μ_teórico, F_tracción, V_máx cleanly!)
  s = s.replace(/_\{([^{}]+)\}/gu, (_, sub) => `<sub>${sub.replace(/perp/g, '⊥')}</sub>`);
  s = s.replace(/\^\{([^{}]+)\}/gu, (_, sup) => `<sup>${sup}</sup>`);
  s = s.replace(/_(perp|[\p{L}\p{N}⊥,]{1,16})(?![\p{L}\p{N}])/gu, (_, sub) => `<sub>${sub === 'perp' ? '⊥' : sub}</sub>`);
  s = s.replace(/\^([+\-−]?[\p{L}\p{N}]{1,4})(?![\p{L}\p{N}])/gu, '<sup>$1</sup>');

  // Restore stacked fractions & radicals
  for (let i = slots.length - 1; i >= 0; i--) {
    s = s.split(`\uE000${i}\uE001`).join(slots[i]);
  }
  return s;
}

export function formatInlineMathHtml(raw) {
  let s = escapeHtml(String(raw ?? ''));
  if (!s) return '';
  s = s.replace(/\\Delta\b/g, 'Δ').replace(/\\mu\b/g, 'μ').replace(/\\alpha\b/g, 'α').replace(/\\cdot\b/g, '·');
  s = s.replace(/_\{([^{}]+)\}/gu, (_, sub) => `<sub>${sub.replace(/perp/g, '⊥')}</sub>`);
  s = s.replace(/\^\{([^{}]+)\}/gu, (_, sup) => `<sup>${sup}</sup>`);
  s = s.replace(/(?<=[\p{L}\p{N}])_(perp|[\p{L}\p{N}⊥,]{1,16})(?![\p{L}\p{N}])/gu, (_, sub) => `<sub>${sub === 'perp' ? '⊥' : sub}</sub>`);
  s = s.replace(/(?<=[\p{L}\p{N})])\^([+\-−]?[\p{L}\p{N}]{1,4})(?![\p{L}\p{N}])/gu, '<sup>$1</sup>');
  return s;
}

export function renderMathExpressionHtml(raw) {
  const txt = String(raw || '').trim();
  if (!txt) return '';
  // If already formatted with clean HTML tags AND contains no raw LaTeX commands (\frac, \Delta, _{), sanitize & return!
  const hasHtml = /<(?:span|sub|sup|b|i|strong)\b/i.test(txt);
  const hasRawLatex = /\\(?:frac|sqrt|Delta|Sigma|sum|cdot|times|alpha|beta|gamma|theta|phi|omega|mu|pi|perp|propto|Rightarrow)|_\{|\^\{/.test(txt);
  if (hasHtml && !hasRawLatex) {
    return sanitizeRichHtml(txt);
  }
  if (hasHtml && hasRawLatex) {
    // Strip broken HTML tags cleanly and recompile cleanly via the math compiler so formulas NEVER look broken!
    const stripped = txt.replace(/<[^>]+>/g, '');
    return sanitizeRichHtml(compilePlainMathSegment(stripped));
  }
  return sanitizeRichHtml(compilePlainMathSegment(txt));
}

export function renderVariableLegendHtml(variables) {
  if (!Array.isArray(variables) || !variables.length) return '';
  const chips = variables
    .slice(0, 8)
    .map((v) => {
      const key = PALETTE[String(v.color || '').toLowerCase()] ? String(v.color).toLowerCase() : 'cyan';
      return `<span class="var-chip var-chip-${key}"><strong class="var-sym">${formatInlineMathHtml(v.symbol || '')}</strong><span class="var-desc">${formatInlineMathHtml(v.label || '')}</span></span>`;
    })
    .join('');
  return `<div class="var-legend" aria-label="Variables">${chips}</div>`;
}

// ---------------- Safe Math Expression Evaluator for plot_curve ----------------
function compileSafeMathExpr(rawExpr) {
  return evalSafeExpr(rawExpr);
}

function fmtTick(val) {
  if (Math.abs(val) < 1e-9) return '0';
  if (Math.abs(val) >= 100 || Number.isInteger(val)) return String(Math.round(val * 100) / 100);
  return Number(val.toFixed(2)).toString();
}

function wrapSvgLines(text, maxChars) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      lines.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

// ---------------- Shared Precision SVG Defs ----------------
function buildBlueprintDefs(prefix = 'cad') {
  const mkArrow = (key, color) => `
    <marker id="${prefix}-arr-${key}" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M 1 1.5 L 11 6 L 1 10.5 L 3.4 6 Z" fill="${color}" />
    </marker>
    <marker id="${prefix}-tick-${key}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" orient="auto">
      <path d="M 1 9 L 9 1" stroke="${color}" stroke-width="1.8" stroke-linecap="round" />
    </marker>
  `;

  return `
    <defs>
      <pattern id="${prefix}-grid" width="24" height="24" patternUnits="userSpaceOnUse">
        <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(148,163,184,0.065)" stroke-width="0.8" />
      </pattern>
      <pattern id="${prefix}-hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="10" stroke="rgba(148,163,184,0.38)" stroke-width="1.5" />
      </pattern>
      <linearGradient id="${prefix}-body-cyan" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.24" />
        <stop offset="100%" stop-color="#0f2234" stop-opacity="0.72" />
      </linearGradient>
      <linearGradient id="${prefix}-body-amber" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.24" />
        <stop offset="100%" stop-color="#271c0a" stop-opacity="0.72" />
      </linearGradient>
      <linearGradient id="${prefix}-body-emerald" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#10b981" stop-opacity="0.24" />
        <stop offset="100%" stop-color="#0c261f" stop-opacity="0.72" />
      </linearGradient>
      <linearGradient id="${prefix}-body-rose" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#f43f5e" stop-opacity="0.24" />
        <stop offset="100%" stop-color="#2b1019" stop-opacity="0.72" />
      </linearGradient>
      <linearGradient id="${prefix}-body-slate" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#94a3b8" stop-opacity="0.20" />
        <stop offset="100%" stop-color="#141e2e" stop-opacity="0.78" />
      </linearGradient>
      <filter id="${prefix}-glow" x="-25%" y="-25%" width="150%" height="150%">
        <feGaussianBlur stdDeviation="2.6" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>
      ${mkArrow('cyan', PALETTE.cyan.stroke)}
      ${mkArrow('amber', PALETTE.amber.stroke)}
      ${mkArrow('emerald', PALETTE.emerald.stroke)}
      ${mkArrow('rose', PALETTE.rose.stroke)}
      ${mkArrow('slate', PALETTE.slate.stroke)}
    </defs>
  `;
}

// Helper for crisp pill text badge inside SVG
function svgPillLabel(x, y, text, colorKey = 'cyan', step = 3, anchor = 'middle') {
  if (!text) return '';
  const pal = getColor(colorKey);
  const clean = String(text);
  const w = Math.max(40, Math.min(260, clean.length * 7.8 + 18));
  const h = 24;
  const rx = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
  const tx = rx + w / 2;
  return `
    <g data-step="${step}">
      <rect x="${rx.toFixed(1)}" y="${(y - h / 2).toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="6"
        fill="${pal.badgeBg}" stroke="${pal.stroke}" stroke-width="1.2" opacity="0.94" data-step="${step}" />
      <text x="${tx.toFixed(1)}" y="${(y + 4.5).toFixed(1)}" text-anchor="middle" fill="${pal.text}"
        font-size="13" font-weight="650" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif" data-step="${step}">${escapeHtml(clean)}</text>
    </g>
  `;
}

// ---------------- Precision CAD Primitives Compiler ----------------
export function renderPrimitiveToSvg(p, idx, ctx) {
  if (!p || typeof p !== 'object') return '';
  const kind = String(p.kind || '').toLowerCase();
  const colorKey = PALETTE[String(p.color || '').toLowerCase()] ? String(p.color).toLowerCase() : 'cyan';
  const pal = getColor(colorKey);
  const prefix = ctx.prefix || 'cad';
  const idAttr = p.id ? ` id="${escapeHtml(p.id)}"` : ` id="prim-${idx}"`;

  // Default 3-layer motion-design choreography steps
  const defaultStep =
    kind === 'ground' || kind === 'axes'
      ? 1
      : kind === 'body' || kind === 'wheel' || kind === 'plot_curve' || kind === 'spring' || kind === 'damper'
        ? 2
        : kind === 'callout'
          ? 4
          : 3;
  const step = Number(p.step) || defaultStep;

  if (kind === 'ground') {
    const x1 = Number(p.x1 ?? 70);
    const x2 = Number(p.x2 ?? 890);
    const y = Number(p.y ?? 435);
    return `
      <g${idAttr} data-step="${step}">
        <rect x="${Math.min(x1, x2)}" y="${y}" width="${Math.abs(x2 - x1)}" height="16" fill="url(#${prefix}-hatch)" opacity="0.7" data-step="${step}" />
        <line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#64748b" stroke-width="2.6" stroke-linecap="round" data-step="${step}" />
        ${p.label ? `<text x="${x2 - 8}" y="${y + 32}" text-anchor="end" fill="#94a3b8" font-size="12.5" font-weight="600" font-family="ui-monospace, monospace" data-step="${step}">${escapeHtml(p.label)}</text>` : ''}
      </g>
    `;
  }

  if (kind === 'axes') {
    const x = Number(p.x ?? 110);
    const y = Number(p.y ?? 75);
    const width = Number(p.width ?? p.w ?? 740);
    const height = Number(p.height ?? p.h ?? 365);
    const xMin = Number(p.xMin ?? 0);
    const xMax = Number(p.xMax ?? 10);
    const yMin = Number(p.yMin ?? 0);
    const yMax = Number(p.yMax ?? 10);

    ctx.lastAxes = { x, y, width, height, xMin, xMax, yMin, yMax };

    const mapX = (vx) => x + ((vx - xMin) / (xMax - xMin || 1)) * width;
    const mapY = (vy) => y + height - ((vy - yMin) / (yMax - yMin || 1)) * height;

    // Position axis baselines through origin if inside domain, else along frame edges
    const yZero = yMin <= 0 && yMax >= 0 ? mapY(0) : y + height;
    const xZero = xMin <= 0 && xMax >= 0 ? mapX(0) : x;

    let ticks = '';
    const xSteps = 5;
    for (let i = 0; i <= xSteps; i++) {
      const val = xMin + (i / xSteps) * (xMax - xMin);
      const px = mapX(val);
      ticks += `<line x1="${px.toFixed(1)}" y1="${y}" x2="${px.toFixed(1)}" y2="${y + height}" stroke="rgba(148,163,184,0.12)" stroke-width="1" data-step="${step}" />`;
      ticks += `<line x1="${px.toFixed(1)}" y1="${(yZero - 4).toFixed(1)}" x2="${px.toFixed(1)}" y2="${(yZero + 4).toFixed(1)}" stroke="#64748b" stroke-width="1.5" data-step="${step}" />`;
      ticks += `<text x="${px.toFixed(1)}" y="${(y + height + 19).toFixed(1)}" text-anchor="middle" fill="#94a3b8" font-size="11.5" font-family="ui-monospace, monospace" data-step="${step}">${fmtTick(val)}</text>`;
    }

    const ySteps = 4;
    for (let i = 0; i <= ySteps; i++) {
      const val = yMin + (i / ySteps) * (yMax - yMin);
      const py = mapY(val);
      ticks += `<line x1="${x}" y1="${py.toFixed(1)}" x2="${x + width}" y2="${py.toFixed(1)}" stroke="rgba(148,163,184,0.12)" stroke-width="1" data-step="${step}" />`;
      ticks += `<line x1="${(xZero - 4).toFixed(1)}" y1="${py.toFixed(1)}" x2="${(xZero + 4).toFixed(1)}" y2="${py.toFixed(1)}" stroke="#64748b" stroke-width="1.5" data-step="${step}" />`;
      ticks += `<text x="${(x - 10).toFixed(1)}" y="${(py + 4).toFixed(1)}" text-anchor="end" fill="#94a3b8" font-size="11.5" font-family="ui-monospace, monospace" data-step="${step}">${fmtTick(val)}</text>`;
    }

    return `
      <g${idAttr} data-step="${step}">
        <rect x="${x}" y="${y}" width="${width}" height="${height}" rx="6" fill="rgba(11,15,23,0.45)" stroke="rgba(148,163,184,0.22)" stroke-width="1" data-step="${step}" />
        ${ticks}
        <line x1="${x}" y1="${yZero.toFixed(1)}" x2="${x + width + 14}" y2="${yZero.toFixed(1)}" stroke="#cbd5e1" stroke-width="2" marker-end="url(#${prefix}-arr-slate)" data-step="${step}" />
        <line x1="${xZero.toFixed(1)}" y1="${y + height}" x2="${xZero.toFixed(1)}" y2="${y - 14}" stroke="#cbd5e1" stroke-width="2" marker-end="url(#${prefix}-arr-slate)" data-step="${step}" />
        ${p.xLabel ? `<text x="${(x + width / 2).toFixed(1)}" y="${(y + height + 40).toFixed(1)}" text-anchor="middle" fill="#e2e8f0" font-size="13" font-weight="650" font-family="-apple-system, sans-serif" data-step="${step}">${escapeHtml(p.xLabel)}</text>` : ''}
        ${p.yLabel ? `<text x="${x.toFixed(1)}" y="${y - 20}" text-anchor="start" fill="#e2e8f0" font-size="13" font-weight="650" font-family="-apple-system, sans-serif" data-step="${step}">${escapeHtml(p.yLabel)}</text>` : ''}
      </g>
    `;
  }

  if (kind === 'plot_curve') {
    const ax = ctx.lastAxes || {
      x: Number(p.x ?? 110),
      y: Number(p.y ?? 75),
      width: Number(p.width ?? p.w ?? 740),
      height: Number(p.height ?? p.h ?? 365),
      xMin: Number(p.xMin ?? 0),
      xMax: Number(p.xMax ?? 10),
      yMin: Number(p.yMin ?? 0),
      yMax: Number(p.yMax ?? 10),
    };
    const xMin = p.xMin != null ? Number(p.xMin) : ax.xMin;
    const xMax = p.xMax != null ? Number(p.xMax) : ax.xMax;
    let yMin = p.yMin != null ? Number(p.yMin) : ax.yMin;
    let yMax = p.yMax != null ? Number(p.yMax) : ax.yMax;
    const hint = `${p.expr || ''} ${p.label || ''}`.toLowerCase();
    const fn =
      compileSafeMathExpr(p.expr || '') ||
      ((vx) => {
        const u = (vx - xMin) / (xMax - xMin || 1);
        if (/\/|inv|p\s*\/\s*v|trac/.test(hint)) return yMin + (yMax - yMin) * Math.min(1, 0.24 / Math.max(0.18, u + 0.04));
        if (/\^2|²|quad|aero|drag/.test(hint)) return yMin + (yMax - yMin) * 0.85 * u * u;
        if (/\^3|³|cub|pot/.test(hint)) return yMin + (yMax - yMin) * 0.85 * u * u * u;
        return yMin + (yMax - yMin) * 0.8 * u;
      });

    const rawPts = [];
    const samples = 140;
    for (let i = 0; i <= samples; i++) {
      const vx = xMin + (i / samples) * (xMax - xMin);
      const vy = fn(vx);
      if (Number.isFinite(vy) && Math.abs(vy) < 1e9) rawPts.push([vx, vy]);
    }
    if (rawPts.length < 2) return '';

    // Auto-rescale Y if formula shoots far above yMax or stays invisibly flat near yMin
    const ys = rawPts.map((pt) => pt[1]).sort((a, b) => a - b);
    const p95 = ys[Math.floor(ys.length * 0.95)];
    const p05 = ys[Math.floor(ys.length * 0.05)];
    const clippedRatio = ys.filter((v) => v > yMax * 1.05).length / ys.length;
    if ((clippedRatio > 0.55 || (yMin === 0 && p95 > 0 && p95 < yMax * 0.08)) && p95 > p05) {
      yMin = p05 >= 0 ? 0 : p05 * 1.1;
      yMax = p95 * 1.15;
    }

    const mapX = (vx) => ax.x + ((vx - xMin) / (xMax - xMin || 1)) * ax.width;
    const mapY = (vy) => ax.y + ax.height - ((vy - yMin) / (yMax - yMin || 1)) * ax.height;

    const pts = rawPts.map(([vx, vy]) => [
      mapX(vx),
      mapY(Math.max(yMin - (yMax - yMin) * 0.04, Math.min(yMax + (yMax - yMin) * 0.04, vy))),
    ]);

    const d = pts.map(([px, py], i) => `${i === 0 ? 'M' : 'L'} ${px.toFixed(1)} ${py.toFixed(1)}`).join(' ');
    const baseLineY = yMin <= 0 && yMax >= 0 ? mapY(0) : ax.y + ax.height;
    const areaD = `${d} L ${pts[pts.length - 1][0].toFixed(1)} ${baseLineY.toFixed(1)} L ${pts[0][0].toFixed(1)} ${baseLineY.toFixed(1)} Z`;

    let highlights = '';
    for (const hp of Array.isArray(p.highlightPoints) ? p.highlightPoints : []) {
      const hxVal = Number(hp.x);
      if (!Number.isFinite(hxVal)) continue;
      const hyVal = fn(hxVal);
      if (!Number.isFinite(hyVal)) continue;
      const hx = mapX(hxVal);
      const hy = mapY(hyVal);
      highlights += `
        <line x1="${hx.toFixed(1)}" y1="${baseLineY.toFixed(1)}" x2="${hx.toFixed(1)}" y2="${hy.toFixed(1)}" stroke="${pal.stroke}" stroke-width="1.2" stroke-dasharray="4 4" opacity="0.65" data-step="${step + 1}" />
        <circle cx="${hx.toFixed(1)}" cy="${hy.toFixed(1)}" r="5.5" fill="#0b0f17" stroke="${pal.stroke}" stroke-width="2.6" data-step="${step + 1}" />
        ${hp.label ? svgPillLabel(hx, Math.max(ax.y + 16, hy - 24), hp.label, colorKey, step + 1) : ''}
      `;
    }

    const lastPt = pts[Math.floor(pts.length * 0.82)];
    return `
      <g${idAttr} data-step="${step}">
        ${p.fillUnder ? `<path d="${areaD}" fill="${pal.fill}" opacity="0.65" data-step="${step}" />` : ''}
        <path d="${d}" fill="none" stroke="${pal.stroke}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"${p.dashed ? ' stroke-dasharray="7 5"' : ''} filter="url(#${prefix}-glow)" data-pen="1" data-pen-color="${pal.stroke}" data-step="${step}" />
        ${p.label ? svgPillLabel(Math.min(ax.x + ax.width - 75, lastPt[0]), Math.max(ax.y + 18, lastPt[1] - 20), p.label, colorKey, step) : ''}
        ${highlights}
      </g>
    `;
  }

  if (kind === 'body') {
    const shape = String(p.shape || 'rect').toLowerCase();
    const x = Number(p.x ?? 260);
    const y = Number(p.y ?? 200);
    const w = Number(p.w ?? p.width ?? 420);
    const h = Number(p.h ?? p.height ?? 120);
    const cx = Number(p.cx ?? x + w / 2);
    const cy = Number(p.cy ?? y + h / 2);
    const rot = Number(p.angleDeg || 0);
    const transformAttr = rot ? ` transform="rotate(${rot} ${cx} ${cy})"` : '';
    const fillGrad = `url(#${prefix}-body-${colorKey})`;

    let geom = '';
    if (shape === 'chassis') {
      // Sleek GT racecar side-profile silhouette scaled accurately to (x, y, w, h)
      const d = [
        `M ${x + w * 0.04} ${y + h * 0.88}`,
        `L ${x + w * 0.02} ${y + h * 0.62}`,
        `Q ${x + w * 0.05} ${y + h * 0.42}, ${x + w * 0.25} ${y + h * 0.36}`,
        `Q ${x + w * 0.40} ${y + h * 0.04}, ${x + w * 0.62} ${y + h * 0.05}`,
        `Q ${x + w * 0.80} ${y + h * 0.14}, ${x + w * 0.94} ${y + h * 0.34}`,
        `L ${x + w * 0.98} ${y + h * 0.45}`,
        `L ${x + w * 0.96} ${y + h * 0.88}`,
        `Z`,
      ].join(' ');
      const cabinD = `M ${x + w * 0.33} ${y + h * 0.38} Q ${x + w * 0.46} ${y + h * 0.14}, ${x + w * 0.65} ${y + h * 0.15} L ${x + w * 0.74} ${y + h * 0.38} Z`;
      const wingD = `M ${x + w * 0.90} ${y + h * 0.30} L ${x + w * 0.97} ${y + h * 0.08} L ${x + w * 1.03} ${y + h * 0.11} L ${x + w * 0.96} ${y + h * 0.33}`;
      geom = `
        <path d="${d}" fill="${fillGrad}" stroke="${pal.stroke}" stroke-width="2.4" stroke-linejoin="round" data-pen="1" data-pen-color="${pal.stroke}" data-step="${step}" />
        <path d="${cabinD}" fill="rgba(15,23,42,0.55)" stroke="${pal.stroke}" stroke-width="1.3" opacity="0.8" data-step="${step}" />
        <path d="${wingD}" fill="none" stroke="${pal.stroke}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" data-step="${step}" />
        <line x1="${x - 10}" y1="${y + h * 0.62}" x2="${x + w + 10}" y2="${y + h * 0.62}" stroke="${pal.stroke}" stroke-width="0.9" stroke-dasharray="6 5" opacity="0.35" data-step="${step}" />
      `;
    } else if (shape === 'circle' || shape === 'ring') {
      const r = Number(p.r ?? Math.min(w, h) / 2);
      const innerR = shape === 'ring' ? Number(p.innerR ?? r * 0.55) : 0;
      geom = `
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="${fillGrad}" stroke="${pal.stroke}" stroke-width="2.4" data-step="${step}" />
        ${innerR > 0 ? `<circle cx="${cx}" cy="${cy}" r="${innerR}" fill="#0b0f17" stroke="${pal.stroke}" stroke-width="2" data-step="${step}" />` : ''}
        <line x1="${cx - r - 12}" y1="${cy}" x2="${cx + r + 12}" y2="${cy}" stroke="${pal.stroke}" stroke-width="1" stroke-dasharray="5 4" opacity="0.45" data-step="${step}" />
        <line x1="${cx}" y1="${cy - r - 12}" x2="${cx}" y2="${cy + r + 12}" stroke="${pal.stroke}" stroke-width="1" stroke-dasharray="5 4" opacity="0.45" data-step="${step}" />
      `;
    } else if (shape === 'wedge') {
      const d = `M ${x} ${y + h} L ${x + w} ${y + h} L ${x + w} ${y} Z`;
      geom = `<path d="${d}" fill="${fillGrad}" stroke="${pal.stroke}" stroke-width="2.4" stroke-linejoin="round" data-step="${step}" />`;
    } else if (shape === 'polygon' && Array.isArray(p.points) && p.points.length >= 3) {
      const ptsStr = p.points.map((pt) => (Array.isArray(pt) ? `${pt[0]},${pt[1]}` : `${pt.x},${pt.y}`)).join(' ');
      geom = `<polygon points="${ptsStr}" fill="${fillGrad}" stroke="${pal.stroke}" stroke-width="2.4" stroke-linejoin="round" data-step="${step}" />`;
    } else {
      geom = `
        <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${shape === 'beam' ? 4 : 10}" fill="${fillGrad}" stroke="${pal.stroke}" stroke-width="2.3" data-step="${step}" />
        <line x1="${x - 8}" y1="${cy}" x2="${x + w + 8}" y2="${cy}" stroke="${pal.stroke}" stroke-width="0.9" stroke-dasharray="6 5" opacity="0.38" data-step="${step}" />
      `;
    }

    return `
      <g${idAttr}${transformAttr} data-step="${step}">
        ${geom}
        ${p.label ? `<text x="${cx}" y="${cy + 5}" text-anchor="middle" fill="${pal.text}" font-size="14.5" font-weight="650" font-family="-apple-system, sans-serif" data-step="${step}">${escapeHtml(p.label)}</text>` : ''}
      </g>
    `;
  }

  if (kind === 'wheel') {
    const cx = Number(p.cx ?? p.x ?? 300);
    const cy = Number(p.cy ?? p.y ?? 390);
    const r = Number(p.r ?? 44);
    const rimR = Number(p.innerR ?? r * 0.62);
    const camber = Number(p.camberDeg || 0);
    let spokes = '';
    for (let i = 0; i < 5; i++) {
      const ang = (i * 72 * Math.PI) / 180;
      spokes += `<line x1="${cx}" y1="${cy}" x2="${(cx + Math.cos(ang) * rimR).toFixed(1)}" y2="${(cy + Math.sin(ang) * rimR).toFixed(1)}" stroke="#64748b" stroke-width="2.2" data-step="${step}" />`;
    }
    return `
      <g${idAttr} transform="rotate(${camber} ${cx} ${cy})" data-step="${step}">
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="#111827" stroke="#94a3b8" stroke-width="3" data-step="${step}" />
        <circle cx="${cx}" cy="${cy}" r="${rimR}" fill="#1e293b" stroke="${pal.stroke}" stroke-width="2" data-step="${step}" />
        ${spokes}
        <circle cx="${cx}" cy="${cy}" r="6" fill="${pal.stroke}" data-step="${step}" />
        <path d="M ${(cx - r * 0.42).toFixed(1)} ${(cy + r).toFixed(1)} L ${(cx + r * 0.42).toFixed(1)} ${(cy + r).toFixed(1)}" stroke="${PALETTE.amber.stroke}" stroke-width="4" stroke-linecap="round" data-step="${step}" />
        ${p.label ? `<text x="${cx}" y="${cy + r + 24}" text-anchor="middle" fill="${pal.text}" font-size="13" font-weight="650" font-family="-apple-system, sans-serif" data-step="${step}">${escapeHtml(p.label)}</text>` : ''}
      </g>
    `;
  }

  if (kind === 'cg_marker') {
    const cx = Number(p.cx ?? p.x ?? 480);
    const cy = Number(p.cy ?? p.y ?? 260);
    const r = Number(p.r ?? 13);
    return `
      <g${idAttr} data-step="${step}">
        <line x1="${cx - r - 9}" y1="${cy}" x2="${cx + r + 9}" y2="${cy}" stroke="${pal.stroke}" stroke-width="1.3" opacity="0.7" data-step="${step}" />
        <line x1="${cx}" y1="${cy - r - 9}" x2="${cx}" y2="${cy + r + 9}" stroke="${pal.stroke}" stroke-width="1.3" opacity="0.7" data-step="${step}" />
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="#0b0f17" stroke="${pal.stroke}" stroke-width="2.2" data-step="${step}" />
        <path d="M ${cx} ${cy} L ${cx + r} ${cy} A ${r} ${r} 0 0 1 ${cx} ${cy + r} Z" fill="${pal.stroke}" data-step="${step}" />
        <path d="M ${cx} ${cy} L ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx} ${cy - r} Z" fill="${pal.stroke}" data-step="${step}" />
        ${p.label ? svgPillLabel(cx + r + 14, cy - r - 8, p.label, colorKey, step, 'start') : ''}
      </g>
    `;
  }

  if (kind === 'vector') {
    const x1 = Number(p.x1 ?? p.x ?? 480);
    const y1 = Number(p.y1 ?? p.y ?? 260);
    let x2 = p.x2 != null ? Number(p.x2) : x1;
    let y2 = p.y2 != null ? Number(p.y2) : y1 + 100;
    if (p.x2 == null && p.angleDeg != null) {
      const len = Number(p.length ?? p.r ?? 110);
      const rad = (Number(p.angleDeg) * Math.PI) / 180;
      x2 = x1 + Math.cos(rad) * len;
      y2 = y1 - Math.sin(rad) * len;
    }
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    const lx = (x1 + x2) / 2 + nx * 24;
    const ly = (y1 + y2) / 2 + ny * 24;

    let compSvg = '';
    if (p.showComponents && Math.abs(dx) > 16 && Math.abs(dy) > 16) {
      compSvg = `
        <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y1}" stroke="${pal.stroke}" stroke-width="1.6" stroke-dasharray="5 4" opacity="0.72" marker-end="url(#${prefix}-arr-${colorKey})" data-step="${step}" />
        <line x1="${x2}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${pal.stroke}" stroke-width="1.6" stroke-dasharray="5 4" opacity="0.72" marker-end="url(#${prefix}-arr-${colorKey})" data-step="${step}" />
      `;
    }

    return `
      <g${idAttr} data-step="${step}">
        ${compSvg}
        <line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"
          stroke="${pal.stroke}" stroke-width="3.2" stroke-linecap="round"${p.dashed ? ' stroke-dasharray="7 5"' : ''}
          marker-end="url(#${prefix}-arr-${colorKey})" filter="url(#${prefix}-glow)" data-pen="1" data-pen-color="${pal.stroke}" data-step="${step}" />
        <circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="3.5" fill="${pal.stroke}" data-step="${step}" />
        ${p.label ? svgPillLabel(Math.max(70, Math.min(890, lx)), Math.max(24, Math.min(516, ly)), p.label, colorKey, step) : ''}
      </g>
    `;
  }

  if (kind === 'dimension') {
    const x1 = Number(p.x1 ?? 200);
    const y1 = Number(p.y1 ?? 420);
    const x2 = Number(p.x2 ?? 700);
    const y2 = Number(p.y2 ?? 420);
    const offset = Number(p.offset ?? 36);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;

    const ax1 = x1 + nx * offset;
    const ay1 = y1 + ny * offset;
    const ax2 = x2 + nx * offset;
    const ay2 = y2 + ny * offset;
    const extSign = offset >= 0 ? 1 : -1;
    const ex1 = ax1 + nx * 6 * extSign;
    const ey1 = ay1 + ny * 6 * extSign;
    const ex2 = ax2 + nx * 6 * extSign;
    const ey2 = ay2 + ny * 6 * extSign;
    const mx = (ax1 + ax2) / 2;
    const my = (ay1 + ay2) / 2;

    return `
      <g${idAttr} data-step="${step}">
        <line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${ex1.toFixed(1)}" y2="${ey1.toFixed(1)}" stroke="${pal.stroke}" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.65" data-step="${step}" />
        <line x1="${x2.toFixed(1)}" y1="${y2.toFixed(1)}" x2="${ex2.toFixed(1)}" y2="${ey2.toFixed(1)}" stroke="${pal.stroke}" stroke-width="1.2" stroke-dasharray="3 3" opacity="0.65" data-step="${step}" />
        <line x1="${ax1.toFixed(1)}" y1="${ay1.toFixed(1)}" x2="${ax2.toFixed(1)}" y2="${ay2.toFixed(1)}"
          stroke="${pal.stroke}" stroke-width="1.8" marker-start="url(#${prefix}-arr-${colorKey})" marker-end="url(#${prefix}-arr-${colorKey})" data-step="${step}" />
        ${p.label ? svgPillLabel(mx, my, p.label, colorKey, step) : ''}
      </g>
    `;
  }

  if (kind === 'spring') {
    const x1 = Number(p.x1 ?? 300);
    const y1 = Number(p.y1 ?? 220);
    const x2 = Number(p.x2 ?? 300);
    const y2 = Number(p.y2 ?? 370);
    const coils = Math.max(4, Math.min(12, Number(p.coils ?? 7)));
    const amp = Number(p.r ?? 14);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const nx = -uy;
    const ny = ux;
    const lead = Math.min(22, len * 0.16);
    const bodyLen = Math.max(20, len - 2 * lead);

    const pts = [`M ${x1.toFixed(1)} ${y1.toFixed(1)}`, `L ${(x1 + ux * lead).toFixed(1)} ${(y1 + uy * lead).toFixed(1)}`];
    const segs = coils * 2;
    for (let i = 1; i <= segs; i++) {
      const t = lead + (i / (segs + 1)) * bodyLen;
      const side = i % 2 === 1 ? amp : -amp;
      pts.push(`L ${(x1 + ux * t + nx * side).toFixed(1)} ${(y1 + uy * t + ny * side).toFixed(1)}`);
    }
    pts.push(`L ${(x2 - ux * lead).toFixed(1)} ${(y2 - uy * lead).toFixed(1)}`);
    pts.push(`L ${x2.toFixed(1)} ${y2.toFixed(1)}`);

    const mx = (x1 + x2) / 2 + nx * (amp + 28);
    const my = (y1 + y2) / 2 + ny * (amp + 28);
    return `
      <g${idAttr} data-step="${step}">
        <path d="${pts.join(' ')}" fill="none" stroke="${pal.stroke}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" data-step="${step}" />
        ${p.label ? svgPillLabel(mx, my, p.label, colorKey, step) : ''}
      </g>
    `;
  }

  if (kind === 'damper') {
    const x1 = Number(p.x1 ?? 360);
    const y1 = Number(p.y1 ?? 220);
    const x2 = Number(p.x2 ?? 360);
    const y2 = Number(p.y2 ?? 370);
    const dx = x2 - x1;
    const dy = y2 - y1;
    const len = Math.hypot(dx, dy) || 1;
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    const mid = len * 0.5;
    const cylW = 24;
    const cylL = Math.min(len * 0.45, 58);

    return `
      <g${idAttr} data-step="${step}">
        <g transform="translate(${x1.toFixed(1)} ${y1.toFixed(1)}) rotate(${ang.toFixed(1)})">
          <line x1="0" y1="0" x2="${mid.toFixed(1)}" y2="0" stroke="${pal.stroke}" stroke-width="2.4" data-step="${step}" />
          <line x1="${mid.toFixed(1)}" y1="${(-cylW * 0.36).toFixed(1)}" x2="${mid.toFixed(1)}" y2="${(cylW * 0.36).toFixed(1)}" stroke="${pal.stroke}" stroke-width="3.2" data-step="${step}" />
          <path d="M ${(mid - cylL * 0.4).toFixed(1)} ${(-cylW / 2).toFixed(1)} L ${(mid + cylL * 0.6).toFixed(1)} ${(-cylW / 2).toFixed(1)} L ${(mid + cylL * 0.6).toFixed(1)} ${(cylW / 2).toFixed(1)} L ${(mid - cylL * 0.4).toFixed(1)} ${(cylW / 2).toFixed(1)}"
            fill="none" stroke="${pal.stroke}" stroke-width="2.4" stroke-linejoin="round" data-step="${step}" />
          <line x1="${(mid + cylL * 0.6).toFixed(1)}" y1="0" x2="${len.toFixed(1)}" y2="0" stroke="${pal.stroke}" stroke-width="2.4" data-step="${step}" />
        </g>
        ${p.label ? svgPillLabel((x1 + x2) / 2 + 34, (y1 + y2) / 2, p.label, colorKey, step, 'start') : ''}
      </g>
    `;
  }

  if (kind === 'angle_arc') {
    const cx = Number(p.cx ?? p.x ?? 400);
    const cy = Number(p.cy ?? p.y ?? 350);
    const r = Number(p.r ?? 54);
    const a1 = (Number(p.startDeg ?? 0) * Math.PI) / 180;
    const a2 = (Number(p.endDeg ?? 30) * Math.PI) / 180;
    const sx = cx + Math.cos(a1) * r;
    const sy = cy - Math.sin(a1) * r;
    const ex = cx + Math.cos(a2) * r;
    const ey = cy - Math.sin(a2) * r;
    const sweep = a2 > a1 ? 0 : 1;
    const midA = (a1 + a2) / 2;
    const lx = cx + Math.cos(midA) * (r + 22);
    const ly = cy - Math.sin(midA) * (r + 22);
    return `
      <g${idAttr} data-step="${step}">
        <path d="M ${cx} ${cy} L ${sx.toFixed(1)} ${sy.toFixed(1)} A ${r} ${r} 0 0 ${sweep} ${ex.toFixed(1)} ${ey.toFixed(1)} Z" fill="${pal.fill}" opacity="0.65" data-step="${step}" />
        <path d="M ${sx.toFixed(1)} ${sy.toFixed(1)} A ${r} ${r} 0 0 ${sweep} ${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none" stroke="${pal.stroke}" stroke-width="2.2" data-step="${step}" />
        ${p.label ? `<text x="${lx.toFixed(1)}" y="${(ly + 5).toFixed(1)}" text-anchor="middle" fill="${pal.text}" font-size="15" font-weight="700" font-family="Georgia, serif" data-step="${step}">${escapeHtml(p.label)}</text>` : ''}
      </g>
    `;
  }

  if (kind === 'moment_arc') {
    const cx = Number(p.cx ?? p.x ?? 480);
    const cy = Number(p.cy ?? p.y ?? 260);
    const r = Number(p.r ?? 38);
    const cw = String(p.direction || 'ccw').toLowerCase() === 'cw';
    const startA = cw ? -Math.PI * 0.72 : Math.PI * 0.72;
    const endA = cw ? Math.PI * 0.35 : -Math.PI * 0.35;
    const sx = cx + Math.cos(startA) * r;
    const sy = cy + Math.sin(startA) * r;
    const ex = cx + Math.cos(endA) * r;
    const ey = cy + Math.sin(endA) * r;
    const sweep = cw ? 1 : 0;
    return `
      <g${idAttr} data-step="${step}">
        <path d="M ${sx.toFixed(1)} ${sy.toFixed(1)} A ${r} ${r} 0 1 ${sweep} ${ex.toFixed(1)} ${ey.toFixed(1)}"
          fill="none" stroke="${pal.stroke}" stroke-width="2.8" stroke-linecap="round" marker-end="url(#${prefix}-arr-${colorKey})" data-step="${step}" />
        ${p.label ? svgPillLabel(cx, cy - r - 18, p.label, colorKey, step) : ''}
      </g>
    `;
  }

  if (kind === 'callout') {
    const tx = Number(p.targetX ?? p.x1 ?? 480);
    const ty = Number(p.targetY ?? p.y1 ?? 260);
    const lx = Number(p.labelX ?? p.x2 ?? (tx < 480 ? tx + 115 : tx - 115));
    const ly = Number(p.labelY ?? p.y2 ?? Math.max(46, ty - 54));
    const midX = (tx + lx) / 2;
    return `
      <g${idAttr} data-step="${step}">
        <circle cx="${tx.toFixed(1)}" cy="${ty.toFixed(1)}" r="4.5" fill="${pal.stroke}" data-step="${step}" />
        <path d="M ${tx.toFixed(1)} ${ty.toFixed(1)} Q ${midX.toFixed(1)} ${ly.toFixed(1)}, ${lx.toFixed(1)} ${ly.toFixed(1)}"
          fill="none" stroke="${pal.stroke}" stroke-width="1.8" stroke-dasharray="4 3" data-step="${step}" />
        ${svgPillLabel(lx, ly, p.text || p.label || '', colorKey, step)}
      </g>
    `;
  }

  if (kind === 'top_car') {
    // Precision top-down plan-view racecar (ideal for wheelbase L, track width t, yaw I_zz, slip angles, Ackermann)
    const x = Number(p.x ?? 250);
    const y = Number(p.y ?? 165);
    const w = Number(p.w ?? p.width ?? 440); // length along X (front -> right)
    const h = Number(p.h ?? p.height ?? 195); // width along Y
    const cx = x + w / 2;
    const cy = y + h / 2;
    const steer = Number(p.steerDeg ?? 0);
    const yawDeg = Number(p.angleDeg ?? p.yawDeg ?? 0);
    const frontAxleX = x + w * 0.77;
    const rearAxleX = x + w * 0.23;
    const tireL = Math.max(44, w * 0.145);
    const tireW = Math.max(18, h * 0.145);
    const wheelYTop = y + h * 0.12;
    const wheelYBot = y + h * 0.88;
    const fillGrad = `url(#${prefix}-body-${colorKey})`;

    const bodyD = [
      `M ${x + w * 0.04} ${y + h * 0.24}`,
      `Q ${x + w * 0.02} ${cy}, ${x + w * 0.04} ${y + h * 0.76}`,
      `L ${x + w * 0.16} ${y + h * 0.84}`,
      `L ${x + w * 0.78} ${y + h * 0.84}`,
      `Q ${x + w * 0.96} ${y + h * 0.80}, ${x + w * 0.99} ${cy}`,
      `Q ${x + w * 0.96} ${y + h * 0.20}, ${x + w * 0.78} ${y + h * 0.16}`,
      `L ${x + w * 0.16} ${y + h * 0.16}`,
      `Z`,
    ].join(' ');

    const cockpitD = `M ${x + w * 0.34} ${y + h * 0.31} Q ${x + w * 0.56} ${y + h * 0.26}, ${x + w * 0.68} ${y + h * 0.36} Q ${x + w * 0.72} ${cy}, ${x + w * 0.68} ${y + h * 0.64} Q ${x + w * 0.56} ${y + h * 0.74}, ${x + w * 0.34} ${y + h * 0.69} Z`;

    const drawTire = (tx, ty, rotDeg = 0) =>
      `<rect x="${(tx - tireL / 2).toFixed(1)}" y="${(ty - tireW / 2).toFixed(1)}" width="${tireL.toFixed(1)}" height="${tireW.toFixed(1)}" rx="5" fill="#111827" stroke="#94a3b8" stroke-width="2.2" transform="rotate(${rotDeg} ${tx.toFixed(1)} ${ty.toFixed(1)})" data-step="${step}" />`;

    return `
      <g${idAttr}${yawDeg ? ` transform="rotate(${yawDeg} ${cx.toFixed(1)} ${cy.toFixed(1)})"` : ''} data-step="${step}">
        <line x1="${(x - 18).toFixed(1)}" y1="${cy.toFixed(1)}" x2="${(x + w + 24).toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${pal.stroke}" stroke-width="1" stroke-dasharray="6 5" opacity="0.4" data-step="${step}" />
        <line x1="${rearAxleX.toFixed(1)}" y1="${wheelYTop.toFixed(1)}" x2="${rearAxleX.toFixed(1)}" y2="${wheelYBot.toFixed(1)}" stroke="#64748b" stroke-width="2.2" data-step="${step}" />
        <line x1="${frontAxleX.toFixed(1)}" y1="${wheelYTop.toFixed(1)}" x2="${frontAxleX.toFixed(1)}" y2="${wheelYBot.toFixed(1)}" stroke="#64748b" stroke-width="2.2" data-step="${step}" />
        <path d="${bodyD}" fill="${fillGrad}" stroke="${pal.stroke}" stroke-width="2.4" stroke-linejoin="round" data-pen="1" data-pen-color="${pal.stroke}" data-step="${step}" />
        <path d="${cockpitD}" fill="rgba(15,23,42,0.58)" stroke="${pal.stroke}" stroke-width="1.3" opacity="0.82" data-step="${step}" />
        <rect x="${(x + w * 0.03).toFixed(1)}" y="${(y + h * 0.14).toFixed(1)}" width="${(w * 0.055).toFixed(1)}" height="${(h * 0.72).toFixed(1)}" rx="2" fill="rgba(148,163,184,0.22)" stroke="${pal.stroke}" stroke-width="1.5" data-step="${step}" />
        ${drawTire(rearAxleX, wheelYTop, 0)}
        ${drawTire(rearAxleX, wheelYBot, 0)}
        ${drawTire(frontAxleX, wheelYTop, steer)}
        ${drawTire(frontAxleX, wheelYBot, steer)}
        ${p.label ? `<text x="${cx.toFixed(1)}" y="${(y - 12).toFixed(1)}" text-anchor="middle" fill="${pal.text}" font-size="13.5" font-weight="650" font-family="-apple-system, sans-serif" data-step="${step}">${escapeHtml(p.label)}</text>` : ''}
      </g>
    `;
  }

  if (kind === 'front_car') {
    // Precision front-view racecar cross-section (ideal for track width t, roll angle, roll center, camber, lateral ΔFz)
    const x = Number(p.x ?? 270);
    const y = Number(p.y ?? 195);
    const w = Number(p.w ?? p.width ?? 420);
    const h = Number(p.h ?? p.height ?? 170);
    const cx = x + w / 2;
    const cy = y + h * 0.54;
    const roll = Number(p.rollDeg ?? p.angleDeg ?? 0);
    const camber = Number(p.camberDeg ?? 0);
    const tireW = Math.max(36, w * 0.13);
    const tireH = Math.max(76, h * 0.62);
    const groundY = y + h + 40;
    const leftTireX = x + tireW / 2;
    const rightTireX = x + w - tireW / 2;
    const tireTopY = groundY - tireH;
    const fillGrad = `url(#${prefix}-body-${colorKey})`;

    const bodyD = [
      `M ${(x + w * 0.14).toFixed(1)} ${(y + h * 0.85).toFixed(1)}`,
      `L ${(x + w * 0.12).toFixed(1)} ${(y + h * 0.48).toFixed(1)}`,
      `Q ${(x + w * 0.24).toFixed(1)} ${(y + h * 0.12).toFixed(1)}, ${(x + w * 0.36).toFixed(1)} ${(y + h * 0.08).toFixed(1)}`,
      `L ${(x + w * 0.64).toFixed(1)} ${(y + h * 0.08).toFixed(1)}`,
      `Q ${(x + w * 0.76).toFixed(1)} ${(y + h * 0.12).toFixed(1)}, ${(x + w * 0.88).toFixed(1)} ${(y + h * 0.48).toFixed(1)}`,
      `L ${(x + w * 0.86).toFixed(1)} ${(y + h * 0.85).toFixed(1)}`,
      `Z`,
    ].join(' ');

    return `
      <g${idAttr} data-step="${step}">
        <rect x="${(leftTireX - tireW / 2).toFixed(1)}" y="${tireTopY.toFixed(1)}" width="${tireW.toFixed(1)}" height="${tireH.toFixed(1)}" rx="7" fill="#111827" stroke="#94a3b8" stroke-width="2.6" transform="rotate(${-camber} ${leftTireX.toFixed(1)} ${groundY.toFixed(1)})" data-step="${step}" />
        <rect x="${(rightTireX - tireW / 2).toFixed(1)}" y="${tireTopY.toFixed(1)}" width="${tireW.toFixed(1)}" height="${tireH.toFixed(1)}" rx="7" fill="#111827" stroke="#94a3b8" stroke-width="2.6" transform="rotate(${camber} ${rightTireX.toFixed(1)} ${groundY.toFixed(1)})" data-step="${step}" />
        <line x1="${(leftTireX + tireW * 0.45).toFixed(1)}" y1="${(tireTopY + tireH * 0.32).toFixed(1)}" x2="${(x + w * 0.24).toFixed(1)}" y2="${(y + h * 0.62).toFixed(1)}" stroke="#64748b" stroke-width="2.2" data-step="${step}" />
        <line x1="${(leftTireX + tireW * 0.45).toFixed(1)}" y1="${(tireTopY + tireH * 0.74).toFixed(1)}" x2="${(x + w * 0.24).toFixed(1)}" y2="${(y + h * 0.82).toFixed(1)}" stroke="#64748b" stroke-width="2.2" data-step="${step}" />
        <line x1="${(rightTireX - tireW * 0.45).toFixed(1)}" y1="${(tireTopY + tireH * 0.32).toFixed(1)}" x2="${(x + w * 0.76).toFixed(1)}" y2="${(y + h * 0.62).toFixed(1)}" stroke="#64748b" stroke-width="2.2" data-step="${step}" />
        <line x1="${(rightTireX - tireW * 0.45).toFixed(1)}" y1="${(tireTopY + tireH * 0.74).toFixed(1)}" x2="${(x + w * 0.76).toFixed(1)}" y2="${(y + h * 0.82).toFixed(1)}" stroke="#64748b" stroke-width="2.2" data-step="${step}" />
        <g${roll ? ` transform="rotate(${roll} ${cx.toFixed(1)} ${cy.toFixed(1)})"` : ''}>
          <path d="${bodyD}" fill="${fillGrad}" stroke="${pal.stroke}" stroke-width="2.4" stroke-linejoin="round" data-pen="1" data-pen-color="${pal.stroke}" data-step="${step}" />
          <path d="M ${(x + w * 0.28).toFixed(1)} ${(y + h * 0.45).toFixed(1)} L ${(x + w * 0.36).toFixed(1)} ${(y + h * 0.16).toFixed(1)} L ${(x + w * 0.64).toFixed(1)} ${(y + h * 0.16).toFixed(1)} L ${(x + w * 0.72).toFixed(1)} ${(y + h * 0.45).toFixed(1)} Z"
            fill="rgba(15,23,42,0.58)" stroke="${pal.stroke}" stroke-width="1.3" opacity="0.82" data-step="${step}" />
        </g>
        <line x1="${cx.toFixed(1)}" y1="${(y - 12).toFixed(1)}" x2="${cx.toFixed(1)}" y2="${(groundY + 12).toFixed(1)}" stroke="${pal.stroke}" stroke-width="1" stroke-dasharray="5 5" opacity="0.4" data-step="${step}" />
        ${p.label ? `<text x="${cx.toFixed(1)}" y="${(y - 16).toFixed(1)}" text-anchor="middle" fill="${pal.text}" font-size="13.5" font-weight="650" font-family="-apple-system, sans-serif" data-step="${step}">${escapeHtml(p.label)}</text>` : ''}
      </g>
    `;
  }

  if (kind === 'note' || kind === 'formula_box' || kind === 'text_box') {
    const x = Number(p.x ?? 480);
    const y = Number(p.y ?? 92);
    const mainText = String(p.text || p.label || '');
    const subText = String(p.subtext || p.subtitle || '');
    if (!mainText && !subText) return '';
    const maxLen = Math.max(mainText.length, Math.min(48, subText.length));
    const bw = Math.max(150, Math.min(440, maxLen * 8.4 + 34));
    const subLines = subText ? wrapSvgLines(subText, 44) : [];
    const bh = 36 + subLines.length * 19;
    const rx = Math.max(18, Math.min(960 - bw - 18, x - bw / 2));
    const ry = Math.max(44, Math.min(540 - bh - 14, y - bh / 2));
    const subSvg = subLines
      .map(
        (ln, i) =>
          `<text x="${(rx + 16).toFixed(1)}" y="${(ry + 42 + i * 18).toFixed(1)}" fill="#cbd5e1" font-size="12.5" font-family="-apple-system, sans-serif" data-step="${step}">${escapeHtml(ln)}</text>`,
      )
      .join('');
    return `
      <g${idAttr} data-step="${step}">
        <rect x="${rx.toFixed(1)}" y="${ry.toFixed(1)}" width="${bw.toFixed(1)}" height="${bh.toFixed(1)}" rx="10"
          fill="${pal.badgeBg}" stroke="${pal.stroke}" stroke-width="1.8" opacity="0.96" data-pen="1" data-pen-color="${pal.stroke}" data-step="${step}" />
        <line x1="${(rx + 12).toFixed(1)}" y1="${(ry + 1.5).toFixed(1)}" x2="${(rx + bw - 12).toFixed(1)}" y2="${(ry + 1.5).toFixed(1)}"
          stroke="${pal.stroke}" stroke-width="2.8" stroke-linecap="round" opacity="0.9" data-step="${step}" />
        <text x="${(rx + 16).toFixed(1)}" y="${(ry + 23).toFixed(1)}" fill="${pal.text}" font-size="14.5" font-weight="700"
          font-family="${kind === 'formula_box' ? 'Georgia, serif' : '-apple-system, sans-serif'}" data-step="${step}">${escapeHtml(mainText)}</text>
        ${subSvg}
      </g>
    `;
  }

  if (kind === 'polyline' || kind === 'curve' || kind === 'path') {
    const rawPts = Array.isArray(p.points) ? p.points : [];
    const pts = rawPts
      .map((pt) => (Array.isArray(pt) ? [Number(pt[0]), Number(pt[1])] : [Number(pt?.x), Number(pt?.y)]))
      .filter(([px, py]) => Number.isFinite(px) && Number.isFinite(py));
    if (pts.length < 2) return '';
    let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
    if (pts.length === 2 || p.straight) {
      for (let i = 1; i < pts.length; i++) d += ` L ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}`;
    } else {
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = ((pts[i][0] + pts[i + 1][0]) / 2).toFixed(1);
        const my = ((pts[i][1] + pts[i + 1][1]) / 2).toFixed(1);
        d += ` Q ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}, ${mx} ${my}`;
      }
      const last = pts[pts.length - 1];
      d += ` L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
    }
    const mid = pts[Math.floor(pts.length / 2)];
    return `
      <g${idAttr} data-step="${step}">
        <path d="${d}" fill="none" stroke="${pal.stroke}" stroke-width="${Number(p.strokeWidth || 2.8)}" stroke-linecap="round" stroke-linejoin="round"${p.dashed ? ' stroke-dasharray="7 5"' : ''}${p.arrowEnd ? ` marker-end="url(#${prefix}-arr-${colorKey})"` : ''} data-pen="1" data-pen-color="${pal.stroke}" data-step="${step}" />
        ${p.label ? svgPillLabel(mid[0], Math.max(26, mid[1] - 20), p.label, colorKey, step) : ''}
      </g>
    `;
  }

  return '';
}

export function extractLastAxes(primitives = []) {
  let last = null;
  for (const p of Array.isArray(primitives) ? primitives : []) {
    if (String(p?.kind || '').toLowerCase() === 'axes') {
      last = {
        x: Number(p.x ?? 110),
        y: Number(p.y ?? 75),
        width: Number(p.width ?? p.w ?? 740),
        height: Number(p.height ?? p.h ?? 365),
        xMin: Number(p.xMin ?? 0),
        xMax: Number(p.xMax ?? 10),
        yMin: Number(p.yMin ?? 0),
        yMax: Number(p.yMax ?? 10),
      };
    }
  }
  return last;
}

export function buildPrecisionPrimitivesSvg(title, primitives = [], { prefix = 'cad', compact = false } = {}) {
  const vbW = 960;
  const vbH = compact ? 420 : 540;
  const ctx = { prefix, lastAxes: null };
  const bodySvg = (Array.isArray(primitives) ? primitives : [])
    .map((p, idx) => renderPrimitiveToSvg(p, idx, ctx))
    .join('\n');

  return `
    <svg viewBox="0 0 ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg" class="precision-svg">
      ${buildBlueprintDefs(prefix)}
      <rect x="0" y="0" width="${vbW}" height="${vbH}" fill="url(#${prefix}-grid)" />
      ${title ? `<text x="28" y="34" fill="#e2e8f0" font-size="16.5" font-weight="650" letter-spacing="-0.01em" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif">${escapeHtml(title)}</text>` : ''}
      <g class="primitives-layer">${bodySvg}</g>
    </svg>
  `;
}

// ---------------- Upgraded Bezier Structured Blocks Builder ----------------
export function buildStructuredBlocksSvg(title, blocks = [], arrows = []) {
  const cols = blocks.some((b) => Number(b.col) > 0) ? 2 : 1;
  const rows = Math.max(1, ...blocks.map((b, i) => (b.row != null ? Number(b.row) + 1 : Math.floor(i / cols) + 1)));
  const cardW = cols === 1 ? 840 : 395;
  const cardH = rows <= 2 ? 132 : 106;
  const gapX = 50;
  const gapY = 30;
  const startX = 60;
  const startY = 74;
  const totalH = Math.max(360, startY + rows * (cardH + gapY) + 22);

  const positions = new Map();
  let shapes = `${buildBlueprintDefs('blk')}<rect x="0" y="0" width="960" height="${totalH}" fill="url(#blk-grid)" />`;
  if (title) {
    shapes += `<text x="60" y="42" fill="#eef2f7" font-size="20" font-weight="680" letter-spacing="-0.015em" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif">${escapeHtml(title)}</text>`;
  }

  blocks.forEach((b, idx) => {
    const c = b.col != null ? Math.min(1, Math.max(0, Number(b.col))) : idx % cols;
    const r = b.row != null ? Math.max(0, Number(b.row)) : Math.floor(idx / cols);
    const x = startX + c * (cardW + gapX);
    const y = startY + r * (cardH + gapY);
    const colKey = PALETTE[b.color] ? b.color : ['cyan', 'emerald', 'amber', 'rose'][idx % 4];
    const pal = getColor(colKey);
    const step = idx + 1;
    positions.set(b.id, { x, y, w: cardW, h: cardH, cx: x + cardW / 2, cy: y + cardH / 2 });

    const subLines = wrapSvgLines(b.subtitle || '', cols === 1 ? 82 : 42);
    const subSvg = subLines
      .map(
        (ln, li) =>
          `<text x="${x + 22}" y="${y + 68 + li * 21}" fill="#cbd5e1" font-size="14.5" font-family="-apple-system, sans-serif" data-step="${step}">${escapeHtml(ln)}</text>`,
      )
      .join('');

    shapes += `
      <g id="${escapeHtml(b.id || `block-${idx}`)}" data-step="${step}">
        <rect x="${x}" y="${y}" width="${cardW}" height="${cardH}" rx="12" fill="url(#blk-body-${colKey})" stroke="${pal.stroke}" stroke-width="2" data-step="${step}" />
        <line x1="${x + 14}" y1="${y + 1.5}" x2="${x + cardW - 14}" y2="${y + 1.5}" stroke="${pal.stroke}" stroke-width="3" stroke-linecap="round" opacity="0.9" data-step="${step}" />
        <text x="${x + 22}" y="${y + 38}" fill="${pal.text}" font-size="16.5" font-weight="700" font-family="-apple-system, sans-serif" data-step="${step}">${escapeHtml(b.title || '')}</text>
        ${subSvg}
      </g>
    `;
  });

  arrows.forEach((a, idx) => {
    const p1 = positions.get(a.from);
    const p2 = positions.get(a.to);
    if (!p1 || !p2) return;
    const colKey = PALETTE[a.color] ? a.color : 'amber';
    const pal = getColor(colKey);
    let x1 = p1.cx;
    let y1 = p1.cy;
    let x2 = p2.cx;
    let y2 = p2.cy;
    let d = '';
    if (Math.abs(p2.cx - p1.cx) > Math.abs(p2.cy - p1.cy)) {
      x1 = p2.cx > p1.cx ? p1.x + p1.w : p1.x;
      x2 = p2.cx > p1.cx ? p2.x - 4 : p2.x + p2.w + 4;
      const cxMid = (x1 + x2) / 2;
      d = `M ${x1} ${y1} C ${cxMid} ${y1}, ${cxMid} ${y2}, ${x2} ${y2}`;
    } else {
      y1 = p2.cy > p1.cy ? p1.y + p1.h : p1.y;
      y2 = p2.cy > p1.cy ? p2.y - 4 : p2.y + p2.h + 4;
      const cyMid = (y1 + y2) / 2;
      d = `M ${x1} ${y1} C ${x1} ${cyMid}, ${x2} ${cyMid}, ${x2} ${y2}`;
    }
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2;
    const step = blocks.length + idx + 1;
    shapes += `
      <path d="${d}" fill="none" stroke="${pal.stroke}" stroke-width="2.4" marker-end="url(#blk-arr-${colKey})" data-step="${step}" />
      ${a.label ? svgPillLabel(mx, my - 10, a.label, colKey, step) : ''}
    `;
  });

  return `<svg viewBox="0 0 960 ${totalH}" xmlns="http://www.w3.org/2000/svg" class="precision-svg">${shapes}</svg>`;
}

export function buildSceneSvg(data, opts = {}) {
  if (data?.template && BLUEPRINT_TEMPLATES[String(data.template).toLowerCase()]) {
    return buildParametricBlueprintSvg(
      data.scene_title || data.problem_title || '',
      data.template,
      data.template_spec || data,
      data.active_layers || data.layers || [],
      { prefix: opts.prefix || 'bp' },
    );
  }
  if (Array.isArray(data?.primitives) && data.primitives.length) {
    return buildPrecisionPrimitivesSvg(data.scene_title || data.problem_title || '', data.primitives, opts);
  }
  if (Array.isArray(data?.blocks) && data.blocks.length) {
    return buildStructuredBlocksSvg(data.scene_title || '', data.blocks, data.arrows || []);
  }
  if (data?.svg_code) {
    return sanitizeRichHtml(data.svg_code);
  }
  return '';
}

// ---------------- Organic Hand-Perfected Apple-Pencil Ink Paths (Fiorella & Mayer Embodiment) ----------------
function handCirclePath(cx, cy, rx, ry) {
  // Natural confident teacher's oval loop starting near top-left with a subtle organic overlap at the close
  const pts = [];
  const steps = 28;
  const startAngle = -Math.PI * 0.68;
  const totalSweep = Math.PI * 2.12; // subtle human overlap at closure
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const a = startAngle + t * totalSweep;
    // Tiny smooth organic hand variance (deterministic, zero jitter)
    const wobbleR = 1 + 0.032 * Math.sin(a * 2 + 0.5) - 0.018 * Math.cos(a * 3);
    const spiral = 1 + (t - 0.5) * 0.035;
    const px = cx + Math.cos(a) * rx * wobbleR * spiral;
    const py = cy + Math.sin(a) * ry * wobbleR * spiral;
    pts.push([px, py]);
  }
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = ((pts[i][0] + pts[i + 1][0]) / 2).toFixed(1);
    const my = ((pts[i][1] + pts[i + 1][1]) / 2).toFixed(1);
    d += ` Q ${pts[i][0].toFixed(1)} ${pts[i][1].toFixed(1)}, ${mx} ${my}`;
  }
  const last = pts[pts.length - 1];
  d += ` L ${last[0].toFixed(1)} ${last[1].toFixed(1)}`;
  return d;
}

function handUnderlinePath(x, y, w) {
  const x1 = x - 4;
  const x2 = x + w + 5;
  const c1x = x + w * 0.32;
  const c1y = y + 3.2;
  const c2x = x + w * 0.72;
  const c2y = y - 1.6;
  return `M ${x1.toFixed(1)} ${(y + 0.8).toFixed(1)} C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${x2.toFixed(1)} ${(y - 0.6).toFixed(1)}`;
}

// ---------------- Sub-Millimeter PDF Annotation Overlay Renderer ----------------
export function renderPdfAnnotationsSvg(annotations = [], vbW = 1000, vbH = 750, prevCount = 0) {
  const mkPdfArrow = (key, color) => `
    <marker id="pdf-arr-${key}" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M 1 1.5 L 11 6 L 1 10.5 L 3.4 6 Z" fill="${color}" />
    </marker>
  `;

  const hasNewBatch = prevCount > 0 && annotations.length > prevCount;

  let body = `
    <defs>
      <filter id="pdf-shadow" x="-20%" y="-20%" width="140%" height="140%">
        <feDropShadow dx="0" dy="2" stdDeviation="2.2" flood-color="#000000" flood-opacity="0.35" />
      </filter>
      ${mkPdfArrow('cyan', PALETTE.cyan.pdfStroke)}
      ${mkPdfArrow('amber', PALETTE.amber.pdfStroke)}
      ${mkPdfArrow('emerald', PALETTE.emerald.pdfStroke)}
      ${mkPdfArrow('rose', PALETTE.rose.pdfStroke)}
    </defs>
  `;

  annotations.forEach((ann, idx) => {
    const isNew = idx >= prevCount;
    const newAttr = isNew ? ' data-new="1"' : ' data-existing="1"';
    // Cognitive Load Spotlight: softly dim older marks on the slide so the eye locks onto the active mark!
    const dimClass = !isNew && hasNewBatch ? ' class="ann-past"' : ' class="ann-active"';
    const step = isNew ? idx - prevCount + 1 : 0;
    const colorKey = PALETTE[ann.color] ? ann.color : 'amber';
    const pal = getColor(colorKey);
    const kind = String(ann.kind || 'highlight').toLowerCase();

    const x = Number(ann.x ?? 120);
    const y = Number(ann.y ?? 120);
    const w = Number(ann.w ?? 160);
    const h = Number(ann.h ?? 32);

    const floatLabel = (lx, ly, text) => {
      if (!text) return '';
      const clean = String(text);
      const pw = Math.max(54, Math.min(300, clean.length * 7.6 + 22));
      const ph = 26;
      const clampedX = Math.max(8, Math.min(vbW - pw - 8, lx - pw / 2));
      const clampedY = Math.max(8, Math.min(vbH - ph - 8, ly - ph / 2));
      return `
        <g${newAttr}${dimClass} data-step="${step + 1}" filter="url(#pdf-shadow)">
          <rect x="${clampedX.toFixed(1)}" y="${clampedY.toFixed(1)}" width="${pw.toFixed(1)}" height="${ph}" rx="7"
            fill="rgba(11, 15, 23, 0.92)" stroke="${pal.stroke}" stroke-width="1.8" />
          <text x="${(clampedX + pw / 2).toFixed(1)}" y="${(clampedY + 17).toFixed(1)}" text-anchor="middle"
            fill="${pal.text}" font-size="13" font-weight="650" font-family="-apple-system, BlinkMacSystemFont, sans-serif">${escapeHtml(clean)}</text>
        </g>
      `;
    };

    if (kind === 'highlight') {
      // Sweeping translucent chisel-tip highlighter stroke + subtle warm baseline
      const hy = y + h / 2;
      const strokeH = Math.max(16, Math.min(44, h + 9));
      body += `
        <g id="${escapeHtml(ann.id)}"${newAttr}${dimClass} data-step="${step}">
          <path d="M ${(x - 6).toFixed(1)} ${hy.toFixed(1)} Q ${(x + w * 0.5).toFixed(1)} ${(hy - 1.2).toFixed(1)}, ${(x + w + 7).toFixed(1)} ${(hy + 0.5).toFixed(1)}"
            fill="none" stroke="${pal.pdfHl}" stroke-width="${strokeH.toFixed(1)}" stroke-linecap="butt" data-pen="1" data-pen-color="${pal.pdfStroke}" data-step="${step}" />
          <path d="${handUnderlinePath(x, y + h + 2, w)}"
            fill="none" stroke="${pal.pdfStroke}" stroke-width="2.2" stroke-linecap="round" opacity="0.85" data-step="${step}" />
          ${ann.label ? floatLabel(x + w / 2, y > 46 ? y - 20 : y + h + 24, ann.label) : ''}
        </g>
      `;
    } else if (kind === 'underline') {
      const uy = y + h + 4;
      const uPath = handUnderlinePath(x, uy, w);
      body += `
        <g id="${escapeHtml(ann.id)}"${newAttr}${dimClass} data-step="${step}">
          <path d="${uPath}" fill="none" stroke="#ffffff" stroke-width="6.2" stroke-linecap="round" opacity="0.55" data-step="${step}" />
          <path d="${uPath}" fill="none" stroke="${pal.pdfStroke}" stroke-width="3.6" stroke-linecap="round" data-pen="1" data-pen-color="${pal.pdfStroke}" data-step="${step}" />
          ${ann.label ? floatLabel(x + w / 2, uy + 20, ann.label) : ''}
        </g>
      `;
    } else if (kind === 'circle' || kind === 'oval') {
      const cx = x + w / 2;
      const cy = y + h / 2;
      const rx = Math.max(22, w / 2 + 15);
      const ry = Math.max(16, h / 2 + 11);
      const cPath = handCirclePath(cx, cy, rx, ry);
      body += `
        <g id="${escapeHtml(ann.id)}"${newAttr}${dimClass} data-step="${step}">
          <path d="${cPath}" fill="none" stroke="#ffffff" stroke-width="6.2" stroke-linecap="round" opacity="0.52" data-step="${step}" />
          <path d="${cPath}" fill="${pal.pdfHl}" fill-opacity="0.24" stroke="${pal.pdfStroke}" stroke-width="3.5" stroke-linecap="round" data-pen="1" data-pen-color="${pal.pdfStroke}" data-step="${step}" />
          ${ann.label ? floatLabel(cx, cy - ry > 34 ? cy - ry - 18 : cy + ry + 20, ann.label) : ''}
        </g>
      `;
    } else if (kind === 'box') {
      const pad = 8;
      const bx = x - pad;
      const by = y - pad;
      const bw = w + pad * 2;
      const bh = h + pad * 2;
      const boxPath = `M ${(bx + 8).toFixed(1)} ${by.toFixed(1)} L ${(bx + bw - 8).toFixed(1)} ${by.toFixed(1)} Q ${(bx + bw).toFixed(1)} ${by.toFixed(1)}, ${(bx + bw).toFixed(1)} ${(by + 8).toFixed(1)} L ${(bx + bw).toFixed(1)} ${(by + bh - 8).toFixed(1)} Q ${(bx + bw).toFixed(1)} ${(by + bh).toFixed(1)}, ${(bx + bw - 8).toFixed(1)} ${(by + bh).toFixed(1)} L ${(bx + 8).toFixed(1)} ${(by + bh).toFixed(1)} Q ${bx.toFixed(1)} ${(by + bh).toFixed(1)}, ${bx.toFixed(1)} ${(by + bh - 8).toFixed(1)} L ${bx.toFixed(1)} ${(by + 8).toFixed(1)} Q ${bx.toFixed(1)} ${by.toFixed(1)}, ${(bx + 8).toFixed(1)} ${by.toFixed(1)}`;
      body += `
        <g id="${escapeHtml(ann.id)}"${newAttr}${dimClass} data-step="${step}">
          <path d="${boxPath}" fill="${pal.pdfHl}" fill-opacity="0.2" stroke="${pal.pdfStroke}" stroke-width="3" stroke-linecap="round" data-pen="1" data-pen-color="${pal.pdfStroke}" data-step="${step}" />
          ${ann.label ? floatLabel(x + w / 2, y > 48 ? y - 22 : y + h + 26, ann.label) : ''}
        </g>
      `;
    } else if (kind === 'arrow' || kind === 'callout') {
      const x1 = Number(ann.x1 ?? (x < vbW * 0.55 ? x + w + 80 : x - 80));
      const y1 = Number(ann.y1 ?? Math.max(36, y - 40));
      const x2 = Number(ann.x2 ?? x + w / 2);
      const y2 = Number(ann.y2 ?? y + h / 2);
      const ctrlX = (x1 + x2) / 2;
      const ctrlY = y1;
      const aPath = `M ${x1.toFixed(1)} ${y1.toFixed(1)} Q ${ctrlX.toFixed(1)} ${ctrlY.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      body += `
        <g id="${escapeHtml(ann.id)}"${newAttr}${dimClass} data-step="${step}">
          <path d="${aPath}" fill="none" stroke="#ffffff" stroke-width="5.6" stroke-linecap="round" opacity="0.65" data-step="${step}" />
          <path d="${aPath}" fill="none" stroke="${pal.pdfStroke}" stroke-width="3.2" stroke-linecap="round" marker-end="url(#pdf-arr-${colorKey})" data-pen="1" data-pen-color="${pal.pdfStroke}" data-step="${step}" />
          <circle cx="${x2.toFixed(1)}" cy="${y2.toFixed(1)}" r="4.5" fill="${pal.pdfStroke}" opacity="0.85" data-step="${step}" />
          ${ann.label ? floatLabel(x1, y1 - 14, ann.label) : ''}
        </g>
      `;
    } else if (kind === 'vector') {
      const x1 = Number(ann.x1 ?? x);
      const y1 = Number(ann.y1 ?? y);
      const x2 = Number(ann.x2 ?? x1);
      const y2 = Number(ann.y2 ?? Math.min(vbH - 20, y1 + 95));
      const mx = (x1 + x2) / 2 + 24;
      const my = (y1 + y2) / 2;
      const vPath = `M ${x1.toFixed(1)} ${y1.toFixed(1)} L ${x2.toFixed(1)} ${y2.toFixed(1)}`;
      body += `
        <g id="${escapeHtml(ann.id)}"${newAttr}${dimClass} data-step="${step}">
          <path d="${vPath}" fill="none" stroke="#ffffff" stroke-width="7" stroke-linecap="round" opacity="0.72" data-step="${step}" />
          <path d="${vPath}" fill="none" stroke="${pal.pdfStroke}" stroke-width="4" stroke-linecap="round" marker-end="url(#pdf-arr-${colorKey})" data-pen="1" data-pen-color="${pal.pdfStroke}" data-step="${step}" />
          <circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="4.5" fill="${pal.pdfStroke}" stroke="#ffffff" stroke-width="1.5" data-step="${step}" />
          ${ann.label ? floatLabel(mx, my, ann.label) : ''}
        </g>
      `;
    }
  });

  return `<svg class="pdf-overlay-svg" viewBox="0 0 ${vbW} ${vbH}" xmlns="http://www.w3.org/2000/svg">${body}</svg>`;
}

// ---------------- 60fps Choreographed Stroke Animator + Fiorella-Mayer Live Moving Pen Nib ----------------
const activePenAnimations = new WeakMap();

function ensureLivePenNib(svgEl) {
  let nib = svgEl.querySelector('.live-pen-nib');
  if (!nib) {
    const ns = 'http://www.w3.org/2000/svg';
    nib = document.createElementNS(ns, 'g');
    nib.setAttribute('class', 'live-pen-nib');
    nib.style.pointerEvents = 'none';
    nib.style.opacity = '0';
    nib.style.transition = 'opacity 180ms cubic-bezier(0.23, 1, 0.32, 1)';
    nib.innerHTML = `
      <circle class="pen-halo" cx="0" cy="0" r="10" fill="#f59e0b" opacity="0.24" />
      <circle class="pen-tip-dot" cx="0" cy="0" r="3.6" fill="#f59e0b" stroke="#ffffff" stroke-width="1.4" />
      <g transform="rotate(-38)">
        <path d="M 3 -3 L 26 -6 L 31 0 L 26 6 L 3 3 Z" fill="#1e293b" stroke="#e2e8f0" stroke-width="1.3" stroke-linejoin="round" />
        <path d="M 1 0 L 6 -3 L 6 3 Z" class="pen-tip-cone" fill="#f59e0b" />
        <line x1="12" y1="-2.2" x2="23" y2="-3.6" stroke="#94a3b8" stroke-width="1.1" stroke-linecap="round" />
      </g>
    `;
    svgEl.appendChild(nib);
  }
  return nib;
}

function runLivePenTrack(svgEl, penJobs) {
  if (!penJobs.length) return;
  const prevCancel = activePenAnimations.get(svgEl);
  if (prevCancel) prevCancel();

  const nib = ensureLivePenNib(svgEl);
  const halo = nib.querySelector('.pen-halo');
  const dot = nib.querySelector('.pen-tip-dot');
  const cone = nib.querySelector('.pen-tip-cone');

  let cancelled = false;
  let rafId = 0;
  const cancel = () => {
    cancelled = true;
    if (rafId) cancelAnimationFrame(rafId);
    nib.style.opacity = '0';
  };
  activePenAnimations.set(svgEl, cancel);

  const tStart = performance.now();
  const totalEnd = Math.max(...penJobs.map((j) => j.delay + j.dur)) + 260;

  // Ease-out cubic matching CSS cubic-bezier(0.23, 1, 0.32, 1) closely
  const easeOut = (t) => 1 - Math.pow(1 - t, 3);

  const tick = (now) => {
    if (cancelled) return;
    const elapsed = now - tStart;
    if (elapsed > totalEnd) {
      nib.style.opacity = '0';
      return;
    }

    // Find the currently active stroke job (or most recent completed one briefly)
    let activeJob = null;
    for (const job of penJobs) {
      if (elapsed >= job.delay && elapsed <= job.delay + job.dur) {
        activeJob = job;
        break;
      }
    }

    if (activeJob) {
      const frac = Math.max(0, Math.min(1, (elapsed - activeJob.delay) / Math.max(1, activeJob.dur)));
      const dist = easeOut(frac) * activeJob.len;
      try {
        let pt = activeJob.el.getPointAtLength(dist);
        const elCtm = activeJob.el.getCTM?.();
        const rootCtm = svgEl.getCTM?.();
        if (elCtm && rootCtm && typeof pt.matrixTransform === 'function') {
          pt = pt.matrixTransform(rootCtm.inverse().multiply(elCtm));
        }
        const col = activeJob.color || '#f59e0b';
        halo.setAttribute('fill', col);
        dot.setAttribute('fill', col);
        cone.setAttribute('fill', col);
        nib.setAttribute('transform', `translate(${pt.x.toFixed(1)} ${pt.y.toFixed(1)})`);
        nib.style.opacity = '1';
      } catch {}
    } else if (elapsed > penJobs[penJobs.length - 1].delay + penJobs[penJobs.length - 1].dur) {
      nib.style.opacity = '0';
    }

    rafId = requestAnimationFrame(tick);
  };

  rafId = requestAnimationFrame(tick);
}

export function animateSvgStrokes(svgEl, { onlyNew = false, targetDurationMs = 0 } = {}) {
  if (!svgEl) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduced) return;

  const scope = onlyNew ? svgEl.querySelectorAll('[data-new="1"]') : [svgEl];
  const drawable = [];
  const labels = [];

  scope.forEach((root) => {
    root.querySelectorAll('path, line, polyline, polygon, circle, ellipse, rect').forEach((el) => {
      if (el.closest('defs, marker, pattern, .live-pen-nib')) return;
      if (el.getAttribute('fill')?.startsWith('url(#') && el.getAttribute('fill')?.includes('-grid')) return;
      drawable.push(el);
    });
    root.querySelectorAll('text, tspan').forEach((t) => {
      if (t.closest('defs, marker, pattern, .live-pen-nib')) return;
      labels.push(t);
    });
  });

  if (!drawable.length && !labels.length) return;

  const getStep = (el) => Number(el.getAttribute('data-step') || el.closest('[data-step]')?.getAttribute('data-step') || 99);
  drawable.sort((a, b) => getStep(a) - getStep(b));

  // Pace total stroke reveal smoothly with the spoken segment duration so drawing & voice match naturally!
  const budgetMs = targetDurationMs > 0 ? Math.max(750, Math.min(3000, Math.round(targetDurationMs * 0.65))) : 1700;
  let delay = 35;
  const stepGap = Math.max(45, Math.min(240, Math.floor(budgetMs / Math.max(drawable.length, 1))));
  const penJobs = [];

  drawable.forEach((el) => {
    let len = 0;
    try {
      if (typeof el.getTotalLength === 'function') {
        len = el.getTotalLength();
      }
    } catch {
      len = 0;
    }

    const strokeAttr = el.getAttribute('stroke');
    const hasStroke = strokeAttr && strokeAttr !== 'none';
    if (hasStroke && len > 4 && len < 6000) {
      const origDash = el.getAttribute('stroke-dasharray') || '';
      el.style.transition = 'none';
      el.style.strokeDasharray = `${len}`;
      el.style.strokeDashoffset = `${len}`;
      el.style.opacity = '1';

      const dur = Math.max(260, Math.min(760, Math.round(len * 0.95)));
      const myDelay = delay;
      delay += stepGap;

      // Track primary colored strokes with the Fiorella-Mayer live moving pen tip!
      const isWhiteHalo = strokeAttr === '#ffffff' || strokeAttr === '#fff';
      const explicitPen = el.getAttribute('data-pen') === '1';
      if (typeof el.getPointAtLength === 'function' && !isWhiteHalo && (explicitPen || (len > 36 && penJobs.length < 7))) {
        penJobs.push({
          el,
          len,
          delay: myDelay,
          dur,
          color: el.getAttribute('data-pen-color') || strokeAttr,
        });
      }

      requestAnimationFrame(() => {
        setTimeout(() => {
          el.style.transition = `stroke-dashoffset ${dur}ms cubic-bezier(0.23, 1, 0.32, 1)`;
          el.style.strokeDashoffset = '0';
          if (origDash) {
            setTimeout(() => {
              el.style.strokeDasharray = origDash;
            }, dur + 25);
          }
        }, myDelay);
      });
    } else {
      el.style.opacity = '0';
      const myDelay = delay;
      delay += Math.round(stepGap * 0.55);
      requestAnimationFrame(() => {
        setTimeout(() => {
          el.style.transition = 'opacity 260ms cubic-bezier(0.23, 1, 0.32, 1)';
          el.style.opacity = el.getAttribute('opacity') || '1';
        }, myDelay);
      });
    }
  });

  if (penJobs.length) {
    runLivePenTrack(svgEl, penJobs);
  }

  labels.forEach((t, idx) => {
    t.style.opacity = '0';
    const st = getStep(t);
    const tDelay = st > 0 && st < 99 ? Math.min(1800, st * 260) : Math.min(delay + idx * 35, 2100);
    requestAnimationFrame(() => {
      setTimeout(() => {
        t.style.transition = 'opacity 260ms cubic-bezier(0.23, 1, 0.32, 1)';
        t.style.opacity = '1';
      }, tDelay);
    });
  });
}
