import {
  escapeHtml,
  sanitizeRichHtml,
  formatInlineMathHtml,
  renderMathExpressionHtml,
  renderVariableLegendHtml,
  buildSceneSvg,
  renderPdfAnnotationsSvg,
  animateSvgStrokes,
  renderPrimitiveToSvg,
  extractLastAxes,
  BLUEPRINT_TEMPLATES,
  normalizeTemplateLayers,
  renderBlueprintLayersMarkup,
} from '/stageRenderer.js';

const $ = (id) => document.getElementById(id);

const state = {
  ws: null,
  connected: false,
  engine: 'local', // 'local' ($0 Ollama) | 'gemini' (Cloud Live API)
  micMuted: false,
  echoShield: true,
  echoCooldownUntil: 0,
  pttMode: false,
  pttHeld: false,
  mode: 'folder_expert',
  connectedMode: null,
  captureCtx: null,
  captureNode: null,
  micStream: null,
  whisperChunks: [],
  speechRec: null,
  playbackCtx: null,
  masterGain: null,
  playbackChain: Promise.resolve(),
  playbackGen: 0,
  fallbackAudioEl: null,
  nextPlayTime: 0,
  activeSources: new Set(),
  classQueue: [], // Pre-buffered synchronized AV segments for Continuous Class
  qaQueue: [], // Immediate synchronized AV segments for Q&A / interactive turns
  classTimelinePaused: false,
  timelinePumping: false,
  currentPlayingClassSeg: null,
  turnFinishedWaitingAudio: false,
  screenStream: null,
  scenes: [], // { id, kind, title, data, exportHtml }
  activeSceneIdx: -1,
  stageSurface: 'canvas', // 'split' | 'pdf' | 'canvas'
  classroomFullscreen: false,
  lastInkPane: 'board', // 'pdf' | 'board'
  pdfs: [],
  pdfView: null, // { docId, name, page, totalPages, imageUrl, vbW, vbH, hasExampleProblem, reason, annotations }
  classState: {
    active: false,
    paused: false,
    qaPaused: false,
    surface: 'pdf',
    pdfId: '',
    pdfName: '',
    currentPage: 1,
    totalPages: 1,
    problemActive: false,
    problemTitle: '',
  },
  pendingClassStart: null,
  transcript: [],
  currentUserBubble: null,
  currentProfBubble: null,
  hasApiKey: false,
  models: [],
  ollama: { running: false, models: [] },
  voiceCapabilities: { kokoro: false, whisper: false, macosSay: true },
  recommendedLocalModels: [],
  domainProfile: null,
  workspaceRoot: '',
  pendingPrompt: null,
  inkEnabled: false,
  inkColor: '#f43f5e',
  hasInkStrokes: false,
  activeLabIframe: null,
};

// ---------------- Cognitive Ergonomic Theme (Papel / Sepia / Noche) & Rail Toggles ----------------
const VALID_THEMES = ['light', 'sepia', 'dark'];
function applyTheme(theme) {
  const next = VALID_THEMES.includes(theme) ? theme : 'light';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('prof-theme-v2', next);
  const switcher = $('themeSwitcher');
  if (switcher) {
    switcher.querySelectorAll('.theme-opt').forEach((btn) => {
      const active = btn.dataset.themeOpt === next;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });
  }
}

const initialTheme = localStorage.getItem('prof-theme-v2') || 'light';
applyTheme(initialTheme);

$('themeSwitcher')?.addEventListener('click', (e) => {
  const btn = e.target.closest('.theme-opt');
  if (!btn) return;
  applyTheme(btn.dataset.themeOpt);
});

$('themeBtn')?.addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme || 'light';
  const idx = VALID_THEMES.indexOf(cur);
  applyTheme(VALID_THEMES[(idx + 1) % VALID_THEMES.length]);
});

// Collapsible Side Rails (1-Click Distraction-Free Focus Mode)
function applyRailState(side, collapsed) {
  const shell = $('appShell') || document.querySelector('.app-shell');
  if (!shell) return;
  shell.classList.toggle(`${side}-collapsed`, collapsed);
  const btn = side === 'left' ? $('toggleLeftRailBtn') : $('toggleRightRailBtn');
  if (btn) {
    btn.classList.toggle('active', !collapsed);
    btn.setAttribute('aria-pressed', String(!collapsed));
  }
  try {
    const saved = JSON.parse(localStorage.getItem('prof-rails') || '{}');
    saved[side] = collapsed;
    localStorage.setItem('prof-rails', JSON.stringify(saved));
  } catch {}
}

(() => {
  try {
    const saved = JSON.parse(localStorage.getItem('prof-rails') || '{}');
    if (saved.left) applyRailState('left', true);
    if (saved.right) applyRailState('right', true);
  } catch {}
  $('toggleLeftRailBtn')?.addEventListener('click', () => {
    const shell = $('appShell') || document.querySelector('.app-shell');
    applyRailState('left', !shell?.classList.contains('left-collapsed'));
  });
  $('toggleRightRailBtn')?.addEventListener('click', () => {
    const shell = $('appShell') || document.querySelector('.app-shell');
    applyRailState('right', !shell?.classList.contains('right-collapsed'));
  });
})();

// Unified Settings Modal & Audio Tray Popover
(() => {
  const modal = $('settingsModal');
  const openSettings = () => modal?.classList.add('open');
  const closeSettings = () => modal?.classList.remove('open');
  $('openSettingsBtn')?.addEventListener('click', openSettings);
  $('closeSettingsBtn')?.addEventListener('click', closeSettings);
  $('doneSettingsBtn')?.addEventListener('click', closeSettings);
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closeSettings();
  });

  // Also close API Key & Folder modals on backdrop click
  ['apiKeyModal', 'folderModal'].forEach((id) => {
    const m = $(id);
    m?.addEventListener('click', (e) => {
      if (e.target === m) m.classList.remove('open');
    });
  });

  // Micro audio options tray inside right rail
  const audioBtn = $('audioMenuBtn');
  const audioTray = $('audioTray');
  audioBtn?.addEventListener('click', () => {
    if (!audioTray) return;
    const isHidden = audioTray.hasAttribute('hidden');
    if (isHidden) audioTray.removeAttribute('hidden');
    else audioTray.setAttribute('hidden', '');
    audioBtn.classList.toggle('active', isHidden);
    audioBtn.setAttribute('aria-expanded', String(isHidden));
  });
})();

// ---------------- Utilities ----------------
function setStatus(visualState, text) {
  $('statusPill').dataset.state = visualState;
  $('statusText').textContent = text;
  const orbState =
    visualState === 'connected' ? (state.micMuted ? 'idle' : 'listening') : visualState;
  $('orbWrap').dataset.state = orbState;
  $('voiceStateText').textContent = text;
  const fsDot = $('fsVoiceDot');
  if (fsDot) fsDot.dataset.state = visualState;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToInt16(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Int16Array(bytes.buffer);
}

// ---------------- Audio Playback (Native-Rate Web Audio + HTML5 WAV Fallback + Audio-Drained Sync) ----------------
function ensurePlaybackContext() {
  if (!state.playbackCtx) {
    // Use macOS native hardware sample rate (48kHz) to avoid CoreAudio/AirPods/Safari silent 24kHz glitches
    state.playbackCtx = new (window.AudioContext || window.webkitAudioContext)();
    state.masterGain = state.playbackCtx.createGain();
    state.masterGain.gain.value = 1.25;
    state.masterGain.connect(state.playbackCtx.destination);
    state.nextPlayTime = state.playbackCtx.currentTime;
  }
  if (state.playbackCtx.state === 'suspended') {
    state.playbackCtx.resume().catch(() => {});
  }
  // Silent 1-sample unlock inside user gesture for Safari/Chrome autoplay policies
  try {
    const silent = state.playbackCtx.createBuffer(1, 1, state.playbackCtx.sampleRate);
    const s = state.playbackCtx.createBufferSource();
    s.buffer = silent;
    s.connect(state.masterGain);
    s.start(0);
  } catch {}
}

function buildWavBlobFromInt16(int16, sampleRate = 24000) {
  const dataBytes = int16.byteLength;
  const buf = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(buf);
  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataBytes, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, 'data');
  view.setUint32(40, dataBytes, true);
  new Uint8Array(buf, 44).set(new Uint8Array(int16.buffer, int16.byteOffset, dataBytes));
  return new Blob([buf], { type: 'audio/wav' });
}

function playFallbackWavHtmlAudio(int16, sampleRate, myGen) {
  return new Promise((resolve) => {
    if (myGen !== state.playbackGen) return resolve();
    const blob = buildWavBlobFromInt16(int16, sampleRate);
    const url = URL.createObjectURL(blob);
    const audioEl = new Audio(url);
    state.fallbackAudioEl = audioEl;
    const expectedMs = Math.max(1500, Math.ceil((int16.length / Math.max(8000, sampleRate)) * 1000));
    let finished = false;
    let watchdog = null;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (watchdog) clearTimeout(watchdog);
      state.activeSources.delete(token);
      if (state.fallbackAudioEl === audioEl) state.fallbackAudioEl = null;
      URL.revokeObjectURL(url);
      if (state.activeSources.size === 0 && state.connected) {
        state.echoCooldownUntil = Date.now() + 420;
        setStatus('connected', state.micMuted ? 'Connected (Mic muted)' : 'Listening — ask anything');
        notifyAudioDrainedIfReady();
      }
      resolve();
    };
    const token = {
      stop: () => {
        try { audioEl.pause(); } catch {}
        finish();
      },
    };
    state.activeSources.add(token);
    setStatus('speaking', state.classState.active ? 'Profesor impartiendo clase...' : 'Professor speaking...');
    watchdog = setTimeout(() => {
      console.warn('[Audio Watchdog] HTML5 audio exceeded expected duration — advancing cleanly');
      try { audioEl.pause(); } catch {}
      finish();
    }, expectedMs + 3500);
    audioEl.onended = finish;
    audioEl.onerror = finish;
    audioEl.play().catch((err) => {
      appendTranscript('system', `⚠️ El navegador bloqueó el sonido (${err.message}). Pulsa "🔊 Probar Voz" para activarlo.`);
      finish();
    });
  });
}

function notifyAudioDrainedIfReady() {
  if (state.turnFinishedWaitingAudio && state.activeSources.size === 0) {
    state.turnFinishedWaitingAudio = false;
    if (state.connected && state.ws?.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify({ type: 'audio_drained' }));
    }
  }
}

function playPcm24Chunk(base64Pcm, mimeType = 'audio/pcm;rate=24000') {
  const int16 = base64ToInt16(base64Pcm);
  if (!int16.length) return;
  const rateMatch = String(mimeType || '').match(/rate=(\d+)/i);
  const sampleRate = rateMatch ? Number(rateMatch[1]) || 24000 : 24000;
  const myGen = state.playbackGen;

  state.playbackChain = state.playbackChain.then(async () => {
    if (myGen !== state.playbackGen) return;
    ensurePlaybackContext();
    if (state.playbackCtx.state !== 'running') {
      try {
        await state.playbackCtx.resume();
      } catch {}
    }

    // If Web Audio Context is still suspended (e.g. Safari autoplay policy), fall back to HTML5 <audio> WAV
    if (state.playbackCtx.state !== 'running') {
      await playFallbackWavHtmlAudio(int16, sampleRate, myGen);
      return;
    }

    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) {
      float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
    }

    const audioBuffer = state.playbackCtx.createBuffer(1, float32.length, sampleRate);
    audioBuffer.copyToChannel(float32, 0);

    const src = state.playbackCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(state.masterGain || state.playbackCtx.destination);

    const now = state.playbackCtx.currentTime;
    if (state.nextPlayTime < now + 0.02) state.nextPlayTime = now + 0.06;
    src.start(state.nextPlayTime);
    state.nextPlayTime += audioBuffer.duration;

    state.activeSources.add(src);
    state.echoCooldownUntil = Date.now() + Math.ceil((state.nextPlayTime - now) * 1000) + 450;
    setStatus('speaking', state.classState.active ? 'Profesor impartiendo clase...' : 'Professor speaking...');
    src.onended = () => {
      state.activeSources.delete(src);
      if (state.activeSources.size === 0 && state.connected) {
        state.echoCooldownUntil = Date.now() + 420;
        setStatus('connected', state.micMuted ? 'Connected (Mic muted)' : 'Listening — ask anything');
        notifyAudioDrainedIfReady();
      }
    };
  });
}

let pendingPauseCancels = [];

function flushPlaybackQueue() {
  state.playbackGen++;
  state.turnFinishedWaitingAudio = false;
  for (const cancel of pendingPauseCancels) {
    try { cancel(); } catch {}
  }
  pendingPauseCancels = [];
  for (const src of state.activeSources) {
    try { src.stop(); } catch {}
  }
  state.activeSources.clear();
  if (state.fallbackAudioEl) {
    try { state.fallbackAudioEl.pause(); } catch {}
    state.fallbackAudioEl = null;
  }
  state.echoCooldownUntil = 0;
  if (state.playbackCtx) state.nextPlayTime = state.playbackCtx.currentTime;
}

// Pre-decode PCM -> WebAudio AudioBuffer & preload upcoming PDF slide images BEFORE playback starts (0ms transition!)
function prewarmTimelineSegment(seg) {
  if (!seg) return;
  const evts = Array.isArray(seg.onStartEvents) ? seg.onStartEvents : [];
  for (const evt of evts) {
    if (evt?.type === 'stage_pdf_page' && evt.data?.imageUrl) {
      const img = new Image();
      img.decoding = 'async';
      img.src = evt.data.imageUrl;
      seg._preloadedImg = img;
    }
  }
  if (seg.audioBase64 && state.playbackCtx && !seg._decodedBuffer) {
    try {
      const int16 = base64ToInt16(seg.audioBase64);
      if (int16.length) {
        const float32 = new Float32Array(int16.length);
        for (let i = 0; i < int16.length; i++) {
          float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
        }
        const sr = seg.sampleRate || 24000;
        const audioBuffer = state.playbackCtx.createBuffer(1, float32.length, sr);
        audioBuffer.copyToChannel(float32, 0);
        seg._decodedBuffer = audioBuffer;
      }
    } catch {}
  }
}

// ---------------- Synchronized Dual-Queue AV Timeline Player (0ms Drift + Anti-Freeze Watchdog!) ----------------
function playAtomicAudioSegment(base64Pcm, sampleRate = 24000, myGen, predecodedBuffer = null) {
  return new Promise(async (resolve) => {
    if (myGen !== state.playbackGen) return resolve(false);
    if (!base64Pcm && !predecodedBuffer) return resolve(true);

    ensurePlaybackContext();
    if (state.playbackCtx.state !== 'running') {
      // Never hang forever if browser autoplay policy blocks AudioContext.resume()!
      await Promise.race([
        state.playbackCtx.resume().catch(() => {}),
        new Promise((r) => setTimeout(r, 1200)),
      ]);
    }
    if (myGen !== state.playbackGen) return resolve(false);

    if (state.playbackCtx.state !== 'running') {
      const int16 = base64ToInt16(base64Pcm);
      if (!int16.length) return resolve(true);
      await playFallbackWavHtmlAudio(int16, sampleRate, myGen);
      return resolve(myGen === state.playbackGen);
    }

    let audioBuffer = predecodedBuffer;
    if (!audioBuffer) {
      const int16 = base64ToInt16(base64Pcm);
      if (!int16.length) return resolve(true);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / (int16[i] < 0 ? 0x8000 : 0x7fff);
      }
      audioBuffer = state.playbackCtx.createBuffer(1, float32.length, sampleRate);
      audioBuffer.copyToChannel(float32, 0);
    }

    const src = state.playbackCtx.createBufferSource();
    src.buffer = audioBuffer;
    src.connect(state.masterGain || state.playbackCtx.destination);

    let finished = false;
    let safetyTimer = null;
    const done = (completed) => {
      if (finished) return;
      finished = true;
      if (safetyTimer) clearTimeout(safetyTimer);
      state.activeSources.delete(src);
      if (state.activeSources.size === 0 && state.connected) {
        state.echoCooldownUntil = Date.now() + 900;
      }
      resolve(completed);
    };

    const origStop = src.stop.bind(src);
    src.stop = () => {
      try { origStop(); } catch {}
      done(false);
    };

    const now = state.playbackCtx.currentTime;
    const expectedMs = Math.max(600, Math.ceil(audioBuffer.duration * 1000));
    state.nextPlayTime = now + 0.008;
    try {
      src.start(state.nextPlayTime);
    } catch (err) {
      console.error('[Audio start error]', err);
      return done(true);
    }
    state.nextPlayTime += audioBuffer.duration;
    state.activeSources.add(src);
    state.echoCooldownUntil = Date.now() + expectedMs + 360;
    setStatus('speaking', state.classState.active && !state.classTimelinePaused ? 'Profesor impartiendo clase...' : 'Professor speaking...');

    // Hard anti-freeze watchdog: if Safari/Chrome/CoreAudio ever misses src.onended, advance cleanly!
    safetyTimer = setTimeout(() => {
      if (!finished) {
        console.warn(`[Audio Watchdog] onended missed after ${expectedMs}ms — auto-advancing cleanly`);
        try { origStop(); } catch {}
        done(myGen === state.playbackGen);
      }
    }, expectedMs + 2600);

    src.onended = () => done(myGen === state.playbackGen);
  });
}

