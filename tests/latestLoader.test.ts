// The shared async-read owner also accepts live snapshots, invalidating old reads without reviving disposed owners.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLatestLoader } from '../src/lib/latestLoader';
import { controlledReads } from './support/async-scenarios.ts';

for (const olderFirst of [true, false]) {
  test(`only the latest overlapping read publishes, older first: ${olderFirst}`, async () => {
    const reads = controlledReads<string>();
    const seen: string[] = [];
    const loader = createLatestLoader(reads.read, (value) => seen.push(value));
    const first = loader.load();
    const second = loader.load();
    if (olderFirst) {
      reads.requests[0].resolve('old');
      await first;
      assert.deepEqual(seen, []);
      reads.requests[1].resolve('new');
    } else {
      reads.requests[1].resolve('new');
      await second;
      reads.requests[0].resolve('old');
    }
    await Promise.all([first, second]);
    assert.deepEqual(seen, ['new']);
  });
}

test('a push retires both old successes and failures, and a later read can still replace it', async () => {
  const reads = controlledReads<string>();
  const seen: string[] = [];
  const errors: unknown[] = [];
  const loader = createLatestLoader(
    reads.read,
    (value) => seen.push(value),
    (error) => errors.push(error),
  );
  const first = loader.load();
  loader.push('event 1');
  reads.requests[0].resolve('old');
  await first;
  const second = loader.load();
  loader.push('event 2');
  reads.requests[1].reject(new Error('old'));
  await second;
  assert.deepEqual(seen, ['event 1', 'event 2']);
  assert.deepEqual(errors, []);
  const third = loader.load();
  reads.requests[2].resolve('new read');
  await third;
  assert.deepEqual(seen, ['event 1', 'event 2', 'new read']);
});

test('stop retires pending work and refuses queued pushes and reads', async () => {
  const reads = controlledReads<string>();
  const seen: string[] = [];
  const errors: unknown[] = [];
  const loader = createLatestLoader(
    reads.read,
    (value) => seen.push(value),
    (error) => errors.push(error),
  );
  const first = loader.load();
  const second = loader.load();
  loader.stop();
  loader.push('retired event');
  await loader.load();
  reads.requests[0].resolve('retired success');
  reads.requests[1].reject(new Error('retired failure'));
  await Promise.all([first, second]);
  assert.equal(reads.requests.length, 2);
  assert.deepEqual(seen, []);
  assert.deepEqual(errors, []);
});

test('only a current read failure is reported; an omitted failure callback is safe', async () => {
  const error = new Error('current');
  const errors: unknown[] = [];
  const read = async () => {
    throw error;
  };
  await createLatestLoader(
    read,
    () => assert.fail('must not publish'),
    (value) => errors.push(value),
  ).load();
  assert.deepEqual(errors, [error]);
  await createLatestLoader(read, () => assert.fail('must not publish')).load();
});

test('publication failures keep their existing caller-visible behavior and cannot revive a stale read', async () => {
  const reads = controlledReads<string>();
  const error = new Error('publisher refused');
  const seen: string[] = [];
  const loader = createLatestLoader(reads.read, (value) => {
    if (value === 'fail') throw error;
    seen.push(value);
  });
  const first = loader.load();
  assert.throws(() => loader.push('fail'), error);
  reads.requests[0].resolve('obsolete');
  await first;
  assert.deepEqual(seen, []);
  const second = loader.load();
  reads.requests[1].resolve('fail');
  await assert.rejects(second, error);
  loader.push('recovered');
  assert.deepEqual(seen, ['recovered']);
});

test('read arguments belong to their request and a stopped loader never forwards them', async () => {
  const reads = controlledReads<string>();
  const seen: string[] = [];
  const args: [boolean, string][] = [];
  const loader = createLatestLoader(
    (_current, refresh: boolean, key: string) => {
      args.push([refresh, key]);
      return reads.read();
    },
    (value) => seen.push(value),
  );
  const first = loader.load(true, 'first');
  const second = loader.load(false, 'second');
  assert.deepEqual(args, [
    [true, 'first'],
    [false, 'second'],
  ]);
  reads.requests[1].resolve('second');
  await second;
  reads.requests[0].resolve('first');
  await first;
  assert.deepEqual(seen, ['second']);
  loader.stop();
  await loader.load(true, 'disposed');
  assert.equal(args.length, 2);
});

test('settled waits for the newest load, including one started while waiting, and cancel supersedes without stopping', async () => {
  const reads = controlledReads<string>();
  const seen: string[] = [];
  const loader = createLatestLoader(reads.read, (value) => seen.push(value));
  await loader.settled();
  void loader.load();
  let settled = false;
  const waiting = loader.settled().then(() => {
    settled = true;
  });
  void loader.load();
  reads.requests[0].resolve('old');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(settled, false);
  // a load started while waiting is waited for too
  void loader.load();
  reads.requests[1].resolve('middle');
  for (let i = 0; i < 5; i++) await Promise.resolve();
  assert.equal(settled, false);
  reads.requests[2].resolve('new');
  await waiting;
  assert.deepEqual(seen, ['new']);
  // cancel: the read in flight publishes nothing, and the owner still loads afterwards
  void loader.load();
  loader.cancel();
  reads.requests[3].resolve('cancelled');
  await loader.settled();
  void loader.load();
  reads.requests[4].resolve('after');
  await loader.settled();
  assert.deepEqual(seen, ['new', 'after']);
});
