// Schematic Precision Engineering Blueprint Library (960x540)
// Design Philosophy: MIT / Milliken / Gillespie textbook Free-Body Diagrams & Plots.
// - Crisp geometric schematics (zero busy artwork, zero pixel guesswork)
// - Built-in LabelPlacer bounding-box collision avoider (0% overlapping pills)
// - Smart math + qualitative shape plotter with auto-scale & clean Legend Box (0% blank graphs)
// - Progressive chalk-talk layer reveals with 60fps live pen tracking

const PAL = {
  cyan: { stroke: '#38bdf8', strong: '#0ea5e9', fill: 'rgba(56, 189, 248, 0.11)', text: '#7dd3fc', bg: '#0c2235' },
  amber: { stroke: '#f59e0b', strong: '#d97706', fill: 'rgba(245, 158, 11, 0.12)', text: '#fcd34d', bg: '#291c09' },
  emerald: { stroke: '#10b981', strong: '#059669', fill: 'rgba(16, 185, 129, 0.11)', text: '#6ee7b7', bg: '#09251d' },
  rose: { stroke: '#f43f5e', strong: '#e11d48', fill: 'rgba(244, 63, 94, 0.12)', text: '#fda4af', bg: '#2b0e18' },
  slate: { stroke: '#94a3b8', strong: '#64748b', fill: 'rgba(148, 163, 184, 0.10)', text: '#cbd5e1', bg: '#151f30' },
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Typographic SVG <tspan> subscripts & superscripts so NO raw underscores (F_z, μ_real) ever appear in SVG!
function svgMath(s) {
  let out = esc(s);
  out = out.replace(/_\{([^{}]+)\}/gu, (_, sub) => `<tspan dy="3" font-size="76%">${sub.replace(/perp/g, '⊥')}</tspan><tspan dy="-3">&#8203;</tspan>`);
  out = out.replace(/\^\{([^{}]+)\}/gu, (_, sup) => `<tspan dy="-4" font-size="76%">${sup}</tspan><tspan dy="4">&#8203;</tspan>`);
  out = out.replace(/(?<=[\p{L}\p{N}])_(perp|[\p{L}\p{N}⊥,]{1,14})(?![\p{L}\p{N}])/gu, (_, sub) => `<tspan dy="3" font-size="76%">${sub === 'perp' ? '⊥' : sub}</tspan><tspan dy="-3">&#8203;</tspan>`);
  out = out.replace(/(?<=[\p{L}\p{N})])\^([+\-−]?[\p{L}\p{N}]{1,3})(?![\p{L}\p{N}])/gu, '<tspan dy="-4" font-size="76%">$1</tspan><tspan dy="4">&#8203;</tspan>');
  return out;
}

function palOf(c, fb = 'cyan') {
  return PAL[String(c || '').toLowerCase()] || PAL[fb] || PAL.cyan;
}

// ---------------- Automatic Bounding-Box Label Collision Avoider ----------------
function createPlacer(initialObstacles = []) {
  const boxes = [...initialObstacles]; // { x, y, w, h }

  const intersects = (a, b, pad = 6) =>
    !(a.x + a.w + pad <= b.x || b.x + b.w + pad <= a.x || a.y + a.h + pad <= b.y || b.y + b.h + pad <= a.y);

  const clampRect = (rx, ry, w, h) => ({
    x: Math.max(16, Math.min(944 - w, rx)),
    y: Math.max(46, Math.min(522 - h, ry)),
    w,
    h,
  });

  function reserve(x, y, w, h) {
    boxes.push({ x, y, w, h });
  }

  function pill(x, y, text, color = 'cyan', { anchor = 'middle', fontSize = 12, maxLen = 40 } = {}) {
    if (!text) return '';
    const p = palOf(color);
    const clean = String(text).trim().slice(0, maxLen);
    if (!clean) return '';
    const w = Math.max(38, Math.min(265, clean.length * (fontSize * 0.62) + 18));
    const h = 23;
    const baseRx = anchor === 'middle' ? x - w / 2 : anchor === 'end' ? x - w : x;
    const baseRy = y - h / 2;

    const offsets = [
      [0, 0],
      [0, -28],
      [0, 28],
      [0, -56],
      [0, 56],
      [38, 0],
      [-38, 0],
      [38, -28],
      [-38, -28],
      [38, 28],
      [-38, 28],
      [82, 0],
      [-82, 0],
      [0, -84],
      [0, 84],
      [82, -28],
      [-82, -28],
      [82, 28],
      [-82, 28],
    ];

    let chosen = clampRect(baseRx, baseRy, w, h);
    for (const [dx, dy] of offsets) {
      const cand = clampRect(baseRx + dx, baseRy + dy, w, h);
      if (!boxes.some((b) => intersects(cand, b, 6))) {
        chosen = cand;
        break;
      }
    }
    boxes.push(chosen);

    return `
      <g>
        <rect x="${chosen.x.toFixed(1)}" y="${chosen.y.toFixed(1)}" width="${chosen.w.toFixed(1)}" height="${chosen.h}" rx="5.5"
          fill="${p.bg}" stroke="${p.stroke}" stroke-width="1.2" opacity="0.96" />
        <text x="${(chosen.x + chosen.w / 2).toFixed(1)}" y="${(chosen.y + 15.5).toFixed(1)}" text-anchor="middle" fill="${p.text}"
          font-size="${fontSize}" font-weight="650" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Text', sans-serif">${svgMath(clean)}</text>
      </g>
    `;
  }

  return { pill, reserve };
}

function dimLine(placer, x1, y1, x2, y2, offset, label, color = 'cyan', prefix = 'bp') {
  const p = palOf(color);
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;
  const ax1 = x1 + nx * offset;
  const ay1 = y1 + ny * offset;
  const ax2 = x2 + nx * offset;
  const ay2 = y2 + ny * offset;
  const sign = offset >= 0 ? 1 : -1;
  const ex1 = ax1 + nx * 6 * sign;
  const ey1 = ay1 + ny * 6 * sign;
  const ex2 = ax2 + nx * 6 * sign;
  const ey2 = ay2 + ny * 6 * sign;
  const mx = (ax1 + ax2) / 2;
  const my = (ay1 + ay2) / 2;
  return `
    <g>
      <line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${ex1.toFixed(1)}" y2="${ey1.toFixed(1)}" stroke="${p.stroke}" stroke-width="1.1" stroke-dasharray="3 3" opacity="0.55" />
      <line x1="${x2.toFixed(1)}" y1="${y2.toFixed(1)}" x2="${ex2.toFixed(1)}" y2="${ey2.toFixed(1)}" stroke="${p.stroke}" stroke-width="1.1" stroke-dasharray="3 3" opacity="0.55" />
      <line x1="${ax1.toFixed(1)}" y1="${ay1.toFixed(1)}" x2="${ax2.toFixed(1)}" y2="${ay2.toFixed(1)}" stroke="${p.stroke}" stroke-width="1.7"
        marker-start="url(#${prefix}-arr-${color})" marker-end="url(#${prefix}-arr-${color})" data-pen="1" data-pen-color="${p.stroke}" />
      ${label ? placer.pill(mx, my, label, color) : ''}
    </g>
  `;
}

function vecArrow(placer, x1, y1, x2, y2, label, color = 'amber', { prefix = 'bp', labelDx = 0, labelDy = 0, dashed = false, anchor = 'middle', width = 3.0 } = {}) {
  const p = palOf(color);
  const mx = (x1 + x2) / 2 + labelDx;
  const my = (y1 + y2) / 2 + labelDy;
  return `
    <g>
      <line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"
        stroke="${p.stroke}" stroke-width="${width}" stroke-linecap="round"${dashed ? ' stroke-dasharray="6 4"' : ''}
        marker-end="url(#${prefix}-arr-${color})" filter="url(#${prefix}-glow)" data-pen="1" data-pen-color="${p.stroke}" />
      <circle cx="${x1.toFixed(1)}" cy="${y1.toFixed(1)}" r="3.2" fill="${p.stroke}" />
      ${label ? placer.pill(mx, my, label, color, { anchor }) : ''}
    </g>
  `;
}

function cgCrosshair(placer, cx, cy, label = 'CG', color = 'amber', r = 11, { labelDx = 16, labelDy = -16, anchor = 'start' } = {}) {
  const p = palOf(color);
  return `
    <g>
      <line x1="${cx - r - 8}" y1="${cy}" x2="${cx + r + 8}" y2="${cy}" stroke="${p.stroke}" stroke-width="1.2" opacity="0.7" />
      <line x1="${cx}" y1="${cy - r - 8}" x2="${cx}" y2="${cy + r + 8}" stroke="${p.stroke}" stroke-width="1.2" opacity="0.7" />
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="#0b0f17" stroke="${p.stroke}" stroke-width="2" />
      <path d="M ${cx} ${cy} L ${cx + r} ${cy} A ${r} ${r} 0 0 1 ${cx} ${cy + r} Z" fill="${p.stroke}" />
      <path d="M ${cx} ${cy} L ${cx - r} ${cy} A ${r} ${r} 0 0 1 ${cx} ${cy - r} Z" fill="${p.stroke}" />
      ${label ? placer.pill(cx + labelDx, cy + labelDy, label, color, { anchor }) : ''}
    </g>
  `;
}

function wheelSchematic(cx, cy, r = 38, color = 'cyan') {
  const p = palOf(color);
  return `
    <g>
      <circle cx="${cx}" cy="${cy}" r="${r}" fill="#0d1422" stroke="#94a3b8" stroke-width="3" />
      <circle cx="${cx}" cy="${cy}" r="${(r * 0.56).toFixed(1)}" fill="#162032" stroke="${p.stroke}" stroke-width="1.8" />
      <circle cx="${cx}" cy="${cy}" r="5" fill="${p.stroke}" />
      <line x1="${(cx - 18).toFixed(1)}" y1="${(cy + r).toFixed(1)}" x2="${(cx + 18).toFixed(1)}" y2="${(cy + r).toFixed(1)}" stroke="#f59e0b" stroke-width="3.6" stroke-linecap="round" />
    </g>
  `;
}

function groundPlane(y = 384, x1 = 90, x2 = 870, label = '', prefix = 'bp') {
  return `
    <g>
      <rect x="${x1}" y="${y}" width="${x2 - x1}" height="10" fill="url(#${prefix}-hatch)" opacity="0.6" />
      <line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="#64748b" stroke-width="2.4" stroke-linecap="round" />
      ${label ? `<text x="${x2 - 4}" y="${y - 8}" text-anchor="end" fill="#64748b" font-size="11" font-weight="600" font-family="ui-monospace, monospace">${esc(label)}</text>` : ''}
    </g>
  `;
}

function momentArc(placer, cx, cy, r, direction = 'ccw', label = '', color = 'rose', prefix = 'bp', labelYOffset = -18) {
  const p = palOf(color);
  const cw = String(direction).toLowerCase() === 'cw';
  const a1 = cw ? -Math.PI * 0.72 : Math.PI * 0.72;
  const a2 = cw ? Math.PI * 0.34 : -Math.PI * 0.34;
  const sx = cx + Math.cos(a1) * r;
  const sy = cy + Math.sin(a1) * r;
  const ex = cx + Math.cos(a2) * r;
  const ey = cy + Math.sin(a2) * r;
  return `
    <g>
      <path d="M ${sx.toFixed(1)} ${sy.toFixed(1)} A ${r} ${r} 0 1 ${cw ? 1 : 0} ${ex.toFixed(1)} ${ey.toFixed(1)}"
        fill="none" stroke="${p.stroke}" stroke-width="2.6" stroke-linecap="round"
        marker-end="url(#${prefix}-arr-${color})" data-pen="1" data-pen-color="${p.stroke}" />
      ${label ? placer.pill(cx, cy - r + labelYOffset, label, color) : ''}
    </g>
  `;
}

