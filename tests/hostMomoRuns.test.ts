// MoMo's routine runs on a Host, H3b (host/src/momoRuns.mjs, momoPrefs.mjs, momoChats.startBackground, protocol.asHost): a routine fires from the Host's tick with no app open, runs as a turn in a fresh MoMo chat in the workspace with its approvals waiting, its result is told to MoMo's main chat, a run the Host stopped under is told as not finished, and what MoMo may not do stays refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
// @ts-ignore: plain ESM without declarations
import { createMomoHome } from '../host/src/momoHome.mjs';
// @ts-ignore
import { MOMO_FORM } from '../host/src/momoChats.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
// @ts-ignore
import { helloParams } from '../shared/host/schema.mjs';
// @ts-ignore
import { createMomoScheduler } from '../host/src/momoScheduler.mjs';
// @ts-ignore
import { scheduleRules } from '../shared/schedule.mjs';
import rrule from 'rrule';
import { waitFor } from './support/waitFor.ts';
import { servedHost } from './support/hostClientsWorld.ts';
import { MOMO, world, turn } from './support/host/momoRunsKit.ts';

test('a routine fires from the Host’s tick with no app open: a fresh MoMo chat in the workspace with the routine’s words, its approvals waiting, and its result told to MoMo’s main chat', async (t) => {
  const w = await world(t);
  await w.home.prefs.change({ proactivity: 'default', quietHours: null });
  await w.routine();
  await w.scheduler.tick();
  assert.deepEqual((await w.minute())?.ran, [w.stores().routines.list()[0].id]);
  const run = w.sends.at(-1);
  assert.match(run.key, MOMO_FORM, 'the run’s chat is one of MoMo’s by its id');
  assert.notEqual(run.key, w.main.chatId, 'and not the main chat');
  assert.equal(run.cwd, w.chats.workspace);
  assert.match(run.text, /Say what is new\./);
  assert.equal(w.records.get(run.key).meta.momo, 'routine');
  assert.equal(w.chats.isMomoChat(run.key), true);
  // the run ends: what it said goes to MoMo's main chat, and the run is over
  turn(w, run.key, 'Nothing new today.');
  await waitFor(() => w.sends.length === 2, 'the report to the main chat');
  const report = w.sends[1];
  assert.equal(report.key, w.main.chatId);
  assert.match(report.text, /“Morning” finished/);
  assert.match(report.text, /Nothing new today\./);
  assert.equal(w.stores().routines.openRuns().length, 0, 'the run is closed');
  assert.equal((await w.scheduler.tick())?.ran.length, 0, 'the same minute does not run twice');
});

test('nothing runs for a routine the user has not approved, in quiet hours, when paused, or when MoMo is off', async (t) => {
  const w = await world(t);
  await w.routine({ name: 'Proposed' }, false);
  const routine = (await w.routine({ name: 'Approved' }))!;
  await w.home.prefs.change({ proactivity: 'default', quietHours: null, paused: true });
  await w.scheduler.tick();
  // paused: the time is declined; a proposal is listed paused and never scheduled, whatever the settings
  const paused = await w.minute();
  assert.deepEqual([paused?.ran, paused?.skipped], [[], [routine.id]]);
  await w.home.prefs.change({ paused: false, proactivity: 'off' });
  assert.deepEqual((await w.minute())?.ran, [], 'off lists nothing');
  // quiet hours that cover now: a time that comes is declined, whether it is a new one or one caught up when MoMo came back on
  const d = new Date(w.clock.now());
  const at = (m: number) => {
    const day = ((m % 1440) + 1440) % 1440;
    return `${String(Math.floor(day / 60)).padStart(2, '0')}:${String(day % 60).padStart(2, '0')}`;
  };
  const nowMin = d.getHours() * 60 + d.getMinutes();
  await w.home.prefs.change({ proactivity: 'default', quietHours: { start: at(nowMin - 120), end: at(nowMin + 120) } });
  await w.scheduler.tick();
  const quietOut = await w.minute();
  assert.deepEqual([quietOut?.ran, quietOut?.skipped.includes(routine.id)], [[], true]);
  assert.deepEqual(
    w.sends.map((s) => s.key),
    [],
    'no chat was started, and nothing was told to MoMo’s main chat',
  );
  assert.equal(w.reports.filter((m) => /skipped/i.test(m)).length, 0, 'a skipped time says nothing');
});

