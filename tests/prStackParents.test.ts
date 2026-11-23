// The PRs a tracked PR is stacked on: the base-branch walk, its stops, the default-branch cache and response contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readStackParents, MAX_DEPTH } from '../electron/platform/prStackParents.cjs';

const repo = 'org/repo';
const tracked = { url: `https://github.com/${repo}/pull/9`, headRefName: 'feature/c', baseRefName: 'feature/b' };
const pr = (n: number, head: string, base: string, extra: Record<string, unknown> = {}) => ({
  url: `https://github.com/${repo}/pull/${n}`,
  title: `PR ${n}`,
  state: 'OPEN',
  headRefName: head,
  baseRefName: base,
  isCrossRepository: false,
  statusCheckRollup: [] as unknown[],
  ...extra,
});
const check = (extra = {}) => ({ __typename: 'CheckRun', name: 'unit-tests', status: 'COMPLETED', conclusion: 'SUCCESS', ...extra });

/** A fake gh: `repo view` answers the default branch; `pr list --head X` answers lists[X] (none for an unknown branch). */
function fixture(lists: Record<string, unknown>, defaultBranch: unknown = { defaultBranchRef: { name: 'main' } }) {
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[], opts: any) => {
    calls.push(args);
    assert.equal(cmd, 'gh');
    assert.equal(opts.cwd, '/work');
    assert.equal(opts.timeout, 30_000);
    const answer = args[0] === 'repo' ? defaultBranch : (lists[args[args.indexOf('--head') + 1]] ?? []);
    if (answer instanceof Error) return { ok: false, stdout: '', stderr: answer.message };
    return { ok: true, stdout: JSON.stringify(answer), stderr: '' };
  };
  const defaults = new Map<string, string>();
  return { calls, defaults, read: (from = tracked, current?: () => boolean) => readStackParents(run, '/work', from, defaults, current) };
}

test('walks base branches to the default branch, nearest parent first, with each parent’s state and CI counts', async () => {
  const f = fixture({
    'feature/b': [
      pr(8, 'feature/b', 'feature/a', {
        statusCheckRollup: [
          check({ conclusion: 'FAILURE' }),
          check({ name: 'lint', status: 'IN_PROGRESS', conclusion: '' }),
          { __typename: 'StatusContext', context: 'gate', state: 'PENDING' },
          check({ name: 'ok' }),
        ],
      }),
    ],
    'feature/a': [pr(7, 'feature/a', 'main', { state: 'MERGED', url: 'https://github.com/Org/Repo/pull/7/' })],
  });
  assert.deepEqual(await f.read(), [
    {
      url: `https://github.com/${repo}/pull/8`,
      title: 'PR 8',
      state: 'OPEN',
      headRefName: 'feature/b',
      baseRefName: 'feature/a',
      failed: 1,
      pending: 2,
    },
    // the URL is canonical, and a merged parent still names its own base
    {
      url: `https://github.com/${repo}/pull/7`,
      title: 'PR 7',
      state: 'MERGED',
      headRefName: 'feature/a',
      baseRefName: 'main',
      failed: 0,
      pending: 0,
    },
  ]);
  assert.deepEqual(f.calls[0], ['repo', 'view', repo, '--json', 'defaultBranchRef']);
  assert.deepEqual(f.calls[1].slice(0, 9), ['pr', 'list', '--repo', repo, '--head', 'feature/b', '--state', 'all', '--limit']);
  assert.equal(f.calls.length, 3);
  // the default branch is read once per repository; a PR based on it costs no list call
  f.calls.length = 0;
  assert.deepEqual(await f.read({ ...tracked, baseRefName: 'main' }), []);
  assert.deepEqual(f.calls, []);
});

