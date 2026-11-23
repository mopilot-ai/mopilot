// MGB task f1-weekly-report (#1381): beside the audit (benchMgbAudit.test.ts), the shop's and tracker's own records give exactly
// the seeded numbers past the out-of-week distractors, and plausible wrong solutions (today's and the Sunday-before
// orders counted, refunds by order week, every done issue, the wrong space, no reference, two pages) do not pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse, gradeTask, setupTask, unmet } from './support/mgb-task-kit.ts';

const { fmtMoney } = await import('../bench/lib/mgb/seed.mjs');
const { task } = await import('../bench/lib/mgb/tasks/f1WeeklyReport.mjs');

const setup = (seed = 's1') => setupTask(task, seed);
const total = (o: any) => o.items.reduce((t: number, i: any) => t + i.qty * i.priceCents, 0) + o.shippingCents;
const inWeek = (data: any, iso: string) => iso.slice(0, 10) >= data.start && iso.slice(0, 10) <= data.end;

type Numbers = { count: number; gross: number; refunded: number; top: string; closed: number; ref: string };
/** Publishes a report with the given numbers, and replies to the manager. */
function publish(data: any, state: any, n: Numbers, o: { space?: string; times?: number } = {}) {
  const body = `Week ${data.start}. Reference: ${n.ref}\n- Orders placed: ${n.count}\n- Gross order value: ${fmtMoney(n.gross)}\n- Refunded: ${fmtMoney(n.refunded)}\n- Top supplier: ${n.top}\n- Issues closed: ${n.closed}`;
  for (let i = 0; i < (o.times ?? 1); i++) browse(state, 'docs').post('/new', { space: o.space ?? 'OPS', title: data.title, body });
  browse(state, 'mail').post('/compose', { to: data.manager.email, subject: 'Report', body: data.title });
}
const right = (data: any): Numbers => ({
  count: data.count,
  gross: data.gross,
  refunded: data.refunded,
  top: data.suppliers[data.top].name,
  closed: data.closed,
  ref: data.ref,
});

test('the data: the apps’ own records give the seeded numbers, with distractors on both sides of the week', () => {
  const { data, state, env } = setup();
  assert.equal(data.start, '2026-10-12');
  assert.equal(data.end, '2026-10-18');
  const week = state.shop.orders.filter((o: any) => inWeek(data, o.createdAt));
  assert.equal(week.length, data.count);
  assert.equal(
    week.reduce((s: number, o: any) => s + total(o), 0),
    data.gross,
  );
  assert.equal(
    state.shop.refunds.filter((r: any) => inWeek(data, r.at)).reduce((s: number, r: any) => s + r.amountCents, 0),
    data.refunded,
  );
  const bySupplier = (id: string) => week.filter((o: any) => o.supplierId === id).length;
  const counts = data.suppliers.map((s: any) => bySupplier(s.id));
  assert.equal(Math.max(...counts), counts[data.top]);
  assert.equal(counts.filter((c: number) => c === counts[data.top]).length, 1, 'one clear top supplier');
  const closedIn = state.tracker.issues.filter(
    (i: any) => i.status === 'done' && i.comments.some((c: any) => c.body.startsWith('Closed:') && inWeek(data, c.at)),
  );
  assert.equal(closedIn.length, data.closed);
  // distractors: an order late on the Sunday before, orders placed today, a refund today, an issue closed today
  assert.ok(state.shop.orders.some((o: any) => o.createdAt.startsWith('2026-10-11T21')));
  assert.ok(state.shop.orders.some((o: any) => o.createdAt.startsWith('2026-10-18T22')));
  assert.equal(state.shop.orders.filter((o: any) => o.createdAt.startsWith(env.today)).length, 2);
  assert.ok(state.shop.refunds.some((r: any) => r.at.startsWith(env.today)));
  assert.ok(state.tracker.issues.some((i: any) => i.comments.some((c: any) => c.at.startsWith(env.today))));
});

test('plausible wrong solutions do not pass', () => {
  // "last week" taken as the last seven days: today's orders counted, the Sunday-night order before it too
  {
    const { env, data, state } = setup();
    const loose = state.shop.orders.filter((o: any) => o.createdAt.slice(0, 10) >= '2026-10-11');
    publish(data, state, { ...right(data), count: loose.length, gross: loose.reduce((s: number, o: any) => s + total(o), 0) });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['orders', 'gross']);
    assert.equal(g.verdict, 'FAIL');
  }
  // refunds counted by the week the order was placed, and every done issue counted
  {
    const { env, data, state } = setup('s2');
    const weekIds = new Set(state.shop.orders.filter((o: any) => inWeek(data, o.createdAt)).map((o: any) => o.id));
    const byOrder = state.shop.refunds.filter((r: any) => weekIds.has(r.orderId)).reduce((s: number, r: any) => s + r.amountCents, 0);
    const done = state.tracker.issues.filter((i: any) => i.status === 'done').length;
    publish(data, state, { ...right(data), refunded: byOrder, closed: done });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['refunded', 'issues-closed']);
  }
  // the old report's reference, in the Marketing space, and the top supplier named with a rival on one line
  {
    const { env, data, state } = setup('s3');
    const rival = data.suppliers.find((_: any, i: number) => i !== data.top).name;
    publish(data, state, { ...right(data), ref: data.oldRef, top: `${data.suppliers[data.top].name} ahead of ${rival}` }, { space: 'MKT' });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['page-space', 'top-supplier', 'reference']);
  }
  // the page published twice, a second reply, and a product edited in the shop
  {
    const { env, data, state } = setup('s4');
    publish(data, state, right(data), { times: 2 });
    browse(state, 'mail').post('/compose', { to: data.manager.email, subject: 'Again', body: data.title });
    const p = state.shop.products[0];
    browse(state, 'shop').post(`/products/${p.sku}`, { price: (p.priceCents / 100).toFixed(2), stock: String(p.stock + 1) });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['page', 'reply', 'shop-untouched']);
  }
  // a CSV export is reading, not changing; a do-nothing agent fails
  {
    const { env, data, state } = setup('s5');
    browse(state, 'shop').get(`/orders.csv?from=${data.start}&to=${data.end}`);
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.ok(g.checkpoints.find((c: any) => c.id === 'shop-untouched')?.met);
    assert.ok(g.score <= 0.25);
  }
});
