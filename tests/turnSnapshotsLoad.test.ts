// What the live turn diff costs with many chats running (electron/session/turnSnapshots.cjs): reads share a global cap,
// an unchanged diff is not sent again, a chat no window shows is not read, and a live diff says it is live.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const { TurnSnapshots, MAX_LIVE_READS, HIDDEN_DELAY_MS, LIVE_DELAY_MS } = require('../electron/session/turnSnapshots.cjs');

const wait = (ms = 15) => new Promise((r) => setTimeout(r, ms));

/** A fake TurnChanges whose peeks wait to be released, so a test sees how many run at once. */
function fakes(o: { shows?: (c: string) => boolean; diff?: (key: string, n: number) => string | undefined } = {}) {
  let running = 0;
  let peak = 0;
  let calls = 0;
  const gates: (() => void)[] = [];
  const changes = {
    begin: async () => {},
    itemStarted: () => {},
    peek: async (key: string) => {
      running++;
      peak = Math.max(peak, running);
      const n = ++calls;
      await new Promise<void>((r) => gates.push(r));
      running--;
      return o.diff ? o.diff(key, n) : `diff ${key}`;
    },
  };
  const published: [any, boolean | undefined][] = [];
  const snaps = new TurnSnapshots({
    changes,
    state: { has: () => false },
    publish: (d: any, live?: boolean) => published.push([d, live]),
    delayMs: 1,
    hiddenDelayMs: 4,
    shows: o.shows,
  });
  const open = async (n: number) => {
    for (let i = 0; i < n; i++) {
      gates.shift()?.();
      await wait(2);
    }
  };
  return { snaps, changes, published, gates, open, stats: () => ({ peak, calls, running }) };
}

const run = (snaps: any, chat: string) => {
  snaps.begin(chat, `k-${chat}`, '/w', `t-${chat}`);
  snaps.tool(chat, `k-${chat}`, false);
};

test('the defaults: a few reads at once, a longer wait for a chat nobody shows', () => {
  assert.equal(MAX_LIVE_READS, 2);
  assert.equal(HIDDEN_DELAY_MS > LIVE_DELAY_MS, true);
});

test('five chats ending tool calls together read two at a time, and every one is read', async () => {
  const f = fakes();
  const chats = ['a', 'b', 'c', 'd', 'e'];
  for (const c of chats) run(f.snaps, c);
  await wait();
  assert.deepEqual(f.stats(), { peak: 2, calls: 2, running: 2 }, 'two run, three wait');
  await f.open(5);
  await wait();
  assert.equal(f.stats().peak, 2);
  assert.equal(f.stats().calls, 5);
  assert.deepEqual(f.published.map(([d]) => d.chatId).sort(), chats);
  assert.equal(
    f.published.every(([, live]) => live === true),
    true,
  );
  assert.equal(f.snaps.active, 0);
  assert.equal(f.snaps.waiting.length, 0);
});

test('a diff equal to the one already sent is not sent again, a changed one is', async () => {
  let n = 0;
  const f = fakes({ diff: () => (++n <= 2 ? 'same' : 'more') });
  run(f.snaps, 'a');
  await wait();
  await f.open(1);
  await wait();
  f.snaps.tool('a', 'k-a', false);
  await wait();
  await f.open(1);
  await wait();
  assert.equal(f.published.length, 1, 'the second read matched the first');
  f.snaps.tool('a', 'k-a', false);
  await wait();
  await f.open(1);
  await wait();
  assert.deepEqual(
    f.published.map(([d]) => d.diff),
    ['same', 'more'],
  );
});

test('a chat no window shows is not read; once a window shows it, the next tool call reads it', async () => {
  let shown = false;
  const f = fakes({ shows: () => shown });
  run(f.snaps, 'a');
  await wait(20);
  assert.equal(f.stats().calls, 0, 'nothing spawned for a hidden chat');
  assert.equal(f.snaps.turns.get('a').reading, false);
  shown = true;
  f.snaps.tool('a', 'k-a', false);
  await wait();
  await f.open(1);
  await wait();
  assert.equal(f.stats().calls, 1);
  assert.equal(f.published.length, 1);
});

test('a lookup that throws counts the chat as shown, and no lookup at all does too', async () => {
  const f = fakes({
    shows: () => {
      throw new Error('boom');
    },
  });
  run(f.snaps, 'a');
  await wait();
  await f.open(1);
  await wait();
  assert.equal(f.published.length, 1);
  const g = fakes();
  assert.equal(g.snaps.watching('x'), true);
});

test('a turn that ended while its read waited for a place is not read or published, and frees nothing it never held', async () => {
  const f = fakes();
  for (const c of ['a', 'b', 'c']) run(f.snaps, c);
  await wait();
  assert.equal(f.snaps.waiting.length, 1, 'c waits');
  f.snaps.retire('c');
  await f.open(3);
  await wait();
  assert.equal(f.stats().calls, 2, 'c never reached git');
  assert.deepEqual(f.published.map(([d]) => d.chatId).sort(), ['a', 'b']);
  assert.equal(f.snaps.active, 0);
});

test('a failing read frees its place for the next one', async () => {
  const f = fakes();
  const peek = f.changes.peek;
  let first = true;
  f.changes.peek = async (k: string) => {
    if (first) {
      first = false;
      throw new Error('git failed');
    }
    return peek(k);
  };
  for (const c of ['a', 'b', 'c']) run(f.snaps, c);
  await wait();
  await f.open(3);
  await wait();
  assert.equal(f.snaps.active, 0);
  assert.equal(f.published.length, 2, 'the other two still read');
});
