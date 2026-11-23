// IPC for restoring a chat's files on rewind (electron/session/turnCheckpoints.cjs, kept with main's TurnChanges, which the Codex adapter holds): what a rewind would restore, the restore and its undo.
const path = require('node:path');

const id = (/** @type {unknown} */ v) => typeof v === 'string' && v.length > 0 && v.length <= 512;
const folder = (/** @type {unknown} */ v) => typeof v === 'string' && path.isAbsolute(v);
const paths = (/** @type {unknown} */ v) =>
  Array.isArray(v) && v.every((p) => typeof p === 'string' && p.length > 0 && !path.isAbsolute(p));
const INVALID = { ok: false, error: 'Invalid rewind request.' };
const NOT_READY = { ok: false, error: 'Checkpoints are not ready yet. Try again in a moment.' };

/** @param {import('electron').IpcMain} ipcMain @param {{ live: any }} deps */
function register(ipcMain, { live }) {
  // main's one TurnChanges, which the Codex adapter holds (app/sessions.cjs)
  const points = () => live?.codex?.turnChanges?.checkpoints ?? null;
  ipcMain.handle('checkpoints:plan', (_e, threadId, turnId, cwd) =>
    !id(threadId) || !id(turnId) || !folder(cwd) ? INVALID : (points()?.plan(threadId, turnId, cwd) ?? NOT_READY),
  );
  // the paths the user was shown: only those are restored
  ipcMain.handle('checkpoints:restore', (_e, threadId, turnId, cwd, files) =>
    !id(threadId) || !id(turnId) || !folder(cwd) || !paths(files)
      ? INVALID
      : (points()?.restore(threadId, turnId, cwd, files) ?? NOT_READY),
  );
  ipcMain.handle('checkpoints:undo', (_e, threadId, cwd, undo) =>
    !id(threadId) || !folder(cwd) || !id(undo) ? INVALID : (points()?.undo(threadId, cwd, undo) ?? NOT_READY),
  );
}

module.exports = { register };