test('a run that cannot start is told to MoMo’s main chat once, and a Host that stopped under a run tells it as not finished', async (t) => {
  const w = await world(t);
  await w.home.prefs.change({ proactivity: 'default', quietHours: null });
  const routine = (await w.routine())!;
  await w.scheduler.tick();
  w.failSend(true);
  const failed = await w.minute();
  assert.deepEqual(failed?.failed, [routine.id]);
  await waitFor(() => w.sends.some((s) => s.key === w.main.chatId), 'the report of the failure');
  w.failSend(false);
  assert.match(w.sends.find((s) => s.key === w.main.chatId).text, /didn’t finish/);
  // the next run starts, and the Host stops with it under way
  w.sends.length = 0;
  await w.minute();
  const run = w.sends.at(-1);
  assert.ok(run && run.key !== w.main.chatId, 'a run is under way');
  const second = w.scheduler;
  // a Host that starts again reads the start with no end: the run ends as cut short and MoMo’s chat is told
  const again = createMomoScheduler({
    home: w.home,
    rules: scheduleRules(rrule.RRule),
    clock: w.clock,
    report: (m: string) => w.reports.push(m),
  });
  const { createMomoRuns } = await import('../host/src/momoRuns.mjs');
  const rebuilt = createMomoRuns({
    home: w.home,
    protocol: w.protocol,
    events: new EventEmitter(),
    state: { has: () => false, get: () => undefined },
    harnesses: async () => [{ id: 'claude', detected: true, signedIn: true }],
    report: () => undefined,
    now: w.clock.now,
  });
  again.setSource(rebuilt.source);
  w.sends.length = 0;
  const cut = await again.recover();
  assert.equal(second === again, false);
  assert.equal(cut.length, 0, 'the run’s start was recorded as run; it went on in its chat');
  await waitFor(() => w.sends.some((s) => s.key === w.main.chatId), 'the report of the cut-off run');
  assert.match(w.sends.find((s) => s.key === w.main.chatId).text, /didn’t finish/);
  assert.equal(w.stores().routines.openRuns().length, 0);
});

test('the Host refuses what MoMo may not run on, and the prefs a client sends are checked', async (t) => {
  const w = await world(t);
  assert.throws(() => w.chats.startBackground('not-an-agent', 'routine'), /not an agent MoMo can use/);
  assert.match(w.chats.startBackground('claude', 'routine'), MOMO_FORM);
  assert.equal(w.chats.main()?.chatId, w.main.chatId);
  assert.deepEqual(await w.home.prefs.change({ proactivity: 'high', quietHours: { start: '22:00', end: '06:30' }, paused: true }), {
    proactivity: 'high',
    quietHours: { start: '22:00', end: '06:30' },
    paused: true,
    brief: { on: false, time: undefined, zone: undefined },
    notify: { previews: false, tellNowMax: 6 },
  });
  assert.equal(w.home.prefs.forRoutines().momo.paused, true);
  // a harness that is not signed in on this machine is not one a routine can run on
  const unsigned = await world(t, { signedIn: false });
  await unsigned.home.prefs.change({ proactivity: 'default', quietHours: null });
  const routine = (await unsigned.routine())!;
  await unsigned.scheduler.tick();
  const out = await unsigned.minute();
  assert.deepEqual(out?.failed, [routine.id]);
  assert.equal(unsigned.sends.filter((s) => s.key !== unsigned.main.chatId).length, 0);
});

test('through the server, a connection that presented the home’s account sets and reads MoMo’s prefs; a bad value is refused, and one that presented nothing gets a request no Host knows', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-prefs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: path.join(dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(dir, 'config')),
  });
  const host = await servedHost(t, { momo: home });
  const a = await host.paired('a', 'A');
  await a.conn.request('host.momoGrant', { account: 'a1', features: MOMO });
  await a.conn.request('host.hello', helloParams());
  assert.deepEqual(await a.conn.request('host.momoPrefs', {}), {
    proactivity: 'default',
    paused: false,
    brief: { on: false },
    notify: { previews: false, tellNowMax: 6 },
  });
  assert.deepEqual(
    await a.conn.request('host.momoPrefs', { proactivity: 'low', quietHours: { start: '21:30', end: '07:00' }, paused: true }),
    {
      proactivity: 'low',
      quietHours: { start: '21:30', end: '07:00' },
      paused: true,
      brief: { on: false },
      notify: { previews: false, tellNowMax: 6 },
    },
  );
  assert.deepEqual((await a.conn.request('host.momoPrefs', { quietHours: null })).quietHours, null);
  for (const bad of [{ proactivity: 'loud' }, { quietHours: { start: '25:00', end: '07:00' } }, { quietHours: 5 }, { paused: 'yes' }])
    await assert.rejects(a.conn.request('host.momoPrefs', bad), (e: any) => e.code === 'invalid');
  await home.close();
});
