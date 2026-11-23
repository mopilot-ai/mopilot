// The owner's approval timings reach the Host's clock (U2): a card reminds and pauses the run after the effective policy's minutes, not the defaults, and a policy sent meanwhile governs the next card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { approvalsFor } from '../host/src/approvalWiring.mjs';

const MIN = 60_000;
const card = (requestId: string) => ({
  kind: 'permission',
  requestId,
  turnId: 't1',
  options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
});

function world(ports: any) {
  let t = 1_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const stopped: string[] = [];
  const approvals = approvalsFor(
    {
      record: () => undefined,
      hub: { state: () => ({}), current: () => ({}) },
      runtime: { host: { cancel: (chatId: string) => stopped.push(chatId) } },
      epochs: { current: () => 1, onAdvance: () => undefined },
      familyOf: () => 'acp',
      report: () => undefined,
      skipped: () => undefined,
    },
    {
      approvalClock: {
        now: () => t,
        after: (fn: () => void, ms: number) => {
          const timer = { at: t + ms, fn, live: true };
          timers.push(timer);
          return () => void (timer.live = false);
        },
      },
      ...ports,
    },
  );
  const advance = (ms: number) => {
    const to = t + ms;
    for (const x of timers.filter((x) => x.live && x.at <= to).sort((a, b) => a.at - b.at)) {
      x.live = false;
      t = x.at;
      x.fn();
    }
    t = to;
  };
  return { approvals, stopped, advance };
}

test('the policy’s minutes are the card’s clock: nothing stops before the pause, the run stops at it, and a changed policy governs the next card', () => {
  const settings = { approvals: { remindMinutes: 1, pauseMinutes: 5 } };
  const w = world({ policy: { approvalSettings: () => settings } });
  w.approvals.seen('c1', card('r1'));
  w.advance(5 * MIN - 1);
  assert.deepEqual(w.stopped, []);
  w.advance(1);
  assert.deepEqual(w.stopped, ['c1']);
  settings.approvals = { remindMinutes: 1, pauseMinutes: 2 };
  w.approvals.seen('c2', card('r2'));
  w.advance(2 * MIN);
  assert.deepEqual(w.stopped, ['c1', 'c2']);
});

test('without a policy the defaults stand, and a clock given by the caller wins over the policy', () => {
  const none = world({});
  none.approvals.seen('c1', card('r1'));
  none.advance(30 * MIN - 1);
  assert.deepEqual(none.stopped, []);
  none.advance(1);
  assert.deepEqual(none.stopped, ['c1']);
  const given = world({
    approvalTimes: () => ({ remindMs: MIN, pauseMs: 2 * MIN }),
    policy: { approvalSettings: () => ({ approvals: { remindMinutes: 9, pauseMinutes: 9 } }) },
  });
  given.approvals.seen('c1', card('r1'));
  given.advance(2 * MIN);
  assert.deepEqual(given.stopped, ['c1']);
});
