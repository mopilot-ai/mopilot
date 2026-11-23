// The rule the merge gate and the main-red issue both read main's runs by (main-unit-tests, main-e2e): a commit's
// result is main's current one for its context only while it is the newest finished (not pending) status for that
// context on main's first-parent commits, newest first (docs/unit-coverage.md#main-check). scripts/merge-gate.mjs
// walks main with git and asks for every run at once; scripts/main-red-issue.mjs walks it over the API for the one
// run that just reported, so an older run's result cannot open, reopen or close the issue behind a newer one. A result
// counts only from the identities that post CI's results (shared/statusTrust.ts).
import { counts, trusted } from './statusTrust.mjs';

// main commits a run's result is looked for on, newest first: each run skips the commits that landed together, and
// the paired cycle (back to back) skips the merges that land while one runs. The gate and the issue share it, so they
// cannot read main through different windows.
export const MAIN_LOOKBACK = 60;

/**
 * The status a targeted re-run of a red run's failing tests posts on a newer commit of main (scripts/main-reverify.mjs,
 * docs/unit-coverage.md#targeted-re-verify): `<context>-reverify`, its description naming the red commit it re-ran.
 */
export const reverifyContext = (/** @type {string} */ context) => `${context}-reverify`;
/**
 * The status a culprit search's run of the same failing tests posts on a candidate commit (scripts/culprit-search.mjs,
 * docs/unit-coverage.md#culprit-search): `<context>-bisect`. Neither the merge gate nor a release reads it, so a search
 * can never lift a red hold.
 */
export const bisectContext = (/** @type {string} */ context) => `${context}-bisect`;
/** The words of that description that tie it to the red commit (its first 12 characters). */
export const reverifyOf = (/** @type {string} */ red) => `of ${red.slice(0, 12)}`;

/** The states GitHub posts. Anything else is not a commit status, so a history holding one is not readable. */
const STATUS_STATES = ['pending', 'success', 'failure', 'error'];

/**
 * A commit's status history as the REST API serves it (newest first), or a throw when the answer is not one: an
 * unreadable history must never read as "no result", which would make a red main look green.
 * @param {unknown} parsed the parsed `commits/<sha>/statuses` response
 * @param {string} sha
 * @returns {{ context: string, state: string, target_url?: string, description?: string, created_at?: string, updated_at?: string, creator?: { login?: string } | null }[]}
 */
export function statusHistory(parsed, sha) {
  if (!Array.isArray(parsed) || parsed.some((s) => !s || typeof s.context !== 'string' || !STATUS_STATES.includes(s.state))) {
    throw new Error(`Invalid main status history on ${sha}`);
  }
  return parsed;
}

/**
 * A commit's statuses that count (shared/statusTrust.ts), newest first, from one page of its REST history: the combined
 * status names no creator, so a decision never reads it.
 * @param {(args: string[]) => string} gh
 * @param {string} repo
 * @param {string} sha
 */
export const readStatuses = (gh, repo, sha) =>
  trusted(statusHistory(JSON.parse(gh(['api', `repos/${repo}/commits/${sha}/statuses?per_page=100`])), sha));

/**
 * The newest finished status for `context` in one commit's history that counts (shared/statusTrust.ts), or null while
 * it has only pending ones: a retry posting pending on the same commit must not hide the result it is retrying, and a
 * result someone else posted is no result.
 * @param {{ context: string, state: string, target_url?: string, description?: string, creator?: { login?: string } | null }[]} statuses
 * @param {string} context
 */
export const finishedStatus = (statuses, context) =>
  statuses.find((s) => s.context === context && s.state !== 'pending' && counts(s)) ?? null;

/**
 * The newest finished result of each context over `commits` — main's first-parent commits, newest first — with the
 * commit it is on; null for a context none of them has one for. One status read per commit, and a lazy `commits`
 * (a generator walking main over the API) is only read as far as the answer needs. A full page can hide a finished
 * result, so truncation before every context is found is an error rather than "no result".
 * @param {{ commits: Iterable<string>, read: (sha: string) => unknown, contexts: string[] }} options
 * @returns {Record<string, { sha: string, state: string, url: string } | null>}
 */
export function newestFinishedRuns({ commits, read, contexts }) {
  /** @type {Record<string, { sha: string, state: string, url: string } | null>} */
  const runs = Object.fromEntries(contexts.map((c) => [c, null]));
  for (const sha of commits) {
    const statuses = statusHistory(read(sha), sha);
    for (const context of contexts) {
      const s = runs[context] ? null : finishedStatus(statuses, context);
      if (s) runs[context] = { sha, state: s.state, url: s.target_url ?? '' };
    }
    if (Object.values(runs).every(Boolean)) break;
    // A full page can hide a finished failure. Keep the read bound, but never mistake truncation for no result.
    if (statuses.length >= 100) throw new Error(`Incomplete main status history on ${sha}; cannot establish its latest finished runs`);
  }
  return runs;
}

/**
 * Whether the failing tests of `run` (a context's newest finished result, red) passed when re-run on a newer commit of
 * main: the newest finished re-run on the commits newer than `run.sha` (`commits` newest first, as the walk that found
 * `run` read them) has to be green and name `run.sha`. A re-run that failed, or one for an older red result, is not.
 * The full run still decides: once it finishes on a newer commit, that result is main's newest, and this one says
 * nothing about it. `{ sha, url }` of the re-run, or null.
 * @param {{ commits: string[], read: (sha: string) => unknown, context: string, run: { sha: string } }} options
 */
export function reverified({ commits, read, context, run }) {
  for (const sha of commits) {
    if (sha === run.sha) return null;
    const s = finishedStatus(statusHistory(read(sha), sha), reverifyContext(context));
    if (s) return s.state === 'success' && s.description?.includes(reverifyOf(run.sha)) ? { sha, url: s.target_url ?? '' } : null;
  }
  return null;
}

/**
 * Re-read immediately before repairing a dead run's pending status, matching both its run URL and timestamp.
 * A replacement/manual run's status belongs to it; it is never cleared by recovery of an older run.
 * @param {{ gh: (args: string[]) => string, repo: string, sha: string, status: import('./mainValidation.ts').MainStatus, dryRun: boolean, log: (line: string) => void }} options
 */
export function repairPending({ gh, repo, sha, status, dryRun, log }) {
  const raw = statusHistory(JSON.parse(gh(['api', `repos/${repo}/commits/${sha}/statuses?per_page=100`])), sha);
  if (raw.length >= 100) throw new Error(`Incomplete status history for ${sha}`);
  const latest = trusted(raw).find((s) => s.context === status.context);
  if (!latest || latest.state !== 'pending' || latest.target_url !== status.target_url || latest.updated_at !== status.updated_at)
    return false;
  if (!dryRun)
    gh([
      'api',
      `repos/${repo}/statuses/${sha}`,
      '-f',
      'state=error',
      '-f',
      `context=${status.context}`,
      '-f',
      'description=Validation stopped without a result; recovery will retry once',
      '-f',
      `target_url=${status.target_url}`,
    ]);
  log(`${status.context}: ${dryRun ? 'would repair' : 'repaired'} stopped run at ${sha}`);
  return true;
}
