// Read versioned browser JSON stores without granting older writers ownership of unknown formats.
const { readStoreFile } = require('../../platform/fsutil.cjs');
const { readCheckedStore } = require('../../platform/checkedStore.cjs');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');
const supported = (data) => !Object.hasOwn(data, 'version') || data.version === 1;

/** Missing files are writable; unreadable known formats are preserved, unknown declarations are read-only. */
function readOwnedJsonStore(file, what, valid, retainRejected = false) {
  const read = retainRejected ? readCheckedStore : readStoreFile;
  const result = read(file, what, (data) => isJsonRecord(data) && (!supported(data) || valid(data)));
  let formatError = /** @type {Error | null} */ (null);
  if (result.data && !supported(result.data)) {
    const newer = Number.isSafeInteger(result.data.version) && result.data.version > 1;
    formatError = new Error(
      newer
        ? `The saved ${what} came from a newer version of MoPilot. Update MoPilot before editing it.`
        : `The saved ${what} has an unsupported version. Restore it and restart MoPilot before editing it.`,
    );
  }
  return { ...result, formatError };
}
module.exports = { readOwnedJsonStore };
