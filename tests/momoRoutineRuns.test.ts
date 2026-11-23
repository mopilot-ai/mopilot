// How a MoMo routine's run ends (electron/momo/routineRuns.cjs, #2139), on the real stores and session store: a finished routine reports one paragraph to MoMo's main chat and its chat is archived; a run given up on (quiet, too long) is stopped, not only marked; one cut short says so; each MoPilot handles only its own runs (pid and start time); a run's chat is deleted before MoMo forgets the run; a coding chat finishing touches nothing of MoMo's.
import './support/tz-la.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, scratch, clock } from './support/momo-fixtures.ts';

const require = createRequire(import.meta.url);
const { RoutineRuns, ownerAlive, IDLE_MS, MAX_RUN_MS, CHAT_KEEP_MS } = require('../electron/momo/routineRuns.cjs');
const { RoutineStore } = require('../electron/momo/routineStore.cjs');
const { SessionStore } = require('../electron/session/state.cjs');

const START = new Date(2030, 2, 11, 9).getTime();
const sweep = { name: 'Inbox sweep', prompt: 'Summarize what needs a reply.', rrule: 'FREQ=DAILY;BYHOUR=9' };
const ME = { pid: 100, started: 1000 };

function world(o: { dir?: string; by?: { pid: number; started: number }; alive?: (by: any) => Promise<boolean> } = {}) {
  const dir = o.dir ?? scratch();
  const safe = fakeSafe();
  const c = clock(START);
  const routines = new RoutineStore({ dir, safeStorage: safe, now: c.now });
  const sessions = new SessionStore();
  const reports: any[] = [];
  const chats: any[] = [];
  const make = (p: { by: { pid: number; started: number }; alive: (by: any) => Promise<boolean> }) =>
    new RoutineRuns({
      routines,
      sessions,
      report: async (r: any) => reports.push(r),
      now: c.now,
      process: p,
      stopChat: async (id: string) => chats.push(['stop', id]),
      archiveChat: async (id: string) => chats.push(['archive', id]),
      discardChat: async (id: string) => chats.push(['discard', id]),
    });
  const runs = make({ by: o.by ?? ME, alive: o.alive ?? (async () => false) });
  /** A run this MoPilot started, its turn going. */
  const start = async (chatId: string, taskId: string, kind = 'momo-routine', extra: object = {}) => {
    await runs.begin({ chatId, taskId, kind, due: c.t, ...extra });
    sessions.patch(chatId, { turn: 'running' });
  };
  const told = () => reports.map((r: any) => [r.name, r.completed, r.text]);
  return { runs, routines, sessions, c, reports, chats, start, told, make, dir };
}

test('a finished routine posts its first paragraph and its chat is archived; one that didn’t finish, or had nothing to say, says so', async () => {
  const w = world();
  const r = await w.routines.add(sweep, { approved: true });
  await w.start('m1', r.id);
  await w.runs.finished({ chatId: 'm1', text: 'Two need a reply:\nAna, Raj.\n\nMore below.', completed: true });
  await w.runs.finished({ chatId: 'm1', text: 'again', completed: true });
  assert.deepEqual(w.told(), [['Inbox sweep', true, 'Two need a reply: Ana, Raj.']]);
  assert.equal(w.routines.openRun('m1'), null);
  assert.deepEqual(w.chats, [['archive', 'm1']]);
  w.c.t += 1;
  await w.start('m2', r.id);
  await w.runs.finished({ chatId: 'm2', completed: false });
  w.c.t += 1;
  await w.start('m3', r.id);
  await w.runs.crashed('m3');
  await w.runs.crashed('m3');
  w.c.t += 1;
  await w.start('m4', r.id);
  await w.routines.remove(r.id);
  await w.runs.finished({ chatId: 'm4', text: '  ', completed: true });
  assert.deepEqual(w.told().slice(1), [
    ['Inbox sweep', false, 'The run didn’t finish.'],
    ['Inbox sweep', false, 'The run didn’t finish.'],
    ['A routine', true, 'Finished with nothing to say.'],
  ]);
});

