// The phone's recomputation of a chat's opaque push handle, equal to shared/remote/ref.mjs without Node's crypto.
import { sha256 } from '@noble/hashes/sha256';
import { toBase64, utf8 } from '../../../shared/remote/envelope.mjs';

/** 22 base64url characters of SHA-256 over the pair id and the chat id. */
export function chatRef(pairId: string, chatId: string): string {
  return toBase64(sha256(utf8(`${pairId}\n${chatId}`)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
    .slice(0, 22);
}
