// PR parent graph validation, GitHub argv, serialization and retired base-change ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPrStacker } from '../electron/platform/prStack.cjs';
import { deferred } from './support/async-scenarios.ts';

const url = 'https://github.com/org/repo/pull/1';
const parentUrl = 'https://github.com/org/repo/pull/2';
const own = (extra = {}) => ({
  url,
  title: 'Child',
  state: 'OPEN',
  headRefName: 'child',
  baseRefName: 'main',
  isCrossRepository: false,
  ...extra,
});
const parent = (extra = {}) => own({ url: parentUrl, title: 'Parent', headRefName: 'parent', ...extra });
function fixture(responses: any[]) {
  const calls: any[] = [];
  let current = true;
  const api = createPrStacker(async (cmd: string, args: string[], options: any) => {
    calls.push([cmd, args, options]);
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response?.raw ?? { ok: true, stdout: JSON.stringify(response), stderr: '' };
  });
  return {
    calls,
    api,
    retire: () => {
      current = false;
    },
    candidates: (link = url) => api.candidates('/work with spaces', link, () => current),
    stack: (p = parentUrl, link = url) => api.stack('/work with spaces', link, p, () => current),
  };
}

test('parent choices exclude self, descendant chains, fork parents and all duplicate-head paths', async () => {
  const prs = [
    own(),
    parent(),
    parent({ url: parentUrl + '0', headRefName: 'descendant', baseRefName: 'child' }),
    parent({ url: parentUrl + '1', headRefName: 'grandchild', baseRefName: 'descendant' }),
    parent({ url: parentUrl + '2', headRefName: 'fork', isCrossRepository: true }),
    parent({ url: parentUrl + '3', headRefName: 'duplicate', baseRefName: 'main' }),
    parent({ url: parentUrl + '4', headRefName: 'duplicate', baseRefName: 'child' }),
    parent({ url: parentUrl + '5', headRefName: 'loop-a', baseRefName: 'loop-b' }),
    parent({ url: parentUrl + '6', headRefName: 'loop-b', baseRefName: 'loop-a' }),
  ];
  const f = fixture([own(), prs]);
  const { parents } = await f.candidates();
  assert.deepEqual(
    parents.map((p: any) => p.headRefName),
    ['parent'],
  );
  assert.equal(f.calls[1][1].includes('--repo'), true);
  for (const [cmd, , options] of f.calls) {
    assert.equal(cmd, 'gh');
    assert.deepEqual(options, { cwd: '/work with spaces', timeout: 30_000 });
  }
});

test('stacking changes only the captured PR base through argv and accepts canonical case/optional fields', async () => {
  const branch = 'feature/quoted-"$value`';
  const f = fixture([own({ extra: true }), [parent({ url: 'https://github.com/Org/Repo/pull/2', headRefName: branch })], null]);
  await f.stack('https://github.com/Org/Repo/pull/2/?extra=1');
  assert.deepEqual(f.calls.at(-1)[1], ['pr', 'edit', url, '--base', branch]);
  assert.equal(f.calls.length, 3);
  const same = fixture([own({ baseRefName: 'parent' }), [parent()]]);
  await same.stack();
  assert.equal(same.calls.length, 2);
  const forkChild = fixture([own({ isCrossRepository: true }), [parent({ headRefName: 'child' })], null]);
  await forkChild.stack();
  assert.equal(forkChild.calls.at(-1)[1].at(-1), 'child');
});

test('invalid identities, closed PRs, fork parents and cycles never dispatch a mutation', async () => {
  for (const link of ['', '--option', 'https://example.com/o/r/pull/1']) {
    const f = fixture([]);
    await assert.rejects(f.candidates(link), /pull request URL/);
    assert.equal(f.calls.length, 0);
  }
  for (const [p, child] of [
    [url, url],
    ['bad', url],
    [parentUrl, 'bad'],
    [parentUrl.replace('/repo/', '/other/'), url],
  ]) {
    const f = fixture([]);
    await assert.rejects(f.stack(p, child), /another pull request/);
    assert.equal(f.calls.length, 0);
  }
  for (const state of ['CLOSED', 'MERGED']) await assert.rejects(fixture([own({ state })]).stack(), /Only an open/);
  for (const parents of [[], [parent({ isCrossRepository: true })], [parent({ baseRefName: 'child' })]]) {
    const f = fixture([own(), parents]);
    await assert.rejects(f.stack(), /closed, comes from a fork, or would create a stack cycle/);
    assert.equal(f.calls.length, 2);
  }
});

test('incomplete, cross-repository and malformed responses fail closed; optional extras remain valid', async () => {
  for (const source of [
    null,
    [],
    {},
    own({ url: 'bad' }),
    own({ url: url.replace('/repo/', '/other/') }),
    own({ title: null }),
    own({ state: 'FUTURE' }),
    own({ headRefName: '' }),
    own({ baseRefName: null }),
    own({ isCrossRepository: null }),
  ])
    await assert.rejects(fixture([source]).candidates(), /incomplete PR branches/);
  await assert.rejects(fixture([parent()]).candidates(), /another pull request/);
  for (const list of [null, {}, Array.from({ length: 1000 }, () => parent())])
    await assert.rejects(fixture([own(), list]).candidates(), /complete PR stack/);
  for (const list of [[parent(), parent()], [parent({ state: 'CLOSED' })]])
    await assert.rejects(fixture([own(), list]).candidates(), /inconsistent PR stack/);
  await assert.rejects(fixture([own(), [{}]]).candidates(), /incomplete PR branches/);
  for (const response of [
    new Error('timeout'),
    { raw: { ok: false, stderr: 'not signed in' } },
    { raw: { ok: false, stderr: '' } },
    { raw: { ok: true, stdout: '{' } },
  ])
    await assert.rejects(fixture([response]).stack());
});

