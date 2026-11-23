// A window's streaming performance probe (src/session/perf.ts) on a fake clock and frames: store commits per thread, frame
// intervals, first-token latency, long tasks and React commit time, each with what the window showed, sent once a second
// and only while the shared.perf.probe switch is on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FLUSH_MS,
  MAX_PENDING,
  followPerfFlag,
  installPerfProbe,
  noteBadgeRead,
  noteReveal,
  observeLongTasks,
  reactCommit,
  startPerfProbe,
  type PerfDeps,
  type PerfSample,
} from '../src/session/perf.ts';

const turn = (id: string, status: string, text?: string) => ({
  id,
  status,
  items: text === undefined ? [{ type: 'userMessage' }] : [{ type: 'userMessage' }, { type: 'agentMessage', text }, { type: 'reasoning' }],
});
const runtime = (turns: any[], activeTurnId: string | null = null) => ({ turns, activeTurnId });

/** A store, clock, frames and timers that move only when the test says. */
function rig(state: any = { route: { name: 'thread', id: 'A' }, runtime: {} }) {
  let s = state;
  const listeners = new Set<(a: any, b: any) => void>();
  const sent: PerfSample[][] = [];
  let clock = 0;
  let frameCb: ((ts: number) => void) | null = null;
  let interval: (() => void) | null = null;
  let longTask: ((ms: number) => void) | null = null;
  let hidden: (() => void) | null = null;
  let visible = true;
  const calls = { cancelRaf: 0, clearInterval: 0, stopLongTasks: 0, offHidden: 0 };
  const deps: PerfDeps = {
    store: {
      getState: () => s,
      subscribe: (l) => (listeners.add(l), () => listeners.delete(l)),
    },
    send: (b) => sent.push(b),
    now: () => 1000 + clock,
    clock: () => clock,
    raf: (cb) => ((frameCb = cb), 1),
    cancelRaf: () => void calls.cancelRaf++,
    setInterval: (cb, ms) => (assert.equal(ms, FLUSH_MS), (interval = cb), 7),
    clearInterval: (id) => (assert.equal(id, 7), void calls.clearInterval++),
    observeLongTasks: (cb) => ((longTask = cb), () => void calls.stopLongTasks++),
    visible: () => visible,
    focused: () => false,
    onHidden: (cb) => ((hidden = cb), () => void calls.offHidden++),
  };
  return {
    deps,
    sent,
    calls,
    set(next: any) {
      const prev = s;
      s = next;
      for (const l of listeners) l(s, prev);
    },
    get state() {
      return s;
    },
    tick: (ms: number) => (clock += ms),
    frame: (ts: number) => frameCb!(ts),
    flush: () => interval!(),
    longTask: (ms: number) => longTask!(ms),
    hide: () => ((visible = false), hidden!()),
    show: () => void (visible = true),
    listeners,
  };
}

test('commits are counted per thread whose runtime changed, and sent once a second with what the window showed', () => {
  const r = rig({ route: { name: 'thread', id: 'A' }, runtime: { A: runtime([turn('t1', 'completed', 'hi')]) } });
  const stop = startPerfProbe(r.deps);
  const b = runtime([turn('b1', 'inProgress')]);
  r.set({ ...r.state, runtime: { ...r.state.runtime, B: b } });
  r.set({ ...r.state, runtime: { ...r.state.runtime, B: runtime([turn('b1', 'inProgress')]) } });
  r.set({ ...r.state, route: { name: 'home' } });
  r.flush();
  assert.deepEqual(r.sent, [[{ t: 1000, visible: true, focused: false, turns: 0, streaming: 0, kind: 'commit', thread: 'B', count: 2 }]]);
  r.flush();
  assert.equal(r.sent.length, 1, 'nothing to send, nothing sent');
  stop();
});

