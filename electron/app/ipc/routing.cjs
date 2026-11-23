// IPC for routed chats' settings (plan Part B, electron/routing), and the model router they run through: the provider catalog with which providers have a key, the named model configs (list, save, remove), and a provider's key (set, clear, has). A key goes in and never comes back: a window sees whether one is kept and its last four characters when it is set. Every change, here or by Host key lending, tells each window `routing:changed`. The one router per app starts here, over the same stores, and Claude Code's "Your own provider" mode is given its base and token (harness/claude/auth.cjs).
const path = require('node:path');
const { noteIgnored } = require('../../ignored.cjs');
const { createConfigs, CONFIGS_FILE } = require('../../routing/configs.cjs');
const { createProviderKeys, KEYS_FILE } = require('../../routing/providerKeys.cjs');
const { createRouter } = require('../../routing/router.cjs');
const { listLlmProviders, keySlotFor } = require('../../../shared/llmProviders.mjs');

/** The key slots of the catalog's named providers, and the prefixes of a server the user names (its key is kept as `<slot>:<origin>`). */
const ROUTED = new Set(listLlmProviders().flatMap((p) => (p.customBase ? [] : [p.keySlot])));
const ROUTED_PREFIXES = listLlmProviders().flatMap((p) => (p.customBase ? [`${p.keySlot}:`] : []));
/** @param {string} slot */
const routedSlot = (slot) => ROUTED.has(slot) || ROUTED_PREFIXES.some((prefix) => slot.startsWith(prefix));
/** The refusals the stores give the window as they are, which are no fault to record. */
const OWN = new Set(['invalid', 'unreadable', 'unavailable', 'write_failed']);

/**
 * @typedef {{ configOf: (id: string) => import('../../routing/configs.cjs').ModelConfig | null, baseFor: (id: string) => string | null,
 *   token: string, onChange: (fn: () => void) => void }} Routing what Claude Code's routed mode reads (harness/claude/state.cjs)
 */

/**
 * @param {import('electron').IpcMain} ipcMain
 * @param {{ app: { getPath(name: string): string, on?: (event: string, fn: () => void) => unknown }, broadcastAll: (channel: string, payload?: unknown) => void,
 *   claude?: { setRouting?: (routing: Routing) => void } }} deps
 * @param {{ safeStorage?: import('../../routing/providerKeys.cjs').SafeStorage, router?: Partial<Parameters<typeof createRouter>[0]> }} [o] for tests;
 *   safeStorage encrypts the keys (default Electron's), router: the router's own deps
 */
function register(ipcMain, deps, { safeStorage, router: routerDeps } = {}) {
  const changed = () => {
    try {
      deps.broadcastAll('routing:changed');
    } catch (e) {
      noteIgnored('tell the windows the model configs changed', e);
    }
  };
  /** @type {import('../../routing/configs.cjs').ModelConfigs | null} */
  let configStore = null;
  /** @type {import('../../routing/providerKeys.cjs').ProviderKeys | null} */
  let keyStore = null;
  const configs = () => {
    if (configStore) return configStore;
    configStore = createConfigs({ file: path.join(deps.app.getPath('userData'), CONFIGS_FILE) });
    configStore.onChange(changed);
    return configStore;
  };
  const keys = () => {
    if (keyStore) return keyStore;
    keyStore = createProviderKeys({
      file: path.join(deps.app.getPath('userData'), KEYS_FILE),
      safeStorage: safeStorage ?? require('electron').safeStorage,
    });
    // a key only a Host takes (xai) changes nothing here
    keyStore.onChange((slots) => void (slots.some(routedSlot) && changed()));
    return keyStore;
  };
  // the stores are opened at the router's first request, as at the windows' first call
  const router = createRouter({
    ...routerDeps,
    configs: { get: (id) => configs().get(id) },
    keys: { get: (slot) => keys().get(slot) },
  });
  if (deps.claude?.setRouting) {
    deps.claude.setRouting({
      configOf: (id) => configs().get(id),
      baseFor: router.baseFor,
      token: router.token,
      onChange: (fn) => configs().onChange(fn),
    });
    router.start().catch((error) => noteIgnored("start MoPilot's model router", error));
    deps.app.on?.('will-quit', () => router.stop());
  }
  /** The slot of `provider`'s key (at `baseUrl` for a server the user names), or a refusal. @param {unknown} provider @param {unknown} baseUrl */
  const slotOf = (provider, baseUrl) => {
    const slot = keySlotFor(provider, baseUrl);
    if (!slot) throw Object.assign(new Error('Choose a provider, and enter its URL for your own server.'), { code: 'invalid' });
    return slot;
  };
  // errors come back as values, so the window sees the message and its code (the bridge's call() rethrows them)
  const handle = (/** @type {string} */ channel, /** @type {(...args: any[]) => unknown} */ fn) =>
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return { value: await fn(...args) };
      } catch (err) {
        const e = /** @type {any} */ (err);
        if (!OWN.has(e?.code)) noteIgnored(`run ${channel}`, e);
        return { error: { message: String(e?.message ?? 'Something went wrong.'), ...(e?.code ? { code: e.code } : {}) } };
      }
    });
  handle('routing:providers', () => {
    const store = keys();
    return {
      // a server the user names keeps a key per URL: whether it has one is asked with its URL (routing:hasKey)
      providers: listLlmProviders().map((p) => ({ ...p, hasKey: p.customBase ? null : store.has(p.keySlot) })),
      keys: store.readable() ? 'ok' : 'unreadable',
    };
  });
  handle('routing:configs', () => configs().list());
  handle('routing:saveConfig', (config) => configs().save(config));
  handle('routing:removeConfig', (id) => configs().remove(id));
  handle('routing:hasKey', (provider, baseUrl) => keys().has(slotOf(provider, baseUrl)));
  handle('routing:setKey', (provider, key, baseUrl) => keys().set(slotOf(provider, baseUrl), key));
  handle('routing:clearKey', (provider, baseUrl) => keys().remove(slotOf(provider, baseUrl)));
  return { router };
}

module.exports = { register };
