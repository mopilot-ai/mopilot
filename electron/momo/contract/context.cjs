// The momoContext semantic's source (#2139): the <momo-context> block a MoMo chat's next turn starts with, from one provider the app sets (none by default, so no chat gets one). Every harness's turn start asks momoContextFor(chatId, { session, query }); a native session gets the block only when it differs from the last one it was given, so its transcript holds one copy per change, not one per turn. A turn that did not start forgets it was sent (forgetMomoSent); a provider that fails or answers something that is not one block gives the turn none.
const { momoBlock, isMomoBlock } = require('../../../shared/momoContext.mjs');
const { noteIgnored } = require('../../ignored.cjs');

/** @typedef {(chatId: string, o: { query: string }) => string | null} MomoContextProvider */

/** @type {MomoContextProvider | null} */
let provider = null;
/** `${chatId}\0${session}` -> the block that native session was last given */
const sent = new Map();
const keyOf = (/** @type {string} */ chatId, /** @type {unknown} */ session) => `${chatId}\0${String(session ?? '')}`;

/**
 * Sets the provider (null: none); returns a function that removes it again, unless another was set since. Either way
 * what each session was given is forgotten, so the next turn of each gets the new provider's block.
 * @param {MomoContextProvider | null} fn
 */
function setMomoContextProvider(fn) {
  const mine = typeof fn === 'function' ? fn : null;
  provider = mine;
  sent.clear();
  return () => {
    if (provider !== mine) return;
    provider = null;
    sent.clear();
  };
}

/**
 * The block a chat's turn in native session `session` starts with: null when there is none, or when that session was
 * given this same block last. `query`: the turn's text, which the provider ranks the facts by.
 * @param {string} chatId
 * @param {{ session?: string | null, query?: string }} [o]
 * @returns {string | null}
 */
function momoContextFor(chatId, { session = null, query = '' } = {}) {
  if (!provider || typeof chatId !== 'string' || !chatId) return null;
  /** @type {string | null} */
  let block = null;
  try {
    const b = provider(chatId, { query: typeof query === 'string' ? query : '' });
    block = isMomoBlock(b) ? b : null;
  } catch (error) {
    // the turn goes on without MoMo's memory rather than not at all
    noteIgnored("read MoMo's memory for a turn", error);
  }
  const key = keyOf(chatId, session);
  if (!block || sent.get(key) === block) return null;
  sent.set(key, block);
  return block;
}

/**
 * The turn that was to carry the block did not start (or the session's context was cleared or compacted): its next
 * turn gets the block again. Without `session`, every session of the chat.
 * @param {string} chatId
 * @param {string | null} [session]
 */
function forgetMomoSent(chatId, session = null) {
  if (session != null) sent.delete(keyOf(chatId, session));
  else for (const k of [...sent.keys()]) if (k.startsWith(`${chatId}\0`)) sent.delete(k);
}

/**
 * The provider for MoMo's store: a MoMo chat gets the store's summary (the facts that fit, picked by the turn's text,
 * in a stable order) as a block while MoMo is allowed and its memory can be decrypted; any other chat gets none.
 * @param {{ store: { summary(o?: { budgetTokens?: number, query?: string }): { persona: string, aboutYou: string, facts: string[] }, available(): boolean },
 *           allowed: () => boolean, isMomoChat: (chatId: string) => boolean, budgetTokens?: number, name?: () => string,
 *           history?: (chatId: string, query: string) => string[], nudges?: (chatId: string) => string[],
 *           channel?: (chatId: string) => { name: string, instructions: string } | null,
 *           ownerRules?: (chatId: string) => { text: string, kind?: string }[] }} o
 *   name: the name the user gave MoMo (prefs.momo.persona.name), read at every turn so a rename reaches the next one
 *   history: snippets of MoMo's other chats that bear on the turn (the index of past chats), within their own small budget
 *   channel: the channel a chat is the journal of, with its instructions (A2: one chat's own, never another's; the memory is the same for every chat)
 *   ownerRules: the owner's standing rules (a Host's learning service), set apart from the quoted data; a Mac app gives none
 *   nudges: the reminders MoMo showed in this chat lately (its nudge notes), so the turn knows what the user may be answering
 * @returns {MomoContextProvider}
 */
function memoryContextProvider({ store, allowed, isMomoChat, budgetTokens, name, history, nudges, channel, ownerRules }) {
  return (chatId, { query }) => {
    if (allowed() !== true || isMomoChat(chatId) !== true || !store.available()) return null;
    const summary = store.summary({ budgetTokens, query });
    /** @type {string[]} */
    let past = [];
    try {
      past = query.trim() && history ? history(chatId, query) : [];
    } catch (error) {
      // the turn still gets its memory without the past chats
      noteIgnored("read MoMo's past chats for a turn", error);
    }
    // the turn's text picks which facts fit; their order in the block stays the same, so the same memory is the same
    // block whatever the turn says, and is not sent again (momoContextFor); past chats change it only when they match
    /** @type {string[]} */
    let shown = [];
    try {
      shown = nudges?.(chatId) ?? [];
    } catch (error) {
      noteIgnored('read the nudges MoMo showed for a turn', error);
    }
    /** @type {{ name: string, instructions: string } | null} */
    let own = null;
    try {
      own = channel?.(chatId) ?? null;
    } catch (error) {
      noteIgnored("read a channel's instructions for a turn", error);
    }
    /** @type {{ text: string, kind?: string }[]} */
    let rules = [];
    try {
      rules = ownerRules?.(chatId) ?? [];
    } catch (error) {
      noteIgnored("read the owner's standing rules for a turn", error);
    }
    return momoBlock({
      ...summary,
      name: name?.(),
      facts: [...summary.facts].sort(),
      history: past,
      nudges: shown,
      channel: own,
      ownerRules: rules,
    });
  };
}

module.exports = { setMomoContextProvider, momoContextFor, forgetMomoSent, memoryContextProvider };
