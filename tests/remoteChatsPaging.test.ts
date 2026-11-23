// chats.recent through the remote service on fake operations: a page start, and `more` saying whether chats follow the page.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig } from './support/remote-kit.ts';

const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);

test('chats.recent pages: a start offset, and `more` says whether the Mac has chats after this page', async () => {
  const all = Array.from({ length: 7 }, (_, i) => ({
    id: `c${i}`,
    title: `Chat ${i}`,
    harness: 'codex',
    at: 100 - i,
    project: null,
    pinned: false,
  }));
  const r = rig({ ops: { recent: async (limit: number, _archived: boolean, offset = 0) => all.slice(offset, offset + limit) } });
  const p = r.phone('p1');
  const first = ok(await p.ask('chats.recent', { limit: 3 }));
  assert.deepEqual(
    first.chats.map((c: any) => c.id),
    ['c0', 'c1', 'c2'],
  );
  assert.equal(first.more, true);
  const second = ok(await p.ask('chats.recent', { limit: 3, offset: 3 }));
  assert.deepEqual(
    second.chats.map((c: any) => c.id),
    ['c3', 'c4', 'c5'],
  );
  assert.equal(second.more, true);
  const last = ok(await p.ask('chats.recent', { limit: 3, offset: 6 }));
  assert.deepEqual(
    last.chats.map((c: any) => c.id),
    ['c6'],
  );
  assert.equal(last.more, false);
  const exact = ok(await p.ask('chats.recent', { limit: 7 }));
  assert.equal(exact.chats.length, 7);
  assert.equal(exact.more, false, 'a page that ends exactly at the end has no next page');
});
