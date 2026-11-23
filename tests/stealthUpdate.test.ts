// The stealth restart (electron/app/stealthUpdate.cjs): ten unbroken minutes with an update ready, no window focused or full screen, and nothing to stop or ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createStealthUpdate, IDLE_MS, TICK_MS } = require('../electron/app/stealthUpdate.cjs');

function setup(over: Record<string, unknown> = {}) {
  const c: any = { enabled: true, ready: true, focused: false, fullScreen: false, quiet: true, t: 0, installs: 0, ...over };
  let interval: { fn: () => void; ms: number } | null = null;
  let cleared = false;
  const s = createStealthUpdate({
    enabled: () => c.enabled,
    ready: () => c.ready,
    focused: () => c.focused,
    fullScreen: () => c.fullScreen,
    quiet: async () => c.quiet,
    install: async () => {
      c.installs++;
      assert.equal(s.installing, true, 'the exit gate hears it is a stealth restart');
      if (c.fail) throw new Error('boom');
    },
    now: () => c.t,
    timers: {
      setInterval: (fn: () => void, ms: number) => ((interval = { fn, ms }), { unref() {} }),
      clearInterval: () => (cleared = true),
    } as any,
  });
  return { c, s, interval: () => interval!, cleared: () => cleared };
}

test('it restarts once every condition has held for ten minutes, and not a moment before', async () => {
  const { c, s, interval } = setup();
  assert.equal(interval().ms, TICK_MS);
  await s.tick();
  c.t = IDLE_MS - 1;
  await s.tick();
  assert.equal(c.installs, 0);
  c.t = IDLE_MS;
  await s.tick();
  assert.equal(c.installs, 1);
  assert.equal(s.installing, false);
  // the wait starts again after a restart that did not happen
  c.t = IDLE_MS + 1;
  await s.tick();
  assert.equal(c.installs, 1);
});

for (const [blocker, over] of [
  ['the switch is off', { enabled: false }],
  ['no update is ready', { ready: false }],
  ['a window has focus', { focused: true }],
  ['a window is full screen', { fullScreen: true }],
  ['quitting would stop or ask something', { quiet: false }],
] as const) {
  test(`${blocker}: the ten minutes start again`, async () => {
    const { c, s } = setup();
    await s.tick();
    c.t = IDLE_MS / 2;
    Object.assign(c, over);
    await s.tick();
    Object.assign(c, { enabled: true, ready: true, focused: false, fullScreen: false, quiet: true });
    c.t = IDLE_MS;
    await s.tick();
    assert.equal(c.installs, 0, 'counted again from the break');
    c.t = 2 * IDLE_MS;
    await s.tick();
    assert.equal(c.installs, 1);
  });
}

test('a window gaining focus resets the wait between reads; a failed restart is reported, not left installing', async () => {
  const { c, s, interval, cleared } = setup({ fail: true });
  await s.tick();
  c.t = IDLE_MS - 1;
  s.reset();
  await s.tick();
  c.t = IDLE_MS;
  await s.tick();
  assert.equal(c.installs, 0);
  c.t = 2 * IDLE_MS;
  await assert.rejects(s.tick(), /boom/);
  assert.equal(s.installing, false);
  // the timer's own read reports a failure instead of throwing
  for (const t of [4 * IDLE_MS, 5 * IDLE_MS]) {
    c.t = t;
    interval().fn();
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(c.installs, 2);
  s.stop();
  assert.equal(cleared(), true);
});

test('reads never overlap: one under way makes another return at once', async () => {
  const waiting: (() => void)[] = [];
  const release = () => {
    for (const r of waiting.splice(0)) r();
  };
  let t = 0;
  let reads = 0;
  let installs = 0;
  const s = createStealthUpdate({
    enabled: () => true,
    ready: () => true,
    focused: () => false,
    fullScreen: () => false,
    quiet: () => (reads++, new Promise<boolean>((r) => waiting.push(() => r(true)))),
    install: async () => {
      installs++;
    },
    now: () => t,
    timers: { setInterval: () => ({}), clearInterval: () => {} } as any,
  });
  const first = s.tick();
  const second = s.tick();
  // the second tick makes no read of its own while the first waits for its read, and returns at once
  assert.equal(reads, 1);
  await second;
  release();
  await first;
  // once the first is done, the next tick reads again and, ten minutes on, restarts
  t = IDLE_MS;
  const next = s.tick();
  release();
  await next;
  assert.deepEqual([reads, installs], [2, 1]);
});

test("by default it reads the clock and a real, unref'd timer", async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 0 });
  const realSetInterval = globalThis.setInterval;
  let timer: any;
  globalThis.setInterval = ((fn: () => void, ms: number) => (timer = realSetInterval(fn, ms))) as typeof setInterval;
  let installs = 0;
  let s: any;
  try {
    s = createStealthUpdate({
      enabled: () => true,
      ready: () => true,
      focused: () => false,
      fullScreen: () => false,
      quiet: async () => true,
      install: async () => {
        installs++;
      },
    });
  } finally {
    globalThis.setInterval = realSetInterval;
  }
  t.after(() => s.stop());
  assert.equal(timer.hasRef(), false, 'the timer never keeps the app running');
  await s.tick();
  t.mock.timers.tick(IDLE_MS);
  await s.tick();
  assert.equal(installs, 1, 'ten minutes on the real clock');
});
