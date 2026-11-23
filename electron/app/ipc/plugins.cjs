// IPC for MoPilot's own plugin store (electron/plugins/service.cjs): installed plugins, marketplaces, the
// review before an install, plugins the harnesses installed themselves, and plugins:changed to every window.
const os = require('node:os');
const path = require('node:path');
const { pluginService, pluginDelivery, codexPluginMirror, builtinReady } = require('../../plugins/service.cjs');
const { nativePlugins } = require('../../plugins/native.cjs');

const text = (v) => String(v ?? '');
const family = (v) => (v === undefined || v === null ? undefined : String(v));

/**
 * @param {import('electron').IpcMain} _ipcMain
 * @param {Pick<import('../../main.cjs').IpcDeps, 'handle' | 'broadcastAll'> & { shellEnv?: { childEnv(): Record<string, string | undefined> } }} deps
 * @param {object} [o] tests pass their own
 * @param {ReturnType<typeof pluginService>} [o.service]
 * @param {Pick<ReturnType<typeof pluginDelivery>, 'skillsFor'>} [o.delivery]
 * @param {() => ReturnType<typeof nativePlugins>} [o.native] the plugins Claude Code and Codex installed themselves
 * @param {() => Record<string, object>} [o.codexStates] what the Codex mirror did with each plugin
 * @param {() => Promise<unknown>} [o.ready] settles once MoPilot's own plugin is in the store (else the one main seeds)
 */
function register(_ipcMain, deps, o = {}) {
  const { handle, broadcastAll } = deps;
  const service = o.service ?? pluginService();
  const delivery = o.delivery ?? pluginDelivery();
  const ready = o.ready ?? (o.service ? () => Promise.resolve() : builtinReady);
  const native =
    o.native ??
    (() =>
      nativePlugins({
        claudeDir: process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
        codexHome: deps.shellEnv?.childEnv().CODEX_HOME || path.join(os.homedir(), '.codex'),
      }));
  const codexStates = o.codexStates ?? (() => codexPluginMirror().states);
  /** A plugin a harness installed itself, by id: only those can be copied in from outside the store. */
  const nativeOne = (id) => {
    const found = native().find((p) => p.id === id);
    if (!found) throw new Error("That plugin isn't installed by a harness on this computer");
    return found;
  };
  service.subscribe((e) => broadcastAll('plugins:changed', e));
  handle('plugins:list', async () => {
    await ready();
    return service.store.list();
  });
  handle('plugins:catalog', () => service.marketplaces.catalog());
  handle('plugins:preview', (marketplace, name) => service.preview(text(marketplace), text(name)));
  handle('plugins:install', (marketplace, name, trust) => service.install(text(marketplace), text(name), text(trust)));
  handle('plugins:uninstall', (id) => service.store.uninstall(text(id)));
  handle('plugins:setEnabled', (id, enabled, f) => service.store.setEnabled(text(id), enabled === true, family(f)));
  handle('plugins:marketplaceAdd', (source) => service.marketplaces.add(text(source)));
  handle('plugins:marketplaceUpgrade', (name) => service.marketplaces.upgrade(text(name)));
  handle('plugins:marketplaceRemove', (name) => service.marketplaces.remove(text(name)));
  // the plugin skills and commands MoPilot provides to a harness family that doesn't load them (the / menu)
  handle('plugins:skillsFor', (f) => delivery.skillsFor(text(f)));
  // "Make available everywhere": a plugin one harness installed itself, reviewed, then copied into the store
  handle('plugins:native', () => native());
  handle('plugins:previewNative', (id) => service.store.preview(nativeOne(text(id)).path));
  handle('plugins:importNative', (id, trust) => {
    const p = nativeOne(text(id));
    return service.store.install(p.path, { marketplace: p.marketplace, trust: text(trust), origin: p.harness });
  });
  handle('plugins:codexStates', () => codexStates());
  // the optional built-in connectors (GitHub): the list, and the switch that installs or removes one
  handle('plugins:builtinList', () => service.builtinConnectors().list());
  handle('plugins:builtinSet', (id, on) => service.builtinConnectors().set(text(id), on === true));
}

module.exports = { register };
