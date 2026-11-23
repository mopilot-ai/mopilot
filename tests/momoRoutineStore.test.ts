// MoMo's routines on disk (electron/momo/routineStore.cjs, #2139): encrypted, checked routines (hourly or slower, reading named sources) with an approval only the user gives, a proposal under a name already waiting answered by that one, each starter routine proposed once ever, and a schedule that counts from its last change, and the runs MoMo started, counted per local day (the daily limit held under the lock) and kept 30 days.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, scratch, clock, ids } from './support/momo-fixtures.ts';

const require = createRequire(import.meta.url);
const { RoutineStore, MAX_ROUTINES } = require('../electron/momo/routineStore.cjs');
const { SealedJson } = require('../electron/gateway/sealedFile.cjs');

const DAY = 86_400_000;
const START = new Date(2030, 2, 10, 9).getTime();
const sweep = { name: 'Inbox sweep', prompt: 'Summarize what needs a reply.', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' };
const code = (c: string) => (e: any) => e?.code === c;

function store() {
  const dir = scratch();
  const safe = fakeSafe();
  const c = clock(START);
  return { s: new RoutineStore({ dir, safeStorage: safe, now: c.now, newId: ids() }), dir, safe, c };
}

test('encrypted at rest; a routine the user made is approved, one MoMo proposed waits', async () => {
  const { s, dir, safe, c } = store();
  const r = await s.add(sweep, { approved: true });
  assert.deepEqual(r, {
    id: 'momo.id-1',
    ...sweep,
    sources: [],
    rev: 1,
    status: 'ACTIVE',
    approved: true,
    createdAt: START,
    updatedAt: START,
    scheduleFrom: START,
  });
  assert.equal((await s.add({ ...sweep, name: 'Proposed' }, { approved: false })).approved, false);
  const raw = fs.readFileSync(path.join(dir, 'routines.json'), 'utf8');
  assert.ok(!raw.includes('Inbox sweep') && !raw.includes('reply'));
  assert.equal(fs.statSync(path.join(dir, 'routines.json')).mode & 0o777, 0o600);
  const again = new RoutineStore({ dir, safeStorage: safe, now: c.now });
  assert.deepEqual(
    again.list().map((x: any) => x.name),
    ['Inbox sweep', 'Proposed'],
  );
  assert.equal(again.get('momo.id-1').prompt, sweep.prompt);
  assert.equal(again.get('nope'), null);
  assert.match((await again.add(sweep, { approved: true })).id, /^momo\.[0-9a-f-]{36}$/, 'an opaque id');
  safe.available = false;
  assert.throws(() => again.list(), code('unavailable'));
});

test('a routine is checked: name, prompt, an hourly-or-slower schedule; at most 50', async () => {
  const { s } = store();
  const bad = (input: any, pattern: RegExp) =>
    assert.rejects(s.add(input, { approved: true }), (e: any) => e.code === 'bad_args' && pattern.test(e.message), pattern.source);
  await bad({ ...sweep, name: ' ' }, /name is 1 to 80/);
  await bad({ ...sweep, name: 'x'.repeat(81) }, /name is 1 to 80/);
  await bad({ ...sweep, prompt: undefined }, /prompt is 1 to 2000/);
  await bad({ ...sweep, rrule: 'every morning' }, /Not a schedule/);
  await bad({ ...sweep, rrule: 'BYHOUR=9' }, /Not a schedule/);
  await bad({ ...sweep, rrule: 'FREQ=MINUTELY;INTERVAL=5' }, /at most hourly/);
  await bad({ ...sweep, rrule: 'RRULE:FREQ=SECONDLY' }, /at most hourly/);
  // several minutes (or seconds) in each hour is more often than hourly
  await bad({ ...sweep, rrule: 'FREQ=HOURLY;BYMINUTE=0,15,30,45' }, /at most hourly/);
  await bad({ ...sweep, rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0;BYSECOND=0,30' }, /at most hourly/);
  await bad(null, /name/);
  assert.equal(
    (await s.add({ ...sweep, rrule: 'RRULE:FREQ=HOURLY;INTERVAL=2' }, { approved: true })).rrule,
    'RRULE:FREQ=HOURLY;INTERVAL=2',
  );
  assert.ok(await s.add({ ...sweep, rrule: 'FREQ=DAILY;BYHOUR=8,12,18;BYMINUTE=30' }, { approved: true }), 'several hours a day is fine');
  await bad({ ...sweep, sources: ['mail'] }, /sources are some of calendar, reminders, files/);
  await bad({ ...sweep, sources: 'calendar' }, /sources are some of/);
  assert.deepEqual((await s.add({ ...sweep, sources: ['files', 'calendar', 'files'] }, { approved: true })).sources, ['files', 'calendar']);
  for (let i = 3; i < MAX_ROUTINES; i++) await s.add(sweep, { approved: true });
  await assert.rejects(s.add(sweep, { approved: true }), code('full'));
});

test('a proposal under a name already waiting is that one; each starter is proposed once ever, even after it is removed', async () => {
  const { s, dir, safe, c } = store();
  const first = await s.add({ ...sweep, name: 'Reading list' }, { approved: false });
  // the same name again (any case) while it waits: nothing new, so a retried call asks once; a corrected one is what waits
  c.t += 1000;
  const again = await s.add(
    { ...sweep, name: 'reading LIST', prompt: 'Other', rrule: 'FREQ=WEEKLY;BYDAY=MO', sources: ['files'] },
    { approved: false },
  );
  assert.deepEqual(
    [again.id, again.name, again.prompt, again.rrule, again.sources, again.updatedAt, again.scheduleFrom],
    [first.id, 'Reading list', 'Other', 'FREQ=WEEKLY;BYDAY=MO', ['files'], START + 1000, START],
  );
  assert.equal(s.list().length, 1);
  assert.equal(s.get(first.id).prompt, 'Other');
  // one the user made is never folded into a proposal, and an approved one doesn't answer a new proposal
  const made = await s.add({ ...sweep, name: 'Reading list' }, { approved: true });
  assert.notEqual(made.id, first.id);
  await s.update(first.id, { approved: true });
  assert.notEqual((await s.add({ ...sweep, name: 'Reading list' }, { approved: false })).id, first.id);
  // a starter: once, and not again from another MoPilot reading the same file, nor after it was removed
  const morning = await s.add({ ...sweep, name: 'Morning Feed' }, { approved: false, starter: 'morningFeed' });
  assert.equal(morning.name, 'Morning Feed');
  const other = new RoutineStore({ dir, safeStorage: safe, now: c.now });
  assert.equal(await other.add({ ...sweep, name: 'Morning Feed' }, { approved: false, starter: 'morningFeed' }), null);
  await s.remove(morning.id);
  assert.equal(await s.add({ ...sweep, name: 'Morning Feed' }, { approved: false, starter: 'morningFeed' }), null);
  // a starter whose name already waits is offered by that one, and counts as offered
  const waiting = await s.add({ ...sweep, name: 'Week ahead' }, { approved: false });
  assert.equal((await s.add({ ...sweep, name: 'Week ahead' }, { approved: false, starter: 'weekAhead' })).id, waiting.id);
  assert.equal(await s.add({ ...sweep, name: 'Week ahead' }, { approved: false, starter: 'weekAhead' }), null);
  // a store that is full still answers a proposal already waiting, and keeps a starter it couldn't add untried
  for (let i = s.list().length; i < MAX_ROUTINES; i++) await s.add(sweep, { approved: true });
  assert.equal((await s.add({ ...sweep, name: 'Week ahead' }, { approved: false })).id, waiting.id);
  await assert.rejects(s.add({ ...sweep, name: 'Bills' }, { approved: false, starter: 'bills' }), code('full'));
  assert.deepEqual(s.json.read().starters, ['morningFeed', 'weekAhead']);
});

test('changes: a new schedule, a resume or an approval count from now; a pause, a rename or new sources do not', async () => {
  const { s, c } = store();
  const r = await s.add(sweep, { approved: false });
  c.t += 1000;
  assert.equal((await s.update(r.id, { name: 'Renamed' })).scheduleFrom, START);
  // what it reads changes without counting from now; only sources there are
  assert.deepEqual((await s.update(r.id, { sources: ['reminders'] })).sources, ['reminders']);
  assert.equal(s.get(r.id).scheduleFrom, START);
  await assert.rejects(s.update(r.id, { sources: ['mail'] }), code('bad_args'));
  assert.equal((await s.update(r.id, { rrule: sweep.rrule })).scheduleFrom, START, 'the same schedule');
  assert.equal((await s.update(r.id, { status: 'PAUSED' })).scheduleFrom, START);
  c.t += 1000;
  const resumed = await s.update(r.id, { status: 'ACTIVE' });
  assert.deepEqual([resumed.status, resumed.scheduleFrom], ['ACTIVE', START + 2000]);
  c.t += 1000;
  const approved = await s.update(r.id, { approved: true });
  assert.deepEqual([approved.approved, approved.scheduleFrom], [true, START + 3000]);
  c.t += 1000;
  assert.equal((await s.update(r.id, { approved: true })).scheduleFrom, START + 3000, 'already approved');
  const moved = await s.update(r.id, { rrule: 'FREQ=WEEKLY;BYDAY=MO', prompt: 'New prompt' });
  assert.deepEqual(
    [moved.rrule, moved.prompt, moved.scheduleFrom, moved.updatedAt],
    ['FREQ=WEEKLY;BYDAY=MO', 'New prompt', START + 4000, START + 4000],
  );
  assert.equal((await s.update(r.id, { status: 'ACTIVE' })).scheduleFrom, START + 4000, 'already active');
  await assert.rejects(s.update(r.id, { status: 'DONE' }), code('bad_args'));
  await assert.rejects(s.update(r.id, { approved: false }), code('bad_args'));
  assert.equal(await s.update('gone', { name: 'x' }), null);
  assert.equal(await s.remove(r.id), true);
  assert.equal(await s.remove(r.id), false);
  assert.deepEqual(s.list(), []);
});

test('runs: open until they end, counted per local day, the limit held under the lock, kept 30 days; runs of another kind are dropped', async () => {
  const { s, c } = store();
  await s.beginRun({ chatId: 'm1', taskId: 'momo.r1', kind: 'momo-routine', due: START });
  // a run of the daily edition an older build kept: not a routine's, so it is dropped when read
  await s.beginRun({ chatId: 'm2', taskId: 'momo.feed', kind: 'momo-feed', due: START });
  assert.equal(s.runsOn(START), 1, 'only routine runs are counted');
  assert.equal(s.openRun('m2'), null);
  // two MoPilots taking the day's last run at once: one gets it
  const [a, b] = await Promise.all([
    s.beginRun({ chatId: 'm3', taskId: 'momo.r2', kind: 'momo-routine', due: START }, { limit: 2 }),
    s.beginRun({ chatId: 'm4', taskId: 'momo.r3', kind: 'momo-routine', due: START }, { limit: 2 }),
  ]);
  assert.deepEqual([a?.chatId ?? null, b?.chatId ?? null].filter(Boolean).length, 1);
  assert.equal(s.runsOn(START), 2);
  assert.deepEqual(
    s.openRuns().map((r: any) => r.chatId),
    ['m1', a ? 'm3' : 'm4'],
  );
  assert.equal(s.openRun('m1').taskId, 'momo.r1');
  c.t += 1000;
  const ended = await s.endRun('m1', 'completed');
  assert.deepEqual([ended.endedAt, ended.outcome], [START + 1000, 'completed']);
  assert.equal(await s.endRun('m1', 'completed'), null, 'already ended');
  assert.equal(await s.endRun('nobody', 'completed'), null);
  assert.equal(s.openRun('m1'), null);
  assert.equal(s.runsOn(START), 2, 'an ended run still counts that day');
  // the next local day starts at midnight, not 24 hours after the run
  const midnight = new Date(2030, 2, 11).getTime();
  assert.equal(s.runsOn(midnight - 1), 2);
  assert.equal(s.runsOn(midnight), 0);
  c.t = START + 30 * DAY;
  assert.deepEqual(s.openRuns(), []);
});

test('a routines file in another shape reads as empty lists', async () => {
  const { dir, safe, c } = store();
  const json = new SealedJson({ file: path.join(dir, 'routines.json'), safeStorage: safe, shape: (v: any) => v });
  await json.change(() => {});
  const s = new RoutineStore({ dir, safeStorage: safe, now: c.now });
  assert.deepEqual(s.list(), []);
  fs.writeFileSync(
    path.join(dir, 'routines.json'),
    JSON.stringify({
      v: 1,
      enc: 'safe',
      data: safe
        .encryptString(JSON.stringify({ routines: 'x', runs: [{ chatId: 'old', kind: 'momo-routine' }, { chatId: 'older' }, 7] }))
        .toString('base64'),
    }),
  );
  assert.deepEqual(s.openRuns(), [], 'a run with no start time is past keeping');
});

test('Reset MoMo erases the routines and their runs', async () => {
  const { s, dir } = store();
  await s.add(sweep, { approved: true });
  await s.beginRun({ chatId: 'm1', taskId: 'momo.r1', kind: 'momo-routine', due: START });
  await s.erase();
  assert.equal(fs.existsSync(path.join(dir, 'routines.json')), false);
  assert.deepEqual([s.list(), s.openRuns()], [[], []]);
});

test('a routine kept before routines had a rev counts from 0: a proposal merged into it, an approval of rev 0, a change', async () => {
  const { s } = store();
  const old = await s.add({ ...sweep, name: 'Old' }, { approved: false });
  await s.json.change((x: any) => void delete x.routines[0].rev);
  assert.equal((await s.add({ ...sweep, name: 'Old', prompt: 'Merged' }, { approved: false })).rev, 1);
  await s.json.change((x: any) => void delete x.routines[0].rev);
  await assert.rejects(s.update(old.id, { approved: true }, { seen: 1 }), code('changed'));
  assert.equal((await s.update(old.id, { approved: true }, { seen: 0 })).rev, 1);
});
