// A remote Host seen with this app's chat ids: everything the app asks about a chat or hears about it is keyed by the id the app uses (shared/host/chatIds.mjs), the Host's own ids stay on the wire.
const { hostChatId, appChatId } = require('../../shared/host/chatIds.mjs');

/** @type {WeakMap<object, any>} */
const wrapped = new WeakMap();

/**
 * The same RemoteHost with chat ids translated at its edge. One wrapper per Host, so a consumer that compares connections sees the same object each time.
 * A Host id is read as a Host-family chat's only when the app has a chat of that app id (`known`): a Codex or Claude Code chat continued to a Host keeps the id it had here.
 * @template {Record<string, any>} H
 * @param {H} host
 * @param {(appId: string) => boolean} known
 * @returns {H}
 */
function withAppChatIds(host, known) {
  const prior = wrapped.get(host);
  if (prior) return prior;
  const appId = (/** @type {string} */ hostId) => {
    const mapped = appChatId(hostId);
    return mapped !== hostId && known(mapped) ? mapped : hostId;
  };
  /** @param {(...a: any[]) => () => void} on @param {(p: any) => void} fn */
  const heard = (on, fn) => on((/** @type {any} */ p) => fn({ ...p, chatId: appId(p.chatId) }));
  const asked = (/** @type {any} */ p) => (typeof p?.chatId === 'string' ? { ...p, chatId: hostChatId(p.chatId) } : p);
  const ids = (/** @type {string} */ chatId) => (typeof chatId === 'string' ? hostChatId(chatId) : chatId);
  const view = {
    ...host,
    call: (method, params) => host.call(method, asked(params)),
    send: (/** @type {string} */ chatId, /** @type {any} */ ...rest) => host.send(ids(chatId), ...rest),
    start: (/** @type {string} */ chatId, /** @type {any} */ ...rest) => {
      const [item] = rest;
      if (item?.sideChat) rest[0] = { ...item, sideChat: { ...item.sideChat, sourceId: ids(item.sideChat.sourceId) } };
      return host.start(ids(chatId), ...rest);
    },
    stop: (/** @type {string} */ chatId, /** @type {any} */ ...rest) => host.stop(ids(chatId), ...rest),
    switchTo: (/** @type {string} */ chatId, /** @type {any} */ ...rest) => host.switchTo(ids(chatId), ...rest),
    goal: (/** @type {string} */ chatId, /** @type {any} */ ...rest) => host.goal(ids(chatId), ...rest),
    removeChat: (/** @type {string} */ chatId, /** @type {any} */ ...rest) => host.removeChat(ids(chatId), ...rest),
    answer: (/** @type {any} */ p) => host.answer(asked(p)),
    permit: (/** @type {any} */ p) => host.permit(asked(p)),
    rename: (/** @type {any} */ p) => host.rename(asked(p)),
    subscribe: async (/** @type {string} */ chatId, /** @type {any} */ ...rest) => {
      const res = await host.subscribe(ids(chatId), ...rest);
      return res.patches ? { ...res, patches: res.patches.map((/** @type {any} */ p) => ({ ...p, chatId: appId(p.chatId) })) } : res;
    },
    browser: {
      ...host.browser,
      request: (/** @type {string} */ method, /** @type {any} */ p) => host.browser.request(method, asked(p)),
      onEvent: (/** @type {(p: any) => void} */ fn) => heard(host.browser.onEvent, fn),
    },
    tools: {
      ...host.tools,
      request: (/** @type {string} */ method, /** @type {any} */ p) => host.tools.request(method, asked(p)),
      onEvent: (/** @type {(p: any) => void} */ fn) => heard(host.tools.onEvent, fn),
    },
    events: {
      onPatch: (/** @type {(p: any) => void} */ fn) => heard(host.events.onPatch, fn),
      onFrame: (/** @type {(p: any) => void} */ fn) => heard(host.events.onFrame, fn),
      onClosed: (/** @type {(p: any) => void} */ fn) => heard(host.events.onClosed, fn),
      onResync: (/** @type {(p: any) => void} */ fn) => heard(host.events.onResync, fn),
      onInflight: (/** @type {(p: any) => void} */ fn) => heard(host.events.onInflight, fn),
    },
  };
  wrapped.set(host, view);
  return /** @type {H} */ (view);
}

module.exports = { withAppChatIds };
