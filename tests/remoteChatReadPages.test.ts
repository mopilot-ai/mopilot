// A phone paging back through a chat over the remote service: the page before the row it names, and the answer when that row is gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './support/remote-kit.ts';

test('chat.read with a row id answers the page before it; without one a panel and a phone read the recent end as before', async () => {
  const r = rig();
  const p = r.phone('p1');
  assert.deepEqual((await p.ask('chat.read', { chatId: 'c1' })).result.rows, [{ role: 'user', text: 'hi' }]);
  const page = await p.ask('chat.read', { chatId: 'c1', before: 'r5', limit: 7 });
  assert.equal(page.ok, true);
  assert.deepEqual(page.result, { chatId: 'c1', rows: [{ role: 'user', text: 'before r5 x7', id: 'r0' }], more: true });
});

test('a row that is gone from the history is a stale page: the phone is told to refresh, not given an empty one', async () => {
  const r = rig();
  const gone = await r.phone('p1').ask('chat.read', { chatId: 'c1', before: 'gone' });
  assert.equal(gone.ok, false);
  assert.equal(gone.error.code, 'stale');
  assert.match(gone.error.message, /Refresh it to read earlier messages/);
});
