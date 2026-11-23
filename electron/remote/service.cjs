// The remote client service: one request set (design/mobile-remote protocol.html) that serves the Chrome side panel and paired phones, written against an injected transport so it needs neither crypto nor a relay.
//
// A client is the panel (always on, in this process) or a phone (a pair on the attached transport). Every request goes
// through call(): its method must be one the Mac allows this client, its params are checked by the schema the panel and
// the phones share (shared/remote/schema.mjs), then the method (electron/remote/methods) runs against the same operations
// the panel always used. A phone's request id is its idempotency id: the last REPLAYS replies per pair are replayed instead of acting twice.
const { ownedMessageParams } = require('./messageIdentity.cjs');
const { randomUUID } = require('node:crypto');
const os = require('node:os');
const { parseParams, knownMethod, PARSERS, SchemaError } = require('../../shared/remote/schema.mjs');
const { noteIgnored, messageOf } = require('../ignored.cjs');
const { RemoteError, RefusalError } = require('./serviceErrors.cjs');
const { HOST_METHODS, directOf, directSignature, machinesOf, machinesSignature } = require('./phoneMachines.cjs');
const { CardLedger } = require('./cardLedger.cjs');
const { viewOf, changesCards } = require('./sessionView.cjs');
const { Mirrors } = require('./mirrors.cjs');
const { fitEvent } = require('./fitFrame.cjs');
const { createEventBudget } = require('./eventBudget.cjs');
const { createChatsChanged } = require('./chatsChanged.cjs');
const METHODS = require('./methods/index.cjs');
const { placed, WaitingCards } = require('./phoneCards.cjs');
const { CardUpdates, FollowedChats } = require('./cardUpdates.cjs');

/** What a phone reads when its answer did not fit in one frame. */
const TOO_LARGE = 'That answer is too large to send to your phone.';
/** The most bytes a snapshot may take once encoded: a reply must fit one 256 KB sealed frame with room for the envelope around it. */
const SNAPSHOT_BYTES = 200_000;
/** The shortest a long string in a snapshot is cut to before older items are dropped instead; only a string over 50,000 characters is cut at all. */
const SNAPSHOT_CUT_FLOOR = 40_000;
/** The most bytes an event may take once encoded; a longer one is shortened (remote/fitFrame.cjs). */
const EVENT_BYTES = 200_000;
/** How many replies per pair are kept to answer a retried request. */
const REPLAYS = 1000;
/** The panel: always allowed what a phone may not be. */
const PANEL = Object.freeze({ kind: /** @type {const} */ ('panel') });
/** Methods that only the panel makes (they act on the Mac's own windows and Chrome). */
const PANEL_ONLY = new Set(['panel.browserSettings', 'chat.open', 'dictation.begin', 'dictation.end']);
/** Methods that only a phone makes. */
const PHONE_ONLY = new Set([
  'chat.follow',
  'chat.unfollow',
  'device.unpair',
  'diff.list',
  'diff.read',
  'file.read',
  'mentions.list',
  'mentions.start',
  'push.settings.get',
  'push.settings.set',
  'steps.thumbnail',
  'messages.image',
  'surface.current',
  ...HOST_METHODS,
  'chats.rename',
  'chat.sideChat',
  'chats.archive',
]);

/**
 * @typedef {{ kind: 'panel' } | { kind: 'phone', pairId: string, follows: Set<string> }} Client
 * @typedef {object} Policy what this Mac lets a phone do
 * @property {(pairId: string, method: string) => boolean} [allow] a method this device may call (default: all a phone may)
 * @property {() => string} [permissionCeiling] the highest permission a phone may set (default 'auto-review'); full access is never
 * @property {(pairId: string) => boolean} [mirrors] whether the Mac turned terminal and frame mirrors on for this device (default off)
 * @property {() => boolean} [allowPersistent] a card choice that makes an allowance permanent (default off)
 * @property {(pairId: string) => boolean | Promise<boolean>} [onUnpair] the device asked to leave: the device list forgets the pair
 */

/** A phone is not a Chrome tab: whatever tab it names is dropped, so no "[Chrome tab: …]" line reaches a chat from it. */
function withoutTab(/** @type {any} */ params) {
  if (!params || typeof params !== 'object' || !('tab' in params)) return params;
  const { tab: _tab, ...rest } = params;
  return rest;
}

