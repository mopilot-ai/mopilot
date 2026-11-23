// Keep readable saved entries for display while retaining a validation failure that forbids replacing their full store.
const { readStoreFile } = require('./fsutil.cjs');

/** @param {string} file @param {string} what @param {((value: any) => boolean) | null} valid */
function readCheckedStore(file, what, valid = null) {
  let parsed = null;
  const result = readStoreFile(
    file,
    what,
    valid
      ? (value) => {
          parsed = value;
          return valid(value);
        }
      : null,
  );
  return { data: result.error ? parsed : result.data, error: result.error };
}
module.exports = { readCheckedStore };
