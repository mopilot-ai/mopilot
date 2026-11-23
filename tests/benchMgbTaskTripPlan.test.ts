// MGB task f4-trip-plan (#1381): audited on every seed, run date and Mac timezone; the itinerary's cancelled flight and
// moved meeting are traps; and booking the cancelled flight, mixing up local and UTC times, re-adding packed items,
// using another city's rates or overwriting the itinerary do not pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditEnv, auditTask, gradeTask, loadFixtures, setupTask, unmet } from './support/mgb-task-kit.ts';

const { dayOffset } = await import('../bench/lib/mgb/seed.mjs');
const { localIso } = await import('../bench/lib/mgb/tasks/f4Common.mjs');
const { csvRows, describeFile, toCsv } = await import('../bench/lib/mgb/files.mjs');
const { task } = await import('../bench/lib/mgb/tasks/f4TripPlan.mjs');

const PACK = 'MGB Packing';
const BUDGET = 'trip-budget.csv';
/** The budget sheet's rows as the folder holds them. */
const sheet = (state: any): string[][] => csvRows(state.files.entries[BUDGET].text);
/** Saves rows back into the budget sheet, as an editor would. */
const save = (state: any, rows: string[][]) => {
  state.files.entries[BUDGET] = describeFile(BUDGET, Buffer.from(toCsv(rows)));
};
const setup = (seed = 's1', tz = 120, today = '2026-10-19') => setupTask(task, seed, { today, tz });
const solved = (seed?: string, tz?: number, today?: string) => {
  const s = setup(seed, tz, today);
  task.solve(s.data, s.state, s.env);
  return s;
};

test('f4-trip-plan passes the audit across run dates and Mac timezones', () => {
  for (const today of ['2026-10-19', '2026-12-31'])
    for (const tz of [0, 120, -420]) {
      const r = auditTask(task, { load: loadFixtures, envOf: (s: string, t: any) => ({ ...auditEnv(s, t), today, tz }) });
      assert.deepEqual(r, { ok: true, problems: [] }, `${today} ${tz}`);
    }
});

test('the data: a cancelled flight, a moved meeting, part of the packing done and an empty budget row', () => {
  for (const seed of ['s1', 's2', 's3']) {
    const { env, data, state } = setup(seed, -420, '2026-12-31');
    const { outbound, cancelled, back, meetings, packing } = data;
    // the cancelled flight leaves earlier on the outbound day, under its own number
    assert.equal(cancelled.day, outbound.day);
    assert.ok(cancelled.dep < outbound.dep);
    assert.notEqual(cancelled.number, outbound.number);
    assert.ok(outbound.dep - 120 >= 7 * 60, 'the airport block starts in the morning');
    assert.ok(back.day > outbound.day && back.arr > back.dep);
    // the trip runs Monday or Tuesday to Friday, and the moved meeting goes from Wednesday to Thursday
    const dow = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
    assert.ok([1, 2].includes(dow(outbound.day)));
    assert.equal(dow(back.day), 5);
    assert.deepEqual([dow(meetings[0].day), dow(meetings[1].was), dow(meetings[1].day)], [3, 3, 4]);
    assert.equal(data.days, data.nights + 1);
    assert.equal(data.rates[0].city, data.city);

    const note = state.mac.notes.find((n: any) => n.name === `Trip: ${data.city}`);
    const line = note.body.split('\n').find((l: string) => l.includes(cancelled.number));
    assert.match(line, /CANCELLED/);
    assert.match(note.body, new RegExp(`moved to Thursday ${meetings[1].day}`));
    assert.ok(note.body.includes(data.hotel.code), 'the confirmation is in the itinerary, not the prompt');
    assert.ok(!task.prompt(data, env).join('\n').includes(data.hotel.code));
    for (const item of [...packing.ticked, packing.open, ...packing.missing]) assert.ok(note.body.includes(item.toLowerCase()), item);

    const list = state.mac.reminders.filter((x: any) => x.list === PACK);
    assert.deepEqual(
      list.map((x: any) => [x.name, x.completed]),
      [...packing.ticked.map((n: string) => [n, true]), [packing.open, false], [packing.extra, false]],
    );
    for (const item of packing.missing) assert.ok(!list.some((x: any) => x.name === item));
    const row = sheet(state).find((r: string[]) => r[0] === data.tripLabel);
    assert.deepEqual(row?.slice(1), ['', '', '', '', '']);
    assert.equal('numbers' in state.mac, false, 'the budget is a CSV in the task folder, not a Numbers document');
    // the dentist appointment sits at 08:00 local three days before the outbound flight
    assert.equal(state.mac.events[0].start, localIso(dayOffset(outbound.day, -3), 8 * 60, -420));
  }
});

