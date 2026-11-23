// Computer access in main (#1364): the remote owners every tool reads instead of a chat (electron/computerAccess/owners.cjs),
// what a remote owner held when it goes away, and this Mac's side (electron/computerAccess/host.cjs): its encrypted
// store, its access log and the listener, behind the person's switch and the remote one. The client tools join here
// in a later step.
const os = require('node:os');
const path = require('node:path');
const { RemoteOwners } = require('../computerAccess/owners.cjs');
const { AccessStore } = require('../computerAccess/store.cjs');
const { AccessLog } = require('../computerAccess/accessLog.cjs');
const { ComputerAccessHost } = require('../computerAccess/host.cjs');
const { ComputerAccessClient } = require('../computerAccess/client.cjs');
const { chatModel } = require('../capabilities/computerUse.cjs');
const { chatAnchorOf } = require('../capabilities/anchor.cjs');
const { acceptWebSocket } = require('../capabilities/browser/wsServer.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** The remote switch: on unless MoPilot turns computer access off everywhere (the person's own switch is off by default). */
const FLAG = 'shared.computerAccess.enabled';

/** This Mac's first IPv4 address on a network, for the pairing offer when other computers may connect. */
function lanAddress(nets = os.networkInterfaces()) {
  for (const list of Object.values(nets)) for (const n of list ?? []) if (n.family === 'IPv4' && !n.internal) return n.address;
  return null;
}

/**
 * @param {{ live: { sessions?: any, browserGrants?: any, chromeGrants?: any, capabilities?: any, computerUse?: any, controller?: any, chats?: any, notifier?: any, transcripts?: any, ledger?: any },
 *   app?: { getPath(name: 'userData'): string }, safeStorage?: any, isFlagEnabled?: (key: string) => boolean,
 *   prefs?: () => any, broadcastAll?: (channel: string, payload?: unknown) => void }} deps
 */
function createComputerAccess({ live, app, safeStorage, isFlagEnabled, prefs, broadcastAll }) {
  /** Chats on paired devices that use this Mac's tools, each an owner of its own (never a chat here). */
  const owners = new RemoteOwners();
  // an owner that goes away forgets its site answers (the host ends its turn: electron/computerAccess/host.cjs)
  const forget = (owner) => {
    live.browserGrants?.forget(owner.id);
    live.chromeGrants?.forget(owner.id);
  };
  owners.onClose(forget);
  // a card withdrawn as the owner closed settles after the close and can record a refusal: a new owner of the same
  // device chat starts without it
  owners.onOpen(forget);
  // a chat on a paired device starting to use this Mac says so, whatever window is open (and with none)
  owners.onOpen((owner) =>
    live.notifier?.notify('computer', owner.id, {
      title: `${owner.deviceName} is using this Mac`,
      body: `A ${owner.harness} chat on ${owner.deviceName}. Stop it in Settings → Computer access, or press Esc while it controls apps.`,
      chatTitle: owner.deviceName,
      group: 'remote',
    }),
  );
  /** @type {InstanceType<typeof ComputerAccessHost> | null} this Mac's side, once main's services are up */
  let host = null;
  /** @type {InstanceType<typeof ComputerAccessClient> | null} the computers this install uses, once main is up */
  let client = null;
  const deviceName = () => os.hostname().replace(/\.local$/, '');
  /** What a call tells the computer about the chat here making it: its turn, harness, model and mode. */
  const facts = (/** @type {string} */ chatId) => {
    const s = live.sessions.get(chatId);
    const kind = live.controller.ref(chatId).kind;
    return {
      turn: s.activeTurn?.id != null ? String(s.activeTurn.id) : 'no-turn',
      human: s.activeTurn?.human === true,
      unattended: s.scheduled?.unattended === true,
      harness: kind,
      model: chatModel(kind, live.chats?.record?.(chatId), prefs?.()),
      anchor: chatAnchorOf(chatId, { sessions: live.sessions, controller: live.controller, prefs }),
    };
  };
  /** At startup, once the registry, the sessions and computer use are up: listens if the person turned access on. */
  function open() {
    if (host || !app || !safeStorage || !isFlagEnabled) return host;
    const dir = path.join(app.getPath('userData'), 'computer-access');
    const store = new AccessStore({ file: path.join(dir, 'store.json'), safeStorage });
    host = new ComputerAccessHost({
      store,
      owners,
      registry: () => live.capabilities,
      answer: (id, result) => live.computerUse?.broker.answer(id, result) ?? false,
      sessions: () => live.sessions,
      hostAnchor: () => prefs?.()?.permission ?? null,
      flagOn: () => isFlagEnabled(FLAG),
      log: new AccessLog({ dir: path.join(dir, 'log'), writer: live.transcripts }),
      ledger: () => live.ledger?.store ?? null,
      hostName: deviceName,
      lanAddress: () => lanAddress(),
      accept: acceptWebSocket,
    });
    host.on('change', () => broadcastAll?.('computerAccess:changed'));
    client = new ComputerAccessClient({
      store,
      broker: () => (live.computerUse ? live.computerUse.broker : null),
      facts,
      stopChat: (chatId) => live.controller.stopChat(chatId),
      deviceName,
    });
    client.on('change', () => broadcastAll?.('computerAccess:changed'));
    // the tools are offered on every harness's channel while a computer is paired
    client.sync(live.capabilities);
    sync();
    return host;
  }
  /** The switches changed (the remote one, the person's): listen or stop as they say now. */
  function sync() {
    host?.sync().catch((error) => noteIgnored('start or stop computer access', error));
  }
  return {
    owners,
    open,
    sync,
    get host() {
      return host;
    },
    get client() {
      return client;
    },
    /** A SessionState change: a remote owner's cards go to its device; a chat's turn here ending ends it on its computers. */
    onSessionPatch: (/** @type {any} */ p) => {
      host?.onSessionPatch(p);
      client?.onSessionPatch(p);
    },
  };
}

