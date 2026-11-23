// MoMo's routines service (electron/momo/routines.cjs, #2139), on the real stores, the real scheduler and fakes of each harness family's isolated chat start: a routine runs in a fresh unattended, isolated background chat on MoMo's one brain and reports one paragraph to MoMo's main chat; quiet hours, the daily limit and MoMo paused skip a time silently and keep it; while MoMo isn't allowed nothing is listed or written and runs are stopped; a run that fails to start is told to the main chat.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world, told, sweep, FAMILIES } from './support/momo-routines.ts';

const require = createRequire(import.meta.url);
const { createMomoRoutines, routinePrompt, UNATTENDED, ISOLATION, REMOVED_TEXT } = require('../electron/momo/routines.cjs');
const { withMomoTasks } = require('../electron/momo/schedulerTasks.cjs');
const { Scheduler, RunSkipped } = require('../electron/platform/scheduler.cjs');
const { RunLedger } = require('../electron/platform/runLedger.cjs');

const DAY = 86_400_000;
const taskOf = async (w: any, id: string) => (await w.service.list()).find((t: any) => t.id === id);
const skippedFor = (reason: string) => (e: any) => e instanceof RunSkipped && e.reason === reason;

test('a routine runs in a fresh, isolated, unattended chat on MoMo’s one brain, on every harness family, and reports one paragraph', async () => {
  for (const harness of FAMILIES) {
    const w = world({ mainBrain: { harness, account: null, model: null } });
    const r = await w.routines.add(sweep, { approved: true });
    const task = await taskOf(w, r.id);
    assert.equal(task.harness, harness);
    const chatId = await w.service.run(task);
    // isolation is how the chat starts, not what the prompt asks: memory, user instructions and built-in tools off
    assert.deepEqual(w.started, [[harness, { momo: 'routine', routineId: r.id, isolation: ISOLATION }, chatId]], harness);
    assert.deepEqual(ISOLATION, { harnessMemory: false, userInstructions: false, builtinTools: false });
    assert.deepEqual(w.sessions.get(chatId).scheduled, UNATTENDED, 'no app control; approvals wait');
    assert.equal(w.sent[0][1].text, routinePrompt(r));
    await w.service.finished({ chatId, text: 'Two replies need you:\nAna and Raj.\n\nDetails below.', completed: true });
    assert.deepEqual(told(w), [['Inbox sweep', true, 'Two replies need you: Ana and Raj.']], harness);
    assert.deepEqual(w.chats, [['archive', chatId]], 'its chat is archived once its result is told');
    await w.service.finished({ chatId: 'a coding chat', text: 'not ours', completed: true });
    assert.equal(w.reports.length, 1);
  }
});

test('routines run on the one brain; a routines brain an older build saved is not used; with it unable to run, the main chat is told', async () => {
  const w = world({ prefs: { momo: { brain: { routines: { harness: 'claude' } } } } });
  const r0 = await w.routines.add(sweep, { approved: true });
  assert.equal((await taskOf(w, r0.id)).harness, 'codex');
  await w.service.run(await taskOf(w, r0.id));
  assert.equal(w.started[0][0], 'codex');
  assert.deepEqual(told(w), [], 'nothing to say while the run goes');
  let canRun = false;
  const none = world({ usable: () => canRun });
  const r2 = await none.routines.add({ ...sweep, name: 'X' }, { approved: true });
  const t2 = await taskOf(none, r2.id);
  await assert.rejects(none.service.run(t2), /No harness can run MoMo’s routines now/);
  await none.service.failed(t2, new Error('No harness can run MoMo’s routines now: sign in or install one.'));
  await none.service.failed(t2, 'plain');
  assert.deepEqual(told(none), [
    ['X', false, 'No harness can run MoMo’s routines now: sign in or install one.'],
    ['X', false, 'plain'],
  ]);
  // the same failure again is told once: an hourly routine with no harness doesn't wake the chat hourly
  await none.service.failed(t2, 'plain');
  assert.equal(told(none).length, 2);
  // a run of it that starts clears that, so the next failure is told again
  canRun = true;
  await none.service.run(t2);
  await none.service.failed(t2, 'plain');
  assert.equal(told(none).length, 3);
  const nobody = world({ mainBrain: null });
  await assert.rejects(nobody.service.brain(), /No harness/);
  assert.equal(createMomoRoutines({}).now, Date.now);
});

test('a failure the main chat could not be told of (MoMo paused, no chat) is told next time, not remembered as told', async () => {
  const w = world();
  let told = false;
  w.service.o.report = async (r: any) => (w.reports.push(r), told);
  const task = { id: 'momo.x', name: 'X' };
  await w.service.failed(task, new Error('boom'));
  await w.service.failed(task, new Error('boom'));
  assert.equal(w.reports.length, 2, 'still not told, so tried again');
  told = true;
  await w.service.failed(task, new Error('boom'));
  await w.service.failed(task, new Error('boom'));
  assert.equal(w.reports.length, 3, 'told once it was');
});

