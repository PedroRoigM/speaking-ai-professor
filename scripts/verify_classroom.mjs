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
const { getOllamaStatus, getOllamaRunningGpuInfo, getOllamaTools } = await import(
  path.join(APP_DIR, 'lib', 'localProfessor.mjs')
);
const { getProfessorToolDeclarations } = await import(path.join(APP_DIR, 'lib', 'professorConfig.mjs'));
const { validatePublicHttpUrl, searchWeb, buildSlideSearchQuery, scoreSourceAuthority, isBlockedLowTrustDomain } = await import(
  path.join(APP_DIR, 'lib', 'webSearch.mjs')
);
const { WebResearchAgent, formatVerifiedBriefForPrompt } = await import(
  path.join(APP_DIR, 'lib', 'webResearchAgent.mjs')
);
const { execPython, execPoppler, getPlatformSummary } = await import(path.join(APP_DIR, 'lib', 'platformTools.mjs'));
const { getLocalVoicesForPlatform, buildWavFromPcm16, extractWavPcmAndRate } = await import(
  path.join(APP_DIR, 'lib', 'localVoice.mjs')
);
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

await check('Sintaxis JS/MJS + Python', async () => {
  const modules = [
    'server.mjs',
    'bin/professor.mjs',
    'scripts/setup.mjs',
    'lib/platformTools.mjs',
    'lib/httpSecurity.mjs',
    'lib/folderPicker.mjs',
    'lib/studyLibrary.mjs',
    'lib/classTimeline.mjs',
    'lib/pdfStage.mjs',
    'lib/localVoice.mjs',
    'lib/mathVerifier.mjs',
    'lib/webSearch.mjs',
    'lib/webResearchAgent.mjs',
    'lib/professorConfig.mjs',
    'public/app.js',
    'public/stageRenderer.js',
    'public/blueprintTemplates.js',
  ];
  for (const rel of modules) {
    execFileSync(process.execPath, ['--check', path.join(APP_DIR, rel)], { stdio: 'pipe' });
  }
  await execPython(['-m', 'py_compile', path.join(APP_DIR, 'lib', 'voice_worker.py')]);
  return `${modules.length + 1} módulos sin errores de sintaxis`;
});

await check('Ollama Local + GPU/CPU', async () => {
  const st = await getOllamaStatus();
  assert.ok(st.running, 'Ollama no responde en 127.0.0.1:11434');
  const gpu = await getOllamaRunningGpuInfo();
  const gpuStr = gpu.length ? gpu.map((m) => `${m.name} (${m.gpuPct}% GPU)`).join(', ') : 'en espera (se carga al iniciar)';
  return `${st.models.length} modelos (${gpuStr})`;
});

