// What becomes of a followed chat's catch-up that failed (#5404): a read that failed on this try is read again, a few times; any other failure means the Host no longer serves the chat, and the windows are told why.
const { clock } = require('../platform/ports/clock.cjs');
const { fanOut } = require('./remoteChannels.cjs');

/** Failures of a chat's catch-up that are read again: the answer was bad or too big on this try, the chat is still the Host's. */
const RETRYABLE = new Set(['invalid', 'host_error', 'timeout']);
const TRIES = 5;
const WAIT_MS = 1000;

/**
 * @param {object} o
 * @param {Map<string, unknown>} o.subs the chats the window follows
 * @param {() => boolean} o.disposed
 * @param {(chatId: string) => unknown} o.again reads the chat's catch-up once more
 * @param {Set<(p: { chatId: string, reason: string }) => void>} o.closedFns the windows told that the Host's stream of a chat ended
 */
/** A timer that never keeps the process alive: a wait to read a chat again is not work the app must stay up for. @param {() => void} fn @param {number} ms */
function later(fn, ms) {
  const timer = clock.setTimeout(fn, ms);
  if (typeof timer === 'object') timer.unref();
}

function createCatchUpRetries({ subs, disposed, again, closedFns }) {
  /** The failed tries of each chat's catch-up. @type {Map<string, number>} */
  const tries = new Map();
  return {
    /** The catch-up of the chat was answered. @param {string} chatId */
    done: (chatId) => void tries.delete(chatId),
    /** The catch-up failed with `error` (a dropped connection is not told: it catches up again when it returns). @param {string} chatId @param {any} error */
    failed(chatId, error) {
      if (error?.code === 'host_unreachable') return;
      const n = (tries.get(chatId) ?? 0) + 1;
      if (subs.has(chatId) && !disposed() && RETRYABLE.has(error?.code) && n <= TRIES) {
        tries.set(chatId, n);
        later(() => void again(chatId), WAIT_MS * 2 ** (n - 1));
        return;
      }
      tries.delete(chatId);
      if (subs.delete(chatId)) fanOut(closedFns, { chatId, reason: String(error?.code) }, 'a close');
    },
  };
}

module.exports = { createCatchUpRetries, later };
