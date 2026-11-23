// The computer-use tools for a chat that lives on a Host (G8 #3903): one stack (ComputerUse, DesktopControl, AppScopedControl) per Host, over a RemoteHelper that drives that Host's own desktop, and the routing that sends a chat's `desktop_*` calls to the stack of the Host that owns the chat.
//
// The same policy code runs as for a chat on this Mac (grants, approval cards, the permission mode, attendance, take-over); only the helper under it differs. What belongs to this Mac's screen is left out of a Host stack on purpose: no control overlay, no global Esc, no hiding of MoPilot's windows, no clipboard, no teach tooltip. Approvals are kept apart from this Mac's (hostGrants.cjs) and the cards name the machine. A call for a chat that lives on a Host never reaches this Mac's stack: a Host that is not connected, a chat whose machine cannot be told, or a tool the stack lacks answers with an error, and there is no path from here to this Mac's helper.
const { benchAttended: vmBenchAttended } = require('../platform/virtualMachine.cjs');
const { ComputerUse } = require('./tools/computer.cjs');
const { DesktopControl } = require('./tools/desktop.cjs');
const { AppScopedControl } = require('./tools/appScoped.cjs');
const { ToolError } = require('./contract/registry.cjs');
/** @typedef {{ lease: (chatId: string, apps: string[] | '*') => Promise<any>, command: (chatId: string, method: string, params?: object, opts?: { callId?: string }) => Promise<any>, release: (chatId: string) => Promise<any>, abort: (chatId: string) => Promise<any>, state: (chatId: string) => Promise<any>, alive: () => boolean, generation?: () => number }} RemoteDesktopLike a Host's desktop over its connection (electron/host/remoteDesktop.cjs) */
const { UNKNOWN_OWNER } = require('../../shared/host/desktop.mjs');
const { createHostApprovals, hostsWithGrants } = require('./hostApprovals.cjs');
const { registerRemoteDesktopView } = require('./hostDesktopView.cjs');
const { createHostDesktopTabs } = require('./hostDesktopTabs.cjs');
const { createHostCursor, cursorAround } = require('./hostDesktopCursor.cjs');