test('not allowed: nothing is listed, validated, read or written, and this MoPilot’s runs are stopped', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momo-none-')), 'momo');
  const never = world({ allowed: false, dir });
  assert.deepEqual(await never.service.list(), []);
  assert.equal(await never.service.validate({ id: 'momo.x' }), null);
  await never.service.failed({ id: 'momo.x', name: 'X' }, new Error('x'));
  assert.deepEqual(never.reports, [], 'a failure is told only while allowed');
  assert.equal(fs.existsSync(dir), false, 'no MoMo folder for an account MoMo isn’t allowed for');
  await assert.rejects(never.service.propose(sweep), (e: any) => e.code === 'not_allowed');
  const w = world();
  const r = await w.routines.add(sweep, { approved: true });
  const task = await taskOf(w, r.id);
  const chatId = await w.service.run(task);
  w.setAllowed(false);
  const before = fs.readFileSync(path.join(w.dir, 'routines.json'), 'utf8');
  assert.deepEqual(await w.service.list(), []);
  await assert.rejects(w.service.run(task), skippedFor('not-allowed'));
  await w.service.revoked();
  assert.deepEqual(w.chats, [['stop', chatId]]);
  // its late finish, with MoMo off, is told to nobody by the real reporter; here the run simply isn't this MoPilot's any more
  await w.service.finished({ chatId, text: 'late', completed: true });
  assert.equal(fs.readFileSync(path.join(w.dir, 'routines.json'), 'utf8'), before, 'nothing written');
  // turned off while the harness started its chat: nothing is sent, the chat goes
  const late = world();
  const r2 = await late.routines.add(sweep, { approved: true });
  const t2 = await taskOf(late, r2.id);
  late.service.o.startChat = async () => (late.setAllowed(false), 'chat-1');
  await assert.rejects(late.service.run(t2), skippedFor('not-allowed'));
  assert.deepEqual([late.sent, late.chats, late.routines.openRuns()], [[], [['discard', 'chat-1']], []]);
});

