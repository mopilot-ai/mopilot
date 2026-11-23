// MGB task f4-reminder-triage (#1381): audited on every seed, run date and Mac timezone; the rules note's order and
// distractors decide the oracle; and copying instead of moving, UTC times, rules applied out of order, a "done in
// person" item completed and a weekend reschedule do not pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditEnv, auditTask, gradeTask, loadFixtures, setupTask, unmet } from './support/mgb-task-kit.ts';

const { dayOffset } = await import('../bench/lib/mgb/seed.mjs');
const { eventAt, localIso, nextWeekday, noteNamed, remindersIn, weekday } = await import('../bench/lib/mgb/tasks/f4Common.mjs');
const { task } = await import('../bench/lib/mgb/tasks/f4ReminderTriage.mjs');

const WAITING = 'MGB Waiting';
const setup = (seed = 's1', tz = 120, today = '2026-10-19') => setupTask(task, seed, { today, tz });
const solved = (seed?: string, tz?: number, today?: string) => {
  const s = setup(seed, tz, today);
  task.solve(s.data, s.state, s.env);
  return s;
};
const kind = (data: any, k: string) => data.items.filter((x: any) => x.kind === k);
const focus = (state: any) => state.mac.events.find((e: any) => e.summary.startsWith('Focus'));

test('f4-reminder-triage passes the audit across run dates and Mac timezones', () => {
  for (const today of ['2026-10-23', '2026-12-31'])
    for (const tz of [0, 120, -420]) {
      const r = auditTask(task, { load: loadFixtures, envOf: (s: string, t: any) => ({ ...auditEnv(s, t), today, tz }) });
      assert.deepEqual(r, { ok: true, problems: [] }, `${today} ${tz}`);
    }
});

test('the F4 helpers: weekdays, the next working day and lookups by name', () => {
  assert.equal(weekday('2026-10-23'), 'Friday');
  assert.equal(nextWeekday('2026-10-19'), '2026-10-20');
  assert.equal(nextWeekday('2026-10-23'), '2026-10-26', 'Friday rolls over the weekend');
  assert.equal(nextWeekday('2026-10-24'), '2026-10-26', 'Saturday rolls to Monday');
  assert.equal(nextWeekday('2026-12-31'), '2027-01-01');
  const mac = {
    events: [{ summary: 'Focus: x', start: 'a', end: 'b' }],
    reminders: [
      { list: 'MGB', name: 'Pay rent' },
      { list: 'MGB Waiting', name: 'Pay rent' },
    ],
    notes: [{ name: 'Rules', body: 'x' }],
  };
  assert.ok(eventAt(mac, 'focus', 'a', 'b'));
  assert.ok(!eventAt(mac, 'focus', 'a', 'c'));
  assert.equal(remindersIn(mac, WAITING, 'pay rent').length, 1);
  assert.equal(noteNamed(mac, 'rules')?.body, 'x');
  assert.equal(noteNamed(mac, 'Other'), undefined);
});

