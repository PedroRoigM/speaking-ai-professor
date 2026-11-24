import { execFile } from 'node:child_process';

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

export async function verifyMathPython(expressionOrCode) {
  const code = String(expressionOrCode || '').trim();
  if (!code) {
    return { ok: false, error: 'Empty expression' };
  }
  if (code.length > 4000) {
    return { ok: false, error: 'Code snippet too long (max 4000 chars)' };
  }

  try {
    const child = execFile('python3', ['-I', '-S', '-c', RUNNER_PY], {
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

    return JSON.parse(output.stdout.trim() || '{}');
  } catch (err) {
    return { ok: false, error: `Python verifier error: ${err.message}` };
  }
}
