// Immutable birth ownership survives orphaned descendants changing groups, while a replacement PID loses ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { TreeWatcher } = createRequire(import.meta.url)('../electron/platform/processTree.cjs');

test('a recorded birth survives group moves and unreadable birth metadata but never transfers to a reused PID', async () => {
  let rows: any[] = [
    [100, 1, 100, 'root'],
    [201, 100, 100, 'writer'],
  ];
  const watcher = new TreeWatcher({ table: () => rows, setTimer: () => null });
  const watch = watcher.watch(100);
  assert.equal(await watcher.tick(), true);
  assert.equal(watch.births.get(201), 'writer');
  rows = [[201, 1, 700, 'writer']];
  assert.equal(await watcher.tick(), true);
  assert.equal(watch.known.get(201), 700, 'setsid/setpgid changes mutable group membership, not ownership');
  assert.equal(watch.births.get(201), 'writer');
  rows = [[201, 1, 800, '']];
  assert.equal(await watcher.tick(), true);
  assert.equal(watch.known.get(201), 800);
  assert.equal(watch.births.get(201), 'writer', 'unknown metadata cannot prove an owned writer exited');
  rows = [[201, 1, 800, 'replacement']];
  assert.equal(await watcher.tick(), true);
  assert.equal(watch.known.size, 0);
  assert.equal(watch.births.size, 0);
  watch.stop();
});
