// The dev host's fake app keeps the model, effort and permission a phone picks, per chat, and its menus show them back.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';

const app = () =>
  createFakeApp({ repo: '/repo', log: () => undefined, now: () => 5_000_000, sleep: async () => undefined, status: async () => '' }).ops;

test('the menus show what was chosen for a chat, another chat and a new chat keep their own, and a model without a choice uses its default effort', async () => {
  const ops = app();
  assert.deepEqual(
    ((o) => [o.model, o.effort, o.permission.value])(await ops.options({ chatId: 'dev-seed-login' })),
    ['dev-fast', 'low', 'default'],
    'the menus start on the defaults',
  );
  await ops.choose({ chatId: 'dev-seed-login', model: 'dev-deep', effort: null });
  const chosen = await ops.options({ chatId: 'dev-seed-login' });
  assert.deepEqual([chosen.model, chosen.effort], ['dev-deep', null]);
  assert.equal((await ops.options({ chatId: 'dev-seed-waiting' })).model, 'dev-fast', 'another chat keeps its own choice');
  await ops.choose({ chatId: 'dev-seed-login', model: 'dev-fast', effort: 'high' });
  assert.equal((await ops.options({ chatId: 'dev-seed-login' })).effort, 'high');
  await ops.choose({ chatId: 'dev-seed-login', model: 'dev-fast' });
  assert.equal((await ops.options({ chatId: 'dev-seed-login' })).effort, 'low', 'no effort chosen: the model default');
  await ops.choose({ model: 'dev-deep', effort: null });
  assert.equal((await ops.options({})).model, 'dev-deep', 'a new chat has its own choice');
  await ops.choose({ chatId: 'dev-seed-readme', model: 'not-in-the-menu' });
  assert.equal((await ops.options({ chatId: 'dev-seed-readme' })).effort, null, 'a model the menu does not list has no default effort');
});

test('a permission chosen for a chat is shown for that chat only, and a new chat has its own', async () => {
  const ops = app();
  await ops.permit({ chatId: 'dev-seed-login', value: 'auto-review' });
  assert.equal((await ops.options({ chatId: 'dev-seed-login' })).permission.value, 'auto-review');
  assert.equal((await ops.options({ chatId: 'dev-seed-waiting' })).permission.value, 'default');
  await ops.permit({ value: 'auto-review' });
  assert.equal((await ops.options({})).permission.value, 'auto-review');
});