test('frame intervals and the first painted token of each turn, against the streaming item of the open thread', () => {
  const r = rig({ route: { name: 'thread', id: 'A' }, runtime: { A: runtime([turn('t1', 'completed', 'old')]) } });
  const stop = startPerfProbe(r.deps);
  r.frame(100);
  r.tick(5);
  // the turn starts with no text yet: not a first token
  r.set({ ...r.state, runtime: { A: runtime([turn('t1', 'completed', 'old'), turn('t2', 'inProgress')]) } });
  r.set({ ...r.state, runtime: { A: runtime([turn('t1', 'completed', 'old'), turn('t2', 'inProgress', 'He')], 't2') } });
  r.tick(4);
  r.set({ ...r.state, runtime: { A: runtime([turn('t1', 'completed', 'old'), turn('t2', 'inProgress', 'Hello')], 't2') } });
  r.tick(3);
  r.frame(116.66);
  r.frame(150);
  r.flush();
  const got = r.sent[0].map(({ t, visible, focused, ...rest }) => rest);
  assert.deepEqual(got, [
    { turns: 2, streaming: 5, kind: 'frame', ms: 16.66 },
    { turns: 2, streaming: 5, kind: 'firstToken', chat: 'A', ms: 7 },
    { turns: 2, streaming: 5, kind: 'frame', ms: 33.34 },
    { turns: 2, streaming: 5, kind: 'commit', thread: 'A', count: 3 },
  ]);
  stop();
});

test('a thread with no runtime, no turns or no reply shows as empty; the active turn wins over the last one', () => {
  const r = rig({ route: { name: 'thread', id: 'Z' }, runtime: {} });
  const stop = startPerfProbe(r.deps);
  r.longTask(72.5);
  r.set({ route: { name: 'thread', id: 'A' }, runtime: { A: runtime([]) } });
  r.longTask(51);
  r.set({ ...r.state, runtime: { A: runtime([turn('t1', 'inProgress', 'abc'), turn('t2', 'completed', 'zz')], 't1') } });
  r.longTask(50);
  r.set({ ...r.state, runtime: { A: runtime([turn('t1', 'completed', 'abc')], 'gone') } });
  r.longTask(49);
  r.set({ ...r.state, runtime: { A: runtime([{ id: 't3', status: 'inProgress', items: [{ type: 'agentMessage', text: 7 }] }]) } });
  r.longTask(48);
  r.flush();
  const longTasks = r.sent[0].filter((x) => x.kind === 'longtask').map((x) => [x.ms, x.turns, x.streaming]);
  assert.deepEqual(longTasks, [
    [72.5, 0, 0],
    [51, 0, 0],
    [50, 2, 3],
    [49, 1, 0],
    [48, 1, 0],
  ]);
  stop();
});

test('a store write that leaves the runtime map alone counts nothing, and a turn measured once is not measured again', () => {
  const r = rig({ route: { name: 'thread', id: 'A' }, runtime: { A: runtime([turn('t1', 'inProgress', 'x')]) } });
  const stop = startPerfProbe(r.deps);
  r.set({ ...r.state, route: { name: 'thread', id: 'A' } });
  r.set({ ...r.state, runtime: { A: runtime([turn('t1', 'inProgress', 'xy')]) } });
  r.set({ ...r.state, runtime: { A: runtime([turn('t1', 'inProgress', 'xyz')]) } });
  r.frame(1);
  r.flush();
  assert.equal(r.sent[0].filter((x) => x.kind === 'firstToken').length, 1);
  assert.deepEqual(
    r.sent[0].filter((x) => x.kind === 'commit').map((x) => x.count),
    [2],
  );
  stop();
});

test('first-token turns are remembered up to a bound, the oldest forgotten first', () => {
  const r = rig({ route: { name: 'thread', id: 'A' }, runtime: {} });
  const stop = startPerfProbe(r.deps);
  for (let i = 0; i < 501; i++) r.set({ ...r.state, runtime: { A: runtime([turn(`t${i}`, 'inProgress', 'x')]) } });
  // t0 was forgotten: seen again, it is measured again
  r.set({ ...r.state, runtime: { A: runtime([turn('t0', 'inProgress', 'x')]) } });
  r.frame(1);
  r.flush();
  assert.equal(r.sent[0].filter((x) => x.kind === 'firstToken').length, 1, 'one per frame per thread');
  stop();
});