test('each MoPilot handles its own runs: another live one’s is left; a quit one’s, a reused pid’s, or one from before owners was cut short', async () => {
  const w = world();
  const r = await w.routines.add(sweep, { approved: true });
  await w.start('m1', r.id);
  const seen: any[] = [];
  const other = w.make({ by: { pid: 200, started: 2000 }, alive: async (by: any) => (seen.push(by), by.pid === 100) });
  await other.check();
  await other.finished({ chatId: 'm1', text: 'not mine', completed: true });
  assert.ok(w.routines.openRun('m1'), 'its MoPilot still runs');
  assert.deepEqual(seen, [ME], 'judged by the pid and start time it recorded');
  assert.deepEqual(w.told(), []);
  // MoPilot 100 quit: the next one ends its run
  const next = w.make({ by: { pid: 300, started: 3000 }, alive: async () => false });
  await next.check();
  assert.deepEqual(w.told(), [['Inbox sweep', false, 'MoPilot closed during the run.']]);
  // this process's own record from before a restart (same pid and start), and a record from before runs had owners
  await w.routines.beginRun({ chatId: 'same', taskId: r.id, kind: 'momo-routine', due: 1, by: { pid: 300, started: 3000 } });
  await w.routines.beginRun({ chatId: 'legacy', taskId: r.id, kind: 'momo-routine', due: 1 });
  await next.check();
  assert.deepEqual(w.routines.openRuns(), []);
});

test('a turn gone quiet or a run going too long is stopped (its approvals denied), then ends saying why; a chat that is gone just ends', async () => {
  const w = world();
  const r = await w.routines.add(sweep, { approved: true });
  await w.start('quiet', r.id);
  w.sessions.patch('quiet', { turn: 'idle' });
  w.c.t += IDLE_MS - 1;
  await w.runs.check();
  assert.ok(w.routines.openRun('quiet'), 'idle, but not for long');
  w.c.t += 1;
  await w.runs.check();
  assert.deepEqual(w.told()[0], ['Inbox sweep', false, 'The run stopped without finishing.']);
  assert.deepEqual(w.chats.slice(0, 2), [
    ['stop', 'quiet'],
    ['archive', 'quiet'],
  ]);
  await w.start('slow', r.id);
  w.sessions.patch('slow', { approvals: [{ id: 'never answered' }], turn: 'awaitingUser' });
  w.c.t += MAX_RUN_MS - 1;
  await w.runs.check();
  assert.ok(w.routines.openRun('slow'));
  w.c.t += 1;
  await w.runs.check();
  assert.equal(w.routines.openRun('slow'), null);
  assert.ok(w.chats.some((c: any) => c[0] === 'stop' && c[1] === 'slow'));
  assert.match(w.told()[1][2], /took too long, so it was stopped/);
  await w.runs.begin({ chatId: 'no-session', taskId: r.id, kind: 'momo-routine', due: 1 });
  await w.runs.check();
  assert.equal(w.routines.openRun('no-session'), null);
  assert.ok(!w.chats.some((c: any) => c[0] === 'stop' && c[1] === 'no-session'), 'nothing to stop');
});

