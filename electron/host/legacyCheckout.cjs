// Finds shared checkout folders through the directory and file reads available on older Hosts.
const { posix, win32 } = require('node:path');
const { foldHostWorktreePath, isWinPath } = require('../../shared/paths.mjs');
const { noteIgnored } = require('../ignored.cjs');

/** @param {string} cwd @param {string} top @param {(path: string) => Promise<string | undefined>} readPointer @param {(path: string) => Promise<string | undefined>} list */
async function legacyCheckout(cwd, top, readPointer, list) {
  const shared = (/** @type {string} */ path) =>
    list(path).catch((error) => {
      if (['outside_roots', 'directory_missing', 'not_a_directory'].includes(error?.code)) return null;
      noteIgnored('verify the older Host shares the checkout', error);
    });
  const path = isWinPath(top) ? win32 : posix;
  const primary = foldHostWorktreePath(top);
  if (path.relative(`${primary}.worktrees`, path.dirname(top)) === '') {
    const pointer = await readPointer(path.join(top, '.git')).catch((error) => {
      if (['not_a_file', 'host_outdated', 'directory_missing', 'outside_roots'].includes(error?.code)) return null;
      noteIgnored('read an older Host worktree pointer', error);
    });
    if (pointer === undefined) return undefined;
    if (pointer !== null) {
      const target = pointer.startsWith('gitdir: ') && pointer.slice('gitdir: '.length).replace(/\r?\n$/, '');
      if (!target || target.includes('\0')) return undefined;
      const gitDir = path.resolve(top, target);
      if (path.relative(path.join(primary, '.git', 'worktrees'), path.dirname(gitDir)) === '') {
        const root = await shared(primary);
        if (root !== null) return root;
      }
    }
  }
  // The branch lookup has already checked that its input is inside the share.
  return top === cwd ? top : shared(top);
}

module.exports = { legacyCheckout };
