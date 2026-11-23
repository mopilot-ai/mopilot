// Chat titles in push, opt-in and off by default. A per-pair title key is derived from the Mac's identity (never stored, never sent to the relay) and delivered to the phone once over the sealed channel as a `push.titleKey` event; a push for one chat then carries its title sealed with that key (`st`: unpadded base64url of nonce24 || XChaCha20-Poly1305 box, aad "mopilot-push-title-v1|" + ref), which only the phone's notification extension can open. The title is never sent in the clear, MoMo and machineOffline pushes keep their fixed titles, and a push goes out with its fixed title whenever the key is not ready. The same key seals the opt-in MoMo push body (A6, the user's own routine name, aad "mopilot-push-body-v1|" + ref), and it is delivered while that opt-in is on too.
'use strict';
const { noteIgnored } = require('../ignored.cjs');
const { toHex } = require('./esm.cjs');
const { readSealedJson, writeSealedJson } = require('./sealedJson.cjs');
const { prefixUnits } = require('../../shared/textPrefix.mjs');

const {
  PUSH_TITLE_EVENT: TITLE_EVENT,
  PUSH_TITLE_AAD_PREFIX: AAD_PREFIX,
  PUSH_TITLE_MAX_UNITS,
  PUSH_BODY_AAD_PREFIX: BODY_AAD_PREFIX,
  PUSH_BODY_PAD_BYTES,
} = require('../../shared/remote/pushSettings.mjs');
const KEY_LABEL = 'mopilot-push-title-key-v1|';
/** The key is handed to a phone again when it next talks to the Mac, at most this often per pair: the phone keeps it only while that Mac is the one it has selected and connected. */
const RESEND_MS = 5 * 60_000;
const utf8 = (/** @type {string} */ s) => new TextEncoder().encode(s);

