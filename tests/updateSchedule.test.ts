// Deterministic updater timers: cadence, jitter, nonoverlap, backoff and cancellation during pending checks.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { deferred, tick as flush } from './support/async-scenarios.ts';
const { scheduleUpdates } = createRequire(import.meta.url)('../electron/updates/schedule.cjs');

test('checks after startup, then each minute', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let checks = 0;
    const stop = scheduleUpdates(async () => (checks++, { status: 'idle' }), { random: () => 0, onError: assert.fail });
    mock.timers.tick(9_999);
    assert.equal(checks, 0);
    mock.timers.tick(1);
    await flush();
    assert.equal(checks, 1);
    mock.timers.tick(59_999);
    assert.equal(checks, 1);
    mock.timers.tick(1);
    await flush();
    assert.equal(checks, 2);
    stop();
    mock.timers.tick(120_000);
    assert.equal(checks, 2);
  } finally {
    mock.timers.reset();
  }
});

test('jitter spreads clients; pending checks never overlap and stopping prevents a retired continuation', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let resolve!: (s: any) => void;
    let checks = 0;
    const stop = scheduleUpdates(
      () => (
        checks++,
        new Promise((r) => {
          resolve = r;
        })
      ),
      { random: () => 0.5, onError: assert.fail },
    );
    mock.timers.tick(12_499);
    assert.equal(checks, 0);
    mock.timers.tick(1);
    assert.equal(checks, 1);
    mock.timers.tick(300_000);
    assert.equal(checks, 1);
    stop();
    resolve({ status: 'idle' });
    await flush();
    mock.timers.tick(300_000);
    assert.equal(checks, 1);
    const random = mock.method(Math, 'random', () => 0);
    const cancel = scheduleUpdates(async () => ({ status: 'idle' }), { onError: assert.fail });
    assert.equal(random.mock.callCount(), 1);
    cancel();
    random.mock.restore();
  } finally {
    mock.timers.reset();
  }
});

test('failures back off to fifteen minutes; thrown errors are recorded and a successful retry resets the interval', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    let checks = 0;
    const errors: unknown[] = [];
    const stop = scheduleUpdates(
      async () => {
        checks++;
        if (checks === 1) throw new Error('offline');
        return { status: checks < 7 ? 'error' : 'idle' };
      },
      { random: () => 0, onError: (e: unknown) => errors.push(e) },
    );
    mock.timers.tick(10_000);
    await flush();
    assert.equal(errors.length, 1);
    for (const delay of [120_000, 240_000, 480_000, 900_000, 900_000, 900_000, 60_000]) {
      const before = checks;
      mock.timers.tick(delay - 1);
      assert.equal(checks, before);
      mock.timers.tick(1);
      await flush();
      assert.equal(checks, before + 1);
    }
    stop();
  } finally {
    mock.timers.reset();
  }
});

for (const outcome of ['success', 'failure']) {
  test(`a replaced schedule's late ${outcome} leaves the new schedule's cadence intact`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = deferred<{ status: string }>();
    let oldChecks = 0;
    let newChecks = 0;
    const errors: unknown[] = [];
    const options = { random: () => 0, onError: (error: unknown) => errors.push(error) };
    const stopOld = scheduleUpdates(() => (oldChecks++, pending.promise), options);
    t.mock.timers.tick(10_000);
    assert.equal(oldChecks, 1);
    stopOld();
    const stopNew = scheduleUpdates(async () => (newChecks++, { status: 'idle' }), options);
    t.after(stopNew);
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(newChecks, 1);
    if (outcome === 'success') pending.resolve({ status: 'idle' });
    else pending.reject(new Error('old check failed'));
    await flush();
    t.mock.timers.tick(60_000);
    await flush();
    assert.equal(oldChecks, 1, 'a retired check cannot schedule another run');
    assert.equal(newChecks, 2, 'only the replacement schedule continues');
    assert.equal(errors.length, outcome === 'failure' ? 1 : 0);
  });
}
