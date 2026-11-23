// Archiving a chat's managed worktree with "Delete branch on archive" on: the worktree and its branch go only when nothing on them can be lost (the checks auto-delete applies, plus every commit on a freshly fetched remote or another branch, and no chat main knows still in it), else both stay and why is said; a later restore makes the branch again from the record kept.
const fs = require('node:fs');
const path = require('node:path');
const { git: runGit } = require('./gitRun.cjs');
const gitPlatform = require('./git.cjs');
const { whyKeptHolder } = require('./worktreePrune.cjs');
const { branchConfig, recordDeleted, dropRecord } = require('./deletedBranch.cjs');
const shellEnv = require('./env.cjs');

/**
 * @typedef {typeof runGit} Git
 * @typedef {{ ok: true, removed: boolean, deleted?: { branch: string }, kept?: string } | { ok: false, error: string }} Archived
 */

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const FETCH_MS = 60_000;
/** Work git keeps beside the branch while an operation is under way: dropped with the checkout. */
const IN_PROGRESS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG'];

/** Every open chat's folder as main knows it (electron/app/liveChatFolders.cjs), or null when it can't say. */
let chatFolders = /** @type {(() => Promise<string[] | null>) | null} */ (null);
const setChatFolders = (/** @type {typeof chatFolders} */ fn) => (chatFolders = fn);

/**
 * Remove the managed worktree at `cwd` and delete its branch, when that loses nothing. `kept` says, in words for the
 * window, why both stay (or why the branch stayed after its worktree went).
 * @param {unknown} cwd
 * @param {{ git?: Git, info?: (p: string) => any, remove?: (wt: { path: string, repo: string }) => Promise<boolean>,
 *   folders?: () => Promise<string[] | null> | null }} [deps]
 * @returns {Promise<Archived>}
 */
async function archiveWorktree(
  cwd,
  { git = runGit, info = gitPlatform.worktreeInfo, remove = gitPlatform.removeWorktree, folders = () => chatFolders?.() ?? null } = {},
) {
  const wt = typeof cwd === 'string' && path.isAbsolute(cwd) ? info(cwd) : null;
  if (!wt) return { ok: false, error: 'Not a MoPilot worktree.' };
  const keep = (/** @type {string} */ why) => ({
    ok: /** @type {const} */ (true),
    removed: false,
    kept: `Kept the worktree and its branch: ${why}.`,
  });
  // made by another tool or by hand: it is used here, never removed from here
  if (wt.adopted) return keep('it was made outside MoPilot');
  const head = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], wt.path);
  const branch = head.ok ? head.stdout.trim() : '';
  if (!branch) return keep('it is not on a branch');
  // what could be lost with the checkout; asked again right before removing it, since the fetch below takes a while
  const lost = async () => {
    // a submodule's own commits are not this branch's, and nothing here checks them
    if (fs.existsSync(path.join(wt.path, '.gitmodules'))) return 'it has submodules';
    const doing = await git(['rev-parse', ...IN_PROGRESS.flatMap((p) => ['--git-path', p])], wt.path);
    if (!doing.ok || doing.stdout.split('\n').some((p) => p && fs.existsSync(path.resolve(wt.path, p))))
      return 'a merge, rebase or other git operation is under way in it';
    // what auto-delete keeps a worktree for (#3909): uncommitted changes, and ignored files that are not rebuildable
    return whyKeptHolder({ path: path.dirname(wt.path), worktrees: [{ path: wt.path }] }, git, gitPlatform.MARKER);
  };
  const first = await lost();
  if (first) return keep(first);
  const sha = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], wt.repo)).stdout.trim();
  if (!SHA.test(sha)) return keep(`${branch}’s commits couldn’t be checked`);
  const pushed = await onlyHere(wt.repo, branch, git);
  if (typeof pushed === 'string') return keep(pushed);
  if (pushed > 0) return keep(`${branch} has ${pushed === 1 ? 'a commit' : `${pushed} commits`} not pushed or on another branch`);
  // the window's list may be older than main's (a chat started there while the cleanup script ran)
  const open = await folders();
  if (!open) return keep('the open chats couldn’t be read');
  const at = gitPlatform.canonical(wt.path);
  if (open.some((c) => gitPlatform.canonical(c) === at || gitPlatform.canonical(c).startsWith(at + path.sep)))
    return keep('another chat works in it');
  const last = await lost();
  if (last) return keep(last);
  const id = path.basename(path.dirname(wt.path));
  const config = await branchConfig(wt.repo, branch, git);
  // restoring this chat's worktree (Undo, or unarchiving later) makes the branch again from this record, so it is
  // written first: nothing is deleted without it
  if (!config || !(await recordDeleted(wt.repo, id, { branch, sha, config }, git)))
    return keep('the branch couldn’t be recorded to bring it back');
  if (!(await remove({ path: wt.path, repo: wt.repo })))
    return await dropRecord(wt.repo, id, git), keep('the worktree couldn’t be removed');
  const del = await git(['branch', '-D', branch], wt.repo);
  if (!del.ok) {
    console.warn(`[worktreeArchive] git branch -D ${branch} failed: ${del.stderr.trim()}`);
    await dropRecord(wt.repo, id, git);
    return { ok: true, removed: true, kept: `Removed the worktree, but couldn’t delete ${branch}.` };
  }
  return { ok: true, removed: true, deleted: { branch } };
}

/**
 * How many of `branch`'s commits are on no remote's branch as it is now and no other local branch, or why that can't
 * be said. Each remote's branches are fetched into a namespace of MoPilot's own and removed after, so no remote-tracking
 * ref is changed or pruned (a commit only a stale one holds stays reachable).
 * @param {string} repo @param {string} branch @param {Git} git
 * @returns {Promise<number | string>}
 */
async function onlyHere(repo, branch, git) {
  const couldnt = `${branch}’s commits couldn’t be checked`;
  const remotes = await git(['remote'], repo);
  if (!remotes.ok) return couldnt;
  const names = remotes.stdout.split('\n').filter(Boolean);
  if (names.some((n) => !/^[\w.-]+$/.test(n))) return couldnt;
  // one namespace per check: two archives in the same repository don't remove each other's refs
  const ns = `${CHECK}/${process.pid}-${++checks}`;
  try {
    for (const name of names) {
      const f = await git(
        ['fetch', '--no-tags', '--no-write-fetch-head', '--quiet', name, `+refs/heads/*:${ns}/${name}/*`],
        repo,
        FETCH_MS,
        QUIET_ENV(),
      );
      if (!f.ok) return 'the remote couldn’t be reached to check what is pushed';
    }
    const only = await git(
      ['rev-list', '--count', `refs/heads/${branch}`, '--not', `--exclude=${branch}`, '--branches', `--glob=${ns}`],
      repo,
    );
    const count = Number(only.stdout.trim());
    return only.ok && only.stdout.trim() && Number.isInteger(count) ? count : couldnt;
  } finally {
    const refs = await git(['for-each-ref', '--format=%(refname)', `${ns}/`], repo);
    for (const ref of refs.stdout.split('\n').filter(Boolean)) await git(['update-ref', '-d', ref], repo);
  }
}

/** Where onlyHere fetches remotes' branches to, a namespace for each check, removed after it. */
const CHECK = 'refs/mopilot/archive-check';
let checks = 0;
/** A fetch that never asks for a password or a passphrase: it gives up instead, and the branch is kept. */
const QUIET_ENV = () => ({
  ...shellEnv.gitEnv(),
  GIT_TERMINAL_PROMPT: '0',
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || 'ssh -o BatchMode=yes',
});

module.exports = { archiveWorktree, setChatFolders };
