// A one-way sealed box for MoMo's Google sign-in hand-off over the shared remote primitives (Host and Mac: node, phone: libsodium): ephemeral X25519, HKDF-SHA256 and XChaCha20-Poly1305 with the context as associated data, so a relay or phone that carries the text can neither read nor re-target it.
import { fromBase64, toBase64, utf8, fromUtf8 } from '../remote/envelope.mjs';
import { createCrypto } from '../remote/crypto.mjs';

const VERSION = '1';
const SALT = utf8('momo-google-seal');
const NONCE_BYTES = 24;
const KEY_BYTES = 32;

/**
 * @param {import('../remote/crypto.mjs').Primitives} p the platform's primitive set (shared/remote/nodePrimitives.mjs, phonePrimitives.mjs)
 */
export function createSealer(p) {
  const { hkdf } = createCrypto(p);
  /** @param {Uint8Array} shared @param {string} context */
  const keyFor = (shared, context) => hkdf(SALT, shared, `seal|${context}`);
  return {
    /** A fresh key pair for one hand-off, as base64: the public half goes to whoever seals, the private half stays on the home. */
    generateKeyPair() {
      const sk = p.randomBytes(KEY_BYTES);
      return { publicKey: toBase64(p.x25519Base(sk)), privateKey: toBase64(sk) };
    },
    /**
     * Seals `plaintext` to `publicKey`; the result opens only with the matching private key and the same `context`.
     * @param {string} publicKey @param {string} plaintext @param {string} context
     */
    seal(publicKey, plaintext, context) {
      const peer = fromBase64(publicKey);
      if (peer.length !== KEY_BYTES) throw new Error('Not a sealing key');
      const eph = p.randomBytes(KEY_BYTES);
      const key = keyFor(p.x25519(eph, peer), context);
      const nonce = p.randomBytes(NONCE_BYTES);
      const box = p.aeadSeal(key, nonce, utf8(plaintext), utf8(context));
      return [VERSION, toBase64(p.x25519Base(eph)), toBase64(nonce), toBase64(box)].join('.');
    },
    /**
     * Opens a sealed text; one generic error for every kind of failure, so a caller cannot tell a wrong key from a changed text.
     * @param {string} privateKey @param {string} sealed @param {string} context
     */
    open(privateKey, sealed, context) {
      try {
        const [version, eph, nonce, box, extra] = String(sealed).split('.');
        if (version !== VERSION || !box || extra !== undefined) throw new Error('shape');
        const key = keyFor(p.x25519(fromBase64(privateKey), fromBase64(eph)), context);
        const plain = p.aeadOpen(key, fromBase64(nonce), fromBase64(box), utf8(context));
        if (!plain) throw new Error('tag');
        return fromUtf8(plain);
      } catch {
        throw new Error('Could not open the sealed text');
      }
    },
  };
}
