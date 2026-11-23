// src/store/session/useSession.ts + useCaps.ts: a frame's session patches for every chat are one store commit, applied in rev
// order with gaps and stale patches judged as they arrive; useSessionField re-renders only for its own fields; caps are
// read again only when what main's caps read of the session changed.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { act, createElement as h } from 'react';
import { flush, mount } from './support/composer-kit.ts';
import { fakeNative } from './support/ports/native.ts';
import { installNative } from '../src/lib/native.ts';
import { goalElapsedMs } from '../src/lib/goalClock.ts';

let patchCb: (p: any) => void = () => {};
let capsCb: () => void = () => {};
const snapshots: any[] = [];
const snapshotCalls: string[] = [];
const capsCalls: any[][] = [];
let capsAnswer: (chatId: string | null, hint: unknown) => Promise<any> = async () => ({ kind: 'codex', tier: 'first', caps: { x: 1 } });
const native = fakeNative({
  session: {
    onPatch: (cb: (p: any) => void) => (patchCb = cb),
    onCapsChanged: (cb: () => void) => (capsCb = cb),
    snapshot: async (chatId: string) => (snapshotCalls.push(chatId), snapshots.shift() ?? null),
    patch: async () => true,
    caps: (chatId: string | null, hint: unknown) => (capsCalls.push([chatId, hint]), capsAnswer(chatId, hint)),
  },
});
installNative(native);
const sess = await import('../src/store/session/useSession.ts');
const caps = await import('../src/store/session/useCaps.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');

const CHATS = Array.from({ length: 30 }, (_, i) => `c${i}`);
const snap = (rev: number, over: object = {}) => ({ ...EMPTY_SESSION, rev, ...over });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let commits = 0;
let off: () => void = () => {};

beforeEach(async () => {
  off();
  sess.flushSessionPatches();
  sess.useSessions.setState({ sessions: Object.fromEntries(CHATS.map((c) => [c, snap(1)])), loaded: {} });
  snapshots.length = 0;
  snapshotCalls.length = 0;
  capsCalls.length = 0;
  capsAnswer = async () => ({ kind: 'codex', tier: 'first', caps: { x: 1 } });
  commits = 0;
  off = sess.useSessions.subscribe(() => commits++);
  sess.startSessions();
});

test('30 chats x 3 progress patches: one commit per frame, every chat at its last rev (before: 90 commits)', async () => {
  for (let r = 2; r <= 4; r++) for (const c of CHATS) patchCb({ chatId: c, rev: r, patch: { progressAt: r * 1000 } });
  assert.equal(commits, 0, 'held until the paint');
  assert.equal(sess.sessionOf('c7').rev, 4, 'a non-React reader sees the held patches');
  assert.equal(sess.useSessions.getState().sessions.c7.rev, 1);
  await sleep(80);
  assert.equal(commits, 1);
  for (const c of CHATS) assert.deepEqual([sess.sessionOf(c).rev, sess.sessionOf(c).progressAt], [4, 4000]);
  sess.flushSessionPatches();
  assert.equal(commits, 1, 'flushing with nothing held writes nothing');
});

test('stale and duplicate patches never replace a newer rev; a gap takes a snapshot instead', async () => {
  patchCb({ chatId: 'c1', rev: 2, patch: { turn: 'running' } });
  patchCb({ chatId: 'c1', rev: 3, patch: { turn: 'idle' } });
  patchCb({ chatId: 'c1', rev: 2, patch: { turn: 'crashed' } });
  patchCb({ chatId: 'c1', rev: 3, patch: { turn: 'crashed' } });
  assert.equal(sess.sessionOf('c1').turn, 'idle');
  snapshots.push(snap(9, { turn: 'awaitingUser' }));
  patchCb({ chatId: 'c1', rev: 7, patch: { turn: 'running' } });
  await sleep(80);
  assert.deepEqual(snapshotCalls, ['c1']);
  assert.deepEqual([sess.sessionOf('c1').rev, sess.sessionOf('c1').turn], [9, 'awaitingUser']);
});

test('a snapshot applies the held patches first, so a newer held rev beats an older snapshot', async () => {
  patchCb({ chatId: 'c2', rev: 2, patch: { turn: 'running' } });
  patchCb({ chatId: 'c2', rev: 3, patch: { turn: 'idle' } });
  snapshots.push(snap(2, { turn: 'running' }));
  await sess.refreshSession('c2');
  assert.deepEqual([sess.sessionOf('c2').rev, sess.sessionOf('c2').turn], [3, 'idle']);
  assert.equal(sess.useSessions.getState().sessions.c2.rev, 3, 'committed, not only held');
});

test('a patch for a chat with no copy asks main for a snapshot, and a missing snapshot changes nothing', async () => {
  patchCb({ chatId: 'new', rev: 1, patch: {} });
  await sleep(20);
  assert.deepEqual(snapshotCalls, ['new']);
  assert.equal(sess.sessionOf('new'), EMPTY_SESSION);
});

test('setSession commits the held patches first, then shows its own change at the same rev', async () => {
  patchCb({ chatId: 'c3', rev: 2, patch: { turn: 'running' } });
  await sess.setSession('c3', { plan: true });
  const now = sess.useSessions.getState().sessions.c3;
  assert.deepEqual([now.rev, now.turn, now.plan], [2, 'running', true]);
});

