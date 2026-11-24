import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

let cachedPython = null; // { bin: string, prefixArgs: string[] }
const cachedPoppler = new Map(); // tool -> bin path

export function isWindows() {
  return process.platform === 'win32';
}

export function isMac() {
  return process.platform === 'darwin';
}

export function isLinux() {
  return process.platform === 'linux';
}

export function getVenvPythonPath(appDir) {
  return isWindows()
    ? path.join(appDir, '.venv', 'Scripts', 'python.exe')
    : path.join(appDir, '.venv', 'bin', 'python');
}

export function getPythonCandidates() {
  if (isWindows()) {
    return [
      { bin: 'python', prefixArgs: [] },
      { bin: 'py', prefixArgs: ['-3'] },
      { bin: 'python3', prefixArgs: [] },
    ];
  }
  return [
    { bin: 'python3', prefixArgs: [] },
    { bin: 'python', prefixArgs: [] },
  ];
}

export async function resolvePythonInvocation() {
  if (cachedPython) return cachedPython;
  for (const cand of getPythonCandidates()) {
    try {
      await execFileAsync(cand.bin, [...cand.prefixArgs, '--version'], { timeout: 3000 });
      cachedPython = cand;
      return cand;
    } catch {
      // Try next candidate
    }
  }
  return getPythonCandidates()[0];
}

export async function execPython(args, opts = {}) {
  const tried = new Set();
  const order = cachedPython ? [cachedPython, ...getPythonCandidates()] : getPythonCandidates();
  let lastErr = null;
  for (const cand of order) {
    const key = `${cand.bin}|${cand.prefixArgs.join(' ')}`;
    if (tried.has(key)) continue;
    tried.add(key);
    try {
      const res = await execFileAsync(cand.bin, [...cand.prefixArgs, ...args], opts);
      cachedPython = cand;
      return res;
    } catch (err) {
      if (err?.code === 'ENOENT') {
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  throw lastErr || new Error('Python 3 not found on PATH (install Python 3.10+)');
}

async function discoverWindowsWingetPopplerBins(exeName) {
  const found = [];
  const localApp = process.env.LOCALAPPDATA;
  if (!localApp) return found;
  const pkgsDir = path.join(localApp, 'Microsoft', 'WinGet', 'Packages');
  try {
    const entries = await fs.readdir(pkgsDir);
    for (const entry of entries) {
      if (!/poppler/i.test(entry)) continue;
      const base = path.join(pkgsDir, entry);
      const subEntries = await fs.readdir(base).catch(() => []);
      for (const sub of subEntries) {
        const candidate = path.join(base, sub, 'Library', 'bin', exeName);
        try {
          await fs.access(candidate);
          found.push(candidate);
        } catch {}
      }
      const direct = path.join(base, 'Library', 'bin', exeName);
      try {
        await fs.access(direct);
        found.push(direct);
      } catch {}
    }
  } catch {}
  return found;
}

export async function getPopplerCandidates(tool) {
  const list = [];
  if (process.env.POPPLER_PATH) {
    const ext = isWindows() ? '.exe' : '';
    list.push(path.join(process.env.POPPLER_PATH, `${tool}${ext}`));
  }
  if (isWindows()) {
    const exe = `${tool}.exe`;
    list.push(exe, tool);
    const localApp = process.env.LOCALAPPDATA || '';
    const userHome = os.homedir();
    if (localApp) list.push(path.join(localApp, 'Microsoft', 'WinGet', 'Links', exe));
    list.push(
      path.join(userHome, 'scoop', 'shims', exe),
      path.join('C:', 'ProgramData', 'chocolatey', 'bin', exe),
      path.join('C:', 'Program Files', 'poppler', 'Library', 'bin', exe),
      path.join('C:', 'poppler', 'Library', 'bin', exe),
    );
    const wingetBins = await discoverWindowsWingetPopplerBins(exe);
    list.push(...wingetBins);
  } else {
    list.push(`/opt/homebrew/bin/${tool}`, `/usr/local/bin/${tool}`, `/usr/bin/${tool}`, tool);
  }
  return [...new Set(list)];
}

export async function execPoppler(tool, args, opts = {}) {
  const cached = cachedPoppler.get(tool);
  const candidates = cached ? [cached, ...(await getPopplerCandidates(tool))] : await getPopplerCandidates(tool);
  const tried = new Set();
  let lastErr = null;
  for (const bin of candidates) {
    if (tried.has(bin)) continue;
    tried.add(bin);
    try {
      const res = await execFileAsync(bin, args, {
        maxBuffer: 25 * 1024 * 1024,
        timeout: 25000,
        windowsHide: true,
        ...opts,
      });
      cachedPoppler.set(tool, bin);
      return res;
    } catch (err) {
      lastErr = err;
    }
  }
  const installHint = isWindows()
    ? 'winget install oschwartz10612.Poppler'
    : isMac()
      ? 'brew install poppler'
      : 'sudo apt install poppler-utils';
  throw new Error(`${tool} failed (${lastErr?.message || 'binary not found'}). Install Poppler: ${installHint}`);
}

export function openBrowserUrl(url) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return;
  if (isMac()) {
    execFile('open', [target], () => {});
  } else if (isWindows()) {
    execFile('cmd.exe', ['/c', 'start', '', target], { windowsHide: true }, () => {});
  } else {
    execFile('xdg-open', [target], () => {});
  }
}

export function getPlatformSummary() {
  const cpuBrand = os.cpus()?.[0]?.model || process.arch;
  const memGb = Math.round(os.totalmem() / 1024 ** 3);
  const osLabel = isMac() ? 'macOS' : isWindows() ? 'Windows' : isLinux() ? 'Linux' : process.platform;
  return {
    platform: process.platform,
    osLabel,
    arch: process.arch,
    cpuBrand,
    memGb,
    isAppleSilicon: isMac() && process.arch === 'arm64',
  };
}
