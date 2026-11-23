// Streaming dictation in main: one stream per recording, on this Mac's helper, the ChatGPT login's dictation socket
// (chatgptDictation.cjs); microphone frames are passed on in order and guesses sent to the window that records.
// A stream that fails says so; the window then transcribes its recording.
const crypto = require('node:crypto');
const { userError } = require('../../shared/userError.mjs');
const { openChatgptDictation } = require('./chatgptDictation.cjs');

/**
 * @param {{ helper: () => any, noteIgnored: (what: string, error: unknown) => void,
 *   chatgptHeaders: () => Promise<Record<string, string> | null>, WebSocket: any }} o
 */
function createSpeechStreams(o) {
  /**
   * `remote`: a ChatGPT stream (null while it connects); none: this Mac's helper session.
   * @type {Map<string, { owner: unknown, session: string, send: (msg: object) => void, chain: Promise<unknown>, failed: unknown, remote?: any, engine?: string }>}
   */
  const streams = new Map();
  const listening = new WeakSet();
  /** the helper's guesses and failures, to the window whose stream they belong to */
  const listen = (helper) => {
    if (listening.has(helper)) return;
    listening.add(helper);
    helper.on('speech', (method, params) => {
      const entry = [...streams.entries()].find(([, s]) => s.session === params?.session);
      if (!entry) return;
      const [capture, s] = entry;
      if (method === 'speech.stream.result') return s.send({ text: String(params.text ?? '') });
      streams.delete(capture);
      // the window only needs to know it stopped (it transcribes the recording instead); the helper's words go to the log
      o.noteIgnored('stream dictation on this Mac', new Error(String(params.message || 'stopped')));
      s.send({ error: 'On-device recognition stopped' });
    });
  };
  const drop = (capture) => {
    const s = streams.get(capture);
    if (!s) return;
    streams.delete(capture);
    // a ChatGPT stream still connecting is closed once it connects (start sees it was dropped)
    if ('remote' in s) return s.remote?.cancel();
    o.helper()
      .call('speech.stream.cancel', { session: s.session })
      .catch((e) => o.noteIgnored('end a streaming dictation', e));
  };
  /** The ChatGPT login's stream for `capture`; a failure after it connected is said to the window once. */
  async function startRemote(owner, capture, language, send) {
    drop(capture);
    const s = { owner, session: '', send, chain: Promise.resolve(), failed: null, remote: null, engine: 'chatgpt' };
    streams.set(capture, s);
    const said = {
      onText: (text) => s.send({ text }),
      // a dropped or replaced stream was cancelled first, which never reports a failure
      onFail: (e) => {
        streams.delete(capture);
        o.noteIgnored('stream dictation with chatgpt', e);
        s.send({ error: 'Dictation stopped' });
      },
    };
    const lang = language === 'auto' ? undefined : language;
    let remote;
    try {
      remote = await openChatgptDictation({ headers: o.chatgptHeaders, WebSocket: o.WebSocket, language: lang, ...said });
    } catch (e) {
      if (streams.get(capture) === s) streams.delete(capture);
      throw e;
    }
    if (streams.get(capture) !== s) return remote.cancel();
    s.remote = remote;
  }
  return {
    /**
     * Starts streaming `capture`'s audio on `engine`; throws when it can't (this Mac: no grant yet, no model, an older
     * helper; ChatGPT: not signed in, no connection).
     * @param {string} [engine]
     */
    async start(owner, capture, language, send, engine = 'local') {
      if (engine === 'chatgpt') return startRemote(owner, capture, language, send);
      if (engine !== 'local') throw new Error('This dictation service has no stream');
      const helper = o.helper();
      await helper.start();
      listen(helper);
      drop(capture);
      const s = { owner, session: crypto.randomUUID(), send, chain: Promise.resolve(), failed: null };
      streams.set(capture, s);
      try {
        await helper.call('speech.stream.start', { session: s.session, language }, { timeoutMs: 10_000 });
      } catch (e) {
        if (streams.get(capture) === s) streams.delete(capture);
        throw e;
      }
    },
    /** One frame of 16-bit PCM, sent after the ones before it; a failed frame fails the stream. */
    audio(capture, bytes) {
      const s = streams.get(capture);
      if (!s) return;
      if ('remote' in s) return s.remote?.audio(bytes);
      const pcm = Buffer.from(bytes).toString('base64');
      s.chain = s.chain
        .then(() => (s.failed ? undefined : o.helper().call('speech.stream.append', { session: s.session, pcm })))
        .catch((e) => {
          s.failed ??= e;
        });
    },
    /** The final text once every frame is in, or why there is none. */
    async finish(capture) {
      const s = streams.get(capture);
      if (!s) return { error: 'This dictation stream has ended' };
      if ('remote' in s) {
        if (!s.remote) {
          streams.delete(capture);
          return { error: 'This dictation stream has ended' };
        }
        // kept until it closes, so a window that retires meanwhile still cancels it
        let answer;
        try {
          answer = { text: await s.remote.finish() };
        } catch (e) {
          answer = { error: userError(e) };
        }
        if (streams.get(capture) === s) streams.delete(capture);
        return answer;
      }
      await s.chain;
      if (streams.get(capture) !== s) return { error: 'This dictation stream has ended' };
      if (s.failed) {
        drop(capture);
        return { error: userError(s.failed) };
      }
      streams.delete(capture);
      try {
        const r = await o.helper().call('speech.stream.finish', { session: s.session }, { timeoutMs: 15_000 });
        return { text: String(r?.text ?? '') };
      } catch (e) {
        return { error: userError(e) };
      }
    },
    cancel: drop,
    /** the service `capture` streams on, if it streams */
    engineOf(capture) {
      const s = streams.get(capture);
      return s ? ('remote' in s ? s.engine : 'local') : null;
    },
    /** A window that retired takes its streams with it. */
    close(owner) {
      for (const [capture, s] of streams) if (s.owner === owner) drop(capture);
    },
  };
}

module.exports = { createSpeechStreams };