test('past its bound a window drops samples and says how many; stopping sends what it holds and lets go of everything', () => {
  const r = rig();
  const stop = startPerfProbe(r.deps);
  for (let i = 0; i < MAX_PENDING + 3; i++) r.longTask(50);
  r.flush();
  assert.equal(r.sent[0].length, MAX_PENDING + 1);
  assert.deepEqual(r.sent[0].at(-1), { t: 1000, kind: 'dropped', count: 3 });
  reactCommit('app', 'update', 3.14159, 0, 0, 0);
  noteReveal(22);
  stop();
  assert.deepEqual(
    r.sent[1].map((x) => [x.kind, x.ms ?? x.chars, x.components]),
    [
      ['react', 3.14, 'app'],
      ['reveal', 22, undefined],
    ],
  );
  assert.deepEqual(r.calls, { cancelRaf: 1, clearInterval: 1, stopLongTasks: 1, offHidden: 1 });
  assert.equal(r.listeners.size, 0);
  // stopped: React's commits and reveal steps go nowhere
  reactCommit('app', 'update', 1, 0, 0, 0);
  noteReveal(5);
  assert.equal(r.sent.length, 2);
});

test('a probe stopped after another started leaves the newer one receiving React commits; no long-task support is fine', () => {
  const a = rig();
  const b = rig();
  b.deps.observeLongTasks = () => null;
  const stopA = startPerfProbe(a.deps);
  const stopB = startPerfProbe(b.deps);
  stopA();
  reactCommit('app', 'mount', 2, 0, 0, 0);
  stopB();
  assert.deepEqual(
    b.sent[0].map((x) => x.kind),
    ['react'],
  );
});

test('long tasks come from PerformanceObserver where the browser lists them', () => {
  assert.equal(
    observeLongTasks(() => undefined, undefined),
    null,
  );
  assert.equal(
    observeLongTasks(() => undefined, { supportedEntryTypes: ['mark'] } as any),
    null,
  );
  const got: number[] = [];
  let observed: any;
  let disconnected = false;
  class Observer {
    static supportedEntryTypes = ['longtask'];
    cb: (list: { getEntries(): { duration: number }[] }) => void;
    constructor(cb: (list: { getEntries(): { duration: number }[] }) => void) {
      this.cb = cb;
    }
    observe(o: any) {
      observed = { o, cb: this.cb };
    }
    disconnect() {
      disconnected = true;
    }
  }
  const stop = observeLongTasks((ms) => got.push(ms), Observer as any)!;
  assert.deepEqual(observed.o, { type: 'longtask' });
  observed.cb({ getEntries: () => [{ duration: 51.234 }, { duration: 80 }] });
  assert.deepEqual(got, [51.23, 80]);
  stop();
  assert.equal(disconnected, true);
});

test('the probe runs while the switch is on, and stops when it turns off or the window lets go', () => {
  let on = false;
  let changed: (() => void) | null = null;
  let unsubscribed = false;
  const flags = {
    isEnabled: (k: string) => (assert.equal(k, 'shared.perf.probe'), on),
    onChanged: (cb: () => void) => ((changed = cb), () => void (unsubscribed = true)),
  };
  const r = rig();
  let started = 0;
  const off = followPerfFlag(flags, () => (started++, r.deps));
  assert.equal(started, 0);
  on = true;
  changed!();
  changed!();
  assert.equal(started, 1);
  assert.equal(r.listeners.size, 1);
  on = false;
  changed!();
  assert.equal(r.listeners.size, 0);
  changed!();
  on = true;
  changed!();
  off();
  assert.equal(unsubscribed, true);
  assert.equal(r.listeners.size, 0);
  off();
});

