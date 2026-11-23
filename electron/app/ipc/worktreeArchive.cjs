// IPC for "Delete branch on archive": remove an archived chat's worktree and its branch when nothing is lost (git:worktreeArchive); restoring the worktree later makes the branch again (platform/deletedBranch.cjs).
const { archiveWorktree } = require('../../platform/worktreeArchive.cjs');

/** @param {import('electron').IpcMain} ipcMain */
function register(ipcMain) {
  ipcMain.handle('git:worktreeArchive', (_e, cwd) => archiveWorktree(cwd));
}

module.exports = { register };
