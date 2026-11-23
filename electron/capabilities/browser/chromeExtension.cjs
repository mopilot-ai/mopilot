// MoPilot's own Chrome extension as the executor of the user's Chrome (design D5, B2 step 2), behind shared.browser.chromeExtension: main's end of its protocol.
//
// It is the Chrome relay (chromeRelay.cjs) with another way to open a chat's connection, so everything above
// it is unchanged: the browser host over Chrome (chromeHost.cjs), the chrome_* tools for Claude Code and ACP,
// the Codex extension backend, turn tokens and Stop, and site rules and sensitive-action checks.
// - One connection from the extension (electron/chrome-extension), on a loopback WebSocket at
//   ws://127.0.0.1:<port>/mopilot-chrome, carries every chat: each message names its chat, and each chat gets a
//   ChatPort that looks like the relay's per-chat WebSocket, so the relay's ChromeLink runs on it as it is.
// - Only the extension's origins can open it (the dev key's and the Web Store's, chromeExtensionIds.cjs), and nothing is trusted before the mutual handshake: MoPilot
//   and the extension each prove the pairing secret (chromePairing.cjs; the extension's src/protocol.mjs). A
//   newer connection that proves it replaces the older one.
// - A chat's connection opens with session.open (the extension starts the chat's session; its tab group starts
//   with its first tab) and closes with session.close (the chat was deleted: its tabs leave the group).
// - Every command carries its turn as well as its chat (frameFields), and session.advance tells the extension
//   when the chat's turn ended, so a command already on its way when the turn ended is refused there too.
// - When the extension isn't connected, the first call waits connectMs for it. When it isn't paired yet (or,
//   after GRACE_MS, when a paired one still hasn't connected: Chrome may be closed, or the extension may have
//   lost its code), its options page opens in the user's Chrome with a one-time claim code (the user presses
//   Pair there). The page's URL is passed to Chrome on its command line, where other local processes can read
//   it, so it never carries the secret: the extension trades the claim code for the pairing code over the
//   socket, once, in time (chromePairOffers.cjs). The error at the end of the wait says how to install or reconnect it.
// - Messages from a connection that was replaced are dropped: only the current connection's reach the chats.
const http = require('node:http');
const { listenLoopback } = require('../../platform/listenLoopback.cjs');
const { noteIgnored, messageOf } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { acceptWebSocket } = require('./wsServer.cjs');
const { unguarded } = require('../contract/actionGuard.cjs');
const { ChromeRelay, ChromeLink } = require('./chromeRelay.cjs');
const { PREFERRED_PORT } = require('./chromePairing.cjs');
const {
  ExtensionPeer,
  ChatPort,
  proofOf,
  pairingCode,
  claimUrl,
  hostPairUrl,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  OPTIONS_PAGE,
  PROTOCOL_VERSION,
} = require('./chromeExtensionTransport.cjs');
const { allowedOrigin, STORE_EXTENSION_ID } = require('./chromeExtensionIds.cjs');
const { adminBlock } = require('../../chrome-extension/src/adminBlocks.mjs');
const { PairOffers } = require('./chromePairOffers.cjs');
/** @typedef {InstanceType<typeof ExtensionPeer>} ExtensionPeer */

const SOCKET_PATH = '/mopilot-chrome';
const CONNECT_MS = 45_000;
const AUTH_MS = 10_000;
const OPEN_MS = 10_000;
const GRACE_MS = 5_000;

