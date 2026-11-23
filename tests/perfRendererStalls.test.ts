// The renderer's stall evidence (src/session/perf.ts): Long Animation Frames with their longest script, slow input events with the
// loaded-turn count as probe samples, and the always-on counter of stalls of 200 ms or more.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STALL_MS,
  SLOW_EVENT_MS,
  countRendererStalls,
  installPerfProbe,
  observeLongFrames,
  observeSlowEvents,
  rendererStalls,
  startPerfProbe,
  type PerfDeps,
  type PerfSample,
} from '../src/session/perf.ts';

type Rec = { cb: (l: { getEntries(): unknown[] }) => void; opts?: any; disconnected: boolean };

/** A PerformanceObserver that delivers what a test hands its callbacks. */
function fakeObserver(types: string[]) {
  const made: Rec[] = [];
  class Observer {
    static supportedEntryTypes = types;
    rec: Rec;
    constructor(cb: Rec['cb']) {
      this.rec = { cb, disconnected: false };
      made.push(this.rec);
    }
    observe(o: any) {
      this.rec.opts = o;
    }
    disconnect() {
      this.rec.disconnected = true;
    }
  }
  return { Observer: Observer as any, made };
}
const deliver = (rec: Rec, ...entries: unknown[]) => rec.cb({ getEntries: () => entries });

test('long animation frames carry the longest script, or none', () => {
  assert.equal(
    observeLongFrames(() => undefined, { supportedEntryTypes: ['longtask'] } as any),
    null,
  );
  const { Observer, made } = fakeObserver(['long-animation-frame']);
  const got: unknown[] = [];
  const stop = observeLongFrames((f) => got.push(f), Observer)!;
  assert.equal(made[0].opts.type, 'long-animation-frame');
  deliver(
    made[0],
    {
      duration: 120.456,
      blockingDuration: 70.111,
      scripts: [
        { duration: 10, sourceURL: 'a.js', sourceFunctionName: 'a', invoker: 'IMG#x.onload' },
        { duration: 90.567, sourceURL: 'app.js', sourceFunctionName: 'render', invoker: 'TimerHandler:setInterval' },
        { duration: 20, sourceURL: 'b.js' },
      ],
    },
    { duration: 60 },
    { duration: 55, scripts: [{ duration: 5 }] },
  );
  assert.deepEqual(got, [
    { ms: 120.46, blocking: 70.11, script: { url: 'app.js', fn: 'render', invoker: 'TimerHandler:setInterval', ms: 90.57 } },
    { ms: 60, blocking: 0, script: null },
    { ms: 55, blocking: 0, script: { url: '', fn: '', invoker: '', ms: 5 } },
  ]);
  stop();
  assert.equal(made[0].disconnected, true);
});

test('slow events are keydown, input and pointer events of 100 ms or more', () => {
  assert.equal(
    observeSlowEvents(() => undefined, undefined as any),
    null,
  );
  assert.equal(
    observeSlowEvents(() => undefined, { supportedEntryTypes: ['longtask'] } as any),
    null,
  );
  const { Observer, made } = fakeObserver(['event']);
  const got: unknown[] = [];
  const stop = observeSlowEvents((e) => got.push(e), Observer)!;
  assert.deepEqual(made[0].opts, { type: 'event', durationThreshold: SLOW_EVENT_MS });
  const e = (name: string, duration: number) => ({ name, duration, startTime: 10, processingStart: 40.4, processingEnd: 130.6 });
  deliver(made[0], e('keydown', 150), e('input', 100), e('pointerdown', 99), e('pointerup', 300), e('click', 500), e('mouseover', 400));
  assert.deepEqual(got, [
    { name: 'keydown', ms: 150, delay: 30, processing: 90 },
    { name: 'input', ms: 100, delay: 30, processing: 90 },
    { name: 'pointerup', ms: 300, delay: 30, processing: 90 },
  ]);
  stop();
  assert.equal(made[0].disconnected, true);
});

test('the always-on counter counts stalls of 200 ms or more and keeps the longest', () => {
  assert.equal(countRendererStalls({ supportedEntryTypes: [] } as any), null);
  const { Observer, made } = fakeObserver(['longtask']);
  const before = { ...rendererStalls };
  const stop = countRendererStalls(Observer)!;
  deliver(made[0], { duration: 80 }, { duration: STALL_MS }, { duration: 450 }, { duration: 300 });
  assert.equal(rendererStalls.count, before.count + 3);
  assert.equal(rendererStalls.maxMs, Math.max(before.maxMs, 450));
  stop();
  assert.equal(made[0].disconnected, true);
});

