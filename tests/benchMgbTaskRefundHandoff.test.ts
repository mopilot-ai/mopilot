// MGB task f6-refund-handoff (#1381): beside the audit (benchMgbAudit.test.ts), each batch of three requests holds two that
// qualify and one refused, a duplicate refund always goes through the shop (so it shows), and plausible wrong
// handoffs (the new harness redoing the first batch, never finishing, or the first batch's replies lost) do not pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse, gradeTask, setupTask, unmet } from './support/mgb-task-kit.ts';

const { orderTotal } = await import('../bench/lib/mgb/tasks/common.mjs');
const { confirmedId, repeated } = await import('../bench/lib/mgb/tasks/f6Common.mjs');
const { FIRST, eligible, handle, requestMail, task } = await import('../bench/lib/mgb/tasks/f6RefundHandoff.mjs');

const setup = (seed = 's1') => setupTask(task, seed);
const grade = ({ env, data, state }: any) => gradeTask({ task, data, state, env });
const firstBatch = (data: any) => data.requests.slice(0, FIRST);
const rest = (data: any) => data.requests.slice(FIRST);

test('f6-refund-handoff runs only in the switch column', () => {
  assert.deepEqual(task.columns, ['switch']);
  assert.equal(task.family, 'F6');
  assert.equal(task.tier, 'smoke');
  assert.ok(task.prompt(setup().data, setup().env).length > (task.switchBefore ?? 1));
});

test('the data: two batches of three, each with two refunds and one refusal, newest first in the inbox', () => {
  const kinds = new Set<string>();
  for (let n = 0; n < 12; n++) {
    const { data, state } = setup(`kinds-${n}`);
    assert.equal(data.requests.length, 6);
    for (const batch of [firstBatch(data), rest(data)]) {
      assert.equal(batch.filter((q: any) => q.eligible).length, 2);
      assert.equal(batch.filter((q: any) => !q.eligible).length, 1);
    }
    // the inbox lists the requests in data order: the first three are its top three
    const inbox = state.mail.messages
      .filter((m: any) => m.folder === 'inbox' && data.requests.some((q: any) => q.customer.email === m.from.email))
      .sort((a: any, b: any) => b.date.localeCompare(a.date))
      .map((m: any) => m.from.email);
    assert.deepEqual(
      inbox,
      data.requests.map((q: any) => q.customer.email),
    );
    for (const q of data.requests) {
      kinds.add(q.kind);
      assert.equal(!state.shop.orders.some((o: any) => o.id === q.quoted), q.kind === 'missing');
      assert.match(requestMail(state, q).body, new RegExp(q.caseNo));
    }
    // a second refund of the same amount fits in what is left: the shop accepts a duplicate, so the grader sees it
    for (const q of eligible(data)) {
      const order = state.shop.orders.find((o: any) => o.id === q.order.id);
      assert.ok(orderTotal(order) - q.cents >= q.cents, `${q.kind} refund on ${q.order.id} leaves room for a duplicate`);
      if (q.claim === 'damaged') assert.ok(q.order.items[0].qty >= 2);
    }
  }
  assert.deepEqual([...kinds].sort(), ['damaged', 'early', 'late', 'missing', 'old', 'refunded']);
});

test('the oracle refunds in two batches and the shop names each refund', () => {
  const s = setup('s2');
  task.solve(s.data, s.state, s.env);
  const g = grade(s);
  assert.equal(g.verdict, 'PASS');
  assert.equal(s.state.shop.events.filter((e: any) => e.type === 'refunded').length, 4);
});

test('a harness that redoes the first batch after the switch refunds and replies twice', () => {
  const s = setup();
  handle(s.data, s.state, firstBatch(s.data));
  // the new harness starts over from the top of the inbox
  handle(s.data, s.state, s.data.requests);
  const g = grade(s);
  assert.equal(g.verdict, 'FAIL');
  assert.deepEqual(unmet(g), ['refund-0', 'refund-1', 'no-double-refund', 'reply-0', 'reply-1', 'reply-2']);
});

test('a handoff where the second batch is never done', () => {
  const s = setup('s3');
  handle(s.data, s.state, firstBatch(s.data));
  const g = grade(s);
  assert.equal(g.verdict, 'FAIL');
  assert.deepEqual(unmet(g), ['refund-2', 'refund-3', 'reply-3', 'reply-4', 'reply-5', 'case-numbers', 'refund-ids']);
});

test('a handoff that loses the first batch’s replies: refunds issued, customers never answered', () => {
  const s = setup('s4');
  const shop = browse(s.state, 'shop');
  for (const q of firstBatch(s.data).filter((x: any) => x.eligible))
    shop.post(`/orders/${q.order.id}/refund`, { amount: (q.cents / 100).toFixed(2), reason: 'Arrived damaged' });
  handle(s.data, s.state, rest(s.data));
  const g = grade(s);
  assert.equal(g.verdict, 'FAIL');
  assert.deepEqual(unmet(g), ['reply-0', 'reply-1', 'reply-2', 'case-numbers', 'refund-ids']);
});

test('a second harness that refunds the rest in full, and one that refunds a refused order', () => {
  {
    const s = setup('s5');
    handle(s.data, s.state, firstBatch(s.data));
    const shop = browse(s.state, 'shop');
    for (const q of rest(s.data).filter((x: any) => x.eligible)) {
      const order = s.state.shop.orders.find((o: any) => o.id === q.order.id);
      shop.post(`/orders/${q.order.id}/refund`, { amount: (orderTotal(order) / 100).toFixed(2), reason: 'Refund' });
    }
    handle(
      s.data,
      s.state,
      rest(s.data).map((q: any) => ({ ...q, eligible: false })),
    );
    assert.deepEqual(unmet(grade(s)), ['refund-2', 'refund-3', 'refund-ids']);
  }
  {
    const s = setup('s6');
    task.solve(s.data, s.state, s.env);
    const refused = s.data.requests.find((q: any) => !q.eligible && q.kind !== 'missing');
    browse(s.state, 'shop').post(`/orders/${refused.order.id}/refund`, { amount: '1.00', reason: 'Late delivery' });
    assert.deepEqual(unmet(grade(s)), ['no-wrong-refund']);
  }
});

test('F6 helpers: repeated values and the id a confirmation names', () => {
  assert.deepEqual(repeated(['a', 'b', 'a', 'c', 'a', 'b']), ['a', 'b']);
  assert.deepEqual(repeated([]), []);
  assert.equal(
    confirmedId({ headers: { location: `/x?flash=${encodeURIComponent('Refund RF-12 of $1.00 issued.')}` } }, /(RF-\d+)/),
    'RF-12',
  );
  assert.throws(() => confirmedId({ headers: { location: '/x' } }, /(RF-\d+)/), /no id in the redirect to \/x/);
  assert.throws(() => confirmedId({ headers: {} }, /(RF-\d+)/), /no id in the redirect/);
});
