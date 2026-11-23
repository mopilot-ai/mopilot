// The sealed blob of a Host's approval push: sealed on the Host and opened on the phone under a key derived from the enrollment's pair root, so the relay carries it unread.
import { createCrypto, NONCE_BYTES } from './crypto.mjs';
import { fromBase64, fromUtf8, toBase64, utf8 } from './envelope.mjs';

const KEY_INFO = 'push-card-key|1';
const AAD_LABEL = 'mopilot-push-card-v1';
const VERSION = 1;
const TAG_BYTES = 16;
/** The most bytes a blob may have before base64; the relay accepts 2048 characters, this leaves room. */
export const MAX_CARD_BLOB_BYTES = 1200;
export const DETAIL_LEVELS = Object.freeze(['minimal', 'tool', 'full']);
export const CARD_TOOLS = Object.freeze(['execute', 'edit', 'delete', 'fetch', 'plan', 'question', 'other']);
/** What a push says about its card: waiting is the first push, the rest reuse the chat's collapse id and replace it. */
export const CARD_STATES = Object.freeze(['waiting', 'reminder', 'paused', 'cleared']);
const MAX_MACHINE = 64;
const MAX_LINE = 160;
const HEADER_FIXED = 1 + 1 + 4 + NONCE_BYTES;

const PHRASE = {
  execute: 'run a command',
  edit: 'edit files',
  delete: 'delete files',
  fetch: 'use the network',
  plan: 'review a plan',
  question: 'ask a question',
  other: 'do something',
};

/** The words for a tool kind, as the lock screen shows them. @param {string} tool */
export const toolPhrase = (tool) => PHRASE[/** @type {keyof typeof PHRASE} */ (tool)] ?? PHRASE.other;

/** A tool kind the phone treats as needing the app open instead of Allow in place (D8). @param {string} tool */
export const opensApp = (tool) => tool === 'delete' || tool === 'fetch';

// eslint-disable-next-line no-control-regex
const clean = (/** @type {unknown} */ s, /** @type {number} */ max) =>
  typeof s === 'string'
    ? s
        .replace(/[\u0000-\u001f\u007f]+/g, ' ')
        .trim()
        .slice(0, max)
    : '';

const aad = (/** @type {string} */ ref, /** @type {string} */ requestId, /** @type {number} */ rev) =>
  utf8(`${AAD_LABEL}|${ref}|${requestId}|${rev}`);

/**
 * @typedef {{ machine?: string, tool?: string, line?: string, stat?: string, question?: boolean, state?: string }} CardText what a lock screen shows, by detail level
 * @typedef {{ requestId: string, rev: number, card: CardText }} OpenedCard
 */

