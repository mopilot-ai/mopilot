// The record "Delete branch on archive" keeps in the repository's git config of a branch it deletes (its commit and its own config), so restoring that chat's worktree later makes the branch again.
const SECTION = 'mopilotdeleted';
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const ID = /^[\w.-]+$/;

/** @typedef {(args: string[], cwd: string) => Promise<{ ok: boolean, stdout: string, stderr?: string }>} Git */
/** @typedef {[key: string, value: string]} Entry one config key and its value (which may hold newlines) */

const escaped = (/** @type {string} */ s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** `-z` output: NUL-ended items, each `key` then a newline and its value (none for a key with no value). */
const entries = (/** @type {string} */ out) =>
  out
    .split('\0')
    .filter(Boolean)
    .map((item) => {
      const at = item.indexOf('\n');
      return /** @type {Entry} */ (at < 0 ? [item, ''] : [item.slice(0, at), item.slice(at + 1)]);
    });
/** `-z --get-all` output: each value NUL-ended. */
const values = (/** @type {string} */ out) => out.split('\0').slice(0, -1);

/**
 * The branch's own config (`branch.<b>.*`: its upstream, its worktree marker), which `git branch -D` removes with it.
 * @param {string} repo @param {string} branch @param {Git} git
 * @returns {Promise<Entry[] | null>} null when it can't be read
 */
async function branchConfig(repo, branch, git) {
  const r = await git(['config', '-z', '--get-regexp', `^branch\\.${escaped(branch)}\\.`], repo);
  // exit 1: no keys
  return r.ok ? entries(r.stdout) : r.stdout || r.stderr ? null : [];
}

/**
 * Record that worktree `id`'s branch is deleted at `sha`, with its config, before it is: false when any write fails.
 * @param {string} repo @param {string} id @param {{ branch: string, sha: string, config: Entry[] }} d @param {Git} git
 */
async function recordDeleted(repo, id, { branch, sha, config }, git) {
  const key = (/** @type {string} */ name) => `${SECTION}.${id}.${name}`;
  await dropRecord(repo, id, git);
  const writes = [
    ['config', key('branch'), branch],
    ['config', key('sha'), sha],
    // each key and its value as two values, in order: a value with a newline in it can't pass for another key
    ...config.flatMap(([k, v]) => [
      ['config', '--add', key('key'), k],
      ['config', '--add', key('value'), v],
    ]),
  ];
  for (const args of writes) if (!(await git(args, repo)).ok) return await dropRecord(repo, id, git), false;
  return true;
}

/** @param {string} repo @param {string} id @param {Git} git */
const dropRecord = (repo, id, git) => git(['config', '--remove-section', `${SECTION}.${id}`], repo);

/**
 * Make worktree `id`'s deleted branch again from its record, with its config, and drop the record: `{ ok, branch }`,
 * `{ ok: false, error }` when its commit is gone, or null when there is no record (or it is not valid).
 * @param {string} repo @param {string} id @param {Git} git
 */
async function bringBackDeleted(repo, id, git) {
  if (!ID.test(id)) return null;
  const read = async (/** @type {string} */ name) =>
    values((await git(['config', '-z', '--get-all', `${SECTION}.${id}.${name}`], repo)).stdout);
  const [branch] = await read('branch');
  const [sha] = await read('sha');
  if (!branch || !sha || !SHA.test(sha) || branch.startsWith('-') || !(await git(['check-ref-format', '--branch', branch], repo)).ok)
    return null;
  const exists = (await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], repo)).ok;
  if (!exists && !(await git(['branch', branch, sha], repo)).ok)
    return { ok: false, error: `The branch for this worktree (…/${id}) was deleted on archive, and its commit is gone` };
  // only the branch's own keys come back: the record is in a file anything can write to
  const own = new RegExp(`^branch\\.${escaped(branch)}\\.[\\w-]+$`);
  const keys = await read('key');
  const vals = await read('value');
  if (!exists && keys.length === vals.length)
    for (const [i, key] of keys.entries()) if (own.test(key)) await git(['config', '--add', key, vals[i]], repo);
  await dropRecord(repo, id, git);
  return { ok: true, branch };
}

module.exports = { branchConfig, recordDeleted, bringBackDeleted, dropRecord };
