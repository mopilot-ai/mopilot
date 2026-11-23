// Server-side deterministic successors let an authenticated refresh operation recover a lost response without plaintext token storage.
import { createHmac } from 'node:crypto';

/** A 192-bit secret operation identity persisted by the phone before its first request. @param {unknown} value */
export const validRefreshOperation = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{32}$/.test(value);

/** Domain and device binding prevent a retry from selecting another credential chain; only its hash is stored. @param {string} token @param {string} deviceId @param {string} operation */
export function refreshSuccessor(token, deviceId, operation) {
  return `mprt_${createHmac('sha256', token)
    .update(JSON.stringify(['mopilot-refresh-operation-v1', deviceId, operation]))
    .digest('base64url')}`;
}