const { setTimeout: sleepMs } = require('node:timers/promises');
const { removeHostGrants } = require('./hostGrants.cjs');
const { unattendedReason } = require('./contract/policy.cjs');
const { chatAnchorOf } = require('./anchor.cjs');
const { hostGrantStore } = require('./hostGrants.cjs');
const { RemoteHelper } = require('./computerRemote.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** What `hostOwner` answers when it cannot tell where a chat lives: the call fails, and is not run on this Mac instead. */

/**
 * The `unattended(chatId, ctx)` check for a chat on a Host: null when the user counts as present, else why not. The user is the person at THIS Mac (their own device's idle time, injected), never the guest's desktop. A reading that fails counts as nobody being here, because this Mac cannot show the user is present without it.
 * @param {{ sessions: { get(chatId: string): any }, controller: { isSubagentCall(chatId: string, callId?: string | null): boolean }, kindOf: (chatId: string) => string, userIdleSeconds: () => Promise<number>, benchAttended?: () => Promise<boolean> }} o
 */
function sandboxAttendance({ sessions, controller, kindOf, userIdleSeconds, benchAttended = async () => false }) {
  return async (/** @type {string} */ chatId, /** @type {{ callId?: string | null } | undefined} */ ctx) => {
    const s = sessions.get(chatId);
    let idleMs = Number.POSITIVE_INFINITY;
    try {
      // the bench switch counts the user as present, honored only inside a VM (electron/platform/virtualMachine.cjs); one that cannot be read is off
      const switched = await Promise.resolve()
        .then(() => benchAttended())
        .catch((error) => {
          noteIgnored('read the bench switch for a Host desktop', error);
          return false;
        });
      idleMs = switched ? 0 : (await userIdleSeconds()) * 1000;
    } catch (error) {
      noteIgnored("read the user's idle time for a Host desktop", error);
    }
    return unattendedReason({
      turn: s.activeTurn,
      scheduled: !!s.scheduled?.unattended,
      subagent: controller.isSubagentCall(chatId, ctx?.callId),
      idleMs,
      basic: kindOf(chatId).startsWith('acp'),
      promptActive: !!s.activeTurn,
    });
  };
}

/**
 * The apps a chat may control, as the Host takes them: the bundle ids it has grants for, and an empty list (a lease with no apps yet, which the Host holds to the lookups) when it has none. Never wider than the grants: revoking the last one narrows the lease, it does not open it.
 * @param {{ granted(chatId: string): Map<string, { bundleId?: string }> }} desktop
 * @returns {(chatId: string) => string[]}
 */
function appsOf(desktop) {
  return (chatId) =>
    [...desktop.granted(chatId).values()]
      .map((g) => g.bundleId)
      .filter(/** @returns {id is string} */ (id) => typeof id === 'string' && id.length > 0);
}

/**
 * The approval broker for a Host's stack: every card says which machine it is for.
 * @param {any} broker @param {string} machine
 */
function machineBroker(broker, machine) {
  return new Proxy(broker, {
    get: (target, prop) => {
      if (prop === 'ask')
        return (/** @type {string} */ chatId, /** @type {string} */ kind, /** @type {object} */ params, /** @type {any} */ opts) =>
          target.ask(chatId, kind, { ...params, machine }, opts);
      const v = target[prop];
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
}

/**
 * One Host's stack.
 * @param {object} o
 * @param {RemoteDesktopLike} o.remote
 * @param {any} o.grants this Host's own approvals (hostGrants.cjs) @param {any} o.broker
 * @param {{ get(chatId: string): any }} o.sessions
 * @param {any} o.controller
 * @param {(chatId: string) => string} o.kindOf
 * @param {(chatId: string) => 'readOnly' | 'ask' | 'auto' | 'full'} o.anchorOf
 * @param {() => Promise<number>} o.userIdleSeconds
 * @param {() => Promise<boolean>} [o.benchAttended] the VM-only bench switch
 * @param {() => boolean} o.unattendedAllowed
 * @param {(chatId: string, e: any) => void} o.onUnattended
 * @param {(chatId: string) => void} o.onStop
 * @param {(chatId: string) => string | null} [o.modelOf]
 * @param {{ note: (chatId: string) => void, driven: (chatId: string) => boolean }} [o.desktopTab] the chat's pane tab for this desktop (hostDesktopTabs.cjs)
 * @param {(chatId: string) => unknown} [o.ownerEpoch]
 * @param {NonNullable<ConstructorParameters<typeof RemoteHelper>[0]['currentRemote']>} [o.currentRemote]
 * @param {{ around: NonNullable<ConstructorParameters<typeof RemoteHelper>[0]['around']>, onShot: (chatId: string, shot: any) => void }} [o.cursor] what the pane shows of the agent's pointer actions (hostDesktopCursor.cjs)
 */
function buildStack(o) {
  /** @type {InstanceType<typeof DesktopControl>} */
  let desktop;
  const helper = new RemoteHelper({
    remote: o.remote,
    currentRemote: o.currentRemote,
    ownerEpoch: o.ownerEpoch,
    appsOf: (chatId) => appsOf(desktop)(chatId),
    idleSeconds: o.userIdleSeconds,
    onLeased: o.desktopTab?.note,
    paused: o.desktopTab?.driven,
    around: o.cursor?.around,
    onShot: o.cursor?.onShot,
  });
  const cu = new ComputerUse({
    helper,
    grants: o.grants,
    broker: o.broker,
    session: (chatId) => o.sessions.get(chatId),
    harness: o.kindOf,
    anchor: o.anchorOf,
    unattended: sandboxAttendance({
      sessions: o.sessions,
      controller: o.controller,
      kindOf: o.kindOf,
      userIdleSeconds: o.userIdleSeconds,
      benchAttended: o.benchAttended,
    }),
    unattendedAllowed: o.unattendedAllowed,
    onUnattended: o.onUnattended,
    onStop: o.onStop,
  });
  desktop = new DesktopControl({
    helper,
    cu,
    grants: o.grants,
    broker: o.broker,
    // nothing of this Mac's screen: no control overlay or global Esc, no clipboard, no teach tooltip, none of its windows hidden
    electron: null,
    indicator: null,
    host: null,
    hideBeforeAction: () => false,
    modelOf: o.modelOf,
  });
  const apps = new AppScopedControl({ desktop, helper, cu, broker: o.broker });
  /** @type {Map<string, (args: any, ctx: any) => any>} */
  const handlers = new Map([...desktop.tools(), ...apps.tools()].map((t) => [t.name, t.handler]));
  return { helper, cu, desktop, apps, handlers };
}

/**
 * @param {object} o
 * @param {(chatId: string) => string | null} o.ownerOf the Host that runs the chat now, null for a chat that lives on this Mac, or UNKNOWN_OWNER when that cannot be told
 * @param {(chatId: string) => unknown} [o.epochOf]
 * @param {(hostId: string) => RemoteDesktopLike | null} o.remoteFor that Host's desktop, or null while it is not connected
 * @param {(hostId: string) => any} o.grantsFor that Host's own approvals
 * @param {(hostId: string) => string} o.nameOf that Host's name, for the cards
 * @param {Omit<Parameters<typeof buildStack>[0], 'remote' | 'grants' | 'desktopTab' | 'cursor' | 'currentRemote' | 'ownerEpoch'> & { desktopTabs?: ReturnType<typeof createHostDesktopTabs>, cursorFor?: (hostId: string) => NonNullable<Parameters<typeof buildStack>[0]['cursor']>, hostLost?: (hostId: string) => void }} o.deps what a stack is built from
 * @param {typeof buildStack} [o.build]
 */
function createHostDesktop({ ownerOf, epochOf, remoteFor, grantsFor, nameOf, deps, build = buildStack }) {
  /** host id -> its stack and the connection it was built over @type {Map<string, { stack: ReturnType<typeof buildStack>, remote: any }>} */
  const stacks = new Map();
  /** The stack for a Host, built when a chat first needs it and kept across reconnects; null while the Host is not connected. @param {string} hostId */
  const stackFor = (hostId) => {
    const remote = remoteFor(hostId);
    if (!remote) return null;
    const known = stacks.get(hostId);
    if (known) {
      // a new connection to the same Host: the chats keep their grants, and the helper talks over the new one (its leases are gone with the old)
      if (known.remote !== remote) {
        known.stack.helper.setRemote(remote);
        known.remote = remote;
        if (deps.hostLost) deps.hostLost(hostId);
        else deps.desktopTabs?.hostLost(hostId);
      }
      return known.stack;
    }
    const tabs = deps.desktopTabs;
    const stack = build({
      ...deps,
      remote,
      ownerEpoch: epochOf,
      currentRemote: (chatId, expected) => ownerOf(chatId) === hostId && remoteFor(hostId) === expected,
      grants: grantsFor(hostId),
      broker: machineBroker(deps.broker, nameOf(hostId)),
      ...(deps.cursorFor ? { cursor: deps.cursorFor(hostId) } : {}),
      ...(tabs ? { desktopTab: { note: (chatId) => tabs.note(chatId, hostId, true), driven: (chatId) => tabs.takenOver(chatId) } } : {}),
    });
    stacks.set(hostId, { stack, remote });
    return stack;
  };
  /** The stack of the Host a chat lives on, when one was built. @param {string} chatId */
  const stackOf = (chatId) => {
    const hostId = ownerOf(chatId);
    return hostId === null || hostId === UNKNOWN_OWNER ? null : (stacks.get(hostId)?.stack ?? null);
  };
  return {
    /**
     * The tools as the registry should hold them: a chat on this Mac runs the tool it always did, a chat on a Host runs the same tool in that Host's stack. A chat on a Host, or one whose machine cannot be told, never runs this Mac's.
     * @template {{ name: string, handler: (args: any, ctx: any) => any }} T
     * @param {T[]} tools
     */
    route: (tools) =>
      tools.map((tool) => ({
        ...tool,
        handler: async (/** @type {any} */ args, /** @type {any} */ ctx) => {
          const hostId = ownerOf(ctx?.chatId);
          if (hostId === null) return tool.handler(args, ctx);
          if (hostId === UNKNOWN_OWNER)
            throw new ToolError('Where this chat runs could not be read, so its desktop is not used. Try again.', 'unavailable');
          const stack = stackFor(hostId);
          if (!stack) throw new ToolError("This chat's Host is not connected, so there is no desktop to use.", 'not_connected');
          const handler = stack.handlers.get(tool.name);
          if (!handler) throw new ToolError(`${tool.name} isn't available on this chat's host`, 'capability_missing');
          return handler(args, ctx);
        },
      })),
    /** Stop on a chat: its Host's desktop fails what waits and lets go. A Host that cannot be reached has nothing more to stop. @param {string} chatId */
    abort: (chatId) =>
      (stackOf(chatId)?.helper.abortChat(chatId) ?? Promise.resolve()).catch((error) =>
        noteIgnored("stop a chat's desktop on its Host", error),
      ),
    /** A chat's turn ended or was stopped: the Host lets go of what it held for it. @param {string} chatId @param {number} turn */
    async turnEnded(chatId, turn) {
      await stackOf(chatId)?.helper.revokeTurn(chatId, turn);
    },
    /** A turn of a chat on a Host ended or was stopped: the stack lets go of what it held for the chat (the lock, held keys, the app locks), as the stack of this Mac does. @param {string} chatId */
    async chatTurnEnded(chatId) {
      const stack = stackOf(chatId);
      if (!stack) return;
      stack.cu.interrupt(chatId);
      stack.apps.turnEnded(chatId);
      await stack.desktop.turnEnded(chatId);
    },
    /** The chat ended (deleted or archived), wherever it lived: every Host's stack forgets its grants and gives its desktop up at once. @param {string} chatId */
    async forget(chatId) {
      for (const { stack } of stacks.values()) {
        try {
          stack.apps.forget(chatId);
          await stack.desktop.forget(chatId);
          await stack.helper.forgetChat(chatId);
        } catch (error) {
          noteIgnored("end a finished chat's desktop on a Host", error);
        }
      }
    },
    /** A machine that is gone: its stack (and the approvals it holds in memory) is dropped. @param {string} hostId */
    drop: (hostId) => void stacks.delete(hostId),
    /** The Host's stack, when one was built (a test or the Settings page may look). @param {string} hostId */
    stack: (hostId) => stacks.get(hostId)?.stack ?? null,
  };
}

/**
 * The router for computer use as the app sets it up (computerUse.cjs): a chat on a Host uses that Host's desktop through the same tools; null when the app does not say where chats live, and then every chat is on this Mac. Also hears the registry: Stop on a chat, the end of its turn, and the end of the chat (the local `desktop.forget`, which the app and the IPC already call, also ends it on its Host).
 * @param {any} o setupComputerUse's options: hostOwner, hostName, remoteDesktopFor, userIdleSeconds, registry, sessions, controller, prefs, remote, userData, flags, onChange
 * @param {{ broker: any, kindOf: (chatId: string) => string, cu: any, desktop: any, modelOf: (chatId: string) => string | null }} p
 */
function hostDesktopFor(o, p) {
  if (!o.hostOwner) return null;
  /** @type {Map<string, any>} */
  const grants = new Map();
  /** @param {string} hostId */
  const grantsFor = (hostId) => {
    if (!grants.has(hostId))
      grants.set(hostId, hostGrantStore({ dir: o.userData, hostId, onChange: (chatId) => o.broadcast('computer:changed', { chatId }) }));
    return grants.get(hostId);
  };
  /** @param {string} hostId */
  const nameOf = (hostId) => o.hostName?.(hostId) ?? 'another machine';
  /** chat id -> its takeover's stop of the agent's side, which the user's own lease waits for @type {Map<string, Promise<void>>} */
  const holds = new Map();
  // the chat's pane tab for its Host's desktop, beside its browser tabs (hostDesktopTabs.cjs)
  const tabs = createHostDesktopTabs({
    onChange: (chatId) => o.desktopTabsChanged?.(chatId),
    nameOf,
    // a takeover stops what the agent runs on the Host and lets go of the keys and buttons it holds (Stop's abort), then the user's input takes its own lease
    hold: (chatId) => {
      hd.stack(String(hostOf(chatId)))?.desktop.interrupt(chatId);
      const stop = hd.abort(chatId);
      holds.set(chatId, stop);
      cursor.hide(chatId);
      // nothing waits for it later
      void stop.finally(() => holds.get(chatId) === stop && holds.delete(chatId));
    },
    // the pane opens the tab, unless the user closed it before (the same rule as for an agent's browser tab); after the tab list reached the windows, which names its machine
    onOpen: (chatId, tabKey) => setImmediate(() => o.broadcast('app:command', 'open-agent-browser-tab', { chatId, tabKey, auto: true })),
  });
  /** The pane the cursor is drawn in, once it is registered (below). @type {{ cursorTo: (chatId: string, message: { hostId: string }) => void, aroundAction: <T>(hostId: string, chatId: string, method: string, run: () => Promise<T>) => Promise<T>, retireChat: (chatId: string) => void, retireHost: (hostId: string) => void } | null} */
  let view = null;
  const cursor = createHostCursor({ emit: (chatId, message) => view?.cursorTo(chatId, /** @type {{ hostId: string }} */ (message)) });
  const hostLost = (/** @type {string} */ hostId) => {
    tabs.hostLost(hostId);
    cursor.hideHost(hostId);
    view?.retireHost(hostId);
  };
  const hd = createHostDesktop({
    ownerOf: o.hostOwner,
    epochOf: o.hostEpoch,
    remoteFor: o.remoteDesktopFor,
    grantsFor,
    nameOf,
    deps: {
      broker: p.broker,
      sessions: o.sessions,
      controller: o.controller,
      kindOf: p.kindOf,
      anchorOf: (chatId) => chatAnchorOf(chatId, { sessions: o.sessions, controller: o.controller, prefs: o.prefs, remote: o.remote }),
      userIdleSeconds: o.userIdleSeconds,
      benchAttended: o.benchAttended ?? vmBenchAttended,
      unattendedAllowed: () => p.cu.unattendedAllowed(),
      onUnattended: (chatId, e) => {
        // the chat is paused and its turn stopped: say why in the log, where a run on a runner can be read
        noteIgnored('a Host desktop call was refused as unattended', new Error(`${e?.code}: ${e?.message}`));
        return p.cu.onUnattended(chatId, e);
      },
      onStop: p.cu.onStop.bind(p.cu),
      modelOf: p.modelOf,
      desktopTabs: tabs,
      hostLost,
      cursorFor: (hostId) => {
        const around = cursorAround(cursor, hostId, o.sleep ?? sleepMs, (chatId) => tabs.takenOver(chatId));
        return {
          // The view is registered below before this runtime exposes any tool handler.
          around: (chatId, method, params, run) =>
            /** @type {ReturnType<typeof registerRemoteDesktopView>} */ (view).aroundAction(hostId, chatId, method, () =>
              around(chatId, method, params, run),
            ),
          onShot: (chatId, shot) => void cursor.agentSaw(hostId, chatId, shot),
        };
      },
    },
  });
  // what is approved on each machine: Settings lists it and takes it back (hostApprovals.cjs)
  const approvals = createHostApprovals({
    grantsFor,
    nameOf,
    knownHosts: () => hostsWithGrants(o.userData),
    stackOf: (hostId) => hd.stack(hostId),
    forget: (hostId) => {
      hd.drop(hostId);
      tabs.forgetHost(hostId);
      grants.delete(hostId);
      removeHostGrants(o.userData, hostId);
    },
  });
  approvals.register(o.ipcMain);
  // the pane shows a Host chat's desktop by its frames, and the user's takeover input reaches it (hostDesktopView.cjs)
  const hostOf = (/** @type {string} */ chatId) => {
    const hostId = o.hostOwner(chatId);
    return hostId === null || hostId === UNKNOWN_OWNER ? null : hostId;
  };
  view = registerRemoteDesktopView({
    ipcMain: o.ipcMain,
    remoteOf: (hostId) => o.remoteDesktopFor(hostId),
    hostOf,
    takenOver: (chatId) => tabs.takenOver(chatId),
    agentHolds: (chatId) => hd.stack(String(hostOf(chatId)))?.helper.leased.has(chatId) === true,
    frameVersion: cursor.frameVersion,
    settled: (chatId) => holds.get(chatId),
    hostLost,
    report: noteIgnored,
  });
  o.registry.onAbort?.((/** @type {string} */ chatId) => (cursor.hide(chatId), view?.retireChat(chatId), void hd.abort(chatId)));
  o.registry.turns?.onRetire((/** @type {string} */ chat, /** @type {number} */ turn) => {
    tabs.idle(chat);
    cursor.hide(chat);
    view?.retireChat(chat);
    hd.chatTurnEnded(chat).catch((error) => noteIgnored("clean up a Host chat's desktop at the end of its turn", error));
    hd.turnEnded(chat, turn).catch((error) => noteIgnored("let go of a chat's Host desktop at the end of its turn", error));
  });
  // a deleted or archived chat (appState and the IPC both call desktop.forget) also lets go of its Host's desktop at once
  const forgetLocal = p.desktop.forget.bind(p.desktop);
  p.desktop.forget = async (/** @type {string} */ chatId) => {
    tabs.forget(chatId);
    cursor.forget(chatId);
    view?.retireChat(chatId);
    await Promise.all([forgetLocal(chatId), hd.forget(chatId)]);
  };
  return Object.assign(hd, { approvals, tabs });
}

module.exports = { createHostDesktop, hostDesktopFor, buildStack, sandboxAttendance, appsOf, machineBroker, UNKNOWN_OWNER };
