// A chat's session state patched through the Rust core (electron/session/state.cjs, core/crates/session): the same patches
// give the published changes, revisions and state, the values as given (undefined, nested undefined and key order included).
// It needs a built core; scripts/rust-coverage.mjs runs
// this file (coreBinding*) against the instrumented core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { SessionStore } = require('../electron/session/state.cjs');
const { corePath, loadCore } = require('../electron/platform/core.cjs');
const { installClock } = require('../electron/platform/ports/clock.cjs');

/** A clock fixed at 42 ms for the test. */
function fixedClock(t: { after: (fn: () => void) => void }) {
  const previous = installClock({ ...installClock(null), now: () => 42 });
  t.after(() => void installClock(previous));
}

const addon = loadCore(corePath());
const required = process.env.MOPILOT_CORE_REQUIRED === '1';

/** Every patch below, as main's modules send them. */
const PATCHES: [string, any, 'client'?][] = [
  ['a', { turn: 'running', activeTurn: { id: 'pending-1', human: true }, runningElsewhere: true }],
  ['a', { progressAt: 5 }],
  ['a', { queue: [{ id: 'q1', text: 'hi', opts: { note: undefined, model: null } }] }],
  ['a', { queue: [{ id: 'q1', text: 'hi', opts: { note: undefined, model: null } }] }],
  ['a', { queue: [{ text: 'hi', id: 'q1', opts: { model: null } }] }],
  ['a', { turn: 'awaitingUser', approvals: [{ id: 7, method: 'x', params: {} }] }],
  ['a', { turn: 'running', approvals: [] }],
  ['a', { goal: { text: 'ship it', updatedAt: 1 } }, 'client'],
  ['a', { goal: { text: 'ship it', updatedAt: 2 } }, 'client'],
  ['a', { turn: 'idle', activeTurn: null, unknown: 1, rev: 99 }],
  ['a', { crashed: undefined }],
  ['a', { plan: true, turn: 'running' }, 'client'],
  // a turn resumed with its own progress, ended with its last, and one that waited on the user and is stopped
  ['a', { turn: 'awaitingUser' }],
  ['a', { turn: 'running', progressAt: 3 }],
  ['a', { turn: 'idle', progressAt: 4 }],
  ['a', { turn: 'awaitingUser' }],
  ['a', { turn: 'idle' }],
  ['b', { pendingSwitch: { harness: 'claude', model: 'opus' } }, 'client'],
  ['b', { turn: null }],
  ['a', 'not an object' as any],
  ['', { plan: true }],
  // approvals move a running turn to wait on the user and back; one that names the turn keeps it
  ['c', { turn: 'running' }],
  ['c', { approvals: [{ id: 1 }] }],
  ['c', { approvals: [{ id: 1 }, { id: 2 }] }],
  ['c', { approvals: [{ id: 2 }] }],
  ['c', { approvals: [] }],
  ['c', { approvals: [{ id: 3 }] }],
  ['c', { approvals: [], turn: 'idle', activeTurn: null }],
  ['c', { approvals: [{ id: 4 }] }],
  ['b', { turn: 5 }],
  // text cut mid-emoji: JSON.stringify writes a lone surrogate, which the core's parser refuses, so this store's rules run
  // in JS from here, with the same result
  ['b', { queue: [{ id: 'q', text: '\ud83d' }] }],
  ['b', { plan: true }],
];

function run(store: any) {
  const published: any[] = [];
  store.publish = (p: any) => published.push(p);
  const results = PATCHES.map(([chat, partial, client]) => (client ? store.clientPatch(chat, partial) : store.patch(chat, partial)));
  return { results, published, a: store.snapshot('a'), b: store.snapshot('b'), c: store.snapshot('c') };
}

