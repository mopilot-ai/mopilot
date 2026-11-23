// Carrying uncommitted changes to the target Host of a continue (docs: design/host/index.html, package 3.5, "later"): the source's changes become one commit on a temporary remote branch without touching its branch, index or files; the target applies that commit as uncommitted changes, or refuses and stays as it was. Pure: git is a runner the caller gives.
import { planOf } from './carrySecrets.mjs';
import { inspectRepo } from './codeTransfer.mjs';

/** The temporary branches live under this prefix; nothing else is ever pushed, fetched or deleted by a carry. */
export const CARRY_PREFIX = 'mopilot/carry/';

/** A branch a carry may name: the prefix and a plain name, never `..`, a trailing dot or `.lock`. */
export const CARRY_BRANCH = /^mopilot\/carry\/(?!.*\.\.)[\w.-]{8,128}$/;
const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** Why a carry did not happen. Each leaves the source as it was and the target as it was. */
export const CARRY_CODES = Object.freeze({
  /** The source folder has no uncommitted changes (any more): there is nothing to do, not a failure. */
  noChanges: 'no_changes',
  /** The source folder has no commit, no `origin` to push through, or cannot be read as a repository. */
  nothingToCarry: 'nothing_to_carry',
  /** The push to the remote failed (no access, offline, the remote refused it). */
  pushFailed: 'carry_push_failed',
  /** The source has commits `origin` does not have, and the push of the temporary branch would publish them; the user has not agreed to that many. */
  unpushed: 'carry_unpushed',
  /** What was staged is not what the plan listed. */
  changed: 'carry_changed',
  /** The target could not fetch the temporary branch. */
  fetchFailed: 'carry_fetch_failed',
  /** The fetched commit is not the one the source pushed. */
  mismatch: 'carry_mismatch',
  /** The source has new files the user has not confirmed (they appeared after the list was shown, or it was never shown). */
  unconfirmed: 'carry_unconfirmed',
  /** The target folder is not a Git repository. */
  noRepository: 'carry_no_repository',
  /** The target has changes of its own; they are never mixed with the source's. */
  targetDirty: 'target_dirty',
  /** The target is on another branch than the source. */
  otherBranch: 'carry_other_branch',
  /** The target's branch has commits the source's branch lacks. */
  diverged: 'carry_diverged',
  /** The changes do not apply on the target's files. */
  conflict: 'carry_conflict',
});

