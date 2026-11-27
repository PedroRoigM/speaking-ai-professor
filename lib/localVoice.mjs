import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import readline from 'node:readline';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { getVenvPythonPath, isMac, isWindows, isLinux } from './platformTools.mjs';

const execFileAsync = promisify(execFile);

export const NEURAL_HD_VOICES = [
  { id: 'edge:es-ES-AlvaroNeural', engine: 'edge', voice: 'es-ES-AlvaroNeural', lang: 'es', label: 'Neural Natural — Álvaro (Español España · masculino · 0 MB)' },
  { id: 'edge:es-ES-ElviraNeural', engine: 'edge', voice: 'es-ES-ElviraNeural', lang: 'es', label: 'Neural Natural — Elvira (Español España · femenino · 0 MB)' },
  { id: 'edge:es-MX-JorgeNeural', engine: 'edge', voice: 'es-MX-JorgeNeural', lang: 'es', label: 'Neural Natural — Jorge (Español LATAM · masculino · 0 MB)' },
  { id: 'edge:es-MX-DaliaNeural', engine: 'edge', voice: 'es-MX-DaliaNeural', lang: 'es', label: 'Neural Natural — Dalia (Español LATAM · femenino · 0 MB)' },
  { id: 'edge:en-US-AndrewNeural', engine: 'edge', voice: 'en-US-AndrewNeural', lang: 'en', label: 'Neural Natural — Andrew (English · male · 0 MB)' },
  { id: 'edge:en-US-AvaNeural', engine: 'edge', voice: 'en-US-AvaNeural', lang: 'en', label: 'Neural Natural — Ava (English · female · 0 MB)' },
];

const KOKORO_VOICES = [
  { id: 'kokoro:em_alex', engine: 'kokoro', voice: 'em_alex', lang: 'e', label: 'Kokoro Offline — Alex (Español masculino · 100% sin red)' },
  { id: 'kokoro:ef_dora', engine: 'kokoro', voice: 'ef_dora', lang: 'e', label: 'Kokoro Offline — Dora (Español femenino · 100% sin red)' },
  { id: 'kokoro:am_fenrir', engine: 'kokoro', voice: 'am_fenrir', lang: 'a', label: 'Kokoro Offline — Fenrir (English male · 100% offline)' },
  { id: 'kokoro:af_heart', engine: 'kokoro', voice: 'af_heart', lang: 'a', label: 'Kokoro Offline — Heart (English female · 100% offline)' },
];

const MACOS_NATIVE_VOICES = [
  { id: 'macos:Mónica', engine: 'macos', voice: 'Mónica', lang: 'es', label: 'macOS Offline — Mónica / Mejorada (Español · sin red)' },
  { id: 'macos:Paulina', engine: 'macos', voice: 'Paulina', lang: 'es', label: 'macOS Offline — Paulina (Español MX · sin red)' },
  { id: 'macos:Samantha', engine: 'macos', voice: 'Samantha', lang: 'en', label: 'macOS Offline — Samantha (English · offline)' },
];

const WINDOWS_NATIVE_VOICES = [
  { id: 'windows:es', engine: 'windows', voice: 'es', lang: 'es', label: 'Windows Offline (OneCore/SAPI) — Español · sin red' },
  { id: 'windows:en', engine: 'windows', voice: 'en', lang: 'en', label: 'Windows Offline (OneCore/SAPI) — English · offline' },
];

const LINUX_NATIVE_VOICES = [
  { id: 'linux:es', engine: 'linux', voice: 'es', lang: 'es', label: 'Linux Offline (espeak-ng) — Español · sin red' },
  { id: 'linux:en', engine: 'linux', voice: 'en', lang: 'en', label: 'Linux Offline (espeak-ng) — English · offline' },
];

export function getLocalVoicesForPlatform(platform = process.platform) {
  if (platform === 'win32') return [...NEURAL_HD_VOICES, ...KOKORO_VOICES, ...WINDOWS_NATIVE_VOICES];
  if (platform === 'linux') return [...NEURAL_HD_VOICES, ...KOKORO_VOICES, ...LINUX_NATIVE_VOICES];
  return [...NEURAL_HD_VOICES, ...KOKORO_VOICES, ...MACOS_NATIVE_VOICES];
}

export const LOCAL_VOICES = getLocalVoicesForPlatform(process.platform);