function waitInterruptible(ms, myGen) {
  if (!ms || ms <= 0) return Promise.resolve(myGen === state.playbackGen);
  return new Promise((resolve) => {
    if (myGen !== state.playbackGen) return resolve(false);
    let done = false;
    const cancel = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(false);
    };
    pendingPauseCancels.push(cancel);
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      pendingPauseCancels = pendingPauseCancels.filter((fn) => fn !== cancel);
      resolve(myGen === state.playbackGen);
    }, ms);
  });
}

function applyStageEvent(evt, { pacingMs = 0 } = {}) {
  if (!evt || !evt.type) return;
  if (evt.type === 'stage_pdf_page') {
    renderPdfStage(evt.data, { animateNewFrom: 0, pacingMs });
  } else if (evt.type === 'stage_pdf_annotations') {
    updatePdfAnnotations(evt.data, { pacingMs });
  } else if (evt.type === 'stage_chalkboard_update') {
    applyChalkboardUpdate(evt.data, { pacingMs });
  } else if (evt.type === 'stage_pointer') {
    showStagePointer(evt.data);
  } else if (evt.type === 'stage_problem_start') {
    startProblemBoard(evt.data, { pacingMs });
  } else if (evt.type === 'stage_problem_step') {
    appendProblemBoardStep(evt.data, { pacingMs });
  } else if (evt.type === 'stage_live_scene') {
    pushScene({ kind: 'live_scene', title: evt.data.scene_title || 'Live Board', data: evt.data }, { pacingMs });
  } else if (evt.type === 'stage_interactive_lab') {
    pushScene({ kind: 'lab', title: evt.data.title || 'Interactive Lab', data: evt.data });
  } else if (evt.type === 'stage_lab_update') {
    if (state.activeLabIframe?.contentWindow) {
      state.activeLabIframe.contentWindow.postMessage(
        { type: 'prof_update_params', updates: evt.data.updates || {} },
        '*',
      );
      const noteEl = $('labNote');
      if (noteEl && evt.data.note) {
        noteEl.textContent = `Professor adjusted lab: ${evt.data.note}`;
        noteEl.classList.add('visible');
      }
    }
  } else if (evt.type === 'stage_lesson_card') {
    pushScene({ kind: 'lesson', title: evt.data.title || 'Derivation', data: evt.data });
  } else if (evt.type === 'stage_quiz') {
    pushScene({ kind: 'quiz', title: evt.data.question || 'Quick Check', data: evt.data });
  } else if (evt.type === 'stage_math') {
    showMathBanner(evt.data);
  }
}

function enqueueTimelineSegment(seg) {
  if (!seg) return;
  prewarmTimelineSegment(seg);
  if (seg.isQa) {
    state.qaQueue.push(seg);
  } else {
    state.classQueue.push(seg);
  }
  pumpTimeline();
}

let skipRequestedGen = -1;
let lastTimelineActiveAt = Date.now();
let lastHealthPingAt = 0;

function skipCurrentBeatNow() {
  if (!state.connected) return;
  const cur = state.currentPlayingClassSeg;
  skipRequestedGen = state.playbackGen;
  flushPlaybackQueue();
  if (cur && state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'timeline_event', event: 'end', segId: cur.id }));
    state.currentPlayingClassSeg = null;
  }
  state.classTimelinePaused = false;
  queueMicrotask(() => pumpTimeline());
}

async function pumpTimeline() {
  if (state.timelinePumping) return;
  state.timelinePumping = true;

  try {
    while (state.connected) {
      // Q&A answers ALWAYS take priority over paused/queued class segments
      let seg = null;
      let fromClass = false;
      if (state.qaQueue.length > 0) {
        seg = state.qaQueue.shift();
      } else if (!state.classTimelinePaused && state.classQueue.length > 0) {
        seg = state.classQueue.shift();
        fromClass = true;
      } else {
        break;
      }

      lastTimelineActiveAt = Date.now();
      const myGen = state.playbackGen;
      if (fromClass) {
        state.currentPlayingClassSeg = seg;
        state.ws?.send(JSON.stringify({ type: 'timeline_event', event: 'start', segId: seg.id }));
      }

      // 1. Fire ALL visual stage changes inside isolated try/catch so a visual glitch NEVER kills playback!
      const pacingMs = seg.durationMs || 2400;
      const evts = Array.isArray(seg.onStartEvents) ? seg.onStartEvents : [];
      if (
        fromClass &&
        (seg.surface === 'pdf' || seg.surface === 'split') &&
        state.stageSurface === 'canvas' &&
        state.pdfView &&
        !evts.some((e) => e.type === 'stage_pdf_page')
      ) {
        try { setStageLayout('split'); } catch (e) { console.error('[StageLayout error]', e); }
      }
      for (const evt of evts) {
        try {
          applyStageEvent(evt, { pacingMs });
        } catch (err) {
          console.error('[StageEvent isolated error — continuing playback]', evt?.type, err);
        }
      }

      // 2. Reveal THIS segment's transcript sentence RIGHT AS it is spoken (and update Fullscreen live caption!)
      if (seg.transcriptText) {
        try {
          const prefix = state.currentProfBubble && !seg.isPageStart ? ' ' : '';
          if (seg.isPageStart) state.currentProfBubble = null;
          appendTranscript('professor', prefix + seg.transcriptText, Boolean(state.currentProfBubble));
          const fsCap = $('fsCaptionText');
          if (fsCap) fsCap.textContent = seg.transcriptText;
        } catch (err) {
          console.error('[Transcript error]', err);
        }
      }

      // 3. Play THIS segment's audio and WAIT until its exact last sample finishes (with anti-freeze watchdog!)
      let completedAudio = true;
      try {
        completedAudio = await playAtomicAudioSegment(seg.audioBase64, seg.sampleRate || 24000, myGen, seg._decodedBuffer || null);
      } catch (err) {
        console.error('[Audio playback isolated error]', err);
        completedAudio = myGen === state.playbackGen;
      }

      const wasSkipped = skipRequestedGen === myGen;
      if (!completedAudio || myGen !== state.playbackGen) {
        // Interrupted mid-segment: only re-queue if user PAUSED (NOT if user skipped or jumped pages!)
        if (fromClass && state.classTimelinePaused && !wasSkipped) {
          state.classQueue.unshift(seg);
        }
        state.currentPlayingClassSeg = null;
        continue;
      }

      // 4. Crisp natural teacher breathing pause before the next beat / page turn
      const completedPause = await waitInterruptible(seg.pauseAfterMs || 220, myGen);
      if (!completedPause || myGen !== state.playbackGen) {
        state.currentPlayingClassSeg = null;
        continue;
      }

      lastTimelineActiveAt = Date.now();
      if (fromClass) {
        state.currentPlayingClassSeg = null;
        state.ws?.send(JSON.stringify({ type: 'timeline_event', event: 'end', segId: seg.id }));
      }
    }
  } finally {
    state.timelinePumping = false;
    // Immediately re-pump if new segments arrived during the tail of flush/skip!
    if (state.connected && (state.qaQueue.length > 0 || (!state.classTimelinePaused && state.classQueue.length > 0))) {
      queueMicrotask(() => pumpTimeline());
      return;
    }
    const waitingForNextBeat =
      state.classState.active &&
      !state.classTimelinePaused &&
      !state.classState.paused &&
      !state.classState.qaPaused &&
      !state.classQueue.length;
    if (state.connected && state.activeSources.size === 0 && !state.qaQueue.length) {
      if (waitingForNextBeat) {
        setStatus('thinking', `Preparando siguiente bloque (Pág. ${(state.classState.currentPage || 1) + 1})...`);
      } else if (state.classTimelinePaused || !state.classQueue.length) {
        setStatus('connected', state.micMuted ? 'Connected (Mic muted)' : 'Listening — ask anything');
      }
    }
  }
}

// Client-side 2.5s Anti-Freeze Heartbeat Watchdog: guarantees playback NEVER stalls silently!
setInterval(() => {
  if (!state.connected || !state.classState.active) return;
  if (state.classTimelinePaused || state.classState.paused || state.classState.qaPaused || state.classState.prebuffering) return;
  if (!state.timelinePumping && (state.classQueue.length > 0 || state.qaQueue.length > 0)) {
    pumpTimeline();
    return;
  }
  const now = Date.now();
  if (!state.timelinePumping && state.classQueue.length === 0 && state.activeSources.size === 0 && now - lastTimelineActiveAt > 3500 && now - lastHealthPingAt > 4500) {
    lastHealthPingAt = now;
    state.ws?.send(
      JSON.stringify({
        type: 'timeline_health_check',
        clientQueueLen: state.classQueue.length,
        playingSegId: state.currentPlayingClassSeg?.id || null,
        currentPage: state.pdfView?.page || state.classState.currentPage || 1,
      }),
    );
  }
}, 2500);

function pauseClassTimeline() {
  state.classTimelinePaused = true;
  state.qaQueue = [];
  flushPlaybackQueue();
}

function resumeClassTimeline() {
  state.classTimelinePaused = false;
  state.qaQueue = [];
  pumpTimeline();
}

function flushAllTimelines() {
  state.classQueue = [];
  state.qaQueue = [];
  state.currentPlayingClassSeg = null;
  state.classTimelinePaused = false;
  flushPlaybackQueue();
}

// ---------------- Audio Capture (AudioWorklet -> 16kHz PCM) ----------------
async function startMicCapture() {
  state.micStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });

  state.captureCtx = new (window.AudioContext || window.webkitAudioContext)();
  await state.captureCtx.audioWorklet.addModule('/pcm-processor.js');

  const source = state.captureCtx.createMediaStreamSource(state.micStream);
  state.captureNode = new AudioWorkletNode(state.captureCtx, 'pcm16-capture-processor');

  state.captureNode.port.onmessage = (evt) => {
    const { pcm16, rms } = evt.data;
    const isSpeakingOrEcho = state.activeSources.size > 0 || Date.now() < state.echoCooldownUntil;
    const gatedByEcho = state.echoShield && isSpeakingOrEcho;
    const scale = state.micMuted || gatedByEcho || (state.pttMode && !state.pttHeld) ? 1 : 1 + Math.min(rms * 4.5, 0.38);
    $('orbRing').style.transform = `scale(${scale.toFixed(3)})`;

    if (!state.connected || !state.ws || state.ws.readyState !== WebSocket.OPEN) return;
    if (state.micMuted) return;

    if (state.engine === 'local') {
      if ($('localSttSelect').value === 'whisper' && state.pttHeld) {
        state.whisperChunks.push(new Uint8Array(pcm16));
      }
      return;
    }

    if (state.pttMode && !state.pttHeld) return;
    if (gatedByEcho) return;
    if (isSpeakingOrEcho && rms < 0.018) return;

    state.ws.send(JSON.stringify({ type: 'audio_in', data: arrayBufferToBase64(pcm16) }));
  };

  source.connect(state.captureNode);
}

// ---------------- Local Browser SpeechRecognition (Instant $0 STT) ----------------
function startLocalBrowserSpeech() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    appendTranscript('system', 'Tu navegador no soporta dictado Web Speech. Usa "Offline mlx-whisper" o escribe abajo.');
    return;
  }
  stopLocalBrowserSpeech();
  const rec = new SR();
  rec.continuous = true;
  rec.interimResults = false;
  const langChoice = $('langSelect').value;
  rec.lang =
    langChoice === 'en'
      ? 'en-US'
      : langChoice === 'es' || state.domainProfile?.detectedLanguage === 'es'
        ? 'es-ES'
        : 'es-ES';

  rec.onresult = (evt) => {
    if (!state.connected || state.engine !== 'local' || state.micMuted) return;
    const isSpeakingOrEcho = state.activeSources.size > 0 || Date.now() < state.echoCooldownUntil;
    const classLecturingNow =
      state.classState.active && !state.classTimelinePaused && !state.classState.paused && !state.classState.qaPaused;
    // With MacBook speakers (Anti-Echo ON), never let speaker echo self-pause the continuous class between beats/pages!
    if (state.echoShield && (isSpeakingOrEcho || classLecturingNow)) return;

    for (let i = evt.resultIndex; i < evt.results.length; i++) {
      if (evt.results[i].isFinal) {
        const spoken = evt.results[i][0]?.transcript?.trim();
        if (spoken && spoken.length >= 2) {
          if (state.classState.active && !state.classTimelinePaused) pauseClassTimeline();
          else if (state.activeSources.size > 0) flushPlaybackQueue();
          appendTranscript('user', spoken, false);
          state.ws?.send(JSON.stringify({ type: 'text', text: spoken, alreadyLogged: true }));
        }
      }
    }
  };

  rec.onerror = (e) => {
    if (e.error !== 'no-speech' && e.error !== 'aborted') {
      appendTranscript('system', `Mic dictado: ${e.error}`);
    }
  };

  rec.onend = () => {
    if (state.connected && state.engine === 'local' && $('localSttSelect').value === 'browser' && !state.micMuted) {
      setTimeout(() => {
        try {
          if (state.connected && state.speechRec === rec) rec.start();
        } catch {}
      }, 220);
    }
  };

  state.speechRec = rec;
  try { rec.start(); } catch {}
}

function stopLocalBrowserSpeech() {
  if (state.speechRec) {
    const old = state.speechRec;
    state.speechRec = null;
    try { old.abort(); } catch {}
  }
}

