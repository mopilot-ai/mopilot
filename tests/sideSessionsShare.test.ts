// src/lib/sideSessions.ts: main sends the whole linked-session view again on every journal write, and a row re-renders only when its own entry changed (#5398: 1,500 old sessions made each broadcast a 300 ms freeze of every sidebar row).
import { rendersOf, resetCommits } from './support/commitProbe.ts'; // first: React reads the hook as it loads
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement as h } from 'react';
import { fx, reset, render, thread, ThreadRow, flush } from './support/shell-sidebar-kit.ts';
import {
  linkedChildren,
  resetSideSessions,
  selectorEnv,
  selectorMadeNothing,
  shareView,
  useOrchestration,
  useOrchestrationSelect,
} from '../src/lib/sideSessions.ts';
import { shareDeep } from '../src/lib/structuralShare.ts';
import { markWindowReady } from '../src/lib/windowReady.ts';

markWindowReady();

const child = (name: string, extra: object = {}) => ({
  parentId: 'top',
  name,
  title: name,
  createdAt: 1,
  worked: { ms: 5, turns: 1, since: null },
  lastReport: null,
  ...extra,
});
const base = () => ({
  children: { a: child('alpha'), b: child('beta') },
  deliveries: { d1: { kind: 'message', chatId: 'a', at: 1 } },
  proposals: {},
  queue: ['a', 'b'],
  plans: {},
  wrapUps: {},
});
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test('a broadcast that changed nothing is the held view itself; a change makes new objects only along its path', () => {
  const prev = base() as any;
  assert.equal(shareView(prev, clone(prev)), prev);

  const moved = clone(prev);
  moved.children.a.worked.ms = 99;
  const next = shareView(prev, moved) as any;
  assert.notEqual(next, prev);
  assert.notEqual(next.children, prev.children);
  assert.notEqual(next.children.a, prev.children.a);
  assert.equal(next.children.a.worked.ms, 99);
  for (const same of ['b']) assert.equal(next.children[same], prev.children[same], 'an entry that did not change keeps its identity');
  assert.equal(next.deliveries, prev.deliveries);
  assert.equal(next.queue, prev.queue);
  assert.equal(next.plans, prev.plans);
});

test('an added, removed or reordered part is a change, and a key the view gains or loses is too', () => {
  const prev = base() as any;
  const added = clone(prev);
  added.children.c = child('gamma');
  const a = shareView(prev, added) as any;
  assert.deepEqual(Object.keys(a.children), ['a', 'b', 'c']);
  assert.equal(a.children.a, prev.children.a);

  const removed = clone(prev);
  delete removed.children.b;
  assert.deepEqual(Object.keys((shareView(prev, removed) as any).children), ['a']);

  const queued = clone(prev);
  queued.queue = ['b', 'a'];
  assert.deepEqual((shareView(prev, queued) as any).queue, ['b', 'a']);
  const shorter = clone(prev);
  shorter.queue = ['a'];
  assert.deepEqual((shareView(prev, shorter) as any).queue, ['a']);

  const gains = { ...clone(prev), waiting: { a: { after: ['b'], held: null } } };
  assert.deepEqual((shareView(prev, gains) as any).waiting, gains.waiting);
  assert.deepEqual(shareView(gains as any, clone(prev)), clone(prev));
  const swapped = { ...clone(prev), families: ['x'] };
  delete (swapped as any).plans;
  assert.deepEqual(Object.keys(shareView(prev, swapped as any)).sort(), [
    'children',
    'deliveries',
    'families',
    'proposals',
    'queue',
    'wrapUps',
  ]);

  // values that are not records or arrays of JSON compare by value
  const odd = { ...clone(prev), children: { a: child('alpha', { paths: ['x', { y: null }], detached: true }) } };
  const again = { ...clone(odd) };
  const shared = shareView(odd as any, again as any) as any;
  assert.equal(shared, odd);
  assert.notEqual(
    shareView(odd as any, { ...again, children: { a: child('alpha', { paths: ['x', { y: 1 }], detached: true }) } } as any),
    odd,
  );
  assert.notEqual(shareView(odd as any, { ...again, children: { a: child('alpha', { paths: { 0: 'x' }, detached: true }) } } as any), odd);
});

beforeEach(() => {
  reset();
  resetSideSessions();
  resetCommits();
});

/** The windows' own listener is what feeds the store: the kit hands it to `fx` when the store subscribes. */
const broadcast = (view: unknown) => act(async () => fx.orchestrationChanged(view));