export function getDefaultNativeVoiceId(_platform = process.platform) {
  return 'edge:es-ES-AlvaroNeural';
}

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
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(dataLen, 40);
  return Buffer.concat([header, pcmBuffer]);
}

/**
 * Parses a standard RIFF WAV buffer (macOS `say`, Windows SAPI, Linux `espeak-ng`)
 * returning mono 16-bit PCM bytes + exact sampleRate from the `fmt ` chunk.
 */
export function extractWavPcmAndRate(wavBuf, fallbackRate = 24000) {
  if (!wavBuf || wavBuf.length < 44 || wavBuf.toString('ascii', 0, 4) !== 'RIFF') {
    return { pcm: wavBuf || Buffer.alloc(0), sampleRate: fallbackRate };
  }
  let sampleRate = fallbackRate;
  let channels = 1;
  let bitsPerSample = 16;
  let pcm = wavBuf.subarray(44);

  let offset = 12;
  while (offset + 8 <= wavBuf.length) {
    const id = wavBuf.toString('ascii', offset, offset + 4);
    const size = wavBuf.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    const chunkEnd = Math.min(wavBuf.length, chunkStart + size);
    if (id === 'fmt ' && size >= 16 && chunkStart + 16 <= wavBuf.length) {
      channels = wavBuf.readUInt16LE(chunkStart + 2) || 1;
      sampleRate = wavBuf.readUInt32LE(chunkStart + 4) || fallbackRate;
      bitsPerSample = wavBuf.readUInt16LE(chunkStart + 14) || 16;
    } else if (id === 'data') {
      pcm = wavBuf.subarray(chunkStart, chunkEnd);
    }
    offset = chunkStart + size + (size % 2);
  }

  // Downmix stereo 16-bit PCM to mono cleanly if an OS TTS outputs 2 channels
  if (channels === 2 && bitsPerSample === 16 && pcm.length >= 4) {
    const frames = Math.floor(pcm.length / 4);
    const mono = Buffer.allocUnsafe(frames * 2);
    for (let i = 0; i < frames; i++) {
      const l = pcm.readInt16LE(i * 4);
      const r = pcm.readInt16LE(i * 4 + 2);
      mono.writeInt16LE(Math.round((l + r) / 2), i * 2);
    }
    pcm = mono;
  }

  return { pcm, sampleRate };
}

export class LocalVoiceEngine {
  constructor({ appDir }) {
    this.appDir = appDir;
    const unpackedDir = String(appDir || '').replace(/app\.asar(?=[\\/]|$)/, 'app.asar.unpacked');
    this.venvPython = getVenvPythonPath(unpackedDir);
    this.workerScript = path.join(unpackedDir, 'lib', 'voice_worker.py');
    this.worker = null;
    this.workerReady = false;
    this.capabilities = {
      edgeNeural: true,
      kokoro: false,
      kokoroBackend: null,
      whisper: false,
      whisperBackend: null,
      macosSay: isMac(),
      windowsSapi: isWindows(),
      linuxEspeak: false,
      nativeOsTts: isMac() || isWindows(),
      platform: process.platform,
    };
    this.preferredMacVoices = { es: 'Mónica', en: 'Samantha' };
    this.pending = new Map();
    this.reqSeq = 1;
  }

  async checkLinuxEspeak() {
    if (!isLinux()) return false;
    for (const bin of ['espeak-ng', 'espeak']) {
      try {
        await execFileAsync(bin, ['--version'], { timeout: 2500 });
        return true;
      } catch {}
    }
    return false;
  }

  async init() {
    const hasLinuxEspeak = await this.checkLinuxEspeak();
    this.capabilities.linuxEspeak = hasLinuxEspeak;
    this.capabilities.nativeOsTts = isMac() || isWindows() || hasLinuxEspeak;

    try {
      await fs.access(this.venvPython);
      await this.startWorker();
    } catch {
      // No .venv installed — native OS TTS (macOS say / Windows SAPI / Linux espeak-ng) remains ready
    }
    return this.capabilities;
  }