/** A thrown error as a reply carries it. */
function wireError(/** @type {unknown} */ error, /** @type {string} */ goneText) {
  if (error instanceof RemoteError || error instanceof RefusalError) return { code: error.code, message: error.message };
  if (error instanceof SchemaError) return { code: 'invalid', message: error.message };
  const message = messageOf(error);
  return { code: message === goneText ? 'gone' : 'failed', message };
}

class RemoteService {
  /**
   * @param {object} o
   * @param {Record<string, any>} o.ops what the service reads and does: the panel's operations (app/chromePanel.cjs),
   *   plus state, reachable, cardsOf and items for phones
   * @param {Policy} [o.policy]
   * @param {() => boolean} [o.momoAllowed] whether MoMo is allowed for the signed-in account (momo/access.cjs)
   * @param {() => object | null} [o.momo] MoMo's operations for phones (remote/momoOps.cjs), once main has made them
   * @param {{ api: () => { view: () => Promise<unknown>, intent: (raw: unknown) => Promise<unknown>, hostCall?: (method: string, params: object) => Promise<unknown> } | null, flagOn: () => boolean, on: (fn: (payload: object) => void) => () => void } | null} [o.momoHome] MoMo's home for phones (app/homeChannel.cjs): its API once main has one, the `momo.home` flag (off: `momo.home.*` and the hello's `momoHome` are absent) and its changes
   * @param {(pairId: string) => boolean} [o.phoneAbsent] whether the relay says that pair's phone is not connected (no live stream is sent to it)
   * @param {() => any} [o.host] the user's remote machines for phones (app/hostPhone.cjs), once Host's IPC has made them
   * @param {object | null} [o.pushSettings] the notification settings a phone may read and change (remote/pushSettingsOps.cjs); null when this build has none
   * @param {string} [o.version] the app's version
   * @param {() => string} [o.machineName] this computer's name as a phone shows it (machine.hello); the host name's first label by default
   * @param {string} [o.goneText] the message a read of a chat that is gone fails with (it replies with the code 'gone')
   * @param {() => number} [o.now]
   */
  constructor({
    ops,
    policy = {},
    momoAllowed = () => false,
    momo = () => null,
    momoHome = null,
    host = () => null,
    pushSettings = null,
    version = '',
    machineName = () => os.hostname().split('.')[0],
    phoneAbsent = () => false,
    goneText = '',
    now = Date.now,
  }) {
    this.goneText = goneText;
    this.ops = ops;
    this.policy = policy;
    this.momoAllowed = momoAllowed;
    this.momo = momo;
    this.momoHome = momoHome;
    /** @type {(() => void) | null} */
    this.stopHome = null;
    this.host = host;
    /** @type {Map<string, string>} what machines.changed last told each phone, so a heartbeat that changes nothing it shows sends nothing */
    this.machinesSent = new Map();
    /** @type {Promise<void>} */
    this.machinesChain = Promise.resolve();
    this.pushSettings = pushSettings;
    this.version = version;
    this.machineName = machineName;
    /** whether the relay says a pair's phone is not connected: live stream events are not queued for it (it reads the chat again when it returns) */
    this.phoneAbsent = phoneAbsent;
    this.now = now;
    this.ledger = new CardLedger();
    /** a followed turn's live events stay within the data budget: tool output is cut once it is spent */
    this.budget = createEventBudget();
    this.mirror = new Mirrors(this);
    /** a phone's chat list is kept live by one event for a burst of changes (chatsChanged.cjs) */
    this.listChanged = createChatsChanged({ send: () => this.#chatsChanged() });
    /** @type {Map<string, Promise<unknown>>} chat -> its last follow-up send */
    this.sends = new Map();
    /** @type {Map<string, object>} chat -> who owns its pending sends (a Stop retires them) */
    this.sendOwners = new Map();
    /** @type {Map<string, { client: Extract<Client, { kind: 'phone' }>, replays: Map<string, Promise<object>> }>} */
    this.phones = new Map();
    /** the hand-offs only the Mac finishes, told to a chat's followers as they begin and end */
    this.waiting = new WaitingCards(this);
    this.cardUpdates = new CardUpdates(this);
    /** @type {Map<string, Promise<void>>} chat -> the last event being sent for it, so a chat's events keep their order */
    this.chains = new Map();
    /** @type {import('../../shared/remote/transport.mjs').RemoteTransport | null} */
    this.transport = null;
    /** @type {(() => void) | null} */
    this.unsubscribe = null;
  }

  /** Whether the client may call the method on this Mac. */
  permitted(/** @type {Client} */ client, /** @type {string} */ method) {
    // MoMo's methods are a phone's: the panel never reaches MoMo
    if (method.startsWith('momo.')) return client.kind === 'phone' && this.policy.allow?.(client.pairId, method) !== false;
    if (client.kind === 'panel') return !PHONE_ONLY.has(method);
    if (PANEL_ONLY.has(method)) return false;
    if (method === 'device.unpair' && !this.policy.onUnpair) return false;
    return this.policy.allow?.(client.pairId, method) !== false;
  }

  /** Whether MoMo's home is offered to phones: MoMo is allowed for the account and the `momo.home` flag is on. */
  homeOffered() {
    return this.momoAllowed() === true && this.momoHome?.flagOn() === true;
  }

  /** Whether this account may see its remote machines (Host's gate): without it a phone never sees one. */
  hostAllowed() {
    return this.host()?.allowed() === true;
  }

  /** Whether the client is still served: the panel always, a phone until its pair is removed (a request in flight when the Mac removes a phone stops here). */
  paired(/** @type {Client} */ client) {
    return client.kind !== 'phone' || this.phones.get(client.pairId)?.client === client;
  }

  /** Throws unless the client is still served (see `paired`): the check a method makes after an await and before an effect. */
  assertPaired(/** @type {Client} */ client) {
    if (!this.paired(client)) throw new RemoteError('forbidden', 'This device is no longer paired.');
  }

  /** The methods the client may call, for machine.hello. */
  methodsFor(/** @type {Client} */ client) {
    const momo = this.momoAllowed() === true;
    const host = this.hostAllowed();
    return Object.keys(PARSERS).filter(
      (m) =>
        (momo || !m.startsWith('momo.')) &&
        (this.homeOffered() || !m.startsWith('momo.home.')) &&
        (host || !HOST_METHODS.includes(m)) &&
        this.permitted(client, m),
    );
  }

  /**
   * One request: authorized, checked, run. Throws a RemoteError (forbidden, stale, gone), a SchemaError (invalid) or the operation's own error.
   * @param {Client} client @param {string} method @param {unknown} params
   */
  async call(client, method, params) {
    // an account MoMo isn't allowed for gets no momo.* at all, whatever the method: answered exactly as an unknown method, before the schema or the operations
    const hidden =
      typeof method === 'string' &&
      ((method.startsWith('momo.') && this.momoAllowed() !== true) || (method.startsWith('momo.home.') && !this.homeOffered()));
    if (hidden || !knownMethod(method)) throw new SchemaError(`Unknown request: ${method}`);
    // an account without Host gets no machine: refused before the schema or the operations
    if (HOST_METHODS.includes(method) && !this.hostAllowed())
      throw new RemoteError('forbidden', "Remote machines aren't available for this account.");
    if (!this.permitted(client, method)) throw new RemoteError('forbidden', "This Mac doesn't allow that from this device.");
    return METHODS[method](
      this,
      client,
      ownedMessageParams(client, method, parseParams(method, client.kind === 'phone' ? withoutTab(params) : params)),
    );
  }

  /** Serves the paired devices on a transport; replaces an earlier one. */
  attach(/** @type {import('../../shared/remote/transport.mjs').RemoteTransport} */ transport) {
    this.detach();
    this.stopHome = this.momoHome?.on((payload) => this.onMomoHomeChanged(payload)) ?? null;
    this.transport = transport;
    const sync = (/** @type {string[]} */ pairs) => {
      for (const pairId of pairs)
        if (!this.phones.has(pairId))
          this.phones.set(pairId, {
            client: {
              kind: 'phone',
              pairId,
              follows: new FollowedChats((chatId) => {
                if (!this.followers(chatId).length) this.cardUpdates.retire(chatId);
              }),
            },
            replays: new Map(),
          });
      for (const [pairId, phone] of [...this.phones]) {
        if (pairs.includes(pairId)) continue;
        this.phones.delete(pairId);
        this.machinesSent.delete(pairId);
        this.mirror.dropPair(pairId);
        for (const chatId of phone.client.follows)
          if (!this.followers(chatId).length) {
            this.ledger.forget(chatId);
            this.cardUpdates.retire(chatId);
          }
      }
    };
    const offs = [
      transport.onMessage((pairId, msg) => void this.#incoming(pairId, msg)),
      transport.onPairsChanged(sync),
      this.waiting.follow(),
    ];
    this.unsubscribe = () => offs.forEach((off) => off());
    sync(transport.pairs());
  }

  /** Stops serving devices. */
  detach() {
    this.stopHome?.();
    this.stopHome = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.transport = null;
    this.mirror.closeAll();
    this.phones.clear();
    this.machinesSent.clear();
    this.cardUpdates.clear();
  }

  async #incoming(/** @type {string} */ pairId, /** @type {import('../../shared/remote/transport.mjs').RemoteMessage} */ msg) {
    const phone = this.phones.get(pairId);
    if (!phone || msg?.kind !== 'request' || typeof msg.id !== 'string' || !msg.id) return;
    let reply = phone.replays.get(msg.id);
    if (!reply) {
      reply = this.#run(phone.client, msg);
      phone.replays.set(msg.id, reply);
      while (phone.replays.size > REPLAYS) phone.replays.delete(/** @type {string} */ (phone.replays.keys().next().value));
    }
    const sent = await reply;
    if (this.phones.get(pairId) !== phone) return;
    const failure = await this.#send(pairId, sent);
    // an answer too large for one frame would leave the request to time out on the phone: it gets a small error now, and a retry gets the same
    if (/** @type {any} */ (failure)?.code === 'size') {
      const failed = { ...sent, ok: false, result: undefined, error: { code: 'failed', message: TOO_LARGE } };
      phone.replays.set(msg.id, Promise.resolve(failed));
      await this.#send(pairId, failed);
    }
  }

  async #run(/** @type {Extract<Client, { kind: 'phone' }>} */ client, /** @type {any} */ msg) {
    const base = { id: `m_${randomUUID()}`, t: this.now(), kind: /** @type {const} */ ('reply'), inReplyTo: msg.id };
    try {
      return { ...base, ok: true, result: (await this.call(client, String(msg.method), msg.params)) ?? {} };
    } catch (error) {
      return { ...base, ok: false, error: wireError(error, this.goneText) };
    }
  }

  /** @returns {Promise<unknown>} the error when the transport did not take the message, else null */
  async #send(/** @type {string} */ pairId, /** @type {any} */ msg) {
    try {
      await this.transport?.send(pairId, msg);
      return null;
    } catch (error) {
      noteIgnored('send to a paired phone', error);
      return error;
    }
  }

