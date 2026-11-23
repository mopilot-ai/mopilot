// electron/platform/processTree.cjs (#1347): the groups a harness's stop ends (its own and every group descending from it,
// never MoPilot's own or 0/1), the signals sent, and the grace period's SIGKILL only for processes that were there.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
// flush lets the grace period's async pass run (setImmediate is not mocked)
import { tick as flush } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const {
  groupsOf,
  descendantsOf,
  signalTree,
  processTable,
  TreeWatcher,
  watchTree,
  reapTree,
  wakeWatcher,
  GROUP_GRACE_MS,
  WATCH_MS,
  IDLE_WATCH_MS,
  QUIET_TICKS,
} = require('../electron/platform/processTree.cjs');

// MoPilot (pid 10, group 10) spawned harness 100 (group 100); 100 runs 101 in its group, which runs commands 200
// (group 200) and 300 (group 300, whose child 301 is in group 300). 400 is unrelated; 1 is launchd.
const TABLE = [
  [1, 0, 1],
  [10, 1, 10],
  [100, 10, 100],
  [101, 100, 100],
  [200, 101, 200],
  [300, 101, 300],
  [301, 300, 300],
  [400, 1, 400],
];

test('the groups of a harness: its own and every group a process of it started, never MoPilot, 0 or 1', () => {
  const { groups, pids } = groupsOf(TABLE, 100, 10);
  assert.deepEqual([...groups].sort(), [100, 200, 300]);
  assert.deepEqual(
    [...pids].sort((a, b) => a - b),
    [100, 101, 200, 300, 301],
  );
  // a command put back into MoPilot's group, or launchd's, is never signalled as a group
  const odd = [...TABLE, [500, 101, 10], [501, 101, 1], [502, 101, 0]];
  assert.deepEqual([...groupsOf(odd, 100, 10).groups].sort(), [100, 200, 300]);
  // the leader is gone: its members (re-parented) still carry its group id and lead to their commands
  const orphaned = TABLE.filter(([pid]) => pid !== 100).map(([pid, ppid, g]) => (pid === 101 ? [pid, 1, g] : [pid, ppid, g]));
  assert.deepEqual([...groupsOf(orphaned, 100, 10).groups].sort(), [100, 200, 300]);
  // nothing left of it at all
  assert.deepEqual(groupsOf([[1, 0, 1]], 100, 10), { groups: new Set([100]), pids: new Set() });
  // a parent loop in a torn ps listing ends
  assert.deepEqual(
    [
      ...groupsOf(
        [
          [100, 101, 100],
          [101, 100, 100],
        ],
        100,
        10,
      ).groups,
    ],
    [100],
  );
});

test('signalTree signals every group, then SIGKILLs only what was there and is still there', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const sent: any[] = [];
    let rows: number[][] = TABLE;
    const kill = (pid: number, sig: string) => {
      sent.push([pid, sig]);
      if (pid === -300) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    };
    assert.equal(await signalTree(100, 'SIGTERM', { table: () => rows, kill, own: 10 }), true);
    assert.deepEqual(
      sent.sort(),
      [
        [-100, 'SIGTERM'],
        [-200, 'SIGTERM'],
        [-300, 'SIGTERM'],
      ].sort(),
    );
    sent.length = 0;
    // 101 and 300 ended; 200 ignored SIGTERM; 301's pid went to a process in another group; 600 is new
    rows = [
      [1, 0, 1],
      [100, 10, 100],
      [200, 101, 200],
      [301, 1, 700],
      [600, 100, 100],
    ];
    mock.timers.tick(GROUP_GRACE_MS);
    await flush();
    assert.deepEqual(
      sent.sort(),
      [
        [100, 'SIGKILL'],
        [200, 'SIGKILL'],
      ].sort(),
      'not 301 (another group now), not 600 (new)',
    );
  } finally {
    mock.timers.reset();
  }
});

