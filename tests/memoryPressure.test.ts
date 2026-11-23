// electron/platform/memoryPressure.cjs: the system's memory pressure, read from macOS's level or the share of free memory,
// told to subscribers on every reading under pressure and once on its return to normal; polled only while subscribed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  createMemoryPressure,
  systemPressure,
  levelOfDarwin,
  levelOfFree,
  readDarwin,
  POLL_MS,
} = require('../electron/platform/memoryPressure.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

test("macOS's level and the share of free memory read as normal, warning or critical", () => {
  assert.equal(levelOfDarwin('1\n'), null);
  assert.equal(levelOfDarwin('2\n'), 'warning');
  assert.equal(levelOfDarwin('4'), 'critical');
  assert.equal(levelOfDarwin('garbage'), null);
  assert.equal(levelOfFree(0.5), null);
  assert.equal(levelOfFree(0.049), 'warning');
  assert.equal(levelOfFree(0.019), 'critical');
});

test("B2: macOS's level comes from the Rust core, and a read that fails reads as no pressure", async () => {
  assert.equal(await readDarwin(async () => 4), 'critical');
  assert.equal(await readDarwin(async () => 2), 'warning');
  assert.equal(await readDarwin(async () => 1), null);
  assert.equal(await readDarwin(async () => null), null);
  assert.equal(
    await readDarwin(async () => {
      throw new Error('sysctl kern.memorystatus_vm_pressure_level: EPERM');
    }),
    null,
    'the route failed',
  );
});

test('subscribers hear every reading under pressure and the return to normal once; a failing one does not stop the others', async () => {
  clearIgnored();
  const levels: any[] = ['warning', 'warning', null, null, 'critical'];
  const p = createMemoryPressure({
    read: async () => levels.shift() ?? null,
    timers: { setInterval: () => ({}), clearInterval: () => {} },
  });
  const heard: any[] = [];
  p.subscribe(() => {
    throw new Error('subscriber broke');
  });
  p.subscribe((l: any) => heard.push(l));
  for (let i = 0; i < 5; i++) await p.poll();
  assert.deepEqual(heard, ['warning', 'warning', null, 'critical']);
  assert.equal(p.level(), 'critical');
  assert.ok(recentIgnored().some((e: any) => e.context === 'tell a subscriber the memory pressure'));
});

test('A1: a reading still under way is not started again', async () => {
  let release: (v: any) => void = () => {};
  let reads = 0;
  const p = createMemoryPressure({
    read: () => (reads++, new Promise((r) => (release = r))),
    timers: { setInterval: () => ({}), clearInterval: () => {} },
  });
  const first = p.poll();
  await p.poll();
  release('warning');
  await first;
  assert.equal(reads, 1);
  assert.equal(p.level(), 'warning');
});

test('it polls only while subscribed: one timer, unref, cleared with the last subscriber; the default read on other platforms', async () => {
  const set: any[] = [];
  let cleared = 0;
  let unref = 0;
  const timers: any = {
    setInterval: (fn: () => void, ms: number) => (set.push([fn, ms]), { unref: () => unref++ }),
    clearInterval: () => cleared++,
  };
  const p = createMemoryPressure({ platform: 'linux', timers });
  const a = p.subscribe(() => {});
  const b = p.subscribe(() => {});
  assert.deepEqual([set.length, set[0][1], unref], [1, POLL_MS, 1]);
  a();
  assert.equal(cleared, 0);
  b();
  assert.equal(cleared, 1);
  // the free-memory reading (whatever this machine has free), polled by the timer too
  set[0][0]();
  await p.poll();
  assert.ok([null, 'warning', 'critical'].includes(p.level()));
  // the app shares one
  assert.equal(systemPressure(), systemPressure());
  // and the macOS default reads sysctl
  const mac = createMemoryPressure({ platform: 'darwin', timers });
  await mac.poll();
  assert.ok([null, 'warning', 'critical'].includes(mac.level()));
});