  /** The phones that follow a chat. */
  followers(/** @type {string} */ chatId) {
    return [...this.phones.values()].filter((p) => p.client.follows.has(chatId));
  }

  /** Runs `fn` after the chat's earlier events, so a phone gets them in the order they happened. */
  enqueue(/** @type {string} */ chatId, /** @type {() => Promise<void>} */ fn) {
    const tail = (this.chains.get(chatId) ?? Promise.resolve())
      .then(fn)
      .catch((error) => noteIgnored('send an event to a paired phone', error));
    this.chains.set(chatId, tail);
    void tail.then(() => {
      if (this.chains.get(chatId) === tail) this.chains.delete(chatId);
    });
    return tail;
  }

  /**
   * The cards up in a chat as a phone sees them (no versions), each with the rev it was raised at and whether the phone can answer it
   * (`where`); with them, the hand-offs only the Mac finishes (./phoneCards.cjs). Records them.
   */
  cardsFor(/** @type {string} */ chatId, /** @type {number} */ rev, /** @type {() => boolean} */ may = () => true) {
    return this.cardUpdates.cardsFor(chatId, rev, may);
  }

  /** Place a ready card list and record its versions without awaiting history on the live queue. */
  placeCards(
    /** @type {string} */ chatId,
    /** @type {number} */ rev,
    /** @type {any[]} */ offered,
    /** @type {import('./cardUpdates.cjs').CardRead} */ owner,
  ) {
    const waiting = this.waiting.of(chatId);
    this.waiting.sent(chatId, waiting);
    const cards = [...offered, ...waiting];
    this.ledger.seen(
      chatId,
      cards.map((c) => c.version),
      rev,
    );
    const seen = cards.map(({ version, ...card }) => ({ ...placed(card), rev: this.ledger.revOf(chatId, version) }));
    this.cardUpdates.placed(chatId, rev, seen, owner);
    return seen;
  }

