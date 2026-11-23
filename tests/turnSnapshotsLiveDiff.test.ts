// TurnSnapshots.liveDiff: the running turn's changes so far, read on request for a phone's review.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const { TurnSnapshots } = require('../electron/session/turnSnapshots.cjs');

function rig(peek: (key: string) => Promise<string | undefined>, active: string | null = 'turn-active') {
  const changes = { begin: async () => {}, itemStarted: () => {}, peek };
  const snaps = new TurnSnapshots({
    changes,
    state: { has: () => true, get: () => ({ activeTurn: active ? { id: active } : null }) },
    publish: () => {},
    delayMs: 1000,
  });
  return snaps;
}

test('a running turn reads its diff now, under its own id or the controller’s', async () => {
  const snaps = rig(async (key) => `diff of ${key}`);
  snaps.begin('c1', 'k1', '/work', 'turn-1');
  assert.deepEqual(await snaps.liveDiff('c1'), { turnId: 'turn-1', diff: 'diff of k1' });
  snaps.begin('c2', 'k2', '/work');
  assert.deepEqual(await snaps.liveDiff('c2'), { turnId: 'turn-active', diff: 'diff of k2' });
});

test('no running turn, a snapshot that cannot say, a turn with no id, and a turn that ended or was replaced mid-read read nothing', async () => {
  const snaps = rig(async () => undefined);
  assert.equal(await snaps.liveDiff('none'), undefined);
  snaps.begin('c1', 'k1', '/work', 'turn-1');
  assert.equal(await snaps.liveDiff('c1'), undefined, 'the snapshot could not say');
  const noId = rig(async () => 'd', null);
  noId.begin('c1', 'k1', '/work');
  assert.equal(await noId.liveDiff('c1'), undefined);
  for (const end of [(s: any) => s.retire('c1'), (s: any) => s.begin('c1', 'k1', '/work', 'turn-2')]) {
    let release: (v: string) => void = () => {};
    const slow = rig(() => new Promise<string>((r) => (release = r)));
    slow.begin('c1', 'k1', '/work', 'turn-1');
    const read = slow.liveDiff('c1');
    // the read waits for its slot before it peeks
    await new Promise((r) => setImmediate(r));
    end(slow);
    release('late');
    assert.equal(await read, undefined);
  }
});

test('reads of one turn share a snapshot, and the reads of many chats wait for a slot', async () => {
  let running = 0;
  let peak = 0;
  let calls = 0;
  const gates: (() => void)[] = [];
  const peek = async (key: string) => {
    calls++;
    running++;
    peak = Math.max(peak, running);
    await new Promise<void>((r) => gates.push(r));
    running--;
    return `diff of ${key}`;
  };
  const snaps = new TurnSnapshots({
    changes: { begin: async () => {}, itemStarted: () => {}, peek },
    state: { has: () => true, get: () => ({ activeTurn: { id: 'turn-active' } }) },
    publish: () => {},
    delayMs: 1000,
    maxReads: 1,
  });
  for (const id of ['c1', 'c2', 'c3']) snaps.begin(id, `k-${id}`, '/work', `t-${id}`);
  const wait = () => new Promise((r) => setTimeout(r, 5));
  // let the next waiting peek go, whenever it gets to start
  const letGo = async () => {
    while (!gates.length) await wait();
    gates.shift()?.();
  };
  const same = [snaps.liveDiff('c1'), snaps.liveDiff('c1'), snaps.liveDiff('c1')];
  const others = [snaps.liveDiff('c2'), snaps.liveDiff('c3')];
  await wait();
  assert.deepEqual([calls, running], [1, 1], 'one slot, one snapshot for the three reads of c1');
  await letGo();
  await letGo();
  await letGo();
  const results = await Promise.all([...same, ...others]);
  assert.deepEqual(
    results.map((r) => r?.diff),
    ['diff of k-c1', 'diff of k-c1', 'diff of k-c1', 'diff of k-c2', 'diff of k-c3'],
  );
  assert.equal(peak, 1);
  assert.equal(calls, 3);
  // a later read takes a new snapshot
  const again = snaps.liveDiff('c1');
  await letGo();
  assert.equal((await again)?.diff, 'diff of k-c1');
  assert.equal(calls, 4);
});
