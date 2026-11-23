// The plugin store as main runs it: one PluginStore and its Marketplaces over ~/.mopilot/plugins, shared by the
// Plugins page's IPC (electron/app/ipc/plugins.cjs) and every harness's delivery, so they see the same installs.
const os = require('node:os');
const path = require('node:path');
const { PluginStore } = require('./store.cjs');
const { Marketplaces } = require('./marketplaces.cjs');
const { PluginDelivery } = require('./delivery.cjs');
const { CodexPluginMirror } = require('./codexMirror.cjs');
const { createBuiltinConnectors } = require('../platform/builtinConnectors.cjs');
const { seedBuiltin } = require('./builtin.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { isEnabled } = require('../platform/flags.cjs');

/**
 * @param {object} o
 * @param {() => string} [o.dir] ~/.mopilot/plugins
 * @param {string} [o.home]
 * @param {ConstructorParameters<typeof Marketplaces>[0]['git']} [o.git]
 */
function createPluginService(o = {}) {
  const home = o.home ?? os.homedir();
  const dir = o.dir ?? (() => path.join(home, '.mopilot', 'plugins'));
  /** @type {Set<(e: {ids?: string[], marketplaces?: boolean}) => void>} */
  const listeners = new Set();
  const onChange = (e) => {
    for (const l of listeners) l(e);
  };
  const store = new PluginStore({ dir, onChange: (ids) => onChange({ ids }) });
  const marketplaces = new Marketplaces({ dir, home, git: o.git, onChange: () => onChange({ marketplaces: true }) });

  /** Fetch a marketplace entry, run `use` on its folder, and always let the fetched copy go. */
  async function withEntry(marketplace, name, use) {
    const fetched = await marketplaces.fetchPlugin(marketplace, name);
    try {
      return await use(fetched.dir);
    } finally {
      await fetched.done();
    }
  }

  /** @type {ReturnType<typeof createBuiltinConnectors> | null} */
  let builtin = null;
  return {
    store,
    marketplaces,
    /** The optional built-in connectors (GitHub) over this store. */
    builtinConnectors: () => (builtin ??= createBuiltinConnectors({ store })),
    /** Hear every change to installs and marketplaces; returns the unsubscribe. */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    /** What installing a marketplace's plugin would bring and run, with the digest install() must be given. */
    preview: (marketplace, name) => withEntry(marketplace, name, (dir) => store.preview(dir)),
    /** Install a marketplace's plugin the user reviewed: refused if what it runs is no longer what they saw. */
    install: (marketplace, name, trust) =>
      withEntry(marketplace, name, (dir) => store.install(dir, { marketplace, trust, origin: 'marketplace' })),
  };
}

/** @type {ReturnType<typeof createPluginService> | null} */
let shared = null;
/** The one service main runs, over the user's ~/.mopilot/plugins. */
const pluginService = () => (shared ??= createPluginService());

/** @type {InstanceType<typeof PluginDelivery> | null} */
let delivery = null;
/** @type {Promise<void> | null} */
let seeded = null;
/**
 * MoPilot's own plugin in the store (electron/plugins/builtin.cjs), once per run. It never rejects: a failure
 * is noted and never stops a session or a sync, and is not repeated until the next run (a retry on every session
 * start would install the plugin again each time).
 */
function builtinReady() {
  seeded ??= seedBuiltin(pluginService().store).then(
    () => undefined,
    (error) => noteIgnored("give the plugin store MoPilot's own plugin", error),
  );
  return seeded;
}

/** What every harness's sessions get from that store, each family behind its remote switch (plugins.<family>). */
const pluginDelivery = () =>
  (delivery ??= new PluginDelivery({ store: pluginService().store, enabled: (f) => isEnabled(`plugins.${f}`), ready: builtinReady }));

/** @type {InstanceType<typeof CodexPluginMirror> | null} */
let mirror = null;
/**
 * The store mirrored into Codex (electron/plugins/codexMirror.cjs), behind plugins.codex. It syncs whenever the
 * store's installs change; main attaches the Codex adapter and syncs again whenever Codex comes up.
 */
function codexPluginMirror() {
  if (mirror) return mirror;
  // a plugin Codex failed to install keeps its skills through plugin_skills there
  pluginDelivery().reportFailures(
    'codex',
    () =>
      new Set(
        Object.entries(m.states)
          .filter(([, st]) => st.state === 'failed')
          .map(([id]) => id),
      ),
  );
  const m = new CodexPluginMirror({
    store: pluginService().store,
    enabled: () => isEnabled('plugins.codex'),
    log: (line) => console.warn(line),
  });
  pluginService().subscribe((e) => {
    // a sync that fails leaves Codex as it was; the next change or Codex start tries again
    if (e.ids) m.sync().catch((error) => noteIgnored('give Codex the plugin store', error));
  });
  mirror = m;
  return m;
}

module.exports = { createPluginService, pluginService, pluginDelivery, codexPluginMirror, builtinReady };
