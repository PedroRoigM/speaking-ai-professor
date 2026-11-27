import fs from 'node:fs/promises';
import { createWriteStream, constants as fsConstants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';

const execFileAsync = promisify(execFile);
const UPDATER_STATE_PATH = path.join(os.homedir(), '.config', 'speaking-professor', 'updater-state.json');

export const GITHUB_REPO = 'PedroRoigM/speaking-ai-professor';
const LATEST_RELEASE_API = `https://api.github.com/repos/${GITHUB_REPO}/releases/latest`;
const ALLOWED_DOWNLOAD_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

export async function readUpdaterState() {
  try {
    return JSON.parse(await fs.readFile(UPDATER_STATE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

export async function saveSkippedVersion(version) {
  const dir = path.dirname(UPDATER_STATE_PATH);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const prev = await readUpdaterState();
  await fs.writeFile(
    UPDATER_STATE_PATH,
    JSON.stringify({ ...prev, skippedVersion: String(version || '').replace(/^v/i, '') }, null, 2),
    { mode: 0o600 },
  );
}

/**
 * Resolves the enclosing `.app` bundle path from an Electron executable path on macOS,
 * e.g. `/Applications/Speaking AI Professor.app/Contents/MacOS/Speaking AI Professor`
 * -> `/Applications/Speaking AI Professor.app`. Returns null if not inside a writable local `.app`.
 */
export function resolveMacAppBundlePath(execPath = process.execPath) {
  const normalized = String(execPath || '').replace(/\\/g, '/');
  const marker = '.app/Contents/MacOS/';
  const idx = normalized.indexOf(marker);
  if (idx === -1) return null;
  const appPath = normalized.slice(0, idx + 4);
  if (appPath.startsWith('/Volumes/')) return null; // Never try to overwrite a read-only mounted DMG
  return appPath;
}

/**
 * True 1-click atomic macOS in-place update:
 * Mounts the downloaded DMG at a private temp mountpoint, verifies the new `.app`,
 * spawns a detached atomic swap+relaunch script that waits for `mainPid` to quit,
 * replaces the installed `.app` with rollback protection, detaches the DMG, and relaunches!
 */
export async function applyMacDmgUpdateInPlace({ dmgPath, execPath = process.execPath, mainPid = process.pid }) {
  const targetApp = resolveMacAppBundlePath(execPath);
  if (!targetApp) {
    return { ok: false, fallbackManual: true, reason: 'La app no se está ejecutando desde /Applications' };
  }
  try {
    await fs.access(path.dirname(targetApp), fsConstants.W_OK);
  } catch {
    return { ok: false, fallbackManual: true, reason: 'Sin permisos de escritura en la carpeta de la aplicación' };
  }

  const mountDir = path.join(os.tmpdir(), `sap-upd-mount-${Date.now()}`);
  await fs.mkdir(mountDir, { recursive: true });
  try {
    await execFileAsync(
      '/usr/bin/hdiutil',
      ['attach', '-nobrowse', '-readonly', '-mountpoint', mountDir, dmgPath],
      { timeout: 30000 },
    );
  } catch (err) {
    await fs.rm(mountDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, fallbackManual: true, reason: `No se pudo montar el DMG: ${err.message}` };
  }

  const entries = await fs.readdir(mountDir);
  const appEntry = entries.find((e) => e.endsWith('.app'));
  if (!appEntry) {
    await execFileAsync('/usr/bin/hdiutil', ['detach', mountDir, '-force', '-quiet']).catch(() => {});
    return { ok: false, fallbackManual: true, reason: 'No se encontró ningún .app dentro del DMG' };
  }

  const srcApp = path.join(mountDir, appEntry);
  const scriptPath = path.join(os.tmpdir(), `sap-apply-update-${Date.now()}.sh`);
  const scriptBody = `#!/bin/sh
PID="$1"
SRC_APP="$2"
DST_APP="$3"
MOUNT_DIR="$4"
DMG_FILE="$5"
SELF_SCRIPT="$6"

i=0
while kill -0 "$PID" 2>/dev/null && [ $i -lt 60 ]; do
  sleep 0.25
  i=$((i + 1))
done

TMP_BAK="\${DST_APP}.old.$$"
rm -rf "$TMP_BAK"
if mv "$DST_APP" "$TMP_BAK" && /usr/bin/ditto "$SRC_APP" "$DST_APP"; then
  rm -rf "$TMP_BAK"
  /usr/bin/xattr -cr "$DST_APP" 2>/dev/null || true
else
  rm -rf "$DST_APP" 2>/dev/null || true
  if [ -d "$TMP_BAK" ]; then
    mv "$TMP_BAK" "$DST_APP" 2>/dev/null || true
  fi
fi

/usr/bin/hdiutil detach "$MOUNT_DIR" -force -quiet 2>/dev/null || true
rmdir "$MOUNT_DIR" 2>/dev/null || true
rm -f "$DMG_FILE" "$SELF_SCRIPT" 2>/dev/null || true
/usr/bin/open -n "$DST_APP"
`;
  await fs.writeFile(scriptPath, scriptBody, { mode: 0o700 });
  const child = spawn('/bin/sh', [scriptPath, String(mainPid), srcApp, targetApp, mountDir, dmgPath, scriptPath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  return { ok: true, targetApp };
}

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
