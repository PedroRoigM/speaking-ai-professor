import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';

export const GITHUB_REPO = 'PedroRoigM/speaking-ai-professor';
const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export function parseSemver(raw) {
  const clean = String(raw || '')
    .trim()
    .replace(/^v/i, '')
    .split('-')[0];
  const parts = clean.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0];
}

export function compareSemver(a, b) {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function selectReleaseAsset(assets = [], { platform = process.platform, arch = process.arch, isPortable = false } = {}) {
  const list = Array.isArray(assets) ? assets : [];
  const findBy = (re) => list.find((a) => a && typeof a.name === 'string' && re.test(a.name) && a.browser_download_url);

  let picked = null;
  if (platform === 'win32') {
    picked = isPortable
      ? findBy(/windows.*portable.*\.exe$/i) || findBy(/windows.*setup.*\.exe$/i)
      : findBy(/windows.*setup.*\.exe$/i) || findBy(/\.exe$/i);
  } else if (platform === 'darwin') {
    picked =
      arch === 'arm64'
        ? findBy(/mac.*arm64.*\.dmg$/i) || findBy(/\.dmg$/i)
        : findBy(/mac.*x64.*\.dmg$/i) || findBy(/\.dmg$/i);
  } else if (platform === 'linux') {
    picked = findBy(/linux.*\.AppImage$/i) || findBy(/\.AppImage$/i);
  }

  if (!picked) return null;
  return {
    name: picked.name,
    url: picked.browser_download_url,
    size: Number(picked.size || 0),
  };
}

export async function checkLatestGithubRelease({
  currentVersion = '0.0.0',
  platform = process.platform,
  arch = process.arch,
  isPortable = Boolean(process.env.PORTABLE_EXECUTABLE_DIR),
  timeoutMs = 9000,
} = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(LATEST_RELEASE_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': `Speaking-AI-Professor/${currentVersion}`,
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      return { ok: false, error: `GitHub API HTTP ${res.status}`, hasUpdate: false };
    }
    const data = await res.json();
    const latestTag = String(data.tag_name || '').trim();
    const latestVersion = latestTag.replace(/^v/i, '');
    const hasUpdate = Boolean(latestVersion && compareSemver(latestVersion, currentVersion) > 0);
    const asset = selectReleaseAsset(data.assets, { platform, arch, isPortable });
    const rawNotes = String(data.body || '')
      .replace(/[#*_`]+/g, '')
      .replace(/\r?\n{2,}/g, '\n')
      .trim();

    return {
      ok: true,
      hasUpdate,
      currentVersion: String(currentVersion).replace(/^v/i, ''),
      latestVersion,
      latestTag: latestTag || `v${latestVersion}`,
      releaseUrl: data.html_url || `https://github.com/${GITHUB_REPO}/releases/latest`,
      releaseNotes: rawNotes.slice(0, 420),
      asset,
    };
  } catch (err) {
    return { ok: false, error: err.message || 'No se pudo consultar actualizaciones', hasUpdate: false };
  } finally {
    clearTimeout(timer);
  }
}

export async function downloadReleaseAsset(assetUrl, filename, onProgress) {
  const parsed = new URL(assetUrl);
  if (parsed.protocol !== 'https:' || !ALLOWED_DOWNLOAD_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error(`Dominio de descarga no permitido: ${parsed.hostname}`);
  }

  const safeName = path.basename(String(filename || 'update-installer')).replace(/[^a-zA-Z0-9._-]/g, '_');
  const destDir = path.join(os.tmpdir(), 'speaking-ai-professor-updates');
  await fs.mkdir(destDir, { recursive: true });
  const destPath = path.join(destDir, safeName);

  const res = await fetch(assetUrl, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`Error al descargar actualización (HTTP ${res.status})`);
  }

  const finalHost = new URL(res.url).hostname.toLowerCase();
  if (!ALLOWED_DOWNLOAD_HOSTS.has(finalHost)) {
    throw new Error(`Redirección a host no autorizado: ${finalHost}`);
  }

  const totalBytes = Number(res.headers.get('content-length') || 0);
  let downloaded = 0;
  let lastEmit = 0;

  const outStream = createWriteStream(destPath);
  const readable = Readable.fromWeb(res.body);

  await new Promise((resolve, reject) => {
    readable.on('data', (chunk) => {
      downloaded += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 250) {
        lastEmit = now;
        const pct = totalBytes > 0 ? Math.min(99, Math.round((downloaded / totalBytes) * 100)) : 50;
        onProgress?.({
          pct,
          downloadedMb: (downloaded / (1024 * 1024)).toFixed(1),
          totalMb: totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(1) : '?',
        });
      }
    });
    readable.on('error', reject);
    outStream.on('error', reject);
    outStream.on('finish', resolve);
    readable.pipe(outStream);
  });

  if (process.platform === 'linux' && safeName.endsWith('.AppImage')) {
    await fs.chmod(destPath, 0o755).catch(() => {});
  }

  onProgress?.({ pct: 100, downloadedMb: (downloaded / (1024 * 1024)).toFixed(1), totalMb: (downloaded / (1024 * 1024)).toFixed(1) });
  return destPath;
}
