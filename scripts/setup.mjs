#!/usr/bin/env node
/**
 * Speaking AI Professor — Cross-Platform Installer (macOS · Windows · Linux)
 * Pure Node.js setup script: avoids Windows .ps1/.bat antivirus blocks & ExecutionPolicy issues.
 *
 * Usage:
 *   node scripts/setup.mjs                    # Standard setup (deps + Poppler check + verify)
 *   node scripts/setup.mjs --with-voice       # Also install local neural voice (.venv)
 *   node scripts/setup.mjs --link-cli         # Also register global `professor` command
 *   node scripts/setup.mjs --all              # Full setup (deps + voice + global CLI)
 *   npm run setup -- --all
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import {
  isWindows,
  isMac,
  getPlatformSummary,
  getVenvPythonPath,
  resolvePythonInvocation,
  execPoppler,
} from '../lib/platformTools.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, '..');

const args = new Set(process.argv.slice(2).map((a) => a.toLowerCase()));
if (args.has('-h') || args.has('--help')) {
  console.log('\nUsage: npm run setup -- [--with-voice] [--link-cli] [--tune-gpu] [--all]\n');
  process.exit(0);
}

const all = args.has('--all') || args.has('-all');
const withVoice = all || args.has('--with-voice') || args.has('-withvoice');
const linkCli = all || args.has('--link-cli') || args.has('-linkcli');
const tuneGpu = all || args.has('--tune-gpu');

const plat = getPlatformSummary();
const npmBin = isWindows() ? 'npm.cmd' : 'npm';

function runStep(bin, stepArgs, opts = {}) {
  const res = spawnSync(bin, stepArgs, {
    cwd: ROOT_DIR,
    stdio: 'inherit',
    shell: isWindows() && /\.cmd$/i.test(bin),
    ...opts,
  });
  return res.status === 0;
}

console.log('');
console.log(`🎓 Speaking AI Professor — Setup (${plat.osLabel} · ${plat.arch})`);
console.log('=======================================================');

// 1. Check Node.js >= 20
const nodeMajor = Number(process.versions.node.split('.')[0]);
if (!Number.isFinite(nodeMajor) || nodeMajor < 20) {
  console.error(`❌ Node.js 20+ is required (detected ${process.version}). Install from https://nodejs.org`);
  process.exit(1);
}
console.log(`✅ Node.js ${process.version} detected`);

// 2. Install Node.js dependencies
console.log('📦 Installing Node.js dependencies...');
if (!runStep(npmBin, ['install'])) {
  console.error('❌ npm install failed.');
  process.exit(1);
}

// 3. Check or install Poppler PDF tools
let popplerOk = false;
try {
  await execPoppler('pdftoppm', ['-v']);
  await execPoppler('pdftotext', ['-v']);
  popplerOk = true;
} catch {
  popplerOk = false;
}

if (popplerOk) {
  console.log('✅ Poppler PDF tools (pdftoppm / pdftotext) found');
} else {
  console.log('⚠️  Poppler not found (needed for Dual-Screen PDF slides).');
  if (isMac()) {
    console.log('   Attempting Homebrew install (brew install poppler)...');
    runStep('brew', ['install', 'poppler']);
  } else if (isWindows()) {
    console.log('   Attempting WinGet install (oschwartz10612.Poppler)...');
    runStep('winget', [
      'install',
      '--id',
      'oschwartz10612.Poppler',
      '-e',
      '--accept-package-agreements',
      '--accept-source-agreements',
    ]);
  } else {
    console.log('   Install manually: sudo apt install poppler-utils  (or sudo dnf install poppler-utils)');
  }
}

// 4. Optional local neural voice (.venv)
if (withVoice) {
  let py = null;
  try {
    const cand = await resolvePythonInvocation();
    const check = spawnSync(cand.bin, [...cand.prefixArgs, '--version'], { encoding: 'utf8', windowsHide: true });
    if (check.status === 0 && /Python 3\./i.test(`${check.stdout}${check.stderr}`)) {
      py = cand;
    }
  } catch {}

  if (!py) {
    console.log('⚠️  Python 3.10+ not found. Skipping optional neural voice (OS native voice still works with 0 MB!).');
  } else {
    const venvDir = path.join(ROOT_DIR, '.venv');
    const venvPy = getVenvPythonPath(ROOT_DIR);
    let hasVenv = false;
    try {
      await fs.access(venvPy);
      hasVenv = true;
    } catch {}

    if (!hasVenv) {
      console.log('🐍 Creating Python .venv...');
      runStep(py.bin, [...py.prefixArgs, '-m', 'venv', venvDir]);
    }

    try {
      await fs.access(venvPy);
      if (plat.isAppleSilicon) {
        if (isMac()) {
          runStep('brew', ['list', 'espeak-ng'], { stdio: 'ignore' }) || runStep('brew', ['install', 'espeak-ng']);
        }
        console.log('🔊 Installing Apple Silicon neural voice (Kokoro-82M MLX + mlx-whisper)...');
        runStep(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip']);
        runStep(venvPy, ['-m', 'pip', 'install', '-r', path.join(ROOT_DIR, 'requirements-voice.txt')]);
      } else {
        console.log('🔊 Installing cross-platform neural voice (Kokoro ONNX + faster-whisper)...');
        runStep(venvPy, ['-m', 'pip', 'install', '--upgrade', 'pip']);
        runStep(venvPy, ['-m', 'pip', 'install', '-r', path.join(ROOT_DIR, 'requirements-voice-crossplatform.txt')]);
      }
      console.log('✅ Optional local neural voice setup finished');
    } catch {
      console.log('⚠️  Could not set up .venv. Native OS voice still works out of the box!');
    }
  }
} else {
  const nativeHint = isWindows() ? 'Windows SAPI (0 MB)' : isMac() ? 'macOS say (0 MB)' : 'espeak-ng';
  console.log(`✅ Native OS voice (${nativeHint}) ready. Run "npm run setup -- --with-voice" anytime for Kokoro neural voice.`);
}

// 5. Optional Apple Silicon Metal GPU tuning
if (tuneGpu && plat.isAppleSilicon) {
  runStep('bash', [path.join(ROOT_DIR, 'scripts', 'optimize_mac_gpu.sh')]);
}

// 6. Optional global `professor` CLI
if (linkCli) {
  console.log("🔗 Linking global 'professor' CLI (npm link)...");
  if (runStep(npmBin, ['link'])) {
    console.log("✅ Global 'professor' CLI registered! (Open a new terminal if not recognized immediately.)");
  } else {
    console.log("⚠️  npm link did not complete. You can always run 'npm start' or 'node server.mjs --open'.");
  }
}

// 7. Create .env from example if missing
const envPath = path.join(ROOT_DIR, '.env');
const envExample = path.join(ROOT_DIR, '.env.example');
try {
  await fs.access(envPath);
} catch {
  try {
    await fs.copyFile(envExample, envPath);
  } catch {}
}

// 8. Run classroom self-verification diagnostics
console.log('\n🔎 Running classroom diagnostics...');
runStep(process.execPath, [path.join(ROOT_DIR, 'scripts', 'verify_classroom.mjs')]);

console.log('\n🎉 Setup complete!');
console.log('   Start immediately:   npm start');
console.log('   Global CLI (linked): professor');
console.log('   Any study folder:    node server.mjs --dir "/path/to/your/notes" --open');
console.log("   For $0 Local AI:     install Ollama (https://ollama.com) and run 'ollama pull gemma4:12b'");
console.log('   For Cloud Gemini:    add GEMINI_API_KEY inside Settings -> API Key\n');
