// Startup resource ownership: pending opens are cancelled, failures clean up, and successful opens transfer ownership.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { getEventListeners } from 'node:events';
import { deferred } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { startupResource } = require('../electron/app/startupResource.cjs');
const { startApp } = require('../electron/app/startup.cjs');
const { clearIgnored, recentIgnored } = require('../electron/ignored.cjs');

test('a successful startup transfers the open resource to normal app cleanup', async () => {
  const setup = new AbortController();
  let closed = 0;
  const claim = await startupResource(
    setup.signal,
    async () => 'listener',
    () => closed++,
  );
  assert.equal(getEventListeners(setup.signal, 'abort').length, 1, 'opening alone does not transfer cancellation ownership');
  assert.equal(claim(), 'listener');
  assert.equal(getEventListeners(setup.signal, 'abort').length, 0);
  setup.abort();
  assert.equal(closed, 0, 'normal app shutdown owns a successfully opened resource');
});

test('retirement between opening and the caller resuming closes the unclaimed resource', async () => {
  const setup = new AbortController();
  let closed = 0;
  const claim = await startupResource(
    setup.signal,
    async () => 'obsolete socket',
    () => closed++,
  );
  const reason = new Error('retired before claim');
  setup.abort(reason);
  assert.equal(closed, 1);
  assert.throws(claim, (error) => error === reason);
  assert.equal(getEventListeners(setup.signal, 'abort').length, 0);
});

test('an already retired startup never opens its resource', async () => {
  const setup = new AbortController();
  const reason = new Error('retired');
  setup.abort(reason);
  let opened = 0;
  let closed = 0;
  await assert.rejects(
    startupResource(
      setup.signal,
      async () => opened++,
      () => closed++,
    ),
    (error) => error === reason,
  );
  assert.equal(opened, 0);
  assert.equal(closed, 1);
  assert.equal(getEventListeners(setup.signal, 'abort').length, 0);
});

for (const outcome of ['success', 'failure'] as const) {
  test(`retiring a pending open closes it once and rejects its late ${outcome}`, async () => {
    const setup = new AbortController();
    const opening = deferred<string>();
    let closed = 0;
    const result = startupResource(
      setup.signal,
      () => opening.promise,
      () => closed++,
    );
    const reason = new Error('app stopping');
    const failure = new Error('listen failed');
    const rejected = assert.rejects(result, (error) => error === (outcome === 'success' ? reason : failure));
    assert.equal(getEventListeners(setup.signal, 'abort').length, 1);
    setup.abort(reason);
    assert.equal(closed, 1, 'cleanup starts before the opening promise settles');
    if (outcome === 'success') opening.resolve('obsolete listener');
    else opening.reject(failure);
    await rejected;
    assert.equal(closed, 1);
    assert.equal(getEventListeners(setup.signal, 'abort').length, 0);
  });
}

test('an opening failure cleans up; a failed cleanup is reported without replacing the opening error', async () => {
  clearIgnored();
  const setup = new AbortController();
  const failure = new Error('bind denied');
  await assert.rejects(
    startupResource(
      setup.signal,
      () => {
        throw failure;
      },
      () => {
        throw new Error('cleanup failed');
      },
    ),
    (error) => error === failure,
  );
  assert.equal(getEventListeners(setup.signal, 'abort').length, 0);
  assert.ok(
    recentIgnored().some((error: any) => error.context === 'close a cancelled startup resource' && error.message === 'cleanup failed'),
  );
});

test('an app startup registered after quit acceptance is already retired', async () => {
  const quitting = new AbortController();
  quitting.abort();
  let readiness!: () => Promise<unknown>;
  const started = deferred<void>();
  startApp({
    ipcMain: { on: () => {}, handle: (_channel: string, handler: () => Promise<unknown>) => (readiness = handler) },
    lifecycle: { quitSignal: quitting.signal },
    app: { whenReady: () => started.promise },
  });
  assert.deepEqual(await readiness(), { error: { code: 'startup_closed', message: 'MoPilot is quitting.' } });
  started.resolve();
  await new Promise((resolve) => setImmediate(resolve));
});
