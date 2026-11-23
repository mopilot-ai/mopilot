// Resolves a branch diff's merge base from the checkout's local Git refs on desktop, Host and phone.
const REMOTES = 'refs/remotes/';
const DEFAULTS = ['main', 'master'];
const REMOTE_DEFAULTS = ['HEAD', ...DEFAULTS];
const MAX_DEFAULT_REFS = 64;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// Older Git can ignore GIT_NO_LAZY_FETCH. Blocking transports keeps these reads local on those builds too.
export const BRANCH_COMPARISON_GIT_ENV = Object.freeze({ GIT_NO_LAZY_FETCH: '1', GIT_ALLOW_PROTOCOL: '' });

export const BRANCH_BASE_UNAVAILABLE = 'No clear comparison base for this branch. Uncommitted changes are still available.';

/** @typedef {(args: string[]) => Promise<{ ok: boolean, stdout: string, code?: number | string, cut?: boolean }>} GitRead */

/** @param {GitRead} git @param {string} ref @returns {Promise<string | null | undefined>} A merge base, unrelated history (null), or an unreadable probe (undefined). */
async function mergeBase(git, ref) {
  const result = await git(['merge-base', 'HEAD', ref]);
  const oid = result.stdout.trim();
  if (!result.cut && result.ok && OID.test(oid)) return oid;
  if (!result.cut && !result.ok && result.code === 1) return null;
  return undefined;
}

/** @param {GitRead} git @param {string[]} refs conventional first match for origin and repositories without fetched refs */
async function firstMergeBase(git, refs) {
  for (const ref of new Set(refs)) {
    const base = await mergeBase(git, ref);
    if (base) return base;
  }
  return null;
}

/** Without fetched remote history, use the local default or HEAD. Unrelated or ambiguous remote defaults cannot supply a base.
 * @param {GitRead} git one read-only Git runner for the checkout being compared
 */
export async function branchComparisonBase(git) {
  const upstream = await git(['symbolic-ref', '--quiet', `${REMOTES}origin/HEAD`]);
  const ref = upstream.stdout.trim();
  const originDefaults = DEFAULTS.map((name) => `${REMOTES}origin/${name}`);
  if (upstream.ok && ref.startsWith(`${REMOTES}origin/`)) originDefaults.unshift(ref);
  const origin = await firstMergeBase(git, originDefaults);
  if (origin) return origin;

  const remotes = await git(['remote']);
  if (!remotes.ok || remotes.cut) return null;
  // Simple tracking namespaces can outlive a remote rename. A slash in a remote's
  // name needs a config entry to distinguish it from a nested branch name.
  const slashRemotes = remotes.stdout
    .trim()
    .split('\n')
    .filter((name) => name.includes('/'));
  const defaults = REMOTE_DEFAULTS.map((name) => `${REMOTES}*/${name}`);
  for (const remote of slashRemotes) {
    // A glob matches the whole ref while a literal can also match a path prefix.
    for (const name of REMOTE_DEFAULTS) defaults.push(`${REMOTES}${remote}/[${name[0]}]${name.slice(1)}`);
  }
  const listed = await git(['for-each-ref', `--count=${MAX_DEFAULT_REFS + 1}`, '--format=%(refname)', ...defaults]);
  if (!listed.ok || listed.cut) return null;
  const refs = listed.stdout.trim().split('\n').filter(Boolean);
  if (refs.length > MAX_DEFAULT_REFS) return null;
  if (!refs.length) {
    const tracked = await git(['for-each-ref', '--count=1', '--format=%(refname)', 'refs/remotes']);
    if (!tracked.ok || tracked.cut || tracked.stdout.trim()) return null;
    return (
      (await firstMergeBase(
        git,
        DEFAULTS.map((name) => `refs/heads/${name}`),
      )) ?? 'HEAD'
    );
  }

  const known = new Set(refs);
  let base = null;
  for (const name of refs) {
    const prefix = name.slice(0, name.lastIndexOf('/') + 1);
    if (prefix === `${REMOTES}origin/`) continue;
    const defaultRef = `${prefix}HEAD`;
    if (name !== defaultRef && known.has(defaultRef)) continue;
    const candidate = await mergeBase(git, name);
    if (candidate === undefined) return null;
    if (candidate === null) continue;
    if (base && base !== candidate) return null;
    base = candidate;
  }
  return base;
}
