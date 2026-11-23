// The F8 tasks (#1381): f8-research-handoff, f8-warehouse-desk and f8-usage-limit pass the audit, and the plausible
// wrong runs (no hand-off, the work done without the peer, a refund done twice after the limit) do not pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse, gradeTask, setupTask as setup, unmet } from './support/mgb-task-kit.ts';

const handoff = await import('../bench/lib/mgb/tasks/f8ResearchHandoff.mjs');
const desk = await import('../bench/lib/mgb/tasks/f8WarehouseDesk.mjs');
const limit = await import('../bench/lib/mgb/tasks/f8UsageLimit.mjs');

test('the F8 tasks set their peers up from the task data', () => {
  const { env, data } = setup(handoff.task);
  const peer = handoff.task.peers?.[0];
  assert.equal(peer?.name, 'Procurement desk');
  assert.match(peer?.prompt(data, env) ?? '', new RegExp(data.costCenter), 'only the peer chat knows the cost center');
  assert.doesNotMatch(handoff.task.prompt(data, env).join('\n'), new RegExp(data.costCenter));
  const d2 = setup(desk.task);
  assert.match(desk.task.peers?.[0].prompt(d2.data, d2.env) ?? '', new RegExp(d2.data.prefix));
  assert.equal(desk.trackingFor('1ZMG42', 'SO-1234'), '1ZMG421234');
  assert.deepEqual(limit.task.columns, ['claude']);
});

test('f8-research-handoff: exactly one vendor fits; filing it yourself or never hearing back fails', () => {
  for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
    const { data } = setup(handoff.task, seed);
    assert.equal(data.vendors.filter((v: any) => handoff.fitOf(v, data)).length, 1, seed);
  }
  // the main chat files the request itself: no hand-off, no reply, no cost center
  const { env, data, state } = setup(handoff.task);
  const v = data.vendors.find((x: any) => x.slug === data.chosen);
  const plan = handoff.fitOf(v, data);
  browse(state, 'vendors').post(`/v/${v.slug}/contact`, {
    company: 'X',
    email: 'x@y.test',
    seats: String(data.seats),
    plan: plan.name,
    billing: 'annual',
    message: data.ref,
  });
  const q = state.vendors.quotes[0];
  browse(state, 'tracker').post('/issues', { title: `Purchase request: ${v.name}`, body: q.id, priority: 'low', labels: 'purchase' });
  assert.deepEqual(unmet(gradeTask({ task: handoff.task, data, state, env })), ['handed-off', 'answered', 'cost-center', 'key-returned']);
  // a quote from a vendor that does not fit, monthly: the quote checks fail
  const w = setup(handoff.task, 's2');
  const other = w.data.vendors.find((x: any) => x.slug !== w.data.chosen);
  handoff.task.solve(w.data, w.state, w.env);
  browse(w.state, 'vendors').post(`/v/${other.slug}/contact`, {
    company: 'X',
    email: 'x@y.test',
    seats: '3',
    plan: 'Starter',
    billing: 'monthly',
    message: 'm',
  });
  assert.deepEqual(unmet(gradeTask({ task: handoff.task, data: w.data, state: w.state, env: w.env })), ['no-other-quotes']);
});

test('f8-warehouse-desk: shipping yourself with a guessed format, shipping the unpaid order, or double replies fail', () => {
  const { env, data, state } = setup(desk.task);
  for (const o of data.waiting) browse(state, 'shop').post(`/orders/${o.id}/ship`, { tracking: `TRK-${o.id}` });
  const g = gradeTask({ task: desk.task, data, state, env });
  assert.deepEqual(unmet(g), [
    'shipped-0',
    'shipped-1',
    'shipped-2',
    'shipped-3',
    'tracking-format',
    'asked-desk',
    'desk-replied',
    'told-0',
    'told-1',
    'told-2',
    'told-3',
    'pending-told',
  ]);
  const w = setup(desk.task, 's2');
  desk.task.solve(w.data, w.state, w.env);
  browse(w.state, 'shop').post(`/orders/${w.data.pending.id}/ship`, { tracking: 'X' });
  const o = w.data.waiting[0];
  browse(w.state, 'mail').post('/compose', { to: o.customer.email, subject: 'again', body: desk.trackingFor(w.data.prefix, o.id) });
  assert.deepEqual(unmet(gradeTask({ task: desk.task, data: w.data, state: w.state, env: w.env })), ['pending-kept', 'told-0']);
});

test('f8-usage-limit: a refund redone after the limit, silence about the limit, or no limit at all fail', () => {
  const { env, data, state } = setup(limit.task);
  limit.task.solve(data, state, env);
  // the run resumed and refunded the first order again
  const a = data.approved[0];
  browse(state, 'shop').post(`/orders/${a.order}/refund`, { amount: '1.00', reason: 'goodwill' });
  assert.deepEqual(unmet(gradeTask({ task: limit.task, data, state, env })), ['refund-0', 'reply']);
  const quiet = setup(limit.task, 's2');
  limit.task.solve(quiet.data, quiet.state, quiet.env);
  quiet.state.run = { limitedAt: 5 };
  assert.deepEqual(unmet(gradeTask({ task: limit.task, data: quiet.data, state: quiet.state, env: quiet.env })), ['limit-told']);
  delete quiet.state.run;
  assert.deepEqual(unmet(gradeTask({ task: limit.task, data: quiet.data, state: quiet.state, env: quiet.env })), [
    'limit-hit',
    'limit-told',
  ]);
});
