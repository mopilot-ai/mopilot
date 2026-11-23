// The chats a window's request or a broadcast names, and ipcMain whose harness replies wait for the stream batcher's deltas.

/** The keys of a request or payload that name a chat, a session or a thread. */
const NAME_KEYS = ['chatId', 'threadId', 'sessionId', 'key', 'id', 'chat'];

/**
 * The chat ids, session keys and thread ids a request's arguments (or a broadcast's payload) name: string arguments, and
 * those properties of an object argument or of its `params`, one list level deep. Which chat each belongs to is the batcher's `resolve`.
 * @param {unknown[]} args
 * @returns {string[]}
 */
function namedChats(args) {
  /** @type {Set<string>} */
  const names = new Set();
  const add = (v) => typeof v === 'string' && v.length > 0 && v.length <= 256 && names.add(v);
  const fromObject = (o) => {
    for (const k of NAME_KEYS) add(o[k]);
  };
  const read = (a) => {
    if (typeof a === 'string') add(a);
    else if (a && typeof a === 'object') {
      fromObject(a);
      if (a.params && typeof a.params === 'object') fromObject(a.params);
    }
  };
  for (const a of args) {
    // codex:api and codex:leased carry their arguments in a list
    if (Array.isArray(a)) a.forEach(read);
    else read(a);
  }
  return [...names];
}

/**
 * ipcMain whose handlers on `channels` (by default every harness family's) answer through the batcher's `ordered`, so a
 * window's request (a chat's history, a thread read) is never answered ahead of events main sent before the answer.
 * @param {Electron.IpcMain} ipcMain
 * @param {(fn: () => unknown, args: unknown[]) => Promise<unknown>} ordered CoreBatcher.ordered of the app's batcher
 * @param {RegExp} [channels]
 * @returns {Electron.IpcMain}
 */
function orderedReplies(ipcMain, ordered, channels = /^(codex|claude|acp):/) {
  const wrap =
    (fn) =>
    (/** @type {any[]} */ ...args) =>
      // the arguments (the IPC event among them, which names nothing) say which chat the answer must not overtake
      ordered(() => fn(...args), args);
  return new Proxy(ipcMain, {
    get(target, prop) {
      const value = Reflect.get(target, prop);
      if (prop === 'handle' || prop === 'handleOnce')
        return (channel, fn) => value.call(target, channel, channels.test(channel) ? wrap(fn) : fn);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

module.exports = { namedChats, orderedReplies };
