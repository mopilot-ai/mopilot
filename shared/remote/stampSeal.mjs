// The lease of the MoMo home that sent a push, sealed for the phone: the Host seals {homeId, leaseEpoch} under a key derived from the enrollment's pair root and the phone opens it with the same root, so the relay, APNs and FCM carry it unread and learn nothing (not how many homes a phone has, not when one moves) and cannot raise or flood a bar they cannot read or write. The phone, not the relay, is the authority: it drops a push whose stamp is older than the newest it has seen for that home.
import { createCrypto, NONCE_BYTES } from './crypto.mjs';
import { fromBase64, fromUtf8, toBase64, utf8 } from './envelope.mjs';

const KEY_INFO = 'push-stamp-key|1';
const AAD_LABEL = 'mopilot-push-stamp-v1';
const VERSION = 1;
const TAG_BYTES = 16;
/** A home's id is at most this long (the Host's own id). */
export const MAX_HOME_ID = 64;
/** The most characters a sealed stamp may have on the wire: the relay refuses more, and a real one is far under it. */
export const MAX_SEALED_STAMP = 256;

const aad = (/** @type {string} */ ref) => utf8(`${AAD_LABEL}|${ref}`);

/** @param {import('./crypto.mjs').Primitives} prim */
export function createStampSeal(prim) {
  const { hkdf } = createCrypto(prim);
  /** The key of one enrollment's stamps: its own label under the pair root, never the ratchet, the title key or the card key. @param {Uint8Array} pairRoot */
  const stampKey = (pairRoot) => hkdf(utf8('mopilot-remote-v1'), pairRoot, KEY_INFO);

  return {
    stampKey,
    /**
     * Seal a stamp for one phone, bound to the push's `ref` (not to its body or card: a relay could attach the newest valid stamp for a ref to an older push on the same ref, so a stamp proves the home's lease, not which push it came with; known limit, the phone's newest-lease rule still refuses anything older than the lease it has seen). Returns base64url without padding, or null for a stamp that is not one.
     * @param {{ key: Uint8Array, ref: string, homeId: string, leaseEpoch: number }} o
     */
    seal(o) {
      if (typeof o.homeId !== 'string' || !o.homeId || utf8(o.homeId).length > MAX_HOME_ID) return null;
      if (!Number.isSafeInteger(o.leaseEpoch) || o.leaseEpoch < 1) return null;
      const nonce = prim.randomBytes(NONCE_BYTES);
      const box = prim.aeadSeal(o.key, nonce, utf8(JSON.stringify({ h: o.homeId, e: o.leaseEpoch })), aad(o.ref));
      const out = new Uint8Array(1 + NONCE_BYTES + box.length);
      out[0] = VERSION;
      out.set(nonce, 1);
      out.set(box, 1 + NONCE_BYTES);
      return toBase64(out).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    },
    /**
     * Open a stamp under any of a phone's keys (one per enrollment); any failure returns null and the phone treats the push as unstamped.
     * @param {{ sealed: string, ref: string, keys: Uint8Array[] }} o @returns {{ homeId: string, leaseEpoch: number } | null}
     */
    open(o) {
      if (typeof o.sealed !== 'string' || o.sealed.length > MAX_SEALED_STAMP) return null;
      let blob;
      try {
        const std = o.sealed.replace(/-/g, '+').replace(/_/g, '/');
        blob = fromBase64(std + '='.repeat((4 - (std.length % 4)) % 4));
      } catch {
        return null;
      }
      if (blob.length < 1 + NONCE_BYTES + TAG_BYTES || blob[0] !== VERSION) return null;
      const nonce = blob.slice(1, 1 + NONCE_BYTES);
      const box = blob.slice(1 + NONCE_BYTES);
      for (const key of o.keys) {
        if (key.length !== 32) continue;
        let plain;
        try {
          plain = prim.aeadOpen(key, nonce, box, aad(o.ref));
        } catch {
          continue;
        }
        if (!plain) continue;
        try {
          const v = JSON.parse(fromUtf8(plain));
          if (typeof v?.h === 'string' && v.h && v.h.length <= MAX_HOME_ID && Number.isSafeInteger(v.e) && v.e >= 1)
            return { homeId: v.h, leaseEpoch: v.e };
        } catch {
          continue;
        }
      }
      return null;
    },
  };
}