test('nothing to signal is reported, and a SIGKILL that finds the process gone is fine', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const gone = () => {
      throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    };
    assert.equal(await signalTree(100, 'SIGTERM', { table: () => [], kill: gone, own: 10 }), false);
    // MoPilot not in the listing (a torn ps read): no group of its own to spare, the harness's is still signalled
    const seen: any[] = [];
    assert.equal(
      await signalTree(100, 'SIGTERM', { table: () => [[100, 1, 100]], kill: (pid: number, sig: string) => void seen.push([pid, sig]) }),
      true,
    );
    assert.deepEqual(seen, [[-100, 'SIGTERM']]);
    mock.timers.tick(GROUP_GRACE_MS);
    await flush();
    // MoPilot's own group comes from the table when not given
    const sent: any[] = [];
    let first = true;
    const table = () => [
      [process.pid, 1, 55],
      [100, process.pid, 100],
    ];
    const kill = (pid: number, sig: string) => {
      sent.push([pid, sig]);
      if (!first) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    };
    assert.equal(await signalTree(100, 'SIGTERM', { table, kill }), true);
    first = false;
    mock.timers.tick(GROUP_GRACE_MS);
    await flush();
    assert.deepEqual(sent, [
      [-100, 'SIGTERM'],
      [100, 'SIGKILL'],
    ]);
  } finally {
    mock.timers.reset();
  }
});

test("the process table is the Rust core's, and a read that fails lists nothing", async () => {
  const fromCore = [
    [1, 0, 1],
    [42, 1, 42],
  ];
  const asked: string[] = [];
  assert.deepEqual(await processTable(async (route: string) => (asked.push(route), fromCore)), fromCore);
  assert.deepEqual(asked, ['proc.table']);
  assert.deepEqual(
    await processTable(async () => {
      throw new Error('read the process table: EPERM');
    }),
    [],
    'a failed read: the group alone is signalled, and a watch keeps what it recorded',
  );
});

test('the descendants of a root: every process below it, never launchd, MoPilot or a loop back to it', () => {
  assert.deepEqual(
    [...descendantsOf(TABLE, 100)].sort((a, b) => a[0] - b[0]),
    [
      [101, 100],
      [200, 200],
      [300, 300],
      [301, 300],
    ],
  );
  assert.deepEqual([...descendantsOf(TABLE, 999)], []);
  // pid 1 and this process are skipped; a loop in a torn listing ends
  const odd = [
    [100, 10, 100],
    [1, 100, 1],
    [process.pid, 100, 100],
    [101, 100, 100],
    [102, 101, 102],
    [101, 102, 100],
  ];
  assert.deepEqual([...descendantsOf(odd, 100).keys()].sort(), [101, 102]);
});

test('a watch records the descendants of its root and keeps them after the root is gone', async () => {
  let rows: number[][] = TABLE;
  const w = new TreeWatcher({ table: () => rows, every: 1e9 });
  const mine = w.watch(100);
  await w.tick();
  assert.deepEqual([...mine.known.keys()].sort(), [101, 200, 300, 301]);
  // the harness is SIGKILLed: its commands are re-parented to launchd, out of the walk from 100, yet still recorded
  rows = [
    [1, 0, 1],
    [10, 1, 10],
    [200, 1, 200],
    [300, 1, 300],
    // 101 ended; 301's pid came back in another group
    [301, 1, 700],
  ];
  await w.tick();
  assert.deepEqual([...mine.known].sort(), [
    [200, 200],
    [300, 300],
  ]);
  w.stop(mine);
});

/** Timers the test fires by hand: the one pending tick and its delay. */
function handTimers() {
  const t = {
    pending: null as null | { fn: () => void; ms: number },
    setTimer: (fn: () => void, ms: number) => ((t.pending = { fn, ms }), { unref: () => undefined }),
    clearTimer: () => void (t.pending = null),
    /** fires the pending tick and lets it finish */
    async fire() {
      const p = t.pending!;
      t.pending = null;
      p.fn();
      await flush();
      await flush();
    },
  };
  return t;
}

