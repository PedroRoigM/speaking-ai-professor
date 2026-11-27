import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable } from 'node:stream';
import { getOllamaStatus, pullOllamaModel } from './localProfessor.mjs';
import { getPlatformSummary, isMac, isWindows, isLinux } from './platformTools.mjs';

const execFileAsync = promisify(execFile);

export const DEFAULT_LOCAL_MODEL_CHOICES = [
  {
    id: 'qwen2.5:3b',
    label: 'Qwen 2.5 3B — Ligero (~1.9 GB · ideal para 8 GB RAM)',
    sizeGb: 1.9,
    minRamGb: 6,
    vision: false,
  },
  {
    id: 'qwen3.5:4b',
    label: 'Qwen 3.5 4B — Equilibrado (~3.4 GB · Visión PDF · ideal para 16 GB RAM)',
    sizeGb: 3.4,
    minRamGb: 10,
    vision: true,
  },
  {
    id: 'qwen3.5:9b',
    label: 'Qwen 3.5 9B — Alto nivel (~6.6 GB · Visión PDF · ideal para 24+ GB RAM)',
    sizeGb: 6.6,
    minRamGb: 18,
    vision: true,
  },
  {
    id: 'gemma4:12b',
    label: 'Gemma 4 12B — Estudio Pro (~7.7 GB · Visión PDF · 24+ GB RAM)',
    sizeGb: 7.7,
    minRamGb: 20,
    vision: true,
  },
];

export function getRecommendedDefaultModel(memGbOverride = null) {
  const plat = getPlatformSummary();
  const memGb =
    memGbOverride !== null && memGbOverride !== undefined && Number.isFinite(Number(memGbOverride))
      ? Number(memGbOverride)
      : plat.memGb;
  let picked;
  if (memGb <= 9) {
    picked = DEFAULT_LOCAL_MODEL_CHOICES[0]; // qwen2.5:3b
  } else if (memGb <= 17) {
    picked = DEFAULT_LOCAL_MODEL_CHOICES[1]; // qwen3.5:4b
  } else {
    picked = DEFAULT_LOCAL_MODEL_CHOICES[2]; // qwen3.5:9b
  }
  return {
    model: picked.id,
    label: picked.label,
    sizeGb: picked.sizeGb,
    vision: picked.vision,
    memGb,
    osLabel: plat.osLabel,
    arch: plat.arch,
    choices: DEFAULT_LOCAL_MODEL_CHOICES,
  };
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function findOllamaBinary() {
  const candidates = [];
  if (isWindows()) {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    candidates.push(
      path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Ollama', 'ollama.exe'),
    );
  } else if (isMac()) {
    candidates.push(
      '/opt/homebrew/bin/ollama',
      '/usr/local/bin/ollama',
      '/Applications/Ollama.app/Contents/Resources/ollama',
      path.join(os.homedir(), 'Applications', 'Ollama.app', 'Contents', 'Resources', 'ollama'),
    );
  } else {
    candidates.push('/usr/local/bin/ollama', '/usr/bin/ollama', path.join(os.homedir(), '.local', 'bin', 'ollama'));
  }

  for (const c of candidates) {
    if (await fileExists(c)) return c;
  }

  try {
    const cmd = isWindows() ? 'where' : 'which';
    const { stdout } = await execFileAsync(cmd, ['ollama'], { timeout: 3000, windowsHide: true });
    const first = String(stdout || '')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find(Boolean);
    if (first && (await fileExists(first))) return first;
  } catch {}

  return null;
}

async function findMacOllamaApp() {
  if (!isMac()) return null;
  for (const p of ['/Applications/Ollama.app', path.join(os.homedir(), 'Applications', 'Ollama.app')]) {
    if (await fileExists(p)) return p;
  }
  return null;
}

export async function getLocalSetupSummary() {
  const [ollama, bin, macApp] = await Promise.all([getOllamaStatus(), findOllamaBinary(), findMacOllamaApp()]);
  const ollamaInstalled = Boolean(ollama.running || bin || macApp);
  const hasModels = Boolean(ollama.running && Array.isArray(ollama.models) && ollama.models.length > 0);
  const recommended = getRecommendedDefaultModel();
  return {
    ollamaInstalled,
    ollamaRunning: Boolean(ollama.running),
    hasModels,
    needsBootstrap: !ollama.running || !hasModels,
    recommended,
  };
}

async function waitForOllamaReady(maxWaitMs = 25000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const st = await getOllamaStatus();
    if (st.running) return st;
    await new Promise((r) => setTimeout(r, 750));
  }
  return getOllamaStatus();
}

