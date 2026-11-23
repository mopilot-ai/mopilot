// Computer access (#1364), this Mac's side: it listens only while the person has access on (and the remote switch has
// not turned it off), on 127.0.0.1 unless they allowed other computers on the network; pairs a device only when a
// person allows it here; and runs a paired device's calls through the capability registry as a remote owner, so they
// meet the same cards, no-go lists, desktop lock and Esc as a chat's. Cards go to the device's chat and stay answerable
// here; a stop, a revoke and access turned off end what the device's chats hold at once.
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const { RemoteOwners } = require('./owners.cjs');
const { HostConnection } = require('./hostConnection.cjs');
const { PairingOffers } = require('./offer.cjs');
const { CallWindow } = require('./callWindow.cjs');
const { allowed, offered } = require('./allowlist.cjs');
const { fingerprint } = require('./handshake.cjs');
const { FRAME_MAX } = require('./frames.cjs');
const { AccessListener } = require('./listener.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** A client chat id or turn id: what a client may send. */
const ID_MAX = 200;
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= ID_MAX;

/**
 * @typedef {{ conn: InstanceType<typeof HostConnection>, key: string, name: string, code: string, at: number,
 *   timer: ReturnType<typeof setTimeout> }} PairingRequest
 */

class ComputerAccessHost extends EventEmitter {
  /**
   * @param {{
   *   store: InstanceType<typeof import('./store.cjs').AccessStore>,
   *   owners: InstanceType<typeof RemoteOwners>,
   *   registry: () => { invoke: Function, list: () => any[] },
   *   answer: (approvalId: string, result: unknown) => boolean,
   *   sessions: () => { get(id: string): any, patch(id: string, p: object): boolean, has(id: string): boolean },
   *   hostAnchor: () => unknown,
   *   flagOn: () => boolean,
   *   log: InstanceType<typeof import('./accessLog.cjs').AccessLog>,
   *   ledger?: () => { record(r: object): void } | null,
   *   hostName: () => string,
   *   lanAddress?: () => string | null,
   *   http?: Pick<typeof import('node:http'), 'createServer'>,
   *   accept: (req: any, socket: any, head: Buffer, o: { maxBytes: number }) => any,
   *   port?: number, now?: () => number, handshakeMs?: number }} o
   * Events: 'change' when anything Settings shows changed.
   */
  constructor(o) {
    super();
    this.o = o;
    this.store = o.store;
    this.owners = o.owners;
    this.now = o.now ?? Date.now;
    this.offers = new PairingOffers({ now: this.now });
    this.listener = new AccessListener({
      options: () => this.o,
      wanted: () => this.wanted(),
      handshaking: () => [...this.conns].filter((c) => c.phase === 'hello' || c.phase === 'confirm').length,
      onSocket: (ws) => this.#connected(ws),
      now: this.now,
    });
    /** @type {Promise<void> | null} the start in progress */
    this.starting = null;
    /** @type {Set<InstanceType<typeof HostConnection>>} */
    this.conns = new Set();
    /** @type {PairingRequest | null} a device that proved the offer and waits for the person */
    this.request = null;
    /** device id -> its call window */
    this.windows = new Map();
    /** owner id -> the card ids its device was sent */
    this.sent = new Map();
    /** @type {Map<InstanceType<typeof HostConnection>, Set<string>>} connection -> the owners its calls entered */
    this.ownersOf = new Map();
    // an owner that goes away (stopped, revoked, disconnected, access off) ends its turn here as a chat's does: the turn
    // ledger lets go of its tabs, the desktop and its leases, retires its tokens and aborts its calls; its cards go
    this.owners.onClose((owner) => {
      this.#endTurn(owner.id);
      this.sent.delete(owner.id);
    });
    // Esc, the tray and a pausing refusal reach the owner's device, which stops its chat's turn
    this.owners.setStopper((owner) => {
      this.o.log.add({ event: 'stop', device: owner.deviceId, deviceName: owner.deviceName, chat: owner.clientChat });
      this.#connOf(owner)?.send({ t: 'stop', chat: owner.clientChat });
    });
  }

  /** @returns {{ address: string, port: number } | null} where this Mac listens, or null */
  get listening() {
    return this.listener.listening;
  }

  get server() {
    return this.listener.server;
  }

  get attempts() {
    return this.listener.attempts;
  }

  /** Whether this Mac should be listening now. */
  wanted() {
    return this.store.available && !this.store.problem() && this.store.enabled() && this.o.flagOn();
  }

  /** What Settings shows. */
  state() {
    return {
      available: this.store.available,
      problem: this.store.problem(),
      enabled: this.store.enabled(),
      blocked: !this.o.flagOn(),
      lan: this.store.lan(),
      listening: this.listening,
      pairing: ((o) => (o ? { expiresAt: o.expiresAt } : null))(this.offers.current()),
      request: this.request ? { name: this.request.name, code: this.request.code } : null,
      devices: this.store.devices().map(({ key, ...d }) => ({ ...d, fingerprint: fingerprint(key), online: this.#online(d.id) })),
      active: this.owners
        .list()
        .map((x) => ({ id: x.id, device: x.deviceId, deviceName: x.deviceName, chat: x.clientChat, harness: x.harness })),
    };
  }

  #changed() {
    this.emit('change');
  }

  #online(deviceId) {
    return [...this.conns].some((c) => c.open && c.deviceId === deviceId);
  }

  /** Listens or stops as the switches say (the person's on/off, the remote switch, the network choice). */
  async sync() {
    // a start under way finishes first: the switches are read again after it (the network choice may have changed)
    if (this.starting) {
      // its own caller is told how it failed; here it only has to be over
      await this.starting.catch((error) => noteIgnored('wait for a computer access start that failed', error));
      return this.sync();
    }
    if (!this.wanted()) return this.stop('off');
    const host = this.store.lan() ? '0.0.0.0' : '127.0.0.1';
    if (this.listening && this.listener.boundTo === host) return;
    if (this.listening) await this.stop('restart');
    this.starting = this.#start(host).finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async #start(host) {
    if (await this.listener.open(host)) this.#changed();
  }

  /**
   * Stops listening: every connection ends, every remote owner goes away (its turn ends here), the offer and a
   * waiting pairing are dropped.
   * @param {string} why
   */
  async stop(why) {
    this.offers.cancel();
    this.#dropRequest();
    for (const c of [...this.conns]) c.close('off', 'Computer access is off on this Mac');
    this.conns.clear();
    const ended = this.owners.closeAll(why);
    if ((await this.listener.close()) || ended) this.o.log.add({ event: 'off', code: why });
    this.#changed();
  }

  /**
   * The person's switch, the kill switch: off ends everything at once.
   * @param {boolean} on
   */
  async setEnabled(on) {
    this.store.setEnabled(on);
    await this.sync();
  }

  /** @param {boolean} on */
  async setLan(on) {
    this.store.setLan(on);
    await this.sync();
  }

  /** A socket the listener accepted: its handshake starts. */
  #connected(ws) {
    const conn = new HostConnection({
      ws,
      identity: () => this.store.identity(),
      known: (key) => !!this.store.deviceByKey(key),
      pairSecret: () => this.offers.take(),
      handshakeMs: this.o.handshakeMs,
      openMaxBytes: Math.ceil((FRAME_MAX * 4) / 3) + 64,
    });
    this.conns.add(conn);
    this.ownersOf.set(conn, new Set());
    conn.on('pair', (p) => this.#pairing(conn, p));
    conn.on('open', (key) => this.#opened(conn, key));
    conn.on('request', (m) =>
      this.#request(conn, m).catch((error) => {
        noteIgnored('answer a computer access request', error);
        conn.close('protocol', 'request failed');
      }),
    );
    conn.on('close', (code) => this.#closed(conn, code));
  }

  #pairing(conn, { key, name, code }) {
    // the offer was used up on the way in, so no second device can be waiting; the person has as long as an offer
    // lasts to answer, then the device is let go
    const timer = setTimeout(() => {
      if (this.request?.conn === conn) this.cancelPairing();
    }, this.offers.ttlMs);
    timer.unref?.();
    this.request = { conn, key, name, code, at: this.now(), timer };
    this.o.log.add({ event: 'pairing', deviceName: name });
    this.#changed();
  }

  /**
   * The person's answer to a waiting pairing: Allow pairs the device with the scopes they picked; Deny ends it.
   * @param {boolean} allow @param {Record<string, boolean>} [scopes]
   */
  answerPairing(allow, scopes) {
    const r = this.request;
    if (!r) return null;
    this.request = null;
    clearTimeout(r.timer);
    // the device gave up while the person decided, or access went off: nothing to pair
    if (!allow || r.conn.phase !== 'pairing' || !this.wanted()) {
      r.conn.send({ t: 'denied' });
      r.conn.close('unauthorized', 'The person on this Mac did not allow pairing');
      this.o.log.add({ event: 'denied', deviceName: r.name });
      this.#changed();
      return null;
    }
    const device = this.store.addDevice({ name: r.name, key: r.key, scopes });
    r.conn.admit(device.id);
    r.conn.send({ t: 'paired', host: this.o.hostName(), device: device.id });
    this.o.log.add({ event: 'paired', device: device.id, deviceName: device.name });
    this.store.touchDevice(device.id);
    this.o.log.add({ event: 'connected', device: device.id, deviceName: device.name });
    this.#changed();
    return device;
  }

  #dropRequest() {
    if (!this.request) return;
    clearTimeout(this.request.timer);
    this.request.conn.close('no_pairing', 'Pairing was cancelled on this Mac');
    this.request = null;
  }

  /** Shows a new pairing offer (any earlier one stops working); null while not listening. */
  startPairing() {
    if (!this.listening) return null;
    this.#dropRequest();
    const offer = this.offers.start({
      address: this.listening.address,
      port: this.listening.port,
      fingerprint: fingerprint(this.store.identity().x),
    });
    this.#changed();
    return offer;
  }

  /** The person closed the pairing dialog: the offer stops working and a waiting device is let go. */
  cancelPairing() {
    this.offers.cancel();
    this.#dropRequest();
    this.#changed();
  }

  #opened(conn, key) {
    const device = this.store.deviceByKey(key);
    // revoked between the handshake and now: hostConnection checked the key, the store is the authority
    if (!device) return conn.close('unknown_device', 'This device is not paired with this Mac');
    conn.deviceId = device.id;
    this.store.touchDevice(device.id);
    this.o.log.add({ event: 'connected', device: device.id, deviceName: device.name });
    this.#changed();
  }

  #closed(conn, code) {
    this.conns.delete(conn);
    const ids = this.#ownersOf(conn);
    this.ownersOf.delete(conn);
    const waiting = this.request;
    if (waiting && waiting.conn === conn) {
      clearTimeout(waiting.timer);
      this.request = null;
    }
    // an owner another open connection of the device still serves stays (a reconnect while the old socket lingers)
    for (const id of ids) if (![...this.ownersOf.values()].some((held) => held.has(id))) this.owners.close(id, 'disconnected');
    if (conn.deviceId) this.o.log.add({ event: 'disconnected', device: conn.deviceId, code: String(code) });
    this.#changed();
  }

  /** The owners a connection's calls entered (set as it is accepted, until it closes). */
  #ownersOf(conn) {
    return /** @type {Set<string>} */ (this.ownersOf.get(conn));
  }

  /** The paired device a request comes from, checked again now: revoked, expired or access off refuses it. */
  #deviceOf(conn) {
    // a request comes only from an open connection, whose key the handshake proved
    const device = this.store.deviceByKey(/** @type {string} */ (conn.key));
    if (!device || device.id !== conn.deviceId || !this.wanted()) return null;
    return device;
  }

  #connOf(owner) {
    return [...this.conns].find((c) => c.open && c.deviceId === owner.deviceId && this.#ownersOf(c).has(owner.id)) ?? null;
  }

  /** @param {InstanceType<typeof HostConnection>} conn @param {any} m */
  async #request(conn, m) {
    const device = this.#deviceOf(conn);
    if (!device) {
      this.o.log.add({ event: 'refused', device: conn.deviceId, code: 'revoked' });
      conn.send({ t: 'error', code: 'revoked', message: 'This device is no longer allowed to use this Mac' });
      return conn.close('revoked', 'revoked');
    }
    if (m.t === 'tools') return conn.send({ t: 'tools', tools: offered(this.o.registry().list(), device.scopes) });
    if (m.t === 'turnEnded') {
      if (!isId(m.chat)) return conn.close('protocol', 'bad chat');
      const id = RemoteOwners.idOf(device.id, m.chat);
      if (this.#ownersOf(conn).has(id)) this.#endTurn(id);
      return;
    }
    if (m.t === 'answer') return this.#answer(conn, device, m);
    return this.#call(conn, device, m);
  }

  /** The owner's turn ended on its device: here it ends as a chat's does (tabs, desktop lock, leases, tokens, cards). */
  #endTurn(id) {
    const sessions = this.o.sessions();
    if (sessions.has(id)) sessions.patch(id, { turn: 'idle', activeTurn: null, approvals: [] });
  }

  #answer(conn, device, m) {
    const reply = (ok, code) => conn.send({ t: 'answered', id: m.id, ok, ...(code ? { code } : {}) });
    if (typeof m.id !== 'string') return reply(false, 'malformed');
    if (device.hostOnlyApprovals) return reply(false, 'host_only');
    // only a card of this device's own owners
    const sessions = this.o.sessions();
    const mine = [...this.#ownersOf(conn)].some((id) => sessions.get(id).approvals.some((a) => a.id === m.id));
    if (!mine) return reply(false, 'unknown');
    return reply(this.o.answer(m.id, m.result ?? null));
  }

  async #call(conn, device, m) {
    const started = this.now();
    const refuse = (code, message) => {
      this.o.log.add({ event: 'refused', device: device.id, deviceName: device.name, chat: m.chat, tool: m.tool, code });
      conn.send({ t: 'result', callId: m.callId, ok: false, content: [], error: { code, message } });
    };
    let window = this.windows.get(device.id);
    if (!window) this.windows.set(device.id, (window = new CallWindow({ now: this.now })));
    const fresh = window.accept(m.callId, m.issuedAt);
    if (fresh !== 'ok') return refuse(fresh, `This call was refused as ${fresh}`);
    if (!isId(m.chat) || !isId(m.turn)) return refuse('malformed', 'A call must name its chat and turn');
    if (!allowed(m.tool, device.scopes))
      return refuse('not_allowed', `${String(m.tool).slice(0, 64)} is not something this device may use on this Mac`);
    const owner = this.owners.enter({
      deviceId: device.id,
      deviceName: device.name,
      clientChat: m.chat,
      harness: m.harness,
      model: m.model,
      anchor: m.anchor,
      human: m.human,
      hostAnchor: this.o.hostAnchor(),
      hostOnlyApprovals: device.hostOnlyApprovals === true,
    });
    this.#ownersOf(conn).add(owner.id);
    const sessions = this.o.sessions();
    const s = sessions.get(owner.id);
    if (s.activeTurn?.id !== m.turn) {
      // a new turn on the device: the last one ends here first, then this one runs as a turn of its own
      if (s.activeTurn) this.#endTurn(owner.id);
      sessions.patch(owner.id, {
        turn: 'running',
        activeTurn: { id: m.turn, human: m.human === true },
        // a scheduled run on the device: unattended here too (a card waits for a person; it never stops a chat here)
        scheduled: m.unattended === true ? { unattended: true, computer: true, onApproval: 'wait' } : null,
      });
    }
    const res = await this.o.registry().invoke(owner.id, owner.id, m.tool, m.args ?? {}, {
      callId: crypto.createHash('sha256').update(`${device.id}\n${m.callId}`).digest('hex').slice(0, 32),
    });
    const ms = this.now() - started;
    this.o.log.add({
      event: 'call',
      device: device.id,
      deviceName: device.name,
      chat: m.chat,
      harness: owner.harness,
      tool: m.tool,
      argKeys: m.args && typeof m.args === 'object' ? Object.keys(m.args) : [],
      outcome: res.ok ? 'ok' : 'error',
      code: res.error?.code,
      ms,
    });
    try {
      this.o.ledger?.()?.record({
        kind: 'computerAccess',
        harness: owner.harness,
        chat: m.chat,
        device: device.id,
        tool: m.tool,
        outcome: res.ok ? 'ok' : 'error',
        code: res.error?.code,
      });
    } catch (error) {
      noteIgnored('write a computer access call to the request ledger', error);
    }
    conn.send({ t: 'result', callId: m.callId, ok: res.ok, content: res.content, ...(res.error ? { error: res.error } : {}) });
  }

  /**
   * A SessionState change: a remote owner's cards go to its device's chat as they come and go.
   * @param {{ chatId: string, patch: any }} p
   */
  onSessionPatch(p) {
    const owner = this.owners.get(p?.chatId);
    if (!owner || !p.patch || !Object.hasOwn(p.patch, 'approvals')) return;
    const now = Array.isArray(p.patch.approvals) ? p.patch.approvals : [];
    const before = this.sent.get(owner.id) ?? new Set();
    const conn = this.#connOf(owner);
    for (const a of now) {
      if (before.has(a.id)) continue;
      conn?.send({ t: 'approval', chat: owner.clientChat, approval: a, hostOnly: owner.hostOnlyApprovals });
    }
    const ids = new Set(now.map((a) => a.id));
    for (const id of before) if (!ids.has(id)) conn?.send({ t: 'withdraw', chat: owner.clientChat, id });
    this.sent.set(owner.id, ids);
    this.#changed();
  }

  /**
   * What the person changed about a device: its scopes, or whether only this Mac can approve its actions. Its chats'
   * next calls run under the new settings.
   * @param {string} id @param {{ scopes?: Record<string, boolean>, hostOnlyApprovals?: boolean }} patch
   */
  setDevice(id, patch) {
    this.store.setDevice(id, patch);
    this.#changed();
  }

  /** Starts over after the store couldn't be read: everything ends, a new identity, no devices, access off. */
  async reset() {
    await this.stop('reset');
    this.store.reset();
    this.#changed();
  }

  /**
   * Removes a device: its key stops working, its connections end and its chats' owners go away at once.
   * @param {string} deviceId
   */
  revoke(deviceId) {
    const had = this.store.revokeDevice(deviceId);
    this.owners.closeDevice(deviceId, 'revoked');
    for (const c of [...this.conns]) if (c.deviceId === deviceId) c.close('revoked', 'This device was removed on this Mac');
    this.windows.delete(deviceId);
    if (had) this.o.log.add({ event: 'revoked', device: deviceId });
    this.#changed();
    return had;
  }
}

module.exports = { ComputerAccessHost };