  async startWorker() {
    if (this.worker && this.workerReady) return this.capabilities;
    return new Promise((resolve) => {
      const env = { ...process.env };
      if (isMac()) {
        env.PATH = `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`;
        env.PHONEMIZER_ESPEAK_LIBRARY = process.env.PHONEMIZER_ESPEAK_LIBRARY || '/opt/homebrew/lib/libespeak-ng.dylib';
        env.ESPEAK_DATA_PATH = process.env.ESPEAK_DATA_PATH || '/opt/homebrew/share/espeak-ng-data';
      }
      const child = spawn(this.venvPython, [this.workerScript], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env,
        windowsHide: true,
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
            ...this.capabilities,
            kokoro: Boolean(msg.capabilities?.kokoro),
            kokoroBackend: msg.capabilities?.kokoroBackend || null,
            whisper: Boolean(msg.capabilities?.whisper),
            whisperBackend: msg.capabilities?.whisperBackend || null,
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
    return extractWavPcmAndRate(wavBuf).pcm;
  }

  async synthesizeEdgeNeural(text, voiceName = 'es-ES-AlvaroNeural', speed = 1.02) {
    const deltaPct = Math.max(-18, Math.min(25, Math.round((Number(speed || 1.02) - 1.0) * 100)));
    const rateStr = `${deltaPct >= 0 ? '+' : ''}${deltaPct}%`;
    const tts = new MsEdgeTTS();
    try {
      await Promise.race([
        tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3),
        new Promise((_, rej) => setTimeout(() => rej(new Error('Edge TTS metadata timeout')), 6500)),
      ]);
      const { audioStream } = tts.toStream(text, { rate: rateStr });
      const chunks = [];
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Edge TTS stream timeout')), 11000);
        audioStream.on('data', (c) => chunks.push(c));
        audioStream.on('end', () => {
          clearTimeout(timer);
          resolve();
        });
        audioStream.on('error', (err) => {
          clearTimeout(timer);
          reject(err);
        });
      });
      const mp3Buf = Buffer.concat(chunks);
      if (mp3Buf.length < 128) {
        throw new Error('Edge TTS returned empty audio');
      }
      // 48 kbps mono MP3 = 6000 bytes/sec
      const durationMs = Math.max(700, Math.round((mp3Buf.length / 6000) * 1000));
      return {
        ok: true,
        sampleRate: 24000,
        pcmBase64: mp3Buf.toString('base64'),
        audioMime: 'audio/mpeg',
        durationMs,
        engine: `neural-hd (${voiceName})`,
      };
    } catch (err) {
      return { ok: false, error: err.message || 'Edge Neural TTS failed', pcmBase64: '', sampleRate: 24000 };
    } finally {
      try { tts.close(); } catch {}
    }
  }

  async resolveBestMacVoice(requested = 'Mónica', lang = 'es') {
    if (this._macVoicesScanned) {
      return requested === 'Mónica' && lang === 'es' ? this.preferredMacVoices.es : requested;
    }
    this._macVoicesScanned = true;
    try {
      const { stdout } = await execFileAsync('/usr/bin/say', ['-v', '?'], { timeout: 3000 });
      const lines = String(stdout || '').split(/\r?\n/);
      const findBest = (patterns) => {
        for (const re of patterns) {
          const hit = lines.find((l) => re.test(l));
          if (hit) {
            const name = hit.split(/\s{2,}/)[0]?.trim();
            if (name) return name;
          }
        }
        return null;
      };
      const bestEs = findBest([
        /Marisol \(Premium\)/i,
        /Marisol \(Enhanced\)/i,
        /M[oó]nica \(Enhanced\)/i,
        /Jorge \(Enhanced\)/i,
        /Paulina \(Enhanced\)/i,
        /^Marisol\s/i,
        /^M[oó]nica\s/i,
      ]);
      const bestEn = findBest([/Ava \(Premium\)/i, /Samantha \(Enhanced\)/i, /Daniel \(Enhanced\)/i, /^Samantha\s/i]);
      if (bestEs) this.preferredMacVoices.es = bestEs;
      if (bestEn) this.preferredMacVoices.en = bestEn;
    } catch {}
    return lang === 'en' ? this.preferredMacVoices.en : this.preferredMacVoices.es;
  }

