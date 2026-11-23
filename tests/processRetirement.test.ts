// Managed process retirement waits for observed writers, escalates ignored termination and rejects unverified cleanup.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';
const require = createRequire(import.meta.url);
const { signalTree, GROUP_GRACE_MS } = require('../electron/platform/processTree.cjs');

const SELF = [10, 1, 10];
const born = (rows: any[][]) => rows.map((row) => [row[0], row[1], row[2], row[3] ?? `born-${row[0]}`]);

test('a retiring tree holds until its remaining child and later children actually disappear', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let rows = [SELF, [100, 10, 100], [200, 100, 200], [400, 1, 400]];
  const sent: any[] = [];
  let done = false;
  const work = signalTree(100, 'SIGTERM', {
    wait: true,
    own: 10,
    table: () => born(rows),
    kill: (pid: number, signal: string) => sent.push([pid, signal]),
  }).then(() => {
    done = true;
  });
  await tick();
  assert.deepEqual(sent, [
    [-100, 'SIGTERM'],
    [-200, 'SIGTERM'],
  ]);
  rows = [SELF, [200, 1, 200], [201, 200, 200], [400, 1, 400]];
  t.mock.timers.tick(GROUP_GRACE_MS);
  await tick();
  assert.equal(done, false, 'the root exit and SIGKILL request are neither a retirement receipt');
  assert.deepEqual(sent.slice(2), [
    [200, 'SIGKILL'],
    [201, 'SIGKILL'],
  ]);
  rows = [SELF, [400, 1, 400]];
  t.mock.timers.tick(100);
  await work;
  assert.equal(done, true);
  assert.equal(
    sent.some(([pid]) => pid === 400 || pid === -400),
    false,
  );
});

test('a failed later process-table read cannot release a retiring tree', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let rows = [SELF, [100, 10, 100]];
  let done = false;
  const work = signalTree(100, 'SIGTERM', { wait: true, own: 10, table: () => born(rows), kill() {} }).then(() => {
    done = true;
  });
  await tick();
  rows = [];
  t.mock.timers.tick(100);
  await tick();
  assert.equal(done, false);
  rows = [SELF];
  t.mock.timers.tick(100);
  await work;
});

test('a reused pid in a different group is retired without signalling its new owner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let rows: any[] = [SELF, [100, 10, 100]];
  const sent: any[] = [];
  const work = signalTree(100, 'SIGTERM', { wait: true, own: 10, table: () => born(rows), kill: (...args: any[]) => sent.push(args) });
  await tick();
  rows = [SELF, [100, 1, 700, 'replacement-birth']];
  t.mock.timers.tick(GROUP_GRACE_MS);
  await work;
  assert.deepEqual(sent, [[-100, 'SIGTERM']]);
});

test('recorded loose descendants retire individually without taking the parent app group', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let rows = [SELF, [201, 1, 10], [202, 1, 10]];
  const sent: any[] = [];
  const work = signalTree(null, 'SIGTERM', {
    wait: true,
    own: 10,
    known: new Map([[201, 10]]),
    births: new Map([[201, 'born-201']]),
    table: () => born(rows),
    kill: (pid: number, sig: string) => {
      sent.push([pid, sig]);
      if (sig === 'SIGKILL') throw Object.assign(new Error('already gone'), { code: 'ESRCH' });
    },
  });
  await tick();
  t.mock.timers.tick(GROUP_GRACE_MS);
  await tick();
  assert.deepEqual(sent, [
    [201, 'SIGTERM'],
    [201, 'SIGKILL'],
  ]);
  rows = [SELF, [202, 1, 10]];
  t.mock.timers.tick(100);
  await work;
});

test('unverifiable or never-retired processes fail visibly instead of claiming cleanup', async (t) => {
  await assert.rejects(signalTree(100, 'SIGTERM', { wait: true, table: () => [] }), /unavailable.*unverified/);
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const rows = [SELF, [100, 10, 100]];
  const work = signalTree(100, 'SIGTERM', { wait: true, own: 10, table: () => born(rows), kill() {} });
  const rejected = assert.rejects(work, /did not retire.*lock is still held/);
  await tick();
  for (let i = 0; i < 300; i++) {
    t.mock.timers.tick(100);
    await tick();
  }
  await rejected;
});

test('an already empty owned group reports that nothing was signalled', async () => {
  const result = await signalTree(100, 'SIGTERM', {
    wait: true,
    own: 10,
    table: () => born([SELF]),
    kill: () => assert.fail('an empty, unobserved group does not authorize a signal'),
  });
  assert.equal(result, false);
});

