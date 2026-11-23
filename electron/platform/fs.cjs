// Text files the renderer edits (user-level instruction files), written by main so no harness is needed. @host-portable: loads in the Host process without Electron (host/boundary.json).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { writeTextAtomic } = require('./writeTextAtomic.cjs');
const { sharedRoot } = require('./claudeHome.cjs');
const shellEnv = require('./env.cjs');
const { isDirectory } = require('./directoryReads.cjs');
const { userError } = require('../../shared/userError.mjs');

/** Write an absolute path atomically, making its folder; a symlink (dotfiles) is written through, not replaced. */
function writeText(p, text) {
  if (typeof p !== 'string' || !path.isAbsolute(p) || typeof text !== 'string') return { ok: false, error: 'invalid path' };
  try {
    writeTextAtomic(p, text);
    return { ok: true };
  } catch (err) {
    // "Permission denied.", not the errno text with the file's path
    return { ok: false, error: userError(err) };
  }
}

/** Where the first-tier harnesses keep their user-level config: $CODEX_HOME and the Claude CLI's folder. */
function configRoots(env = shellEnv.childEnv(), home = os.homedir()) {
  return { home, codexHome: env.CODEX_HOME || path.join(home, '.codex'), claudeRoot: sharedRoot() };
}

/** A folder's entries, for the file tree and the automations list; [] when it can't be read. */
async function readDir(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return [];
  try {
    const entries = await fs.promises.readdir(p, { withFileTypes: true });
    return await Promise.all(
      entries.map(async (e) => ({
        fileName: e.name,
        isDirectory: e.isDirectory() || (e.isSymbolicLink() && (await isDirLink(path.join(p, e.name)))),
      })),
    );
  } catch {
    return [];
  }
}

async function isDirLink(p) {
  try {
    return await isDirectory(p);
  } catch {
    return false;
  }
}

/** Remove a file or folder tree; a missing path is fine. */
function removePath(p) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return { ok: false, error: 'invalid path' };
  const resolved = path.resolve(p);
  if (resolved === path.parse(resolved).root) return { ok: false, error: 'invalid path' };
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return { ok: true };
  } catch (err) {
    // "Permission denied.", not the errno text with the file's path
    return { ok: false, error: userError(err) };
  }
}

function register(ipcMain) {
  ipcMain.handle('fs:readDir', (_e, p) => readDir(p));
  ipcMain.handle('fs:remove', (_e, p) => removePath(p));
  ipcMain.handle('fs:writeText', (_e, p, text) => writeText(p, text));
  ipcMain.handle('fs:configRoots', () => configRoots());
}

module.exports = { register, writeText, configRoots, readDir, removePath };
