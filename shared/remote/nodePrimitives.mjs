// The primitive set of shared/remote/crypto.mjs on plain node:crypto, for a process that has no native modules (the MoPilot Host):
// X25519 and Ed25519 from raw keys, HMAC and SHA-256, and XChaCha20-Poly1305 as HChaCha20 (written out here) in front of
// node's IETF ChaCha20-Poly1305. tests/nodePrimitives.test.ts holds it to shared/remote/vectors.json, so it seals exactly as libsodium does.
import nodeCrypto from 'node:crypto';

const X_PKCS8 = Buffer.from('302e020100300506032b656e04220420', 'hex');
const X_SPKI = Buffer.from('302a300506032b656e032100', 'hex');
const ED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const ED_SPKI = Buffer.from('302a300506032b6570032100', 'hex');
const TAG = 16;

const view = (/** @type {Buffer} */ b) => new Uint8Array(b.buffer, b.byteOffset, b.length);
const xPrivate = (/** @type {Uint8Array} */ sk) =>
  nodeCrypto.createPrivateKey({ key: Buffer.concat([X_PKCS8, Buffer.from(sk)]), format: 'der', type: 'pkcs8' });
const rawPublic = (/** @type {nodeCrypto.KeyObject} */ k) =>
  view(/** @type {Buffer} */ (nodeCrypto.createPublicKey(k).export({ format: 'der', type: 'spki' })).subarray(-32));

const rotl = (/** @type {number} */ v, /** @type {number} */ n) => ((v << n) | (v >>> (32 - n))) >>> 0;

/** HChaCha20: the subkey XChaCha20 uses for a 24-byte nonce (draft-irtf-cfrg-xchacha, section 2.2). @param {Uint8Array} key @param {Uint8Array} nonce16 */
export function hchacha20(key, nonce16) {
  const k = Buffer.from(key);
  const n = Buffer.from(nonce16);
  const s = new Uint32Array(16);
  s.set([0x61707865, 0x3320646e, 0x79622d32, 0x6b206574]);
  for (let i = 0; i < 8; i++) s[4 + i] = k.readUInt32LE(i * 4);
  for (let i = 0; i < 4; i++) s[12 + i] = n.readUInt32LE(i * 4);
  const q = (/** @type {number} */ a, /** @type {number} */ b, /** @type {number} */ c, /** @type {number} */ d) => {
    s[a] += s[b];
    s[d] = rotl(s[d] ^ s[a], 16);
    s[c] += s[d];
    s[b] = rotl(s[b] ^ s[c], 12);
    s[a] += s[b];
    s[d] = rotl(s[d] ^ s[a], 8);
    s[c] += s[d];
    s[b] = rotl(s[b] ^ s[c], 7);
  };
  for (let i = 0; i < 10; i++) {
    q(0, 4, 8, 12);
    q(1, 5, 9, 13);
    q(2, 6, 10, 14);
    q(3, 7, 11, 15);
    q(0, 5, 10, 15);
    q(1, 6, 11, 12);
    q(2, 7, 8, 13);
    q(3, 4, 9, 14);
  }
  const out = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    out.writeUInt32LE(s[i], i * 4);
    out.writeUInt32LE(s[12 + i], 16 + i * 4);
  }
  return out;
}

/** The ChaCha20-Poly1305 key and 12-byte nonce XChaCha20-Poly1305 runs on. @param {Uint8Array} key @param {Uint8Array} nonce 24 bytes */
const xchacha = (key, nonce) => ({
  subkey: hchacha20(key, nonce.subarray(0, 16)),
  iv: Buffer.concat([Buffer.alloc(4), Buffer.from(nonce.subarray(16, 24))]),
});

/** @returns {import('./crypto.mjs').Primitives} */
export function createNodePrimitives() {
  return {
    randomBytes: (n) => view(nodeCrypto.randomBytes(n)),
    sha256: (data) => view(nodeCrypto.createHash('sha256').update(data).digest()),
    hmacSha256: (key, data) => view(nodeCrypto.createHmac('sha256', key).update(data).digest()),
    aeadSeal(key, nonce, plain, aad) {
      const { subkey, iv } = xchacha(key, nonce);
      const c = nodeCrypto.createCipheriv('chacha20-poly1305', subkey, iv, { authTagLength: TAG });
      c.setAAD(aad, { plaintextLength: plain.length });
      return view(Buffer.concat([c.update(plain), c.final(), c.getAuthTag()]));
    },
    aeadOpen(key, nonce, box, aad) {
      if (box.length < TAG) return null;
      const { subkey, iv } = xchacha(key, nonce);
      const d = nodeCrypto.createDecipheriv('chacha20-poly1305', subkey, iv, { authTagLength: TAG });
      d.setAAD(aad, { plaintextLength: box.length - TAG });
      d.setAuthTag(box.subarray(box.length - TAG));
      try {
        return view(Buffer.concat([d.update(box.subarray(0, box.length - TAG)), d.final()]));
      } catch {
        // a failed tag is the answer, not an error
        return null;
      }
    },
    x25519(sk, pk) {
      try {
        return view(
          nodeCrypto.diffieHellman({
            privateKey: xPrivate(sk),
            publicKey: nodeCrypto.createPublicKey({ key: Buffer.concat([X_SPKI, Buffer.from(pk)]), format: 'der', type: 'spki' }),
          }),
        );
      } catch {
        // OpenSSL refuses a low-order key; libsodium's crypto_scalarmult gives zeros, which crypto.mjs refuses with its own error
        return new Uint8Array(32);
      }
    },
    x25519Base: (sk) => rawPublic(xPrivate(sk)),
    edKeypair() {
      const seed = nodeCrypto.randomBytes(32);
      const pk = rawPublic(nodeCrypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, seed]), format: 'der', type: 'pkcs8' }));
      // libsodium's secret key: the seed, then the public key
      return { pk, sk: view(Buffer.concat([seed, pk])) };
    },
    edSign: (sk, msg) =>
      view(
        nodeCrypto.sign(
          null,
          msg,
          nodeCrypto.createPrivateKey({ key: Buffer.concat([ED_PKCS8, Buffer.from(sk.subarray(0, 32))]), format: 'der', type: 'pkcs8' }),
        ),
      ),
    edVerify(pk, msg, sig) {
      try {
        return nodeCrypto.verify(
          null,
          msg,
          nodeCrypto.createPublicKey({ key: Buffer.concat([ED_SPKI, Buffer.from(pk)]), format: 'der', type: 'spki' }),
          sig,
        );
      } catch {
        return false;
      }
    },
  };
}
