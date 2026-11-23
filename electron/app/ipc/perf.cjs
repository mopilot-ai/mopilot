// IPC for the performance probe: a window's batched samples (src/session/perf.ts) go to main's probe file (electron/perf/probe.cjs).
const { recordWindowSamples } = require('../../perf/probe.cjs');

/**
 * @param {import('electron').IpcMain} ipcMain
 */
function register(ipcMain) {
  ipcMain.on('perf:samples', (e, batch) => recordWindowSamples(e.sender.id, batch));
}

module.exports = { register };
