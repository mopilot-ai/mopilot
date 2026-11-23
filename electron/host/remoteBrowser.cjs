// A remote Host's browser service as the transport the remote tabs drive (electron/capabilities/browser/remoteHost.cjs, package 2.6): `browser.*` requests over the Host connection, and the tab events the Host sends back.
//
// The Host keeps a chat's tabs while the Mac is away. When the connection returns, the transport asks which tabs the chat still has
// (that also makes the Host send their events again) and tells the chat's listeners about the ones that went meanwhile.

const { noteIgnored } = require('../ignored.cjs');

/**
 * @param {object} o
 * @param {{ browser: { request: (method: string, params: object) => Promise<any>, onEvent: (fn: (e: { chatId: string, payload: any }) => void) => () => void },
 *           state: () => string, onState: (fn: (s: string) => void) => () => void }} o.host a remote Host (remote.cjs)
 */
function createRemoteBrowserTransport({ host }) {
  /** chat id -> its listeners. @type {Map<string, Set<(event: any) => void>>} */
  const listeners = new Map();
  /** chat id -> the target ids the Host has told us of. @type {Map<string, Set<string>>} */
  const known = new Map();
  const tell = (/** @type {string} */ chatId, /** @type {any} */ event) => {
    for (const fn of [...(listeners.get(chatId) ?? [])]) fn(event);
  };
  const targets = (/** @type {string} */ chatId) => {
    let set = known.get(chatId);
    if (!set) known.set(chatId, (set = new Set()));
    return set;
  };

  const offEvent = host.browser.onEvent(({ chatId, payload }) => {
    if (payload?.type === 'opened') targets(chatId).add(payload.targetId);
    else if (payload?.type === 'closed' && payload.targetId) targets(chatId).delete(payload.targetId);
    else if (payload?.type === 'closed' || payload?.type === 'exit') known.delete(chatId);
    tell(chatId, payload);
  });

  /** The connection is back: the Host sends the chat's events again, and a tab it no longer has is closed here. @param {string} chatId */
  async function resume(chatId) {
    const { tabs } = await host.browser.request('browser.tabs', { chatId });
    const live = new Set(tabs.map((/** @type {{ targetId: string }} */ t) => t.targetId));
    for (const targetId of [...targets(chatId)]) {
      if (live.has(targetId)) continue;
      targets(chatId).delete(targetId);
      tell(chatId, { type: 'closed', targetId });
    }
  }
  const offState = host.onState((s) => {
    if (s !== 'online') return;
    for (const chatId of [...listeners.keys()])
      resume(chatId).catch((error) => noteIgnored("read a chat's tabs on a Host after the connection returned", error));
  });

  /** @param {string} method @param {object} params */
  const call = (method, params) => host.browser.request(method, params);
  return {
    async open(/** @type {string} */ chatId) {
      const tab = await call('browser.open', { chatId });
      targets(chatId).add(tab.targetId);
      return tab;
    },
    attach: (/** @type {string} */ chatId, /** @type {string} */ targetId) => call('browser.attach', { chatId, targetId }),
    detach: (/** @type {string} */ chatId, /** @type {string} */ targetId) => call('browser.detach', { chatId, targetId }),
    command: (/** @type {string} */ chatId, /** @type {{ targetId: string, sessionId: string, method: string, params: object }} */ req) =>
      call('browser.command', { chatId, ...req }),
    async close(/** @type {string} */ chatId, /** @type {string} */ targetId) {
      const out = await call('browser.close', { chatId, targetId });
      targets(chatId).delete(targetId);
      return out;
    },
    async release(/** @type {string} */ chatId) {
      known.delete(chatId);
      return call('browser.release', { chatId });
    },
    abort: (/** @type {string} */ chatId) => call('browser.abort', { chatId }),
    /** Hears the chat's tab events; the Host sends them once the chat has opened a tab here. @param {string} chatId @param {(event: any) => void} fn */
    subscribe(chatId, fn) {
      let set = listeners.get(chatId);
      if (!set) listeners.set(chatId, (set = new Set()));
      set.add(fn);
      return () => {
        set.delete(fn);
        if (set.size === 0 && listeners.get(chatId) === set) listeners.delete(chatId);
      };
    },
    /** Whether the Host answers now: the tunnel and the connection are up. */
    alive: () => host.state() === 'online',
    dispose() {
      offEvent();
      offState();
      listeners.clear();
      known.clear();
    },
  };
}

module.exports = { createRemoteBrowserTransport };
