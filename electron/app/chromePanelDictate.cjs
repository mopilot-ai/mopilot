// Dictate in the Chrome side panel (app/chromePanel.cjs), as the window's (src/components/ui/Dictation.tsx): the panel's chat's chain of services, settled as the window settles it; a clip tried on each in turn (platform/voice.cjs) in the language picked until one answers, and kept with the window's recordings.
const { randomUUID } = require('node:crypto');
const { noteIgnored } = require('../ignored.cjs');
const { userError } = require('../../shared/userError.mjs');
const { noSpeechReason, SPEECH_TOO_LONG, speechFailure, speechSettles, takesWav } = require('../../shared/speech.mjs');

/**
 * How long a service may take while another could still be asked, and the limit for the whole clip from its arrival
 * (reading the chain again included), with room under the panel's TRANSCRIBE_MS for the upload and the answer.
 */
const NEXT_MS = 45_000;
const CHAIN_MS = 130_000;
/** The least time worth asking a service with: less would send (and might bill) a clip it can't finish. */
const MIN_MS = 5_000;

/**
 * @param {object} d
 * @param {any} d.live main's late-bound services: dictation (platform/voice.cjs), recordings (platform/recordings.cjs), patchPrefs
 * @param {() => any} d.prefs the app's prefs
 * @param {number} [d.readinessMs] maximum readiness wait, shorter than the panel transport timeout
 * @param {number} [d.nextMs] a service's wait while another could still be asked
 * @param {number} [d.chainMs] the whole chain's wait
 * @param {number} [d.minMs] the least time left worth asking a service with
 * @param {string} [d.platform] process.platform
 */
