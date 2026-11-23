// Claims a break of main for one fixer (docs/unit-coverage.md#claiming-a-break): refs/heads/claims/main-red-<issue> points
// at a small commit whose message records the claimant, time and pull request as JSON. GitHub creates a ref only once
// (422) and, with force false, moves it only forward, so claiming, attaching a pull request and releasing are each a
// compare-and-swap; a release moves the ref to a "released" commit, which reads as unclaimed, and the ref is deleted
// only once its issue is closed (a delete is no compare-and-swap).
// The sweep expires claims (scripts/claim-lease.mjs). It imports no package (tests/ciDependencies.test.ts).
//   node scripts/claim-main-red.mjs claim <issue> [--pr <n>] [--as <who>]
//   node scripts/claim-main-red.mjs attach <issue> --pr <n> [--as <who>]
//   node scripts/claim-main-red.mjs release <issue> [--as <who>] [--force]
//   SOURCE_REPO=mopilot-ai/mopilot-internal
import os from 'node:os';
import path from 'node:path';
import { validWorker } from './mainRepairClaim.mjs';

/** @typedef {(args: string[]) => string} Gh */
/** @typedef {{ issue: number, claimant: string, at: string, pr: number | null, attached?: string, worker?: import('./mainRepairClaim.mjs').RepairWorker, reverify?: {red: string, fix: string, target: string, at: string, attempt?: string} }} Claim */
/** @typedef {{ state: 'unclaimed', sha?: string } | ({ state: 'claimed', sha: string } & Claim)} ReadState */
/** @typedef {ReadState | { state: 'unknown', why: string }} ClaimState */
/** @typedef {{ ok: boolean, claim: ClaimState, why?: string }} Outcome */

export const CLAIM_PREFIX = 'claims/main-red-';
const SUBJECT = 'main-red claim';
// the file every claim commit holds (a commit needs a tree): the same JSON as its message
const FILE = 'claim.json';

/** The branch that claims issue `issue`, exactly: claims/main-red-12 never stands for issue 120. */
export function claimRef(/** @type {number | string} */ issue) {
  if (!/^[1-9]\d*$/.test(String(issue))) throw new Error(`Not an issue number: ${issue}`);
  return `${CLAIM_PREFIX}${issue}`;
}

/** The issue a full ref name claims, or null for any other ref. */
export const issueOfRef = (/** @type {string} */ ref) => {
  const m = /^refs\/heads\/claims\/main-red-([1-9]\d*)$/.exec(ref);
  return m ? Number(m[1]) : null;
};

/** The HTTP status a failed gh call reports, or null (a timeout, no network). */
export const httpStatus = (/** @type {any} */ error) => {
  const m = /HTTP (\d{3})/.exec(`${error?.stderr ?? ''}\n${error?.message ?? ''}`);
  return m ? Number(m[1]) : null;
};
/** One line on why a gh call failed: gh's own last line when it printed one (it carries the HTTP status). */
export const brief = (/** @type {any} */ error) =>
  String(error?.stderr ?? '')
    .trim()
    .split('\n')
    .at(-1) || String(error?.message ?? error).split('\n')[0];
const unanswered = (/** @type {any} */ error) => {
  const s = httpStatus(error);
  return s === null || s >= 500;
};

/** A claim commit's message: a subject, then the record as one JSON line, never concatenated text. */
export const claimMessage = (/** @type {Record<string, unknown>} */ record) => `${SUBJECT} #${record.issue}\n\n${JSON.stringify(record)}\n`;

/**
 * The record a claim commit's message holds: `{ released }` for a released claim; it throws on anything else, so an
 * unreadable claim is never taken for no claim.
 * @returns {Claim | { issue: number, released: string }}
 */
export function parseClaim(/** @type {string} */ message) {
  const [subject, , json] = message.split('\n');
  const record = subject?.startsWith(SUBJECT) ? JSON.parse(json ?? '') : null;
  if (record && Number.isInteger(record.issue) && typeof record.released === 'string') return record;
  if (
    !record ||
    !Number.isInteger(record.issue) ||
    typeof record.claimant !== 'string' ||
    !record.claimant ||
    Number.isNaN(Date.parse(record.at)) ||
    !(record.pr === null || Number.isInteger(record.pr)) ||
    (record.worker !== undefined && !validWorker(record.worker))
  )
    throw new Error('the claim commit records no claim');
  return record;
}

/**
 * What claims issue `issue` now. A missing ref, or one at a released commit, is unclaimed; any other failure throws.
 * @param {{ gh: Gh, repo: string, issue: number }} options
 * @returns {ReadState}
 */
export function readClaim({ gh, repo, issue }) {
  let sha;
  try {
    sha = JSON.parse(gh(['api', `repos/${repo}/git/ref/heads/${claimRef(issue)}`])).object.sha;
  } catch (error) {
    if (httpStatus(error) === 404) return { state: 'unclaimed' };
    throw error;
  }
  return stateAt({ gh, repo, issue, sha });
}

