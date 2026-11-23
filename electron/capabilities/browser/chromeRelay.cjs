// MoPilot's own CDP relay to the Playwright Extension in the user's Chrome (design D5, B2 step 1), behind shared.browser.chromeRelay.
//
// It replaces @playwright/mcp for this path: MoPilot serves the extension's relay protocol
// (protocol version 2, as the extension's lib/background.mjs speaks it) on a loopback WebSocket server
// and drives Chrome with the five commands the extension allows - chrome.debugger.attach, detach and
// sendCommand, chrome.tabs.create and remove - and the events it forwards (chrome.debugger.onEvent and
// onDetach, chrome.tabs.onCreated and onRemoved, extension.initialized).
//
// - One extension connection per chat, so each chat gets its own tab group in Chrome (the extension
//   groups the tabs a connection attaches, titled "Playwright · <client name>"). A connection starts by
//   opening the extension's connect page with the relay URL, a per-connection path and, when MoPilot has it, the extension's token (no token: the user approves the connection in Chrome).
// - Only the extension's origin may open a relay path, and a command can only name a tab the chat's own
//   connection reported (the connect page, a tab it created, a popup of one, a tab the user dragged into
//   the group): the user's other tabs are never reached, whatever tab id a caller passes.
// - Turn tokens (design D1 step 2): every command carries (chatId, turn) from token(), and a command
//   whose turn is no longer the chat's current one is refused (stale_turn) without reaching Chrome. The
//   turn is the chat's control epoch for Chrome; within it, the running call's guard (actionGuard.cjs)
//   refuses a call that was stopped (Stop, a harness cancel) with `stopped`, as Your Chrome does.
//   advance() starts a new turn (the chat's turn end, a Stop). Commands that only let go (detaching,
//   closing a tab) are never refused, so the turn end's cleanup always runs.
// - Each command has a timeout; a chat whose extension is not connected gets one clear error naming
//   the extension, its install page and the token.
const crypto = require('node:crypto');
const http = require('node:http');
const { listenLoopback } = require('../../platform/listenLoopback.cjs');
const { EventEmitter } = require('node:events');
const { noteIgnored, messageOf } = require('../../ignored.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { acceptWebSocket } = require('./wsServer.cjs');
const { mayAct, stopped, unguarded } = require('../contract/actionGuard.cjs');
const {
  ChromeLink,
  linkGone,
  retiredMembership,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  EXTENSION_URL,
  CONNECT_PAGE,
} = require('./chromeLink.cjs');
/** @typedef {InstanceType<typeof ChromeLink>} ChromeLink */

const PROTOCOL_VERSION = 2;
const CONNECT_MS = 30_000;
const COMMAND_MS = 20_000;
/** Commands that only let go: never refused for a stale turn. */
const RELEASES = new Set(['chrome.debugger.detach', 'chrome.tabs.remove']);
const COMMANDS = new Set([
  'chrome.debugger.attach',
  'chrome.debugger.detach',
  'chrome.debugger.sendCommand',
  'chrome.tabs.create',
  'chrome.tabs.remove',
]);

const notConnected = (ms) =>
  new ToolError(
    `Your Chrome isn't connected: the Playwright Extension did not connect within ${Math.round(ms / 1000)} s. Make sure Chrome is open with the Playwright Extension installed (${EXTENSION_URL}) and that the connection token in Settings → Browser matches the extension's, then try again.`,
    'not_connected',
  );
const staleTurn = () => new ToolError('This browser step belongs to a turn that already ended, so it was not run in Chrome.', 'stale_turn');
/**
 * What a file upload Chrome refused for want of file access says: which extension needs "Allow access to file URLs"
 * (the one serving this connection, never another), so the agent relays the right fix (bu3: the Codex plugin's own
 * hint named the ChatGPT extension while MoPilot's served). Other refusals pass through as they are.
 * @param {unknown} error what the command failed with
 * @param {string} extension the extension as chrome://extensions lists it
 */
function fileAccessRefusal(error, extension) {
  if (!/\bNot allowed\b/.test(messageOf(error))) return error;
  return new ToolError(
    `Chrome refused to attach the file because the ${extension} extension can't read files on this computer. To enable file upload, open chrome://extensions in Chrome, click Details under "${extension}", and turn on "Allow access to file URLs"; then try the upload again.`,
    'file_access',
  );
}

class ChromeRelay extends EventEmitter {
  /**
   * @param {{ openPage: (url: string, chatId: string) => unknown,
   *           token?: () => string | null | undefined,
   *           clientName?: (chatId: string) => string,
   *           connectMs?: number, commandMs?: number,
   *           createServer?: () => import('node:http').Server }} o
   *   openPage: opens the extension's connect page in the user's Chrome (never another profile's)
   *   token: the Playwright Extension's connection token (chromeToken.cjs), when the user gave one
   *   clientName: the name the extension shows and titles the chat's tab group with
   */
  constructor(o) {
    super();
    this.o = o;
    this.connectMs = o.connectMs ?? CONNECT_MS;
    this.commandMs = o.commandMs ?? COMMAND_MS;
    /** @type {import('node:http').Server | null} */
    this.server = null;
    /** @type {Promise<number> | null} */
    this.listening = null;
    /** @type {AbortController | null} */
    this.listenAbort = null;
    /** url path -> the chat waiting for the extension on it */
    this.waiting = new Map();
    /** chat id -> its connection */
    this.links = new Map();
    /** chat id -> a connection on its way */
    this.connecting = new Map();
    /** chat id -> its current turn (kept after a disconnect, so an old token never becomes current again) */
    this.turns = new Map();
    /** chat id -> how many times it was disconnected; and how many times the relay stopped: a connect they outdated is dropped */
    this.generations = new Map();
    this.epoch = 0;
  }

  /** The chat's current turn token: what every command of this turn carries. */
  token(chatId) {
    return Object.freeze({ chatId, turn: this.turns.get(chatId) ?? 0 });
  }

  /** A new turn of the chat (its turn ended, or Stop): commands carrying an older token are refused. */
  advance(chatId) {
    this.turns.set(chatId, (this.turns.get(chatId) ?? 0) + 1);
  }

  /** The Playwright Extension carries no administrator policy (MoPilot's does: chrome-extension/src/adminBlocks.mjs). */
  policyBlock(/** @type {string} */ _url) {
    return /** @type {string | null} */ (null);
  }

  /**
   * The chat's title and turn for its tab group: the Playwright Extension has no such message (MoPilot's does).
   * @param {string} _chatId @param {{ title: string | null, status: string | null }} _o
   */
  turnStatus(_chatId, _o) {
    // nothing to tell the Playwright Extension
  }

  /** Whether the chat's extension connection is open. */
  connected(chatId) {
    return !!this.links.get(chatId)?.open;
  }

  /** The chat's open connection, or null. */
  link(chatId) {
    const l = this.links.get(chatId);
    return l?.open ? l : null;
  }

  #listen() {
    if (this.listening) return this.listening;
    // outside any call: the server and its connections outlive the call that first connected (../contract/actionGuard.cjs)
    const listening = unguarded(() => this.#serve());
    this.listening = listening;
    listening.catch(() => {
      if (this.listening === listening) this.listening = null;
    });
    return listening;
  }

  async #serve() {
    const server = (this.o.createServer ?? (() => http.createServer()))();
    this.server = server;
    const abort = new AbortController();
    this.listenAbort = abort;
    server.on('request', (_req, res) => {
      res.statusCode = 404;
      res.end();
    });
    server.on('upgrade', (req, socket, head) => this.#upgrade(req, socket, head));
    let port;
    try {
      port = await listenLoopback(server, 0, abort.signal);
      if (abort.signal.aborted) throw new Error('The browser server was stopped while opening.');
    } catch (error) {
      if (this.server === server) {
        server.close();
        this.server = null;
      }
      throw error;
    } finally {
      if (this.listenAbort === abort) this.listenAbort = null;
    }
    return port;
  }

  #upgrade(req, socket, head) {
    const path = String(req.url).split('?')[0];
    const wait = this.waiting.get(path);
    // only the extension opens a relay path, and only one it was given
    if (!wait || req.headers.origin !== EXTENSION_ORIGIN) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const ws = acceptWebSocket(req, socket, head);
    if (!ws) return;
    this.waiting.delete(path);
    wait.arrived(ws);
  }

  /**
   * The connect page's URL for a relay path: the relay's address, the client name, the protocol version
   * and the token when there is one.
   */
  connectUrl(chatId, port, path) {
    const url = new URL(CONNECT_PAGE);
    url.searchParams.set('mcpRelayUrl', `ws://127.0.0.1:${port}${path}`);
    url.searchParams.set('client', JSON.stringify({ name: this.o.clientName?.(chatId) || 'MoPilot' }));
    url.searchParams.set('protocolVersion', String(PROTOCOL_VERSION));
    /** @type {string | null} */
    let token = null;
    try {
      token = this.o.token?.() || null;
    } catch (error) {
      // without the token Chrome asks the user to approve the connection
      noteIgnored("read the Playwright Extension's connection token", error);
    }
    if (token) url.searchParams.set('token', token);
    return url.toString();
  }

  /**
   * The chat's connection, opening one when there is none: the connect page opens in Chrome and the
   * extension connects back. Rejects with not_connected after connectMs.
   * @returns {Promise<ChromeLink>}
   */
  connect(chatId) {
    const open = this.link(chatId);
    if (open) return Promise.resolve(open);
    const on = this.connecting.get(chatId);
    if (on) return on;
    const p = this.openLink(chatId).finally(() => {
      if (this.connecting.get(chatId) === p) this.connecting.delete(chatId);
    });
    this.connecting.set(chatId, p);
    return p;
  }

  /**
   * Opens the chat's connection: the Playwright Extension's connect page, and the extension connecting back.
   * MoPilot's own extension (chromeExtension.cjs) opens it over its one connection instead.
   * @returns {Promise<ChromeLink>}
   */
  async openLink(chatId) {
    const generation = this.generation(chatId);
    const port = await this.#listen().catch((error) => {
      throw new ToolError(`Couldn't start the Chrome relay: ${messageOf(error)}`, 'not_connected');
    });
    if (this.generation(chatId) !== generation) throw new ToolError('The Chrome connection was closed while it opened.', 'not_connected');
    const path = `/extension/${crypto.randomUUID()}`;
    /** @type {any} */
    let timer = null;
    /** @type {ChromeLink | null} */
    let link = null;
    const done = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(notConnected(this.connectMs)), this.connectMs);
      timer.unref?.();
      this.waiting.set(path, {
        chatId,
        arrived: (ws) => {
          link = new ChromeLink(chatId, ws, this.commandMs);
          link.once('ready', () => resolve(link));
          link.once('closed', (reason) =>
            reject(new ToolError(`The Playwright Extension closed the connection: ${reason}`, 'not_connected')),
          );
        },
      });
    });
    const settled = () => {
      clearTimeout(timer);
      this.waiting.delete(path);
    };
    try {
      // both at once: a timeout while the page is still opening fails the connect, and is never left unhandled
      const [, ready] = await Promise.all([this.o.openPage(this.connectUrl(chatId, port, path), chatId), done]);
      settled();
      // the chat was disconnected (deleted) or the relay stopped while it connected: nobody owns this connection
      if (this.generation(chatId) !== generation) throw new ToolError('The Chrome connection was closed while it opened.', 'not_connected');
      this.adopt(chatId, ready);
      return ready;
    } catch (error) {
      settled();
      /** @type {ChromeLink | null} */ (link)?.close('not used');
      throw error instanceof ToolError ? error : new ToolError(`Couldn't open Chrome's connect page: ${messageOf(error)}`, 'not_connected');
    }
  }

  /** Changes when the chat is disconnected or the relay stops: a connect it outdated is dropped. */
  generation(chatId) {
    return `${this.epoch}:${this.generations.get(chatId) ?? 0}`;
  }

  /** The chat's new connection becomes its link. */
  adopt(chatId, link) {
    // connect() opens a connection only when the chat has none open, so this is the chat's only one
    this.links.set(chatId, link);
    link.once('closed', () => {
      if (this.links.get(chatId) !== link) return;
      this.links.delete(chatId);
      this.emit('disconnected', chatId);
    });
    this.emit('connected', chatId, link);
  }

  /**
   * Sends one of the extension's commands for the token's chat: refused for a stale turn (except a
   * release), a closed connection, or a tab the chat's connection never reported.
   * @param {{ chatId: string, turn: number, membership?: string | null, link?: unknown }} tok
   * @param {string} method
   * @param {any[]} params
   * @param {number | null} tabId the tab the command names, checked against the chat's tabs
   */
  command(tok, method, params, tabId = null) {
    if (!tok || typeof tok.chatId !== 'string' || !Number.isInteger(tok.turn))
      return Promise.reject(new ToolError('A Chrome command needs a turn token.', 'bad_args'));
    if (!COMMANDS.has(method)) return Promise.reject(new ToolError(`${method} is not a Chrome relay command.`, 'bad_args'));
    if (!RELEASES.has(method)) {
      if (tok.turn !== (this.turns.get(tok.chatId) ?? 0)) return Promise.reject(staleTurn());
      // a call stopped since it began (Stop, a harness cancel) sends nothing more to Chrome, as Your Chrome (../contract/actionGuard.cjs)
      if (!mayAct()) return Promise.reject(stopped(`${method.replace(/^chrome\./, '')} in your Chrome`));
    }
    const link = this.link(tok.chatId);
    if (!link || ('link' in tok && tok.link !== link)) return Promise.reject(linkGone());
    if (tabId !== null && !link.tabs.has(tabId))
      return Promise.reject(new ToolError(`Chrome tab ${tabId} is not one of this chat's tabs.`, 'bad_target'));
    let membership;
    if (tabId !== null && link.membershipReceipts) {
      membership = link.memberships.get(tabId)?.membership;
      if (!membership || tok.membership !== membership) return Promise.reject(retiredMembership());
    }
    return link.send(method, params, { ...this.frameFields(tok), ...(membership ? { membership } : {}) });
  }

  /**
   * Fields a command frame carries besides its id, method and params: none for the Playwright Extension.
   * @param {{ chatId: string, turn: number, membership?: string | null, link?: unknown }} _tok
   * @returns {Record<string, unknown> | null}
   */
  frameFields(_tok) {
    return null;
  }

  attach(tok, tabId) {
    return this.command(tok, 'chrome.debugger.attach', [{ tabId }, '1.3'], tabId);
  }

  detach(tok, tabId) {
    return this.command(tok, 'chrome.debugger.detach', [{ tabId }], tabId);
  }

  /** The extension that serves this connection, as chrome://extensions lists it (its errors name it). */
  get extensionName() {
    return 'Playwright Extension';
  }

  /**
   * A CDP command on a tab, or on a child session of it (a cross-origin frame). A file upload Chrome refuses for
   * want of file access says which extension to give it (fileAccessRefusal).
   */
  cdp(tok, { tabId, sessionId = '' }, method, params = {}) {
    const sent = this.command(tok, 'chrome.debugger.sendCommand', [sessionId ? { tabId, sessionId } : { tabId }, method, params], tabId);
    if (method !== 'DOM.setFileInputFiles') return sent;
    return sent.catch((error) => {
      throw fileAccessRefusal(error, this.extensionName);
    });
  }

  /** Opens a tab in the chat's group (the extension groups it once it is attached); resolves with chrome.tabs.Tab. */
  async createTab(tok, url = 'about:blank') {
    const link = this.link(tok.chatId);
    const tab = await this.command(tok, 'chrome.tabs.create', [{ url, active: false }]);
    if (!tab || !Number.isInteger(tab.id)) throw new ToolError("Chrome didn't open a tab.", 'failed');
    if (this.link(tok.chatId) !== link) throw linkGone();
    if (link.membershipReceipts) {
      if (!this.owns(tok.chatId, tab.id, tab.membership)) throw retiredMembership();
    } else link.tabs.set(tab.id, tab);
    return tab;
  }

  /** A captured host identity survives reconnect only when the extension reports the same receipt. */
  owns(chatId, tabId, membership) {
    const link = this.link(chatId);
    return (
      !!link?.tabs.has(tabId) &&
      (!link.membershipReceipts || (typeof membership === 'string' && link.memberships.get(tabId)?.membership === membership))
    );
  }

  removeTab(tok, tabId) {
    return this.command(tok, 'chrome.tabs.remove', [tabId], tabId);
  }

  /** The chat's connection goes (the chat was deleted): the extension ungroups its tabs. */
  disconnect(chatId) {
    this.links.get(chatId)?.close('MoPilot closed the connection');
    this.links.delete(chatId);
    this.generations.set(chatId, (this.generations.get(chatId) ?? 0) + 1);
  }

  /** Every connection and the server go (the app quits, the switch goes off). */
  stop() {
    for (const chatId of [...this.links.keys()]) this.disconnect(chatId);
    this.epoch++;
    this.listenAbort?.abort();
    this.listenAbort = null;
    this.server?.close();
    this.server = null;
    this.listening = null;
  }
}

module.exports = {
  ChromeRelay,
  ChromeLink,
  staleTurn,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  EXTENSION_URL,
  CONNECT_PAGE,
  PROTOCOL_VERSION,
  RELEASES,
};
