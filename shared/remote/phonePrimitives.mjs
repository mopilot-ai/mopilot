// Phone primitives for shared remote crypto, using injected react-native-libsodium and noble functions without Node APIs.
import { fromUtf8 } from './envelope.mjs';

/**
 * @typedef {object} PhoneSodium
 * @property {(n: number) => Uint8Array} randombytes_buf
 * @property {() => { publicKey: Uint8Array, privateKey: Uint8Array }} crypto_sign_keypair
 * @property {(msg: Uint8Array, sk: Uint8Array) => Uint8Array} crypto_sign_detached
 * @property {(sig: Uint8Array, msg: Uint8Array, pk: Uint8Array) => boolean} crypto_sign_verify_detached
 * @property {(plain: Uint8Array, aad: string, secretNonce: null, nonce: Uint8Array, key: Uint8Array) => Uint8Array} crypto_aead_xchacha20poly1305_ietf_encrypt
 * @property {(secretNonce: null, box: Uint8Array, aad: string, nonce: Uint8Array, key: Uint8Array) => Uint8Array} crypto_aead_xchacha20poly1305_ietf_decrypt
 */
/**
 * @typedef {object} PhoneNoble
 * @property {{ getSharedSecret: (sk: Uint8Array, pk: Uint8Array) => Uint8Array, getPublicKey: (sk: Uint8Array) => Uint8Array }} x25519
 * @property {typeof import('@noble/hashes/sha256').sha256} sha256
 * @property {typeof import('@noble/hashes/hmac').hmac} hmac
 */
/**
 * Adapt react-native-libsodium 1.7.0 and noble's x25519, sha256 and hmac to the shared crypto contract.
 * The native binding takes UTF-8 strings for AAD. Shared remote crypto produces UTF-8 AAD exclusively.
 * @param {PhoneSodium} sodium
 * @param {PhoneNoble} noble
 * @returns {import('./crypto.mjs').Primitives}
 */
export function createPhonePrimitives(sodium, noble) {
  return {
    randomBytes(n) {
      // The binding converts the JS number to a signed C++ int before allocating.
      if (!Number.isInteger(n) || n < 0 || n > 0x7fffffff) throw new RangeError('invalid random byte count');
      return sodium.randombytes_buf(n);
    },
    sha256: (data) => noble.sha256(data),
    hmacSha256: (key, data) => noble.hmac(noble.sha256, key, data),
    x25519: (sk, pk) => noble.x25519.getSharedSecret(sk, pk),
    x25519Base: (sk) => noble.x25519.getPublicKey(sk),
    edKeypair() {
      const pair = sodium.crypto_sign_keypair();
      return { pk: pair.publicKey, sk: pair.privateKey };
    },
    edSign(sk, msg) {
      if (sk.length !== 64) throw new RangeError('invalid Ed25519 secret key length');
      return sodium.crypto_sign_detached(msg, sk);
    },
    edVerify(pk, msg, sig) {
      if (pk.length !== 32 || sig.length !== 64) return false;
      return sodium.crypto_sign_verify_detached(sig, msg, pk);
    },
    aeadSeal: (key, nonce, plain, aad) => sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(plain, fromUtf8(aad), null, nonce, key),
    aeadOpen(key, nonce, box, aad) {
      // The 1.7.0 native binding subtracts the tag size before checking the box length.
      if (box.length < 16) return null;
      try {
        return sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, box, fromUtf8(aad), nonce, key);
      } catch (error) {
        if (
          error instanceof Error &&
          error.message ===
            '[react-native-libsodium][crypto_aead_xchacha20poly1305_ietf_decrypt] crypto_aead_xchacha20poly1305_ietf_decrypt failed'
        )
          return null;
        throw error;
      }
    },
  };
}