function createPanelDictation({ live, prefs, readinessMs = 10_000, nextMs = NEXT_MS, chainMs = CHAIN_MS, minMs = MIN_MS }) {
  const attempts = new Map();
  const starting = new Map();
  async function end(capture, clientId, generation = 0) {
    if (!capture) {
      const pending = starting.get(JSON.stringify([clientId, generation]));
      if (pending) pending.cancelled = true;
      return;
    }
    const a = attempts.get(capture);
    if (!a || a.clientId !== clientId) return;
    attempts.delete(capture);
    clearTimeout(a.timer);
    await live.speech.end(a.sender, capture);
  }
  async function begin(clientId, target, generation = 0) {
    if (typeof clientId !== 'string' || !/^[a-f0-9-]{36}$/.test(clientId)) throw new Error('Reopen the speech input panel');
    if (!Number.isSafeInteger(generation) || generation < 0) throw new Error('Reopen the speech input panel');
    const key = JSON.stringify([clientId, generation]);
    if (starting.has(key)) throw new Error('This speech input is already preparing');
    const pending = { cancelled: false };
    starting.set(key, pending);
    try {
      const chatId = target.chatId ?? null,
        hint = target.harness ? { kind: target.harness } : {};
      const chain = await settled(chatId, hint);
      if (pending.cancelled) throw new Error('This speech input was cancelled. Dictate again.');
      const language = prefs().dictationLanguage;
      const sender = `chrome:${clientId}`;
      const capture = live.speech.begin(sender, chatId, hint);
      const timer = setTimeout(() => void end(capture, clientId).catch((e) => noteIgnored('expire Chrome speech capture', e)), 300_000);
      timer.unref?.();
      attempts.set(capture, { sender, clientId, chatId, hint, language, timer });
      // `wav`: the panel sends WAV beside its recording when a service in the chain reads it (an older panel: this Mac's only)
      return { engine: chain[0], chain, wav: chain.some(takesWav), capture };
    } finally {
      if (starting.get(key) === pending) starting.delete(key);
    }
  }
  /** main's chain for this chat, or a refusal once readiness takes longer than the panel's transport waits */
  async function settled(chatId = null, hint = {}) {
    let timer;
    try {
      return await Promise.race([
        chainOf(chatId, hint),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Speech services did not respond. Dictate again.')), readinessMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  /** Every surface uses main's checked services: the pinned one, else the chat's own account's, this Mac, then the rest. */
  async function chainOf(chatId = null, hint = {}) {
    const options = await live.speech.options(chatId, hint);
    if (!options.chain.length) throw new Error(noSpeechReason(prefs().dictationEngine, options.choices));
    return options.chain;
  }
  /** The first service a clip would go to with no chat picked. */
  async function engine() {
    return (await chainOf())[0];
  }

  /**
   * The clip on each service in `chain` until one settles it, each sent the form it reads; with every one failing, each
   * says why ("This Mac: … · ChatGPT account: …"). Throws once the capture ends (`current`).
   * @param {string[]} chain
   * @param {{ wav: Buffer | null, webm: Buffer | null }} forms
   * @param {{ lang: string, chatId: string | null, current: () => void, deadline: number }} o
   */
  async function along(chain, forms, { lang, chatId, current, deadline }) {
    /** @type {{ engine: string, error: string }[]} */
    const failed = [];
    for (const [i, used] of chain.entries()) {
      const wav = takesWav(used);
      const bytes = wav ? forms.wav : forms.webm;
      if (!bytes) {
        failed.push({ engine: used, error: 'Update the MoPilot extension to use this dictation service' });
        continue;
      }
      const left = deadline - Date.now();
      // out of time, or too little to finish in: this service and the rest go untried, and the error says so
      if (left <= minMs) {
        failed.push({ engine: used, error: SPEECH_TOO_LONG });
        break;
      }
      // this Mac's engine takes "auto"; the others are told no language rather than "auto"
      const language = used === 'local' ? lang : lang === 'auto' ? undefined : lang;
      let timer;
      // a service left after its share of the wait is stopped, so it uploads (and bills) nothing more
      const gaveUp = new AbortController();
      const res = await Promise.race([
        live.dictation.transcribe({
          engine: used,
          bytes,
          mime: wav ? 'audio/wav' : 'audio/webm',
          language,
          current,
          chatId,
          signal: gaveUp.signal,
        }),
        new Promise((resolve) => {
          timer = setTimeout(
            () => {
              gaveUp.abort();
              resolve({ error: SPEECH_TOO_LONG });
            },
            i < chain.length - 1 ? Math.min(nextMs, left) : left,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      current();
      if (speechSettles(res)) return res;
      failed.push({ engine: used, error: res.error });
    }
    return { error: speechFailure(failed) };
  }

  /**
   * A clip transcribed: `audio` WAV (`mime` audio/wav) beside `clip`, the recorder's webm and the recording kept; or, from a
   * panel that sends one form, the webm alone. The text, or each service's reason it has none.
   * @param {{ audio: Buffer, mime: string, clip: Buffer, capture?: string, clientId?: string, keep?: boolean }} p keep: false leaves the clip
   *   out of the window's recordings (a clip nobody asked to keep)
   */
  async function transcribe({ audio, mime, clip, capture, clientId, keep = true }) {
    const a = attempts.get(capture);
    if (!a || a.clientId !== clientId) throw new Error('This recording no longer has an active speech owner');
    const current = () => {
      if (!live.speech.current(a.sender, capture)) throw new Error('This recording was cancelled. Dictate again.');
    };
    const isWav = mime === 'audio/wav';
    const forms = { wav: isWav ? audio : null, webm: !isWav ? audio : clip !== audio ? clip : null };
    const deadline = Date.now() + chainMs;
    try {
      current();
      // read again now: a service pinned or turned off while recording is respected, and the clip never goes where the user just said no
      const chain = await settled(a.chatId, a.hint);
      current();
      const res = await along(chain, forms, { lang: a.language, chatId: a.chatId, current, deadline });
      if (res?.error) throw new Error(res.error);
      const text = String(res?.text ?? '').trim();
      if (!text || !keep) return { text };
      // kept with the window's recordings; a clip that can't be saved still leaves its text
      try {
        await live.recordings.save(clip, text);
      } catch (error) {
        noteIgnored("save a recording dictated in Chrome's side panel", error);
        return { text, saveError: `Could not save recording: ${userError(error)}` };
      }
      return { text };
    } finally {
      await end(capture, clientId);
    }
  }

  /**
   * A clip a phone sent whole, with no speech lease of its own (a phone never takes one): this Mac's own chain and language, a lease
   * made for the clip and ended with it. `keep: false` leaves the clip out of the recordings (MoMo's voice notes).
   * @param {{ audio: Buffer, mime: string, keep?: boolean }} p
   */
  async function transcribeClip({ audio, mime, keep = true }) {
    const clientId = randomUUID();
    const { capture } = await begin(clientId, {});
    return transcribe({ audio, mime, clip: audio, capture, clientId, keep });
  }

  return { engine, begin, end, transcribe, transcribeClip };
}

module.exports = { createPanelDictation };
