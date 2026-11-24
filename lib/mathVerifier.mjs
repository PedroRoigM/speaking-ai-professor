import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const RUNNER_PY = `
import json, math, cmath, statistics, fractions, sys

code = sys.stdin.read()
safe_builtins = {
    "abs": abs, "all": all, "any": any, "bool": bool, "dict": dict,
    "enumerate": enumerate, "float": float, "int": int, "len": len,
    "list": list, "max": max, "min": min, "pow": pow, "range": range,
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

import io, contextlib
buf = io.StringIO()
result = None
try:
    with contextlib.redirect_stdout(buf):
        try:
            result = eval(code, ns, ns)
        except SyntaxError:
            before_keys = set(ns.keys())
            exec(code, ns, ns)
            if "result" in ns:
                result = ns["result"]
            else:
                new_vars = {k: v for k, v in ns.items() if k not in before_keys and not k.startswith("_") and isinstance(v, (int, float, complex, str, bool, list, tuple))}
                if len(new_vars) == 1:
                    k, v = next(iter(new_vars.items()))
                    result = f"{k} = {round(v, 4) if isinstance(v, float) else v}"
                elif new_vars:
                    result = ", ".join(f"{k}={round(v, 4) if isinstance(v, float) else v}" for k, v in list(new_vars.items())[-4:])
    out = {
        "ok": True,
        "result": result if isinstance(result, str) else (repr(round(result, 6)) if isinstance(result, float) else (repr(result) if result is not None else None)),
        "stdout": buf.getvalue().strip()[:2000],
    }
except Exception as ex:
    out = {"ok": False, "error": f"{type(ex).__name__}: {ex}"}

print(json.dumps(out))
`;

export async function verifyMathPython(expressionOrCode) {
  const code = String(expressionOrCode || '').trim();
  if (!code) {
    return { ok: false, error: 'Empty expression' };
  }
  if (code.length > 4000) {
    return { ok: false, error: 'Code snippet too long (max 4000 chars)' };
  }

  try {
    const child = execFile('python3', ['-I', '-c', RUNNER_PY], {
      timeout: 3000,
      maxBuffer: 1024 * 1024,
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

    const parsed = JSON.parse(output.stdout.trim() || '{}');
    return parsed;
  } catch (err) {
    return { ok: false, error: `Python verifier error: ${err.message}` };
  }
}
