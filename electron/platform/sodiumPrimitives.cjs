// The Mac's primitive set for shared/remote/crypto.mjs: libsodium through sodium-native (XChaCha20-Poly1305, X25519, Ed25519, SHA-256) and node:crypto for HMAC-SHA256, every value a Uint8Array.
const nodeCrypto = require('node:crypto');

const view = (/** @type {Buffer} */ b) => new Uint8Array(b.buffer, b.byteOffset, b.length);

/** @returns {import('../../shared/remote/crypto.mjs').Primitives} */
function createSodiumPrimitives() {
  // loaded when the stack starts, not when main loads: the native addon picks its prebuild by process.platform, which a test of another platform overrides
  const sodium = require('sodium-native');
  return {
    randomBytes(n) {
      const b = Buffer.alloc(n);
      sodium.randombytes_buf(b);
      return view(b);
    },
    sha256(data) {
      const out = Buffer.alloc(sodium.crypto_hash_sha256_BYTES);
      sodium.crypto_hash_sha256(out, Buffer.from(data));
      return view(out);
    },
    hmacSha256: (key, data) => view(nodeCrypto.createHmac('sha256', key).update(data).digest()),
    aeadSeal(key, nonce, plain, aad) {
      const out = Buffer.alloc(plain.length + sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES);
      sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        out,
        Buffer.from(plain),
        Buffer.from(aad),
        null,
        Buffer.from(nonce),
        Buffer.from(key),
      );
      return view(out);
    },
    aeadOpen(key, nonce, box, aad) {
      const abytes = sodium.crypto_aead_xchacha20poly1305_ietf_ABYTES;
      if (box.length < abytes) return null;
      const out = Buffer.alloc(box.length - abytes);
      try {
        sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          out,
          null,
          Buffer.from(box),
          Buffer.from(aad),
          Buffer.from(nonce),
          Buffer.from(key),
        );
      } catch {
        // a failed tag is the answer, not an error
        return null;
      }
      return view(out);
    },
    x25519(sk, pk) {
      const out = Buffer.alloc(sodium.crypto_scalarmult_BYTES);
      sodium.crypto_scalarmult(out, Buffer.from(sk), Buffer.from(pk));
      return view(out);
    },
    x25519Base(sk) {
      const out = Buffer.alloc(sodium.crypto_scalarmult_BYTES);
      sodium.crypto_scalarmult_base(out, Buffer.from(sk));
      return view(out);
    },
    edKeypair() {
      const pk = Buffer.alloc(sodium.crypto_sign_PUBLICKEYBYTES);
      const sk = Buffer.alloc(sodium.crypto_sign_SECRETKEYBYTES);
      sodium.crypto_sign_keypair(pk, sk);
      return { pk: view(pk), sk: view(sk) };
    },
    edSign(sk, msg) {
      const sig = Buffer.alloc(sodium.crypto_sign_BYTES);
      sodium.crypto_sign_detached(sig, Buffer.from(msg), Buffer.from(sk));
      return view(sig);
    },
    edVerify: (pk, msg, sig) => sodium.crypto_sign_verify_detached(Buffer.from(sig), Buffer.from(msg), Buffer.from(pk)),
  };
}

module.exports = { createSodiumPrimitives };
