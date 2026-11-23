// src/lib/prReviewThreads.ts and src/lib/prReviewGit.ts: GitHub's review threads read defensively, the order Next
// unresolved comment walks, the branch's open PR read through gh, and a line comment posted with its range.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { installNativeStub } from './support/ports/native.ts';
import {
  answerReviewRequest,
  nextUnresolved,
  parseReviewThreads,
  prRef,
  unresolvedOrder,
  type ReviewThread,
} from '../src/lib/prReviewThreads.ts';

const PATCH = '--- a/src/a.ts\n+++ b/src/a.ts\n@@ -3,2 +3,2 @@\n-first old\n-old\n+first new\n+new';
const { parseUnifiedDiff } = await import('../src/lib/diff.ts');
const expected = parseUnifiedDiff(PATCH)[0];
const ghCalls: string[][] = [];
let answers: ((args: string[]) => { ok: boolean; stdout?: string; stderr?: string }) | null = null;
installNativeStub({
  git: {
    run: async () => ({ ok: true, stdout: 'abc', stderr: '', code: 0 }),
    status: async () => ({ files: [] }),
    gh: async (_cwd: string, args: string[]) => {
      ghCalls.push(args);
      const r =
        args[0] === 'pr' && args[1] === 'diff'
          ? { ok: true, stdout: PATCH }
          : args[0] === 'pr' && args.includes('headRefOid,state')
            ? { ok: true, stdout: JSON.stringify({ headRefOid: 'abc', state: 'OPEN' }) }
            : answers!(args);
      return { code: r.ok ? 0 : 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '', ...r };
    },
  },
});
const { readBranchReview, postReviewComment } = await import('../src/lib/prReviewGit.ts');

beforeEach(() => {
  ghCalls.length = 0;
  answers = null;
});
const node = (over: Record<string, unknown> = {}) => ({
  id: 'T1',
  path: 'src/a.ts',
  line: 3,
  diffSide: 'RIGHT',
  isResolved: false,
  isOutdated: false,
  comments: {
    pageInfo: { hasNextPage: false },
    nodes: [{ id: 'C1', author: { login: 'ana' }, body: 'Rename this', url: 'https://github.com/o/r/pull/7#c1' }],
  },
  ...over,
});
const answer = (nodes: unknown[], head: unknown = 'abc123') => ({
  data: { repository: { pullRequest: { headRefOid: head, reviewThreads: { pageInfo: { hasNextPage: false }, nodes } } } },
});

test('a github.com pull request URL names its owner, repository and number; anything else names none', () => {
  assert.deepEqual(prRef('https://github.com/o/r/pull/7'), { owner: 'o', name: 'r', number: 7 });
  assert.deepEqual(prRef('https://github.com/o/r/pull/7/files#x'), { owner: 'o', name: 'r', number: 7 });
  for (const url of ['https://gitlab.com/o/r/pull/7', 'https://github.com/o/r/issues/7', 'https://github.com/o/r/pull/x', ''])
    assert.equal(prRef(url), null, url);
});

test('threads are read with their line, side, state and comments; unreadable ones are left out', () => {
  const { head, threads } = parseReviewThreads(
    answer([
      node(),
      node({ id: 'T2', line: null, diffSide: 'LEFT', isResolved: true, isOutdated: true }),
      node({ id: 'T3', line: 0 }),
      node({
        id: 'T4',
        comments: { pageInfo: { hasNextPage: false }, nodes: [{ id: 'C', body: 'ghost', author: null }, { id: 'X' }, null] },
      }),
      node({ id: 'T5', comments: { pageInfo: { hasNextPage: false }, nodes: [] } }),
      node({ id: 'T6', comments: null }),
      node({ id: '' }),
      node({ path: 7 }),
      null,
      'nope',
    ]),
  );
  assert.equal(head, 'abc123');
  assert.deepEqual(
    threads.map((t) => [t.id, t.line, t.side, t.resolved, t.outdated, t.comments.map((c) => `${c.author}:${c.body}:${c.url}`)]),
    [
      ['T1', 3, 'R', false, false, ['ana:Rename this:https://github.com/o/r/pull/7#c1']],
      ['T2', null, 'L', true, true, ['ana:Rename this:https://github.com/o/r/pull/7#c1']],
      ['T3', null, 'R', false, false, ['ana:Rename this:https://github.com/o/r/pull/7#c1']],
      ['T4', 3, 'R', false, false, ['ghost:ghost:']],
    ],
  );
  assert.throws(() => parseReviewThreads(answer('not a list' as any, 7)), /incomplete/);
  assert.throws(() => parseReviewThreads({ data: { repository: { pullRequest: {} } } }), /incomplete/);
});

test('an answer without the pull request is an error, never "no comments"', () => {
  for (const bad of [null, {}, { data: null }, { data: { repository: null } }, { data: { repository: { pullRequest: [] } } }])
    assert.throws(() => parseReviewThreads(bad), /did not send/);
});