class PushTitles {
  /**
   * @param {object} o
   * @param {string} o.file where the opt-in is kept (sealed like the other Mobile Remote files)
   * @param {import('./sealedJson.cjs').SafeStorage | null} o.safe
   * @param {import('./sealedJson.cjs').FsPromises} o.fs
   * @param {import('../../shared/remote/crypto.mjs').Primitives} o.prim
   * @param {{ get(): Promise<{ x: { sk: Uint8Array } }> }} o.identity
   * @param {{ send(pairId: string, msg: object): Promise<void>, onMessage(fn: (pairId: string) => void): () => void }} o.channel
   * @param {{ list(): { pairId: string }[], onChange(fn: (list: { pairId: string }[]) => void): () => void }} o.devices
   * @param {() => number} [o.now]
   * @param {() => boolean} [o.bodyOn] the Mac's opt-in for a MoMo push body (prefs.momo.notify.pushBody, read at each push): the phone's key is delivered while it is on, even when chat titles are off
   */
  constructor(o) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.bodyOn = o.bodyOn ?? (() => false);
    this.enabled = false;
    /** @type {Uint8Array | null} the secret the keys derive from; null until the identity has loaded */
    this.secret = null;
    /** @type {Set<string>} pairs whose key was handed to the channel since this start */
    this.delivered = new Set();
    /** @type {Promise<unknown>} saves one after another, so the file ends as the last switch left it */
    this.saving = Promise.resolve();
    /** @type {Map<string, number>} when each pair's key was last re-sent because the phone spoke */
    this.resent = new Map();
    const offDevices = o.devices.onChange(() => void this.start().then(() => this.#deliverAll()));
    const offMessages = o.channel.onMessage((pairId) => void this.start().then(() => this.#heard(pairId)));
    this.off = () => {
      offDevices();
      offMessages();
    };
    /** @type {Promise<void> | null} */
    this.ready = null;
  }

  /** Reads the setting and the identity. Nothing is read until a push, the Settings switch or a change of paired phones needs it, so a stack that only idles touches no storage for this. */
  start() {
    this.ready ??= this.#load();
    return this.ready;
  }

  async #load() {
    try {
      const read = await readSealedJson({ file: this.o.file, safe: this.o.safe, fs: this.o.fs });
      this.enabled = read.found && read.value?.titles === true;
      this.secret = (await this.o.identity.get()).x.sk;
    } catch (error) {
      noteIgnored('load the push title key', error);
    }
  }

  /** The Settings switch: persists it, and turning it on hands every paired phone its key. Resolves when it is saved. */
  async setEnabled(/** @type {boolean} */ on) {
    await this.start();
    const save = this.saving.then(() =>
      writeSealedJson({ file: this.o.file, safe: this.o.safe, fs: this.o.fs, value: { v: 1, titles: on } }),
    );
    this.saving = save.catch((error) => noteIgnored('save the push title setting', error));
    await save;
    this.enabled = on;
    this.#deliverAll();
  }

  /** @param {string} pairId @returns {Uint8Array | null} */
  keyOf(pairId) {
    return this.secret ? this.o.prim.hmacSha256(this.o.prim.hmacSha256(this.secret, utf8(KEY_LABEL)), utf8(pairId)) : null;
  }

  /** The phone spoke: if it may have just selected this Mac, it gets its key again (a phone that has it saves it idempotently). */
  #heard(/** @type {string} */ pairId) {
    if (!this.#wanted() || !this.o.devices.list().some((p) => p.pairId === pairId)) return;
    const last = this.resent.get(pairId);
    if (last !== undefined && this.now() - last < RESEND_MS) return;
    this.resent.set(pairId, this.now());
    this.delivered.delete(pairId);
    this.#deliverAll();
  }

  /** The phone needs its key: chat titles are on, or the MoMo push body opt-in is. */
  #wanted() {
    return this.enabled || this.bodyOn() === true;
  }

  #deliverAll() {
    const pairs = this.o.devices.list();
    // a removed pair's entry goes, so a pair that comes back is handed its key again
    for (const id of this.delivered) if (!pairs.some((p) => p.pairId === id)) this.delivered.delete(id);
    for (const id of this.resent.keys()) if (!pairs.some((p) => p.pairId === id)) this.resent.delete(id);
    if (!this.#wanted() || !this.secret) return;
    for (const { pairId } of pairs) {
      const key = this.delivered.has(pairId) ? null : this.keyOf(pairId);
      if (!key) continue;
      this.delivered.add(pairId);
      const msg = { id: `n_${this.now()}_titlekey`, t: this.now(), kind: 'event', ev: TITLE_EVENT, patch: { key: toHex(key) } };
      this.o.channel.send(pairId, msg).catch((error) => {
        // the next push for this pair sends it again; until then pushes keep the fixed title
        this.delivered.delete(pairId);
        noteIgnored('send the push title key', error);
      });
    }
  }

  /**
   * The sealed title of one chat's push, or null when titles are off, the key is not ready, the pair has no key yet on the phone, or there is no title.
   * @param {string} pairId @param {string} ref @param {string} title @returns {string | null}
   */
  seal(pairId, ref, title) {
    if (!this.ready) void this.start().then(() => this.#deliverAll());
    if (!this.enabled) return null;
    // a key that failed to go out is tried again with the next push; this one keeps its fixed title
    if (!this.delivered.has(pairId)) {
      this.#deliverAll();
      return null;
    }
    return this.#box(pairId, ref, prefixUnits(String(title ?? ''), PUSH_TITLE_MAX_UNITS), AAD_PREFIX);
  }

  /**
   * The sealed MoMo push body (A6) of one notice, or null when the opt-in is off, the key is not ready, the pair has no key yet on the phone, or there is no text. `text` is momoPushBody's result (shared/momoNotices.mjs): sealed under the pair's key with its own AAD, padded with spaces to one length so the relay learns nothing from its size.
   * @param {string} pairId @param {string} ref @param {string} text @returns {string | null}
   */
  sealBody(pairId, ref, text) {
    if (!this.ready) void this.start().then(() => this.#deliverAll());
    if (this.bodyOn() !== true || typeof text !== 'string' || !text) return null;
    if (!this.delivered.has(pairId)) {
      this.#deliverAll();
      return null;
    }
    return this.#box(pairId, ref, text, BODY_AAD_PREFIX, PUSH_BODY_PAD_BYTES);
  }

  /** @param {string} pairId @param {string} ref @param {string} text @param {string} aad @param {number} [pad] bytes to pad the text to @returns {string | null} */
  #box(pairId, ref, text, aad, pad = 0) {
    const key = this.keyOf(pairId);
    if (!key || !text) return null;
    const bytes = utf8(text);
    const plain = new Uint8Array(Math.max(pad, bytes.length)).fill(0x20);
    plain.set(bytes);
    const nonce = this.o.prim.randomBytes(24);
    const box = this.o.prim.aeadSeal(key, nonce, plain, utf8(aad + ref));
    return Buffer.from([...nonce, ...box]).toString('base64url');
  }

  stop() {
    this.off();
  }
}

module.exports = { PushTitles, TITLE_EVENT, AAD_PREFIX };
