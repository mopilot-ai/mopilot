// The folders a chat may hand to the user or work in from its host tools (open_in_editor, reveal_path, worktree tools): its
// working directory plus the folders the user granted it (request_directory), and a path check that holds across links.
const os = require('node:os');
const path = require('node:path');
const { fs } = require('../../platform/ports/fs.cjs');
const { ToolError } = require('../contract/registry.cjs');
const { lexicalInside, realPathAsync } = require('../../platform/pathInside.cjs');

/** Invisible, look-alike and control characters: a path the approval card could not show unambiguously. */
const UNSAFE = /[\p{Cc}\p{Cf}⠀￼]|[^\S ]/u;
const MAX_PATH = 4096;

const OUTSIDE =
  "That path is not a file or folder inside this session's folders (working directory, worktree, or folders granted with request_directory), or it doesn't exist. Check the path; for a folder outside the session, ask for access with request_directory first.";
const INVISIBLE =
  "That path contains a character the approval card can't show unambiguously (an invisible, zero-width, or look-alike space or control character), so it can't be used from here. Tell the user the path instead.";

/** `p` with a leading ~ read as the home folder. */
const expandHome = (/** @type {string} */ p, home = os.homedir()) =>
  p === '~' ? home : /^~[\\/]/.test(p) ? path.join(home, p.slice(2)) : p;

/**
 * @param {object} o
 * @param {(chatId: string) => Promise<string | null>} o.projectOf the chat's working directory
 * @param {(chatId: string) => string[]} o.extraOf the folders granted to the chat
 * @param {string} [o.home]
 */
function createSessionFolders({ projectOf, extraOf, home = os.homedir() }) {
  /** The chat's folders as written: its working directory first. */
  const folders = async (/** @type {string} */ chatId) => {
    const cwd = await projectOf(chatId);
    return [...(cwd ? [cwd] : []), ...extraOf(chatId)].filter((f) => typeof f === 'string' && path.isAbsolute(f));
  };
  /**
   * The real path of `p` (absolute, ~, or relative to the working directory) when it exists inside one of the chat's folders.
   * @returns {Promise<{ path: string, isDirectory: boolean }>}
   */
  const resolve = async (/** @type {string} */ chatId, /** @type {unknown} */ p) => {
    if (typeof p !== 'string' || !p.trim() || p.length > MAX_PATH)
      throw new ToolError('`path` is required: a file or folder path.', 'invalid_args');
    if (UNSAFE.test(p)) throw new ToolError(INVISIBLE, 'invalid_args');
    const mine = await folders(chatId);
    const wanted = expandHome(p.trim(), home);
    if (!path.isAbsolute(wanted) && !mine.length)
      throw new ToolError('This session has no working directory: give an absolute path.', 'invalid_args');
    const full = path.isAbsolute(wanted) ? path.normalize(wanted) : path.resolve(mine[0], wanted);
    const real = await realPathAsync(full);
    if (!real) throw new ToolError(OUTSIDE, 'not_found');
    for (const folder of mine) {
      const realFolder = await realPathAsync(folder);
      if (realFolder && lexicalInside(realFolder, real)) return { path: real, isDirectory: (await fs.promises.stat(real)).isDirectory() };
    }
    throw new ToolError(OUTSIDE, 'not_found');
  };
  return { folders, resolve };
}

module.exports = { createSessionFolders, expandHome, OUTSIDE, UNSAFE };