test('in a window the probe uses its clocks, frames, timers and focus, and sends through the bridge', () => {
  const sent: any[] = [];
  const calls: string[] = [];
  const win: any = {
    performance: { now: () => 12 },
    requestAnimationFrame: (cb: any) => (calls.push('raf'), (win.frame = cb), 3),
    cancelAnimationFrame: (id: number) => calls.push(`cancel ${id}`),
    setInterval: (cb: () => void, ms: number) => (calls.push(`every ${ms}`), (win.flush = cb), 9),
    clearInterval: (id: number) => calls.push(`clear ${id}`),
    document: {
      visibilityState: 'visible',
      hasFocus: () => true,
      listeners: new Map<string, () => void>(),
      addEventListener(type: string, cb: () => void) {
        this.listeners.set(type, cb);
      },
      removeEventListener(type: string) {
        this.listeners.delete(type);
      },
    },
    PerformanceObserver: undefined,
  };
  const store = { getState: () => ({ route: { name: 'home' }, runtime: {} }) as any, subscribe: () => () => undefined };
  const native = { flags: { isEnabled: () => true, onChanged: () => () => undefined }, perf: { samples: (b: any) => sent.push(b) } };
  const off = installPerfProbe(native, store, win);
  reactCommit('app', 'update', 1, 0, 0, 0);
  win.frame(16);
  // shown again: the window's own event, which only a hide passes on
  win.document.listeners.get('visibilitychange')();
  win.document.visibilityState = 'hidden';
  win.document.listeners.get('visibilitychange')();
  win.frame(5000);
  win.flush();
  off();
  assert.equal(win.document.listeners.size, 0);
  assert.equal(sent[0].filter((x: any) => x.kind === 'frame').length, 0, 'the frame after a hide is no interval');
  assert.deepEqual(sent[0][0], {
    t: sent[0][0].t,
    visible: true,
    focused: true,
    turns: 0,
    streaming: 0,
    kind: 'react',
    ms: 1,
    components: 'app',
  });
  assert.deepEqual(calls, ['raf', 'every 1000', 'raf', 'raf', 'cancel 3', 'clear 9']);
});

test('the frame after a window was hidden is not an interval, and only the shown thread of a window on screen gets first tokens', () => {
  const r = rig({ route: { name: 'thread', id: 'A' }, runtime: {} });
  const stop = startPerfProbe(r.deps);
  r.frame(0);
  r.frame(16);
  r.hide();
  // a background chat, and the shown one while hidden: nothing painted, nothing measured
  r.set({ ...r.state, runtime: { B: runtime([turn('b', 'inProgress', 'x')]) } });
  r.set({ ...r.state, runtime: { ...r.state.runtime, A: runtime([turn('a', 'inProgress', 'x')]) } });
  r.show();
  r.frame(30_000);
  r.frame(30_016);
  r.set({ ...r.state, runtime: { ...r.state.runtime, A: runtime([turn('a', 'inProgress', 'xy')]) } });
  r.frame(30_032);
  r.flush();
  const got = r.sent[0].filter((x) => x.kind === 'frame' || x.kind === 'firstToken').map((x) => [x.kind, x.ms]);
  assert.deepEqual(got, [
    ['frame', 16],
    ['frame', 16],
    ['frame', 16],
    ['firstToken', 0],
  ]);
  stop();
});

test('a badge read is a sample with its trigger while a probe runs, and nothing before or after one (#2963)', () => {
  noteBadgeRead('before');
  const r = rig();
  const stop = startPerfProbe(r.deps);
  noteBadgeRead('updatedAt');
  noteBadgeRead('poll');
  stop();
  assert.deepEqual(
    r.sent[0].map((x) => [x.kind, x.trigger]),
    [
      ['badgeRead', 'updatedAt'],
      ['badgeRead', 'poll'],
    ],
  );
  noteBadgeRead('after');
  assert.equal(r.sent.length, 1);
});
