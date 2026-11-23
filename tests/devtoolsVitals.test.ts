// browser_vitals' page side and text (devtools/vitals.cjs): the in-page collector over fake PerformanceObservers, thresholds and the tool's text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { pageVitals, VITALS_SOURCE, rate, vitalsText } = require('../electron/capabilities/browser/devtools/vitals.cjs');

test('rate sits on the thresholds', () => {
  assert.equal(rate('lcp', 2500), 'good');
  assert.equal(rate('lcp', 2501), 'needs improvement');
  assert.equal(rate('lcp', 4000), 'needs improvement');
  assert.equal(rate('lcp', 4001), 'poor');
});

test('vitalsText for full and empty metrics', () => {
  const full = vitalsText({
    url: 'https://x.test/',
    lcp: { ms: 3000, element: 'img#hero' },
    cls: 0.05,
    inp: { ms: 300, event: 'click', target: 'button' },
    interactions: 5,
    fcp: 1000,
    ttfb: 900,
    load: 1200,
    longTasks: { count: 1, totalMs: 60, longestMs: 60 },
  });
  assert.equal(
    full,
    [
      'Web Vitals of https://x.test/:',
      'LCP: 3000 ms (needs improvement), img#hero',
      'CLS: 0.05 (good)',
      'INP: 300 ms (needs improvement), click on button (5 interactions)',
      'FCP: 1000 ms (good)',
      'TTFB: 900 ms (needs improvement)',
      'Load: 1200 ms. Long tasks: 1 (60 ms in all, longest 60 ms).',
    ].join('\n'),
  );
  const bare = vitalsText({
    url: 'u',
    lcp: { ms: 1 },
    cls: 0,
    inp: { ms: 1, event: 'key', target: '' },
    interactions: 1,
    fcp: null,
    ttfb: null,
    load: null,
    longTasks: { count: 0 },
  });
  assert.match(bare, /LCP: 1 ms \(good\)\n/);
  assert.match(bare, /INP: 1 ms \(good\), key \(1 interactions\)/);
  assert.match(bare, /FCP: not measured\nTTFB: not measured\nLoad: not finished\. Long tasks: 0\./);
  const empty = vitalsText({
    url: 'u',
    lcp: null,
    cls: 0,
    inp: null,
    interactions: 0,
    fcp: null,
    ttfb: null,
    load: null,
    longTasks: { count: 0 },
  });
  assert.match(empty, /LCP: not measured\n/);
  assert.match(empty, /INP: not measured \(no interaction yet\)/);
});

test('VITALS_SOURCE evaluates to the collector function', () => {
  assert.equal(typeof new Function(`return ${VITALS_SOURCE}`)(), 'function');
});

type Entries = Record<string, any[]>;

/** Runs pageVitals with fake globals; unsupported entry types throw on observe. */
async function runVitals(entries: Entries, opts: any, o: { unsupported?: string[]; nav?: any[] } = {}) {
  const keys = ['PerformanceObserver', 'performance', 'location', 'setTimeout'] as const;
  const saved = keys.map((k) => [k, Object.getOwnPropertyDescriptor(globalThis, k)] as const);
  const g = globalThis as any;
  const observers: any[] = [];
  const observed: any[] = [];
  const delays: number[] = [];
  const def = (k: string, value: unknown) => Object.defineProperty(globalThis, k, { value, configurable: true, writable: true });
  def(
    'PerformanceObserver',
    class {
      disconnected = false;
      cb: (l: any) => void;
      constructor(cb: (l: any) => void) {
        this.cb = cb;
        observers.push(this);
      }
      observe(init: any) {
        observed.push(init);
        if (o.unsupported?.includes(init.type)) throw new TypeError('unsupported');
        this.cb({ getEntries: () => entries[init.type] ?? [] });
      }
      disconnect() {
        this.disconnected = true;
      }
    },
  );
  def('performance', { getEntriesByType: (t: string) => (t === 'navigation' ? (o.nav ?? []) : []) });
  def('location', { href: 'https://x.test/a?b=1#h', origin: 'https://x.test', pathname: '/a' });
  def('setTimeout', (fn: () => void, ms: number) => {
    delays.push(ms);
    fn();
  });
  try {
    const out = await pageVitals(opts);
    return { out, observers, observed, delays };
  } finally {
    for (const [k, d] of saved) {
      if (d) Object.defineProperty(globalThis, k, d);
      else delete g[k];
    }
  }
}

