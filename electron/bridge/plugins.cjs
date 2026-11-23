// window.native.plugins: MoPilot's own plugin store, installed once for every harness (electron/app/ipc/plugins.cjs).
const { call, on } = require('./spec.cjs');

module.exports = {
  list: call('plugins:list'),
  catalog: call('plugins:catalog'),
  preview: call('plugins:preview'),
  install: call('plugins:install'),
  uninstall: call('plugins:uninstall'),
  setEnabled: call('plugins:setEnabled'),
  marketplaceAdd: call('plugins:marketplaceAdd'),
  marketplaceUpgrade: call('plugins:marketplaceUpgrade'),
  marketplaceRemove: call('plugins:marketplaceRemove'),
  skillsFor: call('plugins:skillsFor'),
  native: call('plugins:native'),
  previewNative: call('plugins:previewNative'),
  importNative: call('plugins:importNative'),
  codexStates: call('plugins:codexStates'),
  // the optional built-in connectors (GitHub), turned on or off from Settings
  builtin: { list: call('plugins:builtinList'), set: call('plugins:builtinSet') },
  onChanged: on('plugins:changed'),
};
