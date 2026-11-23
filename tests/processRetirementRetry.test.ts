// Failed process verification retains the run's discovered birth and group owners for the next explicit Stop or Quit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';
const { signalTree, GROUP_GRACE_MS } = createRequire(import.meta.url)('../electron/platform/processTree.cjs');
const self = [10, 1, 10, 'self'];

test('a rejected group authority cannot persist foreign births or grant them to a later retry', async () => {
  let rows: any[] = [self, [100, 1, 100, 'foreign-parent'], [201, 100, 100, 'foreign-child']];
  let valid = false;
  const sent: any[] = [];
  const owner = { known: new Map(), births: new Map(), ownedGroups: new Map() };
  const options = { ...owner, wait: true, own: 10, table: () => rows, valid: () => valid, kill: (...args: any[]) => sent.push(args) };
  await assert.rejects(signalTree(100, 'SIGTERM', options), /changed owner/);
  assert.equal(owner.births.size, 0, 'a rejected capability must never record a foreign birth');
  assert.equal(owner.ownedGroups.size, 0, 'a rejected capability must never persist a foreign group');
  rows = [self, [201, 1, 700, 'foreign-child']];
  valid = true;
  assert.equal(await signalTree(100, 'SIGTERM', options), false);
  assert.deepEqual(sent, []);
});

for (const replacement of [false, true])
  test(`cleanup retry ${replacement ? 'spares a replacement' : 'retains a discovered writer'} after a group move and verification failure`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 0 });
    let rows: any[] = [self, [100, 10, 100, 'root'], [201, 100, 100, 'writer']];
    const sent: any[] = [];
    const owner = { known: new Map(), births: new Map(), ownedGroups: new Map() };
    const options = { ...owner, wait: true, own: 10, table: () => rows, kill: (...args: any[]) => sent.push(args) };
    const first = signalTree(100, 'SIGTERM', options);
    const rejected = assert.rejects(first, /owned process birth.*unverified/);
    await tick();
    rows = [self, [201, 1, 700, 'writer']];
    t.mock.timers.tick(100);
    await tick();
    rows = [self, [201, 1, 700, '']];
    t.mock.timers.tick(100);
    await rejected;
    rows = [self, [201, 1, 700, replacement ? 'replacement' : 'writer'], [701, 1, 700, 'foreign']];
    const before = sent.length;
    let done = false;
    const retry = signalTree(100, 'SIGTERM', options).then(() => {
      done = true;
    });
    t.after(async () => {
      rows = [self];
      t.mock.timers.tick(100);
      await retry;
    });
    await tick();
    assert.equal(done, replacement);
    if (!replacement) {
      t.mock.timers.tick(GROUP_GRACE_MS);
      await tick();
      assert.deepEqual(sent.slice(before), [
        [201, 'SIGTERM'],
        [201, 'SIGKILL'],
      ]);
      rows = [self, [701, 1, 700, 'foreign']];
      t.mock.timers.tick(100);
    } else assert.deepEqual(sent.slice(before), []);
    await retry;
  });
