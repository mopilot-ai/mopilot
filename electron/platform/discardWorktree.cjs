// Cancelled starts remove only their clean prepared worktree, without force, and leave unexpected holder files untouched.
const fs = require('node:fs/promises');
const path = require('node:path');
const { git } = require('./gitRun.cjs');
const { removeCheckout } = require('./worktreeRemoval.cjs');
const { noteIgnored } = require('../ignored.cjs');

async function discardWorktree(worktree, { run = git, io = fs } = {}) {
  // git checks the checkout is clean before deleting it; one it could not finish deleting (held) is finished here
  const result = await removeCheckout(worktree.worktree, () => run(['worktree', 'remove', worktree.worktree], worktree.repo), io);
  if (!result.ok)
    return {
      discarded: false,
      reason: 'The prepared worktree was retained because Git could not remove it cleanly; any local changes are kept.',
    };
  const holder = path.dirname(worktree.worktree);
  try {
    await io.unlink(path.join(holder, '.mopilot-worktree.json'));
    await io.rmdir(holder);
  } catch (error) {
    // A file somebody added beside the checkout is not this start's to delete.
    noteIgnored('remove an empty cancelled-start worktree holder', error, ['ENOENT', 'ENOTEMPTY']);
  }
  return { discarded: true };
}

module.exports = { discardWorktree };