test('an open PR wins over older merged ones; forks, other heads and other repositories are never a parent', async () => {
  const fork = pr(20, 'feature/b', 'main', { isCrossRepository: true });
  const other = pr(21, 'feature/other', 'main');
  const elsewhere = pr(22, 'feature/b', 'main', { url: 'https://github.com/org/else/pull/22' });
  const merged = pr(23, 'feature/b', 'release', { state: 'MERGED' });
  const open = pr(24, 'feature/b', 'main');
  let f = fixture({ 'feature/b': [fork, other, elsewhere, merged, open] });
  assert.deepEqual(
    (await f.read()).map((p: any) => p.url),
    [open.url],
  );
  // with no open one, the newest (first listed) closed or merged PR stands for the branch
  f = fixture({ 'feature/b': [fork, pr(25, 'feature/b', 'main', { state: 'CLOSED' }), merged] });
  assert.deepEqual(
    (await f.read()).map((p: any) => [p.url.split('/').at(-1), p.state]),
    [['25', 'CLOSED']],
  );
  // a base branch with only a fork's PR, or none at all, ends the stack
  f = fixture({ 'feature/b': [fork] });
  assert.deepEqual(await f.read(), []);
});

test('a cycle in the base branches stops at the first repeat, and a long stack stops at the nearest five', async () => {
  let f = fixture({ 'feature/b': [pr(8, 'feature/b', 'feature/c')], 'feature/c': [pr(9, 'feature/c', 'feature/b')] });
  assert.deepEqual(
    (await f.read()).map((p: any) => p.headRefName),
    ['feature/b'],
  );
  f = fixture({ 'feature/b': [pr(8, 'feature/b', 'feature/b')] });
  assert.equal((await f.read()).length, 1);
  const lists: Record<string, unknown> = {};
  for (let i = 0; i < 8; i++) lists[`s${i}`] = [pr(100 + i, `s${i}`, `s${i + 1}`)];
  f = fixture(lists);
  const parents = await f.read({ ...tracked, baseRefName: 's0' });
  assert.equal(MAX_DEPTH, 5);
  assert.deepEqual(
    parents.map((p: any) => p.headRefName),
    ['s0', 's1', 's2', 's3', 's4'],
  );
  assert.equal(f.calls.length, 1 + MAX_DEPTH);
});

test('malformed default branches, lists, records and checks fail the read instead of inventing a stack', async () => {
  for (const bad of [null, {}, { defaultBranchRef: null }, { defaultBranchRef: { name: '' } }, new Error('gh auth')]) {
    const f = fixture({}, bad);
    await assert.rejects(f.read(), /GitHub returned incomplete PR data|gh auth/);
    // a failed read caches nothing, so the next read asks again
    assert.equal(f.defaults.size, 0);
  }
  for (const bad of [
    {},
    [null],
    [pr(8, 'feature/b', 'main', { url: 'https://example.com/x' })],
    [pr(8, 'feature/b', 'main', { title: '' })],
    [pr(8, 'feature/b', 'main', { state: 'DRAFT' })],
    [pr(8, '', 'main')],
    [pr(8, 'feature/b', '')],
    [pr(8, 'feature/b', 'main', { isCrossRepository: 'no' })],
    [pr(8, 'feature/b', 'main', { statusCheckRollup: null })],
    [pr(8, 'feature/b', 'main', { statusCheckRollup: [check({ status: 'SOMEDAY' })] })],
    new Error('rate limited'),
  ]) {
    await assert.rejects(fixture({ 'feature/b': bad }).read(), /GitHub returned incomplete PR data|rate limited/);
  }
});

test('a retired monitor context stops the walk before its next GitHub call', async () => {
  let live = true;
  const f = fixture({ 'feature/b': [pr(8, 'feature/b', 'feature/a')], 'feature/a': [pr(7, 'feature/a', 'main')] });
  const read = f.read(tracked, () => live);
  // the default branch read is under way; the context retires before the first parent is asked for
  live = false;
  await assert.rejects(read, /context changed/);
  assert.deepEqual(
    f.calls.map((c) => c[0]),
    ['repo'],
  );
});
