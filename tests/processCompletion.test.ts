// Actual child closure and verified retirement can complete in either order, while retries preserve one run's terminal result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred, tick } from './support/async-scenarios.ts';
const { processCompletion } = createRequire(import.meta.url)('../electron/platform/processCompletion.cjs');

test('root closure waits for verified retirement and duplicated observations cannot replace its outcome', async () => {
  const retirement = deferred<void>();
  const ended: unknown[] = [];
  let requests = 0;
  const owner = processCompletion({
    retire: () => {
      requests++;
      return retirement.promise;
    },
    onComplete: (value: unknown) => ended.push(value),
    onError: () => assert.fail('no error'),
  });
  owner.close(0);
  owner.close(99);
  owner.request();
  await tick();
  assert.equal(requests, 1);
  assert.deepEqual(ended, []);
  retirement.resolve();
  await tick();
  assert.deepEqual(ended, [0]);
  owner.request();
  owner.close(100);
  await tick();
  assert.equal(requests, 1);
  assert.deepEqual(ended, [0]);
});

test('a retired process cannot complete while its closure boundary still waits', async () => {
  const ended: unknown[] = [];
  const owner = processCompletion({
    retire() {},
    onComplete: (value: unknown) => ended.push(value),
    onError: () => assert.fail('no error'),
  });
  owner.request();
  await tick();
  assert.deepEqual(ended, []);
  owner.close('closed');
  assert.deepEqual(ended, ['closed']);
});

test('rejected and thrown cleanup retain ownership, report the error and permit one explicit retry', async () => {
  for (const synchronous of [false, true]) {
    const failure = new Error('identity unavailable');
    const errors: unknown[] = [];
    const ended: unknown[] = [];
    let requests = 0;
    const owner = processCompletion({
      retire: () => {
        if (++requests === 1) {
          if (synchronous) throw failure;
          return Promise.reject(failure);
        }
      },
      onComplete: (value: unknown) => ended.push(value),
      onError: (error: unknown) => errors.push(error),
    });
    owner.close(143);
    await tick();
    assert.deepEqual(ended, []);
    assert.deepEqual(errors, [failure]);
    owner.request();
    owner.request();
    await tick();
    assert.equal(requests, 2);
    assert.deepEqual(ended, [143]);
  }
});
