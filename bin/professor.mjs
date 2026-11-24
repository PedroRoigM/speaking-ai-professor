#!/usr/bin/env node
/**
 * Global CLI launcher for Speaking AI Professor.
 * Install globally via `npm link` from the repository root, then run:
 *   cd /path/to/any/study-folder
 *   professor
 * Or pass a folder directly:
 *   professor ~/Desktop/Physics_Notes --port 3456
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const serverEntry = path.resolve(__dirname, '..', 'server.mjs');

const userArgs = process.argv.slice(2);
const hasDirFlag = userArgs.some((a) => a === '--dir' || a === '-d' || !a.startsWith('-'));
const hasOpenFlag = userArgs.includes('--open') || userArgs.includes('--no-open');

const forwardArgs = [serverEntry, ...userArgs.filter((a) => a !== '--no-open')];
if (!hasDirFlag) {
  forwardArgs.push('--dir', process.cwd());
}
if (!hasOpenFlag) {
  forwardArgs.push('--open');
}

const child = spawn(process.execPath, forwardArgs, {
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
