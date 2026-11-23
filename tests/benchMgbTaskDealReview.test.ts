// MGB task f1-deal-review (#1381): beside the audit (benchMgbAudit.test.ts), its minutes mix amounts in words and percentages
// with computed close dates among similar deal names, and plausible wrong solutions (the old minutes' legal owner,
// relative amounts ignored, a calendar month end, a sibling deal edited, no meeting code, a duplicate issue) fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse, gradeTask, setupTask, unmet } from './support/mgb-task-kit.ts';

const { lastBusinessDayOfNextMonth, task } = await import('../bench/lib/mgb/tasks/f1DealReview.mjs');

const setup = (seed = 's1', today?: string) => setupTask(task, seed, today ? { today } : {});
const deal = (state: any, name: string) => state.crm.deals.find((x: any) => x.name === name);

/** Applies the minutes like the oracle, with `edit` changing what is written for each reviewed deal. */
function apply(
  data: any,
  state: any,
  edit: (t: any) => Partial<{ stage: string; cents: number; close: string; note: string }> = () => ({}),
) {
  const crm = browse(state, 'crm');
  for (const t of data.targets) {
    const d = deal(state, t.name);
    const v = { stage: t.newStage, cents: t.newCents, close: t.newClose, note: `${data.code} ${t.note}`, ...edit(t) };
    crm.post(`/deals/${d.id}`, {
      name: d.name,
      accountId: d.accountId,
      stage: v.stage,
      amount: (v.cents / 100).toFixed(2),
      closeDate: v.close,
    });
    crm.post(`/deals/${d.id}/notes`, { note: v.note });
  }
}
const fileLegal = (data: any, state: any, assignee: string, times = 1) => {
  const tracker = browse(state, 'tracker');
  for (const k of data.legalDeals)
    for (let n = 0; n < times; n++) tracker.post('/issues', { title: `Legal review: ${data.targets[k].name}`, priority: 'high', assignee });
};

test('the last business day of next month skips a weekend month end', () => {
  assert.equal(lastBusinessDayOfNextMonth('2026-10-19'), '2026-11-30');
  assert.equal(lastBusinessDayOfNextMonth('2026-09-14'), '2026-10-30');
  assert.equal(lastBusinessDayOfNextMonth('2026-12-03'), '2027-01-29');
  assert.equal(lastBusinessDayOfNextMonth('2027-01-20'), '2027-02-26');
});

test('the data: fifteen deals, six reviewed, each changing stage, amount and close date', () => {
  const { data, state } = setup();
  assert.equal(state.crm.deals.length, 15);
  assert.equal(new Set(state.crm.deals.map((x: any) => x.name)).size, 15);
  for (const t of data.targets) {
    assert.notEqual(t.newStage, t.stage);
    assert.notEqual(t.newCents, t.amountCents);
    assert.notEqual(t.newClose, t.closeDate);
  }
  // three reviewed deals share their account and a topic word with a sibling deal
  for (const t of data.targets.slice(0, 3)) assert.ok(deal(state, t.sibling));
  const minutes = state.docs.pages.find((p: any) => p.title === `Pipeline review — ${data.review}`);
  assert.ok(minutes.body.includes(data.code));
  assert.match(minutes.body, /thousand dollars/);
  assert.match(minutes.body, /% /);
  assert.equal(minutes.body.match(/Needs legal review/g).length, 2);
});

test('plausible wrong solutions do not pass', () => {
  // the old minutes name the colleague now on leave: both legal issues go to the wrong person
  {
    const { env, data, state } = setup();
    apply(data, state);
    fileLegal(data, state, data.away.name);
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['legal-0-assignee', 'legal-1-assignee']);
    assert.equal(g.verdict, 'FAIL');
  }
  // relative amounts left as they are, and a sibling deal edited by mistake
  {
    const { env, data, state } = setup('s2');
    apply(data, state, (t) => (/% /.test(t.amountText) ? { cents: t.amountCents } : {}));
    fileLegal(data, state, data.legal.name);
    const sib = deal(state, data.targets[0].sibling);
    browse(state, 'crm').post(`/deals/${sib.id}/notes`, { note: `${data.code} wrong deal` });
    const g = gradeTask({ task, data, state, env });
    const relative = data.targets.flatMap((t: any, k: number) => (/% /.test(t.amountText) ? [`deal-${k}-amount`] : []));
    assert.equal(relative.length, 3);
    assert.deepEqual(unmet(g), [...relative, 'others-untouched']);
  }
  // in a month that ends on a Saturday, the calendar month end is not a business day
  {
    const { env, data, state } = setup('s3', '2026-09-14');
    apply(data, state, (t) => (t.closeText.includes('business day') ? { close: '2026-10-31' } : {}));
    fileLegal(data, state, data.legal.name);
    const g = gradeTask({ task, data, state, env });
    const monthEnd = data.targets.flatMap((t: any, k: number) => (t.closeText.includes('business day') ? [`deal-${k}-close`] : []));
    assert.equal(monthEnd.length, 3);
    assert.deepEqual(unmet(g), monthEnd);
  }
  // notes without the meeting code, and every legal issue filed twice
  {
    const { env, data, state } = setup('s4');
    apply(data, state, (t) => ({ note: t.note }));
    fileLegal(data, state, data.legal.name, 2);
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['meeting-code', 'legal-0', 'legal-1']);
  }
  // a legal issue for a deal that was not flagged; a renamed deal is unmet, not a crash
  {
    const { env, data, state } = setup('s5');
    task.solve(data, state, env);
    const unflagged = data.targets.find((_: any, k: number) => !data.legalDeals.includes(k));
    browse(state, 'tracker').post('/issues', { title: `Legal review: ${unflagged.name}`, priority: 'low' });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['legal-only']);
    const d = deal(state, data.targets[5].name);
    browse(state, 'crm').post(`/deals/${d.id}`, {
      name: 'Renamed',
      accountId: d.accountId,
      stage: d.stage,
      amount: '1.00',
      closeDate: d.closeDate,
    });
    const renamed = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(renamed), ['deal-5-stage', 'deal-5-amount', 'deal-5-close', 'meeting-code', 'legal-only', 'others-untouched']);
  }
});