class ChromeExtensionChannel extends ChromeRelay {
  /**
   * @param {{ pairing: { get: () => { secret: string, port: number, paired: boolean, name?: string } | null, rename?: (name: unknown) => string,
   *                      forPort: (port: number) => { secret: string, port: number, paired: boolean }, markPaired: () => void },
   *           openPage: (url: string, chatId: string | null) => unknown,
   *           clientName?: (chatId: string) => string, installHint?: string, installed?: () => 'on' | 'off' | 'missing' | null,
   *           pageId?: () => string, storeId?: string | null, hostRoute?: () => boolean,
   *           connectMs?: number, commandMs?: number, authMs?: number, openMs?: number, graceMs?: number, port?: number, panel?: (m: any, reply: (message: object) => void) => unknown,
   *           createServer?: () => import('node:http').Server }} o
   *   pairing: the saved pairing (ChromePairing); openPage: opens a URL in the user's Chrome (the pairing page);
   *   installHint: how to install the extension, for the not_connected error; installed: whether it is in the Chrome
   *   profile the pairing page would open in (chromeProfileExtension.cjs); pageId: the id whose pairing page opens (the
   *   one installed there, chromeExtensionIds.cjs extensionInProfileOf; the dev key's when not given); storeId: the
   *   Web Store's id, accepted beside the dev key's (STORE_EXTENSION_ID when not given); hostRoute: the native host is
   *   installed (chromeNativeHost.cjs), so the page opens without the claim code and the host hands it over; port: the
   *   port to try first
   */
  constructor(o) {
    super({
      openPage: o.openPage,
      clientName: o.clientName,
      connectMs: o.connectMs ?? CONNECT_MS,
      commandMs: o.commandMs,
      createServer: o.createServer,
    });
    this.x = o;
    this.storeId = o.storeId === undefined ? STORE_EXTENSION_ID : o.storeId;
    this.authMs = o.authMs ?? AUTH_MS;
    this.openMs = o.openMs ?? OPEN_MS;
    /** @type {ExtensionPeer | null} the extension's connection, once it proved the secret */
    this.peer = null;
    /** @type {{ pattern: string, re: RegExp }[]} the Chrome administrator's blocked sites, from the last connection */
    this.adminPatterns = [];
    this.statuses = new Map(); // chat id -> its turn's last status, for the session that opens after it (session.open)
    /** chat id -> its port on the peer */
    this.ports = new Map();
    /** @type {Promise<number> | null} */
    this.serving = null;
    /** @type {import('node:http').Server | null} */
    this.extServer = null;
    /** @type {AbortController | null} */
    this.serveAbort = null;
    /** @type {object | null} the wait that opened the pairing page, while it waits: a burst of waits opens it once */
    this.offeredBy = null;
    /** @type {'missing' | 'off' | null} why the pairing page can't open, as the profile read at the last offer */
    this.absent = null;
    /** chats deleted while the extension was away: their sessions close once it is back */
    this.closing = new Set();
    this.graceMs = o.graceMs ?? GRACE_MS;
    /** the one-time claim code offered, and "Allow Chrome to connect?" (chromePairOffers.cjs) */
    this.offers = new PairOffers();
    this.offers.on('change', (asking) => this.emit('ask', asking));
    // every chat waiting for the extension listens for it: more than ten chats may wait at once
    this.setMaxListeners(0);
  }

  /** MoPilot's own extension serves this connection (its manifest's name). */
  get extensionName() {
    return 'MoPilot';
  }

  /** Starts serving the extension (once): resolves with the port. Main calls it at startup, so a paired extension connects before the first call. */
  start() {
    if (this.serving) return this.serving;
    const serving = unguarded(() => this.#serve());
    this.serving = serving;
    serving.catch(() => {
      if (this.serving === serving) this.serving = null;
    });
    return serving;
  }

  async #serve() {
    const server = (this.x.createServer ?? (() => http.createServer()))();
    this.extServer = server;
    const abort = new AbortController();
    this.serveAbort = abort;
    server.on('request', (_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head));
    /** @type {number} */
    let port;
    try {
      const want = this.x.port ?? this.x.pairing.get()?.port ?? PREFERRED_PORT;
      try {
        port = await listenLoopback(server, want, abort.signal);
      } catch (error) {
        if (abort.signal.aborted) throw error;
        // the saved port is taken: another port, and the extension pairs again
        noteIgnored("listen on the Chrome extension's saved port", error);
        port = await listenLoopback(server, 0, abort.signal);
      }
      if (abort.signal.aborted) throw new Error('The browser server was stopped while opening.');
      this.x.pairing.forPort(port);
    } catch (error) {
      if (this.extServer === server) {
        server.close();
        this.extServer = null;
      }
      throw error;
    } finally {
      if (this.serveAbort === abort) this.serveAbort = null;
    }
    return port;
  }