test('the watcher runs one timer while something is watched, one ps at a time, and keeps its record when ps lists nothing', async () => {
  let calls = 0;
  let release: () => void = () => {};
  let slow = false;
  const t = handTimers();
  const w = new TreeWatcher({
    table: () => {
      calls++;
      return slow ? new Promise<number[][]>((r) => (release = () => r(TABLE))) : calls === 2 ? [] : TABLE;
    },
    every: 1000,
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
  });
  const a = w.watch(100);
  const b = w.watch(300);
  assert.equal(w.watches.size, 2);
  assert.equal(t.pending!.ms, 1000);
  await t.fire();
  assert.equal(calls, 1);
  assert.ok(a.known.size > 0 && b.known.has(301));
  // ps failed (listed nothing): the record stays
  await t.fire();
  assert.equal(calls, 2);
  assert.ok(a.known.size > 0);
  // a slow ps is not stacked on: a tick while it runs reads nothing
  slow = true;
  await t.fire();
  assert.equal(await w.tick(), false);
  assert.equal(calls, 3);
  // a watch stopped meanwhile records nothing more
  a.known.clear();
  a.stop();
  release();
  await flush();
  assert.equal(a.known.size, 0);
  assert.ok(w.timer, 'one watch is left');
  b.stop();
  assert.equal(w.timer, null);
  // stopping twice is fine
  b.stop();
  // a new watch starts the timer again
  w.watch(100).stop();
});

test('a quiet watcher backs off to idleEvery; a harness event or a change in the tree brings it back at once', async () => {
  let rows = TABLE;
  const t = handTimers();
  const w = new TreeWatcher({ table: () => rows, every: 2000, idleEvery: 30_000, setTimer: t.setTimer, clearTimer: t.clearTimer });
  w.watch(100);
  // the first tick records the tree: a change
  await t.fire();
  assert.equal(t.pending!.ms, 2000);
  // QUIET_TICKS ticks with nothing new: the next one is idleEvery away
  for (let i = 1; i < QUIET_TICKS; i++) {
    await t.fire();
    assert.equal(t.pending!.ms, 2000);
  }
  await t.fire();
  assert.equal(t.pending!.ms, 30_000);
  // a harness event: the next tick is every away again
  w.wake();
  assert.equal(t.pending!.ms, 2000);
  // events while it is fast count as activity and keep it fast
  for (let i = 0; i < QUIET_TICKS; i++) {
    w.wake();
    await t.fire();
    assert.equal(t.pending!.ms, 2000);
  }
  for (let i = 0; i < QUIET_TICKS; i++) await t.fire();
  assert.equal(t.pending!.ms, 30_000);
  // a slow tick that finds a new command: fast again
  rows = [...TABLE, [500, 101, 500]];
  await t.fire();
  assert.equal(t.pending!.ms, 2000);
  // and one that finds a command gone
  for (let i = 0; i < QUIET_TICKS; i++) await t.fire();
  rows = TABLE;
  await t.fire();
  assert.equal(t.pending!.ms, 2000);
  // waking with nothing watched does nothing
  const idle = new TreeWatcher({ table: () => TABLE, setTimer: t.setTimer, clearTimer: t.clearTimer });
  t.pending = null;
  idle.wake();
  assert.equal(t.pending, null);
  // the defaults are WATCH_MS and IDLE_WATCH_MS
  assert.deepEqual([idle.every, idle.idleEvery], [WATCH_MS, IDLE_WATCH_MS]);
});

test('the shared watcher wakes on a harness event, and its default timers are the real ones', () => {
  const real = new TreeWatcher({ table: () => TABLE });
  const w = real.watch(100);
  assert.ok(real.timer);
  w.stop();
  assert.equal(real.timer, null);
  assert.doesNotThrow(() => wakeWatcher());
});