test('a run’s chat is deleted before MoMo forgets the run, once; a full day records nothing', async () => {
  const w = world();
  const r = await w.routines.add(sweep, { approved: true });
  await w.start('m1', r.id);
  await w.runs.finished({ chatId: 'm1', text: 'Done.', completed: true });
  w.c.t += CHAT_KEEP_MS - 1;
  await w.runs.check();
  assert.ok(!w.chats.some((c: any) => c[0] === 'discard'));
  w.c.t += 2;
  await w.runs.check();
  await w.runs.check();
  assert.deepEqual(
    w.chats.filter((c: any) => c[0] === 'discard'),
    [['discard', 'm1']],
  );
  assert.equal(await w.runs.begin({ chatId: 'over', taskId: r.id, kind: 'momo-routine', due: 1 }, { limit: 0 }), null);
  assert.deepEqual(w.routines.openRuns(), []);
  // without archive or discard hooks, a run still ends
  const bare = new RoutineRuns({
    routines: w.routines,
    sessions: w.sessions,
    report: async () => {},
    now: w.c.now,
    process: { by: ME, alive: async () => false },
    stopChat: async () => {},
  });
  await bare.begin({ chatId: 'b1', taskId: r.id, kind: 'momo-routine', due: 1 });
  await bare.finished({ chatId: 'b1', text: 'ok', completed: true });
  w.c.t += CHAT_KEEP_MS + 1;
  await bare.check();
  assert.equal(w.routines.endedBefore(w.c.t).length, 0);
});

test('a run that didn’t get going closes with nothing told', async () => {
  const w = world();
  await w.start('m1', 'momo.r1');
  await w.runs.close('m1');
  await w.runs.close('never');
  assert.deepEqual(w.routines.openRuns(), []);
  assert.deepEqual(w.told(), []);
  await w.runs.finished({ chatId: 'm1', text: 'late', completed: true });
  assert.deepEqual(w.told(), [], 'closed runs are no longer this MoPilot’s');
  // another MoPilot ended this one's run (it took this one for closed): the finish finds no run
  await w.start('m5', 'momo.r1');
  await w.routines.endRun('m5', 'interrupted');
  await w.runs.finished({ chatId: 'm5', text: 'late', completed: true });
  assert.deepEqual(w.told(), []);
});

test('a coding chat finishing or crashing reads and makes nothing of MoMo’s', async () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momo-none-')), 'momo');
  const w = world({ dir });
  await w.runs.finished({ chatId: 'coding-1', text: 'x', completed: true });
  await w.runs.crashed('coding-2');
  assert.equal(fs.existsSync(dir), false);
});

test('whether another MoPilot still runs: a live pid that started when it said; a gone or reused pid is not', async () => {
  const me = new RoutineRuns({});
  const by = await me.proc.by;
  assert.equal(by.pid, process.pid);
  assert.equal(me.now, Date.now);
  assert.equal(await ownerAlive(by), true);
  assert.equal(await ownerAlive({ pid: process.pid, started: by.started - 3_600_000 }), false, 'the pid now belongs to another start');
  assert.equal(await ownerAlive({ pid: 2 ** 22 + 12345, started: 1 }), false);
  // a core that can't say when it started leaves it running, whatever it recorded
  assert.equal(await ownerAlive({ pid: process.pid, started: 1 }, async () => null), true);
  // launchd (pid 1, root): alive, and its start can be read or not; either way not taken for gone
  assert.equal(typeof (await ownerAlive({ pid: 1, started: 0 })), 'boolean');
});

test('a stop that finishes the turn doesn’t end a given-up run twice; after Reset an open run writes nothing back', async () => {
  const w = world();
  const r = await w.routines.add(sweep, { approved: true });
  await w.start('slow', r.id);
  // the controller's stop ends the turn at once, and its finish hook fires before the stop resolves
  w.runs.o.stopChat = async (id: string) => {
    await w.runs.finished({ chatId: id, text: 'Half done.', completed: true });
  };
  w.c.t += MAX_RUN_MS;
  await w.runs.check();
  assert.deepEqual(w.told(), [['Inbox sweep', false, 'The run took too long, so it was stopped.']], 'one entry, the give-up’s');
  // Reset MoMo while a run is open: its finish finds no run and writes nothing
  await w.start('open', r.id);
  await w.routines.erase();
  await w.runs.finished({ chatId: 'open', text: 'Done.', completed: true });
  await w.runs.check();
  assert.deepEqual(fs.readdirSync(w.dir), [], 'nothing written back');
});
