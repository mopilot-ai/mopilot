// Merge a tracked pull request through gh, pinned to the head the user saw, with the repository's allowed method and a named refusal.
const { pullRequestUrl } = require('../../shared/pullRequest.mjs');
const { mergeBlock } = require('../../shared/prMergeGate.mjs');
const { readPullRequest, json, invalid, record, string } = require('./prGithub.cjs');
const { signInProblem, SIGN_IN, NO_ANSWER } = require('./prCreate.cjs');

const MERGE_MS = 60_000;
const MAX_MESSAGE = 400;
/** In the order tried when the viewer's default method is not allowed. */
const METHODS = [
  { name: 'SQUASH', flag: '--squash', field: 'squashMergeAllowed' },
  { name: 'MERGE', flag: '--merge', field: 'mergeCommitAllowed' },
  { name: 'REBASE', flag: '--rebase', field: 'rebaseMergeAllowed' },
];
/** A refusal with the sentence the window shows for it (`text`, written here: never a bare code or exit status). */
const refuse = (reason, text) => ({ status: /** @type {const} */ ('refused'), reason, text });
const repository = (url) => new URL(url).pathname.split('/').slice(1, 3).join('/');
const HEAD_MOVED = 'The pull request has new commits since you looked. Review them, then merge again.';

/** Why gh could not read or merge, as a refusal the row can show. */
function ghRefusal(text) {
  if (signInProblem(text)) return refuse('gh_auth', SIGN_IN);
  const message = text.trim().slice(0, MAX_MESSAGE) || NO_ANSWER;
  if (/head branch was modified|expected head|head (sha|commit|ref)[^.\n]*match/i.test(text)) return refuse('head_moved', HEAD_MOVED);
  if (/base branch was modified/i.test(text))
    return refuse('base_moved', 'The base branch changed while merging. Nothing was merged; try again.');
  if (/conflict/i.test(text)) return refuse('conflicts', message);
  if (
    /protected branch|branch protection|required status|review is required|approving review|not mergeable|rule violation|ruleset|merge queue|not authorized|HTTP 405/i.test(
      text,
    )
  )
    return refuse('protected', `GitHub refused the merge: ${message}`);
  return refuse('gh_failed', message);
}

/** The method the repository allows: the viewer's default when allowed, else the first allowed; null when none is. */
async function mergeMethod(run, cwd, repo) {
  const info = await json(run, cwd, ['repo', 'view', repo, '--json', `${METHODS.map((m) => m.field).join(',')},viewerDefaultMergeMethod`]);
  if (!record(info) || METHODS.some((m) => typeof info[m.field] !== 'boolean')) invalid();
  const allowed = METHODS.filter((m) => info[m.field]);
  return allowed.find((m) => m.name === info.viewerDefaultMergeMethod) ?? allowed[0] ?? null;
}

/**
 * Re-read the pull request, refuse a head other than `head` or anything the shared gate blocks, then merge that exact
 * head. `current` retires the merge before its write when the chat or its tracked PR changed meanwhile.
 * @param {(cmd: string, args: string[], opts: object) => Promise<{ ok: boolean, stdout: string, stderr: string }>} run
 * @param {string} cwd
 * @param {string} url
 * @param {string} head the head commit the user's button was drawn for
 * @param {() => boolean} [current]
 */
async function mergePullRequest(run, cwd, url, head, current = () => true) {
  if (pullRequestUrl(url) !== url || !string(head) || !/^[0-9a-f]{7,64}$/i.test(head))
    throw new Error('Invalid pull request merge request');
  let method;
  try {
    const pr = await readPullRequest(run, cwd, url, false);
    if (pr.head !== head) return refuse('head_moved', HEAD_MOVED);
    const block = mergeBlock(pr);
    if (block) return refuse(block.reason, block.message);
    method = await mergeMethod(run, cwd, repository(url));
  } catch (error) {
    return ghRefusal(error.message);
  }
  if (!method) return refuse('no_method', 'This repository allows no merge method. Change its settings on GitHub.');
  if (!current()) return refuse('retired', 'The chat or its pull request changed. Nothing was merged.');
  const merged = await run('gh', ['pr', 'merge', url, '--match-head-commit', head, method.flag], { cwd, timeout: MERGE_MS });
  // gh's exit is not the answer: it exits 0 after only queueing the pull request (a merge queue), and a merge can land
  // although gh was killed at its time limit. What GitHub now says of the pull request is.
  const state = await readPullRequest(run, cwd, url, false).then(
    (pr) => pr.state,
    () => null,
  );
  if (state === 'MERGED') return { status: /** @type {const} */ ('merged'), method: method.name };
  if (!merged.ok) return ghRefusal(merged.stderr);
  return {
    status: /** @type {const} */ ('accepted'),
    text: 'GitHub accepted the merge, but the pull request is not merged yet (a merge queue, or GitHub is still finishing). Its row shows when it lands.',
  };
}

module.exports = { mergePullRequest, mergeMethod, ghRefusal };