/** A carry that did not happen. `code` is one of CARRY_CODES and the message is safe to show. */
export class CarryRefusal extends Error {
  /** @param {string} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'CarryRefusal';
    this.code = code;
  }
}

/** @typedef {(args: string[], opts?: { env?: Record<string, string> }) => Promise<{ ok: boolean, stdout: string, stderr: string }>} Run git in the folder, never prompting */

const refuse = (/** @type {string} */ code, /** @type {string} */ message) => new CarryRefusal(code, message);
/** The last line of git's complaint with any `user:token@` in an address removed. */
const reasonOf = (/** @type {{ stderr: string }} */ r, /** @type {string} */ fallback) =>
  r.stderr
    .trim()
    .split('\n')
    .pop()
    ?.replace(/(:\/\/)[^/@\s]+@/g, '$1')
    .slice(0, 300) || fallback;

/** The branch a key names: one plain name, so two keys never share a branch. @param {string} key */
export const carryBranch = (key) => `${CARRY_PREFIX}${key.replace(/[^\w.-]/g, '-')}`;

/** An identity for the carry commit, so a missing `user.name` cannot stop it and the user's own is never claimed. */
const IDENTITY = {
  GIT_AUTHOR_NAME: 'MoPilot carry',
  GIT_AUTHOR_EMAIL: 'carry@mopilot.invalid',
  GIT_COMMITTER_NAME: 'MoPilot carry',
  GIT_COMMITTER_EMAIL: 'carry@mopilot.invalid',
};

/** The status of a folder as a plan, or the reason it has none. @param {Run} run */
async function statusPlan(run) {
  const r = await run(['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-uall']);
  if (!r.ok) throw refuse(CARRY_CODES.nothingToCarry, `The changes could not be listed: ${reasonOf(r, 'git failed')}`);
  return planOf(r.stdout);
}

/** How many commits of HEAD `origin` does not have: what pushing HEAD's temporary branch would publish besides the changes. Null when git cannot say. @param {Run} run */
async function unpushedCount(run) {
  const r = await run(['rev-list', '--count', 'HEAD', '--not', '--remotes=origin']);
  const n = Number(r.stdout.trim());
  return r.ok && Number.isSafeInteger(n) && n >= 0 ? n : null;
}

/** Where the temporary branch is pushed, as the dialog shows it: `origin`'s push address without any `user:token@`. @param {Run} run */
async function pushTarget(run) {
  const r = await run(['remote', 'get-url', '--push', 'origin']);
  return r.ok
    ? r.stdout
        .trim()
        .replace(/(:\/\/)[^/@\s]+@/, '$1')
        .slice(0, 300)
    : '';
}

/**
 * What a carry of the folder would send, for the user to confirm before it runs: the new files (untracked, not ignored) it would send, the files it never sends because their names say they hold secrets, how many files in all, and the commits `origin` lacks that the push would publish with them (`unpushed`, to `remote`; the carry refuses unless the user confirmed at least that many).
 * @param {Run} run
 * @returns {Promise<{ untracked: string[], changed: string[], skipped: string[], files: number, unpushed: number, remote: string }>} `changed` names the files git already knew that the carry sends (modified, deleted, renamed), the first `CHANGED_LISTED` of them
 */
export async function planCarry(run) {
  const plan = await statusPlan(run);
  const fresh = new Set(plan.untracked);
  return {
    untracked: plan.untracked,
    changed: plan.send.filter((f) => !fresh.has(f)).slice(0, CHANGED_LISTED),
    skipped: plan.skipped,
    files: plan.send.length,
    unpushed: (await unpushedCount(run)) ?? 0,
    remote: await pushTarget(run),
  };
}

/** How many changed files a plan names; the count says the rest. */
const CHANGED_LISTED = 50;

/** Paths per `git add`, so a long list stays under the argument limit. */
const STAGE_CHUNK = 200;

/**
 * On the source: commits every uncommitted change (untracked files included, ignored ones not, and files that look like secrets never) as one commit on top of HEAD through a temporary index, and pushes it to `origin` as a temporary branch. The source's branch, index and files are not touched.
 * @param {Run} run
 * @param {{ key: string, untracked: string[], unpushed?: number, tmpIndex: (gitDir: string) => string, removeIndex: (file: string) => Promise<void> }} o `untracked` is the list of new files the user confirmed: a new file outside it stops the carry; `unpushed` is how many unpushed commits the user agreed to publish with it (none unless said); `tmpIndex` names a file for the temporary index inside the git directory; `removeIndex` deletes it
 * @returns {Promise<{ branch: string, commit: string, parent: string, sourceBranch: string | null, files: number, skipped: string[] }>}
 */
export async function pushCarry(run, { key, untracked, unpushed = 0, tmpIndex, removeIndex }) {
  const facts = await inspectRepo((args) => run(args));
  // any origin will do, a local path included: the target fetches from its own origin, and the commit id is checked after
  const origin = facts.isRepo ? await run(['remote', 'get-url', 'origin']) : null;
  if (!facts.isRepo || !facts.head || !origin?.ok)
    throw refuse(CARRY_CODES.nothingToCarry, 'This folder has no commit or no remote to carry changes through.');
  if (!facts.dirty) throw refuse(CARRY_CODES.noChanges, 'This folder has no uncommitted changes.');
  const plan = await statusPlan(run);
  if (plan.send.length === 0)
    throw refuse(CARRY_CODES.noChanges, 'The only changes are files that look like secrets, which are never carried.');
  const unconfirmed = plan.untracked.filter((f) => !untracked.includes(f));
  if (unconfirmed.length > 0)
    throw refuse(
      CARRY_CODES.unconfirmed,
      `New files that were not confirmed: ${unconfirmed.slice(0, 5).join(', ')}${unconfirmed.length > 5 ? ', …' : ''}`,
    );
  // the commit's parent is HEAD, so the push publishes every commit of HEAD that origin lacks: only as many as the user was told of
  const ahead = await unpushedCount(run);
  if (ahead === null) throw refuse(CARRY_CODES.nothingToCarry, 'The commits origin lacks could not be counted.');
  if (ahead > unpushed)
    throw refuse(
      CARRY_CODES.unpushed,
      `${ahead} unpushed commit${ahead === 1 ? '' : 's'} will be pushed to origin with the changes. Confirm that, or push them yourself first.`,
    );
  const gitDir = await run(['rev-parse', '--absolute-git-dir']);
  if (!gitDir.ok) throw refuse(CARRY_CODES.nothingToCarry, 'This folder is not a Git repository.');
  const index = tmpIndex(gitDir.stdout.trim());
  const env = { GIT_INDEX_FILE: index, ...IDENTITY };
  try {
    // HEAD first, then exactly the paths the plan listed (a file that appeared after the plan is not staged, whatever its name); the real index is never read or written
    const read = await run(['read-tree', 'HEAD'], { env });
    if (!read.ok) throw refuse(CARRY_CODES.nothingToCarry, `The changes could not be gathered: ${reasonOf(read, 'git failed')}`);
    for (let i = 0; i < plan.stage.length; i += STAGE_CHUNK) {
      // `:(top,literal)` names a path from the repository root, whatever folder this runs in, and never as a pattern
      const r = await run(['add', '-A', '--', ...plan.stage.slice(i, i + STAGE_CHUNK).map((f) => `:(top,literal)${f}`)], { env });
      if (!r.ok) throw refuse(CARRY_CODES.nothingToCarry, `The changes could not be gathered: ${reasonOf(r, 'git failed')}`);
    }
    // what is staged must be within what the plan listed and the user confirmed
    const staged = await run(['diff-index', '--cached', '--name-only', '--no-renames', '-z', 'HEAD'], { env });
    const listed = new Set(plan.stage);
    if (!staged.ok || staged.stdout.split('\0').some((f) => f && !listed.has(f)))
      throw refuse(CARRY_CODES.changed, 'The changes are not the ones that were listed.');
    const tree = await run(['write-tree'], { env });
    const commit = tree.ok
      ? await run(['commit-tree', tree.stdout.trim(), '-p', facts.head, '-m', 'MoPilot: changes carried to another host'], { env })
      : tree;
    const sha = commit.ok ? commit.stdout.trim() : '';
    if (!SHA.test(sha)) throw refuse(CARRY_CODES.nothingToCarry, `The changes could not be gathered: ${reasonOf(commit, 'git failed')}`);
    const branch = carryBranch(key);
    const pushed = await run(['push', '--quiet', '--no-verify', 'origin', `${sha}:refs/heads/${branch}`]);
    if (!pushed.ok) throw refuse(CARRY_CODES.pushFailed, `The changes could not be pushed: ${reasonOf(pushed, 'the push failed')}`);
    return {
      branch,
      commit: sha,
      parent: facts.head,
      sourceBranch: /** @type {string | null} */ (facts.branch),
      files: plan.send.length,
      skipped: plan.skipped,
    };
  } finally {
    await removeIndex(index);
  }
}

/**
 * On the target: fetches the temporary branch and applies its commit as uncommitted changes on the source's branch. Refuses before touching anything when the folder is not a clean checkout of that branch; when the changes do not apply, puts the folder back exactly as it was.
 * @param {Run} run
 * @param {{ branch: string, commit: string, parent: string, sourceBranch: string | null }} o
 * @returns {Promise<{ files: number }>}
 */
export async function applyCarry(run, { branch, commit, parent, sourceBranch }) {
  const here = await inspectRepo((args) => run(args));
  if (!here.isRepo) throw refuse(CARRY_CODES.noRepository, 'The folder on the other host is not a Git repository.');
  if (here.dirty) throw refuse(CARRY_CODES.targetDirty, 'The folder on the other host has changes of its own.');
  if (here.branch !== sourceBranch) throw refuse(CARRY_CODES.otherBranch, 'The folder on the other host is on another branch.');
  const fetched = await run(['fetch', '--quiet', 'origin', `refs/heads/${branch}`]);
  if (!fetched.ok) throw refuse(CARRY_CODES.fetchFailed, `The changes could not be fetched: ${reasonOf(fetched, 'the fetch failed')}`);
  const [tip, base] = await Promise.all([
    run(['rev-parse', '--verify', '-q', 'FETCH_HEAD']),
    run(['rev-parse', '--verify', '-q', `${commit}^`]),
  ]);
  if (tip.stdout.trim() !== commit || base.stdout.trim() !== parent)
    throw refuse(CARRY_CODES.mismatch, 'The fetched changes are not the ones that were sent.');
  const start = /** @type {string | null} */ (here.head);
  if (start !== parent) {
    // behind the source's commit: catch up; anything else (ahead, diverged) is not this branch
    const behind = start !== null && (await run(['merge-base', '--is-ancestor', start, parent])).ok;
    const moved = behind ? await run(['merge', '--ff-only', '--quiet', parent]) : null;
    if (!moved?.ok) throw refuse(CARRY_CODES.diverged, 'The branch on the other host has commits the source does not have.');
  }
  const picked = await run(['cherry-pick', '--no-commit', commit]);
  if (!picked.ok) {
    // the folder was clean, so a hard reset is exactly "as it was"; HEAD goes back too when it was moved
    await run(['reset', '--quiet', '--hard', /** @type {string} */ (start)]);
    throw refuse(CARRY_CODES.conflict, 'The changes do not apply to the files on the other host.');
  }
  // the changes were staged by the cherry-pick; they are uncommitted work, so leave them unstaged like the source's
  await run(['reset', '--quiet']);
  const status = await run(['status', '--porcelain=v1']);
  return { files: status.stdout.split('\n').filter(Boolean).length };
}

/**
 * Deletes the temporary branch from the remote. Best effort: a branch that stays is harmless and says what it is.
 * @param {Run} run
 * @param {{ branch: string }} o
 */
export async function dropCarry(run, { branch }) {
  const r = await run(['push', '--quiet', 'origin', '--delete', `refs/heads/${branch}`]);
  return { dropped: r.ok };
}