  async synthesizeMacOsSay(text, voiceName = 'Mónica', speed = 1.02) {
    const wavPath = path.join(os.tmpdir(), `prof-say-${crypto.randomBytes(6).toString('hex')}.wav`);
    const rate = Math.max(165, Math.min(215, Math.round(188 * Number(speed || 1.02))));
    const langHint = /samantha|ava|daniel|alex/i.test(voiceName) ? 'en' : 'es';
    const bestVoice = await this.resolveBestMacVoice(voiceName, langHint);
    try {
      await execFileAsync(
        '/usr/bin/say',
        ['-v', bestVoice, '-r', String(rate), '--file-format=WAVE', '--data-format=LEI16@24000', '-o', wavPath, text],
        { timeout: 15000 },
      );
      const wavBuf = await fs.readFile(wavPath);
      const { pcm, sampleRate } = extractWavPcmAndRate(wavBuf, 24000);
      return { ok: true, sampleRate, pcmBase64: pcm.toString('base64'), audioMime: 'audio/pcm', engine: `macos (${bestVoice})` };
    } finally {
      fs.unlink(wavPath).catch(() => {});
    }
  }

  /**
   * Zero-install native Windows TTS via built-in .NET System.Speech.Synthesis (SAPI).
   * Passes speech text strictly via UTF-8 Base64 environment variable (zero shell injection risk).
   */
  async synthesizeWindowsSapi(text, lang = 'es', speed = 1.02) {
    const wavPath = path.join(os.tmpdir(), `prof-sapi-${crypto.randomBytes(6).toString('hex')}.wav`);
    const sapiRate = Math.max(-4, Math.min(4, Math.round((Number(speed || 1.02) - 1.0) * 14)));
    const culturePrefix = lang === 'en' ? 'en' : 'es';
    const psScript = [
      'Add-Type -AssemblyName System.Speech',
      '$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer',
      '$voices = $synth.GetInstalledVoices() | Where-Object { $_.Enabled }',
      `$match = $voices | Where-Object { $_.VoiceInfo.Culture.TwoLetterISOLanguageName -eq '${culturePrefix}' } | Select-Object -First 1`,
      'if ($match) { $synth.SelectVoice($match.VoiceInfo.Name) }',
      `$synth.Rate = ${sapiRate}`,
      '$synth.SetOutputToWaveFile($env:PROF_TTS_WAV)',
      '$txt = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String($env:PROF_TTS_TEXT_B64))',
      '$synth.Speak($txt)',
      '$synth.Dispose()',
    ].join('; ');

    try {
      await execFileAsync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', psScript],
        {
          timeout: 20000,
          windowsHide: true,
          env: {
            ...process.env,
            PROF_TTS_WAV: wavPath,
            PROF_TTS_TEXT_B64: Buffer.from(text, 'utf8').toString('base64'),
          },
        },
      );
      const wavBuf = await fs.readFile(wavPath);
      const { pcm, sampleRate } = extractWavPcmAndRate(wavBuf, 22050);
      return { ok: true, sampleRate, pcmBase64: pcm.toString('base64'), engine: 'windows-sapi' };
    } catch (err) {
      return { ok: false, error: `Windows SAPI TTS error: ${err.message}`, pcmBase64: '', sampleRate: 22050 };
    } finally {
      fs.unlink(wavPath).catch(() => {});
    }
  }

  /**
   * Native Linux TTS via espeak-ng / espeak writing PCM WAV directly.
   */
  async synthesizeLinuxEspeak(text, lang = 'es', speed = 1.02) {
    const wavPath = path.join(os.tmpdir(), `prof-espeak-${crypto.randomBytes(6).toString('hex')}.wav`);
    const wpm = Math.max(140, Math.min(210, Math.round(168 * Number(speed || 1.02))));
    const voiceFlag = lang === 'en' ? 'en-us' : 'es';
    try {
      let ok = false;
      for (const bin of ['espeak-ng', 'espeak']) {
        try {
          await execFileAsync(bin, ['-v', voiceFlag, '-s', String(wpm), '-w', wavPath, '--', text], { timeout: 15000 });
          ok = true;
          break;
        } catch {}
      }
      if (!ok) {
        return { ok: false, error: 'Install espeak-ng (`sudo apt install espeak-ng`) for local Linux voice.', pcmBase64: '', sampleRate: 22050 };
      }
      const wavBuf = await fs.readFile(wavPath);
      const { pcm, sampleRate } = extractWavPcmAndRate(wavBuf, 22050);
      return { ok: true, sampleRate, pcmBase64: pcm.toString('base64'), engine: 'linux-espeak' };
    } finally {
      fs.unlink(wavPath).catch(() => {});
    }
  }

  async synthesize(rawText, { voiceId = 'edge:es-ES-AlvaroNeural', language = 'auto', speed = 1.03 } = {}) {
    const text = cleanTextForSpeech(rawText);
    if (!text) return { ok: true, pcmBase64: '', audioMime: 'audio/pcm', sampleRate: 24000 };

    const allKnown = [
      ...NEURAL_HD_VOICES,
      ...KOKORO_VOICES,
      ...MACOS_NATIVE_VOICES,
      ...WINDOWS_NATIVE_VOICES,
      ...LINUX_NATIVE_VOICES,
    ];
    const meta = allKnown.find((v) => v.id === voiceId) || NEURAL_HD_VOICES[0];

    let chosenVoice = meta.voice;
    let chosenLang = meta.lang;
    const engine = meta.engine;
    const clampedSpeed = Math.max(0.88, Math.min(1.16, Number(speed) || 1.03));

    // 1. Lightweight studio-quality Neural HD voices (0 MB on disk, Windows + macOS + Linux!)
    if (engine === 'edge') {
      if (language === 'en' && chosenLang === 'es') {
        chosenVoice = /Elvira|Dalia/i.test(chosenVoice) ? 'en-US-AvaNeural' : 'en-US-AndrewNeural';
        chosenLang = 'en';
      } else if (language === 'es' && chosenLang === 'en') {
        chosenVoice = /Ava/i.test(chosenVoice) ? 'es-ES-ElviraNeural' : 'es-ES-AlvaroNeural';
        chosenLang = 'es';
      }
      const edgeRes = await this.synthesizeEdgeNeural(text, chosenVoice, clampedSpeed);
      if (edgeRes.ok && edgeRes.pcmBase64 && edgeRes.pcmBase64.length > 64) {
        return edgeRes;
      }
      console.error('[Edge Neural TTS offline fallback]', edgeRes.error || 'empty audio');
      // If offline, fall through to Kokoro (if installed) or native OS voice seamlessly!
    }

    // 2. Local 100% offline Kokoro-82M Neural TTS (if installed)
    if ((engine === 'kokoro' || engine === 'edge') && this.capabilities.kokoro) {
      let kVoice = engine === 'kokoro' ? chosenVoice : 'em_alex';
      let kLang = engine === 'kokoro' ? chosenLang : 'e';
      if (language === 'en' && kLang === 'e') {
        kVoice = 'am_fenrir';
        kLang = 'a';
      } else if (language === 'es' && kLang === 'a') {
        kVoice = 'em_alex';
        kLang = 'e';
      }
      const res = await this.sendWorkerRequest({
        cmd: 'tts',
        text,
        voice: kVoice,
        lang_code: kLang,
        speed: clampedSpeed,
      });
      if (res.ok && res.pcmBase64 && res.pcmBase64.length > 64) {
        return {
          ok: true,
          pcmBase64: res.pcmBase64,
          audioMime: 'audio/pcm',
          sampleRate: res.sampleRate || 24000,
          engine: `kokoro-${this.capabilities.kokoroBackend || 'neural'}`,
        };
      }
      if (!res.ok) {
        console.error('[Kokoro fallback -> native OS TTS]', res.error || 'empty audio');
      }
    }

    // 3. Zero-fail offline OS TTS fallback (macOS Enhanced/say · Windows SAPI · Linux espeak-ng)
    const targetLang = language === 'en' || chosenLang === 'a' || chosenLang === 'en' ? 'en' : 'es';
    if (isWindows()) {
      return this.synthesizeWindowsSapi(text, targetLang, clampedSpeed);
    }
    if (isLinux()) {
      return this.synthesizeLinuxEspeak(text, targetLang, clampedSpeed);
    }
    const macVoice = engine === 'macos' ? chosenVoice : targetLang === 'en' ? 'Samantha' : 'Mónica';
    return this.synthesizeMacOsSay(text, macVoice, clampedSpeed);
  }

  async transcribePcm16(pcm16Base64, { language = 'auto' } = {}) {
    if (!this.capabilities.whisper) {
      return { ok: false, error: 'Local Whisper is not installed yet (use Browser mic or install voice extras).' };
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
