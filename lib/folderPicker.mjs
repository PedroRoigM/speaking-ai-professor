import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

function execFilePromise(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 4 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        reject(err);
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

async function resolveExistingDir(candidate) {
  let dir = candidate || os.homedir();
  try {
    const st = await fs.stat(dir);
    if (!st.isDirectory()) dir = path.dirname(dir);
  } catch {
    dir = os.homedir();
  }
  return dir;
}

/**
 * Opens the native OS folder chooser dialog (Finder on macOS, Zenity/KDialog on Linux,
 * FolderBrowserDialog on Windows) safely using argv/env without shell interpolation.
 */
export async function pickNativeFolderDialog(initialDir) {
  const startDir = await resolveExistingDir(initialDir);

  if (process.platform === 'darwin') {
    const script = [
      'on run argv',
      '  set startPath to item 1 of argv',
      '  set startDir to POSIX file startPath',
      '  try',
      '    activate',
      '    return POSIX path of (choose folder with prompt "Selecciona tu carpeta de estudio" default location startDir)',
      '  on error number -128',
      '    return "__CANCELLED__"',
      '  end try',
      'end run',
    ];
    try {
      const args = [...script.flatMap((line) => ['-e', line]), '--', startDir];
      const { stdout } = await execFilePromise('/usr/bin/osascript', args, { timeout: 180000 });
      const chosen = String(stdout || '').trim();
      if (!chosen || chosen === '__CANCELLED__') return { ok: true, cancelled: true };
      return { ok: true, cancelled: false, folderPath: chosen.replace(/\/+$/, '') || '/' };
    } catch (err) {
      return { ok: false, fallbackRequired: true, error: err.message };
    }
  }

  if (process.platform === 'linux') {
    const attempts = [
      ['zenity', ['--file-selection', '--directory', '--title=Selecciona tu carpeta de estudio', `--filename=${startDir}/`]],
      ['kdialog', ['--getexistingdirectory', startDir, 'Selecciona tu carpeta de estudio']],
    ];
    for (const [bin, args] of attempts) {
      try {
        const { stdout } = await execFilePromise(bin, args, { timeout: 180000 });
        const chosen = String(stdout || '').trim();
        if (!chosen) return { ok: true, cancelled: true };
        return { ok: true, cancelled: false, folderPath: chosen };
      } catch (err) {
        if (err.code === 1) return { ok: true, cancelled: true };
      }
    }
    return { ok: false, fallbackRequired: true, error: 'No desktop folder picker (zenity/kdialog) available' };
  }

  if (process.platform === 'win32') {
    const ps = [
      'Add-Type -AssemblyName System.Windows.Forms',
      '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
      '$d.Description = "Selecciona tu carpeta de estudio"',
      '$d.SelectedPath = $env:PROF_START_DIR',
      'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath } else { Write-Output "__CANCELLED__" }',
    ].join('; ');
    try {
      const { stdout } = await execFilePromise('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], {
        timeout: 180000,
        env: { ...process.env, PROF_START_DIR: startDir },
      });
      const chosen = String(stdout || '').trim();
      if (!chosen || chosen === '__CANCELLED__') return { ok: true, cancelled: true };
      return { ok: true, cancelled: false, folderPath: chosen };
    } catch (err) {
      return { ok: false, fallbackRequired: true, error: err.message };
    }
  }

  return { ok: false, fallbackRequired: true, error: 'Unsupported platform for native folder dialog' };
}

/**
 * Lists subdirectories and common user shortcuts for the visual fallback folder browser.
 */
export async function listBrowseDirectory(dirPath, fallbackDir) {
  const home = os.homedir();
  const requested = String(dirPath || '').trim().replace(/^~/, home);
  const current = await resolveExistingDir(requested || fallbackDir || home);

  const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => []);
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules' && e.name !== '__pycache__')
    .map((e) => ({ name: e.name, fullPath: path.join(current, e.name) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  const shortcuts = [];
  for (const [label, target] of [
    ['Escritorio', path.join(home, 'Desktop')],
    ['Documentos', path.join(home, 'Documents')],
    ['Descargas', path.join(home, 'Downloads')],
    ['Inicio', home],
  ]) {
    try {
      const st = await fs.stat(target);
      if (st.isDirectory()) shortcuts.push({ label, fullPath: target });
    } catch {
      // Shortcut absent on this OS
    }
  }

  const parent = path.dirname(current);
  return {
    ok: true,
    current,
    parent: parent !== current ? parent : null,
    dirs,
    shortcuts,
  };
}
