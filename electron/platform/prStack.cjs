// GitHub-owned PR base relationships: validated parent choices and serialized, cycle-safe base changes.
const { pullRequestUrl } = require('../../shared/pullRequest.mjs');

const FIELDS = 'url,title,state,headRefName,baseRefName,isCrossRepository';
const LIMIT = 1000;
const repository = (url) => new URL(url).pathname.split('/').slice(1, 3).join('/');
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const string = (v) => typeof v === 'string' && v.length > 0;

const assertPrStackCurrent = (current) => {
  if (!current()) throw new Error('The chat or tracked pull request changed. Reopen the stack picker.');
};

function validate(pr, repo) {
  const url = pullRequestUrl(pr?.url);
  if (
    !record(pr) ||
    !url ||
    repository(url) !== repo ||
    !string(pr.title) ||
    !['OPEN', 'CLOSED', 'MERGED'].includes(pr.state) ||
    !string(pr.headRefName) ||
    !string(pr.baseRefName) ||
    typeof pr.isCrossRepository !== 'boolean'
  )
    throw new Error('GitHub returned incomplete PR branches. Retry to reload.');
  return { ...pr, url };
}

/** Build one memoized ancestry checker for the whole list, including duplicate heads and existing cycles. */
function parentSafety(prs, target) {
  const bases = new Map();
  for (const pr of prs) {
    if (pr.isCrossRepository) continue;
    const edges = bases.get(pr.headRefName) ?? [];
    edges.push(pr.baseRefName);
    bases.set(pr.headRefName, edges);
  }
  const active = new Set();
  const checked = new Map();
  const visit = (branch) => {
    if (branch === target || active.has(branch)) return true;
    if (checked.has(branch)) return checked.get(branch);
    active.add(branch);
    const unsafe = (bases.get(branch) ?? []).some(visit);
    active.delete(branch);
    checked.set(branch, unsafe);
    return unsafe;
  };
  return visit;
}

/** One instance per main process: opposite-direction edits cannot validate the same old graph concurrently. */
function createPrStacker(run) {
  let tail = Promise.resolve();
  const command = async (cwd, args, current) => {
    assertPrStackCurrent(current);
    const result = await run('gh', args, { cwd, timeout: 30_000 });
    if (!result.ok) throw new Error(result.stderr.trim() || 'GitHub CLI failed. Check that gh is installed and signed in.');
    return result.stdout;
  };
  const read = async (cwd, args, current) => {
    const output = await command(cwd, args, current);
    assertPrStackCurrent(current);
    return JSON.parse(output);
  };
  const candidates = async (cwd, url, current) => {
    if (pullRequestUrl(url) !== url) throw new Error('Enter a GitHub pull request URL.');
    const repo = repository(url);
    const pr = validate(await read(cwd, ['pr', 'view', url, '--json', FIELDS], current), repo);
    if (pr.url !== url) throw new Error('GitHub returned another pull request. Retry to reload.');
    if (pr.state !== 'OPEN') throw new Error('Only an open pull request can be stacked.');
    const raw = await read(cwd, ['pr', 'list', '--repo', repo, '--state', 'open', '--limit', String(LIMIT), '--json', FIELDS], current);
    if (!Array.isArray(raw) || raw.length >= LIMIT) throw new Error('Could not load the complete PR stack. Retry to reload.');
    const prs = raw.map((p) => validate(p, repo));
    if (prs.some((p) => p.state !== 'OPEN') || new Set(prs.map((p) => p.url)).size !== prs.length)
      throw new Error('GitHub returned an inconsistent PR stack. Retry to reload.');
    const unsafe = parentSafety(prs, pr.isCrossRepository ? null : pr.headRefName);
    assertPrStackCurrent(current);
    return {
      pr,
      parents: prs.filter((p) => p.url !== url && !p.isCrossRepository && !unsafe(p.headRefName)),
    };
  };
  const stack = (cwd, url, parentUrl, current) => {
    const task = tail.then(async () => {
      const parent = pullRequestUrl(parentUrl);
      if (!parent || parent === url || pullRequestUrl(url) !== url || repository(parent) !== repository(url))
        throw new Error('Choose another pull request in the same repository.');
      // Re-read at execution time: picker data and an earlier queued edit are never authority for this write.
      const { pr, parents } = await candidates(cwd, url, current);
      assertPrStackCurrent(current);
      const choice = parents.find((p) => p.url === parent);
      if (!choice) throw new Error('That PR is closed, comes from a fork, or would create a stack cycle. Choose another PR.');
      if (pr.baseRefName !== choice.headRefName) await command(cwd, ['pr', 'edit', url, '--base', choice.headRefName], current);
    });
    tail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  };
  return { candidates, stack };
}

module.exports = { createPrStacker, assertPrStackCurrent };