test('pageVitals reads LCP and describes the element', async () => {
  const cases: Array<[any, string]> = [
    [null, ''],
    [{}, ''],
    [{ tagName: 'IMG', id: 'hero', className: 'c' }, 'img#hero'],
    [{ tagName: 'DIV', id: '', className: '  big  foo' }, 'div.big'],
    [{ tagName: 'P', className: {} }, 'p'],
    [{ tagName: 'SPAN', className: '   ' }, 'span'],
  ];
  for (const [element, want] of cases) {
    const { out } = await runVitals(
      {
        'largest-contentful-paint': [
          { startTime: 100, element: { tagName: 'B' }, size: 1 },
          { startTime: 1200.4, element, size: 7 },
        ],
      },
      {},
    );
    assert.deepEqual(out.lcp, { ms: 1200, element: want, size: 7 });
    assert.equal(out.url, 'https://x.test/a');
  }
  assert.equal((await runVitals({}, {})).out.lcp, null);
});

test('pageVitals computes CLS as the largest session window', async () => {
  const shift = (startTime: number, value: number, hadRecentInput = false) => ({ startTime, value, hadRecentInput });
  const list = [shift(100, 0.05), shift(500, 0.04), shift(600, 9, true), shift(2000, 0.03)];
  for (const s of [2000, 2900, 3800, 4700, 5600, 6500, 7400]) list.push(shift(s, 0.02));
  const { out } = await runVitals({ 'layout-shift': list }, {});
  assert.equal(out.cls, 0.15);
});

test('pageVitals reports INP, ignoring events with no interaction, with the percentile for many', async () => {
  const ev = (interactionId: number | undefined, duration: number, name = 'click', target: any = { tagName: 'BUTTON', id: 'b' }) => ({
    interactionId,
    duration,
    name,
    target,
  });
  const { out } = await runVitals({ event: [ev(0, 999), ev(1, 40), ev(1, 120.2, 'keydown'), ev(1, 100), ev(2, 80)] }, {});
  assert.deepEqual(out.inp, { ms: 120, event: 'keydown', target: 'button#b' });
  assert.equal(out.interactions, 2);
  const many = Array.from({ length: 100 }, (_v, i) => ev(i + 1, i + 1));
  const r = await runVitals({ event: many }, {});
  assert.equal(r.out.inp.ms, 98);
  assert.equal(r.out.interactions, 100);
  const none = await runVitals({}, {});
  assert.equal(none.out.inp, null);
  assert.equal(none.out.interactions, 0);
  assert.equal(none.observed.find((x: any) => x.type === 'event').durationThreshold, 16);
});

test('pageVitals reads FCP from the paint entries and the navigation timing', async () => {
  const paint = {
    paint: [
      { name: 'first-paint', startTime: 10 },
      { name: 'first-contentful-paint', startTime: 20.6 },
    ],
  };
  const a = await runVitals(paint, {}, { nav: [{ responseStart: 12.4, loadEventEnd: 0 }] });
  assert.equal(a.out.fcp, 21);
  assert.equal(a.out.ttfb, 12);
  assert.equal(a.out.load, null);
  const b = await runVitals({}, {}, { nav: [{ responseStart: 5, loadEventEnd: 900.2 }] });
  assert.equal(b.out.fcp, null);
  assert.equal(b.out.load, 900);
  const c = await runVitals({}, {});
  assert.equal(c.out.ttfb, null);
  assert.equal(c.out.load, null);
});

test('pageVitals counts long animation frames, or long tasks where those are unsupported', async () => {
  const frames = [{ duration: 49 }, { duration: 60.4 }, { duration: 120 }];
  const a = await runVitals({ 'long-animation-frame': frames, longtask: [{ duration: 500 }] }, {});
  assert.deepEqual(a.out.longTasks, { count: 2, totalMs: 180, longestMs: 120 });
  assert.equal(a.observers.length, 5);
  assert.ok(a.observers.every((x) => x.disconnected));
  const b = await runVitals({ longtask: frames }, {}, { unsupported: ['long-animation-frame'] });
  assert.deepEqual(b.out.longTasks, { count: 2, totalMs: 180, longestMs: 120 });
  // the unsupported type's observer was made, but it never observed: only the five that did are disconnected
  assert.equal(b.observers.length, 6);
  assert.equal(b.observers.filter((x) => x.disconnected).length, 5);
  const c = await runVitals({}, {}, { unsupported: ['long-animation-frame', 'longtask'] });
  assert.equal(c.out.longTasks.count, 0);
});

test('pageVitals clamps waitMs', async () => {
  const delay = async (opts: any) => (await runVitals({}, opts)).delays[0];
  assert.equal(await delay({ waitMs: -5 }), 0);
  assert.equal(await delay({ waitMs: 99_999 }), 5000);
  assert.equal(await delay({ waitMs: 100 }), 100);
  assert.equal(await delay({}), 250);
  assert.equal(await delay(undefined), 250);
});