test('an unseen goal clock excludes a pause even when the pause and resume are held for one paint', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
  const chatId = 'c3';
  const goal = {
    threadId: 'native',
    status: 'active' as const,
    objective: 'Keep working',
    timeUsedSeconds: 20,
    createdAt: 1,
    updatedAt: 1,
    tokenBudget: null,
    tokensUsed: 0,
  };
  assert.equal(await sess.setSession(chatId, { goal }), true);
  assert.deepEqual(native.callsTo('session.patch').at(-1), [chatId, { goal }], 'the estimate stays local to the window');
  const elapsed = () => goalElapsedMs(sess.useSessions.getState().sessions[chatId].goalClock!, Date.now());
  const before = commits;

  t.mock.timers.tick(3000);
  const resumed = { ...goal, timeUsedSeconds: 23 };
  patchCb({ chatId, rev: 2, patch: { goal: { ...resumed, status: 'paused' } } });
  t.mock.timers.tick(30_000);
  patchCb({ chatId, rev: 3, patch: { goal: resumed } });
  patchCb({ chatId, rev: 2, patch: { goal: null } });
  assert.equal(commits, before, 'both updates arrived before the window committed them');

  t.mock.timers.tick(2000);
  snapshots.push(snap(2, { goal: null }));
  await sess.refreshSession(chatId);
  assert.equal(sess.sessionOf(chatId).goal, resumed);
  assert.equal(elapsed(), 25_000);

  patchCb({ chatId, rev: 4, patch: { goal: null } });
  t.mock.timers.tick(10_000);
  patchCb({ chatId, rev: 5, patch: { goal } });
  sess.flushSessionPatches();
  assert.equal(elapsed(), 20_000, 'clearing retires the clock even if the next goal has the same identifiers');
});

test('useSessionField: a component reading one field draws again only when that field changes', async () => {
  let renders = 0;
  const Probe = ({ id }: { id: string }) => {
    const s = sess.useSessionField(id, (x) => ({ turn: x.turn, queue: x.queue }));
    renders++;
    return h('i', null, s.turn);
  };
  const m = await mount(h(Probe, { id: 'c4' }));
  const base = renders;
  for (let r = 2; r < 12; r++) patchCb({ chatId: 'c4', rev: r, patch: { progressAt: r } });
  await flush(80, 1);
  assert.equal(renders, base, 'ten progress patches: no render');
  patchCb({ chatId: 'c4', rev: 12, patch: { turn: 'running' } });
  await flush(80, 1);
  assert.equal(renders, base + 1);
  assert.equal(m.host.textContent, 'running');
  await m.render(h(Probe, { id: undefined as never }));
  assert.equal(m.host.textContent, 'idle', 'no chat reads the placeholder');
  await m.unmount();
});

test('useCaps: progress patches do not read caps again; a turn change does; an answer for older inputs is dropped', async () => {
  let row: any;
  const Probe = () => ((row = caps.useChatCaps('c5')), null);
  const m = await mount(h(Probe));
  await flush(0, 3);
  assert.equal(capsCalls.length, 1);
  assert.equal(row.loaded, true);
  for (let r = 2; r < 8; r++) patchCb({ chatId: 'c5', rev: r, patch: { progressAt: r, tasks: [] as never } });
  await flush(80, 2);
  assert.equal(capsCalls.length, 1, 'six patches of other fields: no new read');
  let finish: (v: any) => void = () => {};
  capsAnswer = () => new Promise((r) => (finish = r));
  patchCb({ chatId: 'c5', rev: 8, patch: { turn: 'running' } });
  await flush(80, 2);
  assert.equal(capsCalls.length, 2);
  assert.equal(row.loaded, false, 'caps of the earlier turn are not shown for this one');
  patchCb({ chatId: 'c5', rev: 9, patch: { turn: 'idle' } });
  await flush(80, 2);
  assert.equal(capsCalls.length, 3);
  await act(async () => finish({ kind: 'codex', tier: 'first', caps: { late: 1 } }));
  assert.equal(row.loaded, true, 'the third read (idle) answered');
  capsCb();
  await flush(0, 3);
  assert.equal(capsCalls.length, 4, "main's change notice reads again");
  // what the session declares (acp), a model's modality and a pending switch are caps inputs too; reads of one object share a key
  patchCb({ chatId: 'c5', rev: 10, patch: { acp: { modes: [] } as never } });
  await flush(80, 2);
  assert.equal(capsCalls.length, 5);
  patchCb({ chatId: 'c5', rev: 11, patch: { modality: 'image' } });
  patchCb({ chatId: 'c5', rev: 12, patch: { pendingSwitch: { harness: 'x' } as never } });
  await flush(80, 2);
  assert.equal(capsCalls.length, 6, 'both land in one frame, so one read');
  await m.unmount();
});

test('useCaps: a failed read leaves caps unloaded, and capsOf answers null', async () => {
  capsAnswer = async () => {
    throw new Error('down');
  };
  let row: any;
  const Probe = () => ((row = caps.useChatCaps('c6')), null);
  const m = await mount(h(Probe));
  await flush(0, 3);
  assert.equal(row.loaded, false);
  assert.equal(await caps.capsOf('c6'), null);
  assert.equal(row.caps.x, undefined, 'nothing is offered until main answers');
  await m.unmount();
});
