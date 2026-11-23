// MGB task f1-invoice-reconcile (#1381): beside the audit (benchMgbAudit.test.ts), its oracle solves it through the apps' own
// routes, and the plausible wrong solutions (every invoice disputed, no screenshot, no dispute code) do not pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse, gradeTask, setupTask, unmet } from './support/mgb-task-kit.ts';

const { task } = await import('../bench/lib/mgb/tasks/f1InvoiceReconcile.mjs');

const setup = (seed = 's1') => setupTask(task, seed);

test('the task names a window every invoice is in: the last 7 days, not "this week" (#3571)', () => {
  for (const seed of ['s1', 's2', 's3', 's4']) {
    const { env, data, state } = setup(seed);
    const [first] = task.prompt(data, env);
    assert.match(first, /invoices over the last 7 days/);
    assert.doesNotMatch(first, /this week/i);
    // the invoice mails say nothing about a calendar week either, and each is dated 1 to 6 days before the fixture's today
    const mails = state.mail.messages.filter((m: any) => /^Invoice INV-/.test(m.subject));
    assert.equal(mails.length, 7);
    for (const m of mails) {
      assert.doesNotMatch(m.body, /this week/i);
      const days = (Date.parse(`${env.today}T12:00:00Z`) - Date.parse(m.date)) / 86_400_000;
      assert.ok(days > 0 && days < 7, `${m.subject} is ${days.toFixed(1)} days old`);
    }
  }
});

test('the data: seven invoices from one supplier, two of them wrong in different ways', () => {
  const { data, state } = setup();
  assert.equal(data.invoices.length, 7);
  const [a, b] = data.disputed;
  assert.notEqual(a.number, b.number);
  for (const inv of data.disputed) assert.notEqual(inv.totalCents, inv.expectedCents);
  for (const inv of data.invoices.filter((i: any) => !data.disputed.includes(i))) assert.equal(inv.totalCents, inv.expectedCents);
  // the shop's own totals are what an invoice is checked against
  const shopTotals = Object.fromEntries(
    state.shop.orders.map((o: any) => [o.id, o.items.reduce((t: number, i: any) => t + i.qty * i.priceCents, 0) + o.shippingCents]),
  );
  for (const inv of data.invoices) assert.equal(shopTotals[inv.order], inv.expectedCents);
  assert.equal(state.mail.messages.filter((m: any) => /^Invoice INV-/.test(m.subject)).length, 7);
  assert.ok(
    state.mail.messages.some((m: any) => m.body.includes(data.disputeCode)),
    'the dispute code is in the inbox, not the prompt',
  );
});

test('plausible wrong solutions do not pass', () => {
  const png = { field: 'attach', name: 'shot.png', type: 'image/png', content: Buffer.from([0x89, 0x50, 0x4e, 0x47]) };
  // disputing invoices that match is wrong work: a fail, though most of the credit stays
  {
    const { env, data, state } = setup();
    task.solve(data, state, env);
    const tracker = browse(state, 'tracker');
    for (const inv of data.invoices.filter((i: any) => !data.disputed.includes(i))) {
      tracker.post('/issues', {
        fields: { title: `Invoice mismatch: ${inv.number}`, body: `Order ${inv.order}`, priority: 'medium' },
        files: [png],
      });
    }
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.deepEqual(unmet(g), ['no-false-issue']);
    assert.ok(g.score < 1);
  }
  // no screenshot and no dispute code: fails on both
  {
    const { env, data, state } = setup('s2');
    const tracker = browse(state, 'tracker');
    for (const inv of data.disputed)
      tracker.post('/issues', {
        title: `Invoice mismatch: ${inv.number}`,
        body: `Order ${inv.order}`,
        priority: 'medium',
        labels: 'invoice',
      });
    browse(state, 'mail').post('/compose', {
      to: data.supplier.contact.email,
      subject: data.disputed.map((i: any) => i.number).join(' '),
      body: 'Please check.',
    });
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.deepEqual(unmet(g), ['issue-0-amounts', 'issue-0-shot', 'issue-1-amounts', 'issue-1-shot', 'dispute-code', 'labels']);
  }
  // two summary emails: "one summary" fails; refunding an order: shop-untouched fails
  {
    const { env, data, state } = setup('s3');
    task.solve(data, state, env);
    const mail = browse(state, 'mail');
    mail.post('/compose', {
      to: data.supplier.contact.email,
      subject: data.disputed.map((i: any) => i.number).join(' '),
      body: data.disputeCode,
    });
    browse(state, 'shop').post(`/orders/${data.disputed[0].order}/refund`, { amount: '1.00', reason: 'overcharge' });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['summary', 'shop-untouched']);
    assert.equal(g.verdict, 'FAIL');
  }
});
