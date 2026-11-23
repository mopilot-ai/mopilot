// Observed root PID reuse permanently retires its strict group capability, even after the replacement root exits.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { ChildProcess } from 'node:child_process';
const require = createRequire(import.meta.url);
const { retireGroup } = require('../electron/platform/winbin.cjs');
let rows: any[] = [];
// The strict reader is loaded lazily; these boundary cases never signal the host's actual processes.
mock.method(require('../electron/platform/processIdentity.cjs'), 'identityTable', async () => rows);

for (const persisted of [false, true])
  test(`a root capability cannot revive after PID replacement exits (${persisted ? 'persisted group' : 'first attempt'})`, {
    skip: process.platform === 'win32',
  }, async (t) => {
    const proc = Object.assign(new ChildProcess(), {
      pid: 2147483000,
      group: true,
      ...(persisted ? { retiringGroups: new Map([[2147483000, 'original-root']]) } : {}),
      exitCode: 0,
      signalCode: null,
      watch: { known: new Map(), births: new Map(), stop() {} },
    });
    let replacement = true;
    let probes = 0;
    t.mock.method(process, 'kill', (pid: number, signal: number) => {
      assert.equal(pid, proc.pid);
      assert.equal(signal, 0, 'a foreign process must never receive a destructive signal');
      probes++;
      if (replacement) return true;
      throw Object.assign(new Error('replacement exited'), { code: 'ESRCH' });
    });
    await retireGroup(proc);
    assert.equal(proc.retiringGroups?.size ?? 0, 0, 'observed reuse also revokes the persisted group capability');
    const observed = probes;
    replacement = false;
    await retireGroup(proc);
    assert.equal(probes, observed, 'a retired capability does not probe and re-adopt the numeric PID');
  });

test('revoking a reused root group leaves its foreign member alone and still retires an exact-born moved writer', {
  skip: process.platform === 'win32',
}, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
  const own = [process.pid, process.ppid, 10, 'self'];
  const foreign = [301, 1, 100, 'foreign-child'];
  rows = [own, foreign, [201, 1, 700, 'writer']];
  const proc = Object.assign(new ChildProcess(), {
    pid: 100,
    group: true,
    exitCode: 0,
    signalCode: null,
    retiringGroups: new Map([[100, 'original-root']]),
    watch: { known: new Map([[201, 100]]), births: new Map([[201, 'writer']]), stop() {} },
  });
  const sent: any[] = [];
  t.mock.method(process, 'kill', (pid: number, signal: number | string) => {
    if (signal === 0) return true;
    sent.push([pid, signal]);
    assert.equal(pid, 201, 'a foreign group member never inherits a revoked capability');
    if (signal === 'SIGKILL') rows = [own, foreign];
    return true;
  });
  const work = retireGroup(proc);
  const outcome = work.then(
    () => null,
    (error: Error) => error,
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(sent, [[201, 'SIGTERM']]);
  t.mock.timers.tick(3000);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(100);
  assert.equal(await outcome, null);
  await retireGroup(proc);
  assert.deepEqual(sent, [
    [201, 'SIGTERM'],
    [201, 'SIGKILL'],
  ]);
});

test('a persisted descendant group still verifies after root reuse even when the original watch was empty', {
  skip: process.platform === 'win32',
}, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const own = [process.pid, process.ppid, 10, 'self'];
  const foreign = [301, 1, 100, 'foreign-child'];
  rows = [own, foreign, [200, 1, 200, 'owned-leader']];
  const proc = Object.assign(new ChildProcess(), {
    pid: 100,
    group: true,
    exitCode: 0,
    signalCode: null,
    retiringGroups: new Map([
      [100, 'original-root'],
      [200, 'owned-leader'],
    ]),
    watch: { known: new Map(), births: new Map(), stop() {} },
  });
  const sent: any[] = [];
  t.mock.method(process, 'kill', (pid: number, signal: number | string) => {
    if (signal === 0) return true;
    sent.push([pid, signal]);
    assert.equal(pid, -200);
    rows = [own, foreign];
    return true;
  });
  const work = retireGroup(proc);
  await new Promise((resolve) => setImmediate(resolve));
  t.mock.timers.tick(100);
  await work;
  assert.deepEqual(sent, [[-200, 'SIGTERM']]);
});

test('a failed spawn has no process to retire, while an ungrouped live child cannot report verified cleanup', {
  skip: process.platform === 'win32',
}, async () => {
  await retireGroup({ exitCode: null, signalCode: null, kill: () => assert.fail('spawn failed before a PID existed') });
  await assert.rejects(
    retireGroup({ pid: 2147483000, exitCode: null, signalCode: null, kill: () => assert.fail('unmanaged child') }),
    /group is not managed.*unverified/,
  );
});