function springPath(x1, y1, x2, y2, coils = 6, amp = 13) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const nx = -uy;
  const ny = ux;
  const lead = Math.min(18, len * 0.16);
  const body = Math.max(16, len - 2 * lead);
  const pts = [`M ${x1.toFixed(1)} ${y1.toFixed(1)}`, `L ${(x1 + ux * lead).toFixed(1)} ${(y1 + uy * lead).toFixed(1)}`];
  const segs = coils * 2;
  for (let i = 1; i <= segs; i++) {
    const t = lead + (i / (segs + 1)) * body;
    const s = i % 2 === 1 ? amp : -amp;
    pts.push(`L ${(x1 + ux * t + nx * s).toFixed(1)} ${(y1 + uy * t + ny * s).toFixed(1)}`);
  }
  pts.push(`L ${(x2 - ux * lead).toFixed(1)} ${(y2 - uy * lead).toFixed(1)}`, `L ${x2.toFixed(1)} ${y2.toFixed(1)}`);
  return pts.join(' ');
}

function legendBox(x, y, items = []) {
  const valid = items.filter((it) => it && it.label);
  if (!valid.length) return '';
  const maxLen = Math.max(...valid.map((it) => String(it.label).length));
  const w = Math.max(122, Math.min(225, maxLen * 7.2 + 44));
  const rowH = 22;
  const h = 14 + valid.length * rowH;
  const bx = Math.max(16, Math.min(944 - w, x));
  const by = Math.max(46, Math.min(520 - h, y));
  const rows = valid
    .map((it, i) => {
      const p = palOf(it.color);
      const ry = by + 18 + i * rowH;
      return `
        <line x1="${bx + 12}" y1="${ry}" x2="${bx + 32}" y2="${ry}" stroke="${p.stroke}" stroke-width="2.8" stroke-linecap="round"${it.dashed ? ' stroke-dasharray="5 3"' : ''} />
        <text x="${bx + 40}" y="${ry + 4}" fill="#e2e8f0" font-size="11.5" font-weight="600" font-family="-apple-system, BlinkMacSystemFont, sans-serif">${svgMath(String(it.label).slice(0, 28))}</text>
      `;
    })
    .join('');
  return `
    <g>
      <rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${w.toFixed(1)}" height="${h}" rx="8"
        fill="#0b0f17" stroke="rgba(148, 163, 184, 0.34)" stroke-width="1.2" opacity="0.98" />
      ${rows}
    </g>
  `;
}

function buildBlueprintTemplateDefs(prefix = 'bp') {
  const mkArrow = (key, color) => `
    <marker id="${prefix}-arr-${key}" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
      <path d="M 1 1.5 L 11 6 L 1 10.5 L 3.4 6 Z" fill="${color}" />
    </marker>
  `;
  return `
    <defs>
      <pattern id="${prefix}-grid" width="24" height="24" patternUnits="userSpaceOnUse">
        <path d="M 24 0 L 0 0 0 24" fill="none" stroke="rgba(148,163,184,0.055)" stroke-width="0.8" />
      </pattern>
      <pattern id="${prefix}-hatch" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <line x1="0" y1="0" x2="0" y2="10" stroke="rgba(148,163,184,0.34)" stroke-width="1.3" />
      </pattern>
      <linearGradient id="${prefix}-car-cyan" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.18" />
        <stop offset="100%" stop-color="#0f2234" stop-opacity="0.72" />
      </linearGradient>
      <linearGradient id="${prefix}-car-amber" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.18" />
        <stop offset="100%" stop-color="#271c0a" stop-opacity="0.72" />
      </linearGradient>
      <linearGradient id="${prefix}-car-emerald" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#10b981" stop-opacity="0.18" />
        <stop offset="100%" stop-color="#0a271f" stop-opacity="0.72" />
      </linearGradient>
      <linearGradient id="${prefix}-car-rose" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#f43f5e" stop-opacity="0.18" />
        <stop offset="100%" stop-color="#2e0f19" stop-opacity="0.72" />
      </linearGradient>
      <filter id="${prefix}-glow" x="-25%" y="-25%" width="150%" height="150%">
        <feGaussianBlur stdDeviation="2.0" result="b" />
        <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
      </filter>
      ${Object.entries(PAL).map(([k, v]) => mkArrow(k, v.stroke)).join('')}
    </defs>
  `;
}

