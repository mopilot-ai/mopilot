// Connect Codex adapter lifecycle events to the shared plugin mirror without starting the adapter itself.
const { codexPluginMirror, builtinReady } = require('./service.cjs');
const { noteIgnored } = require('../ignored.cjs');

function syncCodexPlugins() {
  // MoPilot's own plugin is in the store first, so Codex gets it on this sync
  builtinReady()
    .then(() => codexPluginMirror().sync())
    .catch((error) => noteIgnored('give Codex the plugin store', error));
}

function codexPluginCallbacks(broadcastAll, capsChanged) {
  return {
    onStatus: (status) => {
      broadcastAll('codex:status', status);
      capsChanged();
      if (status?.kind === 'ready') syncCodexPlugins();
    },
    onFirstStart: () => {
      broadcastAll('codex:status', { kind: 'started' });
      syncCodexPlugins();
    },
  };
}

function attachCodexPluginMirror(codex) {
  codexPluginMirror().attach({
    request: (method, params) => codex.request(method, params),
    connected: () => !!codex.readyAt && !codex.down,
  });
}

module.exports = { codexPluginCallbacks, attachCodexPluginMirror };