test('retirement before each command prevents undispatched effects and a pending command remains bounded', async () => {
  for (const stage of [0, 1, 2]) {
    const wait = deferred<any>();
    let current = stage !== 0;
    const calls: string[][] = [];
    const api = createPrStacker(async (_cmd: string, args: string[], options: any) => {
      calls.push(args);
      assert.equal(options.timeout, 30_000);
      if (calls.length === stage) await wait.promise;
      return { ok: true, stdout: JSON.stringify(args[1] === 'view' ? own() : [parent()]), stderr: '' };
    });
    const task = api.stack('/repo', url, parentUrl, () => current);
    // Explicitly observe the operation while its mocked GitHub boundary is unresolved.
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(calls.length, stage);
    current = false;
    wait.resolve(null);
    await assert.rejects(task, /chat or tracked pull request changed/);
    assert.equal(
      calls.some((a) => a[1] === 'edit'),
      false,
    );
  }
});

test('opposite-direction writes serialize and validate the graph after the accepted predecessor', async () => {
  const prs = [own(), parent()];
  const edit = deferred<any>();
  const calls: string[][] = [];
  const api = createPrStacker(async (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[1] === 'edit') {
      await edit.promise;
      prs.find((p) => p.url === args[2])!.baseRefName = args.at(-1)!;
      return { ok: true, stdout: '', stderr: '' };
    }
    const value = args[1] === 'view' ? prs.find((p) => p.url === args[2]) : prs;
    return { ok: true, stdout: JSON.stringify(value), stderr: '' };
  });
  const first = api.stack('/repo', url, parentUrl, () => true);
  const second = api.stack('/repo', parentUrl, url, () => true);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(calls.length, 3);
  assert.equal(calls[0][2], url);
  edit.resolve(null);
  await first;
  await assert.rejects(second, /stack cycle/);
  assert.equal(calls.filter((a) => a[1] === 'edit').length, 1);
  assert.equal(prs[0].baseRefName, 'parent');
});

test('a rejected mutation preserves the queue and a following retry succeeds', async () => {
  const f = fixture([own(), [parent()], { raw: { ok: false, stderr: 'permission denied' } }, own(), [parent()], null]);
  await assert.rejects(f.stack(), /permission denied/);
  await f.stack();
  assert.equal(f.calls.filter((c) => c[1][1] === 'edit').length, 2);
  const retired = fixture([]);
  retired.retire();
  await assert.rejects(retired.stack(), /changed/);
});

test('converging parent paths remain eligible and are not mistaken for cycles', async () => {
  const prs = [parent(), parent({ url: parentUrl + '0' }), parent({ url: parentUrl + '1', headRefName: 'root', baseRefName: 'main' })];
  const { parents } = await fixture([own(), prs]).candidates();
  assert.equal(parents.length, 3);
});

test('retired final reads cannot return old choices or report a no-op base change as successful', async () => {
  for (const action of ['candidates', 'stack']) {
    const graph = deferred<any>();
    let current = true;
    let calls = 0;
    const api = createPrStacker(async (_cmd: string, args: string[]) => {
      calls++;
      const value = args[1] === 'view' ? own({ baseRefName: 'parent' }) : await graph.promise;
      return { ok: true, stdout: JSON.stringify(value), stderr: '' };
    });
    const task = action === 'candidates' ? api.candidates('/repo', url, () => current) : api.stack('/repo', url, parentUrl, () => current);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    assert.equal(calls, 2);
    current = false;
    graph.resolve([parent()]);
    await assert.rejects(task, /chat or tracked pull request changed/);
    assert.equal(calls, 2);
  }
});

test('the largest complete accepted graph keeps every eligible parent in a long dependency chain', async () => {
  const graph = Array.from({ length: 999 }, (_, i) =>
    parent({
      url: `https://github.com/org/repo/pull/${i + 2}`,
      headRefName: `branch-${i}`,
      baseRefName: i === 998 ? 'main' : `branch-${i + 1}`,
    }),
  );
  const { parents } = await fixture([own(), graph]).candidates();
  assert.equal(parents.length, 999);
  assert.equal(parents[0].headRefName, 'branch-0');
  assert.equal(parents.at(-1).baseRefName, 'main');
});

test('retirement between a producer and its caller prevents stale choices and no-op success', async () => {
  for (const action of ['candidates', 'stack']) {
    let current = true;
    let listDone = false;
    let scheduled = false;
    const api = createPrStacker(async (_cmd: string, args: string[]) => {
      listDone = args[1] === 'list';
      return { ok: true, stdout: JSON.stringify(listDone ? [parent()] : own({ baseRefName: 'parent' })), stderr: '' };
    });
    const owned = () => {
      if (listDone && !scheduled) {
        scheduled = true;
        // Retire after the read producer's last ownership check, before its caller resumes.
        if (action === 'candidates')
          queueMicrotask(() => {
            current = false;
          });
        else
          queueMicrotask(() =>
            queueMicrotask(() => {
              current = false;
            }),
          );
      }
      return current;
    };
    const task = action === 'candidates' ? api.candidates('/repo', url, owned) : api.stack('/repo', url, parentUrl, owned);
    await assert.rejects(task, /tracked pull request changed/);
  }
});