// ---------------- Bulletproof Math + Qualitative Curve Evaluator ----------------
// Accepts ANY single independent variable (x, V, v, t, w, a, u, r, n, f, s),
// Unicode math (², ³, ·, ×, −, π, √), "y = ..." / "F(V) = ..." prefixes, and implicit multiplication ("2x").
export function evalSafeExpr(rawExpr) {
  let expr = String(rawExpr || '').trim();
  if (!expr) return null;

  // Strip LHS assignment like "y = ...", "F(V) = ...", "P_aero = ..."
  const eqIdx = expr.indexOf('=');
  if (eqIdx !== -1 && eqIdx < expr.length - 1) {
    expr = expr.slice(eqIdx + 1).trim();
  }

  // Normalize Unicode math & common Spanish trig
  expr = expr
    .replace(/²/g, '**2')
    .replace(/³/g, '**3')
    .replace(/[·×]/g, '*')
    .replace(/[−–—]/g, '-')
    .replace(/π/g, 'PI')
    .replace(/√\s*\(/g, 'sqrt(')
    .replace(/√\s*([A-Za-z0-9.]+)/g, 'sqrt($1)')
    .replace(/\bsen\(/gi, 'sin(')
    .replace(/\bln\(/gi, 'log(')
    .replace(/\^/g, '**');

  // Auto-detect a single non-reserved independent variable (e.g. V, v, t, alpha, w, u, n) and map to `x`.
  // Reject unknown function calls like alert(1) immediately instead of mistaking them for variable multiplication.
  const reserved = new Set(['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'sinh', 'cosh', 'tanh', 'exp', 'log', 'log10', 'sqrt', 'abs', 'pow', 'min', 'max', 'PI', 'E', 'x']);
  for (const m of expr.matchAll(/\b([A-Za-z_][A-Za-z0-9_]*)\s*\(/g)) {
    if (!reserved.has(m[1])) return null;
  }
  const idents = [...new Set((expr.match(/\b[A-Za-z_][A-Za-z0-9_]*\b/g) || []).filter((id) => !reserved.has(id)))];
  if (idents.length === 1) {
    const varRe = new RegExp(`\\b${idents[0]}\\b`, 'g');
    expr = expr.replace(varRe, 'x');
  } else if (idents.length > 1) {
    return null;
  }

  // Insert implicit multiplication: 2x -> 2*x, 2(x) -> 2*(x), )x -> )*x, )( -> )*(
  expr = expr
    .replace(/(\d)(x\b|\()/g, '$1*$2')
    .replace(/\)(x\b|\d|\()/g, ')*$1')
    .replace(/\bx\(/g, 'x*(');

  // Zero-eval recursive-descent math parser (no `eval`, no `new Function`, 100% CSP-safe)
  const MATH_FUNCS = {
    sin: Math.sin, cos: Math.cos, tan: Math.tan,
    asin: Math.asin, acos: Math.acos, atan: Math.atan,
    sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
    exp: Math.exp, log: Math.log, log10: Math.log10,
    sqrt: Math.sqrt, abs: Math.abs, pow: Math.pow,
    min: Math.min, max: Math.max,
  };
  const MATH_CONSTS = { PI: Math.PI, E: Math.E };

  // Tokenize strictly into numbers, identifiers, and operators
  const tokens = [];
  let i = 0;
  while (i < expr.length) {
    const ch = expr[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (expr.slice(i, i + 2) === '**') { tokens.push({ t: 'op', v: '**' }); i += 2; continue; }
    if ('+-*/(),'.includes(ch)) { tokens.push({ t: 'op', v: ch }); i++; continue; }
    if (/[0-9.]/.test(ch)) {
      const m = expr.slice(i).match(/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/);
      if (!m) return null;
      tokens.push({ t: 'num', v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z]/.test(ch)) {
      const m = expr.slice(i).match(/^[A-Za-z][A-Za-z0-9]*/);
      if (!m) return null;
      const id = m[0];
      if (id !== 'x' && !(id in MATH_FUNCS) && !(id in MATH_CONSTS)) return null;
      tokens.push({ t: 'id', v: id });
      i += id.length;
      continue;
    }
    return null;
  }
  if (!tokens.length) return null;

  // Compile tokens into an AST tree once (fast evaluation per plotted point!)
  let pos = 0;
  const peek = () => tokens[pos] || null;
  const eat = (v) => {
    const tok = peek();
    if (!tok || (v !== undefined && tok.v !== v)) return null;
    pos++;
    return tok;
  };

  function parseAddSub() {
    let left = parseMulDiv();
    while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = eat().v;
      const right = parseMulDiv();
      left = { kind: 'bin', op, left, right };
    }
    return left;
  }

  function parseMulDiv() {
    let left = parsePower();
    while (peek()?.t === 'op' && (peek().v === '*' || peek().v === '/')) {
      const op = eat().v;
      const right = parsePower();
      left = { kind: 'bin', op, left, right };
    }
    return left;
  }

  function parsePower() {
    let base = parseUnary();
    if (peek()?.t === 'op' && peek().v === '**') {
      eat('**');
      const exp = parsePower(); // right-associative
      return { kind: 'bin', op: '**', left: base, right: exp };
    }
    return base;
  }

  function parseUnary() {
    if (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
      const op = eat().v;
      return { kind: 'unary', op, arg: parseUnary() };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new Error('Unexpected end');
    if (tok.t === 'num') { eat(); return { kind: 'num', v: tok.v }; }
    if (tok.t === 'id') {
      eat();
      if (tok.v === 'x') return { kind: 'var' };
      if (tok.v in MATH_CONSTS) return { kind: 'num', v: MATH_CONSTS[tok.v] };
      if (tok.v in MATH_FUNCS) {
        if (!eat('(')) throw new Error('Expected (');
        const args = [];
        if (peek()?.v !== ')') {
          args.push(parseAddSub());
          while (peek()?.v === ',') { eat(','); args.push(parseAddSub()); }
        }
        if (!eat(')')) throw new Error('Expected )');
        return { kind: 'call', fn: MATH_FUNCS[tok.v], args };
      }
      throw new Error('Unknown id');
    }
    if (tok.t === 'op' && tok.v === '(') {
      eat('(');
      const inner = parseAddSub();
      if (!eat(')')) throw new Error('Expected )');
      return inner;
    }
    throw new Error('Unexpected token');
  }

  function evalAst(node, x) {
    switch (node.kind) {
      case 'num': return node.v;
      case 'var': return x;
      case 'unary': return node.op === '-' ? -evalAst(node.arg, x) : evalAst(node.arg, x);
      case 'call': return node.fn(...node.args.map((a) => evalAst(a, x)));
      case 'bin': {
        const l = evalAst(node.left, x);
        const r = evalAst(node.right, x);
        if (node.op === '+') return l + r;
        if (node.op === '-') return l - r;
        if (node.op === '*') return l * r;
        if (node.op === '/') return l / r;
        if (node.op === '**') return l ** r;
        return NaN;
      }
      default: return NaN;
    }
  }

  try {
    const ast = parseAddSub();
    if (pos !== tokens.length) return null;
    const fn = (x) => evalAst(ast, x);
    const probe = fn(1);
    if (typeof probe !== 'number') return null;
    return fn;
  } catch {
    return null;
  }
}

// Qualitative canonical engineering curve shapes normalized cleanly to u in [0, 1] -> [0, 1]
function buildQualitativeCurveFn(shape, { scale = 0.85, offset = 0, yLevel = null } = {}) {
  const s = String(shape || '').toLowerCase().trim();
  const sc = Math.max(0.15, Math.min(1.0, Number(scale) || 0.85));
  const off = Math.max(0, Math.min(0.85, Number(offset) || 0));
  if (s === 'quadratic' || s === 'parabola' || s === 'drag' || s === 'v2') {
    return (u) => off + sc * u * u;
  }
  if (s === 'cubic' || s === 'power' || s === 'v3') {
    return (u) => off + sc * u * u * u;
  }
  if (s === 'linear' || s === 'line') {
    return (u) => off + sc * u;
  }
  if (s === 'linear_down' || s === 'decreasing' || s === 'mu_real' || s === 'slope_down') {
    const start = yLevel != null ? Number(yLevel) : 0.78;
    return (u) => Math.max(0.08, start - 0.30 * u - 0.06 * u * u);
  }
  if (s === 'constant_high' || s === 'horizontal_high' || s === 'mu_const') {
    const lvl = yLevel != null ? Number(yLevel) : 0.78;
    return () => lvl;
  }
  if (s === 'constant' || s === 'flat' || s === 'rolling') {
    const lvl = yLevel != null ? Number(yLevel) : offset > 0 ? off : 0.22;
    return () => lvl;
  }
  if (s === 'inverse' || s === 'hyperbola' || s === 'traction' || s === 'p/v') {
    return (u) => Math.min(1.05, 0.24 / Math.max(0.18, u + 0.04));
  }
  if (s === 'concave' || s === 'saturating' || s === 'tire_load') {
    return (u) => off + sc * (1.42 * u - 0.52 * u * u);
  }
  if (s === 'peak' || s === 'pacejka' || s === 'torque') {
    return (u) => {
      const a = u * 14;
      const ba = 0.25 * a;
      return off + sc * Math.sin(1.45 * Math.atan(ba - 0.35 * (ba - Math.atan(ba))));
    };
  }
  if (s === 'exponential' || s === 'exp') {
    return (u) => off + sc * ((Math.exp(2.3 * u) - 1) / (Math.exp(2.3) - 1));
  }
  if (s === 'decay') {
    return (u) => off + sc * Math.exp(-3.0 * u);
  }
  if (s === 'sine' || s === 'oscillation') {
    return (u) => 0.5 + 0.36 * Math.sin(u * Math.PI * 2.5);
  }
  if (s === 'parabola_down' || s === 'arch') {
    return (u) => off + sc * (4 * u * (1 - u));
  }
  return null;
}

function wrapLines(text, maxChars = 34) {
  const words = String(text || '').split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) {
      out.push(cur);
      cur = w;
    } else {
      cur = (cur + ' ' + w).trim();
    }
  }
  if (cur) out.push(cur);
  return out.slice(0, 3);
}

function fmtTickVal(v) {
  if (Math.abs(v) < 1e-9) return '0';
  if (Math.abs(v) >= 100 || Number.isInteger(v)) return String(Math.round(v));
  return Number(v.toFixed(1)).toString();
}

// ============================================================================
// 12 ULTRA-CLEAN SCHEMATIC ENGINEERING TEMPLATES (0% OVERLAP, 0% BLANK GRAPHS)
// ============================================================================

function layersCarSide(spec = {}, prefix = 'bp') {
  const mode = String(spec.mode || 'static').toLowerCase(); // static | braking | accelerating | aero
  const L = spec.labels || {};
  const placer = createPlacer();
  const groundY = 384;
  const r = 38;
  const wheelY = groundY - r;
  const rearX = 300;
  const frontX = 660;
  const frontPct = Math.max(0.34, Math.min(0.66, Number(spec.frontWeightPct ?? 0.48)));
  const cgX = rearX + (frontX - rearX) * frontPct;
  const cgY = 258;

  // Clean schematic engineering chassis (flat floor, chamfered nose facing right -> +X)
  const bodyD = `M 216 298 L 216 226 L 340 214 L 580 214 L 744 252 L 744 298 Z`;

  const base = `
    ${groundPlane(groundY, 110, 850, '', prefix)}
    <path d="${bodyD}" fill="url(#${prefix}-car-cyan)" stroke="#38bdf8" stroke-width="2.3" stroke-linejoin="round" data-pen="1" data-pen-color="#38bdf8" />
    <line x1="${rearX}" y1="298" x2="${rearX}" y2="${wheelY}" stroke="#64748b" stroke-width="2.4" />
    <line x1="${frontX}" y1="298" x2="${frontX}" y2="${wheelY}" stroke="#64748b" stroke-width="2.4" />
    ${wheelSchematic(rearX, wheelY, r, 'cyan')}
    ${wheelSchematic(frontX, wheelY, r, 'cyan')}
    <text x="760" y="280" fill="#94a3b8" font-size="11.5" font-weight="600" font-family="ui-monospace, monospace">→ +X</text>
  `;

  // Non-overlapping zones: b & a at top (y=112), h_CG cleanly on FAR RIGHT (x=814), L cleanly at bottom (y=502)
  const dimensions = `
    ${dimLine(placer, rearX, 214, cgX, 214, -100, L.b || 'b', 'cyan', prefix)}
    ${dimLine(placer, cgX, 214, frontX, 214, -100, L.a || 'a', 'cyan', prefix)}
    <line x1="${cgX}" y1="${cgY}" x2="820" y2="${cgY}" stroke="#38bdf8" stroke-width="1.1" stroke-dasharray="4 4" opacity="0.45" />
    ${dimLine(placer, 814, groundY, 814, cgY, 0, L.h || 'h_CG', 'cyan', prefix)}
    ${dimLine(placer, rearX, groundY, frontX, groundY, 118, L.L || 'L (batalla)', 'cyan', prefix)}
  `;

  const cg = `
    ${cgCrosshair(placer, cgX, cgY, L.cg || 'CG', 'amber', 11, { labelDx: -18, labelDy: -22, anchor: 'end' })}
    ${vecArrow(placer, cgX, cgY + 12, cgX, cgY + 86, L.mg || 'm·g', 'amber', { prefix, labelDx: 16, labelDy: 8, anchor: 'start' })}
  `;

  // Normal reactions placed BELOW ground pushing UP into tire contact patches (clean textbook FBD — zero wheel overlap!)
  const frontLen = mode === 'braking' ? 92 : mode === 'accelerating' ? 52 : mode === 'aero' ? 84 : 72;
  const rearLen = mode === 'braking' ? 52 : mode === 'accelerating' ? 92 : mode === 'aero' ? 88 : 72;
  const f1Label = L.Fz1 || (mode === 'braking' ? 'F_z1 + ΔF_z' : mode === 'accelerating' ? 'F_z1 − ΔF_z' : 'F_z1');
  const f2Label = L.Fz2 || (mode === 'braking' ? 'F_z2 − ΔF_z' : mode === 'accelerating' ? 'F_z2 + ΔF_z' : 'F_z2');
  const loads = `
    ${vecArrow(placer, frontX, groundY + frontLen, frontX, groundY + 4, f1Label, 'emerald', { prefix, labelDx: 18, labelDy: 4, anchor: 'start' })}
    ${vecArrow(placer, rearX, groundY + rearLen, rearX, groundY + 4, f2Label, mode === 'braking' ? 'rose' : 'emerald', { prefix, labelDx: -18, labelDy: 4, anchor: 'end' })}
  `;

  let forces = '';
  if (mode === 'braking') {
    forces = `
      ${vecArrow(placer, cgX + 12, cgY, cgX + 148, cgY, L.ax || 'F_inercia = m·a_x', 'rose', { prefix, labelDx: 20, labelDy: -22 })}
      ${vecArrow(placer, frontX, groundY - 2, frontX - 96, groundY - 2, L.Fx || 'F_frenada', 'rose', { prefix, labelDx: -6, labelDy: -20 })}
      ${vecArrow(placer, rearX, groundY - 2, rearX - 66, groundY - 2, '', 'rose', { prefix })}
    `;
  } else if (mode === 'accelerating') {
    forces = `
      ${vecArrow(placer, cgX - 12, cgY, cgX - 148, cgY, L.ax || 'F_inercia = m·a_x', 'rose', { prefix, labelDx: -20, labelDy: -22 })}
      ${vecArrow(placer, rearX, groundY - 2, rearX + 106, groundY - 2, L.Fx || 'F_tracción', 'emerald', { prefix, labelDx: 8, labelDy: -20 })}
    `;
  } else if (mode === 'aero') {
    forces = `
      ${vecArrow(placer, 236, 134, 236, 218, L.dfRear || 'F_z,aero tras.', 'amber', { prefix, labelDx: -14, labelDy: -4, anchor: 'end' })}
      ${vecArrow(placer, 704, 152, 704, 236, L.dfFront || 'F_z,aero del.', 'amber', { prefix, labelDx: 14, labelDy: -4, anchor: 'start' })}
      ${vecArrow(placer, 838, 256, 752, 256, L.drag || 'F_aero (drag)', 'rose', { prefix, labelDx: 12, labelDy: -22 })}
    `;
  } else {
    forces = vecArrow(placer, cgX + 12, cgY, cgX + 125, cgY, L.ax || 'v / a_x', 'amber', { prefix, labelDx: 14, labelDy: -22 });
  }

  // Moment arc sits cleanly ABOVE the chassis roof (y=164) — never collides with CG or chassis
  const moment =
    mode === 'braking'
      ? momentArc(placer, cgX, 174, 28, 'cw', L.moment || 'Cabeceo (Dive) · M_y', 'rose', prefix, -16)
      : mode === 'accelerating'
        ? momentArc(placer, cgX, 174, 28, 'ccw', L.moment || 'Cabeceo (Squat) · M_y', 'rose', prefix, -16)
        : momentArc(placer, cgX, 174, 28, 'cw', L.moment || 'Momento de cabeceo (I_yy)', 'rose', prefix, -16);

  return { base, dimensions, cg, loads, forces, moment };
}

function layersCarTop(spec = {}, prefix = 'bp') {
  const mode = String(spec.mode || 'dimensions').toLowerCase(); // dimensions | cornering | yaw | ackermann
  const L = spec.labels || {};
  const placer = createPlacer();
  const x = 276;
  const y = 188;
  const w = 408;
  const h = 160;
  const cy = y + h / 2;
  const rearX = x + 76;
  const frontX = x + w - 76;
  const wheelTopY = y;
  const wheelBotY = y + h;
  const steer = Number(spec.steerDeg ?? (mode === 'cornering' || mode === 'ackermann' ? -18 : 0));
  const cgX = rearX + (frontX - rearX) * 0.48;

  const tireTop = (tx, ty, deg = 0) =>
    `<rect x="${(tx - 28).toFixed(1)}" y="${(ty - 11).toFixed(1)}" width="56" height="22" rx="5" fill="#0d1422" stroke="#94a3b8" stroke-width="2.2" transform="rotate(${deg} ${tx.toFixed(1)} ${ty.toFixed(1)})" />`;

  const base = `
    <line x1="${x - 32}" y1="${cy}" x2="${x + w + 46}" y2="${cy}" stroke="#38bdf8" stroke-width="1" stroke-dasharray="6 5" opacity="0.38" />
    <line x1="${rearX}" y1="${wheelTopY}" x2="${rearX}" y2="${wheelBotY}" stroke="#64748b" stroke-width="2.2" />
    <line x1="${frontX}" y1="${wheelTopY}" x2="${frontX}" y2="${wheelBotY}" stroke="#64748b" stroke-width="2.2" />
    <rect x="${x + 14}" y="${y + 18}" width="${w - 28}" height="${h - 36}" rx="18" fill="url(#${prefix}-car-cyan)" stroke="#38bdf8" stroke-width="2.3" data-pen="1" data-pen-color="#38bdf8" />
    ${tireTop(rearX, wheelTopY, 0)}
    ${tireTop(rearX, wheelBotY, 0)}
    ${tireTop(frontX, wheelTopY, steer)}
    ${tireTop(frontX, wheelBotY, steer * 0.85)}
    <text x="${x + w + 52}" y="${cy + 4}" fill="#94a3b8" font-size="11.5" font-weight="600" font-family="ui-monospace, monospace">+X</text>
  `;

  // Clean outer margins: t_r on left (x=184), t_f on right (x=776), L on bottom (y=424)
  const dimensions = `
    ${dimLine(placer, rearX, wheelBotY, frontX, wheelBotY, 72, L.L || 'L (batalla)', 'cyan', prefix)}
    ${dimLine(placer, frontX, wheelTopY, frontX, wheelBotY, -162, L.tf || 't_f (vía del.)', 'cyan', prefix)}
    ${dimLine(placer, rearX, wheelTopY, rearX, wheelBotY, 162, L.tr || 't_r (vía tras.)', 'cyan', prefix)}
  `;

  const cg = cgCrosshair(placer, cgX, cy, L.cg || 'CG', 'amber', 11, { labelDx: -16, labelDy: -18, anchor: 'end' });

  let forces = '';
  if (mode === 'cornering' || mode === 'ackermann') {
    forces = `
      ${vecArrow(placer, frontX, wheelTopY - 12, frontX, wheelTopY - 82, L.Fyf || 'F_y,del', 'emerald', { prefix, labelDx: 16, labelDy: -6, anchor: 'start' })}
      ${vecArrow(placer, rearX, wheelTopY - 12, rearX, wheelTopY - 76, L.Fyr || 'F_y,tras', 'emerald', { prefix, labelDx: -16, labelDy: -6, anchor: 'end' })}
      ${vecArrow(placer, cgX, cy + 12, cgX, cy + 88, L.ay || 'm·a_y (centrífuga)', 'rose', { prefix, labelDx: 16, labelDy: 8, anchor: 'start' })}
    `;
  } else {
    forces = `
      ${vecArrow(placer, cgX + 12, cy, cgX + 120, cy, L.vx || 'v_x', 'emerald', { prefix, labelDx: 12, labelDy: -20 })}
      ${vecArrow(placer, cgX, cy - 12, cgX, cy - 84, L.ay || 'F_y / a_y', 'amber', { prefix, labelDx: 16, labelDy: -8, anchor: 'start' })}
    `;
  }

  const moment = momentArc(placer, cgX, cy, 42, 'ccw', L.moment || 'Guiñada (Yaw) · I_zz', 'rose', prefix, -22);
  return { base, dimensions, cg, forces, moment };
}

function layersCarFront(spec = {}, prefix = 'bp') {
  const mode = String(spec.mode || 'cornering').toLowerCase(); // static | cornering | camber | roll_center
  const L = spec.labels || {};
  const placer = createPlacer();
  const groundY = 386;
  const leftX = 272;
  const rightX = 688;
  const cx = (leftX + rightX) / 2;
  const tireW = 50;
  const tireH = 112;
  const tireTop = groundY - tireH;
  const rollDeg = Number(spec.rollDeg ?? (mode === 'cornering' ? 4.5 : 0));
  const camberDeg = Number(spec.camberDeg ?? (mode === 'camber' ? -5.0 : -1.5));
  const cgY = 248;
  const rcY = 348;

  // Clean schematic sprung mass box + double-wishbone links + 2 rectangular tires
  const base = `
    ${groundPlane(groundY, 110, 850, '', prefix)}
    <rect x="${leftX - tireW / 2}" y="${tireTop}" width="${tireW}" height="${tireH}" rx="7" fill="#0d1422" stroke="#94a3b8" stroke-width="2.6" transform="rotate(${-camberDeg} ${leftX} ${groundY})" />
    <rect x="${rightX - tireW / 2}" y="${tireTop}" width="${tireW}" height="${tireH}" rx="7" fill="#0d1422" stroke="#94a3b8" stroke-width="2.6" transform="rotate(${camberDeg} ${rightX} ${groundY})" />
    <line x1="${leftX + 25}" y1="${tireTop + 26}" x2="352" y2="274" stroke="#64748b" stroke-width="2.2" />
    <line x1="${leftX + 25}" y1="${tireTop + 82}" x2="352" y2="306" stroke="#64748b" stroke-width="2.2" />
    <line x1="${rightX - 25}" y1="${tireTop + 26}" x2="608" y2="274" stroke="#64748b" stroke-width="2.2" />
    <line x1="${rightX - 25}" y1="${tireTop + 82}" x2="608" y2="306" stroke="#64748b" stroke-width="2.2" />
    <g transform="rotate(${rollDeg} ${cx} ${rcY})">
      <rect x="348" y="198" width="264" height="106" rx="12" fill="url(#${prefix}-car-cyan)" stroke="#38bdf8" stroke-width="2.3" data-pen="1" data-pen-color="#38bdf8" />
    </g>
    <line x1="${cx}" y1="168" x2="${cx}" y2="${groundY + 10}" stroke="#38bdf8" stroke-width="1" stroke-dasharray="5 5" opacity="0.38" />
  `;

  // h_CG cleanly on FAR LEFT (x=140) completely outside the left tire! t (vía) cleanly at bottom (y=502)!
  const dimensions = `
    <line x1="134" y1="${cgY}" x2="${cx}" y2="${cgY}" stroke="#38bdf8" stroke-width="1.1" stroke-dasharray="4 4" opacity="0.42" />
    ${dimLine(placer, 140, groundY, 140, cgY, 0, L.h || 'h_CG', 'cyan', prefix)}
    ${dimLine(placer, leftX, groundY, rightX, groundY, 114, L.t || 't (ancho de vía)', 'cyan', prefix)}
    <circle cx="${cx}" cy="${rcY}" r="5.5" fill="#10b981" stroke="#0b0f17" stroke-width="2" />
    ${placer.pill(cx + 18, rcY + 4, L.rc || 'RC (Centro balanceo)', 'emerald', { anchor: 'start' })}
  `;

  const cg = `
    ${cgCrosshair(placer, cx, cgY, L.cg || 'CG', 'amber', 11, { labelDx: -16, labelDy: -18, anchor: 'end' })}
    ${vecArrow(placer, cx, cgY + 12, cx, cgY + 74, L.mg || 'm·g', 'amber', { prefix, labelDx: -16, labelDy: 6, anchor: 'end' })}
  `;

  // Normal reactions placed BELOW ground pushing UP into tire contact patches — zero tire overlap!
  const extLen = mode === 'cornering' ? 92 : 70;
  const intLen = mode === 'cornering' ? 48 : 70;
  const loads = `
    ${vecArrow(placer, rightX, groundY + extLen, rightX, groundY + 4, L.FzExt || (mode === 'cornering' ? 'F_z,ext + ΔF_z' : 'F_z,der'), 'emerald', { prefix, labelDx: 18, labelDy: 4, anchor: 'start' })}
    ${vecArrow(placer, leftX, groundY + intLen, leftX, groundY + 4, L.FzInt || (mode === 'cornering' ? 'F_z,int − ΔF_z' : 'F_z,izq'), mode === 'cornering' ? 'rose' : 'emerald', { prefix, labelDx: -18, labelDy: 4, anchor: 'end' })}
  `;

  const forces =
    mode === 'camber'
      ? `
        <line x1="${rightX}" y1="${groundY}" x2="${rightX}" y2="${tireTop - 36}" stroke="#38bdf8" stroke-width="1.3" stroke-dasharray="4 4" />
        ${placer.pill(rightX + 20, tireTop - 22, L.camber || 'Caída negativa (γ < 0)', 'amber', { anchor: 'start' })}
      `
      : `
        ${vecArrow(placer, cx + 14, cgY, cx + 162, cgY, L.ay || 'm·a_y (inercia)', 'rose', { prefix, labelDx: 20, labelDy: -22 })}
        ${vecArrow(placer, rightX, groundY - 2, rightX - 96, groundY - 2, L.Fy || 'F_y,ext', 'emerald', { prefix, labelDx: 0, labelDy: -20 })}
      `;

  // Roll arc cleanly ABOVE the sprung mass roof (y=142) — zero collision with CG!
  const moment = momentArc(placer, cx, 146, 30, 'cw', L.moment || 'Balanceo (Roll) · M_x', 'rose', prefix, -16);
  return { base, dimensions, cg, loads, forces, moment };
}

function layersQuarterCar(spec = {}, prefix = 'bp') {
  const L = spec.labels || {};
  const placer = createPlacer();
  const cx = 480;
  const roadY = 446;
  const unsprungY = 312;
  const unsprungH = 50;
  const sprungY = 104;
  const sprungH = 68;

  const roadD = `M 170 ${roadY} L 360 ${roadY} Q 420 ${roadY}, 450 ${roadY - 16} Q 480 ${roadY - 30}, 510 ${roadY - 16} Q 540 ${roadY}, 600 ${roadY} L 790 ${roadY}`;

  const base = `
    <path d="${roadD}" fill="none" stroke="#64748b" stroke-width="2.8" stroke-linecap="round" data-pen="1" data-pen-color="#64748b" />
    <text x="786" y="${roadY + 22}" text-anchor="end" fill="#64748b" font-size="11.5" font-family="ui-monospace, monospace">${esc(L.road || 'Asfalto z_r(t)')}</text>
    <path d="${springPath(cx, roadY - 22, cx, unsprungY + unsprungH, 5, 12)}" fill="none" stroke="#94a3b8" stroke-width="2.3" stroke-linejoin="round" data-pen="1" data-pen-color="#94a3b8" />
    ${placer.pill(cx + 36, (roadY - 22 + unsprungY + unsprungH) / 2, L.kt || 'k_t (neumático)', 'slate', { anchor: 'start' })}
    <rect x="${cx - 95}" y="${unsprungY}" width="190" height="${unsprungH}" rx="9" fill="url(#${prefix}-car-amber)" stroke="#f59e0b" stroke-width="2.2" data-pen="1" data-pen-color="#f59e0b" />
    <text x="${cx}" y="${unsprungY + 30}" text-anchor="middle" fill="#fcd34d" font-size="13.5" font-weight="700" font-family="-apple-system, sans-serif">${esc(L.mu || 'Masa no suspendida (m_u)')}</text>
  `;

  const suspension = `
    <path d="${springPath(cx - 56, unsprungY, cx - 56, sprungY + sprungH, 6, 13)}" fill="none" stroke="#38bdf8" stroke-width="2.5" stroke-linejoin="round" data-pen="1" data-pen-color="#38bdf8" />
    ${placer.pill(cx - 96, (unsprungY + sprungY + sprungH) / 2, L.ks || 'Muelle k_s', 'cyan', { anchor: 'end' })}
    <g>
      <line x1="${cx + 56}" y1="${unsprungY}" x2="${cx + 56}" y2="${unsprungY - 46}" stroke="#10b981" stroke-width="2.5" />
      <path d="M ${cx + 42} ${unsprungY - 90} L ${cx + 42} ${unsprungY - 46} L ${cx + 70} ${unsprungY - 46} L ${cx + 70} ${unsprungY - 90}" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linejoin="round" data-pen="1" data-pen-color="#10b981" />
      <line x1="${cx + 47}" y1="${unsprungY - 68}" x2="${cx + 65}" y2="${unsprungY - 68}" stroke="#10b981" stroke-width="3.2" />
      <line x1="${cx + 56}" y1="${unsprungY - 68}" x2="${cx + 56}" y2="${sprungY + sprungH}" stroke="#10b981" stroke-width="2.5" />
    </g>
    ${placer.pill(cx + 96, (unsprungY + sprungY + sprungH) / 2, L.cs || 'Amortiguador c_s', 'emerald', { anchor: 'start' })}
    <rect x="${cx - 128}" y="${sprungY}" width="256" height="${sprungH}" rx="10" fill="url(#${prefix}-car-cyan)" stroke="#38bdf8" stroke-width="2.3" data-pen="1" data-pen-color="#38bdf8" />
    <text x="${cx}" y="${sprungY + 39}" text-anchor="middle" fill="#7dd3fc" font-size="14.5" font-weight="700" font-family="-apple-system, sans-serif">${esc(L.ms || 'Masa suspendida · Chasis (m_s)')}</text>
  `;

  const dimensions = `
    ${vecArrow(placer, 232, sprungY + 54, 232, sprungY + 6, L.zs || 'z_s (chasis)', 'cyan', { prefix, labelDx: -16, anchor: 'end' })}
    ${vecArrow(placer, 232, unsprungY + 46, 232, unsprungY + 2, L.zu || 'z_u (rueda)', 'amber', { prefix, labelDx: -16, anchor: 'end' })}
  `;

  const forces = placer.pill(480, 496, L.Fz || 'Objetivo: minimizar ΔF_z en el parche de contacto', 'rose');
  return { base, suspension, dimensions, forces };
}

// Universal ultra-clean schematic Free-Body Diagram (horizontal | incline | vertical | equilibrium)
function layersForceBalance(spec = {}, prefix = 'bp') {
  const mode = String(spec.mode || 'horizontal').toLowerCase();
  const L = spec.labels || {};
  const placer = createPlacer();
  const cx = 480;
  const cy = 264;

  if (mode === 'incline') {
    const base = `
      <polygon points="150,420 810,420 810,200" fill="rgba(148,163,184,0.08)" stroke="#64748b" stroke-width="2.2" />
      <path d="M 225 420 A 75 75 0 0 0 221 396" fill="none" stroke="#38bdf8" stroke-width="2" />
      ${placer.pill(256, 404, L.alpha || 'α (pendiente)', 'cyan', { anchor: 'start' })}
      <g transform="translate(500 303) rotate(-18.4)">
        <rect x="-68" y="-56" width="136" height="56" rx="8" fill="url(#${prefix}-car-cyan)" stroke="#38bdf8" stroke-width="2.3" data-pen="1" data-pen-color="#38bdf8" />
      </g>
      ${cgCrosshair(placer, 492, 276, L.body || 'm', 'amber', 10, { labelDx: -18, labelDy: -22, anchor: 'end' })}
    `;
    const forces = `
      ${vecArrow(placer, 492, 276, 626, 231, L.right || L.Fx || 'F_tracción', 'emerald', { prefix, labelDx: 18, labelDy: -18 })}
      ${vecArrow(placer, 492, 276, 368, 317, L.left || L.drag || 'F_aero + F_rod + mg·sen α', 'rose', { prefix, labelDx: -20, labelDy: -24, anchor: 'end' })}
      ${vecArrow(placer, 492, 276, 492, 404, L.down || L.mg || 'm·g', 'amber', { prefix, labelDx: 16, labelDy: 12, anchor: 'start' })}
      ${vecArrow(placer, 492, 276, 456, 168, L.up || L.N || 'N = m·g·cos α', 'cyan', { prefix, labelDx: -16, labelDy: -8, anchor: 'end' })}
    `;
    const result = placer.pill(480, 482, L.result || 'Equilibrio longitudinal: ΣF_x = m · a_x', 'emerald');
    return { base, forces, result };
  }

  const base = `
    ${groundPlane(330, 140, 820, '', prefix)}
    <rect x="${cx - 96}" y="${cy - 44}" width="192" height="88" rx="10" fill="url(#${prefix}-car-cyan)" stroke="#38bdf8" stroke-width="2.4" data-pen="1" data-pen-color="#38bdf8" />
    ${cgCrosshair(placer, cx, cy, L.body || 'm (vehículo)', 'amber', 10, { labelDx: 0, labelDy: -62 })}
  `;
  const forces = `
    ${vecArrow(placer, cx + 96, cy, cx + 256, cy, L.right || L.Fx || 'F_tracción (motriz)', 'emerald', { prefix, labelDx: 6, labelDy: -22 })}
    ${vecArrow(placer, cx - 96, cy, cx - 256, cy, L.left || L.drag || 'F_aero + F_rod (resist.)', 'rose', { prefix, labelDx: -6, labelDy: -22 })}
    ${vecArrow(placer, cx, cy + 44, cx, cy + 140, L.down || L.mg || 'm·g (peso)', 'amber', { prefix, labelDx: 18, labelDy: 6, anchor: 'start' })}
    ${vecArrow(placer, cx, cy - 44, cx, cy - 134, L.up || L.N || 'N (normal)', 'cyan', { prefix, labelDx: 18, labelDy: -4, anchor: 'start' })}
  `;
  const result = placer.pill(480, 488, L.result || '2.ª Ley de Newton: F_motriz − ΣF_resistentes = m · a_x', 'emerald');
  return { base, forces, result };
}

// Dedicated Canonical Graph: External Resistances vs Traction Power & V_max (e.g. Page 29!)
function layersPowerBalance(spec = {}, prefix = 'bp') {
  const L = spec.labels || {};
  const placer = createPlacer();
  const ax = { x: 112, y: 76, w: 690, h: 368 };
  const vMaxAxis = Number(spec.xMax ?? 220);
  const fMaxAxis = Number(spec.yMax ?? 3000);
  const mapX = (v) => ax.x + (v / (vMaxAxis || 1)) * ax.w;
  const mapY = (f) => ax.y + ax.h - (Math.min(fMaxAxis, Math.max(0, f)) / (fMaxAxis || 1)) * ax.h;

  // Physically clean reference model normalized to the plot domain
  const fRollVal = fMaxAxis * 0.085;
  const fAero = (v) => fMaxAxis * 0.48 * Math.pow(v / vMaxAxis, 2);
  const fTotal = (v) => fRollVal + fAero(v);
  // Traction force hyperbola F_x = P / V crossing fTotal cleanly at v = 0.84 * vMaxAxis!
  const vCross = vMaxAxis * 0.84;
  const fCross = fTotal(vCross);
  const powerK = fCross * vCross;
  const fTract = (v) => powerK / Math.max(vMaxAxis * 0.12, v);

  let ticks = '';
  for (let i = 0; i <= 5; i++) {
    const v = (i / 5) * vMaxAxis;
    const px = mapX(v);
    ticks += `<line x1="${px.toFixed(1)}" y1="${ax.y}" x2="${px.toFixed(1)}" y2="${ax.y + ax.h}" stroke="rgba(148,163,184,0.12)" />`;
    ticks += `<text x="${px.toFixed(1)}" y="${ax.y + ax.h + 18}" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="ui-monospace, monospace">${fmtTickVal(v)}</text>`;
  }
  for (let i = 0; i <= 4; i++) {
    const f = (i / 4) * fMaxAxis;
    const py = mapY(f);
    ticks += `<line x1="${ax.x}" y1="${py.toFixed(1)}" x2="${ax.x + ax.w}" y2="${py.toFixed(1)}" stroke="rgba(148,163,184,0.12)" />`;
    ticks += `<text x="${ax.x - 10}" y="${(py + 4).toFixed(1)}" text-anchor="end" fill="#94a3b8" font-size="11" font-family="ui-monospace, monospace">${fmtTickVal(f)}</text>`;
  }

  const base = `
    <rect x="${ax.x}" y="${ax.y}" width="${ax.w}" height="${ax.h}" rx="6" fill="rgba(11,15,23,0.45)" stroke="rgba(148,163,184,0.22)" />
    ${ticks}
    <line x1="${ax.x}" y1="${ax.y + ax.h}" x2="${ax.x + ax.w + 16}" y2="${ax.y + ax.h}" stroke="#cbd5e1" stroke-width="2" marker-end="url(#${prefix}-arr-slate)" />
    <line x1="${ax.x}" y1="${ax.y + ax.h}" x2="${ax.x}" y2="${ax.y - 16}" stroke="#cbd5e1" stroke-width="2" marker-end="url(#${prefix}-arr-slate)" />
    <text x="${ax.x + ax.w / 2}" y="${ax.y + ax.h + 42}" text-anchor="middle" fill="#e2e8f0" font-size="13" font-weight="650">${svgMath(spec.xLabel || L.xLabel || 'Velocidad V (km/h)')}</text>
    <text x="${ax.x}" y="${ax.y - 22}" text-anchor="start" fill="#e2e8f0" font-size="13" font-weight="650">${svgMath(spec.yLabel || L.yLabel || 'Fuerza F (N)')}</text>
  `;

  const samplePath = (fn, vStart = 0) => {
    const pts = [];
    for (let i = 0; i <= 110; i++) {
      const v = vStart + (i / 110) * (vMaxAxis - vStart);
      const yVal = fn(v);
      if (yVal > fMaxAxis * 1.01) continue;
      pts.push(`${pts.length === 0 ? 'M' : 'L'} ${mapX(v).toFixed(1)} ${mapY(yVal).toFixed(1)}`);
    }
    return pts.join(' ');
  };

  const resistances = `
    <line x1="${ax.x}" y1="${mapY(fRollVal).toFixed(1)}" x2="${ax.x + ax.w}" y2="${mapY(fRollVal).toFixed(1)}" stroke="#94a3b8" stroke-width="2" stroke-dasharray="6 4" data-pen="1" data-pen-color="#94a3b8" />
    <path d="${samplePath(fAero, 0)}" fill="none" stroke="#38bdf8" stroke-width="2.8" stroke-linecap="round" data-pen="1" data-pen-color="#38bdf8" />
    <path d="${samplePath(fTotal, 0)}" fill="none" stroke="#f43f5e" stroke-width="3.2" stroke-linecap="round" filter="url(#${prefix}-glow)" data-pen="1" data-pen-color="#f43f5e" />
    ${legendBox(ax.x + ax.w - 196, ax.y + 12, [
      { label: L.total || 'F_total (resist.)', color: 'rose' },
      { label: L.aero || 'F_aero ∝ V²', color: 'cyan' },
      { label: L.roll || 'F_rod + F_pend', color: 'slate', dashed: true },
    ])}
  `;

  const traction = `
    <path d="${samplePath(fTract, vMaxAxis * 0.28)}" fill="none" stroke="#f59e0b" stroke-width="3.2" stroke-linecap="round" filter="url(#${prefix}-glow)" data-pen="1" data-pen-color="#f59e0b" />
    ${legendBox(ax.x + ax.w - 196, ax.y + 12, [
      { label: L.traction || 'F_x = P / V (motor)', color: 'amber' },
      { label: L.total || 'F_total (resist.)', color: 'rose' },
      { label: L.aero || 'F_aero ∝ V²', color: 'cyan' },
      { label: L.roll || 'F_rod + F_pend', color: 'slate', dashed: true },
    ])}
  `;

  const cx = mapX(vCross);
  const cy = mapY(fCross);
  const vmax = `
    <line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${ax.y + ax.h}" stroke="#10b981" stroke-width="2.2" stroke-dasharray="5 4" data-pen="1" data-pen-color="#10b981" />
    <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="8" fill="rgba(16,185,129,0.22)" stroke="#10b981" stroke-width="2.6" />
    <circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="3.5" fill="#10b981" />
    ${placer.pill(cx - 12, cy - 30, L.vmax || 'Equilibrio: F_x = F_total → V_max', 'emerald', { anchor: 'end' })}
  `;

  return { base, resistances, traction, vmax, curve1: resistances, curve2: traction };
}

function layersTireLoadCurve(spec = {}, prefix = 'bp') {
  const L = spec.labels || {};
  const placer = createPlacer();
  const ax = { x: 112, y: 78, w: 724, h: 360 };
  const mapX = (u) => ax.x + u * ax.w;
  const mapY = (v) => ax.y + ax.h - v * ax.h;
  const modeStr = String(spec.mode || '').toLowerCase();
  const yHint = `${spec.yLabel || ''} ${L.yLabel || ''} ${L.curve || ''}`.toLowerCase();
  const isMuMode =
    modeStr === 'mu_vs_fz' ||
    modeStr === 'mu' ||
    modeStr === 'adhesion' ||
    (/coeficiente|adherencia|\bμ\b|\bmu\b/.test(yHint) && !/f_y|fuerza lateral/.test(yHint));

  let grid = '';
  for (let i = 1; i <= 4; i++) {
    const gx = ax.x + (i / 4) * ax.w;
    const gy = ax.y + (i / 4) * ax.h;
    grid += `<line x1="${gx}" y1="${ax.y}" x2="${gx}" y2="${ax.y + ax.h}" stroke="rgba(148,163,184,0.12)" />`;
    grid += `<line x1="${ax.x}" y1="${gy}" x2="${ax.x + ax.w}" y2="${gy}" stroke="rgba(148,163,184,0.12)" />`;
  }

  // Mode 1: μ vs F_z (Coeficiente de adherencia decreciente con la carga vertical — fiel a diapositivas de μ_real vs μ_constante!)
  if (isMuMode) {
    const muConst = 0.78;
    const muReal = (u) => muConst - 0.30 * u - 0.05 * u * u;
    const base = `
      <rect x="${ax.x}" y="${ax.y}" width="${ax.w}" height="${ax.h}" rx="6" fill="rgba(11,15,23,0.45)" stroke="rgba(148,163,184,0.22)" />
      ${grid}
      <line x1="${ax.x}" y1="${ax.y + ax.h}" x2="${ax.x + ax.w + 16}" y2="${ax.y + ax.h}" stroke="#cbd5e1" stroke-width="2" marker-end="url(#${prefix}-arr-slate)" />
      <line x1="${ax.x}" y1="${ax.y + ax.h}" x2="${ax.x}" y2="${ax.y - 16}" stroke="#cbd5e1" stroke-width="2" marker-end="url(#${prefix}-arr-slate)" />
      <text x="${ax.x + ax.w / 2}" y="${ax.y + ax.h + 40}" text-anchor="middle" fill="#cbd5e1" font-size="13" font-weight="650">${svgMath(L.xLabel || spec.xLabel || 'Carga vertical F_z (N)')}</text>
      <text x="${ax.x}" y="${ax.y - 22}" text-anchor="start" fill="#cbd5e1" font-size="13" font-weight="650">${svgMath(L.yLabel || spec.yLabel || 'Coeficiente de adherencia μ')}</text>
      <line x1="${mapX(0)}" y1="${mapY(muConst)}" x2="${mapX(0.95)}" y2="${mapY(muConst)}" stroke="#94a3b8" stroke-width="2" stroke-dasharray="7 5" opacity="0.82" />
    `;
    const pts = [];
    for (let i = 0; i <= 90; i++) {
      const u = (i / 90) * 0.94;
      pts.push(`${i === 0 ? 'M' : 'L'} ${mapX(u).toFixed(1)} ${mapY(muReal(u)).toFixed(1)}`);
    }
    const curve = `
      <path d="${pts.join(' ')}" fill="none" stroke="#38bdf8" stroke-width="3.2" stroke-linecap="round" filter="url(#${prefix}-glow)" data-pen="1" data-pen-color="#38bdf8" />
      ${legendBox(ax.x + ax.w - 220, ax.y + 16, [
        { label: L.ideal || 'μ_constante (Coulomb ideal)', color: 'slate', dashed: true },
        { label: L.curve || 'μ_real (neumático)', color: 'cyan' },
      ])}
    `;
    const uLo = 0.22;
    const uHi = 0.80;
    const transfer = `
      <circle cx="${mapX(uLo)}" cy="${mapY(muReal(uLo))}" r="6" fill="#10b981" stroke="#ffffff" stroke-width="1.8" />
      <circle cx="${mapX(uHi)}" cy="${mapY(muReal(uHi))}" r="6" fill="#f43f5e" stroke="#ffffff" stroke-width="1.8" />
      ${vecArrow(placer, mapX(uHi), mapY(muConst) + 4, mapX(uHi), mapY(muReal(uHi)) - 8, L.loss || 'Caída de μ con mayor F_z', 'rose', { prefix, labelDx: -18, anchor: 'end', width: 2.4 })}
      ${placer.pill(mapX(uLo), mapY(muReal(uLo)) + 34, L.lowLoad || 'Menor F_z → μ más alto', 'emerald')}
      ${placer.pill(mapX(uHi), mapY(muReal(uHi)) + 34, L.highLoad || 'Mayor F_z → μ más bajo', 'amber')}
    `;
    return { base, curve, transfer };
  }

  // Mode 2: F_y vs F_z (Curva cóncava de agarre lateral y pérdida por transferencia de carga ΔF_z)
  const fy = (u) => Math.min(0.95, 1.48 * u - 0.56 * u * u);
  const base = `
    <rect x="${ax.x}" y="${ax.y}" width="${ax.w}" height="${ax.h}" rx="6" fill="rgba(11,15,23,0.45)" stroke="rgba(148,163,184,0.22)" />
    ${grid}
    <line x1="${ax.x}" y1="${ax.y + ax.h}" x2="${ax.x + ax.w + 16}" y2="${ax.y + ax.h}" stroke="#cbd5e1" stroke-width="2" marker-end="url(#${prefix}-arr-slate)" />
    <line x1="${ax.x}" y1="${ax.y + ax.h}" x2="${ax.x}" y2="${ax.y - 16}" stroke="#cbd5e1" stroke-width="2" marker-end="url(#${prefix}-arr-slate)" />
    <text x="${ax.x + ax.w / 2}" y="${ax.y + ax.h + 40}" text-anchor="middle" fill="#cbd5e1" font-size="13" font-weight="650">${svgMath(L.xLabel || 'Carga vertical F_z (N)')}</text>
    <text x="${ax.x}" y="${ax.y - 22}" text-anchor="start" fill="#cbd5e1" font-size="13" font-weight="650">${svgMath(L.yLabel || 'Agarre lateral F_y (N)')}</text>
    <line x1="${mapX(0)}" y1="${mapY(0)}" x2="${mapX(0.64)}" y2="${mapY(0.95)}" stroke="#64748b" stroke-width="1.6" stroke-dasharray="6 5" opacity="0.65" />
  `;

  const pts = [];
  for (let i = 0; i <= 100; i++) {
    const u = (i / 100) * 0.96;
    pts.push(`${i === 0 ? 'M' : 'L'} ${mapX(u).toFixed(1)} ${mapY(fy(u)).toFixed(1)}`);
  }
  const curveD = pts.join(' ');

  const curve = `
    <path d="${curveD}" fill="none" stroke="#38bdf8" stroke-width="3.2" stroke-linecap="round" filter="url(#${prefix}-glow)" data-pen="1" data-pen-color="#38bdf8" />
    ${legendBox(ax.x + 16, ax.y + 14, [
      { label: L.curve || 'Neumático real (cóncava)', color: 'cyan' },
      { label: 'Ideal lineal (μ constante)', color: 'slate', dashed: true },
    ])}
  `;

  const u0 = 0.5;
  const du = 0.34;
  const uIn = u0 - du;
  const uOut = u0 + du;
  const y0 = fy(u0);
  const yIn = fy(uIn);
  const yOut = fy(uOut);
  const yAvg = (yIn + yOut) / 2;

  const transfer = `
    <line x1="${mapX(uIn)}" y1="${mapY(yIn)}" x2="${mapX(uOut)}" y2="${mapY(yOut)}" stroke="#f43f5e" stroke-width="2.3" stroke-dasharray="6 4" data-pen="1" data-pen-color="#f43f5e" />
    <line x1="${mapX(u0)}" y1="${mapY(0)}" x2="${mapX(u0)}" y2="${mapY(y0)}" stroke="#10b981" stroke-width="1.3" stroke-dasharray="4 4" />
    <circle cx="${mapX(uIn)}" cy="${mapY(yIn)}" r="5.5" fill="#0b0f17" stroke="#f43f5e" stroke-width="2.6" />
    <circle cx="${mapX(uOut)}" cy="${mapY(yOut)}" r="5.5" fill="#0b0f17" stroke="#f59e0b" stroke-width="2.6" />
    <circle cx="${mapX(u0)}" cy="${mapY(y0)}" r="6" fill="#10b981" stroke="#ffffff" stroke-width="1.8" />
    <circle cx="${mapX(u0)}" cy="${mapY(yAvg)}" r="5.5" fill="#f43f5e" stroke="#ffffff" stroke-width="1.6" />
    ${vecArrow(placer, mapX(u0) + 10, mapY(y0), mapX(u0) + 10, mapY(yAvg), L.loss || 'Pérdida neta ΔF_y', 'rose', { prefix, labelDx: 18, labelDy: 22, anchor: 'start', width: 2.5 })}
    ${placer.pill(mapX(uIn) + 14, mapY(yIn) + 32, 'Interior (F_z − ΔF_z)', 'rose', { anchor: 'start' })}
    ${placer.pill(mapX(u0), mapY(y0) - 30, 'Óptimo sin ΔF_z', 'emerald')}
    ${placer.pill(mapX(uOut) - 10, mapY(yOut) + 36, 'Exterior (F_z + ΔF_z)', 'amber', { anchor: 'end' })}
  `;

  return { base, curve, transfer };
}

function layersTireSlipCurve(spec = {}, prefix = 'bp') {
  const L = spec.labels || {};
  const placer = createPlacer();
  const ax = { x: 112, y: 78, w: 724, h: 360 };
  const mapX = (a) => ax.x + (a / 16) * ax.w;
  const mapY = (v) => ax.y + ax.h - v * ax.h;
  const pacejka = (a, D = 0.88, C = 1.45, B = 0.24, E = 0.35) => {
    const ba = B * a;
    return D * Math.sin(C * Math.atan(ba - E * (ba - Math.atan(ba))));
  };

  const base = `
    <rect x="${ax.x}" y="${ax.y}" width="${ax.w * 0.28}" height="${ax.h}" fill="rgba(56, 189, 248, 0.05)" />
    <rect x="${ax.x + ax.w * 0.28}" y="${ax.y}" width="${ax.w * 0.24}" height="${ax.h}" fill="rgba(16, 185, 129, 0.07)" />
    <rect x="${ax.x + ax.w * 0.52}" y="${ax.y}" width="${ax.w * 0.48}" height="${ax.h}" fill="rgba(244, 63, 94, 0.05)" />
    <text x="${ax.x + ax.w * 0.14}" y="${ax.y + 20}" text-anchor="middle" fill="#7dd3fc" font-size="11" font-weight="650">Zona lineal (C_α)</text>
    <text x="${ax.x + ax.w * 0.40}" y="${ax.y + 20}" text-anchor="middle" fill="#6ee7b7" font-size="11" font-weight="650">Pico óptimo</text>
    <text x="${ax.x + ax.w * 0.76}" y="${ax.y + 20}" text-anchor="middle" fill="#fda4af" font-size="11" font-weight="650">Saturación</text>
    <line x1="${ax.x}" y1="${ax.y + ax.h}" x2="${ax.x + ax.w + 16}" y2="${ax.y + ax.h}" stroke="#cbd5e1" stroke-width="2" marker-end="url(#${prefix}-arr-slate)" />
    <line x1="${ax.x}" y1="${ax.y + ax.h}" x2="${ax.x}" y2="${ax.y - 16}" stroke="#cbd5e1" stroke-width="2" marker-end="url(#${prefix}-arr-slate)" />
    <text x="${ax.x + ax.w / 2}" y="${ax.y + ax.h + 40}" text-anchor="middle" fill="#cbd5e1" font-size="13" font-weight="650">${svgMath(L.xLabel || 'Ángulo de deriva α (°)')}</text>
    <text x="${ax.x}" y="${ax.y - 22}" text-anchor="start" fill="#cbd5e1" font-size="13" font-weight="650">${svgMath(L.yLabel || 'Fuerza lateral F_y (N)')}</text>
  `;

  const pts = [];
  let peakA = 0;
  let peakV = 0;
  for (let i = 0; i <= 120; i++) {
    const a = (i / 120) * 15.5;
    const v = pacejka(a);
    if (v > peakV) { peakV = v; peakA = a; }
    pts.push(`${i === 0 ? 'M' : 'L'} ${mapX(a).toFixed(1)} ${mapY(v).toFixed(1)}`);
  }

  const curve = `
    <path d="${pts.join(' ')}" fill="none" stroke="#10b981" stroke-width="3.2" stroke-linecap="round" filter="url(#${prefix}-glow)" data-pen="1" data-pen-color="#10b981" />
    <line x1="${mapX(peakA)}" y1="${mapY(0)}" x2="${mapX(peakA)}" y2="${mapY(peakV)}" stroke="#10b981" stroke-width="1.3" stroke-dasharray="4 4" />
    <circle cx="${mapX(peakA)}" cy="${mapY(peakV)}" r="6" fill="#10b981" stroke="#ffffff" stroke-width="1.8" />
    ${placer.pill(mapX(peakA) + 14, mapY(peakV) - 18, L.peak || 'Pico máximo (α_opt)', 'emerald', { anchor: 'start' })}
  `;

  const pts2 = [];
  for (let i = 0; i <= 120; i++) {
    const a = (i / 120) * 15.5;
    pts2.push(`${i === 0 ? 'M' : 'L'} ${mapX(a).toFixed(1)} ${mapY(pacejka(a, 0.56, 1.35, 0.20, 0.2)).toFixed(1)}`);
  }
  const compare = `
    <path d="${pts2.join(' ')}" fill="none" stroke="#f59e0b" stroke-width="2.5" stroke-dasharray="7 5" data-pen="1" data-pen-color="#f59e0b" />
    ${placer.pill(mapX(12.2), mapY(0.51) + 28, L.compare || 'Menor carga F_z / menor μ', 'amber')}
  `;

  return { base, curve, compare };
}

function layersFrictionCircle(spec = {}, prefix = 'bp') {
  const L = spec.labels || {};
  const placer = createPlacer();
  const cx = 480;
  const cy = 280;
  const r = 132;

  const base = `
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="rgba(56, 189, 248, 0.07)" stroke="#38bdf8" stroke-width="2.6" data-pen="1" data-pen-color="#38bdf8" />
    <circle cx="${cx}" cy="${cy}" r="${(r * 0.5).toFixed(1)}" fill="none" stroke="rgba(148,163,184,0.16)" stroke-dasharray="4 4" />
    <line x1="${cx - r - 64}" y1="${cy}" x2="${cx + r + 64}" y2="${cy}" stroke="#cbd5e1" stroke-width="1.7" marker-end="url(#${prefix}-arr-slate)" />
    <line x1="${cx}" y1="${cy + r + 52}" x2="${cx}" y2="${cy - r - 52}" stroke="#cbd5e1" stroke-width="1.7" marker-end="url(#${prefix}-arr-slate)" />
    <text x="${cx + r + 72}" y="${cy + 4}" fill="#cbd5e1" font-size="12.5" font-weight="650">${svgMath(L.xLabel || '+F_y (Lateral)')}</text>
    <text x="${cx}" y="${cy - r - 60}" text-anchor="middle" fill="#cbd5e1" font-size="12.5" font-weight="650">${svgMath(L.yLabel || '+F_x (Tracción)')}</text>
    <text x="${cx}" y="${cy + r + 68}" text-anchor="middle" fill="#94a3b8" font-size="12" font-weight="600">${svgMath('−F_x (Frenada)')}</text>
    ${placer.pill(cx - r - 28, cy - r + 18, L.limit || 'Límite: μ · F_z', 'cyan', { anchor: 'end' })}
  `;

  const ang = (42 * Math.PI) / 180;
  const vx = cx + Math.cos(ang) * r;
  const vy = cy + Math.sin(ang) * r;
  const vectors = `
    <line x1="${vx.toFixed(1)}" y1="${cy}" x2="${vx.toFixed(1)}" y2="${vy.toFixed(1)}" stroke="#f59e0b" stroke-width="1.4" stroke-dasharray="5 4" opacity="0.65" />
    <line x1="${cx}" y1="${vy.toFixed(1)}" x2="${vx.toFixed(1)}" y2="${vy.toFixed(1)}" stroke="#10b981" stroke-width="1.4" stroke-dasharray="5 4" opacity="0.65" />
    ${vecArrow(placer, cx, cy, vx, cy, 'F_y', 'emerald', { prefix, labelDy: -18 })}
    ${vecArrow(placer, cx, cy, cx, vy, 'F_x', 'amber', { prefix, labelDx: -24, anchor: 'end' })}
    ${vecArrow(placer, cx, cy, vx, vy, L.resultant || 'F_total (combinada)', 'rose', { prefix, labelDx: 64, labelDy: 34, anchor: 'start' })}
  `;

  const compare = `
    <circle cx="${cx}" cy="${cy}" r="${r + 32}" fill="none" stroke="#10b981" stroke-width="2" stroke-dasharray="8 5" data-pen="1" data-pen-color="#10b981" />
    ${placer.pill(cx + r + 42, cy - r + 10, L.compare || 'Con carga aero (+F_z)', 'emerald', { anchor: 'start' })}
  `;

  return { base, vectors, compare };
}

function layersInertiaBody(spec = {}, prefix = 'bp') {
  const mode = String(spec.mode || 'steiner').toLowerCase(); // steiner | car_axes
  const L = spec.labels || {};
  const placer = createPlacer();

  if (mode === 'car_axes') {
    const cx = 480;
    const cy = 286;
    // Clean isometric schematic rectangular chassis prism
    const base = `
      <polygon points="355,274 515,232 615,264 455,306" fill="url(#${prefix}-car-cyan)" stroke="#38bdf8" stroke-width="2.1" data-pen="1" data-pen-color="#38bdf8" />
      <polygon points="355,274 455,306 455,340 355,308" fill="rgba(56,189,248,0.10)" stroke="#38bdf8" stroke-width="1.8" />
      <polygon points="455,306 615,264 615,298 455,340" fill="rgba(15,34,52,0.55)" stroke="#38bdf8" stroke-width="1.8" />
      ${cgCrosshair(placer, cx, cy, 'CG', 'amber', 10, { labelDx: -16, labelDy: -16, anchor: 'end' })}
    `;
    const axes = `
      ${vecArrow(placer, cx, cy, cx + 220, cy - 58, 'Eje X · Balanceo (I_xx)', 'cyan', { prefix, labelDx: 18, labelDy: -16, anchor: 'start' })}
      ${vecArrow(placer, cx, cy, cx - 196, cy + 62, 'Eje Y · Cabeceo (I_yy)', 'emerald', { prefix, labelDx: -18, labelDy: 22, anchor: 'end' })}
      ${vecArrow(placer, cx, cy, cx, cy - 178, 'Eje Z · Guiñada (I_zz)', 'rose', { prefix, labelDx: 16, labelDy: -12, anchor: 'start' })}
    `;
    const moment = momentArc(placer, cx, cy - 120, 30, 'ccw', 'Yaw (I_zz)', 'rose', prefix, -16);
    return { base, axes, moment };
  }

  // Steiner Parallel-Axis Theorem — crisp schematic block + parallel axes + perpendicular arm d_perp
  const gx = 616;
  const gy = 266;
  const axisX = 286;

  const base = `
    <rect x="${gx - 96}" y="${gy - 66}" width="192" height="132" rx="18" fill="url(#${prefix}-car-cyan)" stroke="#38bdf8" stroke-width="2.3" data-pen="1" data-pen-color="#38bdf8" />
    ${cgCrosshair(placer, gx, gy, L.G || 'G (CG pieza)', 'amber', 11, { labelDx: 16, labelDy: -16, anchor: 'start' })}
    <line x1="${gx}" y1="118" x2="${gx}" y2="418" stroke="#38bdf8" stroke-width="1.7" stroke-dasharray="6 5" opacity="0.7" />
    ${placer.pill(gx, 96, L.localAxis || 'Eje local paralelo (I_local)', 'cyan')}
  `;

  const axes = `
    <line x1="${axisX}" y1="98" x2="${axisX}" y2="432" stroke="#f43f5e" stroke-width="3" stroke-linecap="round" data-pen="1" data-pen-color="#f43f5e" />
    ${placer.pill(axisX, 76, L.globalAxis || 'Eje global de giro û_giro', 'rose')}
    ${momentArc(placer, axisX, 162, 28, 'ccw', L.omega || 'ω', 'rose', prefix, -14)}
  `;

  const dimensions = `
    ${dimLine(placer, axisX, gy, gx, gy, 118, L.d || 'd_⊥ (distancia perpendicular)', 'amber', prefix)}
    <rect x="${axisX}" y="${gy - 14}" width="14" height="14" fill="none" stroke="#f59e0b" stroke-width="1.8" />
  `;

  const callout = placer.pill(480, 488, L.takeaway || 'La coordenada paralela a û_giro NUNCA entra en d_⊥', 'emerald');
  return { base, axes, dimensions, callout };
}

// Universal Bulletproof Engineering X-Y Plotter (NEVER EMPTY, NEVER CLIPPED, CLEAN LEGEND BOX!)
function layersXyGraph(spec = {}, prefix = 'bp') {
  const L = spec.labels || {};
  const placer = createPlacer();
  const ax = {
    x: 112,
    y: 78,
    w: 724,
    h: 360,
    xMin: Number.isFinite(Number(spec.xMin)) ? Number(spec.xMin) : 0,
    xMax: Number.isFinite(Number(spec.xMax)) ? Number(spec.xMax) : 10,
    yMin: Number.isFinite(Number(spec.yMin)) ? Number(spec.yMin) : 0,
    yMax: Number.isFinite(Number(spec.yMax)) ? Number(spec.yMax) : 10,
  };
  if (ax.xMax <= ax.xMin) ax.xMax = ax.xMin + 10;
  if (ax.yMax <= ax.yMin) ax.yMax = ax.yMin + 10;

  // Prepare curve definitions — if none provided, synthesize a clean default curve from mode so a graph is NEVER empty!
  let rawCurves = Array.isArray(spec.curves) ? spec.curves.filter((c) => c && typeof c === 'object') : [];
  if (!rawCurves.length) {
    const modeLow = String(spec.mode || '').toLowerCase();
    const fallbackShape = /inv|hiper|trac|pot/i.test(modeLow)
      ? 'inverse'
      : /lin/i.test(modeLow)
        ? 'linear'
        : /concav|sat/i.test(modeLow)
          ? 'concave'
          : /peak|pico/i.test(modeLow)
            ? 'peak'
            : 'quadratic';
    rawCurves = [{ shape: fallbackShape, color: 'cyan', label: L.curve1 || spec.yLabel || 'Curva principal' }];
  }

  // Evaluate each curve into world (vx, vy) samples first so we can auto-rescale Y if an expr is off-scale!
  const evaluated = rawCurves.slice(0, 4).map((c, idx) => {
    const col = PAL[String(c.color || '').toLowerCase()] ? String(c.color).toLowerCase() : ['cyan', 'amber', 'rose', 'emerald'][idx % 4];
    const samples = [];

    if (Array.isArray(c.points) && c.points.length >= 2) {
      for (const pt of c.points) {
        const vx = Array.isArray(pt) ? Number(pt[0]) : Number(pt?.x);
        const vy = Array.isArray(pt) ? Number(pt[1]) : Number(pt?.y);
        if (Number.isFinite(vx) && Number.isFinite(vy)) samples.push([vx, vy]);
      }
    }

    if (samples.length < 2 && c.shape) {
      const qfn = buildQualitativeCurveFn(c.shape, { scale: c.scale, offset: c.offset, yLevel: c.yLevel });
      if (qfn) {
        for (let i = 0; i <= 120; i++) {
          const u = i / 120;
          const vx = ax.xMin + u * (ax.xMax - ax.xMin);
          const vy = ax.yMin + qfn(u) * (ax.yMax - ax.yMin);
          if (Number.isFinite(vy)) samples.push([vx, vy]);
        }
      }
    }

    if (samples.length < 2 && c.expr) {
      const fn = evalSafeExpr(c.expr);
      if (fn) {
        for (let i = 0; i <= 140; i++) {
          const vx = ax.xMin + (i / 140) * (ax.xMax - ax.xMin);
          const vy = fn(vx);
          if (Number.isFinite(vy) && Math.abs(vy) < 1e9) samples.push([vx, vy]);
        }
      }
    }

    // Ultimate safety net: infer qualitative shape from expr/label text if expr still failed!
    if (samples.length < 2) {
      const hint = `${c.expr || ''} ${c.label || ''}`.toLowerCase();
      const autoShape = /\/|inv|p\s*\/\s*v|trac/.test(hint)
        ? 'inverse'
        : /\^3|³|cub|pot/.test(hint)
          ? 'cubic'
          : /\^2|²|quad|aero|drag/.test(hint)
            ? 'quadratic'
            : /const|rod|roll/.test(hint)
              ? 'constant'
              : 'linear';
      const qfn = buildQualitativeCurveFn(autoShape, { scale: 0.82 - idx * 0.14 });
      for (let i = 0; i <= 120; i++) {
        const u = i / 120;
        samples.push([ax.xMin + u * (ax.xMax - ax.xMin), ax.yMin + qfn(u) * (ax.yMax - ax.yMin)]);
      }
    }

    return { ...c, color: col, samples };
  });

  // Auto-scale Y range if curves are wildly outside [yMin, yMax] or crushed tiny (<8% of axis height)
  const allYs = evaluated.flatMap((c) => c.samples.map((p) => p[1])).filter(Number.isFinite);
  if (allYs.length) {
    const sortedY = [...allYs].sort((a, b) => a - b);
    const p05 = sortedY[Math.floor(sortedY.length * 0.05)];
    const p95 = sortedY[Math.floor(sortedY.length * 0.95)];
    const span = ax.yMax - ax.yMin;
    const clippedHigh = allYs.filter((y) => y > ax.yMax * 1.05).length / allYs.length;
    const tinyCurve = ax.yMin === 0 && p95 > 0 && p95 < ax.yMax * 0.08;
    if ((clippedHigh > 0.55 || tinyCurve) && p95 > p05) {
      ax.yMin = p05 >= 0 ? 0 : p05 * 1.1;
      ax.yMax = p95 * 1.18;
    } else if (span <= 0) {
      ax.yMin = 0;
      ax.yMax = Math.max(10, p95 * 1.2);
    }
  }

  const mapX = (vx) => ax.x + ((vx - ax.xMin) / (ax.xMax - ax.xMin || 1)) * ax.w;
  const mapY = (vy) => ax.y + ax.h - ((vy - ax.yMin) / (ax.yMax - ax.yMin || 1)) * ax.h;
  const yZero = ax.yMin <= 0 && ax.yMax >= 0 ? mapY(0) : ax.y + ax.h;
  const xZero = ax.xMin <= 0 && ax.xMax >= 0 ? mapX(0) : ax.x;

  let ticks = '';
  for (let i = 0; i <= 5; i++) {
    const v = ax.xMin + (i / 5) * (ax.xMax - ax.xMin);
    const px = mapX(v);
    ticks += `<line x1="${px.toFixed(1)}" y1="${ax.y}" x2="${px.toFixed(1)}" y2="${ax.y + ax.h}" stroke="rgba(148,163,184,0.12)" />`;
    ticks += `<text x="${px.toFixed(1)}" y="${ax.y + ax.h + 18}" text-anchor="middle" fill="#94a3b8" font-size="11" font-family="ui-monospace, monospace">${fmtTickVal(v)}</text>`;
  }
  for (let i = 0; i <= 4; i++) {
    const v = ax.yMin + (i / 4) * (ax.yMax - ax.yMin);
    const py = mapY(v);
    ticks += `<line x1="${ax.x}" y1="${py.toFixed(1)}" x2="${ax.x + ax.w}" y2="${py.toFixed(1)}" stroke="rgba(148,163,184,0.12)" />`;
    ticks += `<text x="${ax.x - 10}" y="${(py + 4).toFixed(1)}" text-anchor="end" fill="#94a3b8" font-size="11" font-family="ui-monospace, monospace">${fmtTickVal(v)}</text>`;
  }

  const base = `
    <rect x="${ax.x}" y="${ax.y}" width="${ax.w}" height="${ax.h}" rx="6" fill="rgba(11,15,23,0.45)" stroke="rgba(148,163,184,0.22)" />
    ${ticks}
    <line x1="${ax.x}" y1="${yZero.toFixed(1)}" x2="${ax.x + ax.w + 16}" y2="${yZero.toFixed(1)}" stroke="#cbd5e1" stroke-width="2" marker-end="url(#${prefix}-arr-slate)" />
    <line x1="${xZero.toFixed(1)}" y1="${ax.y + ax.h}" x2="${xZero.toFixed(1)}" y2="${ax.y - 16}" stroke="#cbd5e1" stroke-width="2" marker-end="url(#${prefix}-arr-slate)" />
    <text x="${ax.x + ax.w / 2}" y="${ax.y + ax.h + 42}" text-anchor="middle" fill="#e2e8f0" font-size="13" font-weight="650">${svgMath(spec.xLabel || L.xLabel || 'x')}</text>
    <text x="${ax.x}" y="${ax.y - 22}" text-anchor="start" fill="#e2e8f0" font-size="13" font-weight="650">${svgMath(spec.yLabel || L.yLabel || 'y')}</text>
  `;

  const renderCurvePath = (c) => {
    const p = palOf(c.color);
    const segs = [];
    let drawing = false;
    for (const [vx, vy] of c.samples) {
      if (vy < ax.yMin - (ax.yMax - ax.yMin) * 0.04 || vy > ax.yMax + (ax.yMax - ax.yMin) * 0.04) {
        drawing = false;
        continue;
      }
      const cy = Math.max(ax.yMin, Math.min(ax.yMax, vy));
      segs.push(`${drawing ? 'L' : 'M'} ${mapX(vx).toFixed(1)} ${mapY(cy).toFixed(1)}`);
      drawing = true;
    }
    if (segs.length < 2) return '';
    return `<path d="${segs.join(' ')}" fill="none" stroke="${p.stroke}" stroke-width="3.1" stroke-linecap="round"${c.dashed ? ' stroke-dasharray="7 5"' : ''} filter="url(#${prefix}-glow)" data-pen="1" data-pen-color="${p.stroke}" />`;
  };

  // Place clean Legend Box in top-left (keeps clear of rising curves on the right!)
  const leg1 = evaluated[0]?.label ? legendBox(ax.x + 14, ax.y + 12, [evaluated[0]]) : '';
  const legAll = evaluated.some((c) => c.label) ? legendBox(ax.x + 14, ax.y + 12, evaluated) : '';

  const curve1 = evaluated[0] ? `${renderCurvePath(evaluated[0])}${leg1}` : '';
  const extraPaths = evaluated.slice(1).map(renderCurvePath).join('');
  const curve2 = extraPaths ? `${extraPaths}${legAll}` : '';

  return { base, curve1, curve2 };
}

function layersComparison(spec = {}, prefix = 'bp') {
  const left = spec.left || { title: 'Vehículo de calle', color: 'amber', points: ['Confort prioritario', 'Compromisos geométricos'] };
  const right = spec.right || { title: 'Vehículo de competición', color: 'emerald', points: ['Rendimiento y control puro', 'Minimizar ΔF_z en ruedas'] };
  const lCol = PAL[String(left.color || '').toLowerCase()] ? String(left.color).toLowerCase() : 'amber';
  const rCol = PAL[String(right.color || '').toLowerCase()] ? String(right.color).toLowerCase() : 'emerald';
  const lp = palOf(lCol);
  const rp = palOf(rCol);
  const placer = createPlacer();

  const renderCard = (x, data, col, p) => {
    const pts = (Array.isArray(data.points) ? data.points : []).slice(0, 4);
    const items = pts
      .map((pt, i) => {
        const lines = wrapLines(pt, 34);
        const y0 = 152 + i * 74;
        return `
          <g>
            <circle cx="${x + 26}" cy="${y0}" r="4.5" fill="${p.stroke}" />
            ${lines.map((ln, li) => `<text x="${x + 42}" y="${y0 + 5 + li * 19}" fill="#e2e8f0" font-size="13.5" font-family="-apple-system, sans-serif">${esc(ln)}</text>`).join('')}
          </g>
        `;
      })
      .join('');
    return `
      <g>
        <rect x="${x}" y="74" width="396" height="364" rx="12" fill="url(#${prefix}-car-${col === 'slate' ? 'cyan' : col})" stroke="${p.stroke}" stroke-width="2" data-pen="1" data-pen-color="${p.stroke}" />
        <line x1="${x + 16}" y1="76" x2="${x + 380}" y2="76" stroke="${p.stroke}" stroke-width="3.2" stroke-linecap="round" />
        <text x="${x + 22}" y="114" fill="${p.text}" font-size="17" font-weight="700" font-family="-apple-system, sans-serif">${esc(data.title || '')}</text>
        <line x1="${x + 20}" y1="128" x2="${x + 376}" y2="128" stroke="${p.stroke}" stroke-width="1" opacity="0.28" />
        ${items}
      </g>
    `;
  };

  const leftLayer = renderCard(56, left, lCol, lp);
  const rightLayer = `
    ${renderCard(508, right, rCol, rp)}
    <path d="M 458 256 L 502 256" stroke="#38bdf8" stroke-width="2.6" marker-end="url(#${prefix}-arr-cyan)" data-pen="1" data-pen-color="#38bdf8" />
  `;
  const takeaway = spec.takeaway ? placer.pill(480, 484, spec.takeaway, 'cyan', { fontSize: 12.5, maxLen: 64 }) : '';
  return { left: leftLayer, right: rightLayer, takeaway };
}

export const BLUEPRINT_TEMPLATES = {
  car_side: { fn: layersCarSide, defaultOrder: ['base', 'dimensions', 'cg', 'loads', 'forces', 'moment'] },
  car_top: { fn: layersCarTop, defaultOrder: ['base', 'dimensions', 'cg', 'forces', 'moment'] },
  car_front: { fn: layersCarFront, defaultOrder: ['base', 'dimensions', 'cg', 'loads', 'forces', 'moment'] },
  quarter_car: { fn: layersQuarterCar, defaultOrder: ['base', 'suspension', 'dimensions', 'forces'] },
  force_balance: { fn: layersForceBalance, defaultOrder: ['base', 'forces', 'result'] },
  power_balance: { fn: layersPowerBalance, defaultOrder: ['base', 'resistances', 'traction', 'vmax'] },
  tire_load_curve: { fn: layersTireLoadCurve, defaultOrder: ['base', 'curve', 'transfer'] },
  tire_slip_curve: { fn: layersTireSlipCurve, defaultOrder: ['base', 'curve', 'compare'] },
  friction_circle: { fn: layersFrictionCircle, defaultOrder: ['base', 'vectors', 'compare'] },
  inertia_body: { fn: layersInertiaBody, defaultOrder: ['base', 'axes', 'dimensions', 'callout', 'moment'] },
  xy_graph: { fn: layersXyGraph, defaultOrder: ['base', 'curve1', 'curve2'] },
  comparison: { fn: layersComparison, defaultOrder: ['left', 'right', 'takeaway'] },
};

export function normalizeTemplateLayers(templateName, requestedLayers, spec = {}) {
  const key = String(templateName || '').toLowerCase();
  const entry = BLUEPRINT_TEMPLATES[key];
  if (!entry) return [];
  const raw = Array.isArray(requestedLayers) ? requestedLayers : [];
  const clean = raw
    .map((l) => String(l || '').toLowerCase().trim())
    .filter((l) => entry.defaultOrder.includes(l));
  const out = clean.length ? [...new Set(clean)] : entry.defaultOrder.slice(0, 2);
  if (entry.defaultOrder[0] === 'base' && !out.includes('base')) {
    out.unshift('base');
  }
  // Never leave a graph blank on Beat 0 when curves were already supplied!
  if (key === 'xy_graph' && out.length === 1 && out[0] === 'base') {
    out.push('curve1');
    if (Array.isArray(spec?.curves) && spec.curves.length > 1) out.push('curve2');
  }
  if (key === 'power_balance' && out.length === 1 && out[0] === 'base') {
    out.push('resistances');
  }
  return out;
}

export function renderBlueprintLayersMarkup(templateName, spec = {}, layerNames = [], { prefix = 'bp', markNew = false } = {}) {
  const entry = BLUEPRINT_TEMPLATES[String(templateName || '').toLowerCase()];
  if (!entry) return '';
  const allLayers = entry.fn(spec, prefix);
  const ordered = entry.defaultOrder.filter((k) => layerNames.includes(k));
  return ordered
    .map((k) => {
      const content = allLayers[k];
      if (!content) return '';
      return `<g data-layer="${k}"${markNew ? ' data-new="1"' : ''}>${content}</g>`;
    })
    .join('\n');
}

export function buildParametricBlueprintSvg(title, templateName, spec = {}, activeLayers = [], { prefix = 'bp' } = {}) {
  const layers = normalizeTemplateLayers(templateName, activeLayers, spec);
  const body = renderBlueprintLayersMarkup(templateName, spec, layers, { prefix, markNew: false });
  if (!body) return '';
  return `
    <svg viewBox="0 0 960 540" xmlns="http://www.w3.org/2000/svg" class="precision-svg blueprint-svg" data-template="${esc(templateName)}">
      ${buildBlueprintTemplateDefs(prefix)}
      <rect x="0" y="0" width="960" height="540" fill="url(#${prefix}-grid)" />
      ${title ? `<text x="28" y="34" fill="#e2e8f0" font-size="16" font-weight="650" letter-spacing="-0.01em" font-family="-apple-system, BlinkMacSystemFont, 'SF Pro Display', sans-serif">${svgMath(title)}</text>` : ''}
      <g class="primitives-layer">${body}</g>
    </svg>
  `;
}