function flushWhisperTurn() {
  if (!state.whisperChunks.length || !state.connected || state.ws?.readyState !== WebSocket.OPEN) {
    state.whisperChunks = [];
    return;
  }
  const totalBytes = state.whisperChunks.reduce((acc, c) => acc + c.byteLength, 0);
  const merged = new Uint8Array(totalBytes);
  let offset = 0;
  for (const c of state.whisperChunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  state.whisperChunks = [];
  if (totalBytes < 4800) return;
  state.ws.send(JSON.stringify({ type: 'local_audio_turn', data: arrayBufferToBase64(merged.buffer) }));
}

function stopMicCapture() {
  $('orbRing').style.transform = 'scale(1)';
  if (state.captureNode) {
    try { state.captureNode.disconnect(); } catch {}
    state.captureNode = null;
  }
  if (state.captureCtx) {
    state.captureCtx.close().catch(() => {});
    state.captureCtx = null;
  }
  if (state.micStream) {
    state.micStream.getTracks().forEach((t) => t.stop());
    state.micStream = null;
  }
}

// ---------------- Laser Pointer on Active Stage (Works on BOTH PDF & Blank Canvas!) ----------------
const POINTER_COLORS = {
  cyan: '#38bdf8',
  amber: '#f59e0b',
  emerald: '#10b981',
  rose: '#f43f5e',
};

function showStagePointer(data) {
  const wantPdf = Boolean(data.onPdf) || (data.onPdf !== false && state.stageSurface === 'pdf');
  const pdfTarget = $('pdfStageMount')?.querySelector('.pdf-stage-frame');
  const boardTarget =
    $('boardStageMount')?.querySelector('.chalk-canvas-wrap') ||
    $('boardStageMount')?.querySelector('.stage-card');
  const wrap = wantPdf ? pdfTarget || boardTarget : boardTarget || pdfTarget;
  if (!wrap) return;

  let pointer = wrap.querySelector('.laser-pointer');
  if (!pointer) {
    pointer = document.createElement('div');
    pointer.className = 'laser-pointer';
    pointer.innerHTML = `<div class="laser-dot"></div><div class="laser-label"></div>`;
    wrap.appendChild(pointer);
  }

  const color = POINTER_COLORS[data.color] || POINTER_COLORS.amber;
  pointer.style.setProperty('--pointer-color', color);
  pointer.querySelector('.laser-label').textContent = data.label || '';

  const wrapRect = wrap.getBoundingClientRect();
  let px = wrapRect.width * 0.5;
  let py = wrapRect.height * 0.45;

  if (data.element_id) {
    const target = wrap.querySelector(`[id="${CSS.escape(data.element_id)}"]`);
    if (target) {
      const r = target.getBoundingClientRect();
      px = r.left - wrapRect.left + r.width / 2;
      py = r.top - wrapRect.top + r.height / 2;
    }
  } else if (Number.isFinite(Number(data.x)) && Number.isFinite(Number(data.y))) {
    const svg = wrap.querySelector('svg');
    if (svg) {
      const svgRect = svg.getBoundingClientRect();
      const vb = svg.viewBox?.baseVal;
      const vbW = data.vbW || vb?.width || 960;
      const vbH = data.vbH || vb?.height || 540;
      px = svgRect.left - wrapRect.left + (Number(data.x) / vbW) * svgRect.width;
      py = svgRect.top - wrapRect.top + (Number(data.y) / vbH) * svgRect.height;
    } else {
      const vbW = data.vbW || 1000;
      const vbH = data.vbH || 750;
      px = (Number(data.x) / vbW) * wrapRect.width;
      py = (Number(data.y) / vbH) * wrapRect.height;
    }
  }

  pointer.style.left = `${Math.max(18, Math.min(wrapRect.width - 18, px))}px`;
  pointer.style.top = `${Math.max(18, Math.min(wrapRect.height - 18, py))}px`;
  pointer.classList.add('visible');
}

// ---------------- Student Ink Overlay (Circle & Ask on BOTH PDF and Chalkboard!) ----------------
function attachInkCanvas(containerEl, paneKey = 'board') {
  const existing = containerEl.querySelector('.ink-canvas');
  if (existing) existing.remove();

  const canvas = document.createElement('canvas');
  canvas.className = `ink-canvas${state.inkEnabled ? ' drawing' : ''}`;
  canvas.dataset.pane = paneKey;
  containerEl.appendChild(canvas);

  const resize = () => {
    const rect = containerEl.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, Math.round(rect.width * dpr));
    canvas.height = Math.max(1, Math.round(rect.height * dpr));
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  new ResizeObserver(resize).observe(containerEl);

  let drawing = false;
  let last = null;
  const getPt = (e) => {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.inkEnabled) return;
    drawing = true;
    state.lastInkPane = paneKey;
    canvas.setPointerCapture(e.pointerId);
    last = getPt(e);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!drawing || !last) return;
    const pt = getPt(e);
    const ctx = canvas.getContext('2d');
    ctx.strokeStyle = state.inkColor;
    ctx.lineWidth = 3.2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(last.x, last.y);
    ctx.lineTo(pt.x, pt.y);
    ctx.stroke();
    last = pt;
    if (!state.hasInkStrokes) {
      state.hasInkStrokes = true;
      $('sendSketchBtn').style.display = 'inline-flex';
      $('clearInkBtn').style.display = 'inline-flex';
    }
  });

  const endDraw = () => {
    drawing = false;
    last = null;
  };
  canvas.addEventListener('pointerup', endDraw);
  canvas.addEventListener('pointercancel', endDraw);
}

async function captureStageWithInkJpeg() {
  const pdfFrame = $('pdfStageMount')?.querySelector('.pdf-stage-frame');
  const boardWrap =
    $('boardStageMount')?.querySelector('.chalk-canvas-wrap') ||
    $('boardStageMount')?.querySelector('.stage-card');
  const preferPdf =
    state.stageSurface === 'pdf' ||
    (state.stageSurface === 'split' && state.lastInkPane === 'pdf');
  const wrap = preferPdf ? pdfFrame || boardWrap : boardWrap || pdfFrame;
  if (!wrap) return null;
  const rect = wrap.getBoundingClientRect();
  const outW = Math.min(1100, Math.max(640, Math.round(rect.width)));
  const outH = Math.round((rect.height / Math.max(rect.width, 1)) * outW);

  const comp = document.createElement('canvas');
  comp.width = outW;
  comp.height = outH;
  const ctx = comp.getContext('2d');
  ctx.fillStyle = wrap.classList.contains('pdf-stage-frame')
    ? '#ffffff'
    : '#0f1724';
  ctx.fillRect(0, 0, outW, outH);

  // 1. Draw underlying PDF page image if on PDF surface
  const pdfImg = wrap.querySelector('.pdf-page-img');
  if (pdfImg && pdfImg.complete && pdfImg.naturalWidth > 0) {
    ctx.drawImage(pdfImg, 0, 0, outW, outH);
  }

  // 2. Draw SVG layer (precision diagram OR PDF annotations)
  const svg = wrap.querySelector('svg');
  if (svg) {
    const clone = svg.cloneNode(true);
    clone.querySelectorAll('*').forEach((el) => {
      el.style.strokeDashoffset = '0';
      el.style.opacity = '1';
    });
    const svgStr = new XMLSerializer().serializeToString(clone);
    const img = new Image();
    const svgBlob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
    const url = URL.createObjectURL(svgBlob);
    await new Promise((resolve) => {
      img.onload = () => {
        const pad = wrap.classList.contains('pdf-stage-frame') ? 0 : 12;
        ctx.drawImage(img, pad, pad, outW - pad * 2, outH - pad * 2);
        URL.revokeObjectURL(url);
        resolve();
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        resolve();
      };
      img.src = url;
    });
  }

  // 3. Composite student's freehand ink canvas on top
  const ink = wrap.querySelector('.ink-canvas');
  if (ink) {
    ctx.drawImage(ink, 0, 0, outW, outH);
  }

  return comp.toDataURL('image/jpeg', 0.86).split(',')[1];
}

