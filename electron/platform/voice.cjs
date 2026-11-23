// Dictation: recorded audio in, text out, independent of the harness. Three engines behind one function:
//   local    macOS speech recognition in the computer-use helper (on device; needs WAV)
//   chatgpt  the signed-in ChatGPT account's /backend-api/transcribe, as the official app does
//   credits  MoPilot credits, the gateway's /v1/audio/transcriptions
const { messageOf, noteIgnored } = require('../ignored.cjs');
const crypto = require('node:crypto');
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { DICTATION_OFF, SPEECH_ASKED, SPEECH_TOO_LONG } = require('../../shared/speech.mjs');

const ENGINES = Object.freeze(['local', 'chatgpt', 'credits']);
const CREDITS_MODEL = 'gpt-4o-mini-transcribe';
/** What a local clip says while macOS's Speech Recognition prompt is up for the first time. */

/** The engine a request asks for; anything unknown is the ChatGPT engine every install had before engines existed. */
function normalizeEngine(engine) {
  return ENGINES.includes(engine) ? engine : 'chatgpt';
}

function extFor(mime) {
  return (String(mime || '').split(/[/;]/)[1] || 'webm').trim().replace('x-wav', 'wav');
}

function audioForm(bytes, mime, language, extra = {}) {
  const form = new FormData();
  form.append('file', new Blob([Buffer.from(bytes)], { type: mime }), `codex.${extFor(mime)}`);
  if (language) form.append('language', language);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return form;
}

/** Normalize every engine before its response crosses IPC into text insertion or toast rendering. */
function transcriptionResult(data) {
  if (!isJsonRecord(data)) return { error: 'Transcription failed: invalid response' };
  if (typeof data.text === 'string') return { text: data.text };
  // Preserve the existing empty/no-speech answer when the reply carries no error.
  if (data.text == null && data.error == null && data.detail == null) return { text: '' };
  return { error: 'Transcription failed: invalid response' };
}

/** macOS's recognizer on a clip without words (kAFAssistantErrorDomain 1110). */
const NO_SPEECH = /^no speech detected/i;

/** A clip shorter than a service will take: an answer about the clip, so no other service is asked (dictationSend.ts). */
const TOO_SHORT = 'Audio too short';

/** One request: the text or the reason, and whether the same request may work if sent again (network, 408, 5xx). */
async function postOnce(fetch, url, init) {
  let res;
  try {
    res = await fetch(url, { method: 'POST', ...init });
  } catch (e) {
    return { result: { error: String(e?.message || e) }, again: true };
  }
  let data = {};
  try {
    data = await res.json();
  } catch (error) {
    // a success without a readable answer is a failure, not an empty transcript; a refusal still reports its status
    if (res.ok) return { result: { error: `Transcription failed: ${messageOf(error)}` }, again: false };
  }
  if (res.ok) return { result: transcriptionResult(data), again: false };
  const code = [data?.detail?.code, data?.error?.code, data?.code].find((v) => typeof v === 'string');
  if (code === 'audio_too_short') return { result: { error: TOO_SHORT }, again: false };
  const message = [data?.detail?.message, data?.detail, data?.error?.message].find((value) => typeof value === 'string' && value.trim());
  return {
    result: { error: message || `Transcription failed (${res.status})` },
    again: res.status === 0 || res.status === 408 || res.status >= 500,
  };
}

/**
 * The request, sent again after a network failure, a timeout or a server error (`attempts` in all, waiting 500 ms and
 * doubling, as the official app does); `body` makes a fresh form for each attempt.
 * @param {{ fetch: typeof fetch, sleep?: (ms: number) => Promise<void> }} o
 * @param {string} url
 * @param {RequestInit} init
 * @param {{ attempts: number, body: (attempt: number) => FormData }} retry
 */
async function postForText(o, url, init, { attempts, body }) {
  for (let attempt = 1; ; attempt++) {
    const { result, again } = await postOnce(o.fetch, url, { ...init, body: body(attempt) });
    const wait = 500 * 2 ** (attempt - 1);
    // nobody waits for an answer any more: no further attempt is sent
    if (!again || attempt >= attempts || init.signal?.aborted) return result;
    await (o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))))(wait);
    if (init.signal?.aborted) return result;
  }
}

/** How often a request checks that its recording is still waiting for it. */
const WATCH_MS = 1_000;

/**
 * A signal for one transcription that aborts once nobody waits for it: the caller gave up (`signal`, its share of the
 * wait over) or the recording ended (`current` throws, checked each second). `stop` ends the watch.
 * @param {() => void} current
 * @param {AbortSignal | undefined} signal
 */
function untilGone(current, signal) {
  const gone = new AbortController();
  const leave = () => gone.abort();
  signal?.addEventListener('abort', leave, { once: true });
  if (signal?.aborted) leave();
  const watch = setInterval(() => {
    try {
      current();
    } catch {
      leave();
    }
  }, WATCH_MS);
  watch.unref?.();
  return {
    signal: gone.signal,
    stop() {
      clearInterval(watch);
      signal?.removeEventListener('abort', leave);
    },
  };
}

