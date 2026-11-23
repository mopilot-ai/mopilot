// Main's shared speech readiness and exclusive capture ownership; no harness or provider is switched for voice. A
// dictation capture belongs to its window and draft only: the account and engine are resolved when it is transcribed.
const { noteIgnored } = require('../ignored.cjs');
const crypto = require('node:crypto');
const { localSpeechReadiness, speechChain, speechOperations, SPEECH_PROVIDERS, DICTATION_OFF } = require('../../shared/speech.mjs');

/** @param {any} o dependencies resolve current accounts, settings and capabilities at each operation. */
function createSpeech(o) {
  /** @type {{ id: string, sender: number | string, chatId: string | null, hint: any, owner: string, retiring?: boolean, dispose?: () => Promise<void> } | null} */
  let capture = null;
  const ownerOf = (chatId, hint) => {
    const p = o.prefs();
    return JSON.stringify([
      chatId,
      chatId ? o.ref(chatId) : hint,
      o.identity(chatId),
      p.dictationLanguage,
      p.dictationEngine,
      p.defaultHarness,
      p.model,
      p.claudeSelection,
      o.localEnabled?.(),
    ]);
  };
  const checked = async (read, fallback, what) => {
    try {
      return await read();
    } catch (error) {
      noteIgnored(what, error);
      return fallback;
    }
  };
  /**
   * A service that needs a sign-in: ready with one, blocked without (or switched off), unknown when it couldn't be checked.
   * @param {import('../../shared/speech.mjs').SpeechEngine} id @param {boolean | 'off' | null | undefined} ok @param {string} signIn
   * @returns {import('../../shared/speech.mjs').SpeechChoice}
   */
  const signedIn = (id, ok, signIn) => ({
    id,
    label: /** @type {{ label: string }} */ (SPEECH_PROVIDERS.find((p) => p.id === id)).label,
    state: ok == null ? 'unknown' : ok === true ? 'ready' : 'blocked',
    reason:
      ok == null
        ? 'This dictation service could not be checked'
        : ok === 'off'
          ? 'This dictation service is turned off in this app'
          : ok
            ? null
            : signIn,
  });
  /** `launch` false: on-device recognition is read only from a helper already running (a check nobody asked for). */
  async function options(chatId = null, hint = {}, launch = true) {
    const owner = ownerOf(chatId, hint);
    const pref = o.prefs().dictationEngine;
    const language = o.prefs().dictationLanguage;
    const operations = () => checked(() => o.caps(chatId, hint), null, 'check native speech operations');
    if (o.enabled?.() === false) {
      /** @type {import('../../shared/speech.mjs').SpeechChoice[]} */
      const off = SPEECH_PROVIDERS.map((p) => ({ ...p, state: 'blocked', reason: DICTATION_OFF }));
      return { engine: null, chain: [], choices: off, ...speechOperations(await operations()) };
    }
    const [local, accounts, caps] = await Promise.all([
      checked(() => o.localStatus(language, launch), null, 'check on-device speech'),
      checked(() => o.accounts(chatId), { chatgpt: null, credits: null }, 'check speech accounts'),
      operations(),
    ]);
    if (owner !== ownerOf(chatId, hint)) throw new Error('Speech settings changed. Open Voice input again.');
    /** @type {import('../../shared/speech.mjs').SpeechChoice[]} */
    const choices = [
      {
        id: 'local',
        label: 'This Mac',
        ...(o.localEnabled?.() === false
          ? { state: 'blocked', reason: 'On-device recognition is turned off in this app' }
          : localSpeechReadiness(local)),
      },
      signedIn('chatgpt', accounts.chatgpt, `Sign in with ${SPEECH_PROVIDERS[1].label} to use this dictation service`),
      signedIn('credits', accounts.credits, 'Sign in to MoPilot to use credits for dictation'),
    ];
    const native = caps?.caps?.nativeDictation?.state === 'native' ? caps.caps.nativeDictation.engine : null;
    const chain = speechChain(pref, choices, native);
    return { engine: chain[0] ?? null, chain, choices, ...speechOperations(caps) };
  }
  return {
    options,
    /** Whether any service could dictate here: false only when every one is known to be blocked (the button hides). */
    async available(chatId = null, hint = {}) {
      return (await options(chatId, hint, false)).choices.some((c) => c.state !== 'blocked');
    },
    owner: ownerOf,
    /** One microphone owner across app windows; a second writer cannot replace an active recording. */
    begin(sender, chatId, hint) {
      if (capture) throw new Error('Voice input is already active in another composer');
      const id = crypto.randomUUID();
      capture = { id, sender, chatId, hint, owner: ownerOf(chatId, hint) };
      return id;
    },
    /** The capture is still this window's: an account, model or setting change does not end a dictation. */
    current(sender, id) {
      return !!capture && !capture.retiring && capture.sender === sender && capture.id === id;
    },
    /** Also nothing it was started for changed: audio messages and native conversations are bound to that chat and account. */
    unchanged(sender, id) {
      const c = capture;
      return !!c && this.current(sender, id) && c.owner === ownerOf(c.chatId, c.hint);
    },
    /** the chat a current capture records for (null: a new chat's draft or no chat) */
    chatOf(sender, id) {
      return this.current(sender, id) ? /** @type {{ chatId: string | null }} */ (capture).chatId : null;
    },
    owns(sender, id, chatId) {
      return this.unchanged(sender, id) && capture?.chatId === chatId;
    },
    attach(sender, id, dispose) {
      if (!capture || !this.unchanged(sender, id)) throw new Error('This voice input belongs to an earlier chat or account');
      if (capture.dispose) throw new Error('A native conversation is already starting');
      capture.dispose = dispose;
    },
    async end(sender, id) {
      const mine = capture;
      if (!mine || mine.sender !== sender || mine.id !== id || mine.retiring) return;
      mine.retiring = true;
      if (!mine.dispose) {
        capture = null;
        return;
      }
      try {
        await mine.dispose?.();
      } finally {
        if (capture === mine) capture = null;
      }
    },
    close(sender) {
      const mine = capture;
      return mine && mine.sender === sender ? this.end(sender, mine.id) : Promise.resolve();
    },
  };
}
module.exports = { createSpeech };
