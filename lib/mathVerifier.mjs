import { execFile } from 'node:child_process';
import { resolvePythonInvocation } from './platformTools.mjs';

const RUNNER_PY = `
import ast, cmath, contextlib, fractions, io, json, math, statistics, sys

try:
    import resource
    resource.setrlimit(resource.RLIMIT_CPU, (2, 2))
except Exception:
    pass

ALLOWED_NODES = (
    ast.Module, ast.Expr, ast.Assign, ast.AugAssign,
    ast.BinOp, ast.UnaryOp, ast.BoolOp, ast.Compare, ast.IfExp,
    ast.Call, ast.Name, ast.Constant, ast.List, ast.Tuple, ast.Dict, ast.Set,
    ast.Subscript, ast.Slice, ast.For, ast.If,
    ast.ListComp, ast.SetComp, ast.DictComp, ast.GeneratorExp, ast.comprehension,
    ast.Attribute, ast.Load, ast.Store, ast.keyword,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv, ast.Mod, ast.Pow,
    ast.UAdd, ast.USub, ast.Not, ast.And, ast.Or,
    ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE, ast.In, ast.NotIn,
    ast.JoinedStr, ast.FormattedValue,
)

SAFE_MODULES = {"math", "cmath", "statistics"}
SAFE_METHODS = {
    "append", "extend", "copy", "keys", "values", "items", "get",
    "real", "imag", "conjugate", "numerator", "denominator",
    "limit_denominator", "as_integer_ratio",
}

def validate_ast(tree):
    node_count = 0
    for node in ast.walk(tree):
        node_count += 1
        if node_count > 600:
            raise ValueError("Expression too complex (max 600 AST nodes)")
        if not isinstance(node, ALLOWED_NODES):
            raise ValueError(f"Disallowed Python syntax: {type(node).__name__}")
        if isinstance(node, ast.Name):
            if node.id.startswith("_") or node.id.endswith("_"):
                raise ValueError(f"Disallowed identifier: {node.id}")
        if isinstance(node, ast.Attribute):
            if node.attr.startswith("_") or node.attr.endswith("_"):
                raise ValueError(f"Disallowed attribute access: {node.attr}")
            is_safe_mod = isinstance(node.value, ast.Name) and node.value.id in SAFE_MODULES
            if not is_safe_mod and node.attr not in SAFE_METHODS:
                raise ValueError(f"Disallowed attribute: .{node.attr}")
        if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Pow):
            if isinstance(node.right, ast.Constant) and isinstance(node.right.value, (int, float)):
                if abs(node.right.value) > 10000:
                    raise ValueError("Exponent too large (max 10000)")
        if isinstance(node, ast.Call):
            if isinstance(node.func, ast.Name) and node.func.id == "pow" and len(node.args) >= 2:
                exp_arg = node.args[1]
                if isinstance(exp_arg, ast.Constant) and isinstance(exp_arg.value, (int, float)) and abs(exp_arg.value) > 10000:
                    raise ValueError("Exponent too large (max 10000)")
            if isinstance(node.func, ast.Name) and node.func.id == "range":
                for arg in node.args:
                    if isinstance(arg, ast.Constant) and isinstance(arg.value, int) and abs(arg.value) > 100000:
                        raise ValueError("Range too large (max 100000)")

code = sys.stdin.read()

def safe_pow(base, exp, mod=None):
    if isinstance(exp, (int, float)) and abs(exp) > 10000:
        raise ValueError("Exponent too large (max 10000)")
    return pow(base, exp) if mod is None else pow(base, exp, mod)

safe_builtins = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict,
    "enumerate": enumerate, "float": float, "int": int, "len": len,
    "list": list, "max": max, "min": min, "pow": safe_pow, "range": range,
    "round": round, "set": set, "sorted": sorted, "str": str, "sum": sum,
    "tuple": tuple, "zip": zip, "print": print,
}
ns = {
    "__builtins__": safe_builtins,
    "math": math,
    "cmath": cmath,
    "statistics": statistics,
    "Fraction": fractions.Fraction,
    "pi": math.pi,
    "e": math.e,
    "sqrt": math.sqrt,
    "sin": math.sin,
    "cos": math.cos,
    "tan": math.tan,
    "asin": math.asin,
    "acos": math.acos,
    "atan": math.atan,
    "atan2": math.atan2,
    "radians": math.radians,
    "degrees": math.degrees,
    "log": math.log,
    "log10": math.log10,
    "exp": math.exp,
}

buf = io.StringIO()
result = None
try:
    tree = ast.parse(code, mode="exec")
    validate_ast(tree)
    with contextlib.redirect_stdout(buf):
        if len(tree.body) == 1 and isinstance(tree.body[0], ast.Expr):
            expr_code = compile(ast.Expression(tree.body[0].value), "<math>", "eval")
            result = eval(expr_code, ns, ns)
        else:
            before_keys = set(ns.keys())
            exec_code = compile(tree, "<math>", "exec")
            exec(exec_code, ns, ns)
            if "result" in ns:
                result = ns["result"]
            else:
                new_vars = {
                    k: v for k, v in ns.items()
                    if k not in before_keys and not k.startswith("_")
                    and isinstance(v, (int, float, complex, str, bool, list, tuple))
                }
                if len(new_vars) == 1:
                    k, v = next(iter(new_vars.items()))
                    result = f"{k} = {round(v, 4) if isinstance(v, float) else v}"
                elif new_vars:
                    result = ", ".join(
                        f"{k}={round(v, 4) if isinstance(v, float) else v}"
                        for k, v in list(new_vars.items())[-4:]
                    )
    out = {
        "ok": True,
        "result": (
            result if isinstance(result, str)
            else (repr(round(result, 6)) if isinstance(result, float)
            else (repr(result) if result is not None else None))
        ),
        "stdout": buf.getvalue().strip()[:2000],
    }
except Exception as ex:
    out = {"ok": False, "error": f"{type(ex).__name__}: {ex}"}

print(json.dumps(out))
`;

