#!/usr/bin/env node
/**
 * Syncs shared deterministic chalkboard templates, Unicode math renderer,
 * and PDF.js browser bundles into mobile/www/vendor/ so Desktop & Android
 * always stay 100% in sync without code duplication.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MOBILE_DIR = path.resolve(__dirname, '..');
const ROOT_DIR = path.resolve(MOBILE_DIR, '..');
const VENDOR_DIR = path.join(MOBILE_DIR, 'www', 'vendor');

const COPIES = [
  {
    src: path.join(ROOT_DIR, 'public', 'blueprintTemplates.js'),
    dst: path.join(VENDOR_DIR, 'blueprintTemplates.js'),
  },
  {
    src: path.join(ROOT_DIR, 'public', 'stageRenderer.js'),
    dst: path.join(VENDOR_DIR, 'stageRenderer.js'),
  },
  {
    src: path.join(ROOT_DIR, 'node_modules', 'pdfjs-dist', 'build', 'pdf.min.mjs'),
    dst: path.join(VENDOR_DIR, 'pdfjs', 'pdf.min.mjs'),
  },
  {
    src: path.join(ROOT_DIR, 'node_modules', 'pdfjs-dist', 'build', 'pdf.worker.min.mjs'),
    dst: path.join(VENDOR_DIR, 'pdfjs', 'pdf.worker.min.mjs'),
  },
];

await fs.mkdir(path.join(VENDOR_DIR, 'pdfjs'), { recursive: true });
for (const { src, dst } of COPIES) {
  await fs.copyFile(src, dst);
}
console.log(`[mobile/sync-assets] Synced ${COPIES.length} shared bundles into mobile/www/vendor/`);
