// The model API keys the user gave the app for their machines (#3361 Tier 1): the Host's view of the shared provider key store (electron/routing/providerKeys.cjs), one key per provider of shared/host/credentials.mjs, read only to lend a key to a Host per dispatch (remoteCredentials.cjs) and shown only as its last four characters.
const { createProviderKeys } = require('../routing/providerKeys.cjs');
const { PROVIDERS, keyHint } = require('../../shared/host/credentials.mjs');

/** A refusal the window shows as it is. @param {string} message @param {string} code */
const refusal = (message, code) => Object.assign(new Error(message), { code });

/**
 * @param {{ file: string, safeStorage: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string } }} o
 */
function createApiKeys({ file, safeStorage }) {
  const store = createProviderKeys({ file, safeStorage });
  /** @param {unknown} provider @returns {provider is string} */
  const lent = (provider) => typeof provider === 'string' && Object.hasOwn(PROVIDERS, provider);
  /** The key of `provider`, decrypted; null when none is kept or it cannot be decrypted (another Mac's file). @param {string} provider */
  const get = (provider) => (lent(provider) ? store.get(provider) : null);
  /** The provider whose key `harness` takes, if any. @param {string} harness */
  const providerOf = (harness) => Object.entries(PROVIDERS).find(([, h]) => h === harness)?.[0] ?? null;
  return {
    get,
    /** Whether the user gave a key `harness` takes, without decrypting it. @param {string} harness */
    hasFor: (harness) => {
      const provider = providerOf(harness);
      return !!provider && store.has(provider);
    },
    /** The key a harness's process takes, if the user gave one: by the harness that uses it. @param {string} harness */
    forHarness: (harness) => {
      const provider = providerOf(harness);
      return provider ? get(provider) : null;
    },
    /** Which providers have a key, each shown as its last four characters only. @returns {Record<string, string>} */
    list() {
      /** @type {Record<string, string>} */
      const out = {};
      for (const provider of Object.keys(PROVIDERS)) {
        const key = get(provider);
        if (key) out[provider] = keyHint(key);
      }
      return out;
    },
    /**
     * Keep `key` for `provider`, encrypted (the store writes only what safeStorage encrypted); a refusal never repeats the key.
     * @param {unknown} provider @param {unknown} key
     */
    set(provider, key) {
      if (!lent(provider)) throw refusal('That provider takes no key here.', 'invalid');
      return store.set(provider, key);
    },
    /** Forget the key of `provider`; false when none was kept. @param {unknown} provider */
    remove: (provider) => lent(provider) && store.remove(provider),
    /** Forget every key a Host could be lent, in one write; a file that can't be read lends none and is left as it is. */
    removeAll: () => (store.readable() ? store.removeAll(Object.keys(PROVIDERS)) : []),
    /** Told when a key a Host may be lent is added or removed, here or by a routed chat's settings (one file, one set of listeners). @param {() => void} fn */
    onChange: (fn) => store.onChange((slots) => void (slots.some(lent) && fn())),
  };
}

module.exports = { createApiKeys };
