// The close of a card is one durable journal item with the turn it belongs to, whoever or whatever closes it (host/src/approvals.mjs, approvalRecovery.mjs): the facts every client folds into the card's outcome line (shared/host/cardClosed.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createApprovals } from '../host/src/approvals.mjs';
// @ts-ignore: plain ESM without declarations
import { closeCutOffCards } from '../host/src/approvalRecovery.mjs';

const MIN = 60_000;
const by = { fingerprint: 'ab12', name: 'Pocket iPhone', kind: 'phone' };
const card = (requestId: string, turnId = 't1') => ({
  kind: 'permission',
  requestId,
  turnId,
  options: [{ optionId: 'allow', name: 'Allow', kind: 'allow_once' }],
});

function world(extra: any = {}) {
  let t = 1_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const records: any[] = [];
  const engine: any = createApprovals({
    record: (chatId: string, e: any) => records.push({ chatId, ...e }),
    state: () => undefined,
    stop: () => undefined,
    epochOf: () => 1,
    familyOf: () => 'acp',
    now: () => t,
    after: (fn: () => void, ms: number) => {
      const timer = { at: t + ms, fn, live: true };
      timers.push(timer);
      return () => void (timer.live = false);
    },
    ...extra,
  });
  const advance = (ms: number) => {
    const to = t + ms;
    for (const x of timers.filter((x) => x.live && x.at <= to).sort((a, b) => a.at - b.at)) (x.live = false), (t = x.at), x.fn();
    t = to;
  };
  return { engine, records, advance };
}
const closes = (w: { records: any[] }) =>
  w.records.filter((r) => r.kind === 'permissionCancelled').map((r) => [r.requestId, r.reason, r.turnId]);

test('every way a card closes writes one item that names the card, why and its turn', () => {
  // the clock
  const timed = world();
  timed.engine.seen('c1', card('r1', 't7'));
  timed.advance(30 * MIN);
  assert.deepEqual(closes(timed), [['r1', 'expired', 't7']]);
  // a Stop, and the turn's own end
  const stopped = world();
  stopped.engine.seen('c1', card('r1', 't2'));
  stopped.engine.stopped('c1');
  assert.deepEqual(closes(stopped), [['r1', 'stopped', 't2']]);
  const ended = world();
  ended.engine.seen('c1', card('r1', 't3'));
  ended.engine.seen('c1', { kind: 'turnEnd', turnId: 't3', stopReason: 'end_turn' });
  assert.deepEqual(closes(ended), [['r1', 'turn_ended', 't3']]);
  // the harness closing a card itself
  const harness = world();
  harness.engine.seen('c1', card('r1', 't4'));
  assert.deepEqual(harness.engine.seen('c1', { kind: 'permissionCancelled', requestId: 'r1' }), {
    kind: 'permissionCancelled',
    requestId: 'r1',
    turnId: 't4',
    at: 1_000,
    reason: 'turn_ended',
  });
  // an answer, with who and which option
  const answered = world();
  answered.engine.seen('c1', card('r1', 't5'));
  const claim = answered.engine.claim({ chatId: 'c1', requestId: 'r1', optionId: 'allow', by });
  assert.deepEqual(answered.engine.answeredEvent(claim, { kind: 'permissionCancelled', requestId: 'r1' }), {
    kind: 'permissionCancelled',
    requestId: 'r1',
    turnId: 't5',
    at: 1_000,
    reason: 'answered',
    answeredBy: by,
    optionKind: 'allow',
  });
  // a scheduled run that skips approvals
  const skipped = world();
  skipped.engine.scheduled('c1', 'skip');
  skipped.engine.seen('c1', card('r1', 't6'));
  assert.deepEqual(closes(skipped), [['r1', 'expired', 't6']]);
  // a card of no turn names none
  const loose = world();
  loose.engine.seen('c1', { kind: 'permission', requestId: 'r1', options: [] });
  loose.engine.stopped('c1');
  assert.deepEqual(closes(loose), [['r1', 'stopped', undefined]]);
});

test('a card has one close item: two clients answering at once, the harness closing it after, and a restart write it once', () => {
  const w = world();
  w.engine.seen('c1', card('r1', 't1'));
  w.engine.seen('c1', card('r2', 't1'));
  const first = w.engine.claim({ chatId: 'c1', requestId: 'r1', optionId: 'allow', by });
  assert.throws(
    () => w.engine.claim({ chatId: 'c1', requestId: 'r1', optionId: 'deny' }),
    (e: any) => e.code === 'card_answered',
  );
  w.engine.answered('c1', 'r1', first);
  // the harness's own close of the answered card is left out of the record
  assert.equal(w.engine.seen('c1', { kind: 'permissionCancelled', requestId: 'r1' }), null);
  // a restart closes the cards the journal shows open and never the one that closed
  const journal = [{ event: card('r1', 't1') }, { event: { kind: 'permissionCancelled', requestId: 'r1' } }, { event: card('r2', 't1') }];
  const restart: any[] = [];
  closeCutOffCards({
    log: { items: () => journal },
    approvals: { restore: () => undefined },
    chatId: 'c1',
    turnId: 't1',
    record: (_chatId: string, e: any) => restart.push(e),
  });
  assert.deepEqual(
    restart.map((e) => [e.requestId, e.reason, e.turnId]),
    [['r2', 'host_restarted', 't1']],
  );
});
