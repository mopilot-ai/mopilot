// A notification's own buttons (host/src/momoIntents.mjs): typed, fenced to the running home, on a key this home issued, once per notification across taps, devices and restarts, with a reminder that is always ahead and bounded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createMomoIntents, MAX_REMIND_MS } from '../host/src/momoIntents.mjs';
// @ts-ignore
import { nextWallTime, zonedParts } from '../host/src/momoClock.mjs';

const NY = 'America/New_York';
const MIN = 60_000;

function wall(zone: string, day: string, hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  const [y, mo, d] = day.split('-').map(Number);
  let t = Date.UTC(y, mo - 1, d, 0, 0) - 14 * 60 * MIN;
  for (let i = 0; i < 50 * 60; i++, t += MIN) {
    const p = zonedParts(t, zone);
    if (p.day === day && p.minutes >= h * 60 + m) return t;
  }
  throw new Error('no such time');
}

/** A push stand-in that remembers what the real one keeps: the keys it issued, and which already did their work. */
function pushStub(keys: string[] = []) {
  const issued = new Set(keys);
  const done = new Set<string>();
  const cleared: [string, any][] = [];
  return {
    cleared,
    knows: (k: string) => issued.has(k),
    intentDone: (k: string) => done.has(k),
    markIntent: async (k: string, on: boolean) => void (on ? done.add(k) : done.delete(k)),
    answered: async (k: string, how: any) => (cleared.push([k, how]), 1),
  };
}

test('Remind me at 4 reads 4 PM on the owner clock even a minute before it, a second tap from another device is acknowledged and not run again, and the notification is cleared everywhere', async () => {
  const calls: any[] = [];
  let lease: any = { homeId: 'studio', leaseEpoch: 1 };
  let at = wall(NY, '2026-11-23', '12:00');
  const push = pushStub(['dana-1', 'k2', 'k4', 'k5', 'k6']);
  const intents = createMomoIntents({
    home: { stamp: () => lease },
    push,
    handlers: { draft: (a: any) => calls.push(a), remind: (a: any) => calls.push(a), dismiss: () => undefined },
    zone: () => NY,
    machine: () => 'Studio',
    now: () => at,
  });
  const r = await intents.apply({ key: 'dana-1', action: 'remind' });
  assert.equal(r.at, wall(NY, '2026-11-23', '16:00'));
  assert.deepEqual(push.cleared, [['dana-1', { by: 'button' }]]);
  assert.equal(calls[0].stamp.leaseEpoch, 1);
  assert.deepEqual(
    await intents.apply({ key: 'dana-1', action: 'dismiss' }),
    { ok: true, action: 'dismiss', duplicate: true },
    'one answer per notification, whatever the action',
  );
  assert.equal(calls.length, 1);
  // 15:59:10: the next 4 PM is fifty seconds away and is still accepted
  at = wall(NY, '2026-11-23', '15:59') + 10_000;
  assert.equal((await intents.apply({ key: 'k2', action: 'remind' })).at, wall(NY, '2026-11-23', '16:00'));
  // after 4 PM "at 4" is tomorrow; a time a client names must be ahead and within a month
  at = wall(NY, '2026-11-23', '17:00');
  await assert.rejects(intents.apply({ key: 'k4', action: 'remind', at: at - MIN }), /not a time MoMo can remind/);
  await assert.rejects(intents.apply({ key: 'k4', action: 'remind', at: at + MAX_REMIND_MS + 1 }), /not a time MoMo can remind/);
  assert.equal((await intents.apply({ key: 'k4', action: 'remind', at: at + 5 * MIN })).at, at + 5 * MIN);
  assert.deepEqual(await intents.apply({ key: 'k5', action: 'draft' }), { ok: true, action: 'draft' });
  // an answer nobody handles yet is refused honestly; a key this home never issued is refused; a Host that is not the home refuses all
  const bare = createMomoIntents({ home: { stamp: () => lease }, push, machine: () => 'Studio' });
  await assert.rejects(bare.apply({ key: 'k6', action: 'dismiss' }), /MoMo on .* can't do that from a notification yet/);
  bare.setHandlers({ dismiss: () => undefined });
  assert.equal((await bare.apply({ key: 'k6', action: 'dismiss' })).ok, true);
  await assert.rejects(intents.apply({ key: 'made-up', action: 'draft' }), /not one MoMo on .* sent/);
  lease = null;
  await assert.rejects(intents.apply({ key: 'k6', action: 'draft' }), /not running on Studio/);
});

test('an answer that fails can be tried again; a restart does not run an answered notification again; two taps at once run it once', async () => {
  let n = 0;
  let fail = true;
  const push = pushStub(['a', 'same']);
  const make = () =>
    createMomoIntents({
      home: { stamp: () => ({}) },
      push,
      handlers: {
        draft: async () => {
          n++;
          if (fail) throw new Error('model down');
        },
      },
    });
  const intents = make();
  await assert.rejects(intents.apply({ key: 'a', action: 'draft' }), /model down/);
  assert.equal(push.intentDone('a'), false);
  fail = false;
  assert.equal((await intents.apply({ key: 'a', action: 'draft' })).ok, true);
  assert.equal(n, 2);
  // a tap after a restart (a new object over the same kept state)
  assert.equal((await make().apply({ key: 'a', action: 'draft' })).duplicate, true);
  assert.equal(n, 2);

  let release: () => void = () => undefined;
  const gate = new Promise<void>((r) => (release = r));
  let m = 0;
  const slow = createMomoIntents({ home: { stamp: () => ({}) }, push, handlers: { draft: async () => void (m++, await gate) } });
  const x = slow.apply({ key: 'same', action: 'draft' });
  await new Promise((r) => setImmediate(r));
  const y = slow.apply({ key: 'same', action: 'draft' });
  release();
  const [rx, ry] = await Promise.all([x, y]);
  assert.equal(m, 1);
  assert.deepEqual([rx.duplicate, ry.duplicate], [undefined, true]);
});

test('nextWallTime: the next 4 PM, across the daylight-saving jump, and the next real minute when the hour does not exist', () => {
  assert.equal(nextWallTime(16 * 60, wall(NY, '2026-11-23', '10:00'), NY), wall(NY, '2026-11-23', '16:00'));
  assert.equal(nextWallTime(16 * 60, wall(NY, '2026-03-07', '17:00'), NY), wall(NY, '2026-03-08', '16:00'));
  assert.equal(nextWallTime(2 * 60 + 30, wall(NY, '2026-03-08', '00:10'), NY), wall(NY, '2026-03-08', '03:00'));
});
