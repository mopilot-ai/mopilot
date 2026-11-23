// Streaming dictation in the window (this Mac's recognizer, or the ChatGPT login's): while recording, the microphone goes
// to main as 16 kHz PCM and each new guess comes back as a live caption; when the recording stops, the final text.
// Anything that fails returns null, and the recording is transcribed as a whole instead.
import { native } from '../../lib/native';
import { ignoring } from '../../lib/ignored';

export const STREAM_RATE = 16_000;

/** 16-bit little-endian PCM at 16 kHz from `samples` at `rate`: each output sample is the mean of the input it covers. */
export function toPcm16(samples: Float32Array, rate: number): Uint8Array {
  const step = rate / STREAM_RATE;
  const out = new Int16Array(Math.floor(samples.length / step));
  for (let i = 0; i < out.length; i++) {
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    let sum = 0;
    for (let j = from; j < to; j++) sum += samples[j];
    const v = Math.max(-1, Math.min(1, sum / (to - from)));
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
  }
  return new Uint8Array(out.buffer);
}

export type StreamEngine = 'local' | 'chatgpt';

export interface LocalStream {
  /** the service streaming it: its text stands only while that service is still the first one */
  engine: StreamEngine;
  /** the final text; null when the stream failed (the recording is transcribed instead) */
  finish(): Promise<string | null>;
  cancel(): void;
}

/** Streams `stream` on `engine` for capture `capture`; null when that service can't stream it now. */
export async function startStream(o: {
  engine: StreamEngine;
  capture: string;
  lang: string;
  stream: MediaStream;
  onCaption(text: string): void;
}): Promise<LocalStream | null> {
  const Ctx = (window as Window & { AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctx) return null;
  // the microphone is tapped at once and held until the stream is ready: the first words are said before it is
  let failed = false;
  let ready = false;
  const early: Uint8Array[] = [];
  const send = (pcm: Uint8Array) =>
    native.speech.streamAudio(o.capture, pcm).catch(() => {
      failed = true;
    });
  const ctx = new Ctx();
  const source = ctx.createMediaStreamSource(o.stream);
  // a ScriptProcessor, not a worklet: no module file to load past the page's script policy, and 100 ms frames suffice
  const tap = ctx.createScriptProcessor(4096, 1, 1);
  tap.onaudioprocess = (e) => {
    if (failed) return;
    const pcm = toPcm16(e.inputBuffer.getChannelData(0), ctx.sampleRate);
    if (ready) void send(pcm);
    else early.push(pcm);
  };
  source.connect(tap);
  // a processor only runs while connected to the output; it writes nothing, so nothing is heard
  tap.connect(ctx.destination);
  let off: (() => void) | null = null;
  let open = true;
  const close = () => {
    if (!open) return;
    open = false;
    tap.onaudioprocess = null;
    source.disconnect();
    tap.disconnect();
    off?.();
    void ctx.close().catch(ignoring('close the dictation stream audio'));
  };
  try {
    await native.speech.streamStart(o.capture, o.lang, o.engine);
  } catch (error) {
    // this Mac: no Speech Recognition grant yet (the whole recording asks), no model, an older helper; ChatGPT: not
    // signed in, no connection, or the switch is off
    close();
    ignoring('stream dictation')(error);
    return null;
  }
  off = native.speech.onStream((e) => {
    if (e.id !== o.capture) return;
    if (e.error) {
      failed = true;
      // the words shown so far won't be the answer: the recording is transcribed as a whole
      o.onCaption('');
    } else if (typeof e.text === 'string') o.onCaption(e.text);
  });
  ready = true;
  for (const pcm of early.splice(0)) void send(pcm);
  return {
    engine: o.engine,
    async finish() {
      close();
      if (failed) {
        void native.speech.streamCancel(o.capture).catch(ignoring('end a failed dictation stream'));
        return null;
      }
      try {
        const r = await native.speech.streamFinish(o.capture);
        // nothing heard is no answer either: the whole recording gets another try
        return r.error || !r.text?.trim() ? null : r.text;
      } catch (error) {
        ignoring('finish a dictation stream')(error);
        return null;
      }
    },
    cancel() {
      close();
      void native.speech.streamCancel(o.capture).catch(ignoring('cancel a dictation stream'));
    },
  };
}
