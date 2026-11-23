// Chrome extension transport: mutual handshake, pairing messages and each chat's share of the authenticated connection.
const crypto = require('node:crypto');
const { sameText } = require('../../platform/timingSafe.cjs');
const { EventEmitter } = require('node:events');
const { noteIgnored } = require('../../ignored.cjs');

const { DEV_EXTENSION_ID, originOf } = require('./chromeExtensionIds.cjs');
const { adminPatterns } = require('../../chrome-extension/src/adminBlocks.mjs');

/** The id Chrome gives the extension loaded unpacked (chromeExtensionIds.cjs has the store's beside it). */
const EXTENSION_ID = DEV_EXTENSION_ID;
const EXTENSION_ORIGIN = originOf(EXTENSION_ID);
const OPTIONS_PAGE = `${EXTENSION_ORIGIN}/options.html`;
const PROTOCOL_NAME = 'mopilot-chrome';
const PROTOCOL_VERSION = 1;
const MEMBERSHIP_CAPABILITY = 'tab-membership-v1';
const { PANEL_TAB_CAPABILITY } = require('../../chrome-extension/src/protocol.mjs');

/** The proof `role` gives for nonces a and b (the extension's src/protocol.mjs computes the same). */
function proofOf(secret, role, a, b) {
  return crypto.createHmac('sha256', secret).update(`${PROTOCOL_NAME}|${role}|${a}|${b}`).digest('hex');
}

/** The pairing code the extension stores. */
function pairingCode({ port, secret }) {
  return `${PROTOCOL_NAME}:${PROTOCOL_VERSION}:${port}:${secret}`;
}

/**
 * The options page of the extension `id` offering a one-time claim code for the port's pairing (never the secret).
 * @param {number} port @param {string} token @param {string} [id] the dev key's when not named
 */
function claimUrl(port, token, id = EXTENSION_ID) {
  return `${originOf(id)}/options.html#pair=${encodeURIComponent(claimCode(port, token))}`;
}

/** The one-time claim code for the port's pairing, as the page or the native host hands it to the extension. */
function claimCode(/** @type {number} */ port, /** @type {string} */ token) {
  return `mopilot-claim:${PROTOCOL_VERSION}:${port}:${token}`;
}

/**
 * The options page of the extension `id` when the native host hands over the claim code (#1632): the page's URL, which
 * reaches Chrome on its command line, then carries no code at all.
 * @param {string} [id]
 */
function hostPairUrl(id = EXTENSION_ID) {
  return `${originOf(id)}/options.html#pair=host`;
}

/** The extension's one connection: the handshake, then its messages by chat. */
class ExtensionPeer extends EventEmitter {
  /**
   * @param {any} ws a WsConnection @param {string} secret @param {number} authMs
   * @param {(token: unknown) => string | null} claim the pairing code for a valid one-time claim code, else null
   */
  constructor(ws, secret, authMs, claim) {
    super();
    this.ws = ws;
    this.secret = secret;
    this.claim = claim;
    this.authed = false;
    this.memberships = false;
    /** @type {string | null} the extension's version, once it proved the secret */
    this.version = null;
    /** @type {ReturnType<typeof adminPatterns>} the Chrome administrator's blocked sites, from the handshake */
    this.policy = [];
    this.nonce = crypto.randomBytes(16).toString('hex');
    this.timer = setTimeout(() => this.close(4408, 'no handshake'), authMs);
    this.timer.unref?.();
    ws.on('message', (text) => this.#message(text));
    ws.on('close', () => {
      clearTimeout(this.timer);
      this.emit('close');
    });
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocol: PROTOCOL_VERSION,
        nonce: this.nonce,
        capabilities: [MEMBERSHIP_CAPABILITY, PANEL_TAB_CAPABILITY],
      }),
    );
  }

  get open() {
    return this.authed && this.ws.open;
  }

  #message(text) {
    let m;
    try {
      m = JSON.parse(text);
    } catch (error) {
      noteIgnored("parse a message from MoPilot's Chrome extension", error);
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (!this.authed) {
      // the options page trades the one-time code it was opened with for the pairing code, then this connection ends
      const code = m.type === 'claim' && m.protocol === PROTOCOL_VERSION ? this.claim(m.token) : null;
      if (code) {
        this.ws.send(JSON.stringify({ type: 'paired', code }));
        this.close(1000, 'paired');
        return;
      }
      const ok =
        m.type === 'auth' &&
        m.protocol === PROTOCOL_VERSION &&
        typeof m.nonce === 'string' &&
        m.nonce.length >= 16 &&
        sameText(m.proof, proofOf(this.secret, 'extension', this.nonce, m.nonce));
      if (!ok) {
        this.close(4401, 'unauthorized');
        return;
      }
      clearTimeout(this.timer);
      this.authed = true;
      this.memberships =
        Array.isArray(m.capabilities) &&
        m.capabilities.every((value) => typeof value === 'string') &&
        m.capabilities.filter((value) => value === MEMBERSHIP_CAPABILITY).length === 1;
      this.version = typeof m.version === 'string' ? m.version.slice(0, 40) : null;
      // the Chrome administrator's blocked sites (chrome-extension/src/policy.mjs)
      this.policy = adminPatterns(m.policy);
      this.ws.send(
        JSON.stringify({
          type: 'welcome',
          proof: proofOf(this.secret, 'app', m.nonce, this.nonce),
          ...(this.memberships ? { capabilities: [MEMBERSHIP_CAPABILITY] } : {}),
        }),
      );
      this.emit('ready');
      return;
    }
    if (m.type === 'ping') {
      this.ws.send(JSON.stringify({ type: 'pong' }));
      return;
    }
    if (typeof m.chat === 'string') this.emit('chat', m.chat, text);
    // the side panel's requests (chromePanel.cjs)
    else if (m.type === 'panel') this.emit('panel', m);
  }

  /** A message to the extension, once it proved the secret. */
  send(message) {
    if (this.open) this.ws.send(JSON.stringify(message));
  }

  close(code, reason) {
    this.ws.close(code, reason);
  }
}

/** One chat's share of the extension's connection, shaped like the relay's per-chat WebSocket. */
class ChatPort extends EventEmitter {
  /** @param {ExtensionPeer} peer @param {string} chatId */
  constructor(peer, chatId) {
    super();
    this.peer = peer;
    this.chatId = chatId;
    this.closed = false;
  }

  get open() {
    return !this.closed && this.peer.open;
  }

  /** A relay frame for this chat (ChromeLink's): the chat is added. */
  send(text) {
    this.peer.send({ ...JSON.parse(text), chat: this.chatId });
  }

  /** MoPilot lets go of the chat's session (the chat was deleted, or the connection was not used). */
  close(code = 1000, reason = '') {
    if (this.closed) return;
    this.peer.send({ chat: this.chatId, method: 'session.close', params: [] });
    this.gone(code, reason);
  }

  /** The port is closed without telling the extension (its connection is gone). */
  gone(code = 1001, reason = '') {
    if (this.closed) return;
    this.closed = true;
    this.emit('close', code, reason);
  }
}

module.exports = {
  sameText,
  ExtensionPeer,
  ChatPort,
  proofOf,
  pairingCode,
  claimUrl,
  claimCode,
  hostPairUrl,
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  OPTIONS_PAGE,
  PROTOCOL_VERSION,
  MEMBERSHIP_CAPABILITY,
};