/**
 * Pure-JS zero-eval scientific math fallback used automatically when Python 3 is not installed
 * (e.g. fresh Windows/macOS Desktop app installs). Supports multi-line variable assignments,
 * +, -, *, /, //, %, **, ^, parentheses, pi, e, sqrt, sin, cos, tan, asin, acos, atan, atan2,
 * radians, degrees, log, log10, exp, abs, round, min, max, pow.
 */
export function verifyMathJsFallback(expressionOrCode) {
  const raw = String(expressionOrCode || '').trim();
  if (!raw) return { ok: false, error: 'Empty expression' };

  const blockedRe = /\b(import|from|open|exec|eval|compile|__[a-z]+__|os|sys|subprocess|class|def|lambda)\b/i;
  if (blockedRe.test(raw)) {
    return { ok: false, error: 'Disallowed syntax in math expression' };
  }

  const FUNCS = {
    sqrt: Math.sqrt,
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    atan2: Math.atan2,
    radians: (d) => (d * Math.PI) / 180,
    degrees: (r) => (r * 180) / Math.PI,
    log: (x, b) => (b == null ? Math.log(x) : Math.log(x) / Math.log(b)),
    log10: Math.log10,
    exp: Math.exp,
    abs: Math.abs,
    round: (x, n = 0) => {
      const f = Math.pow(10, Math.min(12, Math.max(0, Number(n) || 0)));
      return Math.round(x * f) / f;
    },
    min: Math.min,
    max: Math.max,
    pow: (a, b) => {
      if (Math.abs(b) > 10000) throw new Error('Exponent too large (max 10000)');
      return Math.pow(a, b);
    },
  };

  const vars = { pi: Math.PI, e: Math.E };
  const userVars = [];

  const tokenize = (expr) => {
    const tokens = [];
    let i = 0;
    while (i < expr.length) {
      const ch = expr[i];
      if (/\s/.test(ch)) { i++; continue; }
      if (/[0-9.]/.test(ch)) {
        let num = '';
        while (i < expr.length && /[0-9.eE]/.test(expr[i])) {
          if ((expr[i] === 'e' || expr[i] === 'E') && (expr[i + 1] === '+' || expr[i + 1] === '-')) {
            num += expr[i] + expr[i + 1];
            i += 2;
            continue;
          }
          num += expr[i++];
        }
        const v = Number(num);
        if (!Number.isFinite(v)) throw new Error(`Invalid number: ${num}`);
        tokens.push({ t: 'num', v });
        continue;
      }
      if (/[A-Za-z_]/.test(ch)) {
        let id = '';
        while (i < expr.length && /[A-Za-z0-9_.]/.test(expr[i])) id += expr[i++];
        if (id.startsWith('_') || id.endsWith('_') || id.includes('__')) {
          throw new Error(`Disallowed identifier: ${id}`);
        }
        // Strip optional `math.` prefix
        const cleanId = id.startsWith('math.') ? id.slice(5) : id;
        tokens.push({ t: 'id', v: cleanId });
        continue;
      }
      if (expr.slice(i, i + 2) === '**' || expr.slice(i, i + 2) === '//') {
        tokens.push({ t: 'op', v: expr.slice(i, i + 2) });
        i += 2;
        continue;
      }
      if ('+-*/%^(),'.includes(ch)) {
        tokens.push({ t: ch === '(' || ch === ')' || ch === ',' ? ch : 'op', v: ch });
        i++;
        continue;
      }
      throw new Error(`Unsupported token: ${ch}`);
    }
    return tokens;
  };

  const evalExpr = (expr) => {
    const toks = tokenize(expr);
    let pos = 0;
    const peek = () => toks[pos];
    const next = () => toks[pos++];

    const parseAdd = () => {
      let left = parseMul();
      while (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
        const op = next().v;
        const right = parseMul();
        left = op === '+' ? left + right : left - right;
      }
      return left;
    };
    const parseMul = () => {
      let left = parsePow();
      while (peek()?.t === 'op' && ['*', '/', '//', '%'].includes(peek().v)) {
        const op = next().v;
        const right = parsePow();
        if (op === '*') left *= right;
        else if (op === '/') left /= right;
        else if (op === '//') left = Math.floor(left / right);
        else left %= right;
      }
      return left;
    };
    const parsePow = () => {
      let base = parseUnary();
      if (peek()?.t === 'op' && (peek().v === '**' || peek().v === '^')) {
        next();
        const exp = parsePow();
        if (Math.abs(exp) > 10000) throw new Error('Exponent too large (max 10000)');
        base = Math.pow(base, exp);
      }
      return base;
    };
    const parseUnary = () => {
      if (peek()?.t === 'op' && (peek().v === '+' || peek().v === '-')) {
        const op = next().v;
        return op === '-' ? -parseUnary() : parseUnary();
      }
      return parsePrimary();
    };
    const parsePrimary = () => {
      const tk = peek();
      if (!tk) throw new Error('Unexpected end of expression');
      if (tk.t === 'num') { next(); return tk.v; }
      if (tk.t === '(') {
        next();
        const val = parseAdd();
        if (next()?.t !== ')') throw new Error('Missing closing parenthesis');
        return val;
      }
      if (tk.t === 'id') {
        next();
        if (peek()?.t === '(') {
          const fn = FUNCS[tk.v];
          if (!fn) throw new Error(`Unknown function: ${tk.v}`);
          next();
          const args = [];
          if (peek()?.t !== ')') {
            args.push(parseAdd());
            while (peek()?.t === ',') {
              next();
              args.push(parseAdd());
            }
          }
          if (next()?.t !== ')') throw new Error(`Missing ')' in call to ${tk.v}`);
          return fn(...args);
        }
        if (Object.prototype.hasOwnProperty.call(vars, tk.v)) return vars[tk.v];
        throw new Error(`Undefined variable: ${tk.v}`);
      }
      throw new Error(`Unexpected token: ${tk.v}`);
    };

    const val = parseAdd();
    if (pos < toks.length) throw new Error(`Unexpected trailing token: ${toks[pos].v}`);
    if (!Number.isFinite(val)) throw new Error('Result is not a finite number');
    return val;
  };

  try {
    const lines = raw
      .split(/\r?\n|;/)
      .map((l) => l.replace(/#.*$/, '').trim())
      .filter(Boolean);
    let lastVal = null;
    for (const line of lines) {
      const assign = line.match(/^([A-Za-z][A-Za-z0-9_]*)\s*=\s*(.+)$/);
      if (assign) {
        const [, name, rhs] = assign;
        if (name.startsWith('_') || name.endsWith('_')) throw new Error(`Disallowed identifier: ${name}`);
        const v = evalExpr(rhs);
        vars[name] = v;
        if (!userVars.includes(name)) userVars.push(name);
        lastVal = v;
      } else {
        const printMatch = line.match(/^print\s*\((.+)\)$/);
        lastVal = evalExpr(printMatch ? printMatch[1] : line);
      }
    }
    const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Number(n.toFixed(6))));
    let resultStr = lastVal !== null ? fmt(lastVal) : null;
    if (Object.prototype.hasOwnProperty.call(vars, 'result')) {
      resultStr = fmt(vars.result);
    } else if (userVars.length === 1) {
      resultStr = `${userVars[0]} = ${fmt(vars[userVars[0]])}`;
    } else if (userVars.length > 1) {
      resultStr = userVars.slice(-4).map((k) => `${k}=${fmt(vars[k])}`).join(', ');
    }
    return { ok: true, result: resultStr, stdout: '', engine: 'js-fallback' };
  } catch (err) {
    return { ok: false, error: err.message || 'Math evaluation error', engine: 'js-fallback' };
  }
}

