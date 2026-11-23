// Atomic per-action shortcut preference edits; broadcast only after a validated change (held in memory, written behind: platform/uiStateFile.cjs).
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { SHORTCUT_ACTIONS, bindingConflict } = require('../../shared/shortcuts.mjs');

function registerShortcutPrefs(ipcMain, { file, broadcast, onPrefs, ui }) {
  ipcMain.handle('prefs:recording', (event, on) => {
    if (typeof on !== 'boolean') return false;
    event.sender.setIgnoreMenuShortcuts(on);
    return true;
  });
  ipcMain.handle('prefs:binding', (_event, id, key) => {
    if (!SHORTCUT_ACTIONS.some((a) => a.id === id) || !(key === undefined || key === null || (typeof key === 'string' && key.length > 0)))
      return false;
    const state = ui.inspect(file);
    if (
      !isJsonRecord(state) ||
      (typeof state.stateVersion === 'number' && state.stateVersion > 2) ||
      (state.prefs !== undefined && !isJsonRecord(state.prefs))
    )
      return false;
    const prefs = state.prefs ?? {};
    if (prefs.keybindings !== undefined && !isJsonRecord(prefs.keybindings)) return false;
    if (Object.values(prefs.keybindings ?? {}).some((value) => value !== null && typeof value !== 'string')) return false;
    const bindings = /** @type {import('../../shared/shortcuts.mjs').Keybindings} */ ({ ...prefs.keybindings });
    if (typeof key === 'string' && bindingConflict(id, key, bindings, process.platform)) return false;
    if (key === undefined) delete bindings[id];
    else Object.defineProperty(bindings, id, { value: key, enumerable: true, configurable: true, writable: true });
    const next = { ...prefs, keybindings: bindings };
    ui.update(file, (s) => ({ ...s, prefs: next }));
    broadcast('prefs:changed', null, { set: {}, unset: [], binding: { id, ...(key === undefined ? {} : { key }) } });
    onPrefs(next);
    return true;
  });
}
module.exports = { registerShortcutPrefs };