test('the core publishes each change once, in revision order, with values exactly as given', {
  skip: !addon && !required && 'no Rust core built',
}, (t) => {
  fixedClock(t);
  const { published, b } = run(new SessionStore({ addon }));
  for (const chat of ['a', 'b', 'c']) {
    const revs = published.filter((p) => p.chatId === chat).map((p) => p.rev);
    assert.deepEqual(
      revs,
      revs.map((_, i) => i + 1),
      chat,
    );
  }
  assert.equal(b.queue[0].text, '\ud83d', 'a lone surrogate reaches the mirror unchanged');
  // a tool's input can nest deeper than serde_json reads: it is a change like any other
  const deep = new SessionStore({ addon });
  const nested = (leaf: unknown) => {
    let value = leaf;
    for (let i = 0; i < 300; i++) value = [value];
    return { method: 'ask', params: value };
  };
  assert.equal(deep.patch('d', { approvals: [{ id: 1, ...nested('x') }] }), true);
  assert.deepEqual(deep.get('d').approvals, [{ id: 1, ...nested('x') }]);
  assert.equal(deep.patch('d', { approvals: [{ id: 1, ...nested('y') }] }), true, 'another deep value differs');
  // a value that can't be copied fails before the core takes it: the core and the mirror stay at one revision
  const store = new SessionStore({ addon });
  assert.throws(() => store.patch('c', { computer: { app: 'x', onStop: () => {} } }));
  assert.equal(store.patch('c', { plan: true }), true);
  assert.equal(store.get('c').rev, 1);
  assert.equal(store.patch('c', { computer: { app: 'x' } }), true, 'the value the core never took is still a change');
});

test("a core's answer is taken as given: its revision, the keys it changed and the values the turn implied", () => {
  const replies = [{ rev: 4, keys: ['turn', 'runningElsewhere'], implied: { runningElsewhere: false } }, null];
  const sent: any[] = [];
  const fake = {
    dispatchSync: (route: string, payload: Buffer) => {
      if (route === 'session.open') return Buffer.from('');
      sent.push(JSON.parse(String(payload)));
      return Buffer.from(JSON.stringify(replies.shift()));
    },
  };
  const store = new SessionStore({ addon: fake });
  const published: any[] = [];
  store.publish = (p: any) => published.push(p);
  assert.equal(store.patch('c', { turn: 'running', plan: undefined }), true);
  assert.deepEqual(published, [{ chatId: 'c', rev: 4, patch: { turn: 'running', runningElsewhere: false } }]);
  assert.equal(store.get('c').rev, 4);
  assert.equal(sent[0].partial.plan, null, 'undefined goes to the core as null, as the JS rules read it');
  assert.equal(store.patch('c', { plan: false }), false);
  assert.equal(published.length, 1);
});

/** The drain over one store: what each takeNext returned, which holds were asked, and the chat's state after. */
function drains(store: any) {
  const asked: boolean[] = [];
  const held = (v: boolean) => () => (asked.push(v), v);
  const out: unknown[] = [];
  store.patch('d', { queue: [{ id: 'a' }, { id: 'b', waitingFor: 'compaction' }], turn: 'running' });
  out.push(store.takeNext('d', held(false)), 'running');
  store.patch('d', { turn: 'idle' });
  out.push(store.takeNext('d', held(true)), 'held');
  out.push(store.takeNext('d', held(false)), 'taken');
  out.push(store.takeNext('d', held(false)), 'waits');
  out.push(store.takeNext('nobody', held(false)));
  return { out, asked, d: store.snapshot('d') };
}

test('the drain takes the first queued message only when its turn is not running, it waits on nothing and nothing holds the chat', (t) => {
  fixedClock(t);
  const { out, asked, d } = drains(new SessionStore());
  assert.deepEqual(out, [null, 'running', null, 'held', { id: 'a' }, 'taken', null, 'waits', null]);
  assert.deepEqual(asked, [true, false], 'what holds the chat is asked only when the rest allows the message to go');
  assert.deepEqual(d.queue, [{ id: 'b', waitingFor: 'compaction' }]);
});

test('the core drains as the JS rules do', { skip: !addon && !required && 'no Rust core built' }, (t) => {
  fixedClock(t);
  const store = new SessionStore({ addon });
  assert.deepEqual(drains(store), drains(new SessionStore()));
});

test('a drain the core refuses at the last moment takes nothing', (t) => {
  fixedClock(t);
  const fake = {
    dispatchSync: (route: string) => {
      if (route === 'session.open') return Buffer.from('1');
      return Buffer.from(route === 'session.drainable' ? 'true' : 'null');
    },
  };
  const store = new SessionStore({ addon: fake });
  store.get('d').queue = [{ id: 'a' }];
  assert.equal(
    store.takeNext('d', () => false),
    null,
  );
});

