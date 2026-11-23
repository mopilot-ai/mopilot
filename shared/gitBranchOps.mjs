// A folder's branches and switching it to one, over any git runner: this Mac's (electron/platform/git.cjs) and a machine's Host (host/src/hostRead.mjs, host/src/hostWrite.mjs) run the same code, so the branch picker reads the same list from both.
import { parseGitPathLine } from './gitPathLine.mjs';

/** @typedef {(args: string[], cwd: string) => Promise<{ ok: boolean, stdout: string, stderr: string }>} GitRun */

/** @param {unknown} b whether `b` can not be a branch to ask git for: not a name, blank, or one git would read as an option */
export const invalidBranch = (b) => typeof b !== 'string' || !b.trim() || b.startsWith('-');

/** @param {GitRun} git @param {string} repo @param {string} ref whether `ref` names a commit in the repository */
export const hasCommitOf = async (git, repo, ref) => (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repo)).ok;

/** origin's default branch: origin/HEAD's target, else main or master when origin has it; '' without one. @param {GitRun} git @param {string} repo */
export async function defaultBranchOf(git, repo) {
  const head = await git(['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], repo);
  const name = head.ok ? head.stdout.trim().replace(/^origin\//, '') : '';
  if (name) return name;
  for (const b of ['main', 'master']) if (await hasCommitOf(git, repo, `refs/remotes/origin/${b}`)) return b;
  return '';
}

/**
 * The branch picker's list for the repository whose top folder is `repo`: local branches, origin's default first, and the checked-out one. `commits` is false in a repository a worktree can't start from: no commit
 * checked out, and origin's default branch has none here yet, on origin's copy or a local one.
 * @param {GitRun} git @param {string} repo
 */
export async function branchListAt(git, repo) {
  const [current, refs, dflt, head] = await Promise.all([
    git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repo),
    git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], repo),
    defaultBranchOf(git, repo),
    hasCommitOf(git, repo, 'HEAD'),
  ]);
  const names = refs.stdout
    .split('\n')
    .map((n) => n.trim())
    .filter(Boolean);
  const commits =
    head ||
    (!!dflt && ((await hasCommitOf(git, repo, `refs/remotes/origin/${dflt}`)) || (await hasCommitOf(git, repo, `refs/heads/${dflt}`))));
  return {
    current: (current.ok && current.stdout.trim()) || null,
    default: dflt || null,
    branches: dflt ? [dflt, ...names.filter((n) => n !== dflt)] : names,
    commits,
  };
}

/** The branch list of `cwd`'s repository; null outside a repo. @param {GitRun} git @param {string} cwd */
export async function listBranches(git, cwd) {
  const top = await git(['rev-parse', '--show-toplevel'], cwd);
  const repo = parseGitPathLine(top.stdout);
  return !top.ok || !repo ? null : branchListAt(git, repo);
}

const UNMERGED = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);

/** Whether a `git status --porcelain=v1` code is an unmerged path (a conflict not yet resolved). @param {string} code */
export const isUnmerged = (code) => UNMERGED.has(code);

/**
 * Whether switching `cwd` to `branch` would collide with uncommitted work (as Claude Code's desktop app checks): a conflict in progress, or a changed file the branch also changes. A clean tree never does.
 * @param {GitRun} git @param {string} cwd @param {string} branch
 */
async function switchWouldConflict(git, cwd, branch) {
  const st = await git(['status', '--porcelain=v1', '-uall', '-z'], cwd);
  const parts = st.stdout.split('\0');
  const dirty = new Set();
  for (let i = 0; i < parts.length; i++) {
    const code = parts[i].slice(0, 2);
    if (parts[i].length < 4) continue;
    if (UNMERGED.has(code)) return true;
    dirty.add(parts[i].slice(3));
    // a rename or copy is followed by its original path
    if (/[RC]/.test(code)) dirty.add(parts[++i]);
  }
  if (dirty.size === 0) return false;
  /** @type {string | null} */
  let target = null;
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const r = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd);
    if (r.ok) {
      target = r.stdout.trim();
      break;
    }
  }
  if (!target) return true;
  const changed = await git(['diff', '--name-only', '--no-renames', '-z', 'HEAD', target], cwd);
  return changed.stdout.split('\0').some((f) => dirty.has(f));
}

/**
 * Check out `branch` where a chat runs without a worktree (Claude Code's desktop app does the same); nothing to do when it is checked out. The error is a sentence for the person.
 * @param {GitRun} git @param {string} cwd @param {string} branch @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
export async function switchBranch(git, cwd, branch) {
  if (invalidBranch(branch)) return { ok: false, error: `Invalid branch name "${branch}".` };
  const current = await git(['symbolic-ref', '--quiet', '--short', 'HEAD'], cwd);
  const on = current.ok ? current.stdout.trim() : '';
  if (on === branch) return { ok: true };
  if (await switchWouldConflict(git, cwd, branch))
    return {
      ok: false,
      error: `Can't switch to "${branch}": there are uncommitted changes${on ? ` on "${on}"` : ''} in ${cwd}. Commit or stash them, or turn on Worktree.`,
    };
  const r = await git(['switch', branch], cwd);
  return r.ok ? { ok: true } : { ok: false, error: `Failed to switch to "${branch}" in ${cwd}: ${r.stderr.trim() || 'git switch failed'}` };
}