test('Next unresolved comment walks the open threads by file and line, going round', () => {
  const t = (id: string, path: string, line: number | null, resolved = false) => ({ id, path, line, resolved }) as ReviewThread;
  const threads = [t('b2', 'b.ts', 2), t('a9', 'a.ts', 9), t('done', 'a.ts', 1, true), t('a-gone', 'a.ts', null), t('a3', 'a.ts', 3)];
  assert.deepEqual(
    unresolvedOrder(threads).map((x) => x.id),
    ['a-gone', 'a3', 'a9', 'b2'],
  );
  assert.equal(nextUnresolved(threads, null)?.id, 'a-gone');
  assert.equal(nextUnresolved(threads, 'a9')?.id, 'b2');
  assert.equal(nextUnresolved(threads, 'b2')?.id, 'a-gone');
  assert.equal(nextUnresolved(threads, 'done')?.id, 'a-gone', 'a resolved or gone one starts over');
  assert.equal(nextUnresolved([t('x', 'a', 1, true)], null), null);
  assert.match(answerReviewRequest({ owner: 'o', name: 'r', number: 7 }), /unresolved review comments on o\/r#7/);
});

test("the branch's open PR is read with its threads; no PR, a closed one or no GitHub reads as none", async () => {
  answers = (args) =>
    args[0] === 'pr'
      ? { ok: true, stdout: JSON.stringify({ url: 'https://github.com/o/r/pull/7', state: 'OPEN' }) }
      : { ok: true, stdout: JSON.stringify(answer([node()])) };
  const review = await readBranchReview('/repo');
  assert.deepEqual(review?.pr, { owner: 'o', name: 'r', number: 7, url: 'https://github.com/o/r/pull/7' });
  assert.equal(review?.threads.length, 1);
  assert.deepEqual(ghCalls[1].slice(-6), ['-f', 'owner=o', '-f', 'name=r', '-F', 'number=7']);
  for (const view of [
    { ok: false, stderr: 'no pull requests found for branch "x"' },
    { ok: true, stdout: JSON.stringify({ url: 'https://github.com/o/r/pull/7', state: 'MERGED' }) },
  ]) {
    answers = () => view;
    assert.equal(await readBranchReview('/repo'), null, JSON.stringify(view));
  }
});

test("an open PR whose threads can't be read rejects with gh's reason", async () => {
  answers = (args) =>
    args[0] === 'pr'
      ? { ok: true, stdout: JSON.stringify({ url: 'https://github.com/o/r/pull/7', state: 'OPEN' }) }
      : { ok: false, stderr: 'HTTP 502\nmore' };
  await assert.rejects(readBranchReview('/repo'), /HTTP 502$/);
});

test('a line comment goes on the PR head at its line and side; a range adds its start; failures reject', async () => {
  answers = () => ({ ok: true, stdout: '{}' });
  const review = { pr: { owner: 'o', name: 'r', number: 7, url: '' }, head: 'abc', threads: [], limited: false };
  const range = { path: 'src/a.ts', startSide: 'R' as const, startLine: 4, endSide: 'R' as const, endLine: 4, hunk: '' };
  await postReviewComment('/repo', review, range, 'Looks off', expected, () => true);
  assert.deepEqual(
    ghCalls.find((args) => args[1]?.endsWith('/comments')),
    [
      'api',
      'repos/o/r/pulls/7/comments',
      '-f',
      'body=Looks off',
      '-f',
      'commit_id=abc',
      '-f',
      'path=src/a.ts',
      '-F',
      'line=4',
      '-f',
      'side=RIGHT',
    ],
  );
  await postReviewComment('/repo', review, { ...range, startSide: 'R', startLine: 3 }, 'x', expected, () => true);
  assert.deepEqual(ghCalls.findLast((args) => args[1]?.endsWith('/comments'))!.slice(-4), ['-F', 'start_line=3', '-f', 'start_side=RIGHT']);
  await assert.rejects(
    postReviewComment('/repo', { ...review, head: null }, range, 'x', expected, () => true),
    /which commit/,
  );
  answers = () => ({ ok: false, stderr: 'Validation Failed' });
  await assert.rejects(
    postReviewComment('/repo', review, range, 'x', expected, () => true),
    /Validation Failed/,
  );
  answers = () => ({ ok: false, stderr: '' });
  await assert.rejects(
    postReviewComment('/repo', review, range, 'x', expected, () => true),
    /gh failed/,
  );
});

test('partial connections disclose their limit, including a truncated comment conversation', () => {
  const raw = answer([node({ comments: { pageInfo: { hasNextPage: true }, nodes: [{ id: 'c', body: 'first page' }] } })]);
  assert.equal(parseReviewThreads(raw).limited, true);
  assert.equal(
    parseReviewThreads({
      data: { repository: { pullRequest: { headRefOid: 7, reviewThreads: { nodes: [], pageInfo: { hasNextPage: true } } } } },
    }).limited,
    true,
  );
  assert.equal(parseReviewThreads(answer([])).limited, false);
});

test('gh or JSON errors while finding a branch PR propagate for the pane to show Retry', async () => {
  for (const result of [
    { ok: false, stderr: 'Authentication required' },
    { ok: false },
    { ok: true, stdout: 'broken JSON' },
    { ok: true, stdout: JSON.stringify({ url: 5, state: 'OPEN' }) },
  ]) {
    answers = () => result;
    await assert.rejects(readBranchReview('/repo'));
  }
});

test('numeric and boolean-looking repository names remain GraphQL strings', async () => {
  answers = (args) =>
    args[0] === 'pr'
      ? { ok: true, stdout: JSON.stringify({ url: 'https://github.com/123/true/pull/7', state: 'OPEN' }) }
      : { ok: true, stdout: JSON.stringify(answer([])) };
  await readBranchReview('/repo');
  assert.deepEqual(ghCalls[1].slice(-6), ['-f', 'owner=123', '-f', 'name=true', '-F', 'number=7']);
});