export async function ensureOllamaRunning({ onProgress } = {}) {
  const initial = await getOllamaStatus();
  if (initial.running) return { ok: true, alreadyRunning: true, status: initial };

  if (isMac()) {
    const appPath = await findMacOllamaApp();
    if (appPath) {
      onProgress?.({ step: 'engine', status: 'Arrancando Ollama en segundo plano...', pct: 25 });
      try {
        await execFileAsync('open', ['-g', appPath], { timeout: 8000 });
        const st = await waitForOllamaReady(22000);
        if (st.running) return { ok: true, status: st };
      } catch {}
    }
  }

  const bin = await findOllamaBinary();
  if (!bin) return { ok: false, notInstalled: true };

  onProgress?.({ step: 'engine', status: 'Iniciando motor local Ollama...', pct: 28 });
  try {
    const child = spawn(bin, ['serve'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    return { ok: false, error: err.message };
  }

  const st = await waitForOllamaReady(22000);
  return st.running ? { ok: true, status: st } : { ok: false, error: 'Ollama no respondió tras arrancar' };
}

async function downloadFileWithProgress(url, destPath, onPct) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) {
    throw new Error(`No se pudo descargar ${url} (HTTP ${res.status})`);
  }
  const totalBytes = Number(res.headers.get('content-length') || 0);
  let downloaded = 0;
  let lastEmit = 0;

  const fileStream = createWriteStream(destPath);
  const nodeReadable = Readable.fromWeb(res.body);

  await new Promise((resolve, reject) => {
    nodeReadable.on('data', (chunk) => {
      downloaded += chunk.length;
      const now = Date.now();
      if (now - lastEmit > 300) {
        lastEmit = now;
        const pct = totalBytes > 0 ? Math.min(99, Math.round((downloaded / totalBytes) * 100)) : 50;
        const mb = (downloaded / (1024 * 1024)).toFixed(1);
        const totMb = totalBytes > 0 ? (totalBytes / (1024 * 1024)).toFixed(0) : '?';
        onPct?.(pct, mb, totMb);
      }
    });
    nodeReadable.on('error', reject);
    fileStream.on('error', reject);
    fileStream.on('finish', resolve);
    nodeReadable.pipe(fileStream);
  });
}

