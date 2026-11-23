// Browser event waits clean up their listeners and timers without retiring another wait on the same page.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const { waitEvent } = createRequire(import.meta.url)('../electron/capabilities/browser/hostUtil.cjs');

test('the first page event resolves the wait and removes every listener', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = new EventEmitter();
  const answer = waitEvent(page, ['loaded', 'destroyed'], 100);
  assert.equal(page.listenerCount('loaded'), 1);
  assert.equal(page.listenerCount('destroyed'), 1);
  page.emit('loaded');
  assert.equal(await answer, 'loaded');
  assert.equal(page.listenerCount('loaded'), 0);
  assert.equal(page.listenerCount('destroyed'), 0);
  t.mock.timers.tick(100);
});

test('a timed-out page wait removes its listeners', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = new EventEmitter();
  const answer = waitEvent(page, ['loaded', 'destroyed'], 100);
  t.mock.timers.tick(100);
  assert.equal(await answer, 'timeout');
  assert.equal(page.listenerCount('loaded'), 0);
  assert.equal(page.listenerCount('destroyed'), 0);
});

test('one wait timing out leaves another page wait active', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const page = new EventEmitter();
  const first = waitEvent(page, ['loaded'], 10);
  const second = waitEvent(page, ['loaded'], 100);
  t.mock.timers.tick(10);
  assert.equal(await first, 'timeout');
  assert.equal(page.listenerCount('loaded'), 1);
  page.emit('loaded');
  assert.equal(await second, 'loaded');
  assert.equal(page.listenerCount('loaded'), 0);
});
