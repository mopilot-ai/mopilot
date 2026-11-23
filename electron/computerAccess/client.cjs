// Computer access (#1364), the client's side: the computers this install paired with, a connection to each (opened when
// a chat first uses it, its key pinned), and the tools a chat on any harness uses them with: remote_computers,
// remote_computer_tools and remote_computer_call, through the capability registry every harness's channel serves. A
// card the computer raises shows in the chat as the same card, and a person's answer goes back; the computer's stop
// stops the chat here; the chat's turn ending here ends its turn there.
const { EventEmitter } = require('node:events');
const { ClientConnection } = require('./clientConnection.cjs');
const { parseOffer } = require('./offer.cjs');
const { SOCKET_PATH } = require('./listener.cjs');
const { ToolError } = require('../capabilities/contract/registry.cjs');
const { KINDS: CARD_KINDS, METHOD_PREFIX } = require('../capabilities/contract/approvals.cjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * The tools a chat gets while this install has a paired computer. Their names stay clear of the other tool families'
 * prefixes (computer_, desktop_, browser_, chrome_, sage_browser_): visibility.cjs hides and hostServers.cjs moves
 * tools by prefix, and a computer_access_* name was hidden as a legacy computer_* tool.
 */
const TOOL_NAMES = ['remote_computers', 'remote_computer_tools', 'remote_computer_call'];

const HOST_ARG = {
  type: 'string',
  description: 'The paired computer, by name or id (remote_computers). Optional when only one is paired.',
};
const SPECS = [
  {
    name: 'remote_computers',
    policy: 'observe',
    description:
      "The computers this MoPilot is paired with for computer access: their names, ids and whether they are reachable. Use one with remote_computer_tools and remote_computer_call to work in that computer's browser or apps.",
    schema: { type: 'object', properties: {} },
  },
  {
    name: 'remote_computer_tools',
    policy: 'observe',
    description:
      'The tools you may use on a paired computer (its built-in browser, its Chrome or its apps, as its owner allowed), with their input schemas.',
    schema: { type: 'object', properties: { host: HOST_ARG } },
  },
  {
    name: 'remote_computer_call',
    policy: 'act',
    description:
      "Runs one of a paired computer's tools (from remote_computer_tools) on that computer. The person there, or here, approves what needs approving, exactly as for their own chats; a refusal means stop, not retry another way.",
    schema: {
      type: 'object',
      properties: {
        host: HOST_ARG,
        tool: { type: 'string', description: 'The tool name, as remote_computer_tools lists it.' },
        args: { type: 'object', description: "The tool's arguments." },
      },
      required: ['tool'],
    },
  },
];

/**
 * @typedef {{ turn: string, human: boolean, unattended: boolean, harness: string, model: string | null, anchor: string }} ChatFacts
 */

class ComputerAccessClient extends EventEmitter {
  /**
   * @param {{ store: InstanceType<typeof import('./store.cjs').AccessStore>,
   *   broker: () => { ask(chatId: string, kind: string, params: object): Promise<any> & { id?: string }, answer(id: string, r: any): boolean } | null,
   *   facts: (chatId: string) => ChatFacts, stopChat: (chatId: string) => unknown, deviceName: () => string,
   *   WebSocket?: any, now?: () => number }} o
   * Events: 'change' when the computers or their connections changed.
   */
  constructor(o) {
    super();
    this.o = o;
    this.store = o.store;
    /** @type {Map<string, InstanceType<typeof ClientConnection>>} host id -> its open connection */
    this.conns = new Map();
    /** @type {Map<string, Promise<InstanceType<typeof ClientConnection>>>} host id -> its connection being opened */
    this.connecting = new Map();
    /** @type {Map<string, Set<string>>} host id -> the chats here that used it */
    this.chats = new Map();
    /** @type {Map<string, string>} the computer's card id (per host) -> the card shown here */
    this.cards = new Map();
    /** @type {(() => void)[]} unregisters the tools */
    this.unregister = [];
    /** @type {{ register(tool: object): () => void } | null} the capability registry the tools are offered on */
    this.registry = null;
  }

  /** The paired computers, each with whether it is connected now (secrets left out). */
  hosts() {
    return this.store.hosts().map(({ key, ...h }) => ({ ...h, connected: this.conns.get(h.id)?.open === true }));
  }

  /**
   * Starts pairing with a computer from the offer it shows. Resolves with the code to compare with the one that computer
   * shows, and `done`, which settles when the person there allows (the computer is saved) or not.
   * @param {string} offerText
   */
  async pair(offerText) {
    const offer = parseOffer(offerText);
    if (!offer) throw new ToolError("That isn't a pairing code from MoPilot's Computer access", 'bad_offer');
    const conn = new ClientConnection({
      url: `ws://${offer.address}:${offer.port}${SOCKET_PATH}`,
      identity: this.store.identity(),
      pair: { name: this.o.deviceName(), secret: offer.secret, fingerprint: offer.fingerprint },
      WebSocket: this.o.WebSocket,
      now: this.o.now,
    });
    const { host: key, code } = await conn.connect();
    const done = conn.paired().then(({ host: name }) => {
      // the same computer paired again replaces its entry: its old connection goes with the old id
      const before = this.store
        .hosts()
        .filter((h) => h.key === key)
        .map((h) => h.id);
      const host = this.store.addHost({ name, key, address: offer.address, port: offer.port });
      for (const id of before) {
        this.conns.get(id)?.close(1000, 'paired again');
        this.chats.delete(id);
      }
      this.#adopt(host.id, conn);
      // the first paired computer brings the tools to every chat's next session
      this.sync();
      return host;
    });
    // the caller reads `done`; this keeps an unread rejection from going unhandled
    done.catch((error) => noteIgnored('pair with a computer', error));
    return { code, done };
  }

  /** Forgets a computer: its connection ends and it is no longer offered. */
  forget(hostId) {
    const had = this.store.removeHost(hostId);
    this.conns.get(hostId)?.close(1000, 'forgotten');
    this.sync();
    return had;
  }

  /** The connection to a paired computer, opened (and its key checked) on first use. */
  async #connection(hostId) {
    const open = this.conns.get(hostId);
    if (open?.open) return open;
    let pending = this.connecting.get(hostId);
    if (!pending) {
      // #pick found it just now, in the same tick
      const host = /** @type {any} */ (this.store.hosts().find((h) => h.id === hostId));
      const conn = new ClientConnection({
        url: `ws://${host.address}:${host.port}${SOCKET_PATH}`,
        identity: this.store.identity(),
        hostKey: host.key,
        WebSocket: this.o.WebSocket,
        now: this.o.now,
      });
      pending = conn.connect().then(() => (this.#adopt(hostId, conn), conn));
      this.connecting.set(hostId, pending);
      // the attempt is forgotten when it settles; how it failed is the caller's below to report
      const settled = () => this.connecting.delete(hostId);
      pending.then(settled, settled);
    }
    const name = this.#nameOf(hostId);
    try {
      return await pending;
    } catch (error) {
      throw new ToolError(`${name} can't be reached: ${/** @type {Error} */ (error).message}`, 'offline');
    }
  }

  /** A paired computer's name (`#pick` or a live connection vouches that it is paired). */
  #nameOf(hostId) {
    return /** @type {any} */ (this.store.hosts().find((h) => h.id === hostId)).name;
  }

  /** A connection that is open now: the computer's pushes reach the chats that used it. */
  #adopt(hostId, conn) {
    this.conns.set(hostId, conn);
    conn.on('approval', (m) => this.#card(hostId, conn, m));
    conn.on('withdraw', (m) => this.#withdraw(hostId, m.id));
    conn.on('stop', (m) => {
      // only a chat that used this computer can be stopped by it
      if (this.chats.get(hostId)?.has(m.chat))
        Promise.resolve(this.o.stopChat(m.chat)).catch((e) => noteIgnored('stop a chat the computer stopped', e));
    });
    conn.on('close', () => {
      if (this.conns.get(hostId) === conn) this.conns.delete(hostId);
      // its cards can't be answered any more
      for (const key of [...this.cards.keys()]) if (key.startsWith(`${hostId}\n`)) this.#withdraw(hostId, key.slice(hostId.length + 1));
      this.emit('change');
    });
    this.emit('change');
  }

  /** A card the computer raised for one of this install's chats: shown in that chat, its answer sent back. */
  #card(hostId, conn, m) {
    const a = m?.approval;
    const kind = typeof a?.method === 'string' && a.method.startsWith(METHOD_PREFIX) ? a.method.slice(METHOD_PREFIX.length) : null;
    const broker = this.o.broker();
    // only a chat that used this computer, only a card kind this app shows; a card only the computer may answer is not shown
    if (!broker || !kind || !CARD_KINDS.has(kind) || !this.chats.get(hostId)?.has(m.chat) || m.hostOnly === true) return;
    const card = broker.ask(m.chat, kind, { ...a.params, remote: { host: hostId, hostName: this.#nameOf(hostId) } });
    const key = `${hostId}\n${a.id}`;
    if (card.id) this.cards.set(key, card.id);
    card.then((result) => {
      if (this.cards.get(key) !== card.id) return;
      this.cards.delete(key);
      // null: the card went away unanswered here (the turn ended); the computer withdraws its own
      if (result != null) conn.answer(a.id, result);
    });
  }

  #withdraw(hostId, id) {
    const key = `${hostId}\n${id}`;
    const local = this.cards.get(key);
    if (!local) return;
    this.cards.delete(key);
    this.o.broker()?.answer(local, null);
  }

  /** A chat's turn ended here: each computer it used ends that turn there (tabs, desktop lock, cards). */
  turnEnded(chatId) {
    for (const [hostId, chats] of this.chats) {
      if (!chats.delete(chatId)) continue;
      this.conns.get(hostId)?.turnEnded(chatId);
    }
  }

  /**
   * A SessionState change: a chat's turn that ended here ends on the computers it used.
   * @param {{ chatId: string, patch: any }} p
   */
  onSessionPatch(p) {
    if (p?.patch?.turn === 'idle' || p?.patch?.turn === 'crashed') this.turnEnded(p.chatId);
  }

  /** The paired computer `host` names (its id or name), or the only one. */
  #pick(host) {
    const hosts = this.store.hosts();
    if (host == null || host === '') {
      if (hosts.length === 1) return hosts[0].id;
      throw new ToolError(
        hosts.length ? `Name the computer: ${hosts.map((h) => h.name).join(', ')}` : 'No computer is paired with this MoPilot',
        hosts.length ? 'bad_args' : 'unknown_host',
      );
    }
    const found = hosts.find((h) => h.id === host) ?? hosts.find((h) => h.name.toLowerCase() === String(host).toLowerCase());
    if (!found) throw new ToolError(`No paired computer is called ${String(host).slice(0, 80)}`, 'unknown_host');
    return found.id;
  }

  /** The tools' handlers. */
  handlers() {
    return {
      // each computer is reached now, so "online" is what a call would find (a connection opens on first use)
      remote_computers: async () => ({
        computers: await Promise.all(
          this.store.hosts().map(async ({ id, name }) => ({
            id,
            name,
            online: await this.#connection(id).then(
              () => true,
              () => false,
            ),
          })),
        ),
      }),
      remote_computer_tools: async (args) => {
        const conn = await this.#connection(this.#pick(args.host));
        return { tools: await conn.tools() };
      },
      remote_computer_call: async (args, ctx) => {
        const hostId = this.#pick(args.host);
        const conn = await this.#connection(hostId);
        let chats = this.chats.get(hostId);
        if (!chats) this.chats.set(hostId, (chats = new Set()));
        chats.add(ctx.chatId);
        const facts = this.o.facts(ctx.chatId);
        // Stop here: the computer ends the chat's turn there, and its calls with it
        const stop = () => conn.turnEnded(ctx.chatId);
        ctx.signal?.addEventListener('abort', stop, { once: true });
        try {
          const res = await conn.call({ chat: ctx.chatId, ...facts, tool: args.tool, args: args.args ?? {} });
          if (!res.ok) throw new ToolError(res.error.message, res.error.code);
          return { content: res.content };
        } finally {
          ctx.signal?.removeEventListener('abort', stop);
        }
      },
    };
  }

  /**
   * Offers the tools while a computer is paired, and only then (registry: the capability registry).
   * @param {{ register(tool: object): () => void } | null} [registry] (the last one given when none)
   */
  sync(registry) {
    if (registry !== undefined) this.registry = registry;
    const want = !!this.registry && this.store.hosts().length > 0;
    if (want && !this.unregister.length) {
      const h = this.handlers();
      this.unregister = SPECS.map((s) =>
        /** @type {any} */ (this.registry).register({ ...s, handler: h[/** @type {keyof typeof h} */ (s.name)], authorizesItself: true }),
      );
    } else if (!want && this.unregister.length) {
      for (const off of this.unregister.splice(0)) off();
    }
    this.emit('change');
  }

  /** Ends every connection (quit, or the store was reset). */
  close() {
    for (const conn of this.conns.values()) conn.close(1000, 'closing');
    this.conns.clear();
  }
}

module.exports = { ComputerAccessClient, TOOL_NAMES, SPECS };