  #upgrade(req, socket, head) {
    // only MoPilot's extension opens it, and only on its path
    if (String(req.url).split('?')[0] !== SOCKET_PATH || !allowedOrigin(req.headers.origin, { storeId: this.storeId })) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const pairing = this.x.pairing.get();
    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return;
    if (!pairing) {
      ws.close(4401, 'not paired');
      return;
    }
    const peer = new ExtensionPeer(ws, pairing.secret, this.authMs, (token) => this.#claimed(token));
    peer.once('ready', () => this.#adoptPeer(peer));
    // only the connection the chat's port is on: a replaced one's late answers would match the new link's ids
    peer.on('chat', (chatId, text) => {
      const port = this.ports.get(chatId);
      if (port?.peer === peer) port.emit('message', text);
    });
    peer.on('panel', (m) => this.x.panel?.(m, (reply) => peer.send(reply)));
    peer.once('close', () => this.#peerGone(peer));
  }

  #adoptPeer(peer) {
    const old = this.peer;
    this.peer = peer;
    if (old) {
      // the chats' sessions were on the older connection: they go with it, and reopen on the newer one
      this.#dropPorts();
      old.close(4409, 'replaced');
    }
    try {
      this.x.pairing.markPaired();
    } catch (error) {
      // it is paired for this run; the next start may offer the pairing page again
      noteIgnored('save that the Chrome extension paired', error);
    }
    for (const chatId of this.closing) peer.send({ chat: chatId, method: 'session.close', params: [] });
    this.closing.clear();
    // the administrator's blocked sites hold until the next connection says otherwise
    this.adminPatterns = peer.policy;
    this.offers.reset();
    this.emit('peer', peer);
  }

  #peerGone(peer) {
    if (this.peer !== peer) return;
    this.peer = null;
    this.#dropPorts();
    this.emit('peerGone');
  }

