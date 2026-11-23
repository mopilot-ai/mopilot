// A Host that has not found every title yet is asked again, a few times (#4884): after a short wait, never more than a fixed number of times, and not once a newer read, the machine's removal or an answer with none left ends it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostChatKit } from '../mobile/src/remote/hostChat.ts';
import { titlesPending, TITLE_RETRIES, TITLE_RETRY_MS } from '../mobile/src/remote/startedChats.ts';
import { rig } from './support/phone/host-chat-rig.ts';
import { waitFor } from './support/waitFor.ts';

/** A kit whose Host answers with `answer()`, and the timers it asked for (run one by calling it). */
function world(answer: () => unknown, withTimers = true) {
  const r = rig();
  const reads: number[] = [];
  (r.phones as any).session = async () => ({
    supportsChatList: () => true,
    chats: async () => (reads.push(reads.length), answer()),
  });
  const timers: { fn: () => void; ms: number; cancelled: boolean }[] = [];
  const kit = createHostChatKit({
    phones: () => r.phones,
    cards: r.cards,
    newId: () => 'a'.repeat(32),
    changed: () => undefined,
    ...(withTimers
      ? {
          later: (fn: () => void, ms: number) => {
            const timer = { fn, ms, cancelled: false };
            timers.push(timer);
            return () => void (timer.cancelled = true);
          },
        }
      : {}),
  });
  /** Fires the newest timer that was not cancelled and waits for the read it makes. */
  const fire = async () => {
    const live = timers.filter((t) => !t.cancelled).at(-1);
    assert.ok(live, 'a timer is waiting');
    const before = reads.length;
    live.cancelled = true;
    live.fn();
    await waitFor(async () => reads.length > before);
  };
  return { kit, reads, timers, fire };
}
const answer = (pending: unknown) => ({ chats: [], titles: { pending, deferred: 0 } });

test('titles the Host has not found are asked for again after a short wait, at most a fixed number of times, then it stops (#4884)', async () => {
  const w = world(() => answer(3));
  assert.equal(await w.kit.sync('m1'), true);
  assert.deepEqual(
    w.timers.map((t) => t.ms),
    [TITLE_RETRY_MS],
  );
  for (let i = 1; i <= TITLE_RETRIES; i++) {
    await w.fire();
    assert.equal(w.reads.length, i + 1);
  }
  assert.equal(w.timers.filter((t) => !t.cancelled).length, 0, 'after the last retry nothing is waiting');
  assert.equal(w.reads.length, TITLE_RETRIES + 1);
});

test('asking again ends when the Host has found them all, when a newer read comes, and when the machine is removed', async () => {
  let pending = 2;
  const w = world(() => answer(pending));
  await w.kit.sync('m1');
  pending = 0;
  await w.fire();
  assert.equal(w.timers.filter((t) => !t.cancelled).length, 0, 'nothing left: no more asking');
  // a newer read cancels the wait of the older one
  pending = 2;
  await w.kit.sync('m1');
  const first = w.timers.at(-1)!;
  await w.kit.sync('m1');
  assert.equal(first.cancelled, true);
  // removing the machine cancels it
  w.kit.forgetStarted('m1');
  assert.equal(w.timers.filter((t) => !t.cancelled).length, 0);
  // a timer that fires for a machine the phone no longer has asks nothing
  await w.kit.sync('m1');
  const stale = w.timers.at(-1)!;
  const reads = w.reads.length;
  (w.kit as any).forgetStarted('m1');
  stale.cancelled = false;
  stale.fn();
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(w.reads.length, reads + 1, 'it asked once more only if still enrolled');
});

test('an answer that says nothing usable about titles asks nothing', async () => {
  for (const titles of [undefined, null, {}, { pending: 0 }, { pending: -1 }, { pending: 1.5 }, { pending: '3' }, 'x']) {
    const w = world(() => ({ chats: [], titles }));
    assert.equal(await w.kit.sync('m1'), true);
    assert.equal(w.timers.length, 0);
  }
  assert.deepEqual([titlesPending(null), titlesPending({ titles: { pending: 4 } })], [0, 4]);
});

test('the phone’s own clock asks again, and removing the machine stops it', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const w = world(() => answer(1), false);
  await w.kit.sync('m1');
  t.mock.timers.tick(TITLE_RETRY_MS);
  await waitFor(async () => w.reads.length === 2);
  w.kit.forgetStarted('m1');
  t.mock.timers.tick(TITLE_RETRY_MS * 3);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(w.reads.length, 2, 'stopped');
});