test("the drain takes a core's answer as given: the message off the mirror's queue, the revision and the implied values", (t) => {
  fixedClock(t);
  const answers: Record<string, string[]> = {
    'session.drainable': ['false', 'true', 'true'],
    'session.drain': [JSON.stringify({ rev: 9, keys: ['queue', 'progressAt'], implied: { progressAt: null } })],
  };
  const asked: string[] = [];
  const fake = {
    dispatchSync: (route: string) => {
      asked.push(route);
      if (route === 'session.patch') return Buffer.from(JSON.stringify({ rev: 1, keys: ['queue'], implied: {} }));
      return Buffer.from(answers[route]?.shift() ?? '');
    },
  };
  const store = new SessionStore({ addon: fake });
  const item = { id: 'a', note: undefined };
  store.patch('d', { queue: [item] });
  let holds = 0;
  assert.equal(
    store.takeNext('d', () => (holds++, false)),
    null,
    'the core says it cannot go: not asked what holds it',
  );
  assert.equal(
    store.takeNext('d', () => (holds++, true)),
    null,
    'held',
  );
  const next = store.takeNext('d', () => (holds++, false));
  assert.deepEqual(next, item, 'the message as main holds it');
  assert.equal(holds, 2);
  assert.deepEqual([store.get('d').queue, store.get('d').rev], [[], 9]);
  assert.deepEqual(
    asked.filter((r) => r !== 'session.open'),
    ['session.patch', 'session.drainable', 'session.drainable', 'session.drainable', 'session.drain'],
  );
});

/** A turn's steps over one store: what each returned, what was published, and the chat's state after. */
function steps(store: any) {
  const published: any[] = [];
  store.publish = (p: any) => published.push(p);
  const out = [
    store.step('t', 'start', { turnId: 'pending-1', human: true }),
    store.step('t', 'start', { turnId: 'pending-1', human: true }),
    store.patch('t', { approvals: [{ id: 1 }] }),
    store.step('t', 'end', {}, { approvals: [{ id: 1 }], turn: 'running' }),
    store.step('t', 'start', { turnId: 'x' }),
    store.step('t', 'crash', { reason: 'it quit' }, { queue: [{ id: 'q', note: undefined }] }),
    store.step('', 'end'),
  ];
  return { out, published, t: store.snapshot('t') };
}

test("a turn's steps start, end and crash it, the step winning over what is set beside it", (t) => {
  fixedClock(t);
  const { out, t: state } = steps(new SessionStore());
  assert.deepEqual(out, [true, false, true, true, true, true, false]);
  assert.deepEqual(
    [state.turn, state.activeTurn, state.crashed, state.queue],
    ['crashed', null, 'it quit', [{ id: 'q', note: undefined }]],
  );
  assert.throws(() => new SessionStore().step('t', 'pause' as any), /did not answer session\.step: .*no turn step pause/);
  // a crash with nothing to say why says nothing
  const quiet = new SessionStore();
  quiet.step('q', 'crash');
  assert.deepEqual([quiet.get('q').turn, quiet.get('q').crashed], ['crashed', null]);
});

test("the core takes a turn's steps as the JS rules do", { skip: !addon && !required && 'no Rust core built' }, (t) => {
  fixedClock(t);
  const store = new SessionStore({ addon });
  assert.deepEqual(steps(store), steps(new SessionStore()));
});

test("a turn's step takes the core's answer as given, its arguments sent as plain values", (t) => {
  fixedClock(t);
  const sent: any[] = [];
  const fake = {
    dispatchSync: (route: string, payload: Buffer) => {
      if (route !== 'session.step') return Buffer.from('');
      sent.push(JSON.parse(String(payload)));
      const implied = { turn: 'running', activeTurn: { id: 'p', human: true }, crashed: null };
      return Buffer.from(JSON.stringify({ rev: 3, keys: ['turn', 'activeTurn', 'crashed'], implied }));
    },
  };
  const store = new SessionStore({ addon: fake });
  assert.equal(store.step('t', 'start', { turnId: 'p', human: 1 as any }), true);
  assert.deepEqual(sent[0].args, { turnId: 'p', human: true, reason: null });
  store.step('t', 'end');
  assert.deepEqual(sent[1].args, { turnId: null, human: false, reason: null }, 'no arguments: plain nulls');
  assert.deepEqual([store.get('t').turn, store.get('t').activeTurn, store.get('t').rev], ['running', { id: 'p', human: true }, 3]);
});

/** Messages put back over one store: the index each went back at, and the queue after. */
function putBacks(store: any) {
  const at: number[] = [];
  const back = (id: string, ahead = false) => {
    const i = store.putBack('p', id, ahead);
    at.push(i);
    const queue = store.get('p').queue;
    store.patch('p', { queue: [...queue.slice(0, i), { id }, ...queue.slice(i)] });
  };
  back('s');
  store.patch('p', { queue: [...store.get('p').queue, { id: 'x' }] });
  back('t');
  back('u');
  back('own', true);
  back('v');
  return { at, queue: store.get('p').queue.map((q: any) => q.id) };
}

