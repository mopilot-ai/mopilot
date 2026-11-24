// IPC for the performance probe: a window's batched samples (src/session/perf.ts) go to main's probe file (electron/perf/probe.cjs).
const { recordWindowSamples } = require('../../perf/probe.cjs');
const { recordRenderer, forgetRendererWindow } = require('../../perf/rendererLog.cjs');

/**
 * @param {import('electron').IpcMain} ipcMain
 */
function register(ipcMain) {
  ipcMain.on('perf:samples', (e, batch) => recordWindowSamples(e.sender.id, batch));
  // always on, whatever shared.perf.probe says: content-free lines about what a window could not do in time (electron/perf/rendererLog.cjs)
  // a window's count of lines this minute is dropped when it closes
  const watched = new Set();
  ipcMain.on('perf:record', (e, line) => {
    const id = e.sender.id;
    if (!watched.has(id)) {
      watched.add(id);
      e.sender.once('destroyed', () => {
        watched.delete(id);
        forgetRendererWindow(id);
      });
    }
    recordRenderer(id, line);
  });
}

module.exports = { register };
