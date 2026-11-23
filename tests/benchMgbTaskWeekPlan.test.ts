// MGB task f4-week-plan (#1381): audited on every seed, run date and Mac timezone; the sheet's rules are what the
// oracle follows; and local-time mix-ups, a duplicated 1:1 and missing travel do not pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditEnv, auditTask, gradeTask, loadFixtures, setupTask, unmet } from './support/mgb-task-kit.ts';

const { localIso, task } = await import('../bench/lib/mgb/tasks/f4WeekPlan.mjs');
const { csvRows } = await import('../bench/lib/mgb/files.mjs');

const setup = (seed = 's1', tz = 120) => setupTask(task, seed, { tz });

test('f4-week-plan passes the audit across run dates and Mac timezones', () => {
  for (const today of ['2026-10-22', '2026-12-31'])
    for (const tz of [120, -420]) {
      const r = auditTask(task, { load: loadFixtures, envOf: (s: string, t: any) => ({ ...auditEnv(s, t), today, tz }) });
      assert.deepEqual(r.problems, [], `${today} ${tz}`);
    }
});

test('localIso turns a wall time on the Mac into UTC', () => {
  assert.equal(localIso('2026-10-26', 9 * 60, 120), '2026-10-26T07:00:00.000Z');
  assert.equal(localIso('2026-10-26', 9 * 60), '2026-10-26T09:00:00.000Z');
  assert.equal(localIso('2026-10-26', 30, -420), '2026-10-26T07:30:00.000Z');
});

test('the data: next week, an office/off-site mix, a 1:1 that clashes and a free hour for it', () => {
  const { data, state } = setup();
  assert.equal(new Date(`${data.monday}T12:00:00Z`).getUTCDay(), 1);
  assert.ok(data.monday > '2026-10-19');
  assert.ok(data.meetings.some((m: any) => m.location === 'Office') && data.meetings.some((m: any) => m.location !== 'Office'));
  assert.equal(data.oneOnOne.start, data.meetings[1].start, 'the 1:1 starts with the meeting it clashes with');
  assert.ok(data.movedTo >= 9 * 60 && data.movedTo < 17 * 60);
  const rows = csvRows(state.files.entries['next-week.csv'].text);
  assert.equal(rows[0][0], 'Day');
  assert.equal('numbers' in state.mac, false, 'the sheet is a CSV in the task folder, not a Numbers document');
  assert.ok(
    rows.some((r: string[]) => r.join(' ').includes(data.agendaCode)),
    'the code is in the sheet, not the prompt',
  );
});

test('plausible wrong plans do not pass', () => {
  // times entered as UTC instead of the Mac's local time: every meeting, the travel and the 1:1 miss
  {
    const { env, data, state } = setup();
    task.solve(data, state, { ...env, tz: 0 });
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    for (const id of ['meeting-0', 'meeting-4', 'travel', 'one-on-one', 'reminders']) assert.ok(unmet(g).includes(id), id);
  }
  // the 1:1 copied to the free hour instead of moved
  {
    const { env, data, state } = setup('s2');
    const one = state.mac.events[0];
    task.solve(data, state, env);
    state.mac.events.push({ ...one });
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['one-on-one', 'no-clash']);
  }
  // no travel blocks, no agenda code, and team lunch deleted
  {
    const { env, data, state } = setup('s3');
    task.solve(data, state, env);
    state.mac.events = state.mac.events.filter((e: any) => !/travel|lunch/i.test(e.summary));
    for (const n of state.mac.notes) n.body = n.body.replace(data.agendaCode, '');
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['travel', 'agenda-code', 'others-kept']);
  }
});

test("a meeting link in the event's URL field counts, as Calendar keeps it there", () => {
  const { env, data, state } = setup('s2');
  task.solve(data, state, env);
  for (const m of data.meetings) {
    const e = state.mac.events.find((x: any) => x.summary.includes(m.title));
    Object.assign(e, { notes: '', url: m.link });
  }
  assert.equal(gradeTask({ task, data, state, env }).verdict, 'PASS');
  // nowhere at all: every meeting misses its link
  for (const e of state.mac.events) Object.assign(e, { notes: '', url: '' });
  const g = gradeTask({ task, data, state, env });
  assert.deepEqual(
    unmet(g).filter((id: string) => id.endsWith('-where')),
    [0, 1, 2, 3, 4].map((k) => `meeting-${k}-where`),
  );
});
