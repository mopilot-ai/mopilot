// MGB task f1-restock-orders (#1381): beside the audit (benchMgbAudit.test.ts), its stock always has six low products across
// three suppliers plus near misses at exactly 5, and plausible wrong solutions (minimum order ignored, a near miss
// ordered, the archived PO prefix, no copy to purchasing, a split order, mail to the idle supplier) do not pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse, gradeTask, setupTask, unmet } from './support/mgb-task-kit.ts';

const { task } = await import('../bench/lib/mgb/tasks/f1RestockOrders.mjs');

const setup = (seed = 's1') => setupTask(task, seed);
const stockOf = (data: any, sku: string) => data.products.find((p: any) => p.sku === sku).stock;

/** Sends one order per low-stock supplier; `qty`, `prefix`, `cc` and `extra` change what a wrong solution writes. */
function order(
  data: any,
  state: any,
  env: any,
  o: { qty?: (l: any) => number; prefix?: (s: any) => string; cc?: string; extra?: (k: number) => string[] } = {},
) {
  const mail = browse(state, 'mail');
  data.suppliers.slice(0, 3).forEach((s: any, k: number) => {
    const po = `${o.prefix ? o.prefix(s) : s.prefix}-${env.today.replaceAll('-', '')}`;
    const lines = data.lines.filter((l: any) => l.supplier === k).map((l: any) => `${l.sku} x ${o.qty ? o.qty(l) : l.qty}`);
    mail.post('/compose', {
      to: s.email,
      cc: o.cc ?? data.purchasing,
      subject: `PO ${po}`,
      body: [...lines, ...(o.extra ? o.extra(k) : [])].join('\n'),
    });
  });
}

test('the data: six low products over three suppliers, near misses at 5, and both sizing rules in play', () => {
  const { data, state } = setup();
  assert.equal(state.shop.products.filter((p: any) => p.stock < 5).length, 6);
  assert.equal(state.shop.products.filter((p: any) => p.stock === 5).length, 3);
  assert.deepEqual(
    data.lines.map((l: any) => l.supplier),
    [0, 0, 1, 1, 2, 2],
  );
  const s = data.suppliers;
  // the first supplier's minimum wins; the others order up to target
  for (const l of data.lines) {
    const need = s[l.supplier].target - stockOf(data, l.sku);
    assert.equal(l.qty, l.supplier === 0 ? s[0].moq : need);
    assert.ok(l.supplier === 0 ? need < s[0].moq : need > s[l.supplier].moq);
  }
  // the idle supplier only has a near miss, never a low product
  assert.ok(state.shop.products.filter((p: any) => p.supplierId === s[3].id).every((p: any) => p.stock >= 5));
  const terms = state.docs.pages.find((p: any) => p.title === 'Supplier terms');
  for (const x of s) assert.ok(terms.body.includes(x.prefix));
});

test('plausible wrong solutions do not pass', () => {
  // the minimum order quantity ignored: the first supplier's two lines are short
  {
    const { env, data, state } = setup();
    order(data, state, env, { qty: (l) => data.suppliers[l.supplier].target - stockOf(data, l.sku) });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['qty-0', 'qty-1']);
    assert.equal(g.verdict, 'FAIL');
  }
  // a near miss at exactly 5 ordered too
  {
    const { env, data, state } = setup('s2');
    const near = data.products.find((p: any) => p.stock === 5 && p.supplierId === data.suppliers[0].id);
    order(data, state, env, { extra: (k) => (k === 0 ? [`${near.sku} x ${data.suppliers[0].moq}`] : []) });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['no-near-miss']);
    assert.equal(g.verdict, 'FAIL');
  }
  // the archived terms' PO prefix, copied to the old orders inbox
  {
    const { env, data, state } = setup('s3');
    order(data, state, env, { prefix: (s) => s.oldPrefix, cc: `orders@${data.domain}` });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['cc-purchasing', 'po-number']);
  }
  // one supplier's order split over two emails, and a note to the supplier with no low stock
  {
    const { env, data, state } = setup('s4');
    task.solve(data, state, env);
    const mail = browse(state, 'mail');
    mail.post('/compose', { to: data.suppliers[0].email, cc: data.purchasing, subject: 'Forgot one', body: data.lines[0].sku });
    mail.post('/compose', { to: data.suppliers[3].email, subject: 'Nothing this week', body: 'No order from you this week.' });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['po-0', 'no-idle-supplier']);
  }
  // a do-nothing agent keeps only the negative checks
  {
    const { env, data, state } = setup('s5');
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.ok(g.score <= 0.25);
  }
});
