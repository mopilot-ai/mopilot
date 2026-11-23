// The PRs a tracked PR is stacked on, as Claude Code's PR bar lists them: its base branch's PR, that PR's base's, and so on.
const { pullRequestUrl } = require('../../shared/pullRequest.mjs');
const { classifyCheck, json, invalid, record, string } = require('./prGithub.cjs');

const FIELDS = 'url,title,state,headRefName,baseRefName,isCrossRepository,statusCheckRollup';
/** As deep as Claude Code follows a stack; a longer chain shows its nearest five parents. */
const MAX_DEPTH = 5;
const repository = (url) => new URL(url).pathname.split('/').slice(1, 3).join('/');

/** A repository's default branch never has a parent PR, so stopping there costs no list call for an unstacked PR. */
async function defaultBranch(run, cwd, repo, defaults) {
  const known = defaults.get(repo);
  if (known) return known;
  const info = await json(run, cwd, ['repo', 'view', repo, '--json', 'defaultBranchRef']);
  if (!record(info) || !record(info.defaultBranchRef) || !string(info.defaultBranchRef.name)) invalid();
  defaults.set(repo, info.defaultBranchRef.name);
  return info.defaultBranchRef.name;
}

/** The PR whose head is `branch` in the PR's own repository: an open one first, else the newest merged or closed. */
async function branchPullRequest(run, cwd, repo, branch) {
  const list = await json(run, cwd, ['pr', 'list', '--repo', repo, '--head', branch, '--state', 'all', '--limit', '10', '--json', FIELDS]);
  if (!Array.isArray(list)) invalid();
  const own = list.filter((pr) => {
    if (
      !record(pr) ||
      !pullRequestUrl(pr.url) ||
      !string(pr.title) ||
      !['OPEN', 'MERGED', 'CLOSED'].includes(pr.state) ||
      !string(pr.headRefName) ||
      !string(pr.baseRefName) ||
      typeof pr.isCrossRepository !== 'boolean' ||
      !Array.isArray(pr.statusCheckRollup)
    )
      invalid();
    // a fork's branch of the same name is not this repository's branch
    return !pr.isCrossRepository && pr.headRefName === branch && repository(pullRequestUrl(pr.url)) === repo;
  });
  return own.find((pr) => pr.state === 'OPEN') ?? own[0] ?? null;
}

/**
 * Walks base branches up from an open PR until the default branch, a branch with no PR, a cycle or MAX_DEPTH.
 * `defaults` caches each repository's default branch for the process; a retired `current` stops the walk before its
 * next GitHub call.
 */
async function readStackParents(run, cwd, pr, defaults, current = () => true) {
  const repo = repository(pr.url);
  const stop = await defaultBranch(run, cwd, repo, defaults);
  const parents = [];
  const seen = new Set([pr.headRefName]);
  let branch = pr.baseRefName;
  while (parents.length < MAX_DEPTH && branch !== stop && !seen.has(branch)) {
    seen.add(branch);
    if (!current()) throw new Error('PR monitoring context changed');
    const parent = await branchPullRequest(run, cwd, repo, branch);
    if (!parent) break;
    const checks = parent.statusCheckRollup.map(classifyCheck);
    parents.push({
      url: pullRequestUrl(parent.url),
      title: parent.title,
      state: parent.state,
      headRefName: parent.headRefName,
      baseRefName: parent.baseRefName,
      failed: checks.filter((c) => c.failed).length,
      pending: checks.filter((c) => c.pending).length,
    });
    branch = parent.baseRefName;
  }
  return parents;
}

module.exports = { readStackParents, MAX_DEPTH };