test('a missing recorded birth refuses cleanup, while a missing or replaced descendant authorizes no signal', async () => {
  const base = { wait: true, own: 10, known: new Map([[201, 10]]), kill: () => assert.fail('no owned process') };
  await assert.rejects(signalTree(null, 'SIGTERM', { ...base, table: () => born([SELF, [201, 1, 10]]) }), /no birth identity/);
  assert.equal(await signalTree(null, 'SIGTERM', { ...base, table: () => born([SELF]) }), false);
  assert.equal(
    await signalTree(null, 'SIGTERM', {
      ...base,
      births: new Map([[201, 'old']]),
      table: () => born([SELF, [201, 1, 10, 'replacement']]),
    }),
    false,
  );
});

test('a retired group capability refuses both an initial request and later escalation', async (t) => {
  const rows = born([SELF, [100, 10, 100]]);
  await assert.rejects(
    signalTree(100, 'SIGTERM', {
      wait: true,
      table: () => rows,
      valid: () => false,
      kill: () => assert.fail('retired capability'),
    }),
    /changed owner/,
  );
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let valid = true;
  const sent: any[] = [];
  const work = signalTree(100, 'SIGTERM', { wait: true, table: () => rows, valid: () => valid, kill: (...args: any[]) => sent.push(args) });
  const rejected = assert.rejects(work, /changed owner/);
  await tick();
  valid = false;
  t.mock.timers.tick(100);
  await rejected;
  assert.deepEqual(sent, [[-100, 'SIGTERM']]);
});

test('a replacement group leader is spared while a recorded surviving writer still retires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let rows = born([SELF, [100, 10, 100], [101, 100, 100]]);
  const sent: any[] = [];
  const work = signalTree(100, 'SIGTERM', { wait: true, own: 10, table: () => rows, kill: (...args: any[]) => sent.push(args) });
  await tick();
  rows = born([SELF, [100, 1, 100, 'replacement'], [101, 1, 700]]);
  t.mock.timers.tick(GROUP_GRACE_MS);
  await tick();
  assert.deepEqual(sent, [
    [-100, 'SIGTERM'],
    [101, 'SIGKILL'],
  ]);
  rows = born([SELF, [100, 1, 100, 'replacement']]);
  t.mock.timers.tick(100);
  await work;
});

test('a leaderless managed group cannot adopt a newly appearing group leader', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rows = born([[101, 1, 100]]);
  const work = signalTree(100, 'SIGTERM', { wait: true, table: () => rows, kill() {} });
  const rejected = assert.rejects(work, /group leader cannot be identified/);
  await tick();
  rows = born([
    [100, 1, 100],
    [101, 1, 100],
  ]);
  t.mock.timers.tick(100);
  await rejected;
});

test('a newly observed descendant group without its leader remains owned through retirement', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let rows = born([SELF, [100, 10, 100]]);
  const sent: any[] = [];
  const work = signalTree(100, 'SIGTERM', { wait: true, own: 10, table: () => rows, kill: (...args: any[]) => sent.push(args) });
  await tick();
  rows = born([SELF, [100, 10, 100], [201, 100, 200]]);
  t.mock.timers.tick(100);
  await tick();
  t.mock.timers.tick(GROUP_GRACE_MS);
  await tick();
  assert.ok(sent.some(([pid, signal]) => pid === 201 && signal === 'SIGKILL'));
  rows = born([SELF]);
  t.mock.timers.tick(100);
  await work;
});

test('an owned group remains owned after its original members hand off to a new writer', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let rows = [SELF, [100, 10, 100], [200, 100, 200]];
  const sent: any[] = [];
  let done = false;
  const work = signalTree(100, 'SIGTERM', { wait: true, own: 10, table: () => born(rows), kill: (...a: any[]) => sent.push(a) }).then(
    () => {
      done = true;
    },
  );
  await tick();
  rows = [SELF, [201, 1, 200]];
  t.mock.timers.tick(100);
  await tick();
  assert.equal(done, false, 'new group members still own the installation even after every initially observed PID exits');
  t.mock.timers.tick(GROUP_GRACE_MS);
  await tick();
  assert.deepEqual(sent.at(-1), [201, 'SIGKILL']);
  rows = [SELF];
  t.mock.timers.tick(100);
  await work;
});

