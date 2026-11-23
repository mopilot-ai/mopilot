// MGB task f1-refund-requests (#1381): beside the audit (benchMgbAudit.test.ts), its data always holds three qualifying and two
// refused requests, and plausible wrong solutions (refunding a refused order, the wrong amount, a split refund, replies
// without case or refund numbers, a duplicate reply) do not pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse, gradeTask, setupTask, unmet } from './support/mgb-task-kit.ts';

const { task } = await import('../bench/lib/mgb/tasks/f1RefundRequests.mjs');

const setup = (seed = 's1') => setupTask(task, seed);
const eligible = (data: any) => data.requests.filter((q: any) => q.eligible);
const inboxOf = (state: any, q: any) => state.mail.messages.find((m: any) => m.folder === 'inbox' && m.from.email === q.customer.email);

test('the data: three requests qualify and two are refused, each for its own reason the shop shows', () => {
  const kinds = new Set<string>();
  for (let n = 0; n < 12; n++) {
    const { data, state } = setup(`kinds-${n}`);
    assert.equal(data.requests.length, 5);
    assert.equal(eligible(data).length, 3);
    const refused = data.requests.filter((q: any) => !q.eligible).map((q: any) => q.kind);
    assert.equal(new Set(refused).size, 2, 'the two refused requests differ in why');
    for (const q of data.requests) {
      kinds.add(q.kind);
      const order = state.shop.orders.find((o: any) => o.id === q.quoted);
      assert.equal(!order, q.kind === 'missing', 'only a missing order is absent from the shop');
      assert.match(state.mail.messages.find((m: any) => m.from.email === q.customer.email).body, new RegExp(q.caseNo));
    }
    // a late refund is half the items, never shipping; a damaged one the whole total
    for (const q of eligible(data)) {
      const items = q.order.items.reduce((t: number, i: any) => t + i.qty * i.priceCents, 0);
      assert.equal(q.cents, q.claim === 'late' ? Math.floor(items / 2) : items + q.order.shippingCents);
    }
  }
  assert.deepEqual([...kinds].sort(), ['damaged', 'early', 'late', 'missing', 'old', 'refunded']);
});

test('plausible wrong solutions do not pass', () => {
  // refunding a request the policy refuses: everything else right, still a fail
  {
    const { env, data, state } = setup();
    task.solve(data, state, env);
    const refused = data.requests.find((q: any) => !q.eligible && q.kind !== 'missing');
    browse(state, 'shop').post(`/orders/${refused.order.id}/refund`, { amount: '1.00', reason: 'Late delivery' });
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.deepEqual(unmet(g), ['no-wrong-refund']);
  }
  // refunding every late order in full: the late ones get the wrong amount
  {
    const { env, data, state } = setup('s2');
    const shop = browse(state, 'shop');
    const total = (o: any) => o.items.reduce((t: number, i: any) => t + i.qty * i.priceCents, 0) + o.shippingCents;
    for (const q of eligible(data))
      shop.post(`/orders/${q.order.id}/refund`, { amount: (total(q.order) / 100).toFixed(2), reason: q.claim });
    const g = gradeTask({ task, data, state, env });
    const late = eligible(data).flatMap((q: any, k: number) => (q.claim === 'late' ? [`refund-${k}`] : []));
    assert.ok(late.length > 0);
    assert.deepEqual(
      unmet(g).filter((id: string) => id.startsWith('refund-') && !id.startsWith('refund-id')),
      late,
    );
    assert.equal(g.verdict, 'FAIL');
  }
  // right refunds, but fresh emails that quote neither the case nor the refund number
  {
    const { env, data, state } = setup('s3');
    const shop = browse(state, 'shop');
    const mail = browse(state, 'mail');
    for (const q of eligible(data)) shop.post(`/orders/${q.order.id}/refund`, { amount: (q.cents / 100).toFixed(2), reason: q.claim });
    for (const q of data.requests)
      mail.post('/compose', { to: q.customer.email, subject: 'Your refund request', body: 'We have looked into your request.' });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['case-numbers', 'refund-id-0', 'refund-id-1', 'refund-id-2']);
  }
  // the first qualifying refund split in two, and a second reply to the first requester
  {
    const { env, data, state } = setup('s4');
    const shop = browse(state, 'shop');
    const mail = browse(state, 'mail');
    for (const [k, q] of eligible(data).entries()) {
      const parts = k === 0 ? [Math.floor(q.cents / 2), q.cents - Math.floor(q.cents / 2)] : [q.cents];
      for (const cents of parts) shop.post(`/orders/${q.order.id}/refund`, { amount: (cents / 100).toFixed(2), reason: q.claim });
    }
    for (const q of data.requests) {
      const ids = state.shop.refunds.filter((x: any) => x.orderId === q.order.id).map((x: any) => x.id);
      mail.post('/compose', {
        to: q.customer.email,
        subject: 'Re: your request',
        body: `Case ${q.caseNo}. Refunds: ${ids.join(', ') || 'none'}`,
        reply: inboxOf(state, q).id,
      });
    }
    const first = data.requests[0];
    mail.post('/compose', { to: first.customer.email, subject: 'One more thing', body: first.caseNo, reply: inboxOf(state, first).id });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['refund-0', 'reply-0']);
    assert.equal(g.verdict, 'FAIL');
  }
  // nothing done at all scores at most the negative check
  {
    const { env, data, state } = setup('s5');
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.ok(g.score <= 0.25);
  }
});