async function installOllamaAutomatically({ onProgress } = {}) {
  if (isWindows()) {
    const installerPath = path.join(os.tmpdir(), 'OllamaSetup.exe');
    onProgress?.({ step: 'engine', status: 'Descargando Ollama oficial para Windows...', pct: 8 });
    await downloadFileWithProgress('https://ollama.com/download/OllamaSetup.exe', installerPath, (pct, mb, totMb) => {
      onProgress?.({
        step: 'engine',
        status: `Descargando Ollama (${mb} / ${totMb} MB)...`,
        pct: Math.round(8 + pct * 0.22),
      });
    });

    onProgress?.({ step: 'engine', status: 'Instalando Ollama automáticamente (sin terminal)...', pct: 32 });
    await execFileAsync(installerPath, ['/VERYSILENT', '/NORESTART', '/SUPPRESSMSGBOXES'], {
      timeout: 5 * 60 * 1000,
      windowsHide: true,
    });
    await fs.unlink(installerPath).catch(() => {});
    const st = await waitForOllamaReady(25000);
    if (st.running) return { ok: true, status: st };
    return ensureOllamaRunning({ onProgress });
  }

  if (isMac()) {
    const zipPath = path.join(os.tmpdir(), 'Ollama-darwin.zip');
    const userApps = path.join(os.homedir(), 'Applications');
    await fs.mkdir(userApps, { recursive: true });
    onProgress?.({ step: 'engine', status: 'Descargando Ollama oficial para macOS...', pct: 8 });
    await downloadFileWithProgress('https://ollama.com/download/Ollama-darwin.zip', zipPath, (pct, mb, totMb) => {
      onProgress?.({
        step: 'engine',
        status: `Descargando Ollama (${mb} / ${totMb} MB)...`,
        pct: Math.round(8 + pct * 0.22),
      });
    });

    onProgress?.({ step: 'engine', status: 'Descomprimiendo Ollama en ~/Applications...', pct: 32 });
    await execFileAsync('/usr/bin/ditto', ['-xk', zipPath, userApps], { timeout: 120000 });
    await fs.unlink(zipPath).catch(() => {});
    const appPath = path.join(userApps, 'Ollama.app');
    try {
      await execFileAsync('/usr/bin/xattr', ['-dr', 'com.apple.quarantine', appPath], { timeout: 10000 });
    } catch {}
    return ensureOllamaRunning({ onProgress });
  }

  if (isLinux()) {
    onProgress?.({ step: 'engine', status: 'Instalando Ollama oficial en Linux...', pct: 15 });
    await execFileAsync('sh', ['-c', 'curl -fsSL https://ollama.com/install.sh | sh'], {
      timeout: 5 * 60 * 1000,
    });
    return ensureOllamaRunning({ onProgress });
  }

  return { ok: false, error: 'Sistema operativo no soportado para instalación automática' };
}

let activeBootstrapPromise = null;

export async function bootstrapLocalAi({ model = '', onProgress } = {}) {
  if (activeBootstrapPromise) {
    throw new Error('Ya hay una instalación local en curso. Espera a que termine.');
  }

  const rec = getRecommendedDefaultModel();
  const targetModel = String(model || rec.model).trim();

  activeBootstrapPromise = (async () => {
    // Step 1: Ensure Ollama is installed and running
    onProgress?.({ step: 'engine', status: 'Comprobando motor local Ollama...', pct: 4, model: targetModel });
    let engRes = await ensureOllamaRunning({ onProgress });
    if (!engRes.ok && engRes.notInstalled) {
      engRes = await installOllamaAutomatically({ onProgress });
    }
    if (!engRes.ok) {
      throw new Error(engRes.error || 'No se pudo iniciar Ollama automáticamente. Puedes instalarlo desde ollama.com/download.');
    }

    onProgress?.({ step: 'engine', done: true, status: 'Motor Ollama activo', pct: 38, model: targetModel });

    // Step 2: Pull default local model if not already present
    const st = await getOllamaStatus();
    const alreadyHasModel = (st.models || []).some(
      (m) => m.name === targetModel || m.name.startsWith(`${targetModel}:`) || targetModel.startsWith(`${m.name}:`),
    );

    if (!alreadyHasModel) {
      onProgress?.({
        step: 'model',
        status: `Descargando modelo local gratuito ${targetModel}...`,
        pct: 40,
        model: targetModel,
      });
      await pullOllamaModel(targetModel, (evt) => {
        const completed = Number(evt.completed || 0);
        const total = Number(evt.total || 0);
        const subPct = total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0;
        const overallPct = Math.min(98, Math.round(40 + subPct * 0.58));
        const detail =
          total > 0
            ? `${evt.status || 'Descargando'} ${subPct}% (${(completed / 1e9).toFixed(2)} / ${(total / 1e9).toFixed(2)} GB)`
            : evt.status || 'Preparando descarga...';
        onProgress?.({
          step: 'model',
          status: detail,
          pct: overallPct,
          modelPct: subPct,
          model: targetModel,
        });
      });
    }

    const finalOllama = await getOllamaStatus();
    const readyPayload = {
      step: 'ready',
      done: true,
      ok: true,
      pct: 100,
      model: targetModel,
      status: `¡Listo! Modelo local ${targetModel} activo gratis ($0).`,
      ollama: finalOllama,
    };
    onProgress?.(readyPayload);
    return readyPayload;
  })().finally(() => {
    activeBootstrapPromise = null;
  });

  return activeBootstrapPromise;
}
