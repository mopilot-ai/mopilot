// Quick Chat in main: the floating window's saved chat and draft, its request de-duplication and renderer readiness.

const { identityKey } = require('../../shared/identityKey.mjs');
const { readStateFile, writePrivate } = require('../platform/fsutil.cjs');
const { isAcceptedReceipt } = require('../../shared/sendReceipt.mjs');
const { sendOnce } = require('../../shared/sendOnce.mjs');

/** Separate from ui-state.json: the floating window cannot overwrite the app's layout. */
class QuickChatState {
  constructor(file, getChat) {
    this.file = file;
    this.getChat = getChat;
  }
  read() {
    const saved = readStateFile(this.file, 'the Quick Chat draft');
    const threadId = typeof saved?.threadId === 'string' && this.getChat(saved.threadId) ? saved.threadId : null;
    return { threadId, text: typeof saved?.text === 'string' ? saved.text : '' };
  }
  save(value) {
    if (
      !value ||
      typeof value.text !== 'string' ||
      value.text.length > 1_000_000 ||
      !(value.threadId === null || (typeof value.threadId === 'string' && this.getChat(value.threadId)))
    ) {
      throw new Error('Invalid Quick Chat state');
    }
    readStateFile(this.file, 'the Quick Chat draft');
    const state = { threadId: value.threadId, text: value.text };
    writePrivate(this.file, JSON.stringify(state));
    return state;
  }
  owns(id) {
    return typeof id === 'string' && id === this.read().threadId && !!this.getChat(id);
  }
}

/** The floating window that currently owns Quick Chat, including after a request waits for main to start. */
function isQuickChatSender(mini, sender) {
  return !!mini && !mini.isDestroyed() && sender === mini.webContents;
}

/**
 * Whether main can reach a chat, by any of its sources: a saved chat record, or a session a harness
 * adapter registered for a new chat. A new Claude Code or ACP chat has no record until something is
 * saved for it, so a Quick Chat it started must still be accepted before its first message.
 * @param {...(id: string) => unknown} sources
 * @returns {(id: string) => boolean}
 */
function knownChat(...sources) {
  return (id) => sources.some((known) => !!known(id));
}

/** Readiness is an explicit renderer signal, never an arbitrary startup delay. */
function rendererReadiness() {
  const ready = new Set();
  const pending = new Map();
  return {
    has: (id) => ready.has(id),
    mark(id) {
      ready.add(id);
      for (const done of pending.get(id) ?? []) done();
      pending.delete(id);
    },
    forget(id, closed = false) {
      ready.delete(id);
      if (closed) {
        for (const done of pending.get(id) ?? []) done(new Error('The app window was closed'));
        pending.delete(id);
      }
    },
    /** @returns {Promise<void>} */
    wait(id) {
      if (ready.has(id)) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const list = pending.get(id) ?? new Set();
        const done = (error = null) => {
          clearTimeout(timer);
          list.delete(done);
          error ? reject(error) : resolve();
        };
        const timer = setTimeout(() => {
          list.delete(done);
          if (!list.size) pending.delete(id);
          reject(new Error('The app is still starting. Try again.'));
        }, 30_000);
        list.add(done);
        pending.set(id, list);
      });
    },
  };
}
/** Requests in flight or accepted are remembered, so an IPC retry cannot send the same prompt twice; a failed or refused one is sent again. */
class QuickChatRequests {
  constructor() {
    this.once = sendOnce({ accepted: isAcceptedReceipt });
  }
  send(chatId, item, dispatch) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 128 || typeof item.text !== 'string')
      throw new Error('Invalid Quick Chat request');
    return this.once(identityKey(chatId, item.id), dispatch);
  }
}
module.exports = { QuickChatState, QuickChatRequests, rendererReadiness, knownChat, isQuickChatSender };
