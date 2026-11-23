// Sealed-frame core for the Mobile Remote spike: ratchet, header AAD, replay guard, two libsodium backends.
import { createHmac, hkdfSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import sodiumNative from 'sodium-native';
import wasm from 'libsodium-wrappers';
import sumo from 'libsodium-wrappers-sumo';

const b64 = (u) => Buffer.from(u).toString('base64');
const unb64 = (s) => new Uint8Array(Buffer.from(s, 'base64'));
const utf8 = (s) => new Uint8Array(Buffer.from(s, 'utf8'));
const MAX_GAP = 1000;

// Mac side: sodium-native for X25519 + XChaCha20-Poly1305, node:crypto for HKDF (sodium-native has no HMAC).
export const nodeBackend = {
  name: 'sodium-native',
  async ready() {},
  pub(sk) { const o = Buffer.alloc(32); sodiumNative.crypto_scalarmult_base(o, sk); return new Uint8Array(o); },
  dh(sk, pk) { const o = Buffer.alloc(32); sodiumNative.crypto_scalarmult(o, sk, pk); return new Uint8Array(o); },
  hkdf(ikm, salt, info, len) { return new Uint8Array(hkdfSync('sha256', ikm, salt, info, len)); },
  random(n) { const o = Buffer.alloc(n); sodiumNative.randombytes_buf(o); return new Uint8Array(o); },
  seal(key, nonce, aad, pt) {
    const c = Buffer.alloc(pt.length + 16);
    sodiumNative.crypto_aead_xchacha20poly1305_ietf_encrypt(c, pt, aad, null, nonce, key);
    return new Uint8Array(c);
  },
  open(key, nonce, aad, ct) {
    const m = Buffer.alloc(ct.length - 16);
    try { sodiumNative.crypto_aead_xchacha20poly1305_ietf_decrypt(m, null, ct, aad, nonce, key); } catch { return null; }
    return new Uint8Array(m);
  },
};

// Phone side stand-in: libsodium-wrappers (WASM). react-native-libsodium mirrors this API, but its HKDF is
// `_unstable_crypto_kdf_hkdf_sha256_{extract,expand}`; neither wrappers nor its sumo build has HKDF or SHA-256 in the
// standard build, so HKDF here is HMAC-SHA256 from libsodium-wrappers-sumo's crypto_hash_sha256.
function hmac(sodium, key, msg) {
  const block = 64;
  const k = key.length > block ? sodium.crypto_hash_sha256(key) : key;
  const ipad = new Uint8Array(block).fill(0x36), opad = new Uint8Array(block).fill(0x5c);
  k.forEach((v, i) => { ipad[i] ^= v; opad[i] ^= v; });
  const inner = sodium.crypto_hash_sha256(Uint8Array.from([...ipad, ...msg]));
  return sodium.crypto_hash_sha256(Uint8Array.from([...opad, ...inner]));
}
export const wasmBackend = {
  name: 'libsodium-wrappers',
  async ready() { await Promise.all([wasm.ready, sumo.ready]); },
  pub: (sk) => wasm.crypto_scalarmult_base(sk),
  dh: (sk, pk) => wasm.crypto_scalarmult(sk, pk),
  hkdf(ikm, salt, info, len) {
    const prk = hmac(sumo, salt.length ? salt : new Uint8Array(32), ikm);
    let t = new Uint8Array(0); const out = [];
    for (let i = 1; out.length < len; i++) { t = hmac(sumo, prk, Uint8Array.from([...t, ...info, i])); out.push(...t); }
    return Uint8Array.from(out.slice(0, len));
  },
  random: (n) => wasm.randombytes_buf(n),
  seal: (key, nonce, aad, pt) => wasm.crypto_aead_xchacha20poly1305_ietf_encrypt(pt, aad, null, nonce, key),
  open(key, nonce, aad, ct) {
    try { return wasm.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, aad, nonce, key); } catch { return null; }
  },
};

export function dirKey(be, mySk, theirPk, macId, phoneId, dir) {
  const salt = utf8(`mopilot-remote/v1|${macId}|${phoneId}`);
  return be.hkdf(be.dh(mySk, theirPk), salt, utf8(`dir:${dir}`), 32);
}

// Header (pair, dir, ctr) is authenticated as AAD and never encrypted.
export function headerAad(pair, dir, ctr) {
  const ctrBytes = Buffer.alloc(8); ctrBytes.writeBigUInt64BE(BigInt(ctr));
  return Uint8Array.from(Buffer.concat([Buffer.from(pair), Buffer.from([0]), Buffer.from(dir), Buffer.from([0]), ctrBytes]));
}

const zeros = new Uint8Array(32);
export function ratchetStep(be, ck) {
  return { mk: be.hkdf(ck, zeros, utf8('mk'), 32), ck: be.hkdf(ck, zeros, utf8('ck'), 32) };
}

export class Sender {
  constructor(be, pair, dir, key) { Object.assign(this, { be, pair, dir, ck: key, ctr: 0 }); }
  seal(plaintext, nonce = this.be.random(24), ctr = this.ctr + 1) {
    const { mk, ck } = ratchetStep(this.be, this.ck);
    const box = this.be.seal(mk, nonce, headerAad(this.pair, this.dir, ctr), utf8(plaintext));
    this.ck = ck; this.ctr = ctr;
    return { pair: this.pair, dir: this.dir, ctr, nonce: b64(nonce), box: b64(box) };
  }
}

