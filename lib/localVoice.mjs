import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export const LOCAL_VOICES = [
  { id: 'kokoro:em_alex', engine: 'kokoro', voice: 'em_alex', lang: 'e', label: 'Kokoro Neural — Alex (Español masculino)' },
  { id: 'kokoro:ef_dora', engine: 'kokoro', voice: 'ef_dora', lang: 'e', label: 'Kokoro Neural — Dora (Español femenino)' },
  { id: 'kokoro:am_fenrir', engine: 'kokoro', voice: 'am_fenrir', lang: 'a', label: 'Kokoro Neural — Fenrir (English male)' },
  { id: 'kokoro:af_heart', engine: 'kokoro', voice: 'af_heart', lang: 'a', label: 'Kokoro Neural — Heart (English female)' },
  { id: 'macos:Mónica', engine: 'macos', voice: 'Mónica', lang: 'es', label: 'macOS Nativo — Mónica (Español · 0 MB)' },
  { id: 'macos:Paulina', engine: 'macos', voice: 'Paulina', lang: 'es', label: 'macOS Nativo — Paulina (Español MX · 0 MB)' },
  { id: 'macos:Samantha', engine: 'macos', voice: 'Samantha', lang: 'en', label: 'macOS Nativo — Samantha (English · 0 MB)' },
];

