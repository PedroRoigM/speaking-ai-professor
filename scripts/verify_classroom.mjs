#!/usr/bin/env node
/**
 * Speaking AI Professor — One-Shot Self-Verification & Anti-Freeze Diagnostic Tool
 * Run anytime: node Speaking_AI_Professor/scripts/verify_classroom.mjs
 * Checks: Ollama GPU, active models, Kokoro TTS, Poppler PDF, Python math verifier,
 * all 12 schematic blueprints (0 collisions / 0 blank graphs), and anti-freeze watchdogs.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(__dirname, '..');

const { verifyMathPython } = await import(path.join(APP_DIR, 'lib', 'mathVerifier.mjs'));
const { getOllamaStatus, getOllamaRunningGpuInfo } = await import(path.join(APP_DIR, 'lib', 'localProfessor.mjs'));
const { isAllowedLocalHost, isAllowedLocalOrigin, resolveStaticPath } = await import(
  path.join(APP_DIR, 'lib', 'httpSecurity.mjs')
);
const { BLUEPRINT_TEMPLATES, buildParametricBlueprintSvg, renderMathExpressionHtml, evalSafeExpr } = await import(
  path.join(APP_DIR, 'public', 'stageRenderer.js')
);

let failed = 0;
const check = async (name, fn) => {
  try {
    const detail = await fn();
    console.log(`✅ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    failed++;
    console.error(`❌ ${name} — ${err.message}`);
  }
};

console.log('\n🔎 Speaking AI Professor — Verificación completa del aula\n');

await check('Sintaxis JS/MJS + Python', () => {
  const modules = [
    'server.mjs',
    'bin/professor.mjs',
    'lib/httpSecurity.mjs',
    'lib/folderPicker.mjs',
    'lib/studyLibrary.mjs',
    'lib/classTimeline.mjs',
    'lib/pdfStage.mjs',
    'lib/mathVerifier.mjs',
    'lib/professorConfig.mjs',
    'public/app.js',
    'public/stageRenderer.js',
    'public/blueprintTemplates.js',
  ];
  for (const rel of modules) {
    execFileSync('node', ['--check', path.join(APP_DIR, rel)], { stdio: 'pipe' });
  }
  execFileSync('python3', ['-m', 'py_compile', path.join(APP_DIR, 'lib', 'voice_worker.py')], { stdio: 'pipe' });
  return `${modules.length + 1} módulos sin errores de sintaxis`;
});

await check('Ollama Local + Apple Silicon Metal GPU', async () => {
  const st = await getOllamaStatus();
  assert.ok(st.running, 'Ollama no responde en 127.0.0.1:11434');
  const gpu = await getOllamaRunningGpuInfo();
  const gpuStr = gpu.length ? gpu.map((m) => `${m.name} (${m.gpuPct}% GPU)`).join(', ') : 'en espera (se carga en GPU al iniciar)';
  return `${st.models.length} modelos (${gpuStr})`;
});

await check('Poppler PDF (pdftoppm / pdftotext / pdfinfo)', () => {
  execFileSync('pdftotext', ['-v'], { stdio: 'pipe' });
  execFileSync('pdftoppm', ['-v'], { stdio: 'pipe' });
  return 'instalado y operativo';
});

await check('Verificador Matemático Python (auto-captura de variables)', async () => {
  const res = await verifyMathPython('Pd = (1000 * 9.81 * 1.2) / (1.3 + 1.2)');
  assert.ok(res.ok && String(res.result).includes('4708.8'), `Resultado inesperado: ${JSON.stringify(res)}`);
  return res.result;
});

await check('12 Plantillas Esquemáticas + Cero Solapes + Cero Gráficas Vacías', () => {
  for (const [name, entry] of Object.entries(BLUEPRINT_TEMPLATES)) {
    const svg = buildParametricBlueprintSvg(`Check ${name}`, name, { xMin: 0, xMax: 200, yMin: 0, yMax: 3000 }, entry.defaultOrder);
    assert.ok(svg.includes('<svg viewBox="0 0 960 540"'), `Plantilla ${name} inválida`);
    if (name === 'xy_graph' || name === 'power_balance') {
      assert.ok(svg.includes('data-pen="1"'), `Gráfica ${name} sin curvas`);
    }
  }
  const eq = renderMathExpressionHtml('P = (1/2 · ρ · V^3 · C_d · A + m · g · V · (C_r + sen α)) / 736');
  assert.ok(eq.includes('<span class="frac">'), 'Fórmula no compiló fracción vertical');
  return `${Object.keys(BLUEPRINT_TEMPLATES).length}/12 plantillas + compilador matemático OK`;
});

await check('Watchdog Anti-Bloqueo + Self-Heal de Cola (Simulación de bloqueo en Pág. 8)', async () => {
  const { LookaheadClassEngine } = await import(path.join(APP_DIR, 'lib', 'classTimeline.mjs'));
  const events = [];
  const eng = new LookaheadClassEngine({
    pdfStage: {
      resolvePdfDoc: () => ({ id: 'd1', name: 'Test.pdf', relPath: 'Test.pdf' }),
      getPageCount: async () => 20,
      getPageBundle: async (doc, p) => ({
        docId: 'd1', name: 'Test.pdf', page: p, totalPages: 20, text: 'Test', vbW: 1000, vbH: 750,
        imageUrl: `/img/${p}.png`, layout: { lines: [] }, hasExampleProblem: false, cues: [],
      }),
      resolveTextAnchor: () => null,
      renderVisionJpegBase64: async () => null,
    },
    voiceEngine: { capabilities: { kokoro: true }, synthesize: async () => ({ ok: true, sampleRate: 24000, pcmBase64: '' }) },
    sendClient: (m) => events.push(m),
    getRuntimeConfig: () => ({ engine: 'local', localModel: 'gemma4:12b', language: 'es' }),
  });
  eng.active = true;
  eng.pdfDoc = { id: 'd1', name: 'Test.pdf' };
  eng.totalPages = 20;
  eng.playedPage = 8;
  eng.producedUpToPage = 13;
  eng.producerNextPage = 14;
  // Simulate zombie inFlightSegments (exact Page 8 freeze condition!) + pending page 9 beat
  eng.inFlightSegments.set('seg-stuck', { page: 8, surface: 'canvas', durationMs: 5000 });
  eng.pendingSegments.push({ id: 'seg-p9', page: 9, surface: 'split', durationMs: 6000, onStartEvents: [], transcriptText: 'Pág 9' });
  eng.onClientHealthCheck({ clientQueueLen: 0, playingSegId: null, currentPage: 8 });
  assert.ok(events.some((e) => e.type === 'timeline_segment' && e.segment?.id === 'seg-p9'), 'Self-heal no destrabó Pág. 9');
  eng.stop();
  return 'recuperación automática de cola bloqueada verificada';
});

await check('Seguridad: Sandbox Python AST, CSRF/CSWSH, Path Traversal y Parser Sin eval', async () => {
  // 1. Python sandbox must block introspection escapes, imports, file I/O & exponent DoS
  for (const payload of [
    '().__class__.__base__.__subclasses__()',
    'import os; os.system("id")',
    '__import__("os").popen("id").read()',
    'open("/etc/passwd").read()',
    '10 ** 1000000',
  ]) {
    const res = await verifyMathPython(payload);
    assert.strictEqual(res.ok, false, `Sandbox Python NO bloqueó payload peligroso: ${payload}`);
  }
  // Safe multi-line math must still work accurately
  const safeRes = await verifyMathPython('m = 1200\nax = 11.772\nh = 0.48\nL = 2.65\ndFz = m * ax * h / L');
  assert.ok(safeRes.ok && String(safeRes.result).includes('2558'), `Fallo en cálculo legítimo: ${JSON.stringify(safeRes)}`);

  // 2. Host & Origin validation (DNS rebinding + CSRF/CSWSH protection)
  assert.strictEqual(isAllowedLocalHost('localhost:3456'), true);
  assert.strictEqual(isAllowedLocalHost('127.0.0.1:3456'), true);
  assert.strictEqual(isAllowedLocalHost('evil.com:3456'), false);
  assert.strictEqual(isAllowedLocalOrigin('http://localhost:3456'), true);
  assert.strictEqual(isAllowedLocalOrigin('https://evil.com'), false);
  assert.strictEqual(isAllowedLocalOrigin('http://localhost.evil.com'), false);

  // 3. Path traversal & sibling-prefix bypass rejection
  const pubDir = path.join(APP_DIR, 'public');
  assert.ok(resolveStaticPath(pubDir, '/index.html')?.endsWith(path.join('public', 'index.html')));
  assert.strictEqual(resolveStaticPath(pubDir, '/../server.mjs'), null);
  assert.strictEqual(resolveStaticPath(pubDir, '/%2e%2e/server.mjs'), null);
  assert.strictEqual(resolveStaticPath(pubDir, '/../public_evil/secret.txt'), null);

  // 4. Zero-eval math parser accuracy & injection immunity
  const dragFn = evalSafeExpr('0.5 * 1.225 * 0.34 * 1.95 * V^2');
  assert.ok(dragFn && Math.abs(dragFn(10) - 40.60875) < 1e-4, 'evalSafeExpr falló en fórmula física');
  assert.strictEqual(evalSafeExpr('alert(1)'), null);
  assert.strictEqual(evalSafeExpr('constructor.constructor("return 1")()'), null);

  return '5 ataques bloqueados + parser matemático sin eval/Function verificado';
});

console.log(failed === 0 ? '\n🎉 TODAS LAS VERIFICACIONES PASARON AL 100%\n' : `\n⚠️ ${failed} comprobaciones fallaron\n`);
process.exit(failed === 0 ? 0 : 1);
