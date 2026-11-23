// MGB task f1-escalations (#1381): beside the audit (benchMgbAudit.test.ts), its four complaints are always two escalations (one
// over the urgent threshold), one delivered order and one someone else's order, and plausible wrong solutions
// (escalating the stranger's order, last week's owner, flat priority, replies without keys or dates) do not pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse, gradeTask, setupTask, unmet } from './support/mgb-task-kit.ts';

const { task } = await import('../bench/lib/mgb/tasks/f1Escalations.mjs');

const setup = (seed = 's1') => setupTask(task, seed);
const role = (data: any, r: string) => data.complaints.filter((c: any) => c.role === r);
const inboxOf = (state: any, c: any) => state.mail.messages.find((m: any) => m.folder === 'inbox' && m.from.email === c.customer.email);
const total = (o: any) => o.items.reduce((t: number, i: any) => t + i.qty * i.priceCents, 0) + o.shippingCents;

/** Files an issue per escalation; `o` changes the owner or the priority. */
function escalate(data: any, state: any, o: { owner?: string; priority?: string } = {}) {
  const tracker = browse(state, 'tracker');
  for (const c of role(data, 'escalate')) {
    tracker.post('/issues', {
      title: `Order ${c.order.id} lost`,
      body: `Tracking ${c.order.tracking}`,
      priority: o.priority ?? c.priority,
      assignee: o.owner ?? data.onDuty,
    });
  }
}
const reply = (state: any, c: any, body: string) =>
  browse(state, 'mail').post('/compose', { to: c.customer.email, subject: 'Re: your order', body, reply: inboxOf(state, c).id });

test('the data: two escalations either side of the threshold, a delivered order and a stranger’s order', () => {
  const { data, state, env } = setup();
  assert.deepEqual(data.complaints.map((c: any) => c.role).sort(), ['delivered', 'escalate', 'escalate', 'mismatch']);
  assert.deepEqual(
    role(data, 'escalate')
      .map((c: any) => c.priority)
      .sort(),
    ['high', 'urgent'],
  );
  for (const c of role(data, 'escalate')) assert.equal(c.priority === 'urgent', total(c.order) > data.threshold);
  // the stranger's order looks like an escalation: shipped long ago, never delivered
  const [mis] = role(data, 'mismatch');
  assert.notEqual(mis.order.customer.email, mis.customer.email);
  assert.equal(state.shop.orders.find((o: any) => o.id === mis.order.id).status, 'shipped');
  assert.ok(mis.order.shipped < env.today);
  // the rota names this ISO week's owner, and the backup is someone else
  const rota = state.docs.pages.find((p: any) => p.title === 'Support rota').body;
  assert.match(rota, new RegExp(`Week ${data.week}: ${data.onDuty} \\(backup (?!${data.onDuty})`));
  assert.equal(data.week, 43);
});

test('plausible wrong solutions do not pass', () => {
  // the stranger's order escalated too: everything else right, still a fail
  {
    const { env, data, state } = setup();
    task.solve(data, state, env);
    const [mis] = role(data, 'mismatch');
    browse(state, 'tracker').post('/issues', {
      title: `Order ${mis.order.id} lost`,
      body: mis.order.tracking,
      priority: 'high',
      assignee: data.onDuty,
    });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['no-false-escalation']);
    assert.equal(g.verdict, 'FAIL');
  }
  // last week's owner and a flat high priority, and no replies yet
  {
    const { env, data, state } = setup('s2');
    escalate(data, state, { owner: data.rota[1].owner, priority: 'high' });
    const g = gradeTask({ task, data, state, env });
    const urgent = role(data, 'escalate').findIndex((c: any) => c.priority === 'urgent');
    const wrongPriority = (k: number) => (k === urgent ? [`esc-${k}-priority`] : []);
    assert.deepEqual(unmet(g), [
      'esc-0-owner',
      ...wrongPriority(0),
      'esc-1-owner',
      ...wrongPriority(1),
      'reply-0',
      'reply-1',
      'reply-2',
      'reply-3',
      'reply-key-0',
      'reply-key-1',
      'delivered-date',
    ]);
    assert.equal(g.verdict, 'FAIL');
  }
  // the right issues, but replies with no issue key, no delivery date, and the stranger's tracking number
  {
    const { env, data, state } = setup('s3');
    escalate(data, state);
    for (const c of data.complaints)
      reply(state, c, c.role === 'mismatch' ? `Your parcel ${c.order.tracking} is on its way.` : 'We are looking into it.');
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['reply-key-0', 'reply-key-1', 'delivered-date', 'no-leak']);
  }
  // the first escalation filed twice, no tracking numbers, and an order cancelled in the shop
  {
    const { env, data, state } = setup('s4');
    const tracker = browse(state, 'tracker');
    const [first] = role(data, 'escalate');
    for (const c of [first, ...role(data, 'escalate')])
      tracker.post('/issues', { title: `Order ${c.order.id} lost`, body: 'Lost in transit.', priority: c.priority, assignee: data.onDuty });
    const paid = state.shop.orders.find((o: any) => o.status === 'paid');
    browse(state, 'shop').post(`/orders/${paid.id}/cancel`);
    for (const c of data.complaints) reply(state, c, `${c.order.delivered} ${state.tracker.issues.map((i: any) => i.key).join(' ')}`);
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['esc-0', 'tracking', 'shop-untouched']);
    assert.equal(g.verdict, 'FAIL');
  }
  // a do-nothing agent keeps only the negative checks
  {
    const { env, data, state } = setup('s5');
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.ok(g.score <= 0.25);
  }
});