test('the data: fifteen reminders, overdue ones before today, three open high-priority items after the rules', () => {
  for (const [seed, tz, today] of [
    ['s1', 120, '2026-10-19'],
    ['s2', -420, '2026-12-31'],
    ['s3', 0, '2026-10-23'],
  ] as const) {
    const { env, data, state } = setup(seed, tz, today);
    assert.equal(data.items.length, 15);
    assert.equal(new Set(data.items.map((x: any) => x.name)).size, 15);
    const midnight = localIso(today, 0, tz);
    const overdue = (x: any) => localIso(x.day, x.at, tz) < midnight;
    for (const x of kind(data, 'reschedule')) assert.ok(overdue(x) && /#work/.test(x.notes) && !/done in/i.test(x.notes), x.name);
    for (const x of kind(data, 'move')) assert.ok(overdue(x) && /#waiting/.test(x.notes), x.name);
    for (const x of kind(data, 'done')) assert.match(x.notes, /done in OPS-\d{4}/i);
    // the traps: an overdue #work item already done, a future #waiting item, a "done in person" chore
    assert.ok(kind(data, 'done').some((x: any) => overdue(x) && /#work/.test(x.notes)));
    assert.ok(kind(data, 'keep').some((x: any) => !overdue(x) && /#waiting/.test(x.notes)));
    assert.ok(kind(data, 'keep').some((x: any) => /done in person/.test(x.notes)));
    // future items are due after tomorrow, so "tomorrow" never decides anything
    for (const x of data.items.filter((y: any) => !overdue(y))) assert.ok(x.day > data.tomorrow, x.name);
    const high = data.items.filter((x: any) => x.notes.includes('priority: high'));
    assert.deepEqual(
      high
        .filter((x: any) => x.kind !== 'done')
        .map((x: any) => x.name)
        .sort(),
      [...data.top].sort(),
    );
    assert.equal(high.find((x: any) => x.kind === 'done').name, data.doneHigh);
    assert.ok(state.mac.reminders.every((x: any) => x.list === 'MGB' && !x.completed));
    const rules = state.mac.notes.find((n: any) => n.name === 'Triage rules');
    assert.ok(rules.body.includes(data.focusCode), 'the focus code is in the note, not the prompt');
    assert.ok(!task.prompt(data, env).join('\n').includes(data.focusCode));
  }
});

test('copying an overdue #waiting item instead of moving it does not pass', () => {
  const { env, data, state } = solved('s1');
  const x = kind(data, 'move')[0];
  state.mac.reminders.push({ ...state.mac.reminders.find((y: any) => y.name === x.name), list: 'MGB' });
  const g = gradeTask({ task, data, state, env });
  assert.equal(g.verdict, 'FAIL');
  assert.deepEqual(unmet(g), ['waiting-moved', 'no-duplicates']);
});

test('times entered as UTC instead of the Mac clock miss the reschedule and the focus slot', () => {
  for (const [tz, today] of [
    [120, '2026-10-19'],
    [-420, '2026-12-31'],
  ] as const) {
    const { env, data, state } = setup('s2', tz, today);
    task.solve(data, state, { ...env, tz: 0 });
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.deepEqual(unmet(g), ['work-rescheduled', 'focus']);
  }
});

test('rules applied out of order: a done #work item rescheduled and named in the focus event', () => {
  const { env, data, state } = solved('s3', 120);
  const done = kind(data, 'done').find((x: any) => /#work/.test(x.notes) && x.name !== data.doneHigh);
  state.mac.reminders.find((y: any) => y.name === done.name).due = localIso(data.next, 9 * 60, 120);
  focus(state).summary = `Focus: ${[...data.top, data.doneHigh].join(', ')}`;
  const g = gradeTask({ task, data, state, env });
  assert.equal(g.verdict, 'FAIL');
  assert.deepEqual(unmet(g), ['work-kept', 'focus-items']);
});

test('the "done in person" chore completed and a future #waiting item moved do not pass', () => {
  const { env, data, state } = solved('s1', -420, '2026-12-31');
  const chore = data.items.find((x: any) => /done in person/.test(x.notes));
  state.mac.reminders.find((y: any) => y.name === chore.name).completed = true;
  const later = kind(data, 'keep').find((x: any) => /#waiting/.test(x.notes));
  state.mac.reminders.find((y: any) => y.name === later.name).list = WAITING;
  const g = gradeTask({ task, data, state, env });
  assert.equal(g.verdict, 'FAIL');
  assert.deepEqual(unmet(g), ['completed', 'waiting-kept']);
});

test('on a Friday, rescheduling to tomorrow lands on Saturday and does not pass', () => {
  const { env, data, state } = solved('s2', 0, '2026-10-23');
  assert.equal(data.next, '2026-10-26');
  for (const x of kind(data, 'reschedule'))
    state.mac.reminders.find((y: any) => y.name === x.name).due = localIso(dayOffset('2026-10-23', 1), 9 * 60, 0);
  const g = gradeTask({ task, data, state, env });
  assert.deepEqual(unmet(g), ['work-rescheduled']);
});

test('a second focus event, a deleted standup or a missing focus code do not pass', () => {
  {
    const { env, data, state } = solved('s1');
    state.mac.events.push({ ...focus(state), notes: '' });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['focus']);
  }
  {
    const { env, data, state } = solved('s2');
    state.mac.events = state.mac.events.filter((e: any) => e.summary !== 'Team standup');
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['focus']);
  }
  {
    const { env, data, state } = solved('s3');
    focus(state).notes = '';
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.deepEqual(unmet(g), ['focus-code']);
  }
});