/** @param {{ gh: Gh, repo: string, issue: number, sha: string }} options @returns {ReadState} */
export function stateAt({ gh, repo, issue, sha }) {
  const record = parseClaim(JSON.parse(gh(['api', `repos/${repo}/git/commits/${sha}`])).message);
  if (record.issue !== issue) throw new Error(`the claim of #${issue} records issue #${record.issue}`);
  return 'released' in record ? { state: 'unclaimed', sha } : { state: 'claimed', sha, ...record };
}

/** Like readClaim, but an unreadable claim is `unknown`, never unclaimed. @param {{ gh: Gh, repo: string, issue: number }} options */
export function claimState(options) {
  try {
    return readClaim(options);
  } catch (error) {
    return /** @type {ClaimState} */ ({ state: 'unknown', why: brief(error) });
  }
}

/** Calls `fn` again once when GitHub did not answer (a 5xx, no answer at all); a refusal is thrown at once. */
function twice(/** @type {() => string} */ fn) {
  try {
    return fn();
  } catch (error) {
    if (!unanswered(error)) throw error;
    return fn();
  }
}

/**
 * Writes the commit for `record` on `parent` (none for a new claim) and returns its sha. Git objects are content
 * addressed and nothing points at them yet, so a write GitHub did not answer is simply written again.
 * @param {Gh} gh @param {string} repo @param {Record<string, unknown>} record @param {string | null} parent
 */
export function writeClaim(gh, repo, record, parent) {
  const json = JSON.stringify(record);
  const tree = twice(() =>
    gh([
      'api',
      '-X',
      'POST',
      `repos/${repo}/git/trees`,
      '-f',
      `tree[][path]=${FILE}`,
      '-f',
      'tree[][mode]=100644',
      '-f',
      'tree[][type]=blob',
      '-f',
      `tree[][content]=${json}\n`,
    ]),
  );
  const args = [
    'api',
    '-X',
    'POST',
    `repos/${repo}/git/commits`,
    '-f',
    `message=${claimMessage(record)}`,
    '-f',
    `tree=${JSON.parse(tree).sha}`,
  ];
  if (parent) args.push('-f', `parents[]=${parent}`);
  return /** @type {string} */ (JSON.parse(twice(() => gh(args))).sha);
}

/** Moves the claim ref from where it is to `sha`, a commit on top of it; GitHub refuses (422) when it moved or is gone. */
const forward = (/** @type {Gh} */ gh, /** @type {string} */ repo, /** @type {number} */ issue, /** @type {string} */ sha) =>
  gh(['api', '-X', 'PATCH', `repos/${repo}/git/refs/heads/${claimRef(issue)}`, '-f', `sha=${sha}`, '-F', 'force=false']);

/**
 * The outcome once a ref write failed or went unanswered: read the claim back, and it is ours when it is at `sha`.
 * @returns {Outcome}
 */
function readBack(/** @type {{ gh: Gh, repo: string, issue: number }} */ at, /** @type {string} */ sha, /** @type {any} */ error) {
  const claim = claimState(at);
  if (claim.state === 'claimed' && claim.sha === sha) return { ok: true, claim };
  if (claim.state === 'claimed') return { ok: false, claim, why: `#${at.issue} is claimed by ${claim.claimant} since ${claim.at}` };
  if (claim.state === 'unknown')
    return { ok: false, claim, why: `the claim of #${at.issue} could not be read back (${claim.why}) after: ${brief(error)}` };
  return { ok: false, claim, why: `#${at.issue} is not claimed: ${brief(error)}` };
}

/**
 * Claims issue `issue` for `claimant` (with pull request `pr`, if one is open already): the first claim creates the
 * ref and wins, and a later one is told who holds it. A released claim is taken over by moving its ref forward.
 * @param {{ gh: Gh, repo: string, issue: number, claimant: string, pr?: number | null, worker?: import('./mainRepairClaim.mjs').RepairWorker, now?: number }} options
 * @returns {Outcome}
 */
export function claim({ gh, repo, issue, claimant, pr = null, worker, now = Date.now() }) {
  if (worker !== undefined && !validWorker(worker)) throw new Error('Invalid main-repair worker');
  const at = { gh, repo, issue };
  const current = readClaim(at);
  if (current.state === 'claimed') {
    if (current.claimant !== claimant)
      return { ok: false, claim: current, why: `#${issue} is claimed by ${current.claimant} since ${current.at}` };
    // claiming again what one holds: records a newer pull request, if one is named
    return pr && pr !== current.pr ? attach({ gh, repo, issue, claimant, pr, now }) : { ok: true, claim: current };
  }
  const record = { issue, claimant, at: new Date(now).toISOString(), pr, ...(worker ? { worker } : {}) };
  const sha = writeClaim(gh, repo, record, current.sha ?? null);
  try {
    if (current.sha) forward(gh, repo, issue, sha);
    else twice(() => gh(['api', '-X', 'POST', `repos/${repo}/git/refs`, '-f', `ref=refs/heads/${claimRef(issue)}`, '-f', `sha=${sha}`]));
    return { ok: true, claim: /** @type {ClaimState} */ ({ state: 'claimed', sha, ...record }) };
  } catch (error) {
    // a 422 is someone else's claim, made since it was read; anything else may have landed after all
    return readBack(at, sha, error);
  }
}