/** @param {import('./crypto.mjs').Primitives} prim */
export function createCardPush(prim) {
  const { hkdf } = createCrypto(prim);
  /** The key of one enrollment's card pushes: its own label under the pair root, never the ratchet or the title key. @param {Uint8Array} pairRoot */
  const cardKey = (pairRoot) => hkdf(utf8('mopilot-remote-v1'), pairRoot, KEY_INFO);

  /**
   * Seal a card for one phone. Minimal detail carries no text at all (only the ids the action needs).
   * Returns base64url without padding, or null when the ids cannot be carried.
   * @param {{ key: Uint8Array, ref: string, requestId: string, rev: number, detail: string, card: { machine?: string, tool?: string, line?: string, stat?: string, question?: boolean }, state?: string }} o
   */
  function seal(o) {
    const rid = utf8(o.requestId);
    if (rid.length === 0 || rid.length > 255 || !Number.isInteger(o.rev) || o.rev < 0 || o.rev > 0xffffffff) return null;
    /** @type {CardText} */
    let text = {};
    const state = CARD_STATES.includes(/** @type {string} */ (o.state)) && o.state !== 'waiting' ? o.state : undefined;
    if (o.detail !== 'minimal') {
      text = {
        machine: clean(o.card.machine, MAX_MACHINE),
        tool: CARD_TOOLS.includes(/** @type {string} */ (o.card.tool)) ? o.card.tool : 'other',
      };
      if (o.card.question) text.question = true;
      if (o.detail === 'full') {
        const line = clean(o.card.line, MAX_LINE);
        const stat = clean(o.card.stat, 40);
        if (line) text.line = line;
        if (stat) text.stat = stat;
      }
    }
    // a reminder, a pause or a clearing is not content, so every detail level carries it
    if (state) text.state = state;
    // the field caps bound the text (machine 64, line 160, stat 40 units, at most 3 bytes each) and the request id 255 bytes, so a blob stays under MAX_CARD_BLOB_BYTES without a trim step
    const plain = utf8(JSON.stringify(text));
    const nonce = prim.randomBytes(NONCE_BYTES);
    const box = prim.aeadSeal(o.key, nonce, plain, aad(o.ref, o.requestId, o.rev));
    const out = new Uint8Array(HEADER_FIXED - NONCE_BYTES + rid.length + NONCE_BYTES + box.length);
    out[0] = VERSION;
    out[1] = rid.length;
    out.set(rid, 2);
    new DataView(out.buffer).setUint32(2 + rid.length, o.rev);
    out.set(nonce, 6 + rid.length);
    out.set(box, 6 + rid.length + NONCE_BYTES);
    return toBase64(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * Open a blob under any of a phone's card keys (one per enrollment); the tag decides which fits. Any failure returns null,
   * and the caller keeps the fixed title.
   * @param {{ sealed: string, ref: string, keys: Uint8Array[] }} o @returns {OpenedCard | null}
   */
  function open(o) {
    let blob;
    try {
      const std = o.sealed.replace(/-/g, '+').replace(/_/g, '/');
      blob = fromBase64(std + '='.repeat((4 - (std.length % 4)) % 4));
    } catch {
      return null;
    }
    if (blob.length < 2 || blob[0] !== VERSION || blob[1] === 0) return null;
    const ridLen = blob[1];
    if (blob.length < 2 + ridLen + 4 + NONCE_BYTES + TAG_BYTES || blob.length > MAX_CARD_BLOB_BYTES) return null;
    let requestId;
    try {
      requestId = fromUtf8(blob.slice(2, 2 + ridLen));
    } catch {
      return null;
    }
    const rev = new DataView(blob.buffer, blob.byteOffset).getUint32(2 + ridLen);
    const nonce = blob.slice(6 + ridLen, 6 + ridLen + NONCE_BYTES);
    const box = blob.slice(6 + ridLen + NONCE_BYTES);
    const ad = aad(o.ref, requestId, rev);
    for (const key of o.keys) {
      if (key.length !== 32) continue;
      let plain;
      try {
        plain = prim.aeadOpen(key, nonce, box, ad);
      } catch {
        continue;
      }
      if (!plain) continue;
      try {
        const parsed = JSON.parse(fromUtf8(plain));
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
        /** @type {CardText} */
        const card = {};
        if (typeof parsed.machine === 'string' && parsed.machine) card.machine = clean(parsed.machine, MAX_MACHINE);
        if (CARD_TOOLS.includes(parsed.tool)) card.tool = parsed.tool;
        if (CARD_STATES.includes(parsed.state) && parsed.state !== 'waiting') card.state = parsed.state;
        if (parsed.question === true) card.question = true;
        if (typeof parsed.line === 'string' && parsed.line) card.line = clean(parsed.line, MAX_LINE);
        if (typeof parsed.stat === 'string' && parsed.stat) card.stat = clean(parsed.stat, 40);
        return { requestId, rev, card };
      } catch {
        continue;
      }
    }
    return null;
  }

  return { cardKey, seal, open };
}

/**
 * The title and body the lock screen shows for an opened card, by what it carries (minimal carries nothing, so it is the fixed text).
 * @param {CardText} card @returns {{ title: string, body: string }}
 */
export function cardText(card) {
  if (card.state === 'reminder')
    return {
      title: card.machine ? `${card.machine} · still waiting` : 'Still waiting for you',
      body: '',
    };
  if (card.state === 'paused')
    return {
      title: card.machine ? `${card.machine} · paused` : 'A chat paused',
      body: 'No one answered, so it stopped.',
    };
  if (card.state === 'cleared') return { title: 'A chat no longer needs you', body: '' };
  if (!card.tool) return { title: 'A chat needs you', body: '' };
  const phrase = card.question ? toolPhrase('question') : toolPhrase(card.tool);
  return {
    title: card.machine ? `${card.machine} · ${phrase}` : phrase,
    body: [card.line, card.stat].filter(Boolean).join(' · '),
  };
}