// ---------------- Interactive Sandboxed Lab Builder ----------------
function buildLabSrcdoc(htmlBody) {
  const isLight = document.documentElement.dataset.theme === 'light';
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<style>
  :root {
    --bg: ${isLight ? '#f8fafc' : '#0b0f17'};
    --card: ${isLight ? '#ffffff' : '#131a26'};
    --text: ${isLight ? '#0f172a' : '#eef2f7'};
    --muted: ${isLight ? '#475569' : '#9aa7bc'};
    --border: ${isLight ? '#cbd5e1' : '#263348'};
    --cyan: #38bdf8;
    --amber: #f59e0b;
    --emerald: #10b981;
    --rose: #f43f5e;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 16px; background: var(--bg); color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    font-size: 14px; line-height: 1.5;
  }
  input[type="range"] { accent-color: var(--cyan); cursor: pointer; }
  .frac { display: inline-flex; flex-direction: column; align-items: center; vertical-align: middle; margin: 0 3px; line-height: 1.15; }
  .frac .num { border-bottom: 1.5px solid currentColor; padding: 0 4px 2px; }
  .frac .den { padding: 2px 4px 0; }
  .var-cyan { color: var(--cyan); font-weight: 650; }
  .var-amber { color: var(--amber); font-weight: 650; }
  .var-emerald { color: var(--emerald); font-weight: 650; }
  .var-rose { color: var(--rose); font-weight: 650; }
</style>
<script>
  window.PROF_STAGE = {
    notify(summary) {
      window.parent.postMessage({ type: 'lab_user_event', summary: String(summary) }, '*');
    }
  };
  window.addEventListener('message', (evt) => {
    if (evt.data?.type === 'prof_update_params' && evt.data.updates) {
      for (const [key, val] of Object.entries(evt.data.updates)) {
        const el = document.querySelector('[data-param="' + CSS.escape(key) + '"]') || document.getElementById(key);
        if (el) {
          el.value = val;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    }
  });
</script>
</head>
<body>
${htmlBody}
</body>
</html>`;
}

window.addEventListener('message', (evt) => {
  if (evt.data?.type === 'lab_user_event' && state.connected && state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'lab_event', summary: evt.data.summary }));
  }
});

// ---------------- Live Class Bar & Dual-Screen Classroom Controller ----------------
function renderChalkboardReadyPlaceholder() {
  const boardMount = $('boardStageMount');
  if (!boardMount) return;
  boardMount.innerHTML = `
    <div class="pane-placeholder">
      <div class="pane-placeholder-icon" aria-hidden="true">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 20h9"/>
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
        </svg>
      </div>
      <strong>Pizarra viva del profesor</strong>
      <p>Aquí aparecerán esquemas físicos, gráficas y fórmulas paso a paso mientras se explica la diapositiva de la izquierda.</p>
    </div>
  `;
}

function setStageLayout(layout) {
  const valid = ['split', 'pdf', 'canvas'].includes(layout) ? layout : 'split';
  state.stageSurface = valid;
  const dual = $('dualStageContainer');
  if (dual) dual.dataset.layout = valid;

  if (valid === 'split' && state.scenes.length === 0) {
    renderChalkboardReadyPlaceholder();
  }
  syncClassBarUi();
  renderFilmstrip();
}

function syncFullscreenButtons() {
  const fs = state.classroomFullscreen;
  const btn = $('classroomFullscreenBtn');
  if (btn) {
    btn.textContent = fs ? 'Salir pantalla completa (F)' : 'Pantalla completa';
    btn.classList.toggle('btn-primary', !fs);
    btn.classList.toggle('btn-danger', fs);
  }
  const topBtn = $('topbarFullscreenBtn');
  if (topBtn) {
    const labelSpan = topBtn.querySelector('span');
    if (labelSpan) labelSpan.textContent = fs ? 'Salir' : 'Pantalla completa';
    else topBtn.textContent = fs ? 'Salir pantalla completa' : 'Pantalla completa';
  }
}

function toggleClassroomFullscreen(forceState) {
  const next = typeof forceState === 'boolean' ? forceState : !state.classroomFullscreen;
  state.classroomFullscreen = next;
  const shell = document.querySelector('.app-shell');
  if (shell) shell.classList.toggle('classroom-fullscreen', next);

  if (next) {
    if (state.pdfView || state.classState.active || state.pdfs.length) {
      setStageLayout('split');
    }
    if (!document.fullscreenElement && document.documentElement.requestFullscreen) {
      document.documentElement.requestFullscreen().catch(() => {});
    }
  } else if (document.fullscreenElement && document.exitFullscreen) {
    document.exitFullscreen().catch(() => {});
  }
  syncFullscreenButtons();
  syncClassBarUi();
}

document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement && state.classroomFullscreen) {
    state.classroomFullscreen = false;
    document.querySelector('.app-shell')?.classList.remove('classroom-fullscreen');
    syncFullscreenButtons();
    syncClassBarUi();
  }
});

function syncClassBarUi() {
  const bar = $('classBar');
  const hasPdfOrClass = Boolean(state.pdfView || state.classState.active || state.classroomFullscreen);
  bar.classList.toggle('visible', hasPdfOrClass);
  if (!hasPdfOrClass) return;

  $('surfaceSplitBtn')?.classList.toggle('active', state.stageSurface === 'split');
  $('surfacePdfBtn')?.classList.toggle('active', state.stageSurface === 'pdf');
  $('surfaceCanvasBtn')?.classList.toggle('active', state.stageSurface === 'canvas');

  const curPage = state.pdfView?.page || state.classState.currentPage || 1;
  const totPages = state.pdfView?.totalPages || state.classState.totalPages || 1;
  $('pdfPageInput').value = curPage;
  $('pdfPageInput').max = totPages;
  $('pdfTotalPages').textContent = totPages;
  $('pdfPrevBtn').disabled = curPage <= 1;
  $('pdfNextBtn').disabled = curPage >= totPages;
  $('pdfNavControls').style.display = state.pdfView ? 'inline-flex' : 'none';

  const pill = $('classStatePill');
  const btn = $('classPauseResumeBtn');
  const bufBadge = $('bufferBadge');

  if (state.classState.active) {
    const ahead = Number(state.classState.bufferedPagesAhead || 0);
    bufBadge.style.display = 'inline-flex';
    bufBadge.textContent = state.classState.prebuffering
      ? 'Pre-cargando...'
      : `Buffer: +${ahead} pág${ahead === 1 ? '' : 's'}`;
    if ($('skipBeatBtn')) $('skipBeatBtn').style.display = state.classState.prebuffering ? 'none' : 'inline-flex';
    if ($('nextPageNowBtn')) $('nextPageNowBtn').style.display = 'inline-flex';
    if ($('verifyRecoverBtn')) $('verifyRecoverBtn').style.display = 'inline-flex';
  } else {
    bufBadge.style.display = 'none';
    if ($('skipBeatBtn')) $('skipBeatBtn').style.display = 'none';
    if ($('nextPageNowBtn')) $('nextPageNowBtn').style.display = 'none';
    if ($('verifyRecoverBtn')) $('verifyRecoverBtn').style.display = state.pdfView ? 'inline-flex' : 'none';
  }

  if (!state.classState.active) {
    pill.dataset.state = 'idle';
    pill.textContent = state.pdfView ? `PDF · Pág. ${curPage}/${totPages}` : 'Aula 2 pantallas';
    btn.style.display = 'none';
    $('bufferBanner').classList.remove('visible');
  } else if (state.classState.prebuffering) {
    pill.dataset.state = 'problem';
    pill.textContent = `Preparando pág. ${curPage}/${totPages}`;
    btn.style.display = 'inline-flex';
    btn.textContent = 'Cancelar';
    btn.className = 'btn btn-sm btn-amber';
  } else if (state.classState.paused) {
    pill.dataset.state = 'paused';
    pill.textContent = `Pausada · Pág. ${curPage}/${totPages}`;
    btn.style.display = 'inline-flex';
    btn.textContent = 'Reanudar';
    btn.className = 'btn btn-sm btn-emerald';
  } else if (state.classState.qaPaused) {
    pill.dataset.state = 'qa';
    pill.textContent = `Respondiendo duda (Pág. ${curPage})`;
    btn.style.display = 'inline-flex';
    btn.textContent = 'Reanudar';
    btn.className = 'btn btn-sm btn-emerald';
  } else if (state.classState.problemActive) {
    pill.dataset.state = 'problem';
    pill.textContent = `Resolviendo problema (Pág. ${curPage})`;
    btn.style.display = 'inline-flex';
    btn.textContent = 'Pausar';
    btn.className = 'btn btn-sm btn-amber';
  } else {
    pill.dataset.state = 'live';
    pill.textContent = `En clase · Pág. ${curPage}/${totPages}`;
    btn.style.display = 'inline-flex';
    btn.textContent = 'Pausar';
    btn.className = 'btn btn-sm btn-amber';
  }
}

function updateReplayBtnState() {
  const hasBoardSvg = Boolean($('boardStageMount')?.querySelector('svg'));
  const hasPdfAnn = Boolean(state.pdfView?.annotations?.length);
  $('replayDrawBtn').disabled = !hasBoardSvg && !hasPdfAnn;
}

function renderPdfStage(pdfData, { animateNewFrom = 0, pacingMs = 0, forceLayout } = {}) {
  state.pdfView = {
    ...pdfData,
    annotations: Array.isArray(pdfData.annotations) ? pdfData.annotations : [],
  };
  if (forceLayout) {
    setStageLayout(forceLayout);
  } else if (state.stageSurface === 'canvas') {
    // Open Dual-Screen Classroom (PDF Left 50% + Live Chalkboard Right 50%) automatically!
    setStageLayout('split');
  }

  $('stageHeaderTitle').textContent = `📄 ${pdfData.name} · Pág. ${pdfData.page}/${pdfData.totalPages}`;

  const wrap = $('pdfStageMount');
  wrap.innerHTML = '';

  const card = document.createElement('article');
  card.className = 'stage-card pdf-stage-card';
  card.innerHTML = `
    <div class="wb-card-head">
      <div style="display:flex; align-items:center; gap:7px; flex-wrap:wrap;">
        <span class="wb-badge">Proyector PDF · Pág. ${pdfData.page} / ${pdfData.totalPages}</span>
        ${pdfData.hasExampleProblem ? `<span class="wb-badge" style="background:var(--amber-soft); color:var(--amber);">Ejemplo / Problema</span>` : ''}
      </div>
      <span class="wb-source">${escapeHtml(pdfData.name)}</span>
    </div>
    <div class="pdf-stage-frame" data-doc-id="${escapeHtml(pdfData.docId)}" data-page="${pdfData.page}">
      <img class="pdf-page-img" src="${escapeHtml(pdfData.imageUrl)}" alt="Página ${pdfData.page} de ${escapeHtml(pdfData.name)}" />
      <div class="pdf-overlay-host">${renderPdfAnnotationsSvg(state.pdfView.annotations, pdfData.vbW || 1000, pdfData.vbH || 750, animateNewFrom)}</div>
    </div>
    <div class="pdf-stage-footer">
      <span>${pdfData.reason ? escapeHtml(pdfData.reason) : 'Diapositiva actual · El profesor dibuja los esquemas en la pizarra de la derecha.'}</span>
      <span id="pdfAnnCountLabel">${state.pdfView.annotations.length ? `${state.pdfView.annotations.length} marca(s) en PDF` : 'Diapositiva limpia'}</span>
    </div>
  `;
  wrap.appendChild(card);

  const frame = card.querySelector('.pdf-stage-frame');
  attachInkCanvas(frame, 'pdf');

  const overlaySvg = frame.querySelector('.pdf-overlay-svg');
  if (state.pdfView.annotations.length > animateNewFrom) {
    animateSvgStrokes(overlaySvg, { onlyNew: animateNewFrom > 0, targetDurationMs: pacingMs });
  }

  updateReplayBtnState();
  syncClassBarUi();
}

function updatePdfAnnotations(data, { pacingMs = 0 } = {}) {
  if (!state.pdfView || state.pdfView.docId !== data.docId || state.pdfView.page !== data.page) {
    if (state.pdfView && state.pdfView.docId === data.docId) {
      state.pdfView.annotations = data.annotations || [];
      renderPdfStage(state.pdfView, { animateNewFrom: 0, pacingMs });
    }
    return;
  }

  const prevCount = data.clearPrevious ? 0 : Math.max(0, (data.annotations?.length || 0) - (data.newlyAddedCount || 0));
  state.pdfView.annotations = data.annotations || [];

  if (!$('pdfStageMount').querySelector('.pdf-stage-frame')) {
    renderPdfStage(state.pdfView, { animateNewFrom: prevCount, pacingMs });
    return;
  }

  const host = $('pdfStageMount').querySelector('.pdf-overlay-host');
  if (host) {
    host.innerHTML = renderPdfAnnotationsSvg(
      state.pdfView.annotations,
      data.vbW || state.pdfView.vbW || 1000,
      data.vbH || state.pdfView.vbH || 750,
      prevCount,
    );
    const svg = host.querySelector('.pdf-overlay-svg');
    if (data.newlyAddedCount > 0) {
      animateSvgStrokes(svg, { onlyNew: !data.clearPrevious, targetDurationMs: pacingMs });
    }
  }
  const lbl = $('pdfAnnCountLabel');
  if (lbl) {
    lbl.textContent = state.pdfView.annotations.length
      ? `${state.pdfView.annotations.length} marca(s) en PDF`
      : 'Diapositiva limpia';
  }
  updateReplayBtnState();
}

// ---------------- Live Progressive Chalkboard (Right Screen) ----------------
function renderChalkNoteItemHtml(entry) {
  const formulaSrc = entry?.formula || entry?.formula_html || '';
  if (!entry || (!entry.note && !formulaSrc)) return '';
  return `
    <div class="chalk-note-item">
      ${entry.note ? `<div class="chalk-note-text">${formatInlineMathHtml(entry.note)}</div>` : ''}
      ${formulaSrc ? `<div class="wb-formula">${renderMathExpressionHtml(formulaSrc)}</div>` : ''}
    </div>
  `;
}

function applyChalkboardUpdate(data, { pacingMs = 0 } = {}) {
  if (!data) return;
  const action = String(data.action || 'new').toLowerCase();
  const tplName = data.template && BLUEPRINT_TEMPLATES[String(data.template).toLowerCase()]
    ? String(data.template).toLowerCase()
    : '';
  const newPrims = Array.isArray(data.primitives) ? data.primitives : [];
  const formulaSrc = String(data.formula || data.formula_html || '').trim();
  const noteEntry = data.note || formulaSrc ? { note: data.note || '', formula: formulaSrc } : null;

  // Ensure Dual-Screen is active when a PDF is loaded so both screens stay visible side-by-side!
  if (state.pdfView && state.stageSurface === 'pdf') {
    setStageLayout('split');
  }

  // Try progressive zero-flicker append onto the active live chalkboard!
  if (action === 'append' && state.activeSceneIdx >= 0 && state.scenes[state.activeSceneIdx]?.kind === 'live_scene') {
    const sc = state.scenes[state.activeSceneIdx];
    const activeTpl = sc.data.template && BLUEPRINT_TEMPLATES[sc.data.template] ? sc.data.template : '';
    const boardMount = $('boardStageMount');
    const svg = boardMount?.querySelector('.precision-svg');
    const layer = svg?.querySelector('.primitives-layer');

    if (Array.isArray(data.variables) && data.variables.length) {
      const existingSyms = new Set((sc.data.variables || []).map((v) => v.symbol));
      const mergedVars = [...(sc.data.variables || [])];
      for (const v of data.variables) {
        if (v?.symbol && !existingSyms.has(v.symbol)) mergedVars.push(v);
      }
      sc.data.variables = mergedVars;
    }
    let dedupNoteEntry = noteEntry;
    if (dedupNoteEntry) {
      const prevFormulas = new Set((sc.data.notes || []).map((n) => String(n?.formula || '').trim()).filter(Boolean));
      const cleanF = String(dedupNoteEntry.formula || '').trim();
      if (cleanF && prevFormulas.has(cleanF)) {
        dedupNoteEntry = dedupNoteEntry.note ? { note: dedupNoteEntry.note, formula: '' } : null;
      }
    }
    if (dedupNoteEntry) {
      sc.data.notes = [...(sc.data.notes || []), dedupNoteEntry];
    }

    // Path A: Parametric Blueprint Layer Append (0.1px exact engineering layers!)
    if (activeTpl && (!tplName || tplName === activeTpl)) {
      const existingLayers = Array.isArray(sc.data.active_layers) ? sc.data.active_layers : [];
      const prevSpec = sc.data.template_spec || {};
      const incomingCurves = Array.isArray(data.curves) ? data.curves : Array.isArray(data.template_spec?.curves) ? data.template_spec.curves : [];
      let mergedCurves = Array.isArray(prevSpec.curves) ? [...prevSpec.curves] : [];
      if (incomingCurves.length) {
        const seen = new Set(mergedCurves.map((c) => `${c.expr || ''}|${c.shape || ''}|${c.label || ''}`));
        for (const c of incomingCurves) {
          const key = `${c?.expr || ''}|${c?.shape || ''}|${c?.label || ''}`;
          if (c && !seen.has(key)) {
            mergedCurves.push(c);
            seen.add(key);
          }
        }
      }
      const mergedSpec = {
        ...prevSpec,
        ...(data.template_spec || {}),
        ...(data.mode ? { mode: data.mode } : {}),
        ...(data.left ? { left: data.left } : {}),
        ...(data.right ? { right: data.right } : {}),
        ...(data.takeaway ? { takeaway: data.takeaway } : {}),
        ...(data.xMin != null ? { xMin: data.xMin } : {}),
        ...(data.xMax != null ? { xMax: data.xMax } : {}),
        ...(data.yMin != null ? { yMin: data.yMin } : {}),
        ...(data.yMax != null ? { yMax: data.yMax } : {}),
        ...(data.xLabel ? { xLabel: data.xLabel } : {}),
        ...(data.yLabel ? { yLabel: data.yLabel } : {}),
        ...(data.frontWeightPct != null ? { frontWeightPct: data.frontWeightPct } : {}),
        ...(data.steerDeg != null ? { steerDeg: data.steerDeg } : {}),
        ...(data.rollDeg != null ? { rollDeg: data.rollDeg } : {}),
        ...(data.camberDeg != null ? { camberDeg: data.camberDeg } : {}),
        ...(mergedCurves.length ? { curves: mergedCurves } : {}),
        labels: { ...(prevSpec.labels || {}), ...(data.labels || {}), ...((data.template_spec || {}).labels || {}) },
      };
      sc.data.template_spec = mergedSpec;

      let reqLayers = Array.isArray(data.add_layers) && data.add_layers.length
        ? [...data.add_layers]
        : Array.isArray(data.layers) ? [...data.layers] : [];
      // If new curves arrived for xy_graph without explicit layer names, automatically reveal curve1/curve2!
      if (activeTpl === 'xy_graph' && incomingCurves.length && !reqLayers.length) {
        if (!existingLayers.includes('curve1')) reqLayers.push('curve1');
        if (mergedCurves.length > 1 && !existingLayers.includes('curve2')) reqLayers.push('curve2');
      }
      const toAdd = reqLayers
        .map((l) => String(l || '').toLowerCase().trim())
        .filter((l) => BLUEPRINT_TEMPLATES[activeTpl].defaultOrder.includes(l) && !existingLayers.includes(l));
      if (toAdd.length) {
        sc.data.active_layers = [...existingLayers, ...toAdd];
      }

      if (svg && layer) {
        if (toAdd.length) {
          const extraMarkup = renderBlueprintLayersMarkup(activeTpl, mergedSpec, toAdd, { prefix: 'cad', markNew: true });
          if (extraMarkup) {
            layer.insertAdjacentHTML('beforeend', extraMarkup);
            animateSvgStrokes(svg, { onlyNew: true, targetDurationMs: pacingMs });
          }
        }
        if (dedupNoteEntry) {
          let notesStream = boardMount.querySelector('.chalk-notes-stream');
          if (!notesStream) {
            notesStream = document.createElement('div');
            notesStream.className = 'chalk-notes-stream';
            boardMount.querySelector('.stage-card')?.appendChild(notesStream);
          }
          const tmp = document.createElement('div');
          tmp.innerHTML = renderChalkNoteItemHtml(dedupNoteEntry).trim();
          if (tmp.firstElementChild) {
            notesStream.appendChild(tmp.firstElementChild);
            tmp.firstElementChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
          }
        }
        const cardRoot = boardMount.querySelector('.stage-card');
        if (cardRoot) sc.exportHtml = cardRoot.outerHTML;
        updateReplayBtnState();
        return;
      }
    }

    // Path B: Custom Primitives Append
    const prevPrims = Array.isArray(sc.data.primitives) ? sc.data.primitives : [];
    const baseCount = prevPrims.length;
    if (newPrims.length) {
      sc.data.primitives = [...prevPrims, ...newPrims];
    }

    if (svg && layer) {
      if (newPrims.length) {
        const ctx = { prefix: 'cad', lastAxes: extractLastAxes(prevPrims) };
        const extraMarkup = newPrims
          .map((p, i) => `<g data-new="1">${renderPrimitiveToSvg(p, baseCount + i, ctx)}</g>`)
          .join('');
        layer.insertAdjacentHTML('beforeend', extraMarkup);
        animateSvgStrokes(svg, { onlyNew: true, targetDurationMs: pacingMs });
      }
      if (noteEntry) {
        let notesStream = boardMount.querySelector('.chalk-notes-stream');
        if (!notesStream) {
          notesStream = document.createElement('div');
          notesStream.className = 'chalk-notes-stream';
          boardMount.querySelector('.stage-card')?.appendChild(notesStream);
        }
        const tmp = document.createElement('div');
        tmp.innerHTML = renderChalkNoteItemHtml(noteEntry).trim();
        if (tmp.firstElementChild) {
          notesStream.appendChild(tmp.firstElementChild);
          tmp.firstElementChild.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      }
      const cardRoot = boardMount.querySelector('.stage-card');
      if (cardRoot) sc.exportHtml = cardRoot.outerHTML;
      updateReplayBtnState();
      return;
    }

    // Fallback if chalkboard wasn't mounted yet
    showScene(state.activeSceneIdx, true, { pacingMs });
    return;
  }

  // Fresh chalkboard sketch for this concept!
  const tplSpec = data.template_spec || {
    mode: data.mode,
    labels: data.labels,
    left: data.left,
    right: data.right,
    takeaway: data.takeaway,
    curves: data.curves,
    xMin: data.xMin,
    xMax: data.xMax,
    yMin: data.yMin,
    yMax: data.yMax,
    xLabel: data.xLabel,
    yLabel: data.yLabel,
    frontWeightPct: data.frontWeightPct,
    steerDeg: data.steerDeg,
    rollDeg: data.rollDeg,
    camberDeg: data.camberDeg,
  };
  const activeLayers = tplName ? normalizeTemplateLayers(tplName, data.layers || data.add_layers, tplSpec) : [];
  const scene = {
    kind: 'live_scene',
    title: data.scene_title || `Pizarra · Pág. ${data.page || state.pdfView?.page || ''}`,
    data: {
      badge: data.badge || 'Pizarra técnica',
      source_ref: data.source_ref || '',
      scene_title: data.scene_title || 'Esquema físico en pizarra',
      template: tplName,
      template_spec: tplSpec,
      active_layers: activeLayers,
      variables: Array.isArray(data.variables) ? data.variables : [],
      primitives: [...newPrims],
      notes: noteEntry ? [noteEntry] : [],
      formula_html: '',
      caption: '',
    },
  };
  pushScene(scene, { pacingMs });
}

// ---------------- Step-by-Step Problem Board (Renders in Right Chalkboard Pane!) ----------------
function renderProblemStepHtml(step) {
  const isFinal = Boolean(step.is_final_step);
  const eqSrc = step.equation || step.equation_html || '';
  return `
    <div class="problem-step-card${isFinal ? ' final-step' : ''}" data-step-num="${step.step_number}">
      <div class="step-header">
        <span class="step-num-badge">${isFinal ? '✓ Resultado' : `Paso ${step.step_number}`}</span>
        <span class="step-title-text">${escapeHtml(step.step_title || '')}</span>
      </div>
      <div class="step-meta-row">
        ${step.goal ? `<div><strong>🎯 Objetivo:</strong> ${escapeHtml(step.goal)}</div>` : ''}
        ${step.why_reason ? `<div><strong>💡 Por qué:</strong> ${escapeHtml(step.why_reason)}</div>` : ''}
      </div>
      ${eqSrc ? `<div class="wb-formula">${renderMathExpressionHtml(eqSrc)}</div>` : ''}
      ${step.algebraic_detail ? `<div class="step-detail"><strong>🔍 Desarrollo:</strong> ${renderMathExpressionHtml(step.algebraic_detail)}</div>` : ''}
    </div>
  `;
}

function startProblemBoard(data, { pacingMs = 0 } = {}) {
  const scene = {
    kind: 'problem_board',
    title: data.problem_title || 'Resolución paso a paso',
    data: {
      ...data,
      primitives: Array.isArray(data.primitives) ? [...data.primitives] : [],
      steps: [],
    },
  };
  pushScene(scene, { pacingMs });
}

function appendProblemBoardStep(stepData, { pacingMs = 0 } = {}) {
  let idx = state.scenes.findIndex((s, i) => i === state.activeSceneIdx && s.kind === 'problem_board');
  if (idx === -1) {
    for (let i = state.scenes.length - 1; i >= 0; i--) {
      if (state.scenes[i].kind === 'problem_board') {
        idx = i;
        break;
      }
    }
  }
  if (idx === -1) {
    startProblemBoard({ problem_title: 'Resolución paso a paso', statement: '' });
    idx = state.scenes.length - 1;
  }

  const sc = state.scenes[idx];
  const prevPrims = Array.isArray(sc.data.primitives) ? sc.data.primitives : [];
  sc.data.steps.push(stepData);

  // Append optional extra diagram primitives to the problem's precision SVG
  if (Array.isArray(stepData.diagram_primitives) && stepData.diagram_primitives.length) {
    sc.data.primitives = [...prevPrims, ...stepData.diagram_primitives];
  }

  // If this problem board is already visible on the chalkboard pane, append smoothly without re-animating earlier steps!
  if ((state.stageSurface === 'split' || state.stageSurface === 'canvas') && state.activeSceneIdx === idx) {
    const boardMount = $('boardStageMount');
    const stream = boardMount?.querySelector('.problem-steps-stream');
    if (stream) {
      const tmp = document.createElement('div');
      tmp.innerHTML = renderProblemStepHtml(stepData).trim();
      const cardEl = tmp.firstElementChild;
      stream.appendChild(cardEl);
      cardEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

      // Live-append new primitives onto diagram if provided
      if (Array.isArray(stepData.diagram_primitives) && stepData.diagram_primitives.length) {
        const layer = boardMount.querySelector('.precision-svg .primitives-layer');
        if (layer) {
          const baseCount = prevPrims.length;
          const ctx = { prefix: 'prob', lastAxes: extractLastAxes(prevPrims) };
          const extraMarkup = stepData.diagram_primitives
            .map((p, i) => `<g data-new="1">${renderPrimitiveToSvg(p, baseCount + i, ctx)}</g>`)
            .join('');
          layer.insertAdjacentHTML('beforeend', extraMarkup);
          animateSvgStrokes(boardMount.querySelector('.precision-svg'), { onlyNew: true, targetDurationMs: pacingMs });
        }
      }

      const cardRoot = boardMount.querySelector('.stage-card');
      if (cardRoot) sc.exportHtml = cardRoot.outerHTML;
      return;
    }
  }

  showScene(idx, false);
}

// ---------------- Scene Manager & Renderers (Right Chalkboard Pane) ----------------
function pushScene(scene, { pacingMs = 0 } = {}) {
  state.scenes.push(scene);
  renderFilmstrip();
  showScene(state.scenes.length - 1, true, { pacingMs });
}

function renderFilmstrip() {
  const strip = $('sceneFilmstrip');
  if (!state.scenes.length) {
    strip.innerHTML = '';
    return;
  }
  strip.innerHTML = '';
  state.scenes.forEach((sc, idx) => {
    const btn = document.createElement('button');
    btn.className = `scene-tab${state.stageSurface !== 'pdf' && idx === state.activeSceneIdx ? ' active' : ''}`;
    btn.textContent = `${idx + 1}. ${sc.title.slice(0, 30)}`;
    btn.addEventListener('click', () => showScene(idx, false));
    strip.appendChild(btn);
  });
}

function showScene(idx, animate, { pacingMs = 0 } = {}) {
  const sc = state.scenes[idx];
  if (!sc) return;
  state.activeSceneIdx = idx;
  // In Dual-Screen mode with a PDF open, keep BOTH screens visible side-by-side!
  if (state.pdfView && state.stageSurface === 'pdf') {
    setStageLayout('split');
  } else if (!state.pdfView) {
    state.stageSurface = 'canvas';
    const dual = $('dualStageContainer');
    if (dual) dual.dataset.layout = 'canvas';
  }
  state.activeLabIframe = null;
  if (!state.pdfView) {
    $('stageHeaderTitle').textContent = `${idx + 1}/${state.scenes.length} · ${sc.title}`;
  }

  const wrap = $('boardStageMount');
  wrap.innerHTML = '';

  const card = document.createElement('article');
  card.className = `stage-card chalkboard-card${sc.kind === 'problem_board' ? ' problem-board' : ''}`;

  if (sc.kind === 'live_scene') {
    const d = sc.data;
    const svgMarkup = buildSceneSvg(d, { prefix: 'cad' });
    const notesHtml = Array.isArray(d.notes) && d.notes.length
      ? `<div class="chalk-notes-stream">${d.notes.map(renderChalkNoteItemHtml).join('')}</div>`
      : '';
    card.innerHTML = `
      <div class="wb-card-head">
        <span class="wb-badge">${escapeHtml(d.badge || 'Pizarra en vivo')}</span>
        ${d.source_ref ? `<span class="wb-source">${escapeHtml(d.source_ref)}</span>` : ''}
      </div>
      <h3>${formatInlineMathHtml(d.scene_title || 'Diagrama en vivo')}</h3>
      ${renderVariableLegendHtml(d.variables)}
      ${svgMarkup ? `<div class="chalk-canvas-wrap">${svgMarkup}</div>` : ''}
      ${d.formula_html || d.formula ? `<div class="wb-formula">${renderMathExpressionHtml(d.formula || d.formula_html)}</div>` : ''}
      ${notesHtml}
      ${d.caption ? `<p class="wb-caption">${escapeHtml(d.caption)}</p>` : ''}
    `;
    wrap.appendChild(card);
    const chalk = card.querySelector('.chalk-canvas-wrap');
    if (chalk) {
      attachInkCanvas(chalk, 'board');
      if (animate) animateSvgStrokes(chalk.querySelector('svg'), { targetDurationMs: pacingMs });
    } else {
      attachInkCanvas(card, 'board');
    }
  } else if (sc.kind === 'problem_board') {
    const d = sc.data;
    const givensHtml =
      (Array.isArray(d.given_data) ? d.given_data : [])
        .map((g) => {
          const col = g.color ? ` var-${escapeHtml(g.color)}` : ' var-cyan';
          return `<span class="given-pill"><span class="${col}">${formatInlineMathHtml(g.symbol)}</span> = ${formatInlineMathHtml(g.value)} ${formatInlineMathHtml(g.unit || '')}</span>`;
        })
        .join('') +
      (d.unknown
        ? `<span class="given-pill unknown-pill">Incógnita: ${formatInlineMathHtml(d.unknown.symbol)} (${formatInlineMathHtml(d.unknown.label || '')})</span>`
        : '');

    const hasDiagram = Boolean(d.template) || (Array.isArray(d.primitives) && d.primitives.length > 0) || Boolean(d.svg_code);
    const svgMarkup = hasDiagram ? buildSceneSvg(d, { prefix: 'prob', compact: true }) : '';
    const stepsHtml = (Array.isArray(d.steps) ? d.steps : []).map(renderProblemStepHtml).join('');

    card.innerHTML = `
      <div class="wb-card-head">
        <span class="wb-badge">Pizarra · Resolución Paso a Paso</span>
        <div style="display:flex; align-items:center; gap:8px;">
          ${d.source_page ? `<span class="wb-source">${escapeHtml(d.source_pdf || 'PDF')} · Pág. ${d.source_page}</span>` : ''}
        </div>
      </div>
      <h3>${escapeHtml(d.problem_title || 'Problema paso a paso')}</h3>
      ${d.statement ? `<div class="problem-statement">${escapeHtml(d.statement)}</div>` : ''}
      ${givensHtml ? `<div class="problem-givens">${givensHtml}</div>` : ''}
      ${renderVariableLegendHtml(d.variables)}
      ${hasDiagram ? `<div class="chalk-canvas-wrap">${svgMarkup}</div>` : ''}
      <div class="problem-steps-stream">${stepsHtml}</div>
    `;
    wrap.appendChild(card);

    const chalk = card.querySelector('.chalk-canvas-wrap');
    if (chalk) {
      attachInkCanvas(chalk, 'board');
      if (animate) animateSvgStrokes(chalk.querySelector('svg'), { targetDurationMs: pacingMs });
    } else {
      attachInkCanvas(card, 'board');
    }
  } else if (sc.kind === 'lab') {
    const d = sc.data;
    card.innerHTML = `
      <div class="wb-card-head">
        <span class="wb-badge" style="background:var(--emerald-soft); color:var(--emerald);">${escapeHtml(d.badge || 'Interactive Lab')}</span>
      </div>
      <h3>${escapeHtml(d.title || 'Interactive Lab')}</h3>
      ${d.description ? `<p class="wb-caption" style="margin:0 0 12px 0;">${escapeHtml(d.description)}</p>` : ''}
      <iframe class="lab-iframe" sandbox="allow-scripts"></iframe>
      <div id="labNote" class="lab-note"></div>
    `;
    wrap.appendChild(card);
    const iframe = card.querySelector('.lab-iframe');
    iframe.srcdoc = buildLabSrcdoc(d.html_body || '');
    state.activeLabIframe = iframe;
  } else if (sc.kind === 'lesson') {
    const d = sc.data;
    const stepsHtml =
      Array.isArray(d.steps) && d.steps.length
        ? `<ol class="wb-steps">${d.steps.map((s) => `<li>${sanitizeRichHtml(s)}</li>`).join('')}</ol>`
        : '';
    card.innerHTML = `
      <div class="wb-card-head">
        <span class="wb-badge">${escapeHtml(d.badge || 'Derivation')}</span>
        ${d.source_ref ? `<span class="wb-source">${escapeHtml(d.source_ref)}</span>` : ''}
      </div>
      <h3>${escapeHtml(d.title || 'Concept')}</h3>
      ${d.intuition ? `<div class="wb-intuition">${sanitizeRichHtml(d.intuition)}</div>` : ''}
      ${d.formula_html || d.formula ? `<div class="wb-formula">${renderMathExpressionHtml(d.formula || d.formula_html)}</div>` : ''}
      ${stepsHtml}
      ${d.common_trap ? `<div class="wb-trap"><strong>Watch out:</strong> ${sanitizeRichHtml(d.common_trap)}</div>` : ''}
    `;
    wrap.appendChild(card);
    attachInkCanvas(card, 'board');
  } else if (sc.kind === 'quiz') {
    const d = sc.data;
    const options = Array.isArray(d.options) ? d.options : [];
    const correctIdx = Number(d.correct_index);
    card.innerHTML = `
      <div class="wb-card-head">
        <span class="wb-badge" style="background:var(--amber-soft); color:var(--amber);">Predict-Then-Reveal Check</span>
      </div>
      <h3>${escapeHtml(d.question || 'Quick Check')}</h3>
      <div class="quiz-options"></div>
      <div class="quiz-explanation">${sanitizeRichHtml(d.explanation || '')}</div>
    `;
    const optWrap = card.querySelector('.quiz-options');
    const expEl = card.querySelector('.quiz-explanation');
    options.forEach((optText, i) => {
      const btn = document.createElement('button');
      btn.className = 'quiz-opt';
      btn.textContent = `${String.fromCharCode(65 + i)}. ${optText}`;
      btn.addEventListener('click', () => {
        const isCorrect = i === correctIdx;
        optWrap.querySelectorAll('.quiz-opt').forEach((b, bi) => {
          b.disabled = true;
          if (bi === correctIdx) b.classList.add('correct');
          else if (bi === i && !isCorrect) b.classList.add('wrong');
        });
        expEl.classList.add('visible');
        if (state.connected && state.ws?.readyState === WebSocket.OPEN) {
          state.ws.send(JSON.stringify({ type: 'quiz_answer', question: d.question, chosenOption: optText, isCorrect }));
        }
      });
      optWrap.appendChild(btn);
    });
    wrap.appendChild(card);
  }

  sc.exportHtml = card.outerHTML;
  updateReplayBtnState();
  renderFilmstrip();
  syncClassBarUi();
}

function showMathBanner(data) {
  const answer = data.ok ? data.stdout || data.result || 'OK' : `Error: ${data.error}`;
  $('mathStripText').textContent = `✓ Python Verified (${data.description}): ${data.code} = ${answer}`;
  $('mathStrip').classList.add('visible');
}

$('closeMathStrip').addEventListener('click', () => $('mathStrip').classList.remove('visible'));

// ---------------- Transcript ----------------
function appendTranscript(role, text, appendToCurrent = false) {
  const list = $('transcriptList');
  if (appendToCurrent && role === 'user' && state.currentUserBubble) {
    state.currentUserBubble.body.textContent += text;
    state.transcript[state.transcript.length - 1].text += text;
    list.scrollTop = list.scrollHeight;
    return;
  }
  if (appendToCurrent && role === 'professor' && state.currentProfBubble) {
    state.currentProfBubble.body.textContent += text;
    state.transcript[state.transcript.length - 1].text += text;
    list.scrollTop = list.scrollHeight;
    const fsCap = $('fsCaptionText');
    if (fsCap && text.trim()) fsCap.textContent = text.trim();
    return;
  }

  if (role === 'user') state.currentProfBubble = null;
  if (role === 'professor') {
    state.currentUserBubble = null;
    const fsCap = $('fsCaptionText');
    if (fsCap && text.trim()) fsCap.textContent = text.trim();
  }

  const el = document.createElement('div');
  el.className = `msg ${role}`;
  if (role !== 'system') {
    const roleLabel = document.createElement('div');
    roleLabel.className = 'msg-role';
    roleLabel.textContent = role === 'user' ? 'Tú' : 'Profesor';
    el.appendChild(roleLabel);
  }
  const body = document.createElement('div');
  body.textContent = text;
  el.appendChild(body);
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;

  state.transcript.push({ role, text, ts: new Date().toLocaleTimeString() });
  if (role === 'user') state.currentUserBubble = { el, body };
  if (role === 'professor') state.currentProfBubble = { el, body };
}

// ---------------- WebSocket Session ----------------
async function connectSession() {
  if (state.engine === 'gemini' && !state.hasApiKey) {
    openApiKeyModal();
    return;
  }

  ensurePlaybackContext();
  setStatus('connecting', state.engine === 'local' ? 'Iniciando profesor local...' : 'Conectando con Gemini Live...');
  $('connectBtn').disabled = true;

  // Avoid opening raw getUserMedia in Local Browser-Speech mode so macOS CoreAudio / AirPods
  // never switch into VoiceProcessingIO/HFP mode and duck/mute professor playback!
  const needsRawMic = state.engine === 'gemini' || $('localSttSelect').value === 'whisper';
  if (needsRawMic) {
    try {
      await startMicCapture();
    } catch (err) {
      setStatus('error', 'Mic blocked');
      appendTranscript('system', `Mic warning: ${err.message}. You can still type questions once connected.`);
    }
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  state.ws = new WebSocket(`${proto}//${location.host}/ws`);

  state.ws.onopen = () => {
    state.ws.send(
      JSON.stringify({
        type: 'start',
        config: {
          engine: state.engine,
          localModel: $('localModelSelect').value,
          localVoice: $('localVoiceSelect').value,
          localThink: $('localThinkCheck').checked,
          model: $('modelSelect').value,
          geminiClassModel: $('geminiClassModelSelect')?.value || 'gemini-4-hydrogen',
          voice: $('voiceSelect').value,
          language: $('langSelect').value,
          mode: state.mode,
          thinkingLevel: $('thinkingSelect').value,
          topic: $('topicInput').value.trim(),
        },
      }),
    );
  };

  state.ws.onmessage = (evt) => {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }

    if (msg.type === 'session_started') {
      state.connected = true;
      state.connectedMode = state.mode;
      $('connectBtn').disabled = false;
      $('connectBtn').textContent = 'Detener';
      $('connectBtn').classList.remove('btn-subtle', 'btn-primary');
      $('connectBtn').classList.add('btn-danger');
      $('muteBtn').disabled = false;
      $('pttBtn').disabled = false;
      $('interruptBtn').disabled = false;

      if (msg.engine === 'local') {
        if ($('localSttSelect').value === 'browser') {
          startLocalBrowserSpeech();
        } else {
          state.pttMode = true;
          $('pttBtn').classList.add('btn-primary');
          $('pttBtn').textContent = 'Espacio Whisper (ON)';
        }
        setStatus('connected', 'Escuchando · Modo local');
        appendTranscript('system', `Sesión local ($0) lista: ${msg.model} · ${msg.voice}.`);
      } else {
        setStatus('connected', 'Escuchando · Pregunta lo que quieras');
        appendTranscript(
          'system',
          msg.resumed
            ? 'Conexión de clase restaurada.'
            : `Clase en directo iniciada (${msg.folderName} · ${msg.model} · ${msg.voice}).`,
        );
      }

      if (state.pendingClassStart) {
        const req = state.pendingClassStart;
        state.pendingClassStart = null;
        state.ws.send(JSON.stringify({ type: 'class_start', ...req }));
      } else if (state.pendingPrompt) {
        const queued = state.pendingPrompt;
        state.pendingPrompt = null;
        appendTranscript('user', queued, false);
        state.ws.send(JSON.stringify({ type: 'text', text: queued, alreadyLogged: true }));
      }
    } else if (msg.type === 'timeline_segment') {
      enqueueTimelineSegment(msg.segment);
    } else if (msg.type === 'timeline_pause') {
      pauseClassTimeline();
    } else if (msg.type === 'timeline_resume') {
      resumeClassTimeline();
    } else if (msg.type === 'timeline_flush') {
      flushAllTimelines();
    } else if (msg.type === 'timeline_skip_beat') {
      skipCurrentBeatNow();
    } else if (msg.type === 'timeline_nudge') {
      // Server watchdog detected a stalled beat -> unblock audio and advance cleanly!
      appendTranscript('system', `⚡ Auto-recuperación en Pág. ${msg.page || state.classState.currentPage}: destrabando siguiente bloque.`);
      ensurePlaybackContext();
      skipCurrentBeatNow();
    } else if (msg.type === 'class_buffer_status') {
      const banner = $('bufferBanner');
      if (msg.prebuffering) {
        banner.classList.add('visible');
        $('bufferBannerText').textContent = msg.message || 'Preparando clase por adelantado...';
        const pct = Math.max(12, Math.min(95, Math.round(((msg.readyPages || 0) / Math.max(1, msg.targetPages || 2)) * 100)));
        $('bufferFill').style.width = `${pct}%`;
        setStatus('thinking', 'Pre-cargando páginas de clase...');
      } else {
        $('bufferFill').style.width = '100%';
        $('bufferBannerText').textContent = msg.message || '¡Clase sincronizada lista!';
        setTimeout(() => banner.classList.remove('visible'), 1100);
      }
    } else if (msg.type === 'audio_out') {
      playPcm24Chunk(msg.data, msg.mimeType);
    } else if (msg.type === 'interrupted') {
      state.qaQueue = [];
      flushPlaybackQueue();
      state.currentProfBubble = null;
      setStatus('connected', 'Interrupted — listening...');
    } else if (msg.type === 'interaction_status') {
      if (msg.status === 'IN_PROGRESS') setStatus('thinking', state.classState.active ? 'Preparando respuesta...' : 'Deep reasoning...');
      else if (msg.status === 'IDLE' && state.activeSources.size === 0 && !state.qaQueue.length && state.connected) {
        setStatus('connected', 'Listening — ask anything');
      }
    } else if (msg.type === 'turn_complete') {
      state.currentUserBubble = null;
      state.currentProfBubble = null;
      state.turnFinishedWaitingAudio = true;
      notifyAudioDrainedIfReady();
    } else if (msg.type === 'class_state') {
      state.classState = { ...state.classState, ...(msg.state || {}) };
      syncClassBarUi();
    } else if (msg.type && msg.type.startsWith('stage_')) {
      applyStageEvent(msg);
    } else if (msg.type === 'input_transcript') {
      appendTranscript('user', msg.text, true);
    } else if (msg.type === 'output_transcript') {
      appendTranscript('professor', msg.text, true);
    } else if (msg.type === 'tool_status') {
      appendTranscript('system', msg.label);
    } else if (msg.type === 'error') {
      setStatus('error', 'Error');
      appendTranscript('system', `Error: ${msg.message}`);
      if (msg.code === 'NO_API_KEY') openApiKeyModal();
    } else if (msg.type === 'session_closed') {
      disconnectSession(msg.reason || 'Class ended');
    }
  };

  state.ws.onclose = () => {
    if (state.connected) disconnectSession('Disconnected');
  };
}

function disconnectSession(label = 'Listo') {
  state.connected = false;
  state.connectedMode = null;
  state.classState.active = false;
  state.classState.paused = false;
  state.classState.qaPaused = false;
  state.classState.prebuffering = false;
  $('bufferBanner').classList.remove('visible');
  flushAllTimelines();
  stopLocalBrowserSpeech();
  stopMicCapture();
  state.whisperChunks = [];
  if (state.ws) {
    try {
      if (state.ws.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'stop' }));
      state.ws.close();
    } catch {}
    state.ws = null;
  }
  $('connectBtn').disabled = false;
  $('connectBtn').textContent = 'Activar voz';
  $('connectBtn').classList.add('btn-subtle');
  $('connectBtn').classList.remove('btn-danger', 'btn-primary');
  $('muteBtn').disabled = true;
  $('pttBtn').disabled = true;
  $('interruptBtn').disabled = true;
  setStatus('idle', label);
  syncClassBarUi();
}