/**
 * Records pull request `pr` on `claimant`'s claim of `issue`. It only moves the ref forward from the claim it read, so
 * it fails, and never claims again, when the claim expired, was released or was taken meanwhile.
 * @param {{ gh: Gh, repo: string, issue: number, claimant: string, pr: number, now?: number }} options
 * @returns {Outcome}
 */
export function attach({ gh, repo, issue, claimant, pr, now = Date.now() }) {
  const at = { gh, repo, issue };
  const current = readClaim(at);
  if (current.state !== 'claimed')
    return { ok: false, claim: current, why: `#${issue} is not claimed (released or expired): claim it again` };
  if (current.claimant !== claimant)
    return { ok: false, claim: current, why: `#${issue} is claimed by ${current.claimant} since ${current.at}` };
  const { sha: parent, state: _state, ...record } = current;
  return changeClaim({ gh, repo, issue, from: parent, record: { ...record, pr, attached: new Date(now).toISOString() } });
}

/**
 * Ends the claim at `from` (the commit it was read at) by moving the ref forward to a released commit, which fails when
 * the claim changed since it was read; a ref at a released commit reads as unclaimed, and the next claim moves it
 * forward from there. `remove` (only once the issue is closed, when nobody claims it again) also deletes the ref:
 * GitHub deletes a ref unconditionally, so on an open issue the delete could erase a claim made since the move.
 * @param {{ gh: Gh, repo: string, issue: number, from: string, reason: string, remove?: boolean, now?: number }} options
 * @returns {{ released: boolean, left?: string }} whether it released that claim, and why a ref it was asked to
 * remove is left (at the released commit)
 */
export function retire({ gh, repo, issue, from, reason, remove = false, now = Date.now() }) {
  const sha = writeClaim(gh, repo, { issue, released: reason, at: new Date(now).toISOString() }, from);
  try {
    forward(gh, repo, issue, sha);
  } catch (error) {
    if (httpStatus(error) === 422) return { released: false };
    throw error;
  }
  const left = remove ? removeRef(gh, repo, issue) : null;
  return left ? { released: true, left } : { released: true };
}

/** Deletes the claim ref of a closed issue; why it could not, or null. @param {Gh} gh @param {string} repo @param {number} issue */
export function removeRef(gh, repo, issue) {
  try {
    gh(['api', '-X', 'DELETE', `repos/${repo}/git/refs/heads/${claimRef(issue)}`]);
    return null;
  } catch (error) {
    return httpStatus(error) === 422 ? null : brief(error);
  }
}

/**
 * Releases `claimant`'s claim of `issue` (anyone's with `force`).
 * @param {{ gh: Gh, repo: string, issue: number, claimant: string, force?: boolean, now?: number }} options
 */
export function release({ gh, repo, issue, claimant, force = false, now = Date.now() }) {
  const current = readClaim({ gh, repo, issue });
  if (current.state !== 'claimed') return { ok: true, why: `#${issue} is not claimed` };
  if (current.claimant !== claimant && !force)
    return { ok: false, why: `#${issue} is claimed by ${current.claimant}, not ${claimant}; --force releases it anyway` };
  return retire({ gh, repo, issue, from: current.sha, reason: `released by ${claimant}`, now }).released
    ? { ok: true, why: `released #${issue}` }
    : { ok: false, why: `the claim of #${issue} changed while it was released; read it again` };
}

/**
 * Who this is when --as names nobody: the GitHub login, the machine and the checkout, and the agent session when the
 * harness names it, so two agents of one login, even in one checkout, differ.
 * @param {Gh} gh @param {string} [cwd] @param {Record<string, string | undefined>} [env]
 */
export function defaultClaimant(gh, cwd = process.cwd(), env = process.env) {
  const session = env.CLAUDE_CODE_SESSION_ID || env.CODEX_THREAD_ID;
  return `${gh(['api', 'user', '--jq', '.login']).trim()}@${os.hostname()}:${path.basename(cwd)}${session ? `#${session.slice(0, 8)}` : ''}`;
}

/** `text` as one shell word, for a command a person or agent pastes. */
export const shellWord = (/** @type {string} */ text) =>
  /^[\w@%+=:,./-][\w@%+=:,./#-]*$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;

/** Atomically publishes a claimed record on its expected generation; ambiguous writes are read back before dispatch.
 * @param {{ gh: Gh, repo: string, issue: number, from: string, record: Claim }} options
 * @returns {Outcome} */
export function changeClaim({ gh, repo, issue, from, record }) {
  const sha = writeClaim(gh, repo, record, from);
  try {
    forward(gh, repo, issue, sha);
    return { ok: true, claim: { state: 'claimed', sha, ...record } };
  } catch (error) {
    return readBack({ gh, repo, issue }, sha, error);
  }
}
