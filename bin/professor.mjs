#!/usr/bin/env node
/**
 * Global CLI launcher for Speaking AI Professor.
 * Works from ANY folder depth on macOS, Windows, and Linux once linked (`npm run setup` or `npm link`):
 *   cd /any/folder/at/any/depth
 *   professor
 * Or pass a folder directly:
 *   professor ~/Desktop/Physics_Notes --port 3456
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const scriptPath = fs.realpathSync(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(path.dirname(scriptPath), '..');
const serverEntry = path.join(repoRoot, 'server.mjs');
const callerCwd = process.cwd();

const userArgs = process.argv.slice(2);
const hasDirFlag = userArgs.some((a) => a === '--dir' || a === '-d' || !a.startsWith('-'));
const hasOpenFlag = userArgs.includes('--open') || userArgs.includes('--no-open');

const forwardArgs = [serverEntry, ...userArgs.filter((a) => a !== '--no-open')];
if (!hasDirFlag) {
  forwardArgs.push('--dir', callerCwd);
}
if (!hasOpenFlag) {
  forwardArgs.push('--open');
}

const child = spawn(process.execPath, forwardArgs, {
  cwd: repoRoot,
  stdio: 'inherit',
  env: process.env,
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 0);
});
