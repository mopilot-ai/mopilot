// MGB task f6-tracker-migration (#1381): beside the audit (benchMgbAudit.test.ts), each half of the meeting's ten items has
// two customer items and one named owner, and plausible wrong handoffs (the new harness refiling items 1-5, items
// 6-10 never filed, the first half's CRM notes lost, a checklist comment with only the new harness's keys) fail.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gradeTask, setupTask, unmet } from './support/mgb-task-kit.ts';

const { FIRST, closeChecklist, customerItems, file, issuesFor, task } = await import('../bench/lib/mgb/tasks/f6TrackerMigration.mjs');

const setup = (seed = 's1') => setupTask(task, seed);
const grade = ({ env, data, state }: any) => gradeTask({ task, data, state, env });
const firstHalf = (data: any) => data.items.slice(0, FIRST);
const rest = (data: any) => data.items.slice(FIRST);

test('f6-tracker-migration runs only in the switch column', () => {
  assert.deepEqual(task.columns, ['switch']);
  assert.equal(task.family, 'F6');
  const { data, env } = setup();
  assert.equal(task.prompt(data, env).length, 4);
  assert.equal(task.switchBefore, 2);
});

test('the data: two customer items and one named owner per half, rules and checklist on the page', () => {
  for (let n = 0; n < 10; n++) {
    const { data, state } = setup(`items-${n}`);
    assert.equal(data.items.length, 10);
    assert.equal(new Set(data.items.map((it: any) => it.base)).size, 10);
    for (const half of [firstHalf(data), rest(data)]) {
      assert.equal(half.filter((it: any) => it.customer).length, 2);
      const named = half.filter((it: any) => it.named);
      assert.equal(named.length, 1);
      assert.notEqual(named[0].assignee, data.owners[named[0].area], 'the named owner overrides the area owner');
    }
    assert.equal(new Set(customerItems(data).map((it: any) => it.customer.name)).size, 4, 'one item per customer');
    for (const it of data.items) {
      assert.deepEqual(it.labels, [it.area.toLowerCase(), ...(it.customer ? ['customer'] : [])]);
      if (!it.named) assert.equal(it.assignee, data.owners[it.area]);
      assert.ok(state.tracker.members.includes(it.assignee));
    }
    const page = state.docs.pages[0].body;
    assert.match(page, new RegExp(data.code));
    assert.match(page, new RegExp(data.checklistKey));
    for (const it of data.items) assert.ok(page.includes(it.base));
    assert.equal(state.tracker.issues.find((i: any) => i.key === data.checklistKey).status, 'todo');
    for (const c of data.customers) assert.equal(state.crm.deals.find((x: any) => x.id === c.openDeal).stage, 'negotiation');
  }
});

test('the oracle files both halves, notes every customer deal once and closes the checklist', () => {
  const s = setup('s2');
  task.solve(s.data, s.state, s.env);
  assert.equal(grade(s).verdict, 'PASS');
  for (const it of s.data.items) assert.equal(issuesFor(s.state, it).length, 1);
});

test('a harness that refiles items 1 to 5 after the switch makes duplicate issues and notes', () => {
  const s = setup();
  file(s.data, s.state, firstHalf(s.data));
  const keys = file(s.data, s.state, s.data.items);
  closeChecklist(s.data, s.state, keys);
  const g = grade(s);
  assert.equal(g.verdict, 'FAIL');
  assert.deepEqual(unmet(g), ['issue-1', 'issue-2', 'issue-3', 'issue-4', 'issue-5', 'note-0', 'note-1']);
});

test('a handoff where items 6 to 10 are never filed', () => {
  const s = setup('s3');
  file(s.data, s.state, firstHalf(s.data));
  const g = grade(s);
  assert.equal(g.verdict, 'FAIL');
  assert.deepEqual(unmet(g), [
    'issue-6',
    'issue-7',
    'issue-8',
    'issue-9',
    'issue-10',
    'note-2',
    'note-3',
    'checklist-closed',
    'checklist-keys',
    'meeting-code',
  ]);
});

test('a handoff that loses the first half’s CRM notes', () => {
  const s = setup('s4');
  const keys = [
    ...file(
      s.data,
      s.state,
      firstHalf(s.data).map((it: any) => ({ ...it, customer: null })),
    ),
    ...file(s.data, s.state, rest(s.data)),
  ];
  closeChecklist(s.data, s.state, keys);
  assert.deepEqual(unmet(grade(s)), ['note-0', 'note-1']);
});

test('a checklist comment with only the new harness’s keys, and issues without the page’s rules', () => {
  {
    const s = setup('s5');
    file(s.data, s.state, firstHalf(s.data));
    closeChecklist(s.data, s.state, file(s.data, s.state, rest(s.data)));
    assert.deepEqual(unmet(grade(s)), ['checklist-keys']);
  }
  {
    // the area owner for every item, no customer label and no meeting code
    const s = setup('s6');
    const plain = s.data.items.map((it: any) => ({ ...it, assignee: s.data.owners[it.area], labels: [it.area.toLowerCase()] }));
    closeChecklist(s.data, s.state, file({ ...s.data, code: 'none' }, s.state, plain));
    const wrong = s.data.items.filter((it: any) => it.named || it.customer).map((it: any) => `issue-${it.n}`);
    assert.deepEqual(unmet(grade(s)), [...wrong, 'meeting-code']);
  }
  {
    // an issue for something the meeting never asked for
    const s = setup('s7');
    task.solve(s.data, s.state, s.env);
    file(s.data, s.state, [{ ...s.data.items[0], base: 'Rotate the staging certificates again', customer: null }]);
    assert.deepEqual(unmet(grade(s)), ['no-stray-issue']);
  }
});
