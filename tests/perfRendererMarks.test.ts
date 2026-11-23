// A window's startup marks for Phase 0 (src/session/perf.ts, docs/architecture/rust-core.md §2): its first contentful
// paint, and the first chat on screen with its history loaded, each sent as wall-clock time for main's timeline.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installPerfProbe, observeFirstPaint, startPerfProbe, type PerfDeps, type PerfSample } from '../src/session/perf.ts';

/** A store, clock and timers that move only when the test says, with the paint observer the test drives. */
function rig(state: any, o: { origin?: number; paint?: boolean } = {}) {
  let s = state;
  const listeners = new Set<(a: any, b: any) => void>();
  const sent: PerfSample[][] = [];
  let clock = 0;
  let flush: (() => void) | null = null;
  let paint: ((startTime: number) => void) | null = null;
  let paintStopped = 0;
  const deps: PerfDeps = {
    store: { getState: () => s, subscribe: (l) => (listeners.add(l), () => listeners.delete(l)) },
    send: (b) => sent.push(b),
    now: () => 1000 + clock,
    clock: () => clock,
    raf: () => 1,
    cancelRaf: () => undefined,
    setInterval: (cb) => ((flush = cb), 7),
    clearInterval: () => undefined,
    observeLongTasks: () => null,
    visible: () => true,
    focused: () => true,
    onHidden: () => () => undefined,
    ...(o.origin === undefined ? {} : { timeOrigin: () => o.origin as number }),
    ...(o.paint === false ? {} : { observeFirstPaint: (cb: (t: number) => void) => ((paint = cb), () => void paintStopped++) }),
  };
  return {
    deps,
    set(next: any) {
      const prev = s;
      s = next;
      for (const l of listeners) l(s, prev);
    },
    tick: (ms: number) => (clock += ms),
    paint: (t: number) => paint?.(t),
    marks: () => (
      flush!(),
      sent
        .flat()
        .filter((x) => x.kind === 'mark')
        .map(({ name, at }) => ({ name, at }))
    ),
    paintStopped: () => paintStopped,
    hasPaint: () => paint !== null,
  };
}
const viewing = (loaded: boolean) => ({ route: { name: 'thread', id: 'A' }, runtime: { A: { turns: [], activeTurnId: null, loaded } } });

test('first paint and the first chat interactive are marked once, as wall-clock time', () => {
  const r = rig(viewing(false), { origin: 50_000 });
  const stop = startPerfProbe(r.deps);
  r.paint(312.344);
  r.tick(800);
  // the shown chat loads its history: interactive now; later changes mark nothing more
  r.set(viewing(true));
  r.tick(100);
  r.set({ ...viewing(true), runtime: { A: { turns: [], activeTurnId: null, loaded: true } } });
  assert.deepEqual(r.marks(), [
    { name: 'firstPaint', at: 50_312.34 },
    { name: 'chatInteractive', at: 50_800 },
  ]);
  stop();
  assert.equal(r.paintStopped(), 1);
});

test('a chat already loaded when the probe starts is interactive at once; one off screen is not', () => {
  const r = rig(viewing(true), { origin: 10 });
  startPerfProbe(r.deps);
  assert.deepEqual(r.marks(), [{ name: 'chatInteractive', at: 10 }]);
  const off = rig({ route: { name: 'settings' }, runtime: { A: { turns: [], activeTurnId: null, loaded: true } } }, { origin: 10 });
  startPerfProbe(off.deps);
  assert.deepEqual(off.marks(), []);
});

test('without the window’s time origin, or a paint observer, no marks are sent', () => {
  const r = rig(viewing(true));
  const stop = startPerfProbe(r.deps);
  assert.equal(r.hasPaint(), false);
  assert.deepEqual(r.marks(), []);
  stop();
  const noPaint = rig(viewing(false), { origin: 5, paint: false });
  startPerfProbe(noPaint.deps)();
  assert.deepEqual(noPaint.marks(), []);
});

test('observeFirstPaint reads the buffered paint entries once, for the first contentful paint only', () => {
  assert.equal(
    observeFirstPaint(() => undefined, undefined),
    null,
  );
  assert.equal(
    observeFirstPaint(() => undefined, { supportedEntryTypes: ['longtask'] } as any),
    null,
  );
  let callback: any = null;
  let options: any = null;
  let disconnected = 0;
  class Observer {
    static supportedEntryTypes = ['paint'];
    constructor(cb: any) {
      callback = cb;
    }
    observe(o: any) {
      options = o;
    }
    disconnect() {
      disconnected++;
    }
  }
  const seen: number[] = [];
  const stop = observeFirstPaint((t) => seen.push(t), Observer as any);
  assert.deepEqual(options, { type: 'paint', buffered: true });
  const list = (entries: any[]) => ({ getEntries: () => entries });
  callback(
    list([
      { name: 'first-paint', startTime: 90 },
      { name: 'first-contentful-paint', startTime: 120 },
    ]),
  );
  callback(list([{ name: 'first-contentful-paint', startTime: 400 }]));
  assert.deepEqual(seen, [120]);
  stop!();
  assert.equal(disconnected, 1);
});

test('in a window the marks count from its performance.timeOrigin', () => {
  const sent: any[] = [];
  const win: any = {
    performance: { now: () => 12, timeOrigin: 1000 },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame: () => undefined,
    setInterval: (cb: () => void) => ((win.flush = cb), 9),
    clearInterval: () => undefined,
    document: { visibilityState: 'visible', hasFocus: () => true, addEventListener() {}, removeEventListener() {} },
    PerformanceObserver: undefined,
  };
  const store = { getState: () => viewing(true) as any, subscribe: () => () => undefined };
  const native = { flags: { isEnabled: () => true, onChanged: () => () => undefined }, perf: { samples: (b: any) => sent.push(b) } };
  const off = installPerfProbe(native, store, win);
  win.flush();
  off();
  assert.deepEqual(
    sent
      .flat()
      .filter((x) => x.kind === 'mark')
      .map(({ name, at }) => ({ name, at })),
    [{ name: 'chatInteractive', at: 1012 }],
  );
});