export class Receiver {
  constructor(be, pair, dir, key) { Object.assign(this, { be, pair, dir, ck: key, last: 0 }); }
  // Throws 'replay' for ctr <= last, 'gap' past MAX_GAP and 'auth' for a forged or altered frame; state moves only on success.
  open(frame) {
    if (frame.pair !== this.pair || frame.dir !== this.dir) throw new Error('route');
    if (!Number.isSafeInteger(frame.ctr) || frame.ctr <= this.last) throw new Error('replay');
    if (frame.ctr - this.last > MAX_GAP) throw new Error('gap');
    let ck = this.ck, mk;
    for (let i = this.last; i < frame.ctr; i++) ({ mk, ck } = ratchetStep(this.be, ck));
    const pt = this.be.open(mk, unb64(frame.nonce), headerAad(frame.pair, frame.dir, frame.ctr), unb64(frame.box));
    if (!pt) throw new Error('auth');
    this.ck = ck; this.last = frame.ctr;
    return Buffer.from(pt).toString('utf8');
  }
}

// Deterministic inputs so every implementation can reproduce vectors.json byte for byte.
export const FIXED = {
  macId: 'mac_01', phoneId: 'phone_01', pair: 'p_9f01',
  macSk: Array.from({ length: 32 }, (_, i) => i + 1),
  phoneSk: Array.from({ length: 32 }, (_, i) => 0xa0 + i),
  messages: [
    { dir: 'p2m', ctr: 1, text: '{"id":"m_1","kind":"request","method":"card.answer","params":{"cardId":"c1","rev":418,"key":"allow"}}', nonce0: 0x10 },
    { dir: 'p2m', ctr: 2, text: 'second phone message', nonce0: 0x20 },
    { dir: 'p2m', ctr: 5, text: 'after a gap of two', nonce0: 0x30 },
    { dir: 'm2p', ctr: 1, text: '{"id":"m_9","kind":"reply","ok":true}', nonce0: 0x40 },
    { dir: 'm2p', ctr: 2, text: 'ünïcødé ✓', nonce0: 0x50 },
  ],
};
const nonceOf = (n0) => Uint8Array.from({ length: 24 }, (_, i) => n0 + i);

export function keysFor(be, who) {
  const macSk = Uint8Array.from(FIXED.macSk), phoneSk = Uint8Array.from(FIXED.phoneSk);
  const [mine, theirs] = who === 'mac' ? [macSk, be.pub(phoneSk)] : [phoneSk, be.pub(macSk)];
  const k = (dir) => dirKey(be, mine, theirs, FIXED.macId, FIXED.phoneId, dir);
  return { p2m: k('p2m'), m2p: k('m2p') };
}

export function buildVectors(be) {
  const keys = keysFor(be, 'mac');
  const senders = { p2m: new Sender(be, FIXED.pair, 'p2m', keys.p2m), m2p: new Sender(be, FIXED.pair, 'm2p', keys.m2p) };
  const frames = FIXED.messages.map((m) => ({
    text: m.text,
    frame: senders[m.dir].seal(m.text, nonceOf(m.nonce0), m.ctr),
  }));
  // Gap case: the sender's ratchet only moved once per seal, so reseal in order with explicit counters
  // would desync; the vector for ctr 5 is built from a chain stepped to 5 instead.
  const gap = FIXED.messages.find((m) => m.ctr === 5);
  let ck = keys.p2m; let mk;
  for (let i = 0; i < 5; i++) ({ mk, ck } = ratchetStep(be, ck));
  const idx = FIXED.messages.indexOf(gap);
  frames[idx].frame = { pair: FIXED.pair, dir: 'p2m', ctr: 5, nonce: b64(nonceOf(gap.nonce0)),
    box: b64(be.seal(mk, nonceOf(gap.nonce0), headerAad(FIXED.pair, 'p2m', 5), utf8(gap.text))) };
  const hex = (u) => Buffer.from(u).toString('hex');
  return {
    note: 'Deterministic test vectors; see README.md for the construction. Keys are fixed test values, never real ones.',
    construction: 'X25519 -> HKDF-SHA256(salt="mopilot-remote/v1|macId|phoneId", info="dir:<dir>") -> chain key; per message mk=HKDF(ck,salt=0^32,info="mk"), ck\'=HKDF(ck,salt=0^32,info="ck"); XChaCha20-Poly1305 with AAD = pair||0||dir||0||u64be(ctr)',
    macId: FIXED.macId, phoneId: FIXED.phoneId, pair: FIXED.pair,
    macSk: hex(FIXED.macSk), phoneSk: hex(FIXED.phoneSk),
    macPk: hex(be.pub(Uint8Array.from(FIXED.macSk))), phonePk: hex(be.pub(Uint8Array.from(FIXED.phoneSk))),
    dirKeys: { p2m: hex(keys.p2m), m2p: hex(keys.m2p) },
    frames,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--write')) {
  const v = buildVectors(nodeBackend);
  writeFileSync(new URL('./vectors.json', import.meta.url), `${JSON.stringify(v, null, 2)}\n`);
  console.log(`wrote vectors.json (${v.frames.length} frames)`);
}