test('the oracle books flights and meetings at local wall times', () => {
  const { data, state } = solved('s2', -420);
  const flight = state.mac.events.find((e: any) => e.summary.includes(data.outbound.number));
  assert.equal(flight.start, localIso(data.outbound.day, data.outbound.dep, -420));
  const airport = state.mac.events.find((e: any) => e.summary === 'Airport');
  assert.equal(Date.parse(flight.start) - Date.parse(airport.start), 2 * 3600 * 1000);
  const row = sheet(state).find((r: string[]) => r[0] === data.tripLabel);
  assert.deepEqual(row?.slice(1, 3), [String(data.nights), String(data.days)]);
});

test('booking the cancelled flight, with the airport block before it, does not pass', () => {
  const { env, data, state } = solved('s1', 120);
  const { outbound, cancelled } = data;
  const flight = state.mac.events.find((e: any) => e.summary.includes(outbound.number));
  Object.assign(flight, {
    summary: `Flight ${cancelled.number.replace(' ', '')}`,
    start: localIso(cancelled.day, cancelled.dep, 120),
    end: localIso(cancelled.day, cancelled.arr, 120),
  });
  const airport = state.mac.events.find((e: any) => e.summary === 'Airport');
  Object.assign(airport, { start: localIso(cancelled.day, cancelled.dep - 120, 120), end: flight.start });
  const g = gradeTask({ task, data, state, env });
  assert.equal(g.verdict, 'FAIL');
  assert.deepEqual(unmet(g), ['flight-out', 'no-cancelled', 'airport']);
});

test('times entered as UTC instead of the Mac clock miss every timed event', () => {
  for (const [tz, today] of [
    [120, '2026-10-19'],
    [-420, '2026-12-31'],
  ] as const) {
    const { env, data, state } = setup('s3', tz, today);
    task.solve(data, state, { ...env, tz: 0 });
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.deepEqual(unmet(g), ['flight-out', 'flight-back', 'airport', 'meeting-0', 'meeting-moved']);
  }
});

test('the moved meeting kept on its old day and packed items re-added do not pass', () => {
  const { env, data, state } = solved('s2', 0);
  const m = data.meetings[1];
  state.mac.events.push({
    summary: `${m.company} (old slot)`,
    start: localIso(m.was, m.start, 0),
    end: localIso(m.was, m.start + m.minutes, 0),
    location: m.address,
    notes: '',
  });
  for (const name of data.packing.ticked) state.mac.reminders.push({ list: PACK, name, due: null, completed: false, notes: '' });
  const g = gradeTask({ task, data, state, env });
  assert.equal(g.verdict, 'FAIL');
  assert.deepEqual(unmet(g), ['meeting-moved', 'packing-no-dupes']);
});

test("another city's rates, or no trip row at all, miss the budget", () => {
  {
    const { env, data, state } = solved('s1', 0);
    const other = data.rates[1];
    const rows = sheet(state);
    const row = rows.find((r: string[]) => r[0] === data.tripLabel) as string[];
    row.splice(
      3,
      3,
      `$${data.nights * other.hotel}`,
      `$${data.days * other.meals}`,
      `$${data.nights * other.hotel + data.days * other.meals}`,
    );
    save(state, rows);
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['budget-hotel', 'budget-meals', 'budget-total']);
  }
  {
    const { env, data, state } = solved('s2', 0);
    save(
      state,
      sheet(state).filter((r: string[]) => r[0] !== data.tripLabel),
    );
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['budget-hotel', 'budget-meals', 'budget-total']);
    assert.match(g.why.join(' '), /check failed/);
  }
  {
    // the sheet emptied (header and all): no budget, and the grader says why
    const { env, data, state } = solved('s1', 0);
    save(state, []);
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['budget-hotel', 'budget-meals', 'budget-total']);
    assert.match(g.why.join(' '), /check failed/);
  }
  {
    // saved as another file (an editor's "Save As" to .rtf): the sheet the task named is still empty
    const { env, data, state } = solved('s3', 0);
    state.files.entries['trip-budget.rtf'] = state.files.entries[BUDGET];
    delete state.files.entries[BUDGET];
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), ['budget-hotel', 'budget-meals', 'budget-total']);
  }
});

test('a summary without the confirmation, or written over the itinerary, does not pass', () => {
  {
    const { env, data, state } = solved('s3', 120);
    const summary = state.mac.notes.find((n: any) => n.name === `Trip summary ${data.city}`);
    summary.body = summary.body.replace(data.hotel.code, 'see the booking email');
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.deepEqual(unmet(g), ['confirmation']);
  }
  {
    // the itinerary note renamed into the summary: the summary passes, the itinerary is gone
    const { env, data, state } = solved('s1', 120);
    state.mac.notes = state.mac.notes.filter((n: any) => n.name !== `Trip: ${data.city}`);
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.deepEqual(unmet(g), ['itinerary-kept']);
  }
});
