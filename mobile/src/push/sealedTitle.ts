// Open the opt-in sealed chat title and MoMo's opt-in push body (A6): XChaCha20-Poly1305 under a per-pair title key, stateless so it never touches a ratchet.
import { fromBase64, fromUtf8, utf8 } from '../../../shared/remote/envelope.mjs';
import { NONCE_BYTES } from '../../../shared/remote/crypto.mjs';

type Open = (key: Uint8Array, nonce: Uint8Array, box: Uint8Array, aad: Uint8Array) => Uint8Array | null;

const TAG_BYTES = 16;
const MAX_TITLE_BYTES = 200;
export const TITLE_KEY_BYTES = 32;

/** The associated data binds a sealed title to the chat handle it was sent for, so a replayed blob under another ref fails. */
export const titleAad = (ref: string) => utf8(`mopilot-push-title-v1|${ref}`);
/** The same for MoMo's push body: its own prefix, so a sealed title can never be read as a body or the reverse (shared/remote/pushSettings.mjs PUSH_BODY_AAD_PREFIX). */
export const bodyAad = (ref: string) => utf8(`mopilot-push-body-v1|${ref}`);

const clean = (title: string) =>
  // eslint-disable-next-line no-control-regex
  title.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

/**
 * The blob is base64url(nonce24 || box) as the relay's `st` field, padded or not. The relay does not say which pair a push belongs to, so each stored title key is tried;
 * the AEAD tag decides. Any failure (bad base64, short blob, no key opens it, empty or oversized text) returns null and the
 * caller keeps the fixed title.
 */
export function openSealedTitle(o: { sealed: string; ref: string; keys: Uint8Array[]; open: Open }): string | null {
  return openSealed(o, titleAad(o.ref));
}

/** MoMo's sealed push body: the title's rules (every failure is null) under the body's AAD. The Mac pads it with spaces, which the cleaning drops. */
export function openSealedBody(o: { sealed: string; ref: string; keys: Uint8Array[]; open: Open }): string | null {
  return openSealed(o, bodyAad(o.ref));
}

function openSealed(o: { sealed: string; keys: Uint8Array[]; open: Open }, aad: Uint8Array): string | null {
  let blob: Uint8Array;
  try {
    // the relay forwards base64url without padding
    const std = o.sealed.replace(/-/g, '+').replace(/_/g, '/');
    blob = fromBase64(std + '='.repeat((4 - (std.length % 4)) % 4));
  } catch {
    return null;
  }
  if (blob.length < NONCE_BYTES + TAG_BYTES + 1) return null;
  const nonce = blob.slice(0, NONCE_BYTES);
  const box = blob.slice(NONCE_BYTES);
  for (const key of o.keys) {
    if (key.length !== TITLE_KEY_BYTES) continue;
    let plain: Uint8Array | null;
    try {
      plain = o.open(key, nonce, box, aad);
    } catch {
      continue;
    }
    if (!plain || plain.length > MAX_TITLE_BYTES) continue;
    let title: string;
    try {
      title = clean(fromUtf8(plain));
    } catch {
      continue;
    }
    return title || null;
  }
  return null;
}
