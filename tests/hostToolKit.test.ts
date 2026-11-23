// The shared helpers of the host tools (electron/capabilities/tools/hostToolKit.cjs): how a card's answer is read and how
// sizes and counts are worded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { askUser, plural, sizeText } = require('../electron/capabilities/tools/hostToolKit.cjs');

test('askUser: only an allow is a yes, the chosen button comes with it, and no answer is a no', async () => {
  const card = { title: 't', message: 'm', choices: [] };
  const ask = (answer: any) => async () => answer;
  assert.deepEqual(await askUser(ask({ decision: 'allow', choice: 'b' }), 'c', { signal: null }, card), { allowed: true, choice: 'b' });
  assert.deepEqual(await askUser(ask({ decision: 'allow' }), 'c', { signal: null }, card), { allowed: true, choice: null });
  assert.deepEqual(await askUser(ask({ decision: 'deny', choice: 'b' }), 'c', { signal: null }, card), { allowed: false, choice: null });
  assert.deepEqual(await askUser(ask(null), 'c', { signal: null }, card), { allowed: false, choice: null });
});

test('plural and sizeText word counts and sizes', () => {
  assert.equal(plural(1, 'worktree'), '1 worktree');
  assert.equal(plural(3, 'worktree'), '3 worktrees');
  assert.equal(plural(2, 'branch', 'branches'), '2 branches');
  assert.equal(sizeText(500), '500 B');
  assert.equal(sizeText(1536), '1.5 KB');
  assert.equal(sizeText(12 * 1024 * 1024), '12 MB');
  assert.equal(sizeText(5 * 1024 ** 3), '5 GB');
  assert.equal(sizeText(3000 * 1024 ** 4), '3000 TB');
});