test('in the real scheduler: quiet hours, the daily limit and MoMo paused skip a routine silently and keep the time', async (t) => {
  const w = world({ prefs: { momo: { routines: { proactivity: 'low', quietHours: { start: '08:30', end: '10:00' } } } } });
  // made yesterday: this morning's 9:00 is a time of its
  w.c.t -= DAY;
  const r = await w.routines.add(sweep, { approved: true });
  w.c.t += DAY;
  const ledgerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ledger-'));
  t.after(() => fs.rmSync(ledgerDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(ledgerDir, '.baseline'), '1');
  const ledger = new RunLedger({ dir: ledgerDir, now: w.c.now });
  const tasks = withMomoTasks({ list: async () => [], validate: async (x: any) => x, run: async () => 'x' }, () => w.service);
  // "run schedules" off on the coding side doesn't stop MoMo
  const s = new Scheduler({ enabled: () => false, ...tasks, sessions: w.sessions, ledger, now: w.c.now, tickMs: 0 });
  await s.tick();
  assert.deepEqual(
    (await ledger.list(r.id)).map((x: any) => [x.status, x.reason]),
    [['skipped', 'quiet-hours']],
  );
  assert.deepEqual(told(w), [], 'a skipped time says nothing');
  // the next day, quiet hours off, Low's two runs already used today: the limit
  w.service.o.prefs = () => ({ momo: { routines: { proactivity: 'low', quietHours: null } } });
  w.c.t += DAY - 30_000;
  for (const id of ['x1', 'x2']) {
    await w.routines.beginRun({ chatId: id, taskId: r.id, kind: 'momo-routine', due: 1 });
    await w.routines.endRun(id, 'completed');
  }
  await s.tick();
  assert.deepEqual(
    (await ledger.list(r.id)).map((x: any) => x.reason),
    ['limit', 'quiet-hours'],
  );
  // MoMo paused: the next day the routine doesn't run, and that is kept
  w.service.o.prefs = () => ({ momo: { paused: true } });
  w.c.t += DAY;
  await s.tick();
  assert.equal((await ledger.list(r.id))[0].reason, 'paused');
  assert.deepEqual([told(w), w.sent], [[], []]);
});

test('the daily limit is counted again once the chat exists: a run that would pass it goes, chat and all', async () => {
  const w = world({ prefs: { momo: { routines: { proactivity: 'low', quietHours: null } } } });
  const r = await w.routines.add(sweep, { approved: true });
  const task = await taskOf(w, r.id);
  // another MoPilot takes the day's last runs while this one starts its chat
  w.service.o.startChat = async () => {
    for (const id of ['o1', 'o2']) await w.routines.beginRun({ chatId: id, taskId: r.id, kind: 'momo-routine', due: 1 });
    return 'late-chat';
  };
  await assert.rejects(w.service.run(task), skippedFor('limit'));
  assert.deepEqual(w.chats, [['discard', 'late-chat']]);
  assert.deepEqual(w.sent, []);
});

test('an at-limit brain skips the run: held starts nothing, go moves to the account it names', async () => {
  const w = world();
  const r = await w.routines.add(sweep, { approved: true });
  const task = await taskOf(w, r.id);
  w.service.o.atLimit = () => ({ held: 'Codex is at its limit' });
  await assert.rejects(w.service.run(task), skippedFor('at-limit'));
  assert.deepEqual([w.started, w.routines.openRuns()], [[], []]);
  w.service.o.atLimit = () => ({ go: { harness: 'claude', account: 'b', model: null } });
  await w.service.run(task);
  assert.equal(w.started[0][0], 'claude');
});

test('propose keeps a routine unapproved and says nothing; remove forgets it everywhere; a starter is proposed once', async () => {
  const w = world();
  const r = await w.routines.add(sweep, { approved: true });
  const proposed = await w.service.propose({
    name: 'Reading list',
    prompt: 'Pick three articles.',
    rrule: 'FREQ=WEEKLY;BYDAY=MO;BYHOUR=9',
  });
  assert.equal(proposed.approved, false);
  assert.equal((await taskOf(w, proposed.id)).status, 'PAUSED');
  assert.equal((await taskOf(w, r.id)).status, 'ACTIVE');
  assert.deepEqual(told(w), [], 'a proposal tells nothing: it waits in Settings');
  await assert.rejects(w.service.run(await taskOf(w, proposed.id)), skippedFor('not-approved'));
  assert.equal(await w.service.remove(proposed.id), true);
  assert.deepEqual(w.chats.at(-1), ['forget', proposed.id], 'its run history leaves the shared ledger');
  assert.equal(w.routines.get(proposed.id), null);
  const bare = createMomoRoutines({ ...w.service.o, forget: undefined });
  assert.equal(await bare.remove('momo.none'), false);
  assert.equal(await bare.remove(r.id), true);
  const starter = await w.service.propose({ ...sweep, name: 'Morning briefing', sources: ['calendar'] }, { starter: 'morningFeed' });
  assert.equal(starter.approved, false);
  assert.equal(await w.service.propose({ ...sweep, name: 'Morning briefing' }, { starter: 'morningFeed' }), null);
  // a run says what it reads
  assert.match(routinePrompt(starter), /It may read only Calendar\./);
  assert.match(routinePrompt({ name: 'x', prompt: 'y' }), /It reads none of the user’s sources\./);
  assert.match(routinePrompt({ name: 'x', prompt: 'y', sources: ['other'] }), /read only other\./);
});

test('Remove: this MoPilot’s run of the routine under way is stopped and says why; an id that names no routine forgets nothing', async () => {
  const w = world();
  const r = await w.routines.add(sweep, { approved: true });
  const chatId = await w.service.run(await taskOf(w, r.id));
  assert.ok(w.service.mine.has(chatId));
  // another routine's run is left alone
  const other = await w.routines.add({ ...sweep, name: 'Other' }, { approved: true });
  const otherChat = await w.service.run(await taskOf(w, other.id));
  assert.equal(await w.service.remove(r.id), true);
  assert.deepEqual(
    w.chats.filter((c: any) => c[0] === 'stop' || c[0] === 'forget'),
    [
      ['stop', chatId],
      ['forget', r.id],
    ],
  );
  assert.deepEqual(told(w).at(-1), ['Inbox sweep', false, REMOVED_TEXT]);
  assert.ok(w.service.mine.has(otherChat));
  w.chats.length = 0;
  assert.equal(await w.service.remove('momo.none'), false);
  assert.deepEqual(w.chats, [], 'nothing to forget');
});

test('a routine removed while its run’s chat started doesn’t run: nothing is sent and the run closes', async () => {
  const w = world();
  const r = await w.routines.add(sweep, { approved: true });
  const task = await taskOf(w, r.id);
  const start = w.service.o.startChat;
  w.service.o.startChat = async (brain: any, meta: any) => {
    const id = await start(brain, meta);
    await w.routines.remove(r.id);
    return id;
  };
  await assert.rejects(w.service.run(task), skippedFor('not-approved'));
  assert.deepEqual(w.sent, []);
  assert.deepEqual(w.routines.openRuns(), []);
  assert.deepEqual(w.chats, [['discard', w.started[0][2]]], 'its chat goes');
  assert.equal(w.service.mine.size, 0);
});

test('proactivity off lists nothing; with no routines there are no tasks', async () => {
  const off = world({ prefs: { momo: { routines: { proactivity: 'off' } } } });
  await off.routines.add(sweep, { approved: true });
  assert.deepEqual(await off.service.list(), []);
  assert.deepEqual(await world().service.list(), []);
});
