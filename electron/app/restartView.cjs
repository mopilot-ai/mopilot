// The chat the main window showed when the app restarted to update, and how that window was, which the new version opens the same way (as Claude Desktop does).
const { fs } = require('../platform/ports/fs.cjs');
const path = require('path');
const { readJsonRecord, writeAtomic } = require('../platform/fsutil.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { threadHash } = require('../../shared/deepLink.mjs');

const FILE = 'restart-view.json';
/** A marker older than this is from a restart that never happened: a later ordinary launch opens as usual. */
const MAX_AGE_MS = 10 * 60_000;

/**
 * Records the chat to reopen; nothing when the window shows none and no window state is given. A restart nobody asked
 * for (stealthUpdate.cjs) also records how the main window was, so the new version comes back the same way.
 * @param {string} dir
 * @param {string | undefined} chatId
 * @param {number} [now]
 * @param {{ visible: boolean, minimized: boolean }} [window]
 */
function saveRestartView(dir, chatId, now = Date.now(), window = undefined) {
  if (!chatId && !window) return;
  try {
    writeAtomic(path.join(dir, FILE), JSON.stringify({ chatId, ts: now, window }));
  } catch (error) {
    noteIgnored('save the chat to reopen after the update', error);
  }
}

/** A restart that did not happen (it failed, or was refused): the next launch opens as usual. */
function clearRestartView(dir) {
  try {
    fs.rmSync(path.join(dir, FILE), { force: true });
  } catch (error) {
    noteIgnored('remove the chat to reopen after the update', error);
  }
}

/**
 * How the first main window opens after a restart to update, once: the marker is removed as it is read. `hash` opens
 * it on the chat it showed; `window` (a restart nobody asked for) is how it was: shown without focus, minimized, or
 * left hidden.
 * @returns {{ hash?: string, window?: { visible: boolean, minimized: boolean } }}
 */
function takeRestartView(dir, now = Date.now()) {
  const v = readJsonRecord(path.join(dir, FILE));
  if (!v) return {};
  clearRestartView(dir);
  const age = now - v.ts;
  if (!(age >= 0 && age < MAX_AGE_MS)) return {};
  const w = v.window;
  return {
    hash: typeof v.chatId === 'string' && v.chatId ? threadHash(v.chatId) : undefined,
    window: w && typeof w === 'object' ? { visible: w.visible === true, minimized: w.minimized === true } : undefined,
  };
}

module.exports = { saveRestartView, clearRestartView, takeRestartView, MAX_AGE_MS };
