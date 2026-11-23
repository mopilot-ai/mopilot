// Installer quit holds preserve recovery and permit retry when starting or verifying cleanup fails.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred, tick } from './support/async-scenarios.ts';
const { installerQuitHold } = createRequire(import.meta.url)('../electron/app/installerQuit.cjs');

test('no installer services or only checked results leave ordinary quit immediate', async () => {
  const event = { preventDefault: () => assert.fail('nothing owns a package') };
  const empty = installerQuitHold();
  assert.equal(
    empty(event, null, null, () => assert.fail('no second quit')),
    false,
  );
  assert.equal(
    empty(event, null, null, () => assert.fail('already done')),
    false,
  );
  const clean = installerQuitHold();
  let closed = 0;
  assert.equal(
    clean(
      event,
      {
        list: () => [{ state: 'exited', checked: true }],
        close: () => {
          closed++;
          return Promise.resolve();
        },
      },
      { inflight: new Map(), dispose() {} },
      () => assert.fail('ordinary quit'),
    ),
    false,
  );
  assert.equal(closed, 1);
  const failedEmpty = installerQuitHold();
  assert.equal(
    failedEmpty(event, { list: () => [], close: () => Promise.reject(new Error('empty cleanup failed')) }, null, () =>
      assert.fail('ordinary quit'),
    ),
    false,
  );
  await tick();
});

test('an exited run with its admission check pending is drained and repeated quits share it', async () => {
  const check = deferred<void>();
  const deferredQuit: Function[] = [];
  const quit = mock.fn();
  const event = { preventDefault: mock.fn() };
  const hold = installerQuitHold({ defer: (fn: Function) => deferredQuit.push(fn) });
  const runs = { list: () => [{ state: 'exited', checked: false }], close: mock.fn(() => check.promise) };
  assert.equal(hold(event, runs, null, quit), true);
  assert.equal(hold(event, runs, null, quit), true);
  assert.equal(runs.close.mock.callCount(), 2);
  assert.equal(quit.mock.callCount(), 0);
  check.resolve();
  await tick();
  assert.equal(quit.mock.callCount(), 0);
  deferredQuit[0]();
  assert.equal(quit.mock.callCount(), 1);
  assert.equal(hold(event, runs, null, quit), false);
});

test('a synchronous disposal error keeps quit open and the next request can retry', async () => {
  const hold = installerQuitHold({ defer: (fn: Function) => fn() });
  const event = { preventDefault: mock.fn() };
  const quit = mock.fn();
  let attempts = 0;
  const registry = {
    inflight: new Map([['install', true]]),
    dispose() {
      if (++attempts === 1) throw new Error('cannot start cleanup');
    },
  };
  assert.equal(hold(event, null, registry, quit), true);
  assert.equal(quit.mock.callCount(), 0);
  assert.equal(hold(event, null, registry, quit), true);
  await tick();
  assert.equal(quit.mock.callCount(), 1);
  assert.equal(attempts, 2);
});

test('failed retirement keeps the app available and a later quit retries rather than reporting success', async () => {
  const hold = installerQuitHold({ defer: (fn: Function) => fn() });
  const event = { preventDefault: mock.fn() };
  const quit = mock.fn();
  let attempts = 0;
  const runs = {
    list: () => [{ state: 'running', checked: false }],
    close: () => (++attempts === 1 ? Promise.reject(new Error('unverified')) : Promise.resolve()),
  };
  assert.equal(hold(event, runs, null, quit), true);
  await tick();
  assert.equal(quit.mock.callCount(), 0);
  assert.equal(hold(event, runs, null, quit), true);
  await tick();
  assert.equal(quit.mock.callCount(), 1);
  assert.equal(attempts, 2);
});

for (const synchronous of [false, true])
  test(`a ${synchronous ? 'throwing' : 'rejected'} repeated cleanup request keeps the original quit drain pending`, async () => {
    const drain = deferred<void>();
    let attempts = 0;
    const runs = {
      list: () => [{ state: 'running' }],
      close() {
        if (++attempts === 1) return drain.promise;
        const error = new Error('monitor still unavailable');
        if (synchronous) throw error;
        return Promise.reject(error);
      },
    };
    const quit = mock.fn();
    const hold = installerQuitHold({ defer: (fn: Function) => fn() });
    const event = { preventDefault: mock.fn() };
    assert.equal(hold(event, runs, null, quit), true);
    assert.equal(hold(event, runs, null, quit), true);
    await tick();
    assert.equal(quit.mock.callCount(), 0);
    drain.resolve();
    await tick();
    assert.equal(quit.mock.callCount(), 1);
    assert.equal(attempts, 2);
  });