/**
 * Stop for computer use's Esc, tray and pausing refusals: a remote owner's stop goes to its device's chat, never to a
 * chat here (electron/computerAccess/owners.cjs).
 * @param {{ remoteOwners: InstanceType<typeof RemoteOwners>, controller: { stopChat(id: string): Promise<any> } }} live
 */
const stopOwnerOrChat = (live) => (chatId) =>
  live.remoteOwners.get(chatId) ? live.remoteOwners.stop(chatId) : live.controller.stopChat(chatId);

/**
 * Whether a chat gets the saved ("Always allow") sites and may add to them: a remote owner does not.
 * @param {{ remoteOwners?: InstanceType<typeof RemoteOwners> }} live
 */
const usesSavedSites = (live) => (chatId) => !live.remoteOwners?.get(chatId);

/**
 * A card notification about a remote owner names its device and where to answer (never "Codex needs your approval" for
 * a chat that isn't here); any other notification, and any chat's, goes as it was.
 * @param {InstanceType<typeof RemoteOwners> | null | undefined} owners @param {string} chatId @param {any} opts
 * @param {string} [kind] the notification's kind: only an approval is about the person's OK
 */
function remoteNotice(owners, chatId, opts, kind = 'approval') {
  const owner = owners?.get(chatId);
  if (!owner || kind !== 'approval') return opts;
  // a device set to "only this Mac can approve" never shows the card itself
  const where = owner.hostOnlyApprovals
    ? 'Answer in Settings → Computer access.'
    : `Answer in Settings → Computer access, or on ${owner.deviceName}.`;
  return {
    ...opts,
    title: `${owner.deviceName} needs your OK on this Mac`,
    body: `A chat on ${owner.deviceName} is using this Mac. ${where}`,
    chatTitle: owner.deviceName,
  };
}

/**
 * Where a notification's click goes: a remote owner's to Settings → Computer access (it has no chat here), a chat's to
 * the chat. As [command, argument] for the main window.
 * @param {InstanceType<typeof RemoteOwners> | null | undefined} owners @param {string} chatId
 */
const notificationTarget = (owners, chatId) =>
  /** @type {[string, string]} */ (
    // a notice that names a Settings page rather than a chat (app/chromeAskNotice.cjs)
    chatId.startsWith('settings:')
      ? ['settings', chatId.slice('settings:'.length)]
      : owners?.get(chatId)
        ? ['settings', 'computer-access']
        : ['open-chat', chatId]
  );

/**
 * A notification's click: the chat it named opens, or Settings → Computer access for a remote owner; a window that
 * can't take the command says so in the diagnostics.
 * @param {InstanceType<typeof RemoteOwners> | null | undefined} owners
 * @param {(cmd: string, ...args: unknown[]) => Promise<unknown>} command the main window's command (opened if needed)
 * @param {string} chatId
 */
const openNotified = (owners, command, chatId) =>
  void command(...notificationTarget(owners, chatId)).catch((error) => noteIgnored('open the chat a notification named', error));

/**
 * The Electron modules the desktop_* tools get: the window ones from main, plus app icons (capabilities/appIdentity.cjs) and Reduce Motion
 * (the phantom cursor).
 */
function desktopElectron(modules) {
  const { nativeImage, systemPreferences } = require('electron');
  return { ...modules, nativeImage, systemPreferences };
}

module.exports = {
  desktopElectron,
  createComputerAccess,
  stopOwnerOrChat,
  usesSavedSites,
  lanAddress,
  remoteNotice,
  notificationTarget,
  openNotified,
  FLAG,
};
