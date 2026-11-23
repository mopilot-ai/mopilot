// GitHub review-comment dispatch validates the current context, local HEAD/status and the displayed patch against GitHub before posting.
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { installNativeStub } from './support/ports/native.ts';
import { parseUnifiedDiff } from '../src/lib/diff.ts';
const patch = '--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-before\n+after';
const file = parseUnifiedDiff(patch)[0];
let local: { ok: boolean; stdout: string } = { ok: true, stdout: 'abc' };
let status: { files: { path: string; code: string }[] } | null = { files: [] };
let remote: unknown = { headRefOid: 'abc', state: 'OPEN' };
let actualPatch = patch;
let posts: string[][] = [];
installNativeStub({
  git: {
    run: async () => ({ ...local, stderr: '', code: local.ok ? 0 : 1 }),
    status: async () => status,
    gh: async (_cwd: string, args: string[]) => {
      if (args[1] === 'view') return { ok: true, stdout: JSON.stringify(remote), stderr: '', code: 0 };
      if (args[1] === 'diff') return { ok: true, stdout: actualPatch, stderr: '', code: 0 };
      posts.push(args);
      return { ok: true, stdout: '{}', stderr: '', code: 0 };
    },
  },
});
const { postReviewComment, readBranchReview } = await import('../src/lib/prReviewGit.ts');
const review = { pr: { owner: 'o', name: 'r', number: 7, url: 'https://github.com/o/r/pull/7' }, head: 'abc', threads: [], limited: false };
const range = { path: 'a.ts', startSide: 'R' as const, endSide: 'R' as const, startLine: 1, endLine: 1, hunk: '+after' };
beforeEach(() => {
  local = { ok: true, stdout: 'abc' };
  status = { files: [] };
  remote = { headRefOid: 'abc', state: 'OPEN' };
  actualPatch = patch;
  posts = [];
});

test('matching PR and local snapshots allow one post; a retired context allows none', async () => {
  await postReviewComment('/r', review, range, 'comment', file, () => true);
  assert.equal(posts.length, 1);
  await assert.rejects(
    postReviewComment('/r', review, range, 'comment', file, () => false),
    /review changed/,
  );
  assert.equal(posts.length, 1);
});

test('uncommitted or unpushed changes, unknown status, moved PR heads and replaced patches refuse the write', async () => {
  for (const change of [
    () => {
      status = null;
    },
    () => {
      status = { files: [{ path: 'a.ts', code: ' M' }] };
    },
    () => {
      local = { ok: true, stdout: 'unpushed' };
    },
    () => {
      local = { ok: false, stdout: '' };
    },
    () => {
      remote = { headRefOid: 'moved', state: 'OPEN' };
    },
    () => {
      remote = { headRefOid: 'abc', state: 'CLOSED' };
    },
    () => {
      remote = null;
    },
    () => {
      actualPatch = '';
    },
    () => {
      actualPatch = patch.replace('+after', '+different');
    },
  ]) {
    local = { ok: true, stdout: 'abc' };
    status = { files: [] };
    remote = { headRefOid: 'abc', state: 'OPEN' };
    actualPatch = patch;
    change();
    await assert.rejects(
      postReviewComment('/r', review, range, 'comment', file, () => true),
      /lines differ/,
    );
    assert.equal(posts.length, 0);
  }
});

test('malformed branch metadata rejects rather than pretending the branch has no PR', async () => {
  remote = null;
  await assert.rejects(readBranchReview('/r'));
});

test('a valid old-side comment sends LEFT rather than retargeting the replacement line', async () => {
  await postReviewComment('/r', review, { ...range, startSide: 'L', endSide: 'L' }, 'Old line', file, () => true);
  assert.ok(posts[0].includes('side=LEFT'));
  assert.equal(posts.length, 1);
});
