// PCM16 capture + playback helpers for OpenAI Realtime voice.

const TARGET_SAMPLE_RATE = 24000;

const WORKLET_SRC = `
class PCMCapture extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;
    const ch = input[0];
    const out = new Int16Array(ch.length);
    for (let i = 0; i < ch.length; i++) {
      const s = Math.max(-1, Math.min(1, ch[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    this.port.postMessage(out.buffer, [out.buffer]);
    return true;
  }
}
registerProcessor("pcm-capture", PCMCapture);
`;

export interface MicCapture {
  stop: () => void;
  setMuted: (m: boolean) => void;
}

export async function startMicCapture(onChunk: (base64: string) => void): Promise<MicCapture> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    },
  });

  const ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  const blob = new Blob([WORKLET_SRC], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);

  const src = ctx.createMediaStreamSource(stream);
  const node = new AudioWorkletNode(ctx, "pcm-capture");

  let muted = false;

  node.port.onmessage = (e) => {
    if (muted) return;
    const buf = e.data as ArrayBuffer;
    onChunk(arrayBufferToBase64(buf));
  };

  src.connect(node);
  // worklet must connect to destination to pull audio; route to a muted gain so user doesn't hear themselves
  const muteGain = ctx.createGain();
  muteGain.gain.value = 0;
  node.connect(muteGain);
  muteGain.connect(ctx.destination);

  return {
    stop: () => {
      stream.getTracks().forEach((t) => t.stop());
      node.disconnect();
      src.disconnect();
      ctx.close();
    },
    setMuted: (m) => {
      muted = m;
    },
  };
}

export class PcmPlayer {
  private ctx: AudioContext;
  private gain: GainNode;
  private nextStart = 0;
  private resumePromise: Promise<void> | null = null;

  constructor() {
    this.ctx = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
    this.gain = this.ctx.createGain();
    this.gain.gain.value = 1.0;
    this.gain.connect(this.ctx.destination);
  }

  async resume() {
    if (this.ctx.state === "running") return;
    if (!this.resumePromise) {
      this.resumePromise = this.ctx.resume().catch(() => undefined);
    }
    await this.resumePromise;
    this.resumePromise = null;
  }

  push(base64: string) {
    const bytes = base64ToBytes(base64);
    if (bytes.byteLength === 0) return;
    const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    const f32 = new Float32Array(i16.length);
    for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 0x8000;

    const buf = this.ctx.createBuffer(1, f32.length, TARGET_SAMPLE_RATE);
    buf.copyToChannel(f32, 0);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain);

    if (this.ctx.state !== "running") {
      // schedule a resume; first chunk may drop but subsequent chunks will play
      void this.resume();
    }

    const now = this.ctx.currentTime;
    const start = Math.max(now, this.nextStart);
    src.start(start);
    this.nextStart = start + buf.duration;
  }

  setMuted(muted: boolean) {
    this.gain.gain.value = muted ? 0 : 1.0;
  }

  reset() {
    this.nextStart = this.ctx.currentTime;
  }

  close() {
    this.ctx.close();
  }
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