  /**
   * Every chat's port closes with the connection it was on (it dropped, or a newer one replaced it: the extension's
   * service worker restarted). The extension keeps the chats' sessions (chrome.storage.session) and reports their tabs
   * again when a chat's connection reopens, so the links close resumable: the host keeps the chats' tabs and lets go
   * of their debuggers, and the next action on one of them reconnects and attaches again (chromeTab.cjs resume).
   */
  #dropPorts() {
    for (const [chatId, port] of [...this.ports]) {
      const link = this.links.get(chatId);
      if (link?.ws === port) link.resumable = true;
      port.gone(1001, "MoPilot's Chrome extension disconnected");
    }
    this.ports.clear();
  }

  /** Whether the extension is paired, connected, and which version it is. */
  status() {
    let paired = false;
    try {
      paired = !!this.x.pairing.get()?.paired;
    } catch (error) {
      noteIgnored('read the Chrome extension pairing', error);
    }
    return { paired, connected: !!this.peer?.open, version: this.peer?.version ?? null, asking: this.offers.asking };
  }

  /** The not_connected error at the end of the wait: what the user does next. */
  #notConnected(paired) {
    const install = this.x.installHint ? ` ${this.x.installHint}` : '';
    if (this.absent === 'missing')
      return new ToolError(
        `Your Chrome isn't connected: MoPilot's Chrome extension isn't installed in the Chrome profile MoPilot uses, so there is nothing to pair yet. Install it there, then try again.${install}`,
        'not_connected',
      );
    if (this.absent === 'off')
      return new ToolError(
        "Your Chrome isn't connected: MoPilot's Chrome extension is turned off in the Chrome profile MoPilot uses. Turn it on in chrome://extensions, then try again.",
        'not_connected',
      );
    return new ToolError(
      paired
        ? `Your Chrome isn't connected: MoPilot's Chrome extension did not connect within ${Math.round(this.connectMs / 1000)} s. Make sure Chrome is open and the MoPilot extension is turned on in chrome://extensions, then try again.${install}`
        : `Your Chrome isn't connected: MoPilot's Chrome extension isn't paired. MoPilot opened the extension's page in Chrome, which connects by itself. The user only has to click Allow in MoPilot's "Allow Chrome to connect?" dialog, which comes to the front, not in Chrome; once they have, try again. If Chrome showed no such page, the extension isn't installed.${install}`,
      'not_connected',
    );
  }

  /** The pairing code for the one-time claim code the pairing page was opened with: once, and only in time. */
  #claimed(token) {
    if (!this.offers.take(token)) return null;
    const pairing = this.x.pairing.get();
    return pairing ? pairingCode(pairing) : null;
  }

  /**
   * Opens the extension's pairing page in the user's Chrome with a new claim code for `wait`, unless another wait that
   * opened it is still waiting. Never into a profile where the extension is missing or turned off (#1319 G29): Chrome
   * would show a page blocked by the client, with no way on; the error at the end of the wait says what to do instead.
   * The profile is read at every offer, so a wait sees an extension installed or turned on since the last one; and
   * only a wait that opened the page holds the next ones back, by order rather than by the clock (#1531). A page the
   * user opened from Settings (pair) and whose claim code is still good serves the wait instead of a second page.
   */
  #offer(wait) {
    this.absent = this.#absence();
    const pairing = this.x.pairing.get();
    if (!pairing || this.absent || this.offeredBy) return;
    this.offeredBy = wait;
    if (this.offers.userOffer()) return;
    this.#openClaim(pairing, false).catch((error) => noteIgnored("open MoPilot's Chrome extension pairing page", error));
  }

  /**
   * Opens the pairing page with a new one-time claim code, which replaces any earlier one. Where the native host is
   * installed the page's URL carries no code: the extension asks the host for it (hostClaim).
   */
  #openClaim(/** @type {{ port: number }} */ pairing, /** @type {boolean} */ user) {
    const token = this.offers.offer(user);
    const id = this.x.pageId?.();
    const url = this.x.hostRoute?.() ? hostPairUrl(id) : claimUrl(pairing.port, token, id);
    return Promise.resolve().then(() => this.x.openPage(url, null));
  }

  /**
   * The claim code a pairing offered (Settings' Pair, the Allow card or a chat's wait), while it is still good, for the
   * native host to hand the extension (#1632); null when none is open. A request the extension made by itself (`auto`)
   * gets only an offer the user made: otherwise, while the extension isn't connected, it raises "Allow MoPilot to
   * use this Chrome?" and gets PENDING, so it asks again. A claim is still traded over the socket, once (#claimed).
   * @param {{ auto?: boolean }} [o]
   * @returns {string | { pending: true } | null}
   */
  hostClaim({ auto = false } = {}) {
    const pairing = this.x.pairing.get();
    return pairing ? this.offers.forHost({ auto, port: pairing.port, connected: !!this.peer?.open }) : null;
  }

  /** "Allow Chrome to connect?" answered: Allow offers the claim the extension's next ask takes, no page. */
  answerAsk(/** @type {boolean} */ allow) {
    return this.offers.answer(allow) && allow && !!this.x.pairing.get();
  }

  /**
   * The user pressed Pair in Settings → Browser (#1632): opens the pairing page now, with a new claim code, unless the
   * extension is connected already or isn't on in the Chrome profile (the page would be blocked there). Rejects when
   * the channel can't serve or the page can't be opened.
   * @returns {Promise<'opened' | 'connected' | 'missing' | 'off' | 'unreadable'>} unreadable: the saved pairing can't be read
   */
  async pair() {
    await this.start();
    if (this.peer?.open) return 'connected';
    // pairing from Settings answers the question too, and lifts a Not now
    this.offers.reset();
    const absent = this.#absence();
    if (absent) return absent;
    const pairing = this.x.pairing.get();
    if (!pairing) return 'unreadable';
    await this.#openClaim(pairing, true);
    return 'opened';
  }

  /** Whether the extension is missing or turned off in the profile the pairing page would open in; null when on or unreadable. */
  #absence() {
    try {
      const state = this.x.installed?.() ?? null;
      return state === 'missing' || state === 'off' ? state : null;
    } catch (error) {
      // unreadable: the page is offered as before
      noteIgnored("read whether MoPilot's Chrome extension is in the Chrome profile", error);
      return null;
    }
  }

  /**
   * The extension's connection, waiting connectMs for it. The pairing page opens at once when it isn't paired, and
   * after graceMs when a paired one hasn't connected (opening it also starts Chrome and wakes the extension).
   */
  #awaitPeer() {
    if (this.peer?.open) return Promise.resolve(this.peer);
    const paired = !!this.x.pairing.get()?.paired;
    const wait = {};
    // a paired wait reads the profile at its grace offer: until then no earlier wait's reading speaks for it
    if (paired) this.absent = null;
    else this.#offer(wait);
    return new Promise((resolve, reject) => {
      const grace = paired ? setTimeout(() => this.#offer(wait), this.graceMs) : null;
      grace?.unref?.();
      const ended = () => {
        clearTimeout(/** @type {any} */ (grace));
        if (this.offeredBy === wait) this.offeredBy = null;
      };
      const timer = setTimeout(() => {
        ended();
        this.off('peer', on);
        reject(this.#notConnected(paired));
      }, this.connectMs);
      timer.unref?.();
      const on = (peer) => {
        ended();
        clearTimeout(timer);
        resolve(peer);
      };
      this.once('peer', on);
    });
  }

  /**
   * Opens the chat's connection over the extension's: session.open, then the extension's extension.initialized.
   * @returns {Promise<InstanceType<typeof ChromeLink>>}
   */
  async openLink(chatId) {
    const generation = this.generation(chatId);
    await this.start().catch((error) => {
      throw new ToolError(`Couldn't start serving MoPilot's Chrome extension: ${messageOf(error)}`, 'not_connected');
    });
    if (this.generation(chatId) !== generation) throw new ToolError('The Chrome connection was closed while it opened.', 'not_connected');
    const peer = await this.#awaitPeer();
    if (this.peer !== peer || !peer.open)
      throw new ToolError('The Chrome extension connection was replaced while opening.', 'not_connected');
    // connect() opens one connection per chat at a time, and a closed one leaves the map: this is the chat's only port
    const port = new ChatPort(peer, chatId);
    this.ports.set(chatId, port);
    port.once('close', () => {
      if (this.ports.get(chatId) === port) this.ports.delete(chatId);
    });
    const link = new ChromeLink(chatId, port, this.commandMs, { memberships: peer.memberships });
    /** @type {any} */
    let timer;
    const ready = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => reject(new ToolError("MoPilot's Chrome extension did not open this chat's session.", 'not_connected')),
        this.openMs,
      );
      timer.unref?.();
      link.once('ready', resolve);
      link.once('closed', () => reject(new ToolError("MoPilot's Chrome extension disconnected.", 'not_connected')));
    });
    // the chat's turn as main counts it: after a restart main counts again from 0, and the extension follows
    const opening = { title: this.o.clientName?.(chatId) || 'MoPilot', turn: this.turns.get(chatId) ?? 0 };
    peer.send({ chat: chatId, method: 'session.open', params: [{ ...opening, status: this.statuses.get(chatId) ?? null }] });
    try {
      await ready;
      // the chat was disconnected (deleted) or the channel stopped while it opened: nobody owns this session
      if (this.generation(chatId) !== generation || this.peer !== peer || !peer.open)
        throw new ToolError('The Chrome connection was closed while it opened.', 'not_connected');
    } catch (error) {
      link.close('not used');
      throw error;
    } finally {
      clearTimeout(timer);
    }
    this.adopt(chatId, link);
    return link;
  }

  /** Every command also carries its turn: the extension refuses one from an older turn. */
  frameFields(tok) {
    return { turn: tok.turn };
  }

  /** A new turn of the chat: the extension is told too, so commands still on their way from the old one are refused. */
  advance(chatId) {
    super.advance(chatId);
    if (this.ports.get(chatId)?.open) this.peer?.send({ chat: chatId, method: 'session.advance', params: [this.turns.get(chatId)] });
  }

  /** Why the Chrome administrator's policy blocks `url` for MoPilot's agents (chrome-extension/src/adminBlocks.mjs), or null. */
  policyBlock(/** @type {string} */ url) {
    return adminBlock(this.adminPatterns, url);
  }

  /**
   * The chat's title and whether its turn runs, waits for the user or is done ('running' | 'waiting' | 'done'): its
   * tab group shows them (session.status). Only for a chat whose session is open, so other chats send nothing.
   * @param {string} chatId @param {{ title: string | null, status: string | null }} o
   */
  turnStatus(chatId, o) {
    this.statuses.set(chatId, o.status);
    if (this.ports.get(chatId)?.open) this.peer?.send({ chat: chatId, method: 'session.status', params: [o] });
  }

  /**
   * The chat is deleted: its session closes in the extension (its tabs leave the group), also when it has no link
   * open now: right away when the extension is connected, else once it is back.
   */
  disconnect(chatId) {
    this.statuses.delete(chatId);
    const open = this.ports.has(chatId);
    super.disconnect(chatId);
    if (open) return;
    if (this.peer?.open) this.peer.send({ chat: chatId, method: 'session.close', params: [] });
    else this.closing.add(chatId);
  }

  /**
   * Every chat's session, the extension's connection and the server go (the app quits): the extension lets go of
   * the chats' tabs and they leave their groups, the user's again. An unexpected drop keeps the groups instead.
   */
  stop() {
    super.stop();
    const peer = this.peer;
    this.peer = null;
    peer?.close(1001, 'MoPilot stopped');
    this.ports.clear();
    // a wait still pending from before the stop holds back no page after a restart
    this.offeredBy = null;
    this.serveAbort?.abort();
    this.serveAbort = null;
    this.extServer?.close();
    this.extServer = null;
    this.serving = null;
  }
}

module.exports = {
  ChromeExtensionChannel,
  ExtensionPeer,
  ChatPort,
  proofOf,
  pairingCode,
  claimUrl,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  OPTIONS_PAGE,
  SOCKET_PATH,
  PROTOCOL_VERSION,
};
