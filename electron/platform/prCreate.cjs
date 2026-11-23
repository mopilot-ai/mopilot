// Create a pull request for a folder's branch without the browser: its prefilled draft, the push, gh pr create, and the web form as fallback.
const { pullRequestUrl } = require('../../shared/pullRequest.mjs');

/** @typedef {(cmd: string, args: string[], opts: { cwd: string, timeout: number }) => Promise<{ ok: boolean, stdout: string, stderr: string }>} Run */

const GIT_MS = 10_000;
const PUSH_MS = 120_000;
const GH_MS = 30_000;
/** As many commits as the draft's body lists. */
const MAX_COMMITS = 50;
const MAX_TITLE = 256;
const MAX_BODY = 60_000;
const MAX_MESSAGE = 400;

/** A refusal with the sentence the window shows for it (`text`, written here: never a bare code or exit status). */
const refuse = (reason, text) => ({ status: /** @type {const} */ ('refused'), reason, text });
/** A branch name that is safe as one argv entry and inside a refspec: never an option, a range or a ref expression. */
const safeRef = (v) =>
  typeof v === 'string' && v.length > 0 && v.length <= 255 && !v.startsWith('-') && !/[\s~^:?*[\\\0-\x1f\x7f]|\.\./.test(v);
const brief = (text, fallback) => text.trim().slice(0, MAX_MESSAGE) || fallback;
/** gh's own words for "not signed in". */
const signInProblem = (text) => /gh auth login|not logged in|authentication (failed|required)|HTTP 401|bad credentials/i.test(text);
/** A command that failed without a word: killed at its time limit, or not installed. Never taken for a sign-in problem. */
const NO_ANSWER = 'GitHub CLI did not answer: it timed out or is not installed.';
const SIGN_IN = 'GitHub CLI is not signed in. Run `gh auth login` in a terminal, then try again.';
/** The first canonical pull request URL in gh's output. */
const urlIn = (text) => {
  for (const word of text.split(/\s+/)) {
    const url = pullRequestUrl(word);
    if (url) return url;
  }
  return null;
};

/** The branch checked out in `cwd`, or null (detached, or not a repository). */
async function currentBranch(/** @type {Run} */ run, cwd) {
  const r = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: GIT_MS });
  const branch = r.ok ? r.stdout.trim() : '';
  return branch && branch !== 'HEAD' ? branch : null;
}

/** The remote's default branch as the clone knows it, or null. */
async function remoteDefault(/** @type {Run} */ run, cwd) {
  const r = await run('git', ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { cwd, timeout: GIT_MS });
  const name = r.ok ? r.stdout.trim().replace(/^origin\//, '') : '';
  return safeRef(name) ? name : null;
}

/**
 * The form's starting values. The base is the stack parent's branch when the chat's commits sit on it, else the branch
 * the worktree was cut from, else the remote's default; the title and body come from the commits the base lacks.
 * @param {Run} run
 * @param {string} cwd
 * @param {{ sourceBranch: string | null | undefined, stackParent: string | null | undefined }} from
 */
async function draftPullRequest(run, cwd, { sourceBranch, stackParent }) {
  const branch = await currentBranch(run, cwd);
  if (!branch) return refuse('detached', 'The folder is not on a branch with commits. Commit on a branch before creating a pull request.');
  /** @type {string | null} */
  let base = null;
  if (safeRef(stackParent) && stackParent !== branch) {
    const on = await run('git', ['merge-base', '--is-ancestor', `origin/${stackParent}`, 'HEAD'], { cwd, timeout: GIT_MS });
    if (on.ok) base = /** @type {string} */ (stackParent);
  }
  const stacked = base !== null;
  base ??= safeRef(sourceBranch) && sourceBranch !== branch ? /** @type {string} */ (sourceBranch) : await remoteDefault(run, cwd);
  if (base === branch) return refuse('on_base', `${branch} is the base branch. Switch to another branch before creating a pull request.`);
  const format = '--format=%s%x1f%b%x1e';
  const ahead = base
    ? await run('git', ['log', '--reverse', `--max-count=${MAX_COMMITS}`, format, `origin/${base}..HEAD`], { cwd, timeout: GIT_MS })
    : null;
  // an unknown or unfetched base still gets the newest commit's words
  const log = ahead?.ok ? ahead : await run('git', ['log', '--max-count=1', format, 'HEAD'], { cwd, timeout: GIT_MS });
  const commits = (log.ok ? log.stdout : '')
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [subject, body] = entry.split('\x1f');
      return { subject: subject.trim(), body: (body ?? '').trim() };
    });
  return {
    status: /** @type {const} */ ('draft'),
    branch,
    base: base ?? '',
    stacked,
    title: (commits[0]?.subject ?? '').slice(0, MAX_TITLE),
    body: commits.length > 1 ? commits.map((c) => `- ${c.subject}`).join('\n') : (commits[0]?.body ?? ''),
    commits: commits.length,
  };
}

/**
 * Push `branch` and create its pull request. gh's refusal to create it here (a required template, a missing scope)
 * opens GitHub's form with the same words instead, and says why. Nothing is retried; the caller keeps the input.
 * @param {Run} run
 * @param {string} cwd
 * @param {{ title: string, body: string, base: string, branch: string }} input
 */
async function createPullRequest(run, cwd, input) {
  const { title, body, base, branch } = input ?? {};
  if (typeof title !== 'string' || !title.trim() || title.length > MAX_TITLE) return refuse('invalid', 'Enter a title.');
  if (typeof body !== 'string' || body.length > MAX_BODY) return refuse('invalid', 'The description is too long.');
  if (base !== '' && !safeRef(base)) return refuse('invalid', 'Enter a valid base branch.');
  if (!safeRef(branch)) return refuse('invalid', 'The branch name is not valid.');
  const now = await currentBranch(run, cwd);
  if (now !== branch)
    return refuse('branch_changed', `The folder is now on ${now ?? 'a detached commit'}, not ${branch}. Reopen the form to start again.`);
  const push = await run('git', ['push', '--set-upstream', 'origin', `refs/heads/${branch}:refs/heads/${branch}`], {
    cwd,
    timeout: PUSH_MS,
  });
  if (!push.ok) return refuse('push_failed', `Couldn’t push ${branch}: ${brief(push.stderr, 'git failed')}`);
  const words = ['--title', title.trim(), '--body', body, '--head', branch, ...(base ? ['--base', base] : [])];
  const made = await run('gh', ['pr', 'create', ...words], { cwd, timeout: GH_MS });
  if (made.ok) {
    const url = urlIn(made.stdout);
    return url
      ? { status: /** @type {const} */ ('created'), url }
      : refuse('no_url', 'GitHub created the pull request but did not return its link. Use “Track pull request…” to attach it.');
  }
  const existing = /already exists/i.test(made.stderr) ? urlIn(made.stderr) : null;
  if (existing) return { status: /** @type {const} */ ('exists'), url: existing };
  if (signInProblem(made.stderr)) return refuse('gh_auth', SIGN_IN);
  const why = brief(made.stderr, NO_ANSWER);
  if (/no commits between/i.test(made.stderr)) return refuse('no_commits', why);
  const web = await run('gh', ['pr', 'create', '--web', ...words], { cwd, timeout: GH_MS });
  if (!web.ok) return refuse('gh_failed', `${why} GitHub’s form could not be opened either: ${brief(web.stderr, 'gh failed')}`);
  return { status: /** @type {const} */ ('web'), why };
}

module.exports = { draftPullRequest, createPullRequest, currentBranch, signInProblem, safeRef, SIGN_IN, NO_ANSWER, MAX_COMMITS };
