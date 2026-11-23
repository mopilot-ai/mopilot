// The unit run's one-time setup: the Rust core every test file loads is current before the first of them starts.
import assert from 'node:assert/strict';
import test from 'node:test';
import { globalSetup } from '../scripts/test-global-setup.mjs';

test('a unit run makes its Rust core current once, logging to stderr', () => {
  const calls: unknown[] = [];
  globalSetup({ ensure: ((o: unknown) => (calls.push(o), null)) as never });
  assert.deepEqual(calls, [{ log: console.error }]);
});

test('a core that cannot build stops the run before any test starts', () => {
  assert.throws(
    () =>
      globalSetup({
        ensure: (() => {
          throw new Error('The Rust core did not build');
        }) as never,
      }),
    /did not build/,
  );
});