export async function verifyMathPython(expressionOrCode) {
  const code = String(expressionOrCode || '').trim();
  if (!code) {
    return { ok: false, error: 'Empty expression' };
  }
  if (code.length > 4000) {
    return { ok: false, error: 'Code snippet too long (max 4000 chars)' };
  }

  try {
    const py = await resolvePythonInvocation();
    const child = execFile(py.bin, [...py.prefixArgs, '-I', '-S', '-c', RUNNER_PY], {
      timeout: 3000,
      maxBuffer: 1024 * 1024,
      windowsHide: true,
    });

    const output = await new Promise((resolve, reject) => {
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d));
      child.stderr.on('data', (d) => (stderr += d));
      child.on('error', reject);
      child.on('close', () => resolve({ stdout, stderr }));
      child.stdin.write(code);
      child.stdin.end();
    });

    if (!output.stdout.trim()) {
      return verifyMathJsFallback(code);
    }
    return JSON.parse(output.stdout.trim());
  } catch (err) {
    // Seamless zero-Python fallback for packaged Windows/Mac Desktop apps without Python installed!
    if (err?.code === 'ENOENT' || /not found|ENOENT/i.test(err?.message || '')) {
      return verifyMathJsFallback(code);
    }
    return { ok: false, error: `Python verifier error: ${err.message}` };
  }
}
