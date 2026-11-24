// Where the learning service is in the notice lane's reactions (store id + sequence number): a replaced or restarted store is read from its beginning but never counts a tap older than the owner's Undo, a burst larger than one pass is read to the end, and a tap whose audit line could not be written is looked at again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noticing, tap } from './support/host/noticingWorld.ts';

const cursorOf = (n: any) => n.w.home.data.sealed('learning.json', (v: any) => v).read()?.cursor ?? null;
const old = (matter: string, at: number, store: string, seq: number) => ({
  kind: 'not_needed',
  rowId: `gmail:${matter}`,
  matterKey: matter,
  fromDomain: 'acme.com',
  fromAddress: null,
  decisionId: `gmail:${matter}@1`,
  senderStatus: 'pass',
  decidedBy: null,
  outcome: null,
  at,
  store,
  seq,
});

test('a notice store that was replaced (a new id, nothing trimmed) is read from its beginning, but a tap older than the owner’s Undo does not suggest the rule again', async (t) => {
  const n = await noticing(t);
  await tap(n, 'a1');
  await tap(n, 'a2');
  n.w.clock.at += 100_000;
  const undoneAt = n.w.clock.at;
  await n.learning.undo(n.rules()[0].id, 'phone:a');
  assert.deepEqual(cursorOf(n), { store: 'store-1', seq: 2 });
  // after a Reset or Start fresh: another store, whose two first taps are older than the Undo
  n.reactions.length = 0;
  n.reactions.push(old('o1', undoneAt - 5, 'store-2', 1), old('o2', undoneAt - 4, 'store-2', 2));
  assert.deepEqual(await n.learning.consumeNotices(), { counted: 0, set_aside: 2 });
  assert.equal(n.rules().filter((r: any) => r.state === 'suggested').length, 0, 'the old taps do not count after the Undo');
  assert.deepEqual(cursorOf(n), { store: 'store-2', seq: 2 });
  // two new taps in the new store do, once time has passed
  n.w.clock.at += 10_000;
  n.reactions.push(old('o3', undoneAt + 5000, 'store-2', 3), old('o4', undoneAt + 5001, 'store-2', 4));
  assert.deepEqual(await n.learning.consumeNotices(), { counted: 2, set_aside: 0 });
  assert.equal(n.rules().filter((r: any) => r.state === 'suggested').length, 1);
});

test('a store whose numbers went back (restored from a copy) is read from its beginning; one whose numbers only grew is read after the cursor', async (t) => {
  const n = await noticing(t);
  const ignore = (row: string, store: string, seq: number) => ({ kind: 'signal_ignore', rowId: row, at: 1, store, seq });
  n.reactions.push(ignore('notice:sender:a.example.com', 'store-1', 10), ignore('notice:sender:b.example.com', 'store-1', 11));
  assert.deepEqual(await n.learning.consumeNotices(), { counted: 2, set_aside: 0 });
  assert.deepEqual(await n.learning.consumeNotices(), { counted: 0, set_aside: 0 });
  n.reactions.length = 0;
  n.reactions.push(ignore('notice:sender:c.example.com', 'store-1', 3), ignore('notice:sender:d.example.com', 'store-1', 4));
  assert.deepEqual(await n.learning.consumeNotices(), { counted: 2, set_aside: 0 }, 'numbers below the cursor: a restarted store');
  assert.deepEqual(cursorOf(n), { store: 'store-1', seq: 4 });
  n.reactions.push(ignore('notice:sender:e.example.com', 'store-1', 5));
  assert.deepEqual(await n.learning.consumeNotices(), { counted: 1, set_aside: 0 }, 'only what is after the cursor');
  // a reaction with no store or number (older than this version) is not looked at
  n.reactions.push({ kind: 'signal_ignore', rowId: 'notice:sender:f.example.com', at: 1, store: 'store-1' });
  assert.deepEqual(await n.learning.consumeNotices(), { counted: 0, set_aside: 0 });
});

test('a burst bigger than one pass is read to the end by the home’s own look, not left to be trimmed unseen', async (t) => {
  const n = await noticing(t);
  await n.w.home.lifecycle('pause');
  for (let i = 0; i < 130; i++) n.reactions.push({ kind: 'signal_ignore', rowId: `notice:sender:s${i}.example.com`, at: 1 + i });
  await n.w.home.lifecycle('start');
  for (const end = Date.now() + 3000; (cursorOf(n)?.seq ?? 0) < 130 && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
  assert.equal(cursorOf(n).seq, 130, 'three passes of fifty, nothing left');
});