  /**
   * A chat as chat.follow starts it: its SessionState at a rev, the cards up and the last `n` items. The items are halved until
   * the snapshot fits one frame (a last item that is too large is shortened), so a chat with long messages still opens instead of failing every time.
   */
  async snapshot(/** @type {string} */ chatId, /** @type {number} */ n, /** @type {() => boolean} */ may = () => true) {
    const transport = this.transport;
    const epoch = this.cardUpdates.epoch;
    const state = this.ops.state.snapshot(chatId);
    const cards = this.cardsFor(chatId, state.rev, may);
    for (let count = n; ; count = Math.floor(count / 2)) {
      const [seen, items] = await Promise.all([cards, this.ops.items(chatId, count)]);
      if (this.transport !== transport || this.cardUpdates.epoch !== epoch || !may())
        throw new RemoteError('stale', 'This chat is no longer open. Try opening it again.');
      const snapshot = { chatId, rev: state.rev, session: { ...viewOf(state), cards: seen }, ...items };
      if (count === 0 || Buffer.byteLength(JSON.stringify(snapshot)) <= SNAPSHOT_BYTES) return snapshot;
      // a huge string (a tool's output) is cut first, down to a size that leaves ordinary messages whole, so the items around it
      // stay; only when that is not enough do older items go
      const trimmed = fitEvent(snapshot, SNAPSHOT_BYTES, SNAPSHOT_CUT_FLOOR);
      if (trimmed) return trimmed;
      // one item that is itself too large is shortened rather than left out
      if (count === 1) {
        const fitted = fitEvent(snapshot, SNAPSHOT_BYTES);
        if (fitted) return fitted;
      }
    }
  }

