// A request ID is a random version-four UUID suitable for correlating remote replies.
import { toHex } from '../../../shared/remote/envelope.mjs';

export function requestId(randomBytes: (length: number) => Uint8Array) {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = toHex(bytes);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
