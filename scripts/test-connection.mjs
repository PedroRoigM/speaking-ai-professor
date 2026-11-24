import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { GoogleGenAI, Modality, StartSensitivity, EndSensitivity } from '@google/genai';
import { getProfessorToolDeclarations, buildSystemInstruction } from '../lib/professorConfig.mjs';

async function loadKey() {
  if (process.env.GEMINI_API_KEY) return process.env.GEMINI_API_KEY.trim();
  const candidates = [
    path.resolve('Speaking_AI_Professor/.env'),
    path.resolve('.env'),
    path.join(os.homedir(), '.config', 'speaking-professor', '.env'),
  ];
  for (const p of candidates) {
    try {
      const raw = await fs.readFile(p, 'utf8');
      const m = raw.match(/^GEMINI_API_KEY=(.+)$/m);
      if (m && m[1].trim() && m[1].trim() !== 'your_gemini_api_key_here') {
        return m[1].trim().replace(/^['"]|['"]$/g, '');
      }
    } catch {}
  }
  return '';
}

const apiKey = await loadKey();
if (!apiKey) {
  console.log('NO_API_KEY_FOUND');
  process.exit(0);
}

const ai = new GoogleGenAI({
  apiKey,
  apiVersion: 'v1beta',
  httpOptions: { apiVersion: 'v1beta' },
});
const orig = ai.apiClient.getWebsocketBaseUrl.bind(ai.apiClient);
ai.apiClient.getWebsocketBaseUrl = () => orig().replace(/\/+$/, '');

const tests = [
  { model: 'gemini-3.8-live', thinking: false },
  { model: 'gemini-3.8-live-extended-thinking', thinking: true },
];

for (const t of tests) {
  console.log(`\nTesting FULL professor config on: ${t.model}`);
  const config = {
    responseModalities: [Modality.AUDIO],
    speechConfig: {
      voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Fenrir' } },
    },
    systemInstruction: {
      parts: [{ text: buildSystemInstruction({ mode: 'folder_expert', language: 'es', catalogSummary: 'Test catalog' }) }],
    },
    tools: getProfessorToolDeclarations(),
    realtimeInputConfig: {
      automaticActivityDetection: {
        startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
        endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
        prefixPaddingMs: 300,
        silenceDurationMs: 950,
      },
    },
    inputAudioTranscription: {},
    outputAudioTranscription: {},
    contextWindowCompression: { slidingWindow: {} },
    sessionResumption: {},
  };
  if (t.thinking) {
    config.thinkingConfig = { thinkingLevel: 'medium' };
  }

  await new Promise((resolve) => {
    let done = false;
    let sessionRef = null;
    const finish = (status, detail) => {
      if (done) return;
      done = true;
      console.log(`  -> ${status}: ${detail}`);
      resolve();
    };
    const timer = setTimeout(() => finish('TIMEOUT', 'No setupComplete in 8s'), 8000);
    ai.live
      .connect({
        model: t.model,
        config,
        callbacks: {
          onopen: () => console.log('  [WS opened]'),
          onmessage: (msg) => {
            if (msg.setupComplete) {
              clearTimeout(timer);
              finish('SUCCESS', 'FULL setupComplete accepted with all 8 tools!');
              try { sessionRef?.close(); } catch {}
            }
          },
          onerror: (err) => {
            clearTimeout(timer);
            finish('ERROR', err?.message || String(err));
          },
          onclose: (evt) => {
            clearTimeout(timer);
            finish('CLOSED', `code=${evt?.code} reason=${evt?.reason || '(none)'}`);
          },
        },
      })
      .then((s) => {
        sessionRef = s;
        if (done) {
          try { s.close(); } catch {}
        }
      })
      .catch((err) => {
        clearTimeout(timer);
        finish('CONNECT_ERR', err?.message || String(err));
      });
  });
}

// Verify Interactions API across current non-deprecated models (with 503 fallback check)
const aiInt = new GoogleGenAI({ apiKey });
let intPassed = false;
for (const m of ['gemini-4-hydrogen', 'gemini-3.5-flash-lite', 'gemini-4-argon']) {
  console.log(`\nTesting Interactions API on: ${m}`);
  try {
    const inter = await aiInt.interactions.create({
      model: m,
      system_instruction: 'Reply ONLY with valid JSON: {"ok":true}',
      input: 'Ping test',
      store: false,
      generation_config: { max_output_tokens: 80 },
    });
    console.log('  -> SUCCESS:', (inter.output_text || '').trim().slice(0, 140));
    intPassed = true;
    break;
  } catch (err) {
    console.log('  -> TRANSIENT/ERR:', String(err?.message || err).slice(0, 140));
  }
}
if (!intPassed) process.exitCode = 1;
