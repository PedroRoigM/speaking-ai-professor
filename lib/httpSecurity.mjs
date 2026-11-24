import path from 'node:path';

export const SECURITY_HEADERS = Object.freeze({
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'SAMEORIGIN',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
});

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

const LOCAL_HOST_RE = /^(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;
const LOCAL_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d{1,5})?$/i;

/**
 * Blocks DNS rebinding by requiring the HTTP Host header to be a local loopback host.
 */
export function isAllowedLocalHost(hostHeader) {
  if (!hostHeader) return true; // HTTP/1.0 or internal probe
  return LOCAL_HOST_RE.test(String(hostHeader).trim());
}

/**
 * Blocks Cross-Site Request Forgery (CSRF) and Cross-Site WebSocket Hijacking (CSWSH):
 * when a browser sends an Origin header, it must strictly match loopback.
 */
export function isAllowedLocalOrigin(originHeader) {
  if (!originHeader) return true; // Non-browser local CLI/curl calls omit Origin
  return LOCAL_ORIGIN_RE.test(String(originHeader).trim());
}

/**
 * Resolves a request pathname safely inside `publicDir`, preventing both `../` traversal
 * and sibling-directory prefix bypasses (e.g. `/public_secret`).
 */
export function resolveStaticPath(publicDir, pathname) {
  const root = path.resolve(publicDir);
  let decoded = String(pathname || '/');
  try {
    decoded = decodeURIComponent(decoded);
  } catch {
    return null;
  }
  if (decoded.includes('\0')) return null;
  const relFile = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '');
  const candidate = path.resolve(root, relFile);
  const rel = path.relative(root, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return candidate;
}

export function readRequestBody(req, maxBytes = 35 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', (chunk) => {
      total += chunk.length;
      if (total > maxBytes) {
        reject(new HttpError(413, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export async function readJsonBody(req, maxBytes = 64 * 1024) {
  const buf = await readRequestBody(req, maxBytes);
  const raw = buf.toString('utf8').trim();
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new HttpError(400, 'Expected a JSON object body');
    }
    return parsed;
  } catch (err) {
    if (err instanceof HttpError) throw err;
    throw new HttpError(400, 'Invalid JSON request body');
  }
}

export function sendJson(res, status, data) {
  const payload = JSON.stringify(data);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}