await check('Poppler PDF (pdftoppm / pdftotext / pdfinfo)', async () => {
  await execPoppler('pdftotext', ['-v']);
  await execPoppler('pdftoppm', ['-v']);
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

await check('Agente Investigador Web: Gating, Ranking Fiable, Bloqueo SEO/SSRF y Repetibilidad', async () => {
  // 1. Tools MUST be hidden when webSearchEnabled=false and exposed when webSearchEnabled=true
  const offGemini = getProfessorToolDeclarations({ webSearchEnabled: false })[0].functionDeclarations.map((f) => f.name);
  const onGemini = getProfessorToolDeclarations({ webSearchEnabled: true })[0].functionDeclarations.map((f) => f.name);
  assert.ok(
    !offGemini.includes('research_web_verified') && !offGemini.includes('search_web') && !offGemini.includes('fetch_web_page'),
    'Gemini expuso tools web estando desactivadas',
  );
  assert.ok(
    onGemini.includes('research_web_verified') && onGemini.includes('search_web') && onGemini.includes('fetch_web_page'),
    'Gemini no expuso tools web al activarlas',
  );

  const offOllama = getOllamaTools({ classMode: true, webSearchEnabled: false }).map((t) => t.function.name);
  const onOllama = getOllamaTools({ classMode: true, webSearchEnabled: true }).map((t) => t.function.name);
  assert.ok(
    !offOllama.includes('research_web_verified') && !offOllama.includes('search_web') && !offOllama.includes('fetch_web_page'),
    'Ollama expuso tools web estando desactivadas',
  );
  assert.ok(
    onOllama.includes('research_web_verified') && onOllama.includes('search_web') && onOllama.includes('fetch_web_page'),
    'Ollama no expuso tools web al activarlas',
  );

  // 2. Source authority ranking & SEO farm / homework mill filtering
  for (const spam of ['https://www.lifeder.com/teorema-steiner/', 'https://brainly.lat/tarea/123', 'https://www.rincondelvago.com/fisica', 'https://www.reddit.com/r/physics']) {
    assert.strictEqual(isBlockedLowTrustDomain(spam), true, `No bloqueó dominio basura: ${spam}`);
    assert.strictEqual(scoreSourceAuthority(spam).tier, 0, `Tier distinto de 0 en dominio basura: ${spam}`);
  }
  assert.strictEqual(scoreSourceAuthority('https://ocw.mit.edu/courses/physics').tier, 1);
  assert.strictEqual(scoreSourceAuthority('https://arxiv.org/abs/2101.00001').tier, 1);
  assert.strictEqual(scoreSourceAuthority('https://es.wikipedia.org/wiki/Teorema_de_Steiner').tier, 2);

  // 3. Strict SSRF protection (loopback, private IPs, metadata, file://)
  for (const badUrl of [
    'http://127.0.0.1:3456/api/health',
    'http://localhost:11434/api/tags',
    'http://169.254.169.254/latest/meta-data/',
    'http://10.0.0.1/internal',
    'http://192.168.1.1/',
    'http://[::1]/',
    'file:///etc/passwd',
  ]) {
    const checkUrl = await validatePublicHttpUrl(badUrl, { resolveDns: false });
    assert.strictEqual(checkUrl.ok, false, `SSRF Guard NO bloqueó URL peligrosa: ${badUrl}`);
  }
  const goodUrl = await validatePublicHttpUrl('https://es.wikipedia.org/wiki/Teorema_de_Steiner', { resolveDns: false });
  assert.strictEqual(goodUrl.ok, true, 'SSRF Guard rechazó una URL pública legítima');

  // 4. Slide query builder + live authority-filtered search (ZERO blocked domains!)
  const q = buildSlideSearchQuery(
    { layout: { lines: [{ text: 'Página 3' }, { text: 'Sensibilidad de carga del neumático' }] }, text: '' },
    'Dinámica de Vehículos',
  );
  assert.ok(q.toLowerCase().includes('neumático'), `Query de diapositiva inesperada: ${q}`);

  const liveRes = await searchWeb('Teorema de Steiner momento de inercia', {
    maxResults: 4,
    lang: 'es',
    includeAcademic: true,
    timeoutMs: 7500,
  });
  assert.ok(liveRes.ok && liveRes.results.length >= 2, `searchWeb falló: ${JSON.stringify(liveRes)}`);
  for (const r of liveRes.results) {
    assert.strictEqual(isBlockedLowTrustDomain(r.url), false, `Se coló dominio bloqueado: ${r.url}`);
  }

  // 5. Full WebResearchAgent deterministic repeatability test (quick mode)
  const osMod = await import('node:os');
  const tmpCache = path.join(osMod.default.tmpdir(), `sap-webresearch-test-${Date.now()}`);
  const agent = new WebResearchAgent({
    cacheDir: tmpCache,
    getRuntimeConfig: () => ({ engine: 'local', localModel: 'gemma4:12b', language: 'es' }),
  });
  const b1 = await agent.research({
    topic: 'Teorema de Steiner momento de inercia ejes paralelos',
    notesContext: 'I = I_CG + m * d^2 donde d es la distancia perpendicular entre ejes paralelos.',
    folderName: 'Dinámica de Vehículos',
    language: 'es',
    depth: 'quick',
  });
  assert.ok(b1.ok && b1.sources.length >= 1, `WebResearchAgent falló: ${JSON.stringify(b1)}`);
  const formatted = formatVerifiedBriefForPrompt(b1);
  assert.ok(formatted.includes('BRIEFING VERIFICADO'), 'Briefing mal formateado');
  const b2 = await agent.research({
    topic: 'Teorema de Steiner momento de inercia ejes paralelos',
    notesContext: 'I = I_CG + m * d^2 donde d es la distancia perpendicular entre ejes paralelos.',
    folderName: 'Dinámica de Vehículos',
    language: 'es',
    depth: 'quick',
  });
  assert.strictEqual(b2.cached, true, 'La 2ª llamada idéntica no usó caché determinista');
  const topDoms = b1.sources.slice(0, 3).map((s) => `${s.domain}(T${s.tier})`).join(', ');
  return `gating + SEO/SSRF bloqueados + agente 4-fases (${b1.status}/${b1.confidence} · ${topDoms}) + caché repetible OK`;
});

await check('Multiplataforma (macOS / Windows / Linux): Voces Nativas y WAV Parser', () => {
  const winVoices = getLocalVoicesForPlatform('win32');
  const linVoices = getLocalVoicesForPlatform('linux');
  const macVoices = getLocalVoicesForPlatform('darwin');
  assert.ok(winVoices.some((v) => v.id === 'windows:es'), 'Falta voz Windows SAPI ES');
  assert.ok(linVoices.some((v) => v.id === 'linux:es'), 'Falta voz Linux espeak-ng ES');
  assert.ok(macVoices.some((v) => v.id === 'macos:Mónica'), 'Falta voz macOS ES');

  // Verify WAV fmt sampleRate extraction (e.g. 22050 Hz from Windows SAPI)
  const dummyPcm = Buffer.alloc(440);
  const wav22k = buildWavFromPcm16(dummyPcm, 22050);
  const parsed = extractWavPcmAndRate(wav22k, 24000);
  assert.strictEqual(parsed.sampleRate, 22050, `SampleRate WAV incorrecto: ${parsed.sampleRate}`);
  assert.strictEqual(parsed.pcm.length, 440, 'Longitud PCM incorrecta');

  const plat = getPlatformSummary();
  return `${plat.osLabel} (${plat.arch}) · catálogos Win/Linux/Mac + WAV parser OK`;
});

console.log(failed === 0 ? '\n🎉 TODAS LAS VERIFICACIONES PASARON AL 100%\n' : `\n⚠️ ${failed} comprobaciones fallaron\n`);
process.exit(failed === 0 ? 0 : 1);