// ---------------- Continuous Class & PDF Controls ----------------
function populatePdfSelector(pdfs) {
  state.pdfs = Array.isArray(pdfs) ? pdfs : [];
  const sel = $('classPdfSelect');
  const prev = sel.value;
  sel.innerHTML = '';
  $('pdfCountBadge').textContent = `${state.pdfs.length} PDF${state.pdfs.length === 1 ? '' : 's'}`;

  if (!state.pdfs.length) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'No hay PDFs en esta carpeta';
    sel.appendChild(opt);
    $('startContinuousClassBtn').disabled = true;
    $('previewPdfBtn').disabled = true;
    return;
  }

  $('startContinuousClassBtn').disabled = false;
  $('previewPdfBtn').disabled = false;

  for (const p of state.pdfs) {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.name} · ${p.pageCount}p`;
    sel.appendChild(opt);
  }
  if (prev && state.pdfs.some((p) => p.id === prev)) {
    sel.value = prev;
  }
}

function selectMode(modeId) {
  state.mode = modeId;
  $('modeGrid').querySelectorAll('.mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === modeId);
  });
}

async function startContinuousClass() {
  ensurePlaybackContext();
  const pdfId = $('classPdfSelect').value;
  if (!pdfId) {
    appendTranscript('system', 'Sube o selecciona un PDF primero para iniciar el Modo Clase.');
    return;
  }
  const startTopic = $('classStartTopic').value.trim();
  const pageVal = Number($('classStartPage').value);
  // If user entered a topic AND left page at 1, let the server jump straight to the topic's page
  const startPage = startTopic && pageVal === 1 ? 0 : Math.max(1, pageVal || 1);

  const needsReconnect = state.connected && state.connectedMode !== 'continuous_class';
  selectMode('continuous_class');
  setStageLayout('split');

  const req = { pdfId, startPage, startTopic };
  if (needsReconnect) {
    disconnectSession('Activando Modo Clase Continua...');
  }
  if (!state.connected) {
    state.pendingClassStart = req;
    await connectSession();
    return;
  }
  flushPlaybackQueue();
  state.ws.send(JSON.stringify({ type: 'class_start', ...req }));
}

$('startContinuousClassBtn').addEventListener('click', startContinuousClass);

$('previewPdfBtn').addEventListener('click', async () => {
  const pdfId = $('classPdfSelect').value;
  if (!pdfId) return;
  const page = Math.max(1, Number($('classStartPage').value) || 1);
  const res = await fetch(`/api/pdf/page-info?id=${encodeURIComponent(pdfId)}&page=${page}`);
  const data = await res.json();
  if (data.imageUrl) {
    renderPdfStage({ ...data, annotations: [] }, { animateNewFrom: 0 });
  }
});

async function navigatePdfPage({ page, delta }) {
  const docId = state.pdfView?.docId || $('classPdfSelect').value;
  if (!docId) return;
  const cur = state.pdfView?.page || 1;
  const tot = state.pdfView?.totalPages || 9999;
  const target = Math.max(1, Math.min(tot, delta != null ? cur + delta : Number(page) || 1));

  if (state.connected && state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(
      JSON.stringify({
        type: 'class_nav_page',
        docId,
        page: target,
        explainNow: state.classState.active && !state.classState.paused && !state.classState.qaPaused,
      }),
    );
    return;
  }

  const res = await fetch(`/api/pdf/page-info?id=${encodeURIComponent(docId)}&page=${target}`);
  const data = await res.json();
  if (data.imageUrl) {
    $('classStartPage').value = data.page;
    renderPdfStage({ ...data, annotations: [] }, { animateNewFrom: 0 });
  }
}

$('pdfPrevBtn').addEventListener('click', () => navigatePdfPage({ delta: -1 }));
$('pdfNextBtn').addEventListener('click', () => navigatePdfPage({ delta: +1 }));
$('pdfPageInput').addEventListener('change', () => navigatePdfPage({ page: Number($('pdfPageInput').value) }));

$('clearPdfAnnBtn').addEventListener('click', () => {
  if (!state.pdfView) return;
  if (state.connected && state.ws?.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify({ type: 'clear_pdf_annotations', docId: state.pdfView.docId, page: state.pdfView.page }));
  } else {
    state.pdfView.annotations = [];
    renderPdfStage(state.pdfView, { animateNewFrom: 0 });
  }
});

$('surfaceSplitBtn')?.addEventListener('click', () => {
  setStageLayout('split');
});

$('surfacePdfBtn').addEventListener('click', () => {
  setStageLayout('pdf');
});

$('surfaceCanvasBtn').addEventListener('click', () => {
  setStageLayout('canvas');
  if (state.scenes.length) {
    showScene(state.activeSceneIdx >= 0 ? state.activeSceneIdx : state.scenes.length - 1, false);
  } else if (!state.pdfView) {
    renderWelcomeBoard();
  } else {
    renderChalkboardReadyPlaceholder();
  }
});

$('classroomFullscreenBtn')?.addEventListener('click', () => toggleClassroomFullscreen());
$('topbarFullscreenBtn')?.addEventListener('click', () => toggleClassroomFullscreen());

$('fsInterruptBtn')?.addEventListener('click', () => {
  triggerInterrupt();
  $('fsQuickAskInput')?.focus();
});

$('fsCaptionToggleBtn')?.addEventListener('click', () => {
  const shell = document.querySelector('.app-shell');
  if (!shell) return;
  const hidden = shell.classList.toggle('captions-hidden');
  $('fsCaptionToggleBtn').textContent = hidden ? '💬 Mostrar Subtítulos' : '💬 Subtítulos';
});

$('fsQuickAskForm')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('fsQuickAskInput');
  const txt = inp?.value.trim();
  if (!txt) return;
  inp.value = '';
  sendPromptText(txt);
});

// Draggable Vertical Splitter (50/50 PDF | Chalkboard — double-click resets to exact 50%)
(() => {
  const splitter = $('stageSplitter');
  const dual = $('dualStageContainer');
  if (!splitter || !dual) return;
  let dragging = false;

  splitter.addEventListener('pointerdown', (e) => {
    if (state.stageSurface !== 'split') return;
    dragging = true;
    splitter.classList.add('dragging');
    splitter.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  splitter.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const rect = dual.getBoundingClientRect();
    if (rect.width < 200) return;
    const pct = Math.max(28, Math.min(72, ((e.clientX - rect.left) / rect.width) * 100));
    dual.style.setProperty('--split-left', `${pct.toFixed(1)}%`);
  });

  const endDrag = () => {
    dragging = false;
    splitter.classList.remove('dragging');
  };
  splitter.addEventListener('pointerup', endDrag);
  splitter.addEventListener('pointercancel', endDrag);
  splitter.addEventListener('dblclick', () => {
    dual.style.setProperty('--split-left', '50%');
  });
})();

$('classPauseResumeBtn').addEventListener('click', () => {
  if (!state.connected || state.ws?.readyState !== WebSocket.OPEN) return;
  if (state.classState.paused || state.classState.qaPaused) {
    state.ws.send(JSON.stringify({ type: 'class_resume' }));
  } else {
    pauseClassTimeline();
    state.ws.send(JSON.stringify({ type: 'class_pause' }));
  }
});

$('skipBeatBtn')?.addEventListener('click', () => {
  ensurePlaybackContext();
  skipCurrentBeatNow();
});

$('nextPageNowBtn')?.addEventListener('click', () => {
  ensurePlaybackContext();
  navigatePdfPage({ delta: +1 });
});

$('verifyRecoverBtn')?.addEventListener('click', () => {
  ensurePlaybackContext();
  if (state.playbackCtx?.state === 'suspended') {
    state.playbackCtx.resume().catch(() => {});
  }
  if (state.connected && state.ws?.readyState === WebSocket.OPEN) {
    state.classTimelinePaused = false;
    state.ws.send(JSON.stringify({ type: 'class_verify_recover' }));
    if (state.classQueue.length > 0 && !state.timelinePumping) {
      pumpTimeline();
    }
  } else {
    fetch('/api/health')
      .then((r) => r.json())
      .then((h) => {
        appendTranscript('system', `✓ Estado sistema: Ollama=${h.ollamaRunning ? 'OK' : 'OFF'} · Kokoro=${h.voiceCapabilities?.kokoro ? 'OK' : 'macOS'} · PDFs=${h.pdfCount}`);
      })
      .catch((e) => appendTranscript('system', `Error verificando servidor: ${e.message}`));
  }
});

// ---------------- UI Event Bindings ----------------
function handlePrimaryStartOrStop() {
  if (state.connected) {
    disconnectSession('Class ended');
  } else if (state.mode === 'continuous_class' && state.pdfs.length) {
    startContinuousClass();
  } else {
    connectSession();
  }
}
$('connectBtn').addEventListener('click', handlePrimaryStartOrStop);
$('orbBtn').addEventListener('click', handlePrimaryStartOrStop);

$('muteBtn').addEventListener('click', () => {
  state.micMuted = !state.micMuted;
  $('muteBtn').textContent = state.micMuted ? 'Activar micro' : 'Silenciar';
  $('muteBtn').classList.toggle('btn-amber', state.micMuted);
  if (state.micMuted && state.ws?.readyState === WebSocket.OPEN) state.ws.send(JSON.stringify({ type: 'audio_end' }));
  setStatus('connected', state.micMuted ? 'Conectado (micro silenciado)' : 'Escuchando · Pregunta lo que quieras');
});

$('pttBtn').addEventListener('click', () => {
  state.pttMode = !state.pttMode;
  $('pttBtn').classList.toggle('btn-primary', state.pttMode);
  $('pttBtn').textContent = state.pttMode ? 'Espacio PTT (ON)' : 'Espacio PTT (OFF)';
  appendTranscript('system', state.pttMode ? 'Modo pulsar para hablar activado: mantén Espacio mientras hablas.' : 'Micrófono manos libres activo.');
});

$('echoBtn').addEventListener('click', () => {
  state.echoShield = !state.echoShield;
  $('echoBtn').classList.toggle('btn-emerald', state.echoShield);
  $('echoBtn').textContent = state.echoShield ? 'Anti-eco: ON' : 'Auriculares: Dúplex';
  appendTranscript(
    'system',
    state.echoShield
      ? 'Protección anti-eco activada: los altavoces no interrumpen al profesor (pulsa Esc cuando quieras preguntar).'
      : 'Modo auriculares activado: puedes hablar en cualquier momento para interrumpir.',
  );
});

function triggerInterrupt() {
  if (!state.connected) return;
  if (state.classState.active) pauseClassTimeline();
  else {
    state.qaQueue = [];
    flushPlaybackQueue();
  }
  state.ws?.send(JSON.stringify({ type: 'interrupt' }));
  setStatus('connected', 'Interrumpido — haz tu pregunta');
}
$('interruptBtn').addEventListener('click', triggerInterrupt);

$('testAudioBtn').addEventListener('click', async () => {
  ensurePlaybackContext();
  const btn = $('testAudioBtn');
  btn.disabled = true;
  btn.textContent = 'Probando...';
  try {
    const res = await fetch('/api/voice/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        voiceId: $('localVoiceSelect').value || 'kokoro:em_alex',
        language: $('langSelect').value === 'en' ? 'en' : 'es',
      }),
    });
    const data = await res.json();
    if (data.ok && data.pcmBase64) {
      playPcm24Chunk(data.pcmBase64, `audio/pcm;rate=${data.sampleRate || 24000}`);
      appendTranscript('system', `🔊 Audio OK (${data.engine} · ${data.sampleRate}Hz · AudioContext=${state.playbackCtx?.state}).`);
    } else {
      appendTranscript('system', '⚠️ El motor de voz devolvió audio vacío. Prueba cambiando Local Voice a macOS Nativo.');
    }
  } catch (err) {
    appendTranscript('system', `Error probando audio: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Probar voz';
  }
});

