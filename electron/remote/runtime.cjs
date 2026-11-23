// Mobile Remote in main (the "core" slice): the Mac's identity, paired-phone list, pairing service, relay client and sealed channel, made once and running only while the remote.enabled switch is on (off by default; flipping it starts or stops everything, and nothing is created, read or written while it is off). Their files live in <userData>/remote, sealed by safeStorage. This slice has no UI and no IPC: the remote service (electron/remote/service.cjs) consumes live.remote.channel, and Settings will call live.remote.pairing. Never throws; a failure is noted and leaves live.remote with nothing running.
const path = require('node:path');
const { createHash } = require('node:crypto');
const { isEnabled } = require('../platform/flags.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { managedEndpoint } = require('../platform/managedPolicy.cjs');
const { endpoints } = require('../platform/mopilotEndpoints.cjs');
const { toWire } = require('./esm.cjs');
const { accountUser } = require('./accountScope.cjs');
const { createSodiumPrimitives } = require('./sodiumPrimitives.cjs');
const { IdentityStore } = require('./identity.cjs');
const { DeviceList } = require('./deviceList.cjs');
const { RelayClient } = require('./relayClient.cjs');
const { PairingService } = require('./pairing.cjs');
const { sharedLedger } = require('./sendLedger.cjs');
const { RemoteChannel } = require('./channel.cjs');
const { createPairConfirm } = require('./pairApproval.cjs');
const { createPushBridge } = require('./pushBridge.cjs');
const { createActivityBridge } = require('./activityBridge.cjs');
const { isMomoMeta } = require('../../shared/momoChat.mjs');
const { PushTitles } = require('./pushTitles.cjs');
const { createPhonePresence } = require('./phonePresence.cjs');

const FLAG = 'remote.enabled';
/** MoPilot's relay, where this build has the MoPilot service; without it the phone needs one named (and an account) */
const DEFAULT_RELAY_URL = endpoints?.RELAY_URL ?? null;

/**
 * @param {object} o
 * @param {string} o.userData
 * @param {{ mopilot?: { relayToken(force?: boolean): Promise<string | null>, relayRefusal?: 'disabled' | null }, computerUse?: { broker?: any }, notifier?: { onBanner: unknown, onCatchUp: unknown, onSettled: unknown, idleMs(): number | null, getKinds(): Record<string, boolean> } | null, controller?: { state?: any }, chats?: { records: Map<string, any> }, codex?: { chatName?(chatId: string): string | null | undefined } | null, momoPushBody?: (chatId: string) => string, momoPushBodyOn?: () => boolean }} o.live
 * @param {() => boolean} [o.flagOn]
 * @param {() => string | null} [o.chatId] the chat the pairing card is put in; none means a pairing can't be confirmed (Settings supplies it)
 * @param {{ isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string }} [o.safeStorage] Electron's, from main
 * @param {import('./sealedJson.cjs').FsPromises} [o.fs] from main (this layer requires neither electron nor fs)
 * @param {(url: string, headers: Record<string, string>) => import('../remote/relayClient.cjs').RelaySocket} [o.createSocket]
 * @param {string} [o.relayUrl]
 * @param {() => string | null} [o.scope] stable account and device identity, null when signed out
 * @param {() => boolean} [o.optedIn] local consent
 * @param {(channel: InstanceType<typeof RemoteChannel> | null) => void} [o.onChannel] attach or detach the service
 * @param {(req: { device: { id: string, name: string }, safetyNumber: string, signal: AbortSignal }) => Promise<'allow' | 'deny' | null>} [o.confirm]
 */
function openRemote({
  userData,
  live,
  flagOn = () => isEnabled(FLAG),
  chatId = () => null,
  safeStorage,
  fs,
  createSocket,
  relayUrl,
  scope = () => 'legacy',
  optedIn = () => true,
  onChannel = () => undefined,
  confirm,
}) {
  /** @type {null | { relay: InstanceType<typeof RelayClient>, channel: InstanceType<typeof RemoteChannel>, pairing: InstanceType<typeof PairingService>, devices: InstanceType<typeof DeviceList>, identity: InstanceType<typeof IdentityStore>, pushTitles: InstanceType<typeof PushTitles>, presence: ReturnType<typeof createPhonePresence> }} */
  let running = null;
  let starting = false;
  /** @type {string | null} */
  let owner = null;
  let revision = 0;
  let closed = false;
  const url = () => relayUrl ?? managedEndpoint('relay') ?? process.env.MOPILOT_RELAY_URL ?? DEFAULT_RELAY_URL;
  // what the Mac's chats are doing, for a phone's Live Activity: counts and kinds from the session store (every harness), a title only as a sealed blob
  const sessions = live.controller?.state;
  const activity = createActivityBridge({
    state: sessions ?? null,
    owns: (chatId) => {
      // only asked for chats the session store has, so the app's chat records exist
      const record = /** @type {any} */ (live.chats).records.get(chatId);
      return !!record && !isMomoMeta(record.meta);
    },
    titleOf: (chatId) => live.codex?.chatName?.(chatId) || null,
    remote: () => remote,
  });

  // A switch or owner change retires one stack; terminal close also prevents future reconciliation.
  const retire = () => {
    revision++;
    const r = running;
    running = null;
    owner = null;
    onChannel(null);
    if (!r) return;
    r.pairing.cancel();
    r.pushTitles.stop();
    r.channel.stop();
    r.relay.stop();
    activity.reset();
  };

  async function start(key) {
    const dir =
      key === 'legacy' ? path.join(userData, 'remote') : path.join(userData, 'remote', createHash('sha256').update(key).digest('hex'));
    if (!safeStorage || !fs) throw new Error('Mobile Remote needs main to pass safeStorage and fs');
    const safe = safeStorage;
    const prim = createSodiumPrimitives();
    const identity = new IdentityStore({ file: path.join(dir, 'identity.key'), safe, fs, prim });
    const devices = new DeviceList({ file: path.join(dir, 'devices.key'), safe, fs });
    const relay = new RelayClient({
      url,
      getToken: async (force) => {
        if (closed || scope() !== key || !flagOn() || !optedIn()) return null;
        const token = await (live.mopilot?.relayToken(force) ?? Promise.resolve(null));
        return !closed && scope() === key && flagOn() && optedIn() ? token : null;
      },
      refused: () => live.mopilot?.relayRefusal ?? null,
      createSocket,
    });
    const presence = createPhonePresence(relay);
    const pairing = new PairingService({
      identity,
      devices,
      prim,
      relayUrl: url,
      account: () => accountUser(live.mopilot),
      registerPair: (pair) => relay.registerPair(pair),
      removePair: (pair) => relay.removePair(pair),
      sendReply: async (frame) => {
        if (relay.sendFrame(toWire(frame)) === 'dropped') throw new Error('The relay is not accepting messages');
      },
      confirm: confirm ?? createPairConfirm({ broker: () => live.computerUse?.broker ?? null, chatId }),
    });
    // a pair the relay still holds for a phone this Mac no longer has is removed there
    relay.on('open', ({ pairs }) => void pairing.reconcile(pairs));
    relay.on('event', (event) => {
      if (event?.ev === 'pair.removed' && typeof event.pair === 'string') pairing.pairRemoved(event.pair);
      // a phone that has just joined is told what the Mac is doing
      if (event?.ev === 'pair.joined') activity.changed();
    });
    // a new connection may be to a relay that lost what it held
    relay.on('open', () => activity.resend());
    const sendLedger = sharedLedger(path.join(dir, 'sends.json'), { fs, safe, note: noteIgnored });
    const channel = new RemoteChannel({
      devices,
      relay,
      prim,
      sendLedger,
      onHello: (frame) => pairing.handleHello(frame),
      phoneAbsent: (pairId) => presence.isAbsent(pairId),
      onPhoneFrame: (pairId, receivedAt, sentAt) => presence.markPresent(pairId, receivedAt, sentAt),
    });
    await channel.start();
    const pushTitles = new PushTitles({
      file: path.join(dir, 'push.key'),
      safe,
      fs,
      prim,
      identity,
      channel,
      devices,
      bodyOn: () => live.momoPushBodyOn?.() === true,
    });
    return { relay, channel, pairing, devices, identity, pushTitles, presence };
  }

  const remote = {
    /** The channel the remote service consumes (null while off). */
    get channel() {
      return running?.channel ?? null;
    },
    get pairing() {
      return running?.pairing ?? null;
    },
    get devices() {
      return running?.devices ?? null;
    },
    /** Which paired phones are connected now (null while off). */
    get presence() {
      return running?.presence ?? null;
    },
    /** One push request to the relay while Mobile Remote runs; rejects when it is off or the relay is down (the banner already showed). */
    pushRequest(/** @type {{ pair: string, kind: string, ref: string, sealed?: string }} */ req) {
      return running ? running.relay.pushRequest(req) : Promise.reject(new Error('Mobile Remote is off'));
    },
    /** One snapshot of the Mac's chats to the relay for a phone's Live Activity while Mobile Remote runs; rejects when it is off or the relay is down. */
    activityUpdate(/** @type {{ pair: string, state: object }} */ req) {
      return running ? running.relay.activityUpdate(req) : Promise.reject(new Error('Mobile Remote is off'));
    },
    /** Chat titles in push (opt-in; Settings calls setEnabled); null while off. */
    get pushTitles() {
      return running?.pushTitles ?? null;
    },
    get running() {
      return running !== null;
    },
    /** Why the relay is turning this Mac away, while it is (at capacity, the account's device limit, or switched off for the account); null otherwise and while off. */
    get refusal() {
      return running?.relay.refusal ?? null;
    },
    /** Follows the switch: starts when it turns on, stops when it turns off. Never throws. */
    async sync() {
      if (closed) return;
      try {
        const key = flagOn() && optedIn() ? scope() : null;
        if (owner !== key) retire();
        if (!key || running || starting) return;
        starting = true;
        owner = key;
        const mine = ++revision;
        try {
          const next = await start(key);
          if (closed || revision !== mine || !flagOn() || !optedIn() || scope() !== key) {
            next.pairing.cancel();
            next.pushTitles.stop();
            next.channel.stop();
            next.relay.stop();
          } else {
            running = next;
            owner = key;
            next.relay.start();
            onChannel(next.channel);
          }
        } finally {
          starting = false;
          if (!closed && revision !== mine) void remote.sync();
        }
      } catch (error) {
        noteIgnored('start Mobile Remote', error);
      }
    },
    /** Terminal shutdown: no late startup, token or sync can restart it; the files stay. */
    close() {
      closed = true;
      retire();
    },
  };
  // each change of a chat's turn is a reason to tell the paired phones (chained onto the store's publish, as the Host's patch log is)
  if (sessions) {
    const publish = sessions.publish;
    sessions.publish = (/** @type {any} */ p) => {
      if (p?.patch && Object.hasOwn(p.patch, 'turn')) activity.changed();
      return publish.call(sessions, p);
    };
  }
  // a banner the Mac shows also becomes a push to the paired phones (main's notifier exists by now; nothing is sent while the switch is off)
  const notifier = live.notifier;
  if (notifier) {
    const bridge = createPushBridge({
      remote: () => remote,
      getKinds: () => notifier.getKinds(),
      idleMs: () => notifier.idleMs(),
      // MoMo's opt-in push body, asked at each send (momoBackground.cjs sets live.momoPushBody once MoMo is open)
      bodyOf: (chatId) => live.momoPushBody?.(chatId) ?? '',
    });
    notifier.onBanner = bridge.onBanner;
    notifier.onSettled = bridge.cancel;
    // what quiet hours kept back is said once when they end
    notifier.onCatchUp = bridge.catchUp;
  }
  return remote;
}

module.exports = { openRemote, FLAG, DEFAULT_RELAY_URL };
