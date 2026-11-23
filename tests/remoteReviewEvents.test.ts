// review.changed events: a phone that follows a chat (and may review) hears each diff change, a phone that does not hears nothing, and the push never carries the diff.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { rig, settle } from './support/remote-kit.ts';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const { attachReviewEvents, REVIEW_CHANGED } = require('../electron/remote/reviewEvents.cjs');
const { TurnSnapshots } = require('../electron/session/turnSnapshots.cjs');

function setup(o: { policy?: any } = {}) {
  const r = rig({ policy: o.policy });
  const snaps = new TurnSnapshots({
    changes: { begin: async () => {}, itemStarted: () => {}, peek: async () => '', abort: () => {} },
    state: { has: () => true, get: () => ({ activeTurn: null }) },
    publish: () => {},
  });
  const live = { controller: { turnSnapshots: snaps }, chromePanel: { service: r.service } };
  return { ...r, snaps, live };
}

test('followers hear review.changed for live, final and taken-back diffs; others, and the diff itself, never', async () => {
  const s = setup();
  const stop = attachReviewEvents({ live: s.live });
  const p1 = s.phone('p1');
  const p2 = s.phone('p2');
  await p1.ask('chat.follow', { chatId: 'c1' });
  await p2.ask('chat.follow', { chatId: 'c2' });
  s.snaps.emit({ chatId: 'c1', turnId: 't1', diff: 'SECRET diff text' }, true);
  s.snaps.emit({ chatId: 'c1', turnId: 't1', diff: 'SECRET diff text' });
  s.snaps.emit({ chatId: 'c1', turnId: 't1', diff: null });
  await settle();
  const heard = p1.events(REVIEW_CHANGED).map(({ id: _id, t: _t, kind: _k, ...e }: any) => e);
  assert.deepEqual(heard, [
    { ev: REVIEW_CHANGED, chatId: 'c1', turnId: 't1', live: true, removed: false },
    { ev: REVIEW_CHANGED, chatId: 'c1', turnId: 't1', live: false, removed: false },
    { ev: REVIEW_CHANGED, chatId: 'c1', turnId: 't1', live: false, removed: true },
  ]);
  assert.equal(JSON.stringify(p1.inbox).includes('SECRET'), false);
  assert.equal(p2.events(REVIEW_CHANGED).length, 0, 'p2 follows another chat');
  stop();
  s.snaps.emit({ chatId: 'c1', turnId: 't2', diff: 'd' });
  await settle();
  assert.equal(p1.events(REVIEW_CHANGED).length, 3, 'stopped');
});

test('a device the Mac does not let review hears nothing and does not make the chat worth reading', async () => {
  const s = setup({ policy: { allow: (_pair: string, m: string) => m !== 'diff.list' } });
  attachReviewEvents({ live: s.live });
  const p1 = s.phone('p1');
  await p1.ask('chat.follow', { chatId: 'c1' });
  assert.equal(s.snaps.followed('c1'), false);
  s.snaps.emit({ chatId: 'c1', turnId: 't1', diff: 'd' }, true);
  await settle();
  assert.equal(p1.events(REVIEW_CHANGED).length, 0);
});

test('the chat counts as followed while a reviewing phone follows it, and not after it leaves', async () => {
  const s = setup();
  attachReviewEvents({ live: s.live });
  const p1 = s.phone('p1');
  assert.equal(s.snaps.followed('c1'), false);
  await p1.ask('chat.follow', { chatId: 'c1' });
  assert.equal(s.snaps.followed('c1'), true);
  await p1.ask('chat.unfollow', { chatId: 'c1' });
  assert.equal(s.snaps.followed('c1'), false);
});

test('a failed send to one device leaves the others their event and is not thrown', async () => {
  const s = setup();
  attachReviewEvents({ live: s.live });
  const p1 = s.phone('p1');
  const p2 = s.phone('p2');
  await p1.ask('chat.follow', { chatId: 'c1' });
  await p2.ask('chat.follow', { chatId: 'c1' });
  const emit = s.service.emit.bind(s.service);
  s.service.emit = async (pair: string, event: object) => {
    if (pair === 'p1') throw new Error('relay down');
    return emit(pair, event);
  };
  s.snaps.emit({ chatId: 'c1', turnId: 't1', diff: 'd' }, true);
  await settle();
  assert.equal(p1.events(REVIEW_CHANGED).length, 0);
  assert.equal(p2.events(REVIEW_CHANGED).length, 1);
});

test('the event follows the chat’s earlier events in order', async () => {
  const s = setup();
  attachReviewEvents({ live: s.live });
  const p1 = s.phone('p1');
  await p1.ask('chat.follow', { chatId: 'c1' });
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  void s.service.enqueue('c1', async () => {
    await gate;
    await s.service.emit('p1', { ev: 'earlier.event', chatId: 'c1' });
  });
  s.snaps.emit({ chatId: 'c1', turnId: 't1', diff: 'd' }, true);
  await settle();
  assert.equal(p1.events(REVIEW_CHANGED).length, 0, 'waits for the earlier event');
  release();
  await settle();
  assert.deepEqual(
    p1
      .events()
      .filter((e: any) => e.ev !== 'session.patch')
      .map((e: any) => e.ev),
    ['earlier.event', REVIEW_CHANGED],
  );
});

test('no panel yet and no snapshots are fine', async () => {
  const bare = setup();
  attachReviewEvents({ live: { controller: bare.live.controller } });
  bare.snaps.emit({ chatId: 'c1', turnId: 't1', diff: 'd' }, true);
  assert.equal(bare.snaps.followed('c1'), false);
  const none = attachReviewEvents({ live: {} });
  assert.equal(typeof none, 'function');
  none();
});
