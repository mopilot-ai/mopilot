// IPC for Settings → Mobile Remote's always-on switches: read the state, move a switch (main owns the state; windows follow alwaysOn:changed).
function register(ipcMain, { live }) {
  ipcMain.handle('alwaysOn:get', () => live.alwaysOn?.get() ?? null);
  ipcMain.handle('alwaysOn:set', (_e, patch) => {
    if (!live.alwaysOn) throw new Error('Always-on is not ready yet');
    try {
      return live.alwaysOn.set(patch);
    } catch (error) {
      throw new Error(`Couldn't save the setting: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

module.exports = { register };
