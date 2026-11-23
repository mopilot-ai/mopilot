// Getting the code to the target Host of a continue (docs: design/host/index.html, package 3.5): what a folder's repository is, whether the target folder holds the same repository and branch, and the lines the handoff says about it. Pure: git is a runner the caller gives.

/** @typedef {{ isRepo: boolean, remote?: string | null, branch?: string | null, head?: string | null, dirty?: number }} RepoFacts what a folder holds, as `inspectRepo` answers */

/** Why a clone for a continue cannot start; the other refusals come from the Host's own modules (`outside_roots`, `directory_missing`, `clone_failed`). */
export const CODE_CODES = Object.freeze({
  /** The source folder has no `origin` the target could clone from (none, or a local path). */
  noRemote: 'no_remote',
  /** The source's repository could not be read, so there is nothing to clone. */
  unknownSource: 'unknown_source',
});

/** A repository address safe to show, send and compare: no password, token, query or fragment; null for anything the target could not clone (a local path, `file://`). @param {unknown} url */
export function publicRemote(url) {
  if (typeof url !== 'string') return null;
  const v = url.trim();
  if (/^git@[\w.-]+:[^\s]+$/.test(v)) return v;
  if (!/^(https|ssh):\/\//i.test(v) || /[\s\u0000-\u001f]/.test(v)) return null;
  let u;
  try {
    u = new URL(v);
  } catch {
    return null;
  }
  if (!u.hostname) return null;
  // an ssh user (`git@`) is not a secret; an https user is a token more often than a name
  const user = u.protocol === 'ssh:' && u.username ? `${u.username}@` : '';
  return `${u.protocol}//${user}${u.host}${u.pathname}`;
}

/** The repository an address names, the same for its https, ssh and scp forms: `host/path` without `.git`; null when it names none. @param {unknown} url */
export function repoKey(url) {
  const v = publicRemote(url);
  if (!v) return null;
  const scp = /^git@([\w.-]+):(.+)$/.exec(v);
  const parsed = scp ? null : new URL(v);
  const host = scp ? scp[1] : /** @type {URL} */ (parsed).hostname;
  const rest = scp ? scp[2] : /** @type {URL} */ (parsed).pathname;
  const repo = rest
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/, '');
  return repo ? `${host.toLowerCase()}/${repo}` : null;
}

const SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/**
 * What a folder holds, read with git: `{ isRepo: false }`, or the repository's origin, branch (null when detached), commit (null when unborn) and the number of changed files. A part git cannot say is null, never wrong.
 * @param {(args: string[]) => Promise<{ ok: boolean, stdout: string }>} run git in the folder, never prompting
 * @returns {Promise<RepoFacts>}
 */
export async function inspectRepo(run) {
  const inside = await run(['rev-parse', '--is-inside-work-tree']);
  if (!inside.ok || inside.stdout.trim() !== 'true') return { isRepo: false };
  const [branch, head, remote, status] = await Promise.all([
    run(['symbolic-ref', '--short', '-q', 'HEAD']),
    run(['rev-parse', '--verify', '-q', 'HEAD']),
    run(['remote', 'get-url', 'origin']),
    run(['--no-optional-locks', 'status', '--porcelain=v1']),
  ]);
  const sha = head.ok ? head.stdout.trim() : '';
  return {
    isRepo: true,
    remote: remote.ok ? publicRemote(remote.stdout) : null,
    branch: branch.ok && branch.stdout.trim() ? branch.stdout.trim() : null,
    head: SHA.test(sha) ? sha : null,
    dirty: status.ok ? status.stdout.split('\n').filter(Boolean).length : 0,
  };
}

/** A repository as `inspectRepo` answers, checked: an answer from a Host this app does not know is read as not a repository rather than trusted. @param {unknown} v @returns {RepoFacts} */
export function repoFacts(v) {
  const o = /** @type {any} */ (v);
  if (!o || typeof o !== 'object' || o.isRepo !== true) return { isRepo: false };
  const str = (/** @type {unknown} */ s) => (typeof s === 'string' && s && s.length <= 1000 ? s : null);
  return {
    isRepo: true,
    remote: publicRemote(o.remote),
    branch: str(o.branch),
    head: typeof o.head === 'string' && SHA.test(o.head) ? o.head : null,
    dirty: Number.isSafeInteger(o.dirty) && o.dirty > 0 ? o.dirty : 0,
  };
}

/**
 * How the target folder compares with the source's repository: `ready` (the same repository on the same branch), `other_branch`, `other_repository`, `no_repository`, or `unverified` when the source says nothing to compare with (not a repository, or no origin).
 * @param {RepoFacts | null} source null when the source could not be read
 * @param {RepoFacts} target
 */
export function classifyTarget(source, target) {
  if (!target.isRepo) return 'no_repository';
  const want = source?.isRepo ? repoKey(source.remote) : null;
  if (!source?.isRepo || !want) return 'unverified';
  if (repoKey(target.remote) !== want) return 'other_repository';
  // a detached source is the same place only at the same commit
  if (source.branch === null || source.branch === undefined)
    return target.branch == null && target.head === source.head ? 'ready' : 'other_branch';
  return target.branch === source.branch ? 'ready' : 'other_branch';
}

const short = (/** @type {string} */ sha) => sha.slice(0, 12);

/**
 * What the handoff says about the code: the source's repository and branch so the agent can fetch it itself, how the target folder compares, and that uncommitted changes stay behind. Empty when the source says nothing.
 * @param {{ source: RepoFacts | null, target?: RepoFacts | null, carried?: number, skipped?: string[] }} o `carried` is how many uncommitted files were applied on the target, `skipped` the files a carry never sends because they look like secrets (package 3.5)
 * @returns {string[]}
 */
export function codeLines({ source, target = null, carried = 0, skipped = [] }) {
  if (!source?.isRepo) return [];
  const lines = [];
  if (source.remote) lines.push(`Repository: ${source.remote}`);
  if (source.branch) lines.push(`Branch: ${source.branch}${source.head ? ` at ${short(source.head)}` : ''}`);
  else if (source.head) lines.push(`Commit: ${short(source.head)} (no branch checked out)`);
  const state = target ? classifyTarget(source, target) : 'unverified';
  const branch = source.branch ?? 'the same commit';
  if (state === 'ready')
    lines.push('This directory is a clone of that repository on that branch; run `git fetch` if the commit is missing.');
  else if (state === 'other_branch')
    lines.push(
      `This directory is on ${target?.branch ? `branch ${target.branch}` : 'no branch'}, not ${branch}; run \`git fetch\` and check ${branch} out.`,
    );
  else if (state === 'other_repository') lines.push('This directory holds another repository; do not assume it has the same history.');
  else if (state === 'no_repository') lines.push('This directory is not a Git repository.');
  const here = target?.isRepo ? (target.dirty ?? 0) : 0;
  const there = source.dirty ?? 0;
  const files = (/** @type {number} */ n) => `${n} uncommitted file${n === 1 ? '' : 's'}`;
  if (skipped.length > 0) {
    const names = skipped.slice(0, 8).join(', ');
    lines.push(
      `Not carried over, because they look like secrets: ${names}${skipped.length > 8 ? `, and ${skipped.length - 8} more` : ''}.`,
    );
  }
  if (carried > 0) lines.push(`${files(carried)} from the previous host were carried over and are uncommitted here.`);
  else {
    if (here > 0) lines.push(`This directory has ${files(here)} of its own.`);
    if (there > 0) lines.push(`${files(there)} on the previous host were not carried over.`);
  }
  return lines;
}