window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return;
  if ((e.key === 'f' || e.key === 'F') && !e.metaKey && !e.ctrlKey && !e.altKey) {
    e.preventDefault();
    toggleClassroomFullscreen();
    return;
  }
  if ((e.key === 'n' || e.key === 'N') && !e.metaKey && !e.ctrlKey && !e.altKey && state.classState.active) {
    e.preventDefault();
    ensurePlaybackContext();
    skipCurrentBeatNow();
    return;
  }
  if (e.shiftKey && e.key === 'ArrowRight' && state.pdfView) {
    e.preventDefault();
    ensurePlaybackContext();
    navigatePdfPage({ delta: +1 });
    return;
  }
  if (e.shiftKey && e.key === 'ArrowLeft' && state.pdfView) {
    e.preventDefault();
    ensurePlaybackContext();
    navigatePdfPage({ delta: -1 });
    return;
  }
  if (e.code === 'Escape') {
    const openModal = document.querySelector('.modal-backdrop.open');
    if (openModal) {
      e.preventDefault();
      openModal.classList.remove('open');
      return;
    }
    if (state.connected && (state.activeSources.size > 0 || state.classState.active)) {
      e.preventDefault();
      triggerInterrupt();
      return;
    }
    if (state.classroomFullscreen) {
      e.preventDefault();
      toggleClassroomFullscreen(false);
      return;
    }
  }
  const whisperMode = state.engine === 'local' && $('localSttSelect').value === 'whisper';
  if (e.code === 'Space' && (state.pttMode || whisperMode) && state.connected && !state.pttHeld) {
    e.preventDefault();
    state.pttHeld = true;
    state.whisperChunks = [];
    if (state.activeSources.size > 0) flushPlaybackQueue();
    setStatus('connected', whisperMode ? 'Grabando voz (suelta Space)...' : 'Listening (Space held)...');
  }
});
window.addEventListener('keyup', (e) => {
  const whisperMode = state.engine === 'local' && $('localSttSelect').value === 'whisper';
  if (e.code === 'Space' && (state.pttMode || whisperMode) && state.pttHeld) {
    e.preventDefault();
    state.pttHeld = false;
    if (whisperMode) {
      flushWhisperTurn();
      setStatus('thinking', 'Transcribiendo en Apple Silicon...');
    } else {
      state.ws?.send(JSON.stringify({ type: 'audio_end' }));
      setStatus('connected', 'Sent — waiting for professor...');
    }
  }
});

