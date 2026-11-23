// MoMo's index of its past chats in main (#2999 P1), over the services app/momo.cjs made: the sealed index under MoMo's folder (momo/historyIndex.cjs), its indexer fed by every MoMo chat's finished turn on any harness (ChatController onFinished) and by one background pass over all MoMo chats while MoMo is allowed, a deleted MoMo chat taken out, and Reset MoMo's 'history' store; a turn's memory gets a few snippets of MoMo's other chats that bear on it.
const path = require('node:path');
const { HistoryIndex } = require('../momo/historyIndex.cjs');
const { createHistoryIndexer } = require('../momo/historyIndexer.cjs');
const { snippetOf } = require('../momo/historyTools.cjs');
const { registerMomoStore } = require('../momo/stores.cjs');
const { MOMO_META_KEY, MOMO_DATA_TAGS } = require('../../shared/momoChat.mjs');
const { addHook } = require('../session/hookChain.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** How many snippets of MoMo's other chats a turn's memory carries, and how long each side of one may be. */
const TURN_SNIPPETS = 3;
const TURN_SNIPPET_CHARS = 200;

/**
 * What MoMo's other chats said that bears on a turn of `chatId`: a few short snippets, best first; the chat's own turns
 * are left out (it has them). None when the index can't be read.
 * @param {InstanceType<typeof HistoryIndex>} index
 * @param {string} chatId
 * @param {string} query the turn's text
 */
function pastChatsFor(index, chatId, query) {
  if (!index.available()) return [];
  return index.search(query, { limit: TURN_SNIPPETS, excludeChat: chatId }).map((c) => snippetOf(c, TURN_SNIPPET_CHARS));
}

/** How long after MoMo starts its earlier chats are indexed. */
const BACKFILL_DELAY_MS = 30_000;

/**
 * Which MoMo chat `meta` marks: a routine run, a main chat a brain change replaced, or a main chat; null for a chat
 * that isn't MoMo's, or is one of its data-only background chats (a memory pass, search aliases: their prompts quote
 * other chats).
 * @param {any} meta
 * @returns {import('../momo/historyIndex.cjs').ChatKind | null}
 */
function kindOfMeta(meta) {
  const tag = meta && typeof meta === 'object' ? meta[MOMO_META_KEY] : null;
  if (typeof tag !== 'string' || !tag || MOMO_DATA_TAGS.includes(tag)) return null;
  return tag === 'routine' ? 'routine' : tag === 'previous' ? 'previous' : 'main';
}

/**
 * @param {object} o
 * @param {string} o.dir MoMo's folder
 * @param {any} o.safeStorage
 * @param {any} o.live main's services (chats, controller, chatDeletion, peerRuntime)
 * @param {() => string[]} o.chatIds every MoMo chat
 * @param {() => boolean} o.allowed
 * @param {(chatId: string) => string | undefined} o.harnessOf
 */
function openMomoHistory({ dir, safeStorage, live, chatIds, allowed, harnessOf }) {
  const index = new HistoryIndex({ dir: path.join(dir, 'history'), safeStorage });
  const kindOf = (/** @type {string} */ chatId) => kindOfMeta(live.chats?.records.get(chatId)?.meta);
  const indexer = createHistoryIndexer({
    index,
    readHistory: async (chatId) => (live.peerRuntime?.readHistory ? live.peerRuntime.readHistory(chatId) : null),
    kindOf,
    harnessOf,
    chatIds,
    allowed,
  });
  if (live.controller)
    addHook(live.controller, 'onFinished', (/** @type {{ chatId: string }} */ e) => {
      if (kindOf(e?.chatId)) void indexer.queue(e.chatId);
    });
  if (live.chatDeletion) addHook(live.chatDeletion, 'onDeleted', (/** @type {{ chatId: string }} */ r) => index.removeChat(r.chatId));
  registerMomoStore('history', () => index.reset());
  return {
    index,
    indexer,
    /**
     * MoMo is allowed (at startup, or again): every MoMo chat is read once in the background, `delayMs` later, so the
     * app's start (and the peer runtime the transcripts are read through) comes first.
     */
    start(delayMs = BACKFILL_DELAY_MS) {
      if (allowed() !== true) return;
      const timer = setTimeout(() => {
        indexer.backfill().catch((error) => noteIgnored("index MoMo's earlier chats", error));
      }, delayMs);
      timer.unref?.();
    },
  };
}

module.exports = { openMomoHistory, kindOfMeta, pastChatsFor, BACKFILL_DELAY_MS, TURN_SNIPPETS };
