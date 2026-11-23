// Collection validation and account-folder boundaries shared by both saved account registries.
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');
const path = require('node:path');

const isAccountId = (id) => typeof id === 'string' && id.length > 0 && id !== '.' && id !== '..' && !/[\\/]/.test(id);

/** Only a single account name can be joined to the registry's folder, including for unsaved callers. */
function accountFolder(root, id) {
  if (!isAccountId(id)) throw new Error('Invalid account id');
  return path.join(root, id);
}

/**
 * A config folder an account record names: absolute and normalized, named after the account and inside a
 * claude-accounts folder, else null. Removing the account deletes it, so nothing else may pass.
 */
function accountConfigDir(dir, id) {
  if (!isAccountId(id) || typeof dir !== 'string' || !path.isAbsolute(dir) || path.normalize(dir) !== dir) return null;
  return path.basename(dir) === id && path.basename(path.dirname(dir)) === 'claude-accounts' ? dir : null;
}

function isAccountState(state) {
  return (
    isJsonRecord(state) &&
    (state.accounts === undefined ||
      (Array.isArray(state.accounts) && state.accounts.every((entry) => isJsonRecord(entry) && isAccountId(entry.id))))
  );
}

module.exports = { isAccountState, accountFolder, accountConfigDir };
