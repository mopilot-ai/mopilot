// Preferences IPC merges window edits and publishes main-owned acknowledgments in commit order.
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { noteIgnored } = require('../ignored.cjs');

const MAIN_OWNED_PREFS = ['momo', 'mobileRemoteOwner'];

/** @param {{ read: () => Record<string, any>, write: (set: Record<string, unknown>, unset: string[]) => Record<string, any> | null, broadcast: (channel: string, sender: any, payload: any) => void, onPrefs: (prefs: any) => void, runOnName?: (id: string) => string | undefined }} o */
function registerPrefs(ipcMain, o) {
  const { read, write, broadcast, onPrefs, runOnName } = o;
  function patch(set, unset, sender) {
    const prefs = write(set, unset);
    if (prefs) {
      broadcast('prefs:changed', sender, { set, unset });
      onPrefs(prefs);
    }
    return !!prefs;
  }

  ipcMain.handle('prefs:patch', (e, rawSet, rawUnset) => {
    const set = isJsonRecord(rawSet) ? rawSet : {};
    const unset = Array.isArray(rawUnset) ? rawUnset : [];
    if (unset.some((key) => typeof key !== 'string')) {
      noteIgnored('save a window’s prefs', new Error('Preference names must be strings; the patch was refused'));
      return false;
    }
    const owned = [...Object.keys(set), ...unset].filter((k) => MAIN_OWNED_PREFS.includes(k));
    if (owned.length) {
      noteIgnored('save a window’s prefs', new Error(`main owns ${owned.join(', ')}; the patch was refused`));
      return false;
    }
    if (!Object.hasOwn(set, 'lastNewChatHost')) {
      // The CLI selection switch waits for the saved preference via the same broadcast as every other window.
      const confirm = Object.hasOwn(set, 'preferHighestCli') || unset.includes('preferHighestCli');
      return patch(set, unset, confirm ? null : e.sender);
    }

    const { lastNewChatHost, ...other } = set;
    const id = isJsonRecord(lastNewChatHost) && typeof lastNewChatHost.id === 'string' ? lastNewChatHost.id : null;
    const name = id && runOnName?.(id);
    const chosen = name ? { id, name } : null;
    if (lastNewChatHost === null || chosen) {
      return patch(
        { ...other, lastNewChatHost: chosen },
        unset.filter((key) => key !== 'lastNewChatHost'),
        null,
      );
    }
    const remaining = unset.filter((key) => key !== 'lastNewChatHost');
    if (Object.keys(other).length || remaining.length) patch(other, remaining, e.sender);
    broadcast('prefs:changed', null, { set: { lastNewChatHost: read().prefs?.lastNewChatHost ?? null }, unset: [] });
    throw new Error('The selected machine is no longer available.');
  });
  return { patchPrefs: (/** @type {Record<string, unknown>} */ set) => patch(set, [], null) };
}

module.exports = { registerPrefs };
