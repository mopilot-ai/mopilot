// Give boolean-returning secret stores one failure boundary for the OS availability probe and encryption itself.
/**
 * @typedef {{ isEncryptionAvailable(): boolean, getSelectedStorageBackend?(): string }} EncryptionStatus
 */
/** An available Linux key must come from a desktop secret store, never Electron's built-in fallback password.
 * @param {EncryptionStatus | null | undefined} safe
 * @returns {safe is EncryptionStatus} */
function canEncrypt(safe) {
  try {
    return !!safe?.isEncryptionAvailable() && safe.getSelectedStorageBackend?.() !== 'basic_text';
  } catch {
    return false;
  }
}
/**
 * @param {(EncryptionStatus & { encryptString(value: string): Buffer }) | null} safe
 * @param {string} value
 * @returns {{ ok: true, value: string } | { ok: false }}
 */
function encryptForStore(safe, value) {
  try {
    if (!canEncrypt(safe)) return { ok: false };
    return { ok: true, value: safe.encryptString(value).toString('base64') };
  } catch {
    // The OS key may become unavailable after the probe. Callers report a failed save; never log a secret-bearing exception.
    return { ok: false };
  }
}
module.exports = { canEncrypt, encryptForStore };
