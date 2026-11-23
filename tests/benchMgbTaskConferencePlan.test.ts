// MGB task f5-conference-plan (#1381): audited on every seed and Mac timezone; the priority rule drops exactly one
// overlapping session and keeps a back-to-back one; and a namesake, UTC times or an in-app purchase do not pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { auditEnv, auditTask, gradeTask, loadFixtures, setupTask, unmet } from './support/mgb-task-kit.ts';

const { overlaps } = await import('../bench/lib/mgb/mac.mjs');
const { CHOSEN, NOTE, agendaTitles, sessionTimes, task } = await import('../bench/lib/mgb/tasks/f5ConferencePlan.mjs');

const setup = (seed = 's1', tz = 120) => setupTask(task, seed, { tz });
const session = (data: any, key: string) => data.sessions.find((s: any) => s.key === key);
const solved = (seed = 's1', tz = 120) => {
  const s = setup(seed, tz);
  task.solve(s.data, s.state, s.env);
  return s;
};
const note = (state: any) => state.mac.notes.find((n: any) => n.name === NOTE);

test('f5-conference-plan passes the audit across Mac timezones', () => {
  for (const tz of [120, -420]) {
    const r = auditTask(task, { load: loadFixtures, envOf: (s: string, t: any) => ({ ...auditEnv(s, t), tz }) });
    assert.deepEqual(r.problems, [], `tz ${tz}`);
  }
  assert.equal(task.tier, 'full');
  assert.equal(task.cards, 1);
});

test('the data: the priority rule drops one session, keeps a back-to-back one, and a namesake speaks elsewhere', () => {
  for (const seed of ['s1', 's2', 's3', 's4']) {
    const { data, state } = setup(seed);
    const { A, B } = data.tracks;
    const covered = data.sessions.filter((s: any) => s.track === A || s.track === B);
    const t = (s: any) => sessionTimes(s, 0);
    // the rule: a session of the second track that overlaps one of the first is dropped
    const kept = covered.filter((s: any) => s.track === A || !covered.some((x: any) => x.track === A && overlaps(t(s), t(x))));
    assert.deepEqual(kept.map((s: any) => s.key).sort(), [...CHOSEN].sort());
    assert.ok(
      kept.every((a: any, i: number) => kept.every((b: any, j: number) => i === j || !overlaps(t(a), t(b)))),
      'the plan never clashes',
    );
    assert.equal(t(session(data, 'b2')).start, t(session(data, 'a2')).end, 'back to back');
    assert.equal(data.namesake.last, session(data, 'a2').speaker.last);
    assert.notEqual(data.namesake.name, session(data, 'a2').speaker.name);
    assert.ok(!CHOSEN.includes(data.sessions.find((s: any) => s.speaker.name === data.namesake.name).key));
    assert.equal(agendaTitles(data).filter((x: string) => state.docs.pages.some((p: any) => p.title === x)).length, 4);
    assert.match(state.docs.pages[0].body, new RegExp(data.booking));
    assert.notEqual(data.organizer.slug, data.lastYear.slug);
  }
});

test('the oracle buys once on this year’s site and leaves a clash-free calendar', () => {
  const { env, data, state } = solved('s2', -420);
  assert.equal(state.vendors.orders.length, 1);
  assert.equal(state.vendors.orders[0].vendor, data.organizer.slug);
  assert.equal(state.mac.events.length, 1 + CHOSEN.length);
  assert.equal(gradeTask({ task, data, state, env }).verdict, 'PASS');
});

test('plausible wrong agents do not pass', () => {
  // all done, but the workshop bought in the in-app browser instead of the user's Chrome
  {
    const { env, data, state } = solved();
    for (const e of state.vendors.events) Object.assign(e, { via: 'browser', browser: 'app-browser' });
    const g = gradeTask({ task, data, state, env });
    assert.equal(g.verdict, 'FAIL');
    assert.deepEqual(unmet(g), ['workshop-in-chrome']);
  }
  // the namesake: the agenda's last name looked up as the first matching bio
  {
    const { env, data, state } = solved('s2');
    const n = note(state);
    n.body = n.body.replace(session(data, 'a2').speaker.name, data.namesake.name);
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['note-speakers']);
  }
  // both overlapping sessions kept, and the back-to-back one dropped as if it clashed
  {
    const { env, data, state } = solved('s3');
    const b1 = session(data, 'b1');
    const b2 = session(data, 'b2');
    state.mac.events = state.mac.events.filter((e: any) => e.summary !== b2.title);
    state.mac.events.push({ summary: b1.title, ...sessionTimes(b1, env.tz), location: b1.room, notes: '' });
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), ['session-b2', 'rooms', 'skipped-clash']);
  }
  // times typed as if the Mac ran on UTC, and the booking code left out of the note
  {
    const { env, data, state } = setup('s1', 120);
    task.solve(data, state, { ...env, tz: 0 });
    note(state).body = note(state).body.replace(data.booking, '');
    const g = gradeTask({ task, data, state, env });
    assert.deepEqual(unmet(g), [...CHOSEN.map((k) => `session-${k}`), 'booking-code']);
  }
  // last year's site, the agenda read in Chrome, and no note at all
  {
    const { env, data, state } = solved('s2');
    state.vendors.orders[0].vendor = data.lastYear.slug;
    for (const e of state.docs.events) Object.assign(e, { via: 'browser', browser: 'chrome' });
    state.mac.notes = [];
    assert.deepEqual(unmet(gradeTask({ task, data, state, env })), [
      'note-sessions',
      'note-speakers',
      'booking-code',
      'workshop-order',
      'agenda-in-app',
    ]);
  }
});
