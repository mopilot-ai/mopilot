// A paired phone's idempotent send/start has one domain-scoped native UUID, derived identically on the phone and Mac without transmitting pairing identity.
import { utf8 } from './envelope.mjs';
/** @param {(bytes: Uint8Array) => Uint8Array} hash @param {string} pairId @param {'chat.send' | 'chat.start'} method @param {string | null} chatId @param {string} id */
export function messageIdentity(hash, pairId, method, chatId, id) {
  const scope = method === 'chat.start' ? ['start', id] : ['send', chatId, id];
  const bytes = Uint8Array.from(hash(utf8(JSON.stringify(['mopilot.phone.message', 1, pairId, ...scope]))).slice(0, 16));
  // UUID-shaped correlation, accepted by native message APIs; this does not replace authentication or dedupe.
  bytes[6] = (bytes[6] & 15) | 0x50;
  bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
