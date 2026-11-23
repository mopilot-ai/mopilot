// IPC for the user's model keys lent to their machines (#3361 Tier 1), registered by ipc/host.cjs (`registeredBy`): the Host's view of the provider key store it shares with routed chats (electron/host/apiKeys.cjs), made on first use, and its list, set and remove channels. Any write to that store, from either settings page, sends the machines again.
const path = require('node:path');
const { createApiKeys } = require('../../host/apiKeys.cjs');
const { KEYS_FILE } = require('../../routing/providerKeys.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/**
 * The Host's key store, made on first use; `changed` is told after every write to the shared file of a key a Host may be lent.
 * @param {{ userData: () => string, safeStorage?: any, changed: () => void }} o safeStorage: encrypts the keys (default Electron's)
 */
function hostKeyStore({ userData, safeStorage, changed }) {
  /** @type {ReturnType<typeof createApiKeys> | null} */
  let store = null;
  let quiet = 0;
  const keys = () => {
    if (store) return store;
    store = createApiKeys({ file: path.join(userData(), KEYS_FILE), safeStorage: safeStorage ?? require('electron').safeStorage });
    // a write by a routed chat's settings is no fault of its own when the machines can't be sent
    store.onChange(() => {
      if (quiet) return;
      try {
        changed();
      } catch (e) {
        noteIgnored('send the machines again after a key changed', e);
      }
    });
    return store;
  };
  /** Run `fn` without telling the windows of its writes: a caller that tells them itself once it is done (sign out everywhere). @template T @param {() => T} fn @returns {T} */
  keys.quietly = (fn) => {
    quiet++;
    try {
      return fn();
    } finally {
      quiet--;
    }
  };
  return keys;
}

/**
 * The channels; each write tells the windows through the store's listener (hostKeyStore).
 * @param {{ handle: (channel: string, fn: (...args: any[]) => unknown) => void, keys: ReturnType<typeof hostKeyStore> }} o
 *   handle: the Host IPC's own handler (gate, error shape)
 */
function registerHostApiKeys({ handle, keys }) {
  handle('host:apiKeys', () => keys().list());
  handle('host:setApiKey', (provider, key) => keys().set(provider, key));
  handle('host:removeApiKey', (provider) => keys().remove(provider));
}

module.exports = { hostKeyStore, registerHostApiKeys, registeredBy: 'host' };