test('signalTree ends what was recorded below a harness that is gone: a leader with its group, the rest one by one', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    // 100 is gone. 200 leads a group (with 202), 201 is a plain process in MoPilot's group 10, 203 is in group 300 but
    // was recorded in 200 (its group changed), 204 was never recorded
    const rows = [
      [1, 0, 1],
      [10, 1, 10],
      [200, 1, 200],
      [202, 200, 200],
      [201, 1, 10],
      [203, 1, 300],
      [204, 1, 10],
      [process.pid, 1, 10],
    ];
    const known = new Map([
      [200, 200],
      [201, 10],
      [203, 200],
      [205, 205],
      [process.pid, 10],
    ]);
    const sent: any[] = [];
    assert.equal(
      await signalTree(null, 'SIGTERM', {
        table: () => rows,
        kill: (pid: number, sig: string) => void sent.push([pid, sig]),
        own: 10,
        known,
      }),
      true,
    );
    assert.deepEqual(
      sent.sort(),
      [
        [-200, 'SIGTERM'],
        [201, 'SIGTERM'],
      ].sort(),
    );
    sent.length = 0;
    // 202 stayed, 201 ended and its pid went to a process of another group
    const later = [
      [200, 1, 200],
      [202, 200, 200],
      [201, 1, 77],
      [204, 1, 10],
    ];
    mock.timers.tick(GROUP_GRACE_MS);
    await flush();
    // (the pass reads the table it was given at call time: the same rows)
    assert.deepEqual(
      sent.sort(),
      [
        [200, 'SIGKILL'],
        [201, 'SIGKILL'],
        [202, 'SIGKILL'],
      ].sort(),
    );
    void later;
    // a harness whose group is also signalled: its group and the recorded ones together
    sent.length = 0;
    assert.equal(
      await signalTree(100, 'SIGTERM', {
        table: () => [...rows, [100, 10, 100]],
        kill: (pid: number, sig: string) => void sent.push([pid, sig]),
        own: 10,
        known: new Map([[200, 200]]),
      }),
      true,
    );
    assert.deepEqual(
      sent.sort(),
      [
        [-100, 'SIGTERM'],
        [-200, 'SIGTERM'],
      ].sort(),
    );
    // nothing recorded is there any more
    assert.equal(await signalTree(null, 'SIGTERM', { table: () => [[1, 0, 1]], kill: () => {}, own: 10, known }), false);
  } finally {
    mock.timers.reset();
  }
});

test('the late SIGKILL spares a recorded process whose pid went to another group', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    const sent: any[] = [];
    const at = [
      [1, 0, 1],
      [10, 1, 10],
      [201, 1, 10],
    ];
    let rows = at;
    const kill = (pid: number, sig: string) => void sent.push([pid, sig]);
    await signalTree(null, 'SIGTERM', { table: () => rows, kill, own: 10, known: new Map([[201, 10]]) });
    rows = [
      [1, 0, 1],
      [201, 1, 77],
    ];
    sent.length = 0;
    mock.timers.tick(GROUP_GRACE_MS);
    await flush();
    assert.deepEqual(sent, []);
  } finally {
    mock.timers.reset();
  }
});

test('reapTree stops the recording and ends what it holds; with nothing recorded it reports false', async () => {
  const w = new TreeWatcher({ table: () => TABLE, every: 1e9 });
  const empty = w.watch(100);
  assert.equal(await reapTree(empty), false);
  assert.equal(empty.stopped, true);
  const mine = w.watch(100);
  await w.tick();
  const sent: any[] = [];
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    assert.equal(
      await reapTree(mine, { table: () => TABLE, kill: (pid: number, sig: string) => void sent.push([pid, sig]), own: 10 }),
      true,
    );
  } finally {
    mock.timers.reset();
  }
  assert.equal(mine.stopped, true);
  // the leaders' groups, and the others (101 in 100's group, 301 in 300's) one by one
  assert.deepEqual(
    sent.map(([pid]: number[]) => pid).sort((a: number, b: number) => a - b),
    [-300, -200, 101, 301],
  );
});

test('watchTree records on POSIX and nothing on Windows (no ps; a Job Object is the way there)', {
  skip: process.platform === 'win32',
}, () => {
  const w = watchTree(process.pid);
  assert.equal(w.stopped, false);
  w.stop();
  const real = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    const inert = watchTree(5);
    assert.equal(inert.stopped, true);
    assert.equal(inert.known.size, 0);
    assert.equal(inert.stop(), undefined);
  } finally {
    Object.defineProperty(process, 'platform', real);
  }
});