  /** A change to a chat's SessionState (SessionStore's publish): followers get it as session.patch, in rev order. */
  onSessionPatch(/** @type {{ chatId: string, rev: number, patch: Record<string, any> }} */ { chatId, rev, patch }) {
    // the list shows each chat's state: any chat's change may move a row, followed or not
    this.listChanged.changed(this.now());
    if (changesCards(patch)) this.cardUpdates.retire(chatId);
    if (!this.followers(chatId).length) return;
    void this.enqueue(chatId, async () => {
      const view = viewOf(patch);
      for (const p of this.followers(chatId))
        await this.#send(p.client.pairId, this.#event({ ev: 'session.patch', chatId, rev, patch: view }));
    });
    if (changesCards(patch)) this.cardUpdates.changed(chatId);
  }

  /** The sidebar's chats changed (a new chat, a title, a pin, an archive, a harness's list landing late): every phone hears it once for a burst, and reads the list again. */
  onChatsChanged(invalidate = true) {
    if (invalidate) this.ops.invalidateRecent?.();
    this.listChanged.changed(this.now());
  }

  #chatsChanged() {
    for (const p of this.phones.values())
      if (this.permitted(p.client, 'chats.recent')) void this.#send(p.client.pairId, this.#event({ ev: 'chats.changed' }));
  }

  /**
   * MoMo changed something a phone shows (its memory and open loops, routines, brain, sources, settings, or a new note such
   * as a nudge in its main chat): every paired phone is told which part, never what. Nothing is sent while MoMo isn't allowed.
   */
  onMomoChanged(/** @type {'memory' | 'routines' | 'brain' | 'sources' | 'prefs' | 'chat' | 'channels'} */ area) {
    if (this.momoAllowed() !== true) return;
    for (const p of this.phones.values()) void this.#send(p.client.pairId, this.#event({ ev: 'momo.changed', area }));
  }

  /** MoMo's home changed (a Host's answer, a move step, an intent from any client): every paired phone allowed to read the view is told with the fresh view. Nothing is sent while the home is not offered. @param {object} payload */
  onMomoHomeChanged(payload) {
    if (!this.homeOffered()) return;
    for (const p of this.phones.values())
      if (this.permitted(p.client, 'momo.home.view'))
        void this.#send(p.client.pairId, this.#event({ ...payload, ev: 'momo.home.changed' }));
  }

  /**
   * A machines.list answer (methods/host.cjs), read and recorded on the same chain as machines.changed, so its reply never lands after a
   * newer event and the recorded signature is the one the phone was told (#3765).
   * @param {{ pairId: string }} client
   */
  listMachines(client) {
    const answer = this.machinesChain.then(async () => {
      const machines = await machinesOf(this);
      const direct = directOf(this, client, machines);
      this.machinesSent.set(client.pairId, machinesSignature(machines) + directSignature(direct));
      return Object.keys(direct).length ? { machines, direct } : { machines };
    });
    this.machinesChain = answer.then(
      () => undefined,
      (error) => noteIgnored('read the machines a phone asked for', error),
    );
    return answer;
  }

  /**
   * The user's machines or Host's gate changed (app/hostPhone.cjs): every phone allowed them is told the list, unless nothing it shows changed.
   * One change at a time, so a later list never goes out before an earlier one.
   */
  onMachinesChanged() {
    const next = this.machinesChain.then(async () => {
      const allowed = this.hostAllowed();
      const machines = await machinesOf(this);
      const signature = machinesSignature(machines);
      // with the gate open, every phone allowed the list; once it closed, every phone still holding machines (from an event or a
      // machines.list answer) is told this Mac alone
      const phones = [...this.phones.values()].filter(
        (p) => this.permitted(p.client, 'machines.list') && (allowed || this.machinesSent.has(p.client.pairId)),
      );
      for (const { client } of phones) {
        const direct = allowed ? directOf(this, client, machines) : {};
        const mine = signature + directSignature(direct);
        if (this.machinesSent.get(client.pairId) === mine) continue;
        // #send answers the transport's error, null once it took the event: a phone that did not get it is told again at the next change
        const failed = await this.#send(
          client.pairId,
          this.#event({ ev: 'machines.changed', machines, ...(Object.keys(direct).length ? { direct } : {}) }),
        );
        if (failed) continue;
        if (allowed) this.machinesSent.set(client.pairId, mine);
        else this.machinesSent.delete(client.pairId);
      }
    });
    this.machinesChain = next.catch((error) => noteIgnored('tell paired phones the machines changed', error));
    return this.machinesChain;
  }

  /**
   * One item of MoMo's activity (momo.activity.list) changed, appeared or went: every paired phone is told its id, which it
   * re-fetches. Nothing is sent while MoMo isn't allowed.
   */
  onMomoActivity(/** @type {string} */ id) {
    if (this.momoAllowed() !== true) return;
    for (const p of this.phones.values())
      void this.#send(p.client.pairId, this.#event({ ev: 'momo.changed', area: 'activity', itemId: id }));
  }

  /** Whether a transport is attached: raw harness events are translated only while phones can be served. */
  get attached() {
    return this.transport !== null;
  }

  /** An item event the translator made for a chat (items.append, items.replace, items.delta, turn.state): followers get it in order. */
  onFeedEvent(/** @type {{ ev: string, chatId: string }} */ event) {
    const { chatId } = event;
    if (!this.followers(chatId).length) return;
    void this.enqueue(chatId, async () => {
      const rev = this.ops.state.get(chatId)?.rev;
      // a phone that is away follows nothing live: a returning phone re-reads the chat, so a stream queued at the relay for it is only a backlog
      for (const p of this.followers(chatId).filter((f) => !this.phoneAbsent(f.client.pairId)))
        await this.#send(p.client.pairId, this.#event(this.budget.fit(p.client.pairId, chatId, { ...event, rev })));
    });
  }

  /** Records a failure a mirror ignores (the app-wide reporter). */
  note(/** @type {string} */ context, /** @type {unknown} */ error) {
    noteIgnored(context, error);
  }

  /** An event for one device now (a terminal's output, a frame). */
  emit(/** @type {string} */ pairId, /** @type {object} */ event) {
    return this.#send(pairId, this.#event(event));
  }

  #event(/** @type {object} */ event) {
    // The envelope's own fields come last: an event's payload (a MoMo item id, a chat id) must never replace the message id, which checkMessage caps at 64.
    return { ...(fitEvent(event, EVENT_BYTES) ?? event), id: `m_${randomUUID()}`, t: this.now(), kind: 'event' };
  }
}

module.exports = { RemoteService, PANEL };
