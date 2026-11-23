// Pairing a phone with this Mac (design: Mobile Remote, "Pairing flow"). begin() makes the QR payload { v:3, relay, macId, macPub, macEdPub, macEphPub, code, exp } with a 32-byte one-time code that dies in two minutes, and registers the pair the code names (shared/remote/crypto.mjs pairId(code)) at the relay, which never learns the code. The phone's hello is a frame of counter 0 in that pair, sealed under a key only someone who scanned the QR can make; the Mac checks the proof HMAC(code, both public keys), derives the twenty-digit safety number (a hash of the whole pairing transcript, shared/remote/crypto.mjs pairTranscript), and waits for the user's confirmation (the app's ApprovalBroker card, electron/remote/pairApproval.cjs). The code is spent the moment a valid hello is read, so a second phone, a replay or a late confirmation can't pair; every way out except `paired` removes the pair at the relay. States: waiting, confirming, paired, declined, expired, rejected, failed, cancelled.
const { fromBase64, toBase64, toHex, utf8, fromUtf8, sameBytes, createCrypto } = require('./esm.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { cleanDeviceName } = require('./deviceName.cjs');
const { accountHint } = require('../../shared/remote/accountHint.mjs');

const CODE_TTL_MS = 2 * 60_000;
/** The user has this long to compare the numbers and confirm after a valid hello. */
const CONFIRM_TTL_MS = 5 * 60_000;

/**
 * @typedef {'waiting' | 'confirming' | 'paired' | 'declined' | 'expired' | 'rejected' | 'failed' | 'cancelled'} PairingState
 * @typedef {{ state: PairingState, deviceId?: string, deviceName?: string, safetyNumber?: string, error?: string }} PairingEvent
 */

class PairingError extends Error {
  constructor(/** @type {'busy' | 'relay'} */ code, /** @type {string} */ message) {
    super(message);
    this.code = code;
  }
}

const b64 = (/** @type {unknown} */ v, /** @type {number} */ len) => {
  try {
    const bytes = fromBase64(/** @type {string} */ (v));
    return bytes.length === len ? bytes : null;
  } catch {
    return null;
  }
};

class PairingService {
  /**
   * @param {object} o
   * @param {InstanceType<typeof import('./identity.cjs').IdentityStore>} o.identity
   * @param {InstanceType<typeof import('./deviceList.cjs').DeviceList>} o.devices
   * @param {import('../../shared/remote/crypto.mjs').Primitives} o.prim
   * @param {() => string} o.relayUrl
   * @param {(pair: string) => Promise<void>} o.registerPair registers the pair at the relay (pair.register)
   * @param {(pair: string) => Promise<void>} [o.removePair] removes it (pair.remove); best effort
   * @param {(frame: { pair: string, dir: 'm2p', ctr: 0, nonce: Uint8Array, box: Uint8Array }) => Promise<void> | void} o.sendReply sends the answer frame through the relay
   * @param {(req: { device: { id: string, name: string }, safetyNumber: string, signal: AbortSignal }) => Promise<'allow' | 'deny' | null>} o.confirm
   * @param {(device: import('./deviceList.cjs').Device) => unknown} [o.onUnpaired] the channel drops the pair's sessions and tells the phone
   * @param {() => { id?: string, email?: string } | null | undefined} [o.account] who is signed in on this Mac: the QR carries a non-secret hint of it so the phone can tell a different account at the scan
   * @param {() => number} [o.now]
   */
  constructor(o) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.crypto = createCrypto(o.prim);
    /** @type {{ code: Uint8Array, pair: string, exp: number, ephSk: Uint8Array, ephPub: Uint8Array, timer: ReturnType<typeof setTimeout> } | null} */
    this.pending = null;
    /** @type {AbortController | null} */
    this.confirming = null;
    /** @type {{ pair: string, ac: AbortController, removed: boolean } | null} */
    this.activePair = null;
    /** @type {Set<(e: PairingEvent) => void>} */
    this.listeners = new Set();
  }

  /** @param {(e: PairingEvent) => void} fn @returns {() => void} */
  onEvent(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  #emit(/** @type {PairingEvent} */ e) {
    for (const fn of this.listeners) {
      try {
        fn(e);
      } catch (error) {
        noteIgnored('tell a pairing listener', error);
      }
    }
  }

  /**
   * A new QR payload. It replaces a pairing still waiting for its phone; one the user is confirming is not replaced.
   * @returns {Promise<{ payload: object, qr: string, expiresAt: number }>}
   */
  async begin() {
    if (this.confirming) throw new PairingError('busy', 'A phone is waiting for your confirmation');
    const id = await this.o.identity.get();
    if (this.confirming) throw new PairingError('busy', 'A phone is waiting for your confirmation');
    this.#drop('cancelled');
    const code = this.o.prim.randomBytes(32);
    const exp = this.now() + CODE_TTL_MS;
    const pair = this.crypto.pairId(code);
    // the Mac's ephemeral key for this pairing goes in the QR, so both screens can show a number that covers it; it is deleted once the root exists or the code dies
    const ephSk = this.o.prim.randomBytes(32);
    const ephPub = this.o.prim.x25519Base(ephSk);
    const mine = { code, pair, exp, ephSk, ephPub, timer: setTimeout(() => this.#expire(mine), CODE_TTL_MS) };
    mine.timer.unref?.();
    this.pending = mine;
    try {
      await this.o.registerPair(pair);
    } catch (error) {
      if (this.pending === mine) this.#drop(null);
      noteIgnored('register a pairing at the relay', error);
      throw new PairingError('relay', 'The relay could not be reached');
    }
    // a newer begin() or a cancel() while the relay answered owns the state now
    if (this.pending !== mine) throw new PairingError('busy', 'The pairing was replaced');
    const payload = {
      v: 3,
      relay: this.o.relayUrl(),
      macId: id.macId,
      macPub: toBase64(id.x.pk),
      macEdPub: toBase64(id.ed.pk),
      macEphPub: toBase64(ephPub),
      code: toBase64(code),
      exp,
      ...accountHint(this.o.prim.sha256, this.o.account?.()),
    };
    this.#emit({ state: 'waiting' });
    return { payload, qr: JSON.stringify(payload), expiresAt: exp };
  }

  /** The user closed the QR. A phone already being confirmed is declined. */
  cancel() {
    this.confirming?.abort();
    this.#drop('cancelled');
  }

  /**
   * The relay's hello lists the pairs it holds for this Mac. A joined one that no device holds is left over from a removal that could not
   * reach the relay (a phone revoked while the Mac was offline, a pairing that failed): it is removed there, so the phone stops seeing this
   * Mac and its frames stop being kept. Nothing is removed while a pairing is being made (its pair is joined before the device is saved) or
   * while the device list cannot be trusted (locked after a failed save), and a failure leaves the pair for the next connect.
   * @param {unknown} pairs the hello's `pairs`
   */
  async reconcile(pairs) {
    if (!Array.isArray(pairs) || this.pending || this.activePair || this.o.devices.locked) return;
    const held = new Set(this.o.devices.list().map((d) => d.pairId));
    for (const p of pairs) {
      if (p?.role !== 'mac' || p.joined !== true || typeof p.pair !== 'string' || held.has(p.pair)) continue;
      try {
        await this.o.removePair?.(p.pair);
      } catch (error) {
        noteIgnored('remove a pair the relay still holds', error);
      }
    }
  }

  /** The relay removed this pair; a late confirmation cannot restore it. */
  pairRemoved(/** @type {string} */ pair) {
    if (this.pending?.pair === pair) this.#drop('cancelled', true);
    if (this.activePair?.pair === pair) {
      this.o.devices.retirePair(pair);
      this.activePair.removed = true;
      this.activePair.ac.abort();
    }
  }

  /** Forgets the pending code and wipes its ephemeral secret (unless a hello is spending it, `wipe` false), with the state to announce; the relay's pair goes too unless it is the one being paired (`keep`). @param {PairingState | null} state @param {boolean} [keep] */
  #drop(state, keep = false, wipe = true) {
    const p = this.pending;
    if (!p) return;
    clearTimeout(p.timer);
    if (wipe) p.ephSk.fill(0);
    this.pending = null;
    if (!keep) this.#removePair(p.pair);
    if (state) this.#emit({ state });
  }

  #removePair(/** @type {string} */ pair) {
    Promise.resolve(this.o.removePair?.(pair)).catch((error) => noteIgnored('remove a pairing at the relay', error));
  }

  /** Whether a public key is one the exchange refuses (a low-order point). @param {Uint8Array} pub */
  #lowOrder(pub) {
    const scratch = this.o.prim.randomBytes(32);
    let low = false;
    try {
      // both primitive sets throw when the shared secret would be all zeros
      this.o.prim.x25519(scratch, pub);
    } catch {
      low = true;
    }
    scratch.fill(0);
    return low;
  }

  #expire(/** @type {NonNullable<PairingService['pending']>} */ p) {
    if (this.pending === p) this.#drop('expired');
  }

  /**
   * A phone's hello: the frame of counter 0 it sent in the pair this Mac registered.
   * @param {{ pair: string, dir: string, ctr: number, nonce: Uint8Array, box: Uint8Array }} frame
   * @returns {Promise<PairingState | 'ignored'>}
   */
  async handleHello(frame) {
    /** @type {{ ephSk: Uint8Array | null }} */
    const spent = { ephSk: null };
    try {
      return await this.#hello(frame, spent);
    } finally {
      spent.ephSk?.fill(0);
    }
  }

  /** @param {{ pair: string, dir: string, ctr: number, nonce: Uint8Array, box: Uint8Array }} frame @param {{ ephSk: Uint8Array | null }} spent the pending pairing's ephemeral secret once the code is spent: the caller wipes it on every way out */
  async #hello(frame, spent) {
    const p = this.pending;
    if (!p || frame.pair !== p.pair || frame.dir !== 'p2m' || frame.ctr !== 0) return 'ignored';
    const phonePub = this.crypto.helloPub(frame);
    if (!phonePub) return 'ignored';
    const id = await this.o.identity.get();
    // the identity read may have let a cancel, an expiry or a newer begin() in
    if (this.pending !== p) return 'ignored';
    const key = this.crypto.helloKey(id.x.sk, phonePub, p.code);
    const reply = (/** @type {object} */ body) => this.#reply(p.pair, key, body);
    if (this.now() >= p.exp) {
      this.#drop('expired');
      await reply({ ok: false, error: 'expired' });
      return 'expired';
    }
    // a box only someone with the code can make: anything else is noise and changes nothing
    const plain = this.crypto.openHelloFrame(key, frame);
    if (!plain) return 'ignored';
    const req = parseRequest(plain);
    const proof = this.crypto.pairProof(p.code, id.x.pk, phonePub);
    // from here the code is spent, whatever happens next; the relay's pair stays only if the phone ends up paired
    spent.ephSk = p.ephSk;
    this.#drop(null, true, false);
    if (!req || !sameBytes(proof, req.proof)) {
      this.#removePair(p.pair);
      this.#emit({ state: 'rejected' });
      await reply({ ok: false, error: 'proof' });
      return 'rejected';
    }
    // an ephemeral key that makes a zero shared secret is refused before the user is asked about it
    if (this.#lowOrder(req.ephPub)) {
      this.#removePair(p.pair);
      this.#emit({ state: 'rejected' });
      await reply({ ok: false, error: 'proof' });
      return 'rejected';
    }
    const safetyNumber = this.crypto.safetyNumber(
      this.crypto.pairTranscript({
        macId: id.macId,
        phoneId: req.phoneId,
        pairId: p.pair,
        macPub: id.x.pk,
        phonePub,
        macEdPub: id.ed.pk,
        phoneEdPub: req.edPub,
        macEphPub: p.ephPub,
        phoneEphPub: req.ephPub,
      }),
    );
    const ac = new AbortController();
    this.confirming = ac;
    const active = { pair: p.pair, ac, removed: false };
    this.activePair = active;
    const timer = setTimeout(() => ac.abort(), CONFIRM_TTL_MS);
    timer.unref?.();
    // a phone this Mac already has is replaced by this pairing: the card says so, first and in words the new name cannot push out
    const known = this.o.devices.get(req.phoneId);
    const shownName = known ? `Replaces "${known.name}" with "${req.name}"` : req.name;
    this.#emit({ state: 'confirming', deviceId: req.phoneId, deviceName: shownName, safetyNumber });
    /** @type {'allow' | 'deny' | null} */
    let decision = null;
    try {
      decision = await this.o.confirm({ device: { id: req.phoneId, name: shownName }, safetyNumber, signal: ac.signal });
    } catch (error) {
      noteIgnored('ask the user to confirm a pairing', error);
    } finally {
      clearTimeout(timer);
    }
    if (decision !== 'allow' || ac.signal.aborted) {
      if (this.confirming === ac) this.confirming = null;
      if (this.activePair === active) this.activePair = null;
      this.#removePair(p.pair);
      this.#emit({ state: 'declined', deviceId: req.phoneId });
      await reply({ ok: false, error: 'declined' });
      return 'declined';
    }
    // the ephemeral key of this pairing (its public half went out in the QR, the phone's came in the hello and was checked before the user was asked) is deleted as soon as the root exists
    const root = this.crypto.deriveRoot(
      id.x.sk,
      phonePub,
      /** @type {Uint8Array} */ (spent.ephSk),
      req.ephPub,
      id.macId,
      req.phoneId,
      p.pair,
    );
    spent.ephSk?.fill(0);
    const previous = this.o.devices.get(req.phoneId);
    try {
      const stored = await this.o.devices.addGuarded(
        {
          id: req.phoneId,
          name: req.name,
          pairId: p.pair,
          pub: toBase64(phonePub),
          edPub: toBase64(req.edPub),
          tx: { ctr: 0, chain: toHex(this.crypto.dirKey(root, 'm2p')) },
          rx: { ctr: 0, chain: toHex(this.crypto.dirKey(root, 'p2m')) },
        },
        () => !ac.signal.aborted,
        () => {
          if (this.confirming === ac) this.confirming = null;
        },
      );
      if (!stored) {
        if (this.confirming === ac) this.confirming = null;
        if (this.activePair === active) this.activePair = null;
        this.#removePair(p.pair);
        this.#emit({ state: 'declined', deviceId: req.phoneId });
        await reply({ ok: false, error: 'declined' });
        return 'declined';
      }
    } catch (error) {
      if (this.confirming === ac) this.confirming = null;
      if (this.activePair === active) this.activePair = null;
      noteIgnored('save a paired phone', error);
      this.#removePair(p.pair);
      this.#emit({
        state: 'failed',
        deviceId: req.phoneId,
        error: this.o.devices.locked
          ? this.o.devices.uncertainActivation
            ? 'uncertain'
            : 'storage-locked'
          : String(/** @type {any} */ (error)?.code ?? 'storage'),
      });
      await reply({ ok: false, error: 'storage' });
      return 'failed';
    }
    if (active.removed) {
      try {
        await this.o.devices.removePair(req.phoneId, p.pair);
      } catch (error) {
        noteIgnored('forget a removed pairing', error);
        if (this.activePair === active) this.activePair = null;
        this.#emit({ state: 'failed', deviceId: req.phoneId, error: 'uncertain' });
        await reply({ ok: false, error: 'storage' });
        return 'failed';
      }
      if (this.activePair === active) this.activePair = null;
      this.#emit({ state: 'declined', deviceId: req.phoneId });
      await reply({ ok: false, error: 'declined' });
      return 'declined';
    }
    if (this.activePair === active) this.activePair = null;
    // a re-pair leaves the phone's old pair behind at the relay
    if (previous && previous.pairId !== p.pair) this.#removePair(previous.pairId);
    this.#emit({ state: 'paired', deviceId: req.phoneId, deviceName: req.name, safetyNumber });
    await reply({ v: 3, ok: true, pairId: p.pair });
    return 'paired';
  }

  async #reply(/** @type {string} */ pair, /** @type {Uint8Array} */ key, /** @type {object} */ body) {
    try {
      await this.o.sendReply(this.crypto.replyFrame(pair, key, utf8(JSON.stringify(body))));
    } catch (error) {
      noteIgnored('answer a phone\u2019s pairing request', error);
    }
  }

  /** Remove the observed pair, then tell the channel. @param {string} deviceId @param {string} pairId @returns {Promise<boolean>} */
  async unpair(deviceId, pairId) {
    const device = this.o.devices.get(deviceId);
    if (!device || device.pairId !== pairId) return false;
    if (!(await this.o.devices.removePair(deviceId, pairId))) return false;
    this.#removePair(device.pairId);
    try {
      await this.o.onUnpaired?.(device);
    } catch (error) {
      noteIgnored('tell the channel a phone was unpaired', error);
    }
    return true;
  }
}

/** The pair request inside a hello: { v: 3, phoneId, name, edPub, proof, ephPub }, or null when it isn't one. */
function parseRequest(/** @type {Uint8Array} */ plain) {
  let r;
  try {
    r = JSON.parse(fromUtf8(plain));
  } catch {
    return null;
  }
  const edPub = b64(r?.edPub, 32);
  const proof = b64(r?.proof, 32);
  const ephPub = b64(r?.ephPub, 32);
  if (r?.v !== 3 || typeof r?.phoneId !== 'string' || !/^[A-Za-z0-9_-]{4,64}$/.test(r.phoneId) || !edPub || !proof || !ephPub) return null;
  const name = typeof r.name === 'string' ? cleanDeviceName(r.name) : '';
  return { phoneId: r.phoneId, name: name || 'Phone', edPub, proof, ephPub };
}

module.exports = { PairingService, PairingError, CODE_TTL_MS, CONFIRM_TTL_MS };