// Stage Toolbar Controls
$('replayDrawBtn').addEventListener('click', () => {
  const boardSvg = state.stageSurface !== 'pdf' ? $('boardStageMount')?.querySelector('svg') : null;
  const pdfSvg = state.stageSurface !== 'canvas' ? $('pdfStageMount')?.querySelector('.pdf-overlay-svg') : null;
  if (boardSvg) animateSvgStrokes(boardSvg, { onlyNew: false });
  if (pdfSvg && state.pdfView?.annotations?.length) animateSvgStrokes(pdfSvg, { onlyNew: false });
});

$('toggleInkBtn').addEventListener('click', () => {
  state.inkEnabled = !state.inkEnabled;
  $('toggleInkBtn').classList.toggle('btn-primary', state.inkEnabled);
  $('penDots').classList.toggle('visible', state.inkEnabled);
  $('dualStageContainer')?.querySelectorAll('.ink-canvas').forEach((ink) => {
    ink.classList.toggle('drawing', state.inkEnabled);
  });
});

$('penDots').addEventListener('click', (e) => {
  const dot = e.target.closest('.pen-dot');
  if (!dot) return;
  $('penDots').querySelectorAll('.pen-dot').forEach((d) => d.classList.remove('active'));
  dot.classList.add('active');
  state.inkColor = dot.dataset.color;
});

$('clearInkBtn').addEventListener('click', () => {
  $('dualStageContainer')?.querySelectorAll('.ink-canvas').forEach((ink) => {
    ink.getContext('2d').clearRect(0, 0, ink.width, ink.height);
  });
  state.hasInkStrokes = false;
  $('sendSketchBtn').style.display = 'none';
  $('clearInkBtn').style.display = 'none';
});

$('sendSketchBtn').addEventListener('click', async () => {
  if (!state.connected) {
    appendTranscript('system', 'Inicia la clase primero para enviar tu trazo al profesor.');
    return;
  }
  const base64 = await captureStageWithInkJpeg();
  if (!base64) return;
  if (state.classState.active && !state.classTimelinePaused) pauseClassTimeline();
  else flushPlaybackQueue();
  state.ws.send(JSON.stringify({ type: 'video_frame', data: base64, mimeType: 'image/jpeg' }));
  state.ws.send(
    JSON.stringify({
      type: 'text',
      text: 'Mira lo que acabo de rodear o señalar en la pantalla y explícame exactamente esa parte.',
    }),
  );
  appendTranscript('system', 'Captura con tu trazo enviada al profesor.');
});

$('clearBoardBtn').addEventListener('click', () => {
  state.scenes = [];
  state.activeSceneIdx = -1;
  state.activeLabIframe = null;
  if (state.pdfView) {
    renderChalkboardReadyPlaceholder();
  } else {
    setStageLayout('canvas');
    $('stageHeaderTitle').textContent = 'Mesa de estudio';
    renderWelcomeBoard();
  }
  updateReplayBtnState();
  renderFilmstrip();
  syncClassBarUi();
});

$('clearTranscriptBtn').addEventListener('click', () => {
  state.transcript = [];
  state.currentUserBubble = null;
  state.currentProfBubble = null;
  $('transcriptList').innerHTML = '';
});

$('modeGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;
  selectMode(btn.dataset.mode);
  if (state.connected) {
    appendTranscript('system', `Seleccionado "${btn.textContent.trim().split('\n')[0]}". Reinicia la clase (o pulsa Iniciar Clase Continua) para aplicar el modo.`);
  }
});

$('modelSelect').addEventListener('change', () => {
  const info = state.models.find((m) => m.id === $('modelSelect').value);
  $('thinkingField').style.display = info?.supportsThinking ? 'block' : 'none';
});

async function sendPromptText(txt) {
  ensurePlaybackContext();
  if (!state.connected) {
    state.pendingPrompt = txt;
    await connectSession();
    return;
  }
  if (state.classState.active && !state.classTimelinePaused) {
    pauseClassTimeline();
  } else {
    state.qaQueue = [];
    flushPlaybackQueue();
  }
  appendTranscript('user', txt, false);
  state.ws.send(JSON.stringify({ type: 'text', text: txt, alreadyLogged: true }));
}

$('textForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const txt = $('textInput').value.trim();
  if (!txt) return;
  $('textInput').value = '';
  sendPromptText(txt);
});

// ---------------- Screen Share & Image ----------------
$('screenShareBtn').addEventListener('click', async () => {
  try {
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 2 }, audio: false });
    $('screenVideo').srcObject = state.screenStream;
    $('visionBox').classList.add('active');
    state.screenStream.getVideoTracks()[0].onended = stopScreenShare;
  } catch (err) {
    appendTranscript('system', `Screen share cancelled: ${err.message}`);
  }
});

function stopScreenShare() {
  if (state.screenStream) {
    state.screenStream.getTracks().forEach((t) => t.stop());
    state.screenStream = null;
  }
  $('screenVideo').srcObject = null;
  $('visionBox').classList.remove('active');
}
$('stopScreenBtn').addEventListener('click', stopScreenShare);

$('snapFrameBtn').addEventListener('click', () => {
  if (!state.connected || !state.screenStream) {
    appendTranscript('system', 'Start Class first to send a screen snapshot.');
    return;
  }
  const video = $('screenVideo');
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 1280 / (video.videoWidth || 1280));
  canvas.width = Math.round((video.videoWidth || 1280) * scale);
  canvas.height = Math.round((video.videoHeight || 720) * scale);
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const base64 = canvas.toDataURL('image/jpeg', 0.82).split(',')[1];
  state.ws.send(JSON.stringify({ type: 'video_frame', data: base64, mimeType: 'image/jpeg' }));
  appendTranscript('system', 'Sent current screen frame to professor.');
});

$('attachImageBtn').addEventListener('click', () => $('imageInput').click());
$('imageInput').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  e.target.value = '';
  if (!state.connected) {
    appendTranscript('system', 'Start Class first before sending an image.');
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const [meta, base64] = String(reader.result || '').split(',');
    const mimeType = meta.match(/data:(.*?);/)?.[1] || 'image/jpeg';
    state.ws.send(JSON.stringify({ type: 'video_frame', data: base64, mimeType }));
    appendTranscript('system', `Sent image "${file.name}" to professor. Ask about it!`);
  };
  reader.readAsDataURL(file);
});

// ---------------- Adaptive Domain Profile & Folder Switching ----------------
function applyDomainProfile(dp) {
  state.domainProfile = dp;
  if (!dp) return;
  state.workspaceRoot = dp.workspaceRoot || state.workspaceRoot;
  $('folderBadgeText').textContent = `${dp.folderName} · ${dp.activeFiles} archivos`;
  $('folderBadgeBtn').title = `Carpeta activa: ${dp.workspaceRoot} — Haz clic para cambiar`;
  if (state.scenes.length === 0 && !state.pdfView) renderWelcomeBoard();
}

function renderWelcomeBoard() {
  const dp = state.domainProfile;
  const wrap = $('boardStageMount');
  wrap.innerHTML = '';
  const box = document.createElement('div');
  box.className = 'empty-board';
  box.id = 'emptyBoard';
  const folderTitle = dp ? dp.folderName : 'Tu aula interactiva está lista';
  const activeCount = dp?.activeFiles || 0;
  const firstPdf = state.pdfs[0];

  box.innerHTML = `
    <div class="welcome-context-pill">
      <span class="welcome-context-dot" aria-hidden="true"></span>
      <span>${activeCount} ${activeCount === 1 ? 'fuente indexada' : 'fuentes indexadas'}</span>
    </div>
    <h1>${escapeHtml(folderTitle)}</h1>
    <p>
      Proyecta tus apuntes a la izquierda mientras el profesor explica en voz alta y dibuja esquemas y fórmulas paso a paso a la derecha.
    </p>
    <div id="welcomeLaunchSlot"></div>
    <div class="welcome-starters-label" id="welcomeStartersLabel" style="display:none;">O empieza con una pregunta directa</div>
    <div class="starter-chips" id="starterChips"></div>
  `;

  const launchSlot = box.querySelector('#welcomeLaunchSlot');
  if (firstPdf) {
    const card = document.createElement('div');
    card.className = 'welcome-launch-card';
    card.innerHTML = `
      <div class="welcome-launch-doc">
        <div class="welcome-doc-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
            <polyline points="14 2 14 8 20 8"/>
            <line x1="16" y1="13" x2="8" y2="13"/>
            <line x1="16" y1="17" x2="8" y2="17"/>
          </svg>
        </div>
        <div class="welcome-doc-meta">
          <div class="welcome-doc-name">${escapeHtml(firstPdf.name)}</div>
          <div class="welcome-doc-sub">${firstPdf.pageCount || 1} páginas · Doble pantalla sincronizada</div>
        </div>
      </div>
      <div class="welcome-launch-actions">
        <button type="button" class="btn btn-primary" id="welcomeStartBtn">Empezar clase</button>
        <button type="button" class="btn btn-subtle" id="welcomeFsBtn" title="Iniciar en pantalla completa">Pantalla completa</button>
      </div>
    `;
    card.querySelector('#welcomeStartBtn').addEventListener('click', startContinuousClass);
    card.querySelector('#welcomeFsBtn').addEventListener('click', () => {
      startContinuousClass();
      toggleClassroomFullscreen(true);
    });
    launchSlot.appendChild(card);
  } else {
    const card = document.createElement('div');
    card.className = 'welcome-launch-card';
    card.innerHTML = `
      <div class="welcome-launch-doc">
        <div class="welcome-doc-icon" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
            <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
            <line x1="12" x2="12" y1="19" y2="22"/>
          </svg>
        </div>
        <div class="welcome-doc-meta">
          <div class="welcome-doc-name">Sesión interactiva por voz y pizarra</div>
          <div class="welcome-doc-sub">Sube un PDF a la izquierda o empieza hablando directamente</div>
        </div>
      </div>
      <div class="welcome-launch-actions">
        <button type="button" class="btn btn-primary" id="welcomeVoiceBtn">Activar voz</button>
      </div>
    `;
    card.querySelector('#welcomeVoiceBtn').addEventListener('click', connectSession);
    launchSlot.appendChild(card);
  }

  const chipBox = box.querySelector('#starterChips');
  const starters = dp?.suggestedStarters || [];
  if (starters.length) {
    box.querySelector('#welcomeStartersLabel').style.display = 'block';
  }
  starters.forEach((st) => {
    const btn = document.createElement('button');
    btn.className = 'chip';
    btn.textContent = st.label;
    btn.addEventListener('click', () => sendPromptText(st.prompt));
    chipBox.appendChild(btn);
  });
  wrap.appendChild(box);
}

// Switch Folder Modal
$('folderBadgeBtn').addEventListener('click', () => {
  $('folderPathInput').value = state.workspaceRoot || '';
  $('folderModalStatus').textContent = '';
  $('folderModal').classList.add('open');
  $('folderPathInput').focus();
});
$('closeFolderModalBtn').addEventListener('click', () => $('folderModal').classList.remove('open'));
$('switchFolderBtn').addEventListener('click', async () => {
  const folderPath = $('folderPathInput').value.trim();
  if (!folderPath) return;
  $('folderModalStatus').textContent = 'Scanning folder & adapting domain expert...';
  const res = await fetch('/api/folder', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folderPath }),
  });
  const data = await res.json();
  if (data.ok) {
    state.pdfView = null;
    populatePdfSelector(data.pdfs || []);
    applyDomainProfile(data.domainProfile);
    renderFileList(data.files || []);
    $('folderModal').classList.remove('open');
    appendTranscript('system', `Adapted expert to folder "${data.domainProfile.folderName}" (${data.domainProfile.activeFiles} files).`);
    if (state.connected) {
      disconnectSession('Folder switched — click Start Class');
    }
    syncClassBarUi();
  } else {
    $('folderModalStatus').textContent = data.error || 'Could not open folder.';
  }
});