test('a broadcast that changes nothing renders no row; a change to one session renders only the rows that read it', async () => {
  const view = base();
  fx.orchestration = view;
  const Probe = ({ id }: { id: string }) => {
    useOrchestrationSelect((v) => v.children[id]);
    return null;
  };
  const Whole = () => (useOrchestration(), null);
  const rows = ['a', 'b', 'c'].map((id) => thread(id));
  const m = await render(
    h(
      'div',
      null,
      ...rows.map((t) => h(ThreadRow, { key: t.id, thread: t as any, active: false, onOpen: () => {} })),
      h(Probe, { id: 'a' }),
      h(Probe, { id: 'b' }),
      h(Whole),
    ),
  );
  await flush();
  resetCommits();

  await broadcast(clone(view));
  assert.equal(rendersOf('ThreadRow').length, 0, 'the same content again re-renders no row');
  assert.equal(rendersOf('Probe').length + rendersOf('Whole').length, 0);

  const moved = clone(view);
  moved.children.a.worked.ms = 7;
  await broadcast(moved);
  const rendered = rendersOf('ThreadRow').map((p: any) => p.thread.id);
  assert.deepEqual(rendered, ['a'], 'only the row of the session that changed renders');
  assert.deepEqual(
    rendersOf('Probe').map((p: any) => p.id),
    ['a'],
  );
  assert.equal(rendersOf('Whole').length, 1, 'a reader of the whole view still sees every change');

  // the queue position of a row is its own selection: a, b keep their places, c enters the queue
  resetCommits();
  const queued = clone(moved);
  queued.queue = ['a', 'b', 'c'];
  await broadcast(queued);
  assert.deepEqual(
    rendersOf('ThreadRow')
      .map((p: any) => p.thread.id)
      .sort(),
    ['c'],
    'a row renders when its own place in the queue changes',
  );
  await m.unmount();
});

test('shareDeep keeps whatever is equal, down to the leaf, and takes what it does not understand as it is', () => {
  const prev = { a: [1, { b: 2 }], c: { d: 'x' }, e: null };
  assert.equal(shareDeep(prev, JSON.parse(JSON.stringify(prev))), prev);
  const next = shareDeep(prev, { a: [1, { b: 3 }], c: { d: 'x' }, e: null }) as typeof prev;
  assert.notEqual(next, prev);
  assert.equal(next.c, prev.c);
  assert.notEqual(next.a, prev.a);
  assert.equal(next.a[0], 1);
  // a longer or shorter array, a gained or lost key, another type
  assert.deepEqual(shareDeep([1, 2], [1, 2, 3]), [1, 2, 3]);
  assert.deepEqual(shareDeep([1, 2], [1]), [1]);
  // a shorter array whose kept elements are null stays what it is
  assert.deepEqual(shareDeep([1, null, 3], [1, null]), [1, null]);
  assert.deepEqual(shareDeep([null, 2], [null]), [null]);
  assert.deepEqual(shareDeep({ a: 1 }, { a: 1, b: 2 }), { a: 1, b: 2 });
  assert.deepEqual(shareDeep({ a: 1, b: 2 }, { a: 1 }), { a: 1 });
  assert.deepEqual(shareDeep({ a: 1 }, { a: undefined }), { a: undefined });
  assert.deepEqual(shareDeep([1], { 0: 1 }), { 0: 1 });
  assert.deepEqual(shareDeep({ 0: 1 }, [1]), [1]);
  assert.equal(shareDeep(undefined, 'x'), 'x');
  assert.equal(shareDeep(1, 2), 2);
});

test('the chats a chat started come from one index per view: oldest first, detached ones left out, the same list each time', () => {
  const view = {
    ...base(),
    children: {
      late: child('late', { parentId: 'top', createdAt: 30 }),
      early: child('early', { parentId: 'top', createdAt: 10 }),
      gone: child('gone', { parentId: 'top', createdAt: 20, detached: true }),
      other: child('other', { parentId: 'elsewhere', createdAt: 5 }),
    },
  } as any;
  assert.deepEqual(linkedChildren(view, 'top'), ['early', 'late']);
  assert.equal(linkedChildren(view, 'top'), linkedChildren(view, 'top'), 'asked again it is the same list: no work per render');
  assert.deepEqual(linkedChildren(view, 'elsewhere'), ['other']);
  assert.deepEqual(linkedChildren(view, 'nobody'), []);
  // a new view is indexed afresh, so a change is never answered from the old one
  const next = shareView(view, {
    ...clone(view),
    children: { ...clone(view).children, newest: child('newest', { parentId: 'top', createdAt: 40 }) },
  });
  assert.deepEqual(linkedChildren(next, 'top'), ['early', 'late', 'newest']);
  assert.deepEqual(linkedChildren(view, 'top'), ['early', 'late']);
});

test('a selector that makes an object is caught in development; a primitive or an entry of the view is not', () => {
  const entry = { a: 1 };
  assert.doesNotThrow(() => selectorMadeNothing(() => 3, 3));
  assert.doesNotThrow(() => selectorMadeNothing(() => null, null));
  const make = () => ({ made: true });
  assert.throws(() => selectorMadeNothing(make, make()), /new object/);
  // an entry that the view holds is the same object each time
  assert.doesNotThrow(() => selectorMadeNothing(() => entry, entry));
});

test('the hook makes that check only in the development build', async () => {
  const was = selectorEnv.DEV;
  let reads = 0;
  // an entry the view holds: DEV asks for it twice a read (to see it is the same), a build asks once
  const Queue = () => String(useOrchestrationSelect((v) => (reads++, v.queue)).length);
  const Made = () => String(useOrchestrationSelect(() => ({ made: true })).made);
  try {
    selectorEnv.DEV = false;
    const quiet = await render(h(Queue));
    const once = reads;
    await quiet.unmount();
    reads = 0;
    selectorEnv.DEV = true;
    const loud = await render(h(Queue));
    assert.equal(reads, once * 2);
    await loud.unmount();
    const log = console.error;
    console.error = () => {};
    try {
      await assert.rejects(() => render(h(Made)), /new object/);
    } finally {
      console.error = log;
    }
  } finally {
    selectorEnv.DEV = was;
  }
});