function deps(extra: Partial<PerfDeps>) {
  const sent: PerfSample[][] = [];
  let flush: () => void = () => undefined;
  const turns = new Array(7).fill({ id: 't', status: 'completed', items: [] });
  const d: PerfDeps = {
    store: {
      getState: () => ({ route: { name: 'thread', id: 'A' }, runtime: { A: { turns, activeTurnId: null } } }) as any,
      subscribe: () => () => undefined,
    },
    send: (b) => sent.push(b),
    now: () => 5,
    clock: () => 0,
    raf: () => 1,
    cancelRaf: () => undefined,
    setInterval: (cb) => ((flush = cb), 1),
    clearInterval: () => undefined,
    observeLongTasks: () => null,
    visible: () => true,
    focused: () => true,
    onHidden: () => () => undefined,
    ...extra,
  };
  return { d, sent, flush: () => flush() };
}

test('the probe samples long frames and slow events with the loaded turns, and stops both observers', () => {
  let frame: (f: any) => void = () => undefined;
  let event: (e: any) => void = () => undefined;
  const stopped: string[] = [];
  const r = deps({
    observeLongFrames: (cb) => ((frame = cb), () => void stopped.push('frames')),
    observeSlowEvents: (cb) => ((event = cb), () => void stopped.push('events')),
  });
  const stop = startPerfProbe(r.d);
  frame({ ms: 90, blocking: 40, script: null });
  event({ name: 'keydown', ms: 120, delay: 10, processing: 100 });
  r.flush();
  stop();
  const [loaf, ev] = r.sent[0];
  assert.deepEqual(loaf, { t: 5, visible: true, focused: true, turns: 7, streaming: 0, kind: 'loaf', ms: 90, blocking: 40, script: null });
  assert.deepEqual(ev, {
    t: 5,
    visible: true,
    focused: true,
    turns: 7,
    streaming: 0,
    kind: 'event',
    name: 'keydown',
    ms: 120,
    delay: 10,
    processing: 100,
  });
  assert.deepEqual(stopped, ['frames', 'events']);
});

test('a probe without the observers, or where the browser has none, still runs', () => {
  startPerfProbe(deps({ observeLongFrames: () => null, observeSlowEvents: () => null }).d)();
  startPerfProbe(deps({}).d)();
});

test('the probe reports the stall counter only when it moved', () => {
  const r = deps({});
  const stop = startPerfProbe(r.d);
  r.flush();
  assert.equal(r.sent.length, 0);
  rendererStalls.count++;
  rendererStalls.maxMs = Math.max(rendererStalls.maxMs, 333);
  r.flush();
  const s = r.sent[0].find((x) => x.kind === 'stalls')!;
  assert.equal(s.count, rendererStalls.count);
  assert.equal(s.maxMs, rendererStalls.maxMs);
  r.flush();
  assert.equal(r.sent.length, 1);
  stop();
});

function fakeWindow(observer: unknown) {
  return {
    PerformanceObserver: observer,
    performance: { now: () => 0 },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
    document: { visibilityState: 'visible', hasFocus: () => true, addEventListener: () => undefined, removeEventListener: () => undefined },
  } as any;
}
const idleStore = { getState: () => ({ route: { name: 'home' }, runtime: {} }) as any, subscribe: () => () => undefined };

test('a window counts stalls from its install until its stop, and feeds the probe its observers', () => {
  const { Observer, made } = fakeObserver(['longtask', 'long-animation-frame', 'event']);
  const native = { flags: { isEnabled: () => true, onChanged: () => () => undefined }, perf: { samples: () => undefined } };
  const off = installPerfProbe(native, idleStore, fakeWindow(Observer));
  // the counter, then the probe's long tasks, long frames and events
  assert.deepEqual(
    made.map((m) => m.opts.type),
    ['longtask', 'longtask', 'long-animation-frame', 'event'],
  );
  off();
  assert.ok(made.every((m) => m.disconnected));
});

test('a window without long-task entries has no counter to stop', () => {
  const native = { flags: { isEnabled: () => false, onChanged: () => () => undefined }, perf: { samples: () => undefined } };
  installPerfProbe(native, idleStore, fakeWindow({ supportedEntryTypes: [] }))();
});
