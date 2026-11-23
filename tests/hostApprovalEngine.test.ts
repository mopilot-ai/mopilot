// The approval engine on its own (host/src/approvals.mjs): cards, the clock, first answer wins, attention, and what a failing port or lane does to none of them (A1-A4, A6, W2, B1).
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createApprovals, approvalTimes, NOT_RUN_NOTICE } from '../host/src/approvals.mjs';

const MIN = 60_000;
function world(extra: any = {}) {
  let t = 1_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const records: any[] = [];
  const states: any[] = [];
  const told: any[] = [];
  const stops: string[] = [];
  const engine: any = createApprovals({
    record: (chatId: string, e: any) => records.push({ chatId, ...e }),
    state: (chatId: string, patch: any) => states.push({ chatId, ...patch }),
    stop: (chatId: string) => stops.push(chatId),
    epochOf: () => 3,
    familyOf: () => 'claude',
    notify: (m: any) => told.push(m),
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
    for (;;) {
      const next = timers.filter((x) => x.live && x.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      t = next.at;
      next.fn();
    }
    t = to;
  };
  return { engine, records, states, told, stops, advance, timers };
}
const permission = (requestId: string, extra: any = {}) => ({
  kind: 'permission',
  requestId,
  turnId: 't1',
  toolCall: { title: 'git push', kind: 'execute' },
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow_once' },
    { optionId: 'deny', name: 'Deny', kind: 'reject_once' },
  ],
  ...extra,
});
const lastAttention = (w: any) => w.states.at(-1)?.attention;
const by = { fingerprint: 'ab12', name: 'Du phone', kind: 'phone' };

test('the default clock is 10 and 30 minutes', () => {
  assert.deepEqual(approvalTimes(), { remindMs: 10 * MIN, pauseMs: 30 * MIN });
});

test('a card opens attention, lists in host.pending and tells the push port once', () => {
  const w = world();
  const out = w.engine.seen('c1', permission('r1'));
  assert.equal(out.at, 1_000);
  assert.deepEqual(lastAttention(w), { kind: 'approval', since: 1_000, cards: ['r1'] });
  const { cards, attention } = w.engine.pending();
  assert.equal(cards[0].summary.tool, 'execute');
  assert.equal(cards[0].epoch, 3);
  assert.equal(cards[0].family, 'claude');
  assert.deepEqual(cards[0].options[0], { optionId: 'allow', name: 'Allow', kind: 'allow' });
  assert.deepEqual(attention, [{ chatId: 'c1', kind: 'approval', since: 1_000, cards: ['r1'] }]);
  assert.deepEqual(
    w.told.map((m) => [m.kind, m.chatId, m.card?.requestId]),
    [['needsYou', 'c1', 'r1']],
  );
  assert.equal(w.engine.attentionOf('c1').kind, 'approval');
  assert.equal(w.engine.attentionOf('other'), null);
});

test('questions and links are cards too; a runtime event without an id is ignored (B1)', () => {
  const w = world();
  w.engine.seen('c1', { kind: 'question', turnId: 't1', question: { id: 'q1', message: 'Which colour?\nPick', form: { fields: [] } } });
  w.engine.seen('c1', permission('l1', { options: [{ optionId: 'done' }, { optionId: 'cancel' }] }));
  w.engine.seen('c1', permission('p1', { toolCall: undefined, options: undefined, turnId: undefined }));
  w.engine.seen('c1', { kind: 'permission' });
  w.engine.seen('c9', { kind: 'question', turnId: 't1', question: { id: 'q9' } });
  w.engine.seen('c1', { kind: 'question', question: null });
  const cards = w.engine.pending().cards.filter((c: any) => c.requestId !== 'q9');
  assert.deepEqual(
    cards.map((c: any) => [c.requestId, c.cardKind, c.summary.tool, c.summary.line]),
    [
      ['q1', 'question', 'question', 'Which colour? Pick'],
      ['l1', 'link', 'execute', 'git push'],
      ['p1', 'permission', 'other', ''],
    ],
  );
  assert.deepEqual(cards[0].form, { fields: [] });
  assert.equal(cards[2].turnId, undefined);
  assert.deepEqual(cards[2].options, []);
});

test('A6: reminder at 10 minutes once, pause at 30 closes every card as expired, stops the turn and says paused', () => {
  const w = world();
  w.engine.seen('c1', permission('r1'));
  w.engine.seen('c1', permission('r2'));
  w.advance(10 * MIN - 1);
  assert.equal(w.told.filter((m) => m.kind === 'reminder').length, 0);
  w.advance(1);
  w.advance(5 * MIN);
  assert.equal(w.told.filter((m) => m.kind === 'reminder').length, 1);
  w.advance(15 * MIN - 1);
  assert.deepEqual(w.stops, []);
  w.advance(1);
  assert.deepEqual(w.stops, ['c1']);
  assert.deepEqual(
    w.records.map((r) => [r.requestId, r.reason, r.kind]),
    [
      ['r1', 'expired', 'permissionCancelled'],
      ['r2', 'expired', 'permissionCancelled'],
    ],
  );
  assert.deepEqual(lastAttention(w), { kind: 'paused', since: 1_000 + 30 * MIN, reason: 'approval_timeout', pauseMinutes: 30 });
  assert.equal(w.told.at(-1).kind, 'paused');
  assert.deepEqual(w.engine.pending().cards, []);
  // the harness's own close of a card the clock closed is not recorded again
  assert.equal(w.engine.seen('c1', { kind: 'permissionCancelled', requestId: 'r1' }), null);
  // nothing fires again
  w.advance(10 * 60 * MIN);
  assert.equal(w.records.length, 2);
});

test('a failing port, lane, stop or record never resets the clock or the answer (A6)', async () => {
  const reports: string[] = [];
  const boom = () => {
    throw new Error('boom');
  };
  const w = world({ notify: boom, state: boom, stop: boom, report: (m: string) => reports.push(m) });
  w.engine.seen('c1', permission('r1'));
  w.advance(30 * MIN);
  assert.equal(w.engine.pending().cards.length, 0);
  assert.ok(reports.some((m) => m.includes('attention')));
  assert.ok(reports.some((m) => m.includes('notification')));
  assert.ok(reports.some((m) => m.includes('stopped')));
  const rejecting = world({
    notify: () => Promise.reject(new Error('no')),
    stop: () => Promise.reject(new Error('no')),
    report: (m: string) => reports.push(m),
  });
  rejecting.engine.seen('c1', permission('r1'));
  rejecting.advance(30 * MIN);
  await new Promise((r) => setImmediate(r));
  assert.ok(reports.filter((m) => m.includes('notification')).length >= 2);
  const norecord = world({ record: boom, report: (m: string) => reports.push(m) });
  norecord.engine.seen('c1', permission('r1'));
  norecord.advance(30 * MIN);
  assert.ok(reports.some((m) => m.includes('recorded')));
});

test('a policy can replace the clock: the engine reads it when the first card opens', () => {
  const w = world({ times: () => ({ remindMs: 1 * MIN, pauseMs: 2 * MIN }) });
  w.engine.seen('c1', permission('r1'));
  w.advance(2 * MIN);
  assert.equal(w.told.filter((m) => m.kind === 'reminder').length, 1);
  assert.deepEqual(w.stops, ['c1']);
});

test('the real timers are used when none are injected, and they do not hold the process', () => {
  const engine: any = createApprovals({
    record: () => undefined,
    state: () => undefined,
    stop: () => undefined,
    epochOf: () => 0,
    familyOf: () => 'acp',
  });
  engine.seen('c1', permission('r1'));
  engine.forget('c1');
  // with no report port a failing lane is silent
  const quiet = createApprovals({
    record: () => undefined,
    state: () => {
      throw new Error('x');
    },
    stop: () => undefined,
    epochOf: () => 0,
    familyOf: () => 'acp',
  });
  quiet.seen('c1', permission('r1'));
  quiet.forget('c1');
  assert.deepEqual(engine.pending(), { cards: [], attention: [], closed: [] });
});

test('A1/A2: the first answer wins in either order; a late answer never reopens or re-closes a card', () => {
  const w = world();
  w.engine.seen('c1', permission('r1'));
  const first = w.engine.claim({ chatId: 'c1', requestId: 'r1', optionId: 'allow', by });
  assert.deepEqual([first.by, first.optionKind], [by, 'allow']);
  // a second answer while the first is being applied, and after it
  const refusal = (fn: () => unknown) =>
    assert.throws(fn, (e: any) => e.code === 'card_answered' && e.details.by.name === 'Du phone' && e.details.at === 1_000);
  refusal(() => w.engine.claim({ chatId: 'c1', requestId: 'r1', optionId: 'deny' }));
  w.engine.answered('c1', 'r1', first);
  refusal(() => w.engine.claim({ chatId: 'c1', requestId: 'r1', optionId: 'deny' }));
  // the runtime's own close of the answered card is left out
  assert.equal(w.engine.seen('c1', { kind: 'permissionCancelled', requestId: 'r1' }), null);
  assert.equal(lastAttention(w), null);
  assert.deepEqual(w.engine.answeredEvent(first, { kind: 'permissionCancelled', requestId: 'r1', by: 'x' }), {
    kind: 'permissionCancelled',
    requestId: 'r1',
    turnId: 't1',
    at: 1_000,
    reason: 'answered',
    answeredBy: by,
    optionKind: 'allow',
  });
  // an answer whose card is not here, or an option that is not on it, or no principal
  assert.equal(w.engine.claim({ chatId: 'c1', requestId: 'never' }), null);
  assert.deepEqual(w.engine.answeredEvent(null, { kind: 'permissionCancelled', requestId: 'x' }), {
    kind: 'permissionCancelled',
    requestId: 'x',
    at: 1_000,
    reason: 'answered',
    optionKind: 'other',
  });
  w.engine.answered('c1', 'x', null);
});

test('W2/A1: an answer the runtime did not take is let go, so the card can be answered again', () => {
  const w = world();
  w.engine.seen('c1', permission('r1'));
  const c = w.engine.claim({ chatId: 'c1', requestId: 'r1', optionId: 'nope' });
  assert.equal(c.optionKind, 'other');
  assert.equal(c.by, null);
  w.engine.unclaim(c);
  w.engine.unclaim(null);
  assert.ok(w.engine.claim({ chatId: 'c1', requestId: 'r1', optionId: 'allow', by }));
});

test('an answer taken when the clock runs out keeps its card until it is applied', () => {
  const w = world();
  w.engine.seen('c1', permission('r1'));
  const c = w.engine.claim({ chatId: 'c1', requestId: 'r1', optionId: 'allow', by });
  w.advance(30 * MIN);
  assert.deepEqual(w.records, []);
  assert.deepEqual(w.engine.attentionOf('c1').kind, 'approval');
  w.engine.answered('c1', 'r1', c);
  assert.deepEqual(w.engine.attentionOf('c1').kind, 'paused');
});

test('A3/A4: a Stop closes the cards as stopped and ends the clock; a card of the next turn is never closed by an old one', () => {
  const w = world();
  w.engine.seen('c1', permission('r1'));
  w.engine.stopped('c1');
  assert.deepEqual(
    w.records.map((r) => [r.requestId, r.reason]),
    [['r1', 'stopped']],
  );
  w.advance(60 * MIN);
  assert.deepEqual(w.stops, []);
  assert.equal(w.engine.seen('c1', { kind: 'permissionCancelled', requestId: 'r1' }), null);
  // a new card, then the old card's late completion
  w.engine.seen('c1', permission('r2'));
  assert.equal(w.engine.seen('c1', { kind: 'permissionCancelled', requestId: 'r1' }), null);
  assert.deepEqual(
    w.engine.pending().cards.map((c: any) => c.requestId),
    ['r2'],
  );
  // another chat's Stop changes nothing here
  w.engine.stopped('c2');
  w.engine.forget('nobody');
  assert.equal(w.engine.pending().cards.length, 1);
  // an epoch change or a removed chat lets everything go, timers included
  w.engine.forget('c1');
  w.advance(60 * MIN);
  assert.deepEqual(w.stops, []);
  assert.deepEqual(w.engine.pending().cards, []);
});

test('the runtime closing a card, and a turn that ends with one left, are recorded with their reason', () => {
  const w = world();
  w.engine.seen('c1', permission('r1'));
  w.engine.seen('c1', permission('r2', { turnId: 't2' }));
  const closed = w.engine.seen('c1', { kind: 'permissionCancelled', requestId: 'r1' });
  assert.deepEqual([closed.reason, closed.at], ['turn_ended', 1_000]);
  // a close of a card this engine never saw is still told with a reason
  assert.equal(w.engine.seen('c1', { kind: 'permissionCancelled', requestId: 'zz' }).reason, 'turn_ended');
  assert.deepEqual(lastAttention(w).cards, ['r2']);
  assert.deepEqual(w.engine.seen('c1', { kind: 'turnEnd', turnId: 't1' }), { kind: 'turnEnd', turnId: 't1' });
  assert.equal(w.records.length, 0);
  w.engine.seen('c1', { kind: 'turnEnd', turnId: 't2' });
  assert.deepEqual(
    w.records.map((r) => [r.requestId, r.reason]),
    [['r2', 'turn_ended']],
  );
  assert.equal(w.engine.seen('c1', { kind: 'update' }).kind, 'update');
});

test('a message clears the attention; after a pause the next turn is told the action was not run', () => {
  const w = world();
  assert.equal(w.engine.resume('c1'), null);
  w.engine.seen('c1', permission('r1'));
  assert.equal(w.engine.resume('c1'), null);
  w.advance(30 * MIN);
  assert.equal(w.engine.resume('c1'), NOT_RUN_NOTICE);
  assert.equal(lastAttention(w), null);
  assert.equal(w.engine.resume('c1'), null);
});

const authEnd = (extra: any = {}) => ({
  kind: 'turnEnd',
  turnId: 't1',
  stopReason: 'error',
  error: { message: 'x', code: 'auth' },
  ...extra,
});

test('U4: a turn that ended for want of a credential says so, tells the push port once, and a turn that ran clears it', () => {
  const w = world();
  w.engine.seen('c1', authEnd());
  assert.deepEqual(lastAttention(w), { kind: 'credential', since: 1_000 });
  assert.equal(w.told.at(-1).kind, 'blocked');
  // the same stop again says nothing more
  w.engine.seen('c1', authEnd({ turnId: 't2' }));
  assert.equal(w.told.filter((m) => m.kind === 'blocked').length, 1);
  // a message is not a signed-in turn: the stop stays until one runs to its end
  assert.equal(w.engine.resume('c1'), null);
  assert.equal(w.engine.attentionOf('c1').kind, 'credential');
  // other failures (an untyped one, a rate limit) and a Stop leave it as it is
  w.engine.seen('c1', { kind: 'turnEnd', turnId: 't3', stopReason: 'error', error: { message: 'x' } });
  w.engine.seen('c1', { kind: 'turnEnd', turnId: 't3', stopReason: 'error', error: { message: 'x', code: 'rate_limit' } });
  w.engine.seen('c1', { kind: 'turnEnd', turnId: 't3', stopReason: 'cancelled' });
  assert.equal(w.engine.attentionOf('c1').kind, 'credential');
  w.engine.seen('c1', { kind: 'turnEnd', turnId: 't4', stopReason: 'end_turn' });
  assert.equal(lastAttention(w), null);
  // a turn that ends normally with nothing to clear changes nothing
  w.engine.seen('c1', { kind: 'turnEnd', turnId: 't5', stopReason: 'end_turn' });
  assert.equal(w.states.filter((x) => x.attention === null).length, 1);
});

test('U4: a credential stop never replaces a card, and does not clear a pause', () => {
  const w = world();
  w.engine.seen('c1', permission('r1'));
  w.engine.seen('c1', authEnd({ turnId: 't9' }));
  assert.equal(w.engine.attentionOf('c1').kind, 'approval');
  w.engine.seen('c1', permission('r3'));
  w.advance(30 * MIN);
  w.engine.seen('c1', { kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' });
  assert.equal(w.engine.attentionOf('c1').kind, 'paused');
});

test('a pause says the minutes the owner gave the card, the clock it started with, and a restart keeps them', () => {
  let pauseMs = 5 * MIN;
  const w = world({ times: () => ({ remindMs: MIN, pauseMs }) });
  w.engine.seen('c1', permission('r1'));
  // a policy sent meanwhile governs the next card, not this one
  pauseMs = 2 * MIN;
  w.advance(5 * MIN);
  assert.deepEqual(lastAttention(w), { kind: 'paused', since: 1_000 + 5 * MIN, reason: 'approval_timeout', pauseMinutes: 5 });
  const kept: Record<string, any> = {
    five: { attention: { kind: 'paused', since: 5, reason: 'approval_timeout', pauseMinutes: 5 } },
    odd: { attention: { kind: 'paused', since: 5, pauseMinutes: 'soon' } },
  };
  const again = world({ saved: (chatId: string) => kept[chatId] });
  again.engine.restore('five');
  again.engine.restore('odd');
  assert.deepEqual(again.engine.attentionOf('five'), { kind: 'paused', since: 5, reason: 'approval_timeout', pauseMinutes: 5 });
  assert.deepEqual(again.engine.attentionOf('odd'), { kind: 'paused', since: 5 });
});

test('restore: a paused or blocked chat stays so across a restart; a card the old process kept is cleared', () => {
  const kept: Record<string, any> = {
    paused: { attention: { kind: 'paused', since: 5, reason: 'approval_timeout' } },
    blocked: { attention: { kind: 'credential', since: 6 } },
    card: { attention: { kind: 'approval', since: 7, cards: ['r1'] } },
    plain: { title: 'x' },
    odd: { attention: { kind: 'credential', since: 'x' } },
  };
  const w = world({ saved: (chatId: string) => kept[chatId] });
  w.engine.restore('plain');
  w.engine.restore('none');
  assert.deepEqual(w.states, []);
  w.engine.restore('card');
  assert.deepEqual(w.states, [{ chatId: 'card', attention: null }]);
  w.engine.restore('paused');
  assert.deepEqual(w.engine.attentionOf('paused'), { kind: 'paused', since: 5, reason: 'approval_timeout' });
  assert.equal(w.engine.resume('paused'), NOT_RUN_NOTICE);
  w.engine.restore('blocked');
  assert.equal(w.engine.attentionOf('blocked').kind, 'credential');
  w.engine.restore('blocked');
  w.engine.restore('odd');
  assert.equal(w.engine.attentionOf('odd').since, 1_000);
  assert.equal(w.engine.resume('blocked'), null);
});

test('only the newest answers and closes are remembered', () => {
  const w = world();
  for (let i = 0; i < 1100; i++) {
    w.engine.seen('c1', permission(`r${i}`));
    w.engine.seen('c1', { kind: 'permissionCancelled', requestId: `r${i}` });
  }
  assert.equal(w.engine.seen('c1', { kind: 'permissionCancelled', requestId: 'r1099' }), null);
  // the oldest is forgotten, so a repeat of its close is told again rather than leaking memory
  assert.notEqual(w.engine.seen('c1', { kind: 'permissionCancelled', requestId: 'r0' }), null);
});

test('U3: a skip run closes a card at once, tells the schedule once, and a failing record or stop changes nothing', async () => {
  const skipped: string[] = [];
  const w = world({ skipped: (chatId: string) => skipped.push(chatId) });
  w.engine.scheduled('c1', 'wait');
  w.engine.scheduled('c1', undefined);
  assert.equal(w.engine.seen('c1', permission('r1')).requestId, 'r1');
  w.engine.forget('c1');
  w.engine.scheduled('c1', 'skip');
  assert.equal(w.engine.seen('c1', permission('r2')), null);
  assert.equal(w.engine.seen('c1', { kind: 'question', turnId: 't1', question: { id: 'q2', message: 'ok?' } }), null);
  assert.deepEqual(
    w.records.map((r) => [r.requestId ?? r.question?.id, r.kind, r.reason]),
    [
      ['r2', 'permission', undefined],
      ['r2', 'permissionCancelled', 'expired'],
      ['q2', 'question', undefined],
      ['q2', 'permissionCancelled', 'expired'],
    ],
  );
  assert.deepEqual(w.stops, ['c1', 'c1']);
  assert.deepEqual(skipped, ['c1']);
  assert.equal(w.engine.attentionOf('c1').kind, 'paused');
  assert.equal(w.engine.awaiting('c1'), false);
  assert.equal(w.engine.seen('c1', { kind: 'permissionCancelled', requestId: 'r2' }), null);
  // an event with no id is not a card and is left as it was
  assert.equal(w.engine.seen('c1', { kind: 'permission' }).kind, 'permission');
  // the run's turn ends: the chat's next turn waits for a person as usual
  w.engine.seen('c1', { kind: 'turnEnd', turnId: 't1' });
  w.engine.seen('c1', permission('r3'));
  assert.equal(w.engine.awaiting('c1'), true);
  // faults in the record or the stop never keep a skip from closing
  const boom = () => {
    throw new Error('boom');
  };
  const reports: string[] = [];
  const bad = world({ record: boom, stop: boom, report: (m: string) => reports.push(m) });
  bad.engine.scheduled('c2', 'skip');
  assert.throws(() => bad.engine.seen('c2', permission('x')), /boom/);
  const half = world({
    record: (_c: string, e: any) => (e.kind === 'permissionCancelled' ? boom() : undefined),
    stop: () => Promise.reject(new Error('no')),
    report: (m: string) => reports.push(m),
  });
  half.engine.scheduled('c3', 'skip');
  half.engine.seen('c3', permission('y'));
  await new Promise((r) => setImmediate(r));
  assert.ok(reports.some((m) => m.includes('recorded')));
  assert.ok(reports.some((m) => m.includes('stopped')));
  const sync = world({ stop: boom, report: (m: string) => reports.push(m) });
  sync.engine.scheduled('c4', 'skip');
  sync.engine.seen('c4', permission('z'));
  // the default `skipped` does nothing
  const quietly = createApprovals({
    record: () => undefined,
    state: () => undefined,
    stop: () => undefined,
    epochOf: () => 0,
    familyOf: () => 'acp',
  });
  quietly.scheduled('c5', 'skip');
  quietly.seen('c5', permission('q'));
});

test('host.pending names the cards that stopped waiting and who answered each, so a client can say how a card it still shows ended', () => {
  const w = world();
  w.engine.seen('c1', permission('r1'));
  w.engine.seen('c1', permission('r2'));
  const first = w.engine.claim({ chatId: 'c1', requestId: 'r1', optionId: 'allow', by });
  w.engine.answered('c1', 'r1', first);
  // a card the runtime withdrew itself has no one who answered
  w.engine.seen('c1', { kind: 'permissionCancelled', requestId: 'r2' });
  const { cards, closed } = w.engine.pending();
  assert.deepEqual(cards, []);
  assert.deepEqual(
    closed.map((c: any) => [c.requestId, c.by?.name ?? null, c.at ?? null]),
    [
      ['r1', 'Du phone', 1_000],
      ['r2', null, null],
    ],
  );
  // only the latest are reported
  for (let i = 0; i < 60; i += 1) {
    w.engine.seen('c2', permission(`n${i}`));
    w.engine.seen('c2', { kind: 'permissionCancelled', requestId: `n${i}` });
  }
  const latest = w.engine.pending().closed;
  assert.equal(latest.length, 50);
  assert.equal(latest.at(-1).requestId, 'n59');
});
