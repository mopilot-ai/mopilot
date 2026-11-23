// MGB task f2-expense-report (#1381): beside the audit (benchMgbAudit.test.ts), the receipts are real PDFs and a valid PNG, the
// claim applies the meal cap and the alcohol exclusion, and plausible wrong agents fail on exactly what they missed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { browse, gradeTask, setupTask, unmet } from './support/mgb-task-kit.ts';

const { fmtMoney } = await import('../bench/lib/mgb/seed.mjs');
const { bodyBytes, monthName, pdfTextOf, putFile } = await import('../bench/lib/mgb/tasks/f2Common.mjs');
const { COLUMNS, POLICY, csvName, issueTitle, task } = await import('../bench/lib/mgb/tasks/f2ExpenseReport.mjs');

const setup = (seed = 's1') => setupTask(task, seed);
const kind = (data: any, k: string) => data.receipts.find((rc: any) => rc.kind === k);

type Wrong = {
  claim?: (rc: any) => number;
  attach?: (rc: any) => boolean;
  folder?: string;
  costCenter?: boolean;
  merchant?: (m: string) => string;
};
/** A whole run with one mistake or another: what each receipt is claimed at, which are attached, where they go. */
function agent(data: any, state: any, o: Wrong = {}) {
  const claimed = o.claim ?? ((rc: any) => rc.claimed);
  const attach = o.attach ?? ((rc: any) => rc.claimed > 0);
  const files: any[] = [];
  for (const rc of data.receipts) {
    const msg = state.mail.messages.find((m: any) => m.attachments[0]?.name === rc.name);
    const bytes = bodyBytes(browse(state, 'mail').get(`/m/${msg.id}/att/0`));
    putFile(state, `${o.folder ?? 'receipts/'}${rc.name}`, bytes);
    if (attach(rc)) files.push({ field: 'attach', name: rc.name, type: rc.type, content: bytes });
  }
  const total = data.receipts.reduce((t: number, rc: any) => t + claimed(rc), 0);
  const body = `Total ${fmtMoney(total)}${o.costCenter === false ? '' : `, cost center ${data.costCenter}`}`;
  browse(state, 'tracker').post('/issues', { fields: { title: issueTitle(data), body, priority: 'medium' }, files });
  const rows = data.receipts.map(
    (rc: any) => `${rc.date},${(o.merchant ?? ((m: string) => m))(rc.merchant)},${fmtMoney(rc.cents)},${(claimed(rc) / 100).toFixed(2)}`,
  );
  putFile(state, csvName(data), Buffer.from(`${COLUMNS.join(',')}\r\n${rows.join('\r\n')}\r\n`, 'utf8'));
  return state;
}

test('the data: last month’s five receipts, one over the meal cap, one alcohol, one photo', () => {
  const { env, data, state } = setup();
  assert.equal(data.month, '2026-09');
  assert.equal(monthName(data.month), 'September 2026');
  assert.equal(issueTitle(data), 'Expenses September 2026');
  assert.equal(data.receipts.length, 5);
  for (const rc of data.receipts) assert.ok(rc.date.startsWith('2026-09-'));
  assert.ok(kind(data, 'meal-over').cents > data.capCents && kind(data, 'meal-over').claimed === data.capCents);
  assert.ok(kind(data, 'meal-under').cents < data.capCents);
  assert.equal(kind(data, 'alcohol').claimed, 0);
  const sum = data.receipts.reduce((t: number, rc: any) => t + rc.claimed, 0);
  assert.equal(data.totalCents, sum);
  for (const rc of data.receipts.filter((x: any) => x.kind !== 'taxi')) {
    assert.ok(pdfTextOf(rc.base64).includes(`Total: ${fmtMoney(rc.cents)}`), 'the amount is inside the PDF');
    assert.ok(!state.mail.messages.some((m: any) => m.body.includes(fmtMoney(rc.cents))), 'and nowhere else');
  }
  const png = Buffer.from(kind(data, 'taxi').base64, 'base64');
  assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG');
  assert.equal(png.readUInt32BE(16), 24);
  const policy = state.docs.pages.find((p: any) => p.title === POLICY).body;
  assert.ok(policy.includes(data.costCenter) && policy.includes(fmtMoney(data.capCents)));
  assert.ok(!task.prompt(data, env).join('\n').includes(data.costCenter));
});

test('the agent helper matches the oracle, and a shortened merchant name in the CSV still counts', () => {
  const { env, data, state } = setup('s2');
  agent(data, state, { merchant: (m) => m.split(' ').slice(-1)[0] });
  assert.equal(gradeTask({ task, data, state, env }).verdict, 'PASS');
});

test('plausible wrong agents do not pass', () => {
  // the wine bar claimed too: attached, in the total and in the CSV
  {
    const { env, data, state } = setup();
    agent(data, state, { claim: (rc) => (rc.kind === 'alcohol' ? rc.cents : rc.claimed), attach: () => true });
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.deepEqual(unmet(g), ['issue-no-alcohol', 'issue-total', 'csv-rows']);
  }
  // the meal claimed in full, over the cap
  {
    const { env, data, state } = setup('s2');
    agent(data, state, { claim: (rc) => (rc.kind === 'meal-over' ? rc.cents : rc.claimed) });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['issue-total', 'csv-rows']);
  }
  // the photo receipt not attached, and the receipts left loose in the folder
  {
    const { env, data, state } = setup('s3');
    agent(data, state, { attach: (rc) => rc.claimed > 0 && rc.kind !== 'taxi', folder: '' });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['issue-receipts', 'receipts-filed']);
  }
  // no cost-center code: the canary misses
  {
    const { env, data, state } = setup();
    agent(data, state, { costCenter: false });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['cost-center']);
    assert.equal(g.verdict, 'FAIL');
  }
  // two claim issues: neither is "the" claim
  {
    const { env, data, state } = setup('s2');
    agent(data, state);
    agent(data, state);
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), [
      'issue',
      'issue-receipts',
      'issue-no-alcohol',
      'issue-total',
      'cost-center',
    ]);
  }
});
