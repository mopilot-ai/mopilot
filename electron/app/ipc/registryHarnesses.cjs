// Explicit ACP registry discovery and installation requests; windows supply agent ids, never executable metadata.
const { runsFor } = require('./harnessRuns.cjs');
const { registryPackageRun } = require('../../harness/registry/packageRun.cjs');

/** @param {import('electron').IpcMain} ipcMain @param {import('../../main.cjs').IpcDeps} deps */
function register(ipcMain, { live }) {
  const service = () => {
    const registry = live.acpAdmission.registry;
    if (!registry) throw new Error('The ACP registry is not ready yet.');
    return registry;
  };
  ipcMain.handle('acp:registryList', (_event, force) => service().list({ force: force === true }));
  ipcMain.handle('acp:registryInstall', (_event, id) => {
    if (typeof id !== 'string') throw new Error('Choose an agent from the current ACP registry.');
    return service().install(id, (spec) => registryPackageRun(runsFor(ipcMain), id, spec));
  });
  ipcMain.handle('acp:registryRepair', (_event, id) => {
    if (typeof id !== 'string') throw new Error('Choose an installed ACP registry agent.');
    return service().install(id, (spec) => registryPackageRun(runsFor(ipcMain), id, spec), { repair: true });
  });
}

module.exports = { register };