// ---------------- Study Materials ----------------
async function loadMaterials() {
  const res = await fetch('/api/materials');
  const data = await res.json();
  if (data.pdfs) populatePdfSelector(data.pdfs);
  if (data.domainProfile) applyDomainProfile(data.domainProfile);
  renderFileList(data.files || []);
}

function renderFileList(files) {
  $('fileCountBadge').textContent = `${files.filter((f) => f.active).length}/${files.length}`;
  const list = $('fileList');
  list.innerHTML = '';
  for (const f of files) {
    const label = document.createElement('label');
    label.className = 'file-item';
    label.innerHTML = `
      <input type="checkbox" ${f.active ? 'checked' : ''} />
      <div class="file-meta">
        <div class="file-name">${escapeHtml(f.name)}</div>
        <div class="file-sub">${escapeHtml(f.relPath)} · ${(f.size / 1024).toFixed(0)} KB</div>
      </div>
    `;
    const cb = label.querySelector('input');
    cb.addEventListener('change', async () => {
      await fetch('/api/materials/toggle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: f.id, active: cb.checked }),
      });
      loadMaterials();
    });
    list.appendChild(label);
  }
}

async function uploadStudyFiles(fileList) {
  for (const file of fileList) {
    const buf = await file.arrayBuffer();
    const base64 = arrayBufferToBase64(buf);
    appendTranscript('system', `Indexing "${file.name}"...`);
    const res = await fetch('/api/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: file.name, base64 }),
    });
    const data = await res.json();
    if (data.ok) {
      if (data.pdfs) populatePdfSelector(data.pdfs);
      if (data.domainProfile) applyDomainProfile(data.domainProfile);
      renderFileList(data.files);
      appendTranscript('system', `Ready: "${file.name}" (${data.file.pageCount} page/sheet(s) indexed).`);
    }
  }
}

const dropzone = $('dropzone');
dropzone.addEventListener('click', () => $('fileInput').click());
$('fileInput').addEventListener('change', (e) => {
  if (e.target.files?.length) uploadStudyFiles(e.target.files);
  e.target.value = '';
});
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('dragover'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('dragover');
  if (e.dataTransfer.files?.length) uploadStudyFiles(e.dataTransfer.files);
});

// ---------------- API Key Modal ----------------
function openApiKeyModal() {
  $('settingsModal')?.classList.remove('open');
  $('apiKeyModal').classList.add('open');
  $('apiKeyInput').focus();
}
$('apiKeyBtn').addEventListener('click', openApiKeyModal);
$('closeModalBtn').addEventListener('click', () => $('apiKeyModal').classList.remove('open'));
$('saveApiKeyBtn').addEventListener('click', async () => {
  const key = $('apiKeyInput').value.trim();
  if (!key) {
    $('apiKeyStatus').textContent = 'Please paste a valid Gemini API key.';
    return;
  }
  const res = await fetch('/api/apikey', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apiKey: key }),
  });
  const data = await res.json();
  if (data.ok) {
    state.hasApiKey = true;
    $('apiKeyInput').value = '';
    $('apiKeyStatus').textContent = 'Saved globally!';
    setStatus('idle', 'Ready to start class');
    setTimeout(() => $('apiKeyModal').classList.remove('open'), 450);
  } else {
    $('apiKeyStatus').textContent = data.error || 'Could not save key.';
  }
});

// ---------------- Export Entire Live Class as Self-Contained Study HTML ----------------
$('exportBtn').addEventListener('click', () => {
  const folder = state.domainProfile?.folderName || 'Study Session';
  const title = $('topicInput').value.trim() ? `${folder} — ${$('topicInput').value.trim()}` : `${folder} — Live Professor Notes`;
  const scenesHtml =
    state.scenes
      .map((sc, i) => {
        if (sc.kind === 'lab') {
          return `<section class="card"><h2>${i + 1}. ${escapeHtml(sc.title)} (Interactive Lab)</h2><iframe style="width:100%;min-height:440px;border:1px solid #cbd5e1;border-radius:10px;" sandbox="allow-scripts" srcdoc="${escapeHtml(buildLabSrcdoc(sc.data.html_body || ''))}"></iframe></section>`;
        }
        return `<section class="card">${sc.exportHtml || ''}</section>`;
      })
      .join('\n') || '<p>No whiteboard scenes yet.</p>';

  const transcriptHtml = state.transcript
    .filter((t) => t.role !== 'system')
    .map((t) => `<div class="t-row ${t.role}"><strong>${t.role === 'user' ? 'Student' : 'Professor'} (${t.ts}):</strong> ${escapeHtml(t.text)}</div>`)
    .join('\n');

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif; max-width: 920px; margin: 0 auto; padding: 36px 24px 72px; background: #f6f4ef; color: #1b2028; line-height: 1.62; }
  h1 { font-size: 26px; letter-spacing: -0.02em; margin: 0 0 6px; }
  h2 { font-size: 18px; letter-spacing: -0.015em; margin: 28px 0 12px; color: #1b2028; }
  .meta { color: #535c6b; font-size: 13px; margin-bottom: 28px; }
  .card { background: #ffffff; border: 1px solid #e3ded4; border-radius: 14px; padding: 20px 24px; margin-bottom: 18px; box-shadow: 0 2px 10px rgba(27,32,40,0.05); }
  .wb-badge { display: inline-block; padding: 3px 10px; border-radius: 999px; font-size: 11px; font-weight: 620; background: rgba(37,99,235,0.09); color: #2563eb; }
  .wb-intuition { border: 1px solid rgba(37,99,235,0.28); background: rgba(37,99,235,0.07); border-radius: 8px; padding: 11px 14px; margin: 12px 0; }
  .wb-formula { background: #f5f2eb; border: 1px solid #e3ded4; border-radius: 10px; padding: 15px 18px; font-family: Georgia, serif; font-size: 20px; text-align: center; margin: 12px 0; }
  .chalk-canvas-wrap { background: #0f1724; border: 1px solid #233046; border-radius: 12px; padding: 14px; color: #e9eef6; }
  .frac { display: inline-flex; flex-direction: column; align-items: center; vertical-align: middle; margin: 0 3px; line-height: 1.15; }
  .frac .num { border-bottom: 1.5px solid currentColor; padding: 0 4px 2px; }
  .frac .den { padding: 2px 4px 0; }
  .var-cyan { color: #2563eb; font-weight: 650; }
  .var-amber { color: #b45309; font-weight: 650; }
  .var-emerald { color: #0d8560; font-weight: 650; }
  .var-rose { color: #c81e42; font-weight: 650; }
  .var-legend, .problem-givens { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0 12px; }
  .var-chip, .given-pill { padding: 3px 9px; border-radius: 999px; font-size: 12px; background: #efece5; border: 1px solid #e3ded4; }
  .problem-step-card { padding: 14px 16px; border-radius: 10px; background: #fcfbf8; border: 1px solid #e3ded4; margin-top: 12px; }
  .problem-step-card.final-step { border-color: rgba(13,133,96,0.35); background: rgba(13,133,96,0.08); }
  .step-detail { margin-top: 8px; padding: 8px 12px; border-radius: 8px; background: #efece5; }
  .wb-trap { background: rgba(217,119,6,0.10); border: 1px solid rgba(180,83,9,0.30); border-radius: 8px; padding: 10px 14px; margin-top: 12px; }
  svg { width: 100%; height: auto; max-height: 490px; }
  svg * { stroke-dashoffset: 0 !important; opacity: 1 !important; }
  .ink-canvas, .laser-pointer, .return-pdf-inline-btn { display: none !important; }
  .quiz-options { display: grid; gap: 6px; margin: 10px 0; }
  .quiz-opt { padding: 8px 12px; border: 1px solid #cdc6b8; border-radius: 8px; background: #fcfbf8; color: #1b2028; text-align: left; }
  .quiz-opt.correct { background: rgba(13,133,96,0.12); border-color: #0d8560; }
  .quiz-explanation { display: block !important; background: rgba(13,133,96,0.10); border: 1px solid rgba(13,133,96,0.28); border-radius: 8px; padding: 10px 14px; margin-top: 10px; }
  .t-row { padding: 10px 14px; border-radius: 10px; margin-bottom: 8px; background: #ffffff; border: 1px solid #e3ded4; }
  .t-row.user { background: rgba(37,99,235,0.08); border-color: rgba(37,99,235,0.28); }
</style>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <div class="meta">Apuntes exportados desde Profesor IA · ${new Date().toLocaleString()}</div>
  <h2>Pizarras, problemas resueltos y laboratorios</h2>
  ${scenesHtml}
  <h2>Transcripción de la clase</h2>
  ${transcriptHtml || '<p>No se registró transcripción en esta sesión.</p>'}
</body>
</html>`;

  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'professor-class'}.html`;
  a.click();
  URL.revokeObjectURL(url);
});

// ---------------- Engine Switcher & Ollama Controls ----------------
function updateEngineSummaryBadge() {
  const badge = $('engineSummaryBadge');
  if (!badge) return;
  if (state.engine === 'local') {
    const modelName = $('localModelSelect')?.value || 'Ollama';
    badge.textContent = state.ollama.running ? `Local · ${modelName}` : 'Local · Offline';
  } else {
    const clsModel = $('geminiClassModelSelect')?.value || $('modelSelect')?.value || 'Gemini';
    const shortName = clsModel.replace(/^gemini-/, '').replace(/-/g, ' ');
    badge.textContent = `Cloud · ${shortName}`;
  }
}

function applyEngineUi(engine) {
  state.engine = engine;
  $('engineGrid').querySelectorAll('.mode-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.engine === engine);
  });
  $('localEngineFields').style.display = engine === 'local' ? 'block' : 'none';
  $('geminiEngineFields').style.display = engine === 'gemini' ? 'block' : 'none';
  updateEngineSummaryBadge();
  if (!state.connected) {
    if (engine === 'local') {
      setStatus('idle', state.ollama.running ? 'Listo' : 'Ollama inactivo');
    } else {
      setStatus('idle', state.hasApiKey ? 'Listo' : 'Falta API Key');
    }
  }
}

$('localModelSelect')?.addEventListener('change', updateEngineSummaryBadge);
$('geminiClassModelSelect')?.addEventListener('change', updateEngineSummaryBadge);
$('modelSelect')?.addEventListener('change', updateEngineSummaryBadge);

$('engineGrid').addEventListener('click', (e) => {
  const btn = e.target.closest('.mode-btn');
  if (!btn) return;
  const next = btn.dataset.engine;
  if (next === state.engine) return;
  if (state.connected) disconnectSession('Switched engine — click Start Class');
  applyEngineUi(next);
});

function populateOllamaModels(ollama) {
  state.ollama = ollama || { running: false, models: [] };
  const sel = $('localModelSelect');
  const prev = sel.value;
  sel.innerHTML = '';

  const installedNames = new Set((state.ollama.models || []).map((m) => m.name));
  $('ollamaBadge').textContent = state.ollama.running ? '· Online' : '· Offline';
  $('ollamaBadge').style.color = state.ollama.running ? 'var(--emerald)' : 'var(--rose)';

  const sortedInstalled = [...(state.ollama.models || [])].sort((a, b) => {
    const pref = (n) => (n.startsWith('gemma4:12b') ? 1 : n.startsWith('qwen3.5:9b') ? 2 : n.startsWith('qwen3') ? 3 : 9);
    return pref(a.name) - pref(b.name);
  });

  for (const m of sortedInstalled) {
    const opt = document.createElement('option');
    opt.value = m.name;
    const visTag = m.vision ? '👁 Visión' : '📝 Texto';
    opt.textContent = `${m.name} (${m.sizeGb} GB · ${visTag})`;
    sel.appendChild(opt);
  }
  if (!sortedInstalled.length) {
    const opt = document.createElement('option');
    opt.value = 'gemma4:12b';
    opt.textContent = state.ollama.running ? 'No models installed — pull below' : 'Start Ollama first';
    sel.appendChild(opt);
  } else if (prev && installedNames.has(prev)) {
    sel.value = prev;
  }
  updateEngineSummaryBadge();

  const pullBar = $('quickPullBar');
  pullBar.innerHTML = '';
  for (const rec of state.recommendedLocalModels || []) {
    const hasIt = Array.from(installedNames).some((n) => n === rec.id || n.startsWith(`${rec.id}:`));
    if (!hasIt && state.ollama.running) {
      const btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.style.fontSize = '11px';
      btn.textContent = `↓ Install ${rec.id}`;
      btn.title = rec.note;
      btn.addEventListener('click', () => pullModelFromUi(rec.id, btn));
      pullBar.appendChild(btn);
    }
  }
}

async function pullModelFromUi(modelName, btn) {
  btn.disabled = true;
  const prog = $('pullProgress');
  prog.style.display = 'block';
  prog.textContent = `Downloading ${modelName}...`;
  try {
    const res = await fetch('/api/ollama/pull', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName }),
    });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);
          if (evt.total && evt.completed) {
            const pct = Math.round((evt.completed / evt.total) * 100);
            prog.textContent = `Downloading ${modelName}: ${pct}% (${(evt.completed / 1e9).toFixed(1)}/${(evt.total / 1e9).toFixed(1)} GB)`;
          } else if (evt.status) {
            prog.textContent = `${modelName}: ${evt.status}`;
          }
          if (evt.error) throw new Error(evt.error);
        } catch {}
      }
    }
    prog.textContent = `✓ ${modelName} listo para usar en local ($0)!`;
    const stRes = await fetch('/api/ollama/status');
    const stData = await stRes.json();
    populateOllamaModels(stData.ollama);
    $('localModelSelect').value = modelName;
  } catch (err) {
    prog.textContent = `Error downloading ${modelName}: ${err.message}`;
    btn.disabled = false;
  }
}

// ---------------- Boot ----------------
async function init() {
  const res = await fetch('/api/config');
  const cfg = await res.json();
  state.hasApiKey = cfg.hasApiKey;
  state.models = cfg.models || [];
  state.workspaceRoot = cfg.workspaceRoot || '';
  state.recommendedLocalModels = cfg.recommendedLocalModels || [];
  state.voiceCapabilities = cfg.voiceCapabilities || state.voiceCapabilities;

  const modelSel = $('modelSelect');
  for (const m of state.models) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    modelSel.appendChild(opt);
  }

  const classModelSel = $('geminiClassModelSelect');
  if (classModelSel) {
    for (const cm of cfg.classModels || []) {
      const opt = document.createElement('option');
      opt.value = cm.id;
      opt.textContent = cm.label;
      classModelSel.appendChild(opt);
    }
  }

  const voiceSel = $('voiceSelect');
  for (const v of cfg.voices || []) {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.label;
    voiceSel.appendChild(opt);
  }

  const localVoiceSel = $('localVoiceSelect');
  for (const lv of cfg.localVoices || []) {
    const opt = document.createElement('option');
    opt.value = lv.id;
    opt.textContent = lv.label;
    localVoiceSel.appendChild(opt);
  }
  if (!state.voiceCapabilities.kokoro) {
    localVoiceSel.value = 'macos:Mónica';
    $('voiceCapBadge').textContent = '· macOS Nativo';
  } else {
    localVoiceSel.value = 'kokoro:em_alex';
    $('voiceCapBadge').textContent = '· Kokoro Neural READY';
    $('voiceCapBadge').style.color = 'var(--emerald)';
  }

  populateOllamaModels(cfg.ollama);
  populatePdfSelector(cfg.pdfs || []);

  if (cfg.domainProfile) applyDomainProfile(cfg.domainProfile);
  await loadMaterials();

  applyEngineUi(cfg.ollama?.running ? 'local' : 'gemini');
}

init();
