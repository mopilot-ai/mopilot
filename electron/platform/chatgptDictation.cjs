// The ChatGPT login's streaming dictation, as the official desktop app speaks it: one socket per recording
// (wss://chatgpt.com/backend-api/dictation/stream), session.start, audio.append frames held until session.started,
// transcript segments by utterance, and session.close answered by the session closing. Anything else fails the stream,
// and the window transcribes its recording instead.
const crypto = require('node:crypto');

const STREAM_URL = 'wss://chatgpt.com/backend-api/dictation/stream?dictation_surface=composer&client_type=desktop';
const CONNECT_MS = 10_000;
/** frames (about 85 ms each) held while the session starts: past this it isn't starting */
const MAX_HELD = 240;
const CLOSE_MS = 8_000;

/** What the user said, from the stream's events: each utterance's latest revision, in the order they began. */
function transcriptOf(utterances) {
  return [...utterances.values()]
    .map((u) => u.text.trim())
    .filter(Boolean)
    .join(' ');
}

/**
 * One recording's stream.
 * @param {{ headers: () => Promise<Record<string, string> | null>, WebSocket: any, language?: string,
 *   onText: (text: string) => void, onFail: (error: Error) => void, timers?: { set: typeof setTimeout, clear: typeof clearTimeout } }} o
 */
async function openChatgptDictation(o) {
  const timers = o.timers ?? { set: setTimeout, clear: clearTimeout };
  const headers = await o.headers();
  if (!headers) throw new Error('Sign in with ChatGPT to use dictation');
  const ws = new o.WebSocket(STREAM_URL, { protocols: ['chatgpt-dictation', 'codex-desktop'], headers });
  /** @type {Map<string, { revision: number, text: string }>} */
  const utterances = new Map();
  /** frames said before the session started: sent once it has */
  const held = [];
  let opened = false;
  /** fails the start while it connects (set before any socket event can call it) */
  /** @type {(e: Error) => void} */
  let refuse;
  let started = false;
  let failed = /** @type {Error | null} */ (null);
  let closing = /** @type {{ resolve: (text: string) => void, reject: (e: Error) => void } | null} */ (null);
  const send = (msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  const fail = (error) => {
    if (failed) return;
    failed = error;
    // a stream that never opened fails its start instead
    if (closing) closing.reject(error);
    else if (opened) o.onFail(error);
    else refuse(error);
    ws.close();
  };
  await new Promise((resolve, reject) => {
    const timer = timers.set(() => reject(new Error('ChatGPT dictation did not connect')), CONNECT_MS);
    refuse = (e) => {
      timers.clear(timer);
      reject(e);
    };
    ws.addEventListener('open', () => {
      send({
        type: 'session.start',
        dictation_session_id: crypto.randomUUID(),
        attempt_id: crypto.randomUUID(),
        config: {
          ...(o.language ? { language: o.language } : {}),
          input_audio_format: 'pcm16',
          sample_rate_hz: 16_000,
          num_channels: 1,
          max_buffer_size_bytes: 4_194_304,
          max_utterance_duration_ms: 30_000,
          session_ttl_ms: 300_000,
          provider_mode: 'streaming_sse',
          transcript_delivery_mode: 'segment',
          vad: { type: 'server_vad', threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: 500 },
        },
      });
      opened = true;
      timers.clear(timer);
      resolve(undefined);
    });
    ws.addEventListener('error', () => refuse(new Error('ChatGPT dictation could not connect')));
    ws.addEventListener('message', (e) => {
      let event;
      try {
        event = JSON.parse(String(e.data));
      } catch {
        return fail(new Error('ChatGPT dictation sent an unreadable event'));
      }
      switch (event?.type) {
        case 'session.started':
          started = true;
          for (const frame of held.splice(0)) send(frame);
          return;
        case 'transcript.delta':
        case 'transcript.segment':
        case 'transcript.final': {
          const id = String(event.utterance_id ?? '');
          const was = utterances.get(id);
          const revision = Number(event.revision) || 0;
          if (was && revision < was.revision) return;
          const text = event.type === 'transcript.delta' && was && revision === was.revision ? was.text + event.text : event.text;
          utterances.set(id, { revision, text: String(text ?? '') });
          return o.onText(transcriptOf(utterances));
        }
        case 'session.updated':
          if (event.session?.status === 'closed' && closing) closing.resolve(transcriptOf(utterances));
          return;
        case 'transcript.failed':
          return fail(new Error(event.error?.message || 'ChatGPT dictation failed'));
        case 'session.error':
          if (event.fatal) fail(new Error(event.error?.message || 'ChatGPT dictation failed'));
      }
    });
    ws.addEventListener('close', () => fail(new Error('ChatGPT dictation closed')));
  });
  return {
    /** one frame of 16 kHz 16-bit PCM */
    audio(bytes) {
      if (failed || closing) return;
      const frame = { type: 'audio.append', audio: Buffer.from(bytes).toString('base64') };
      // a frame that can't go out is a gap in the text: the stream fails and the recording is transcribed instead
      if (started && ws.readyState !== 1) return fail(new Error('ChatGPT dictation lost its connection'));
      if (started) return send(frame);
      if (held.length >= MAX_HELD) return fail(new Error('ChatGPT dictation did not start'));
      held.push(frame);
    },
    /** the final text once the session closes */
    finish() {
      if (failed) return Promise.reject(failed);
      return new Promise((resolve, reject) => {
        const timer = timers.set(() => fail(new Error('ChatGPT dictation did not finish')), CLOSE_MS);
        closing = {
          resolve: (text) => {
            timers.clear(timer);
            resolve(text);
            ws.close();
          },
          reject: (e) => {
            timers.clear(timer);
            reject(e);
          },
        };
        send({ type: 'session.close' });
      });
    },
    /** ends it; a finish waiting on the close answers that it was cancelled */
    cancel() {
      if (failed) return;
      failed = new Error('Dictation was cancelled');
      closing?.reject(failed);
      ws.close();
    },
  };
}

module.exports = { openChatgptDictation, transcriptOf, STREAM_URL };
