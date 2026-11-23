// IPC for harness routes (electron/harness/routes.cjs): whether each harness's own config sends it to a gateway or another endpoint, its processes that started before that changed, revealing the config file, and Restart to apply; it also starts the harness processes' idle and memory-pressure recycling (codexRecycle.cjs, harness/claude/governor.cjs).
const { createRoutes } = require('../../harness/routes.cjs');
const { routeProcessesFor, codexChatsBusy } = require('../../harness/routeProcesses.cjs');
const { codexRecycler } = require('../../harness/codexRecycle.cjs');
const { systemPressure } = require('../../platform/memoryPressure.cjs');
const { codexBackground } = require('../../platform/exitGate.cjs');

function register(ipcMain, deps) {
  const { app, live, server, claude, shellEnv, broadcastAll, shell } = deps;
  // an idle app-server lets go of the threads (and their MCP servers) it keeps loaded after their last unsubscribe
  const serverOf = () => server;
  const codexOf = () => live.codex;
  const sessionsOf = () => live.sessions;
  const controllerOf = () => live.controller;
  const recycler = codexRecycler({
    server: serverOf,
    codex: codexOf,
    chatsBusy: codexChatsBusy({ sessions: sessionsOf, controller: controllerOf }),
  });
  recycler.start();
  // under memory pressure (#1830) Codex does not wait the full quiet period, and idle Claude Code CLIs end
  const pressure = deps.pressure ?? systemPressure();
  const unwatch = [pressure.subscribe(recycler.onPressure), claude.governor.watch(pressure)];
  // a quit the exit gate holds can still be called off, so the recycler stops only once the app really quits
  app.on('will-quit', () => {
    recycler.stop();
    for (const fn of unwatch) fn();
  });
  const routes = createRoutes({
    env: () => shellEnv.childEnv(),
    processes: routeProcessesFor({
      server: serverOf,
      codex: codexOf,
      accounts: () => live.accounts,
      acpHost: () => live.acpHost,
      claude: claude.routeProcesses,
      background: codexBackground,
      sessions: sessionsOf,
      controller: controllerOf,
    }),
    onChange: (list) => broadcastAll('routes:changed', list),
  });
  void routes.refreshAll();
  ipcMain.handle('routes:list', () => routes.list());
  // a window came to the front: files a watcher missed are read again
  ipcMain.handle('routes:refresh', async () => {
    await routes.refreshAll();
    return routes.list();
  });
  // the path is main's own (the route's source file), never one the window names
  ipcMain.handle('routes:reveal', (_e, kind) => {
    const file = routes.get(String(kind))?.file;
    if (!file) return false;
    shell.showItemInFolder(file);
    return true;
  });
  ipcMain.handle('routes:restartIdle', (_e, kind) => routes.restartIdle(String(kind)));
  return routes;
}

module.exports = { register };
