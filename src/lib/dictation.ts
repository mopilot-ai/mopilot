// Dictation engines and audio helpers. No store or native imports, so node tests can load it.
import { noteIgnored } from './ignored';

export type DictationEngine = 'local' | 'chatgpt' | 'credits';

export const DICTATION_ENGINES: { value: DictationEngine; label: string; desc: string }[] = [
  {
    value: 'local',
    label: 'This Mac',
    desc: 'On-device speech recognition. Audio stays on this Mac. System language uses your macOS locale',
  },
  { value: 'chatgpt', label: 'ChatGPT account', desc: 'Transcribed by ChatGPT, like the official app' },
  { value: 'credits', label: 'MoPilot credits', desc: 'Transcribed through MoPilot and billed to your credits' },
];

/** 16-bit mono PCM WAV of `samples` (floats in -1..1). */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return out;
}

const SPEECH_RATE = 16000;

/** A recording (webm/opus from MediaRecorder) as 16 kHz mono WAV, which is what on-device recognition reads. */
export async function recordingToWav(blob: Blob): Promise<Uint8Array> {
  const ctx = new AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * SPEECH_RATE));
    const off = new OfflineAudioContext(1, frames, SPEECH_RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    return encodeWav((await off.startRendering()).getChannelData(0), SPEECH_RATE);
  } finally {
    // the context only decoded this clip; nothing else uses it
    ctx.close().catch((error) => noteIgnored('close the audio context that decoded a dictation clip', error));
  }
}