export function cleanTextForSpeech(raw) {
  return String(raw || '')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<think>[\s\S]*?<\/think>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[*_`#~]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildWavFromPcm16(pcmBuffer, sampleRate = 16000) {
  const header = Buffer.alloc(44);
  const dataLen = pcmBuffer.length;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLen, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16); // PCM chunk size
  header.writeUInt16LE(1, 20); // PCM format
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28); // byte rate
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcmBuffer]);
}

export class LocalVoiceEngine {
  constructor({ appDir }) {
    this.appDir = appDir;
    this.venvPython = path.join(appDir, '.venv', 'bin', 'python');
    this.workerScript = path.join(appDir, 'lib', 'voice_worker.py');
    this.worker = null;
    this.workerReady = false;
    this.capabilities = { kokoro: false, whisper: false, macosSay: true };
    this.pending = new Map();
    this.reqSeq = 1;
  }

  async init() {
    try {
      await fs.access(this.venvPython);
      await this.startWorker();
    } catch {
      this.capabilities = { kokoro: false, whisper: false, macosSay: true };
    }
    return this.capabilities;
  }

  async startWorker() {
    if (this.worker && this.workerReady) return this.capabilities;
    return new Promise((resolve) => {
      const env = {
        ...process.env,
        PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`,
        PHONEMIZER_ESPEAK_LIBRARY: process.env.PHONEMIZER_ESPEAK_LIBRARY || '/opt/homebrew/lib/libespeak-ng.dylib',
        ESPEAK_DATA_PATH: process.env.ESPEAK_DATA_PATH || '/opt/homebrew/share/espeak-ng-data',
      };
      const child = spawn(this.venvPython, [this.workerScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
      });
      this.worker = child;
      let resolved = false;
      const done = (caps) => {
        if (resolved) return;
        resolved = true;
        resolve(caps);
      };

      const timer = setTimeout(() => done(this.capabilities), 6000);
      const rl = readline.createInterface({ input: child.stdout });

      rl.on('line', (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (msg.type === 'ready') {
          clearTimeout(timer);
          this.workerReady = true;
          this.capabilities = {
            kokoro: Boolean(msg.capabilities?.kokoro),
            whisper: Boolean(msg.capabilities?.whisper),
            macosSay: true,
          };
          done(this.capabilities);
          return;
        }
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          res(msg);
        }
      });

      child.stderr.on('data', (d) => {
        const text = d.toString('utf8').trim();
        if (text && !text.includes('Fetching')) {
          // Quietly log real worker errors only
          console.error('[LocalVoice stderr]', text.slice(0, 300));
        }
      });

      child.on('exit', () => {
        this.worker = null;
        this.workerReady = false;
        for (const [, p] of this.pending) {
          p.resolve({ ok: false, error: 'Voice worker exited' });
        }
        this.pending.clear();
        clearTimeout(timer);
        done(this.capabilities);
      });
    });
  }

  sendWorkerRequest(payload, timeoutMs = 45000) {
    if (!this.worker || !this.workerReady) {
      return Promise.resolve({ ok: false, error: 'Voice worker not running' });
    }
    const id = this.reqSeq++;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: 'Voice worker timed out' });
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (res) => {
          clearTimeout(timer);
          resolve(res);
        },
      });
      this.worker.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
    });
  }

  extractPcmFromWav(wavBuf) {
    // Proper RIFF chunk walk (handles Apple afconvert/say FLLR/JUNK chunks cleanly)
    if (wavBuf.length < 44 || wavBuf.toString('ascii', 0, 4) !== 'RIFF') {
      return wavBuf;
    }
    let offset = 12;
    while (offset + 8 <= wavBuf.length) {
      const id = wavBuf.toString('ascii', offset, offset + 4);
      const size = wavBuf.readUInt32LE(offset + 4);
      if (id === 'data') {
        return wavBuf.subarray(offset + 8, Math.min(wavBuf.length, offset + 8 + size));
      }
      offset += 8 + size + (size % 2);
    }
    return wavBuf.subarray(44);
  }

  async synthesizeMacOsSay(text, voiceName = 'Mónica', speed = 1.02) {
    const wavPath = path.join(os.tmpdir(), `prof-say-${crypto.randomBytes(6).toString('hex')}.wav`);
    const rate = Math.max(165, Math.min(215, Math.round(188 * Number(speed || 1.02))));
    try {
      await execFileAsync(
        '/usr/bin/say',
        ['-v', voiceName, '-r', String(rate), '--file-format=WAVE', '--data-format=LEI16@24000', '-o', wavPath, text],
        { timeout: 15000 },
      );
      const wavBuf = await fs.readFile(wavPath);
      const pcm = this.extractPcmFromWav(wavBuf);
      return { ok: true, sampleRate: 24000, pcmBase64: pcm.toString('base64'), engine: 'macos' };
    } finally {
      fs.unlink(wavPath).catch(() => {});
    }
  }

  async synthesize(rawText, { voiceId = 'kokoro:em_alex', language = 'auto', speed = 1.03 } = {}) {
    const text = cleanTextForSpeech(rawText);
    if (!text) return { ok: true, pcmBase64: '', sampleRate: 24000 };

    const meta = LOCAL_VOICES.find((v) => v.id === voiceId) || LOCAL_VOICES[0];

    // Pick smart language voice if auto
    let chosenVoice = meta.voice;
    let chosenLang = meta.lang;
    let engine = meta.engine;
    const clampedSpeed = Math.max(0.88, Math.min(1.16, Number(speed) || 1.03));

    if (engine === 'kokoro' && this.capabilities.kokoro) {
      if (language === 'en' && chosenLang === 'e') {
        chosenVoice = 'am_fenrir';
        chosenLang = 'a';
      } else if (language === 'es' && chosenLang === 'a') {
        chosenVoice = 'em_alex';
        chosenLang = 'e';
      }
      const res = await this.sendWorkerRequest({
        cmd: 'tts',
        text,
        voice: chosenVoice,
        lang_code: chosenLang,
        speed: clampedSpeed,
      });
      if (res.ok && res.pcmBase64 && res.pcmBase64.length > 64) {
        return { ok: true, pcmBase64: res.pcmBase64, sampleRate: res.sampleRate || 24000, engine: 'kokoro' };
      }
      if (!res.ok) {
        console.error('[Kokoro fallback -> macOS]', res.error || 'empty audio');
      }
    }

    // Automatic zero-fail macOS native fallback
    const macVoice =
      engine === 'macos'
        ? chosenVoice
        : language === 'en' || chosenLang === 'a'
          ? 'Samantha'
          : 'Mónica';
    return this.synthesizeMacOsSay(text, macVoice, clampedSpeed);
  }

  async transcribePcm16(pcm16Base64, { language = 'auto' } = {}) {
    if (!this.capabilities.whisper) {
      return { ok: false, error: 'mlx-whisper is not installed yet.' };
    }
    const pcmBuf = Buffer.from(pcm16Base64, 'base64');
    const wavBuf = buildWavFromPcm16(pcmBuf, 16000);
    return this.sendWorkerRequest(
      {
        cmd: 'stt',
        wavBase64: wavBuf.toString('base64'),
        language: language === 'es' || language === 'en' ? language : null,
      },
      30000,
    );
  }

  warmup() {
    if (this.capabilities.kokoro && this.workerReady) {
      this.sendWorkerRequest({ cmd: 'warmup' }, 30000).catch(() => {});
    }
  }

  shutdown() {
    if (this.worker) {
      try {
        this.worker.kill();
      } catch {}
      this.worker = null;
      this.workerReady = false;
    }
  }
}