test('a message put back goes behind those put back first in line before it, or ahead of all', () => {
  assert.deepEqual(putBacks(new SessionStore()), {
    // the turn's own message went ahead of all, and the next one put back goes behind every one at the front
    at: [0, 1, 2, 0, 4],
    queue: ['own', 's', 't', 'u', 'v', 'x'],
  });
});

test('the core puts messages back as the JS rules do', { skip: !addon && !required && 'no Rust core built' }, () => {
  const store = new SessionStore({ addon });
  assert.deepEqual(putBacks(store), putBacks(new SessionStore()));
});

/** Send-now verdicts over one store, with which capabilities were asked. */
function sendNows(store: any) {
  const asked: string[] = [];
  const flags = (peerSteers: boolean, steers: boolean) => ({
    peerSteers: () => (asked.push('peer'), peerSteers),
    steers: () => (asked.push('steers'), steers),
  });
  const out: string[] = [];
  const go = (phase: 'admit' | 'route', peer: boolean, p = true, s = true) =>
    out.push(store.sendNowRoute('n', phase, { peer, ...flags(p, s) }));
  go('admit', true);
  go('route', false);
  store.patch('n', { turn: 'running' });
  go('admit', false);
  go('admit', true, true);
  go('admit', true, false);
  go('route', false, true, true);
  go('route', false, true, false);
  store.patch('n', { turn: 'awaitingUser' });
  go('admit', true);
  store.patch('n', { turn: 'running', pendingSwitch: { harness: 'claude' } });
  go('admit', true);
  return { out, asked };
}

test('send now admits and routes a queued message by its turn, asking the capabilities only when they decide', () => {
  assert.deepEqual(sendNows(new SessionStore()), {
    out: ['admit', 'start', 'admit', 'admit', 'refuse', 'steer', 'queueFirst', 'refuse', 'refuse'],
    asked: ['peer', 'peer', 'steers', 'steers'],
  });
});

test('the core admits and routes as the JS rules do', { skip: !addon && !required && 'no Rust core built' }, () => {
  const store = new SessionStore({ addon });
  assert.deepEqual(sendNows(store), sendNows(new SessionStore()));
});

test("send now takes a fake core's verdicts, answering its ask with the capability it needs", () => {
  const sent: any[] = [];
  const answers = ['ask', 'steer', 'admit', 'ask', 'refuse', 'ask', 'queueFirst'];
  const fake = {
    dispatchSync: (route: string, payload: Buffer) => {
      if (route !== 'session.sendNow') return Buffer.from('');
      sent.push(JSON.parse(String(payload)));
      return Buffer.from(JSON.stringify(answers.shift()));
    },
  };
  const store = new SessionStore({ addon: fake });
  assert.equal(store.sendNowRoute('n', 'route', { steers: () => true }), 'steer');
  assert.deepEqual([sent[0].steers, sent[1].steers], [undefined, true]);
  assert.equal(store.sendNowRoute('n', 'admit', { peer: true }), 'admit');
  // the core asks whether the peer's harness takes a steer: asked, and sent as the one flag
  assert.equal(store.sendNowRoute('n', 'admit', { peer: true, peerSteers: () => false }), 'refuse');
  assert.deepEqual([sent[4].peerSteers, sent[4].steers], [false, undefined]);
  // no capability to ask: it can't steer
  assert.equal(store.sendNowRoute('n', 'route'), 'queueFirst');
  assert.equal(sent[6].steers, false);
});

test("a store the core will not open, or a route it fails, is the caller's failure: no second copy of the rules takes over", () => {
  assert.throws(() => new SessionStore({ addon: null }), /The Rust core is missing/);
  const refusing = {
    dispatch: async () => Buffer.alloc(0),
    dispatchSync: (route: string) => {
      if (route === 'session.open') return Buffer.alloc(0);
      throw new Error('the core went away');
    },
    routes: () => [],
  };
  const store = new SessionStore({ addon: refusing });
  assert.throws(() => store.patch('c', { plan: true }), { message: 'The Rust core did not answer session.patch: the core went away' });
  assert.throws(() => store.sendNowRoute('c', 'route'), /did not answer session\.sendNow: the core went away/);
  assert.throws(() => store.putBack('c', 'x'), /did not answer session\.putBack: the core went away/);
});
