// AudioWorkletProcessor that captures microphone Float32 audio,
// resamples cleanly to 16kHz mono Int16 PCM, and emits ~40ms frames
// plus live RMS amplitude for visual feedback.

class Pcm16CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.buffer = [];
    this.frameSize = 640; // 40ms @ 16kHz -> ultra-low latency streaming
    this.resampleCarry = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;

    const channel = input[0];
    const ratio = sampleRate / this.targetRate;

    if (Math.abs(ratio - 1) < 0.001) {
      for (let i = 0; i < channel.length; i++) {
        this.buffer.push(channel[i]);
      }
    } else {
      // Linear-interpolated downsampling from native hardware rate (e.g. 48kHz) to 16kHz
      let pos = this.resampleCarry;
      while (pos < channel.length) {
        const idx = Math.floor(pos);
        const frac = pos - idx;
        const s0 = channel[idx];
        const s1 = idx + 1 < channel.length ? channel[idx + 1] : s0;
        this.buffer.push(s0 + (s1 - s0) * frac);
        pos += ratio;
      }
      this.resampleCarry = pos - channel.length;
    }

    while (this.buffer.length >= this.frameSize) {
      const chunk = this.buffer.splice(0, this.frameSize);
      const pcm16 = new Int16Array(this.frameSize);
      let sumSq = 0;
      for (let i = 0; i < this.frameSize; i++) {
        const clamped = Math.max(-1, Math.min(1, chunk[i]));
        sumSq += clamped * clamped;
        pcm16[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
      }
      const rms = Math.sqrt(sumSq / this.frameSize);
      this.port.postMessage({ pcm16: pcm16.buffer, rms }, [pcm16.buffer]);
    }

    return true;
  }
}

registerProcessor('pcm16-capture-processor', Pcm16CaptureProcessor);