test('a reused loose pid in the same shared group cannot be signalled as its earlier owner', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let rows: any[] = [
    [...SELF, 'self'],
    [201, 1, 10, 'first-birth'],
  ];
  const sent: any[] = [];
  const work = signalTree(null, 'SIGTERM', {
    wait: true,
    own: 10,
    known: new Map([[201, 10]]),
    births: new Map([[201, 'first-birth']]),
    table: () => born(rows),
    kill: (...a: any[]) => sent.push(a),
  });
  await tick();
  rows = [
    [...SELF, 'self'],
    [201, 1, 10, 'replacement-birth'],
  ];
  t.mock.timers.tick(GROUP_GRACE_MS);
  await tick();
  assert.deepEqual(sent, [[201, 'SIGTERM']], 'a new birth with the same pid and group is a different owner');
  await work;
});

test('protected unrelated processes remain visible, while an unknown owned birth cannot prove retirement', async () => {
  const self = [...SELF, 'self'];
  const unknown = [400, 1, 400, ''];
  assert.equal(await signalTree(100, 'SIGTERM', { wait: true, own: 10, table: () => [self, unknown] }), false);
  await assert.rejects(
    signalTree(100, 'SIGTERM', {
      wait: true,
      own: 10,
      table: () => [self, [100, 10, 100, '']],
      kill: () => assert.fail('an unknown owner cannot authorize a signal'),
    }),
    /owned process birth.*unverified/,
  );
  await assert.rejects(
    signalTree(null, 'SIGTERM', {
      wait: true,
      own: 10,
      known: new Map([[201, 10]]),
      births: new Map([[201, 'known']]),
      table: () => [self, [201, 1, 10, '']],
      kill: () => assert.fail('do not signal an unknown descendant'),
    }),
    /recorded descendant cannot be identified/,
  );
});

test('a managed writer becoming unreadable during cleanup keeps its lock rather than looking absent', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let rows = born([SELF, [100, 10, 100]]);
  const work = signalTree(100, 'SIGTERM', { wait: true, own: 10, table: () => rows, kill() {} });
  const rejected = assert.rejects(work, /owned process birth.*unverified/);
  await tick();
  rows = born([SELF, [100, 10, 100, '']]);
  t.mock.timers.tick(100);
  await rejected;
});

test('a newly discovered protected child at escalation cannot authorize a signal', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  let rows = born([SELF, [100, 10, 100]]);
  const sent: any[] = [];
  const work = signalTree(100, 'SIGTERM', { wait: true, own: 10, table: () => rows, kill: (...args: any[]) => sent.push(args) });
  const outcome = work.then(
    () => null,
    (error: Error) => error,
  );
  t.after(async () => {
    rows = born([SELF]);
    t.mock.timers.tick(100);
    await outcome;
  });
  await tick();
  rows = born([SELF, [100, 10, 100], [200, 100, 200, '']]);
  t.mock.timers.tick(GROUP_GRACE_MS);
  await tick();
  assert.equal(
    sent.some(([pid]) => pid === 200 || pid === -200),
    false,
    'a newly discovered unknown owner must be verified before escalation',
  );
  assert.match((await outcome)?.message ?? '', /owned process birth.*unverified/);
});

for (const moveDuring of [false, true])
  test(`a recorded child keeps its birth ownership when it moves groups ${moveDuring ? 'during' : 'before'} retirement`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let rows = born([SELF, [201, 1, moveDuring ? 10 : 700], [701, 1, 700]]);
    const sent: any[] = [];
    let done = false;
    const work = signalTree(null, 'SIGTERM', {
      wait: true,
      own: 10,
      known: new Map([[201, 10]]),
      births: new Map([[201, 'born-201']]),
      table: () => rows,
      kill: (...args: any[]) => sent.push(args),
    }).then(() => {
      done = true;
    });
    t.after(async () => {
      rows = born([SELF]);
      t.mock.timers.tick(100);
      await work;
    });
    await tick();
    assert.equal(done, false, 'the same recorded process is still writing in its new group');
    rows = born([SELF, [201, 1, 700], [701, 1, 700]]);
    t.mock.timers.tick(GROUP_GRACE_MS);
    await tick();
    assert.equal(done, false);
    assert.deepEqual(
      sent,
      [
        [201, 'SIGTERM'],
        [201, 'SIGKILL'],
      ],
      'foreign group members must remain untouched',
    );
    rows = born([SELF, [701, 1, 700]]);
    t.mock.timers.tick(100);
    await work;
  });
