// Worktree branch selection keeps fresh sessions on their recorded base while preserving remote-ref and agent-configuration policy; a pull request's worktree checks out its branch.
const fs = require('node:fs');
const { bringBackDeleted } = require('./deletedBranch.cjs');
/** Where a fork's pull request head is fetched: a ref of MoPilot's own, so no branch or remote-tracking ref of origin's is ever overwritten. */
const forkRef = (/** @type {number} */ n) => `refs/mopilot/pull/${n}`;
/**
 * Where a new worktree starts, as Claude Code's desktop app does it: the picked branch, else origin's default
 * branch, freshly fetched whatever branch the checkout is on. origin's copy is used unless the local branch has
 * commits it lacks that leave .claude and .mcp.json alone; offline, the last-fetched commit is. Without a default
 * branch it starts from HEAD.
 */
async function worktreeBase(repo, picked, { defaultBranch, refreshBranch, hasCommit, git, sameAgentConfig }) {
  const name = picked || (await defaultBranch(repo));
  if (!name) return { ok: true, ref: 'HEAD', sourceBranch: null };
  await refreshBranch(repo, name);
  const remote = `refs/remotes/origin/${name}`;
  const local = `refs/heads/${name}`;
  const [hasRemote, hasLocal] = await Promise.all([hasCommit(repo, remote), hasCommit(repo, local)]);
  if (hasRemote) {
    if (!hasLocal || (await git(['merge-base', '--is-ancestor', local, remote], repo)).ok)
      return { ok: true, ref: `origin/${name}`, sourceBranch: name };
    const base = await git(['merge-base', remote, local], repo);
    return {
      ok: true,
      ref: base.ok && (await sameAgentConfig(repo, base.stdout.trim(), local)) ? name : `origin/${name}`,
      sourceBranch: name,
    };
  }
  if (hasLocal) return { ok: true, ref: name, sourceBranch: name };
  return picked ? { ok: false, error: `Branch ${picked} not found` } : { ok: true, ref: 'HEAD', sourceBranch: null };
}

/** A repair starts from a fetched remote commit, with no local-ahead fallback or branch-name interpretation. */
async function pinnedMain(repo, sha, { hasCommit, git }) {
  if (
    !/^[0-9a-f]{40}$/.test(sha) ||
    !(await hasCommit(repo, sha)) ||
    !(await git(['merge-base', '--is-ancestor', sha, 'refs/remotes/origin/main'], repo)).ok
  )
    return { ok: false, error: 'The repair base is not a fetched origin/main commit' };
  return { ok: true, ref: sha, sourceBranch: 'main' };
}

