// Serializes Host trust-file read/modify/write operations across the service and CLI; nested synchronous pairing/update-key writes share one owner, and interrupted owners use the existing PID-lock recovery protocol.
import fs from 'node:fs';
import path from 'node:path';
import { tryLock } from './pidLock.mjs';
import { recoverTrust } from './trustRecovery.mjs';

/** Synchronous nested calls cannot overlap another task in this process. */
const held = new Set();

/**
 * A live competing writer is a retryable refusal, never permission to overwrite its snapshot. No waiting blocks the Host's event loop.
 * @template T
 * @param {string} configDir
 * @param {() => T} work
 * @returns {T}
 */
export function withTrustWrite(configDir, work) {
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const root = fs.realpathSync(configDir);
  if (held.has(root)) {
    recoverTrust(root);
    return work();
  }
  const lock = tryLock(path.join(root, 'trust-write.lock'));
  if (!lock.owned)
    throw Object.assign(new Error('Another Host process is updating trust. Try again after it finishes.'), { code: 'trust_busy' });
  held.add(root);
  try {
    recoverTrust(root);
    return work();
  } finally {
    held.delete(root);
    lock.release();
  }
}