/** The helper's Speech Recognition status, or null when it can't say (the transcription then tells what is wrong). */
async function speechStatusOf(helper, language) {
  try {
    return await helper.speechStatus(language);
  } catch (e) {
    noteIgnored('read the Speech Recognition status', e);
    return null;
  }
}

/**
 * @param {object} o
 * @param {() => Promise<any>} o.chatgptHeaders headers for ChatGPT backend calls, or null when not signed in
 * @param {() => string | null} o.gatewayKey the MoPilot gateway key, or null when signed out
 * @param {string | null} o.apiBase MoPilot API base URL (no trailing /v1); null in a build without the MoPilot service
 * @param {() => any} o.helper the computer-use helper (ComputerHelper)
 * @param {typeof fetch} o.fetch
 * @param {() => boolean} [o.enabled] false while dictation is switched off (shared.dictation.enabled)
 * @param {(ms: number) => Promise<void>} [o.sleep] the wait between attempts (tests)
 */
function createDictation(o) {
  return {
    /**
     * `signal` aborts the request once the caller stops waiting for it (its share of the wait is over); the recording
     * ending (`current` throwing) aborts it too. An aborted request stops uploading and is not sent again.
     * @returns {Promise<{text?: string, error?: string}>}
     */
    async transcribe({ engine, bytes, mime, language, current = () => undefined, signal = undefined }) {
      current();
      if (o.enabled?.() === false) return { error: DICTATION_OFF };
      const gone = untilGone(current, signal);
      try {
        const res = await byEngine(normalizeEngine(engine), { bytes, mime, language, current, signal: gone.signal });
        // stopped: a timeout to whoever still reads it (a throttled window's own timer can come late), never the abort's own words
        return gone.signal.aborted && res.error ? { error: SPEECH_TOO_LONG } : res;
      } finally {
        gone.stop();
      }
    },
  };

  /**
   * The clip on one engine. Cloud requests take `signal`; this Mac's helper takes no cancel, but it is on this Mac
   * and bills nothing, and its own timeout ends it (computer.cjs).
   * @param {string} engine
   * @param {{ bytes: Uint8Array, mime: string, language?: string, current: () => void, signal: AbortSignal }} c
   */
  async function byEngine(engine, { bytes, mime, language, current, signal }) {
    switch (engine) {
      case 'local': {
        if (process.platform !== 'darwin') return { error: 'Local dictation needs macOS' };
        if (!/wav/i.test(mime || '')) return { error: 'Local dictation needs WAV audio' };
        const helper = o.helper();
        try {
          await helper.start();
          current();
          // macOS hasn't asked yet: its prompt goes up now, and this clip ends at once rather than waiting on it (a
          // window asks first itself, src/lib/localSpeech.ts; Chrome's side panel comes here directly, #2286)
          if ((await speechStatusOf(helper, language))?.authorization === 'notDetermined') {
            Promise.resolve()
              .then(() => helper.speechRequest(language))
              .catch((e) => noteIgnored('ask macOS for Speech Recognition', e));
            return { error: SPEECH_ASKED };
          }
          current();
          const r = await helper.speechTranscribe(Buffer.from(bytes).toString('base64'), language);
          return transcriptionResult(r);
        } catch (e) {
          if (e?.reason === 'permission_denied')
            return {
              error: 'Allow speech recognition for "MoPilot" in System Settings → Privacy & Security → Speech Recognition',
            };
          // a clip with no words in it was heard, not lost: nothing to type, and no recording to retry (a helper
          // older than Speech.swift's own answer for it says so as an error)
          if (e?.reason === 'speech_failed' && NO_SPEECH.test(String(e?.message))) return { text: '' };
          return { error: String(e?.message || e) };
        }
      }
      case 'credits': {
        const key = o.gatewayKey();
        // a gateway key comes only from a MoPilot sign-in, which a build without the service has none of
        if (!key || !o.apiBase) return { error: 'Sign in to MoPilot to use credits for dictation' };
        return postForText(
          o,
          `${o.apiBase}/v1/audio/transcriptions`,
          { headers: { Authorization: `Bearer ${key}` }, signal },
          // once: the gateway bills each request, so a reply lost on the way back must not bill the clip twice
          { attempts: 1, body: () => audioForm(bytes, mime, language, { model: CREDITS_MODEL }) },
        );
      }
      default: {
        const headers = await o.chatgptHeaders();
        current();
        if (!headers) return { error: 'Sign in with ChatGPT to use dictation' };
        // as the official app sends it: one session for the clip, an attempt id per try
        const session = crypto.randomUUID();
        return postForText(
          o,
          'https://chatgpt.com/backend-api/transcribe',
          { headers, signal },
          {
            attempts: 3,
            body: (attempt) => audioForm(bytes, mime, language, { dictation_session_id: session, attempt_id: `${session}:${attempt}` }),
          },
        );
      }
    }
  }
}

module.exports = { ENGINES, CREDITS_MODEL, SPEECH_ASKED, TOO_SHORT, WATCH_MS, normalizeEngine, extFor, createDictation };
