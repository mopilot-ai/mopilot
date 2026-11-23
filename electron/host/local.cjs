// The local Host: the interface of electron/host/interface.cjs over the in-process ChatController, SessionStore and adapters. A facade; no logic moves here.
const { HostError, localHostInfo, ownedChat, assertHost } = require('./interface.cjs');

/**
 * @param {object} deps what electron/app/sessions.cjs builds; everything the Host uses is passed in, so it requires no Electron
 * @param {() => { send: Function, stopChat: Function, turnIs: Function }} deps.controller late-bound
 * @param {() => { snapshot: (chatId: string) => { rev: number } }} deps.state late-bound
 * @param {() => { stop: (chatId: string) => unknown }} deps.claudeTurns late-bound
 * @param {(chatId: string) => string} deps.family the harness family of the chat's current segment
 * @param {InstanceType<typeof import('./patchLog.cjs').PatchLog>} deps.log
 * @param {(chatId: string) => boolean} deps.owns whether the chat is one this Host runs
 * @param {() => string[]} deps.list the chats this Host runs
 * @param {(p: { value: string }) => unknown} deps.permit sets the permission mode new turns run under
 */
function createLocalHost({ controller, state, claudeTurns, family, log, owns, list, permit }) {
  let disposed = false;
  const live = () => {
    if (disposed) throw new HostError('disposed', 'This Host was disposed.');
  };
  const own = (/** @type {unknown} */ chatId) => (live(), ownedChat(owns, chatId));
  /** @type {Set<() => void>} */
  const stops = new Set();
  const host = {
    hostInfo: localHostInfo,
    chats: () => (live(), list()),
    /** @param {string} chatId @param {object} item @param {{ origin?: unknown, waitForDelivery?: boolean }} [opts] */
    async send(chatId, item, { origin = null, waitForDelivery = false } = {}) {
      own(chatId);
      // the message is the controller's once sent; disposing the Host only silences its feed, so a send in flight still reports what happened
      return controller().send(chatId, item, origin, waitForDelivery);
    },
    /** Stop pressed. `turnId`: the turn a button showed; 'retired' and nothing stops when another one runs. @param {string} chatId @param {unknown} [turnId] */
    stop(chatId, turnId) {
      own(chatId);
      const c = controller();
      if (!c.turnIs(chatId, turnId)) return 'retired';
      // the Stop button on a Claude chat also pauses the goal MoPilot holds (claudeTurns.stop); the other families use the generic Stop
      return family(chatId) === 'claude' ? claudeTurns().stop(chatId) : c.stopChat(chatId);
    },
    /** @param {{ chatId?: string, value: string }} p */
    async permit(p) {
      live();
      if (p.chatId !== undefined) ownedChat(owns, p.chatId);
      return permit(p);
    },
    /** The chat's state now plus the patches since `fromRev`; `patches` is null when the log lost some (use the snapshot alone). @param {string} chatId @param {number} [fromRev] */
    subscribe(chatId, fromRev) {
      own(chatId);
      const snapshot = state().snapshot(chatId);
      const patches = typeof fromRev === 'number' ? log.since(chatId, fromRev, snapshot.rev) : null;
      return { snapshot, patches };
    },
    events: {
      /** @param {(p: { chatId: string, rev: number, patch: object }) => void} fn */
      onPatch(fn) {
        live();
        const off = log.listen((p) => {
          if (!disposed && owns(p.chatId)) fn(p);
        });
        stops.add(off);
        return () => (off(), stops.delete(off));
      },
    },
    dispose() {
      disposed = true;
      for (const off of stops) off();
      stops.clear();
    },
  };
  return assertHost(host);
}

module.exports = { createLocalHost };
