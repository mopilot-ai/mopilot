// A remote Host's own desktop as the transport the computer-use tools drive (G8 #3903, host/src/desktopHost.mjs): `desktop.*` requests over the Host connection, with their failures as the tool layer reports them. It holds no reference to this Mac's helper on purpose: a call that fails fails, and nothing here can reach this Mac's desktop instead.
const crypto = require('node:crypto');
const { ToolError } = require('../capabilities/contract/registry.cjs');
const { DESKTOP_READS } = require('../../shared/host/desktop.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { UNKNOWN_OWNER } = require('../../shared/host/desktop.mjs');
const { userIdleSeconds } = require('../platform/userIdle.cjs');

/** What the Host and the connection say when a desktop cannot be had, in the words an agent can act on. */
const REFUSED = {
  feature_missing: 'This Host is too old to serve a desktop. Update it.',
  unsupported: 'This Host has no desktop to serve.',
};

/**
 * @param {any} e
 * @returns {InstanceType<typeof ToolError>}
 */
function asToolError(e) {
  if (e instanceof ToolError) return e;
  const code = typeof e?.code === 'string' ? e.code : 'failed';
  // a Host that cannot serve it at all is a missing capability, as every other tool without its surface (hostScope.cjs)
  if (code === 'feature_missing' || code === 'unsupported') return new ToolError(REFUSED[code], 'capability_missing');
  if (code === 'host_unreachable') return new ToolError(String(e?.message ?? 'The host is unreachable.'), 'not_connected');
  return new ToolError(String(e?.message ?? e), code);
}

/**
 * @param {object} o
 * @param {{ desktop: { request: (method: string, params: object) => Promise<any> }, state: () => string, onState?: (fn: (state: string) => void) => () => void }} o.host a remote Host (remote.cjs)
 */
function createRemoteDesktop({ host }) {
  // A stable remote Host object reconnects internally. Its synchronous state events retire the old connection even without another tool or pane read.
  let generation = 0;
  host.onState?.(() => {
    generation++;
  });
  /**
   * @param {string} method @param {object} params
   * @param {boolean} [write] an action that changes the desktop: if the connection is lost after it was sent, whether it happened is not known
   */
  const call = (method, params, write = false) =>
    host.desktop.request(method, params).catch((/** @type {any} */ e) => {
      // sent, and the answer was lost: the Host may have acted. Told as that, never as a plain "unreachable", so the chat looks before it acts again (a retry of a write is a new call, and would act twice)
      if (write && e?.code === 'host_unreachable' && e.notSent !== true)
        return Promise.reject(
          new ToolError(
            'The connection to the Host dropped after this action was sent, so it may or may not have happened. Take a fresh screenshot and check before acting again.',
            'outcome_unknown',
          ),
        );
      return Promise.reject(asToolError(e));
    });
  return {
    generation: () => generation,
    /** Takes the Host's desktop for the chat, with the apps it may control (a list of bundle ids, or '*'). @param {string} chatId @param {string[] | '*'} apps */
    lease: (chatId, apps) => call('desktop.lease', { chatId, apps }),
    /**
     * One helper request on the Host's desktop. A call id makes a resend safe: keep the one from a call that got no answer and send it again, and the Host acts once.
     * @param {string} chatId @param {string} method @param {object} [params] @param {{ callId?: string }} [o]
     */
    command: (chatId, method, params = {}, { callId = crypto.randomUUID() } = {}) =>
      call('desktop.call', { chatId, callId, method, params }, !DESKTOP_READS.has(method)),
    /** Lets go of the desktop. @param {string} chatId */
    release: (chatId) => call('desktop.release', { chatId }),
    /** Stop: a call waiting on the Host fails at once and the desktop is let go. @param {string} chatId */
    abort: (chatId) => call('desktop.abort', { chatId }),
    /** Whether the chat holds the Host's desktop, whether another chat does, and whether this Host can serve one. @param {string} chatId */
    state: (chatId) => call('desktop.state', { chatId }),
    /** Whether the Host answers now: the tunnel and the connection are up. */
    alive: () => host.state() === 'online',
  };
}

/**
 * What the computer-use setup needs of the app to run a chat that lives on a machine on that machine's own desktop (capabilities/hostDesktop.cjs): which machine a chat lives on, that machine's desktop over its live connection (none while it is not connected), and the idle time of this Mac's user.
 * @param {any} live main's late-bound services
 */
function hostDesktopOptions(live) {
  /** One RemoteDesktop per live connection. @type {WeakMap<object, ReturnType<typeof createRemoteDesktop>>} */
  const made = new WeakMap();
  return {
    // where a chat lives: its machine's id, null for this Mac, and UNKNOWN_OWNER when that cannot be told (no ownership service, or it failed): a tool call then fails, and is never run on this Mac in its place
    hostOwner: (/** @type {string} */ chatId) => {
      try {
        const hostId = live.hostOwnership?.get(chatId).hostId;
        if (hostId === undefined) return UNKNOWN_OWNER;
        return hostId && hostId !== 'local' ? hostId : null;
      } catch (error) {
        noteIgnored('read which machine a chat lives on for its desktop', error);
        return UNKNOWN_OWNER;
      }
    },
    hostEpoch: (/** @type {string} */ chatId) => live.hostOwnership?.get(chatId).epoch,
    hostName: (/** @type {string} */ hostId) => live.hostNameOf?.(hostId) ?? 'another machine',
    // the pane hears a chat's desktop tab appear, change or go (the agent-tab list that also lists its browser tabs)
    desktopTabsChanged: (/** @type {string} */ chatId) => live.agentTabsChanged?.(chatId),
    remoteDesktopFor: (/** @type {string} */ hostId) => {
      const host = live.connectedHostFor?.(hostId);
      if (!host) return null;
      let desktop = made.get(host);
      if (!desktop) made.set(host, (desktop = createRemoteDesktop({ host })));
      return desktop;
    },
    // the user's own device decides whether anyone is here for a Host chat; the guest's idle time says nothing about them
    userIdleSeconds,
  };
}

module.exports = { createRemoteDesktop, asToolError, hostDesktopOptions };
