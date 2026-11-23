// SessionState: main holds each chat's live state (electron/session/state.cjs); a window keeps a copy
// from a snapshot plus rev-ordered patches, and takes a new snapshot on a gap (src/store/session/sessionState.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { waitFor } from './support/waitFor.ts';
import { EMPTY_SESSION, applySessionPatch, takeSnapshot, type SessionPatch, type SessionState } from '../src/store/session/sessionState.ts';

const require = createRequire(import.meta.url);
const { SessionStore, emptySession } = require('../electron/session/state.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

function store() {
  const published: SessionPatch[] = [];
  return { s: new SessionStore({ publish: (p: SessionPatch) => published.push(p) }), published };
}

test('the window-side empty state matches main', () => {
  assert.deepEqual({ ...EMPTY_SESSION }, emptySession());
});

test('a store that is collected closes its copy in the core, and a close that fails is noted: nothing waits on it', async () => {
  setFlagsFromString('--expose-gc');
  const gc = runInNewContext('gc') as () => void;
  const closes: string[] = [];
  const addon = {
    dispatchSync: (route: string, payload: Buffer) => {
      if (route !== 'session.close') return Buffer.from('null');
      closes.push(String(payload));
      throw new Error('no such store');
    },
  };
  (() => void new SessionStore({ addon }))();
  // the registry's callback runs in a task after a collection: each check collects again until it has
  await waitFor(() => (gc(), closes.length > 0), 'the collected store to close');
  assert.equal(closes.length, 1);
  assert.ok(recentIgnored().some((e: any) => e.context === "close a chat store's copy in the core" && e.message === 'no such store'));
});

test('a change bumps rev and is published once; an unchanged key is not', () => {
  const { s, published } = store();
  assert.equal(s.patch('c1', { plan: true }), true);
  assert.equal(s.patch('c1', { plan: true }), false);
  assert.equal(s.patch('c1', { plan: true, permission: 'auto' }), true);
  assert.deepEqual(
    published.map((p) => [p.rev, p.patch]),
    [
      [1, { plan: true }],
      [2, { permission: 'auto' }],
    ],
  );
  assert.equal(s.snapshot('c1').rev, 2);
  // chats are separate
  assert.equal(s.snapshot('c2').rev, 0);
});

test('a goal reported by two windows with different clocks is one change', () => {
  const { s, published } = store();
  const goal = { objective: 'ship it', status: 'active', updatedAt: 100 };
  assert.equal(s.patch('c', { goal }), true);
  assert.equal(s.patch('c', { goal: { ...goal, updatedAt: 101 } }), false);
  assert.equal(s.patch('c', { goal: { ...goal, status: 'paused', updatedAt: 102 } }), true);
  assert.equal(published.length, 2);
});

test('windows may set only their own keys', () => {
  const { s } = store();
  assert.equal(s.clientPatch('c', { turn: 'running', queue: [{ id: 'x' }], rev: 99 }), false);
  assert.equal(s.clientPatch('c', { plan: true, turn: 'running' }), true);
  const snap = s.snapshot('c');
  assert.equal(snap.plan, true);
  assert.equal(snap.turn, 'idle');
  assert.deepEqual(snap.queue, []);
});

test('the snapshot is a copy', () => {
  const { s } = store();
  s.patch('c', { queue: [{ id: 'a' }] });
  const snap = s.snapshot('c');
  snap.queue.push({ id: 'b' });
  assert.equal(s.snapshot('c').queue.length, 1);
});

test('a window copy follows patches in rev order and ignores repeats', () => {
  const { s, published } = store();
  let copy: SessionState = s.snapshot('c');
  s.patch('c', { plan: true });
  s.patch('c', { turn: 'running' });
  for (const p of published) {
    const next = applySessionPatch(copy, p);
    assert.ok(next && next !== 'gap');
    copy = next as SessionState;
  }
  assert.equal(applySessionPatch(copy, published[1]), null);
  assert.deepEqual(copy, s.snapshot('c'));
});

test('a skipped rev is a gap: the window takes a new snapshot and catches up', () => {
  const { s, published } = store();
  const copy: SessionState = s.snapshot('c');
  s.patch('c', { plan: true });
  s.patch('c', { permission: 'full' });
  s.patch('c', { turn: 'running' });
  // the first patch got lost
  assert.equal(applySessionPatch(copy, published[1]), 'gap');
  const fresh = takeSnapshot(copy, s.snapshot('c'));
  assert.equal(fresh.rev, 3);
  assert.equal(applySessionPatch(fresh, published[2]), null);
  assert.equal(fresh.plan, true);
  assert.equal(fresh.turn, 'running');
  // a copy with no snapshot yet is a gap too
  assert.equal(applySessionPatch(undefined, published[0]), 'gap');
});

test('an older snapshot never replaces a newer copy', () => {
  const { s } = store();
  const old = s.snapshot('c');
  s.patch('c', { plan: true });
  const cur = s.snapshot('c');
  assert.equal(takeSnapshot(cur, old), cur);
});

test('approval lifetime tokens stay private and survive updates only while that request remains pending', () => {
  const { s } = store();
  assert.equal(s.approvalToken('missing', 1), undefined);
  const a = { id: 1, method: 'ask', params: {} };
  const b = { id: '1', method: 'ask', params: {} };
  s.patch('c', { approvals: [a] });
  const first = s.approvalToken('c', 1);
  assert.ok(first);
  assert.deepEqual(s.snapshot('c').approvals, [a], 'private tokens are not sent to windows');
  s.patch('c', { plan: true });
  assert.equal(s.approvalToken('c', 1), first);
  s.patch('c', { approvals: [a, b] });
  assert.equal(s.approvalToken('c', 1), first);
  assert.notEqual(s.approvalToken('c', '1'), first);
  s.patch('c', { approvals: [a] });
  assert.equal(s.approvalToken('c', '1'), undefined);
  s.patch('c', { approvals: [] });
  s.patch('c', { approvals: [a] });
  assert.notEqual(s.approvalToken('c', 1), first, 'reusing a native id creates a new lifetime');
  s.patch('c', { approvals: null });
  assert.equal(s.approvalToken('c', 1), undefined);
  s.patch('c', { approvals: [null, { id: false }, { id: {} }] });
  assert.equal(s.approvalToken('c', undefined), undefined, 'malformed cards cannot own a token');
});