/** A branch name usable in refs/heads/ and as one argument: never an option, a range, a reflog or other ref expression. */
const plainBranch = (b) =>
  typeof b === 'string' && b.length > 0 && b.length <= 255 && !b.startsWith('-') && !/[\s~^:?*[\\\0-\x1f\x7f]|\.\.|@\{/.test(b);

/** The folder a branch is checked out in (the main checkout or any worktree), or null. */
async function checkedOutAt(repo, branch, git) {
  const list = await git(['worktree', 'list', '--porcelain'], repo);
  let at = null;
  for (const line of list.stdout.split('\n')) {
    if (line.startsWith('worktree ')) at = line.slice('worktree '.length);
    else if (line === `branch refs/heads/${branch}`) return at;
  }
  return null;
}

/**
 * A worktree on an existing branch (a pull request's), when it is checked out nowhere else. A local branch is used;
 * one only behind the fetched head `from` is moved up to it first, so nothing of the user's is lost, and one with
 * commits of its own stays as it is. Else a new one from `from`, tracking it only when it is origin's own branch.
 * `base` is the branch it merges into, which the worktree records as where it came from.
 */
async function existingBranch(repo, { branch, base, from }, { hasCommit, git }) {
  if (!plainBranch(branch)) return { ok: false, error: `Invalid branch name "${branch}".` };
  const local = `refs/heads/${branch}`;
  const fetched = await hasCommit(repo, from);
  if (await hasCommit(repo, local)) {
    const at = await checkedOutAt(repo, branch, git);
    if (at) return { ok: false, error: checkedOutError(repo, branch, at) };
    const old = (await git(['rev-parse', '--verify', '--quiet', local], repo)).stdout.trim();
    // update-ref with the old value: moved only if nobody moved it since
    if (fetched && (await git(['merge-base', '--is-ancestor', local, from], repo)).ok)
      await git(['update-ref', '-m', 'mopilot: fast-forward to the pull request', local, from, old], repo);
    return { ok: true, ref: branch, sourceBranch: base, checkout: { branch, create: false } };
  }
  if (!fetched) return { ok: false, error: `Branch ${branch} was not fetched. Try again.` };
  return { ok: true, ref: from, sourceBranch: base, checkout: { branch, create: true, track: from.startsWith('refs/remotes/origin/') } };
}

/** The git config key on a checked-out branch naming the worktree id it was checked out for, so a restore finds it. */
const WORKTREE_KEY = 'mopilotworktree';

/**
 * The kept branch of deleted worktree `id` in `repo`: the one its holder's marker names, else the one checked out for it
 * (a pull request's: its name has no id in it), else <prefix><id> or one ending in /<id>. `{ ok: false, error }` when
 * none is left or more than one could be it.
 */
async function restoreBranch(repo, id, prefix, owner, git) {
  const refs = await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repo);
  const branches = refs.stdout.split('\n').filter(Boolean);
  if (owner?.branch) {
    const kept = branches.find((b) => b === owner.branch);
    return kept ? { ok: true, branch: kept } : { ok: false, error: `The branch for this worktree (…/${id}) is gone` };
  }
  const keyed = await git(['config', '--get-regexp', `^branch\\..*\\.${WORKTREE_KEY}$`], repo);
  const marked = keyed.stdout
    .split('\n')
    .map((line) => /^branch\.(.+)\.[^.\s]+ (\S+)$/.exec(line.trim()))
    .flatMap((m) => (m && m[2] === id && branches.includes(m[1]) ? [m[1]] : []));
  const candidates = marked.length ? marked : branches.filter((b) => b === `${prefix}${id}` || b.endsWith(`/${id}`));
  if (candidates.length > 1) return { ok: false, error: `Multiple branches match this worktree (…/${id})` };
  if (candidates.length) return { ok: true, branch: candidates[0] };
  // one "Delete branch on archive" deleted: made again from its record
  return (await bringBackDeleted(repo, id, git)) ?? { ok: false, error: `The branch for this worktree (…/${id}) is gone` };
}

/**
 * A worktree on a branch named for its task (a Linear issue's suggested branch, `opts.newBranch`). Never the base or
 * origin's default branch, and never a branch of the user's own: those get the usual name instead (`base` alone). A
 * branch of that name on origin (earlier work, pushed, perhaps from another Mac) is fetched and worked on, tracking it;
 * one MoPilot made here before is worked on (moved up when only behind origin); else a new one is made from the base,
 * tracking nothing. Origin is asked each time, so a branch deleted there since is not brought back.
 */
async function namedBranch(repo, opts, deps) {
  const name = opts.newBranch;
  if (!plainBranch(name)) return { ok: false, error: `Invalid branch name "${name}".` };
  const base = await worktreeBase(repo, opts.branch, deps);
  if (!base.ok) return base;
  if (name === base.sourceBranch || name === (await deps.defaultBranch(repo))) return base;
  const remote = `refs/remotes/origin/${name}`;
  // what origin has now, asked each time: a tracking ref left from a branch deleted since (its pull request merged)
  // would bring back old work, and one fetched a while ago may be behind
  const asked = await deps.git(['ls-remote', '--exit-code', 'origin', `refs/heads/${name}`], repo);
  const gone = !asked.ok && !asked.stderr.trim();
  if (gone) await deps.git(['update-ref', '-d', remote], repo);
  const onOrigin =
    asked.ok &&
    !!asked.stdout.trim() &&
    (await deps.git(['fetch', '--quiet', '--no-write-fetch-head', 'origin', `+refs/heads/${name}:${remote}`], repo)).ok;
  const local = `refs/heads/${name}`;
  if (await deps.hasCommit(repo, local)) {
    // a branch of the user's own (no worktree of MoPilot's was made on it) is theirs, not this chat's
    if (!(await deps.git(['config', '--get', `branch.${name}.${WORKTREE_KEY}`], repo)).ok) return base;
    const at = await checkedOutAt(repo, name, deps.git);
    if (at) return { ok: false, error: checkedOutError(repo, name, at) };
    // only behind what was pushed (from another Mac): moved up, with the old value, so nobody's move is lost
    const old = (await deps.git(['rev-parse', '--verify', '--quiet', local], repo)).stdout.trim();
    if (onOrigin && (await deps.git(['merge-base', '--is-ancestor', local, remote], repo)).ok)
      await deps.git(['update-ref', '-m', 'mopilot: fast-forward to what origin has', local, remote, old], repo);
    return { ok: true, ref: name, sourceBranch: base.sourceBranch, checkout: { branch: name, create: false } };
  }
  if (onOrigin) return { ok: true, ref: remote, sourceBranch: base.sourceBranch, checkout: { branch: name, create: true, track: true } };
  // origin couldn't say, and a branch of that name was there once: the usual name, rather than a second one beside it
  if (!gone && !asked.ok && (await deps.hasCommit(repo, remote))) return base;
  return { ok: true, ref: base.ref, sourceBranch: base.sourceBranch, checkout: { branch: name, create: true, track: false } };
}

/** Why `branch` can't be worked on in a new worktree: checked out at `at`, which may be the project folder itself. */
const checkedOutError = (/** @type {string} */ repo, /** @type {string} */ branch, /** @type {string} */ at) =>
  same(at, repo)
    ? `${branch} is checked out in the project folder. Switch that folder to another branch first, or work there.`
    : `${branch} is already checked out in ${at}. Work there, or remove that worktree first.`;
/** The same folder, however it is spelled (a symlink, a different case on macOS): both exist, as git listed one. */
const same = (/** @type {string} */ a, /** @type {string} */ b) => fs.realpathSync(a) === fs.realpathSync(b);

/**
 * Where worktreeAdd starts, by what opts asks for: an existing branch (opts.checkout, with opts.branch its base and
 * opts.pullRequest for a fork's fetched head), a new branch named for its task (opts.newBranch), a repair's pinned commit,
 * HEAD, or the picked branch / origin's default.
 */
async function worktreeStart(repo, opts, deps) {
  if (opts.checkout != null) {
    const fork = Number.isSafeInteger(opts.pullRequest) && opts.pullRequest > 0 ? forkRef(opts.pullRequest) : null;
    return existingBranch(
      repo,
      { branch: opts.checkout, base: opts.branch ?? null, from: fork ?? `refs/remotes/origin/${opts.checkout}` },
      deps,
    );
  }
  if (opts.newBranch != null) return namedBranch(repo, opts, deps);
  if (opts.baseCommit !== undefined) return pinnedMain(repo, opts.baseCommit, deps);
  if (opts.startPoint === 'head') return { ok: true, ref: 'HEAD', sourceBranch: await deps.head() };
  return worktreeBase(repo, opts.branch, deps);
}

/** `git worktree add`'s arguments after `add`: a new untracked branch, or the existing branch checked out (made from the fetched head when missing). */
const addArgs = (start, branch, dir) =>
  !start.checkout
    ? ['--no-track', '-b', branch, dir, start.ref]
    : start.checkout.create
      ? [start.checkout.track ? '--track' : '--no-track', '-b', branch, dir, start.ref]
      : [dir, branch];

module.exports = { worktreeBase, pinnedMain, existingBranch, worktreeStart, addArgs, forkRef, restoreBranch, WORKTREE_KEY };
