// A Windows process tree ends through the Rust core's proc.kill
// (electron/platform/winbin.cjs endWindowsTree, for killTree and the dev-preview servers); a spawnGroup child's tree is
// held in a Job Object (proc.contain) and what it left running ended after it exits (proc.endContained); and coreCall
// hands a route its payload.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const childProcess = require('node:child_process');
const { endWindowsTree, holdWindowsTree, endHeld, endGroup, spawnGroup } = require('../electron/platform/winbin.cjs');
const { coreCall } = require('../electron/platform/core.cjs');

const settle = () => new Promise((resolve) => setImmediate(resolve));
/** A core whose routes answer `reply` (a throw when it is an Error; a function of the route), recording what it was asked. */
const fakeCore = (reply: unknown) => {
  const asked: [string, string][] = [];
  const addon = {
    dispatch: async (route: string, payload: Buffer) => {
      asked.push([route, String(payload)]);
      const r = typeof reply === 'function' ? reply(route) : reply;
      if (r instanceof Error) throw r;
      return Buffer.from(JSON.stringify(r));
    },
    routes: () => ['proc.kill'],
  };
  return { addon, asked };
};

test('the core ends the tree; a core that did not end the root, or failed, leaves it to the caller', async () => {
  const ended = fakeCore([43, 42]);
  let left = 0;
  endWindowsTree(42, () => left++, ended.addon);
  await settle();
  assert.deepEqual(ended.asked, [['proc.kill', '42']]);
  assert.equal(left, 0);
  for (const reply of [[43], null, new Error('access denied')]) {
    const c = fakeCore(reply);
    let again = 0;
    endWindowsTree(7, () => again++, c.addon);
    await settle();
    assert.equal(again, 1, JSON.stringify(reply));
  }
});

test('coreCall hands the route its payload, none by default', async () => {
  const c = fakeCore([1]);
  assert.deepEqual(await coreCall('proc.kill', c.addon, '9'), [1]);
  assert.deepEqual(await coreCall('proc.table', c.addon), [1]);
  assert.deepEqual(c.asked, [
    ['proc.kill', '9'],
    ['proc.table', ''],
  ]);
});

test('a tree still being held is killed only once the hold settles, so its job ends with it', async () => {
  const c = fakeCore([42]);
  let settleHold: (held: boolean) => void = () => {};
  const held = new Promise<boolean>((resolve) => (settleHold = resolve));
  let left = 0;
  endWindowsTree(42, () => left++, c.addon, held);
  await settle();
  assert.deepEqual(c.asked, [], 'no kill before the hold');
  settleHold(true);
  await settle();
  assert.deepEqual(c.asked, [['proc.kill', '42']]);
  assert.equal(left, 0);
});

test('a child is held through proc.contain: true only when the core says so', async () => {
  const yes = fakeCore(true);
  assert.equal(await holdWindowsTree(42, yes.addon, 1761600000000), true);
  assert.deepEqual(yes.asked, [['proc.contain', '42 1761600000000']], 'its pid, and when it was spawned');
  const now = fakeCore(true);
  const before = Date.now();
  await holdWindowsTree(42, now.addon);
  const at = Number(now.asked[0][1].split(' ')[1]);
  assert.ok(at >= before && at <= Date.now(), 'spawned now by default');
  for (const reply of [false, null, new Error('access denied')]) assert.equal(await holdWindowsTree(7, fakeCore(reply).addon), false);
  assert.equal(await holdWindowsTree(7, null), false);
});

test('after a held child exits, only what its job held is ended; an unheld child asks nothing', async () => {
  const c = fakeCore([50, 51]);
  assert.equal(await endHeld({ pid: 42, job: Promise.resolve(true) } as any, c.addon), true);
  assert.deepEqual(c.asked, [['proc.endContained', '42']]);
  for (const reply of [[], null, new Error('gone')])
    assert.equal(await endHeld({ pid: 9, job: Promise.resolve(true) } as any, fakeCore(reply).addon), false);
  const unheld = fakeCore([1]);
  assert.equal(await endHeld({ pid: 9, job: Promise.resolve(false) } as any, unheld.addon), false);
  assert.deepEqual(unheld.asked, []);
});

test('on Windows, endGroup ends a held child job and leaves an unheld or stopped one; spawnGroup holds a real child', async () => {
  const real = process.platform;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    assert.equal(endGroup({ pid: 4242, group: true, job: null } as any), false);
    assert.equal(endGroup({ pid: 4242, group: true, stopped: true, job: Promise.resolve(true) } as any), false);
    assert.equal(typeof (endGroup({ pid: 4242, group: true, job: Promise.resolve(false) } as any) as Promise<boolean>).then, 'function');
    const proc = spawnGroup(childProcess.spawn, 'sleep', ['30'], { stdio: 'ignore' }, (b: string, a: string[], o: object) => [b, a, o]);
    try {
      // this run has no core, so nothing holds it
      assert.equal(await proc.job, false);
    } finally {
      proc.kill('SIGKILL');
    }
  } finally {
    Object.defineProperty(process, 'platform', { value: real, configurable: true });
  }
});
