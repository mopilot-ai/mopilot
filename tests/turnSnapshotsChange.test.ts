// TurnSnapshots.onChange: listeners hear each diff the windows are told, and a followed chat's live diff is read though no window shows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const { TurnSnapshots } = require('../electron/session/turnSnapshots.cjs');

const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));

function rig(o: Record<string, unknown> = {}) {
  const published: any[] = [];
  let peeks = 0;
  const changes = {
    begin: async () => {},
    itemStarted: () => {},
    peek: async () => (peeks++, 'live diff'),
    finish: async () => 'final diff',
    abort: () => {},
  };
  const snaps = new TurnSnapshots({
    changes,
    state: { has: () => true, get: () => ({ activeTurn: { id: 'turn-1' } }) },
    publish: (d: unknown, live?: boolean) => published.push([d, live]),
    delayMs: 1,
    hiddenDelayMs: 2,
    ...o,
  });
  return { snaps, published, peeks: () => peeks };
}

test('a listener hears live, final and taken-back diffs, with the windows told first; a stopped or failing listener does not matter', () => {
  const { snaps, published } = rig();
  const heard: any[] = [];
  const stop = snaps.onChange((c: unknown) => heard.push(c));
  snaps.onChange(() => {
    throw new Error('listener failed');
  });
  snaps.emit({ chatId: 'c1', turnId: 't1', diff: 'd' }, true);
  snaps.emit({ chatId: 'c1', turnId: 't1', diff: 'd' });
  snaps.emit({ chatId: 'c1', turnId: 't1', diff: null });
  assert.deepEqual(heard, [
    { chatId: 'c1', turnId: 't1', live: true, removed: false },
    { chatId: 'c1', turnId: 't1', live: false, removed: false },
    { chatId: 'c1', turnId: 't1', live: false, removed: true },
  ]);
  assert.equal(published.length, 3);
  stop();
  snaps.emit({ chatId: 'c1', turnId: 't2', diff: 'd' });
  assert.equal(heard.length, 3);
});

test('a chat no window shows is read live only while a phone follows it', async () => {
  const unfollowed = rig({ shows: () => false });
  const heard: any[] = [];
  unfollowed.snaps.onChange((c: unknown) => heard.push(c));
  unfollowed.snaps.begin('c1', 'k1', '/work', 'turn-1');
  unfollowed.snaps.tool('c1', 'k1', false);
  await wait(30);
  assert.equal(unfollowed.peeks(), 0, 'nobody is looking: no git read');

  const followed = rig({ shows: () => false, followed: (id: string) => id === 'c1' });
  followed.snaps.onChange((c: unknown) => heard.push(c));
  followed.snaps.begin('c1', 'k1', '/work', 'turn-1');
  followed.snaps.tool('c1', 'k1', false);
  await wait(30);
  assert.equal(followed.peeks(), 1);
  assert.deepEqual(heard, [{ chatId: 'c1', turnId: 'turn-1', live: true, removed: false }]);
});

test('a followed-lookup that throws counts the chat as watched', () => {
  const { snaps } = rig({
    shows: () => false,
    followed: () => {
      throw new Error('lookup failed');
    },
  });
  assert.equal(snaps.watching('c1'), true);
});

test('a windows sink that throws does not keep the listeners from the change', () => {
  const { snaps } = rig({
    publish: () => {
      throw new Error('sink failed');
    },
  });
  const heard: any[] = [];
  snaps.onChange((c: unknown) => heard.push(c));
  snaps.emit({ chatId: 'c1', turnId: 't1', diff: 'd' }, true);
  assert.equal(heard.length, 1);
});
