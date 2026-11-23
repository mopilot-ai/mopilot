// A dictated clip as the side panel sends it (panelDictate.mjs): 16 kHz mono WAV for this Mac's speech recognition, as the app's Dictate converts it (src/lib/dictation.ts), and bytes as base64.

/** The rate speech recognition reads. */
export const SPEECH_RATE = 16000;

/** 16-bit mono PCM WAV of `samples` (floats in -1..1); the app's encodeWav, byte for byte. */
export function encodeWav(/** @type {Float32Array} */ samples, /** @type {number} */ sampleRate) {
  const out = new Uint8Array(44 + samples.length * 2);
  const v = new DataView(out.buffer);
  const str = (/** @type {number} */ o, /** @type {string} */ s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
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

/**
 * A recording as 16 kHz mono WAV, resampled by the page's own audio contexts.
 * @param {Blob} blob
 * @param {{ AudioContext: any, OfflineAudioContext: any }} g the page's
 */
export async function recordingToWav(blob, g) {
  const ctx = new g.AudioContext();
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    const frames = Math.max(1, Math.ceil(decoded.duration * SPEECH_RATE));
    const off = new g.OfflineAudioContext(1, frames, SPEECH_RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    return encodeWav((await off.startRendering()).getChannelData(0), SPEECH_RATE);
  } finally {
    // the context only decoded this clip; one that won't close leaves the WAV as it is
    ctx
      .close()
      .catch((/** @type {unknown} */ error) =>
        console.warn("MoPilot: couldn't close the audio context that decoded a dictation clip:", error),
      );
  }
}

/** Bytes as base64, a chunk at a time (a long clip is too big for one call). */
export function toBase64(/** @type {Uint8Array} */ bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
