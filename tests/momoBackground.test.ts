// MoMo's background work in main (electron/app/momoBackground.cjs): routines in the app's scheduler, how a routine's result
// reaches MoMo's main chat, and MoMo's notices, over the services app/momo.cjs made; its chats quiet on the coding side; a
// turn's end, a harness's quit, a revoke and Pause reach them; the files of the removed Feed and Topics are deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world } from './support/momoAppWorld.ts';
import { tick } from './support/async-scenarios.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { valueHandle, PAUSED_TEXT } = require('../electron/app/momoBackground.cjs');
const { setMomoContextProvider } = require('../electron/momo/contract/context.cjs');
const { whileResetting, resetMomoStores } = require('../electron/momo/stores.cjs');

/** Waits until `ok()` (a store write is on disk), at most a second. */
const until = async (ok: () => boolean) => {
  await waitFor(ok, 'the store write');
  assert.ok(ok(), 'in time');
};
/** Time for an offer that would write to have written (one that writes nothing has nothing to wait for). */
const settled = (_w: any) => new Promise((r) => setTimeout(r, 50));
const momoChat = (w: any, id: string, meta: any) =>
  w.chats.commit({ id, segments: [{ kind: 'claude', nativeId: id, start: 0, count: null }], meta });
const done = async (w: any) => {
  await w.m.close();
  setMomoContextProvider(null);
};

test('routines run in the app’s scheduler; their IPC and tool are registered, and no Feed or Topics are', async () => {
  const w = world({ allowed: true });
  assert.equal(w.live.momoRoutines, w.m.routines);
  for (const ch of ['momoRoutines:view', 'momoRoutines:approve', 'momoRoutines:edit', 'momoRoutines:remove', 'momoChat:greet'])
    assert.ok(w.handlers.has(ch), ch);
  assert.ok(w.live.capabilities.has('momo_routine_propose'));
  for (const ch of ['momoFeed:view', 'momoTopics:view']) assert.equal(w.handlers.has(ch), false, ch);
  for (const t of ['momo_feed_post', 'momo_topic_start', 'momo_topic_report']) assert.equal(w.live.capabilities.has(t), false, t);
  // what MoMo's background work hands the app: the routines' stores and services, the notices and the prefs hook
  for (const k of ['routineStore', 'routines', 'notices', 'prefsChanged']) assert.ok(k in w.m, k);
  for (const k of ['feed', 'topics', 'composer', 'timers']) assert.equal(k in w.m, false, k);
  await done(w);
});

test('MoMo’s chats are quiet on the coding side; one waiting for an approval says “MoMo needs you”', async () => {
  const w = world({ allowed: true });
  momoChat(w, 'mc', { momo: 'main' });
  momoChat(w, 'cc', {});
  const q = w.live.notifier.quiet;
  assert.equal(q('approval', 'cc'), false);
  assert.equal(q('turn', 'mc'), true);
  assert.equal(w.live.notifier.shown.length, 0, 'a turn’s end is no notice');
  assert.equal(q('approval', 'mc'), true);
  assert.deepEqual(
    w.live.notifier.shown.map((s: any) => [s[0], s[1], s[2].viewing]),
    [['momo', 'momo:chat:mc', false]],
  );
  // clicking it opens MoMo at the chat; another notice is main's
  assert.equal(w.m.notices.click('momo:chat:mc'), true);
  assert.deepEqual(w.opened.at(-1), 'momo');
  assert.equal(w.m.notices.click('chat-1'), false);
  w.inView = 'mc';
  q('approval', 'mc');
  assert.equal(w.live.notifier.shown.at(-1)[2].viewing, true, 'the chat open in a focused window');
  await done(w);
});

test('what the routines service is given: background chats, the brain, sending, archiving and forgetting a run', async () => {
  const w = world({ allowed: true, prefs: { momo: { brain: { main: { harness: 'claude' }, topics: { harness: 'codex' } } } } });
  // an older build's per-role brain is folded away at startup: routines run on MoMo's one brain
  assert.deepEqual(w.prefs.momo.brain, { main: { harness: 'claude', account: null, model: null, modelLabel: null } });
  const r = w.m.routines.o;
  assert.deepEqual(r.mainBrain().harness, 'claude');
  assert.equal(await r.usable('claude'), true);
  assert.equal(await r.usable('acp:kimi'), false);
  const chatId = await r.startChat({ harness: 'claude' }, { momo: 'routine', routineId: 'momo.r1' });
  assert.equal(w.chats.record(chatId).meta.routineId, 'momo.r1');
  await r.stopChat(chatId);
  assert.deepEqual(w.live.controller.stopped, [chatId]);
  await r.discardChat(chatId);
  assert.ok(w.deleted.includes(chatId));
  r.archiveChat(chatId);
  assert.deepEqual(w.live.archived, [chatId]);
  r.forget('momo.r1');
  await r.send(chatId, { id: 'i1', text: 'go' });
  assert.deepEqual(w.ran, [[chatId, { id: 'i1', text: 'go' }]]);
  w.live.chatDeletion = undefined;
  assert.equal(r.discardChat('x'), undefined, 'no deletion before the chats are open');
  await done(w);
});

test('a turn’s end reaches the runs, and a MoMo chat’s notice goes; a failing step is noted and stops no other', async () => {
  const w = world({ allowed: true });
  const ctl = w.live.controller;
  momoChat(w, 'mc', { momo: 'main' });
  momoChat(w, 'cc', {});
  const cleared: string[] = [];
  w.live.notifier.clear = (k: string) => void cleared.push(k);
  const ended: any[] = [];
  w.m.routines.finished = async (e: any) => void ended.push(['finished', e.chatId]);
  w.m.routines.crashed = async (id: string) => void ended.push(['crashed', id]);
  await ctl.onFinished({ chatId: 'mc' });
  await ctl.onFinished({ chatId: 'cc' });
  await ctl.onCrash('cc');
  assert.deepEqual(ended, [
    ['finished', 'mc'],
    ['finished', 'cc'],
    ['crashed', 'cc'],
  ]);
  assert.deepEqual(cleared, ['momo:chat:mc'], 'only a MoMo chat’s “needs you” goes');
  w.m.routines.finished = async () => {
    throw new Error('disk');
  };
  w.m.routines.crashed = async () => {
    throw new Error('disk');
  };
  await ctl.onFinished({ chatId: 'mc' });
  assert.deepEqual(cleared, ['momo:chat:mc', 'momo:chat:mc'], 'a failing step stops no other');
  await ctl.onCrash('mc');
  await done(w);
});

test('MoMo’s main chat proposes a routine through its tool: it waits in Settings, the page reads again, Approve lists it as a routine', async () => {
  const w = world({ allowed: true });
  w.chats.commit({ id: 'mc', segments: [{ kind: 'claude', nativeId: 's1', start: 0, count: null }], meta: { momo: 'main' } });
  const before = w.broadcasts.length;
  const r = await w.live.capabilities.invoke('mc', 'claude:s1', 'momo_routine_propose', {
    name: 'Files check',
    prompt: 'Tell me if anything in my Files folder changed.',
    time: '09:00',
    sources: ['files'],
  });
  assert.equal(r.ok, true);
  // Files isn't connected in this world: the model is told where the user connects it
  assert.match(r.content[0].text, /waits in Settings › MoMo › Routines.*Files isn't connected yet/);
  assert.ok(w.broadcasts.slice(before).some(([c]: any) => c === 'momoRoutines:changed'));
  const view = await w.call('momoRoutines:view');
  assert.deepEqual(
    view.proposals.map((p: any) => [p.name, p.sources]),
    [['Files check', 'Files']],
  );
  assert.deepEqual(view.routines, [], 'not before Approve');
  await w.call('momoRoutines:approve', view.proposals[0].id, view.proposals[0].rev);
  const after = await w.call('momoRoutines:view');
  assert.deepEqual(after.proposals, []);
  assert.deepEqual(
    after.routines.map((x: any) => x.name),
    ['Files check'],
  );
  // a coding chat never gets it
  w.chats.commit({ id: 'cc', segments: [{ kind: 'claude', nativeId: 's2', start: 0, count: null }], meta: {} });
  assert.equal(
    (await w.live.capabilities.invoke('cc', 'claude:s2', 'momo_routine_propose', { name: 'x', prompt: 'y', time: '09:00' })).ok,
    false,
  );
  await done(w);
});

test('a routine proposal tells the model a source macOS refuses is not connected yet; one macOS allows is', async () => {
  const w = world({ allowed: true });
  w.chats.commit({ id: 'mc', segments: [{ kind: 'claude', nativeId: 's1', start: 0, count: null }], meta: { momo: 'main' } });
  w.m.sources.hub.connect('calendar');
  w.m.sources.hub.connect('reminders');
  w.m.sources.hub.markUngranted('reminders');
  const r = await w.live.capabilities.invoke('mc', 'claude:s1', 'momo_routine_propose', {
    name: 'Day plan',
    prompt: 'Plan my day.',
    time: '07:30',
    sources: ['calendar', 'reminders'],
  });
  assert.equal(r.ok, true);
  assert.match(r.content[0].text, /Reminders isn't connected yet/);
  assert.doesNotMatch(r.content[0].text, /Calendar (isn't|aren't)|Calendar, Reminders (isn't|aren't)/);
  await done(w);
});

test('setup’s starter routines are proposed once setup is done: at startup, on the prefs change that finishes it, when MoMo is allowed again; once each', async () => {
  const picked = { onboarding: { done: true, step: 0 }, routines: { starter: ['bills'] } };
  // at startup, setup already done
  const w = world({ allowed: true, prefs: { momo: picked } });
  await until(() => w.m.routineStore.list().length > 0);
  assert.deepEqual(
    w.m.routineStore.list().map((r: any) => [r.name, r.approved]),
    [['Bill reminders', false]],
  );
  await until(() => w.broadcasts.some(([c]: any) => c === 'momoRoutines:changed'));
  await done(w);
  // setup not done at startup; the change that finishes it proposes, a later one doesn't again
  const s = world({ allowed: true, prefs: { momo: { routines: { starter: ['weekAhead'] } } } });
  await settled(s);
  assert.deepEqual(s.m.routineStore.list(), []);
  const told = () => s.broadcasts.filter(([c]: any) => c === 'momoRoutines:changed').length;
  const finished = { momo: { onboarding: { done: true, step: 0 }, routines: { starter: ['weekAhead'] } } };
  s.m.prefsChanged(finished);
  await until(() => s.m.routineStore.list().length > 0 && told() === 1);
  assert.deepEqual(
    s.m.routineStore.list().map((r: any) => r.name),
    ['Week ahead'],
  );
  await settled(s);
  const n = told();
  s.m.prefsChanged(finished);
  await settled(s);
  assert.equal(s.m.routineStore.list().length, 1);
  assert.equal(told(), n, 'nothing new: the page isn’t told');
  // MoMo allowed again: offered again (each once), nothing new
  s.prefs = { ...s.prefs, momo: { ...finished.momo, routines: { quietHours: null, starter: ['weekAhead', 'morningFeed'] } } };
  for (const cb of s.access) cb(true);
  await until(() => s.m.routineStore.list().length > 1);
  assert.deepEqual(
    s.m.routineStore.list().map((r: any) => r.name),
    ['Week ahead', 'Morning briefing'],
  );
  assert.equal(s.m.routineStore.list()[1].rrule, 'FREQ=DAILY;BYHOUR=8;BYMINUTE=0;BYSECOND=0');
  await done(s);
});

test('no starter is proposed while MoMo is paused or being reset (a reset pauses it first); Resume proposes them', async () => {
  const picked = { onboarding: { done: true, step: 0 }, routines: { quietHours: null, starter: ['bills'] } };
  const w = world({ allowed: true, prefs: { momo: { ...picked, paused: true } } });
  await settled(w);
  assert.deepEqual(w.m.routineStore.list(), [], 'paused at startup');
  // a reset under way, MoMo not paused (yet): still nothing
  w.prefs = { ...w.prefs, momo: picked };
  await whileResetting(async () => {
    w.m.prefsChanged(w.prefs);
    await settled(w);
  });
  assert.deepEqual(w.m.routineStore.list(), [], 'while resetting');
  // Resume
  w.m.prefsChanged(w.prefs);
  await until(() => w.m.routineStore.list().length > 0);
  assert.deepEqual(
    w.m.routineStore.list().map((r: any) => r.name),
    ['Bill reminders'],
  );
  await done(w);
});

test('the sources hub holds a routine’s run to its routine’s sources; a routine that is gone reads none, other chats aren’t held', async () => {
  const w = world({ allowed: true });
  const reads = await w.m.routineStore.add(
    { name: 'Files check', prompt: 'p', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0', sources: ['files'] },
    { approved: true },
  );
  const old = await w.m.routineStore.add({ name: 'Old', prompt: 'p', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' }, { approved: true });
  await w.m.routineStore.json.change((s: any) => void delete s.routines.find((r: any) => r.id === old.id).sources);
  momoChat(w, 'run', { momo: 'routine', routineId: reads.id });
  momoChat(w, 'old-run', { momo: 'routine', routineId: old.id });
  momoChat(w, 'gone-run', { momo: 'routine', routineId: 'momo.gone' });
  momoChat(w, 'main', { momo: 'main' });
  // a run whose chat record is gone is matched by its open run
  await w.m.routineStore.beginRun({ chatId: 'no-record', taskId: reads.id, kind: 'momo-routine', due: 0 });
  const scope = (id: string) => w.m.sources.hub.scope(id);
  assert.deepEqual(await scope('run'), { sources: ['files'], name: 'Files check' });
  assert.deepEqual(await scope('no-record'), { sources: ['files'], name: 'Files check' });
  assert.deepEqual(await scope('old-run'), { sources: [], name: 'Old' });
  assert.deepEqual(await scope('gone-run'), { sources: [], name: null });
  for (const id of ['main', 'nobody']) assert.equal(await scope(id), null, id);
  await done(w);
});

test('without a controller or a registry: no hooks and no tools', async () => {
  const w = world({ allowed: true, controller: false, capabilities: false });
  assert.equal(w.live.controller, null);
  await done(w);
});

test('access off stops the runs and closes the notices; access back stops nothing', async () => {
  const w = world({ allowed: true });
  const calls: string[] = [];
  w.m.routines.revoked = async () => void calls.push('runs');
  let closed = 0;
  w.live.notifier.clearMatching = () => void closed++;
  for (const cb of w.access) cb(false);
  await tick();
  assert.deepEqual(calls, ['runs']);
  assert.equal(closed, 1);
  w.allowed = true;
  for (const cb of w.access) cb(true);
  await tick();
  assert.deepEqual(calls, ['runs'], 'access back stops nothing');
  await done(w);
});

test('Pause stops the routine runs, each saying so; Resume stops nothing; nothing while MoMo is off', async () => {
  const w = world({ allowed: true });
  const calls: string[] = [];
  w.m.routines.giveUp = async (chatId: string, why: string) => void calls.push(`giveUp ${chatId} ${why}`);
  w.m.routines.mine.add('run-1');
  w.m.prefsChanged({ momo: {} });
  w.m.prefsChanged({ momo: { paused: true } });
  w.m.prefsChanged({ momo: { paused: true } });
  await tick();
  w.m.prefsChanged(undefined);
  await tick();
  assert.deepEqual(calls, [`giveUp run-1 ${PAUSED_TEXT}`]);
  calls.length = 0;
  w.allowed = false;
  w.m.prefsChanged({ momo: { paused: true } });
  w.m.prefsChanged({ momo: {} });
  await tick();
  assert.deepEqual(calls, [], 'MoMo off: Pause writes nothing');
  await done(w);
});

test('main’s handle for the routines IPC: a value, or the error with its code', async () => {
  const handlers = new Map<string, any>();
  const handle = valueHandle({ handle: (ch: string, fn: any) => handlers.set(ch, fn) });
  handle('a', (x: number) => x + 1);
  handle('b', () => {
    throw Object.assign(new Error('no'), { code: 'bad_args' });
  });
  handle('c', () => {
    throw 'plain';
  });
  assert.deepEqual(await handlers.get('a')({}, 1), { value: 2 });
  assert.deepEqual(await handlers.get('b')({}), { error: { message: 'no', code: 'bad_args' } });
  assert.deepEqual(await handlers.get('c')({}), { error: { message: 'plain', code: null } });
});

test('MoMo’s main chat is held while its brain is known to be out and its rule is Pause (#2306)', async () => {
  const w = world({ allowed: true });
  w.m.mainChat.current = () => 'mc';
  w.prefs.momo = { ...w.prefs.momo, brain: { main: { harness: 'claude', account: 'du@work', model: null } }, atLimit: 'pause' };
  const out = [{ account: 'du@work', kind: 'harnessAuth', billing: 'subscription', status: 'ok', limited: true }];
  assert.equal(w.live.heldChat('mc'), null, 'not known to be out');
  w.live.identity.instances = (h: string) => (h === 'claude' ? out : []);
  assert.equal(w.live.heldChat('mc'), 'MoMo is paused: Claude Code is at its limit.');
  assert.equal(w.live.heldChat('other'), null, 'only MoMo’s main chat');
  w.prefs.momo.brain = {};
  assert.equal(w.live.heldChat('mc'), null, 'no brain yet');
  w.allowed = false;
  assert.equal(w.live.heldChat('mc'), null, 'MoMo off');
  await done(w);
});

test('an input MoMo sends no human wrote is saved in its chat’s meta and every window hears it before it is sent (#2287)', async () => {
  const w = world({ allowed: true });
  momoChat(w, 'mc', { momo: 'main' });
  const item = w.m.routines.o.authored('mc', 'for the model', { by: 'momo', title: '“Bills” finished' });
  assert.deepEqual([item.text, item.opts, item.authored], ['for the model', { human: false }, { id: item.id }]);
  const told = w.broadcasts.find(([c]: any) => c === 'chats:changed');
  assert.equal(told?.[1].id, 'mc');
  assert.equal(told?.[1].chat.meta.authored[item.id].title, '“Bills” finished');
  await done(w);
});

/** A world with MoMo’s main chat made and a routine with a run of its own open, ready to end. */
async function runningRoutine(o: { paused?: boolean } = {}) {
  const w = world({ allowed: true, prefs: { momo: { brain: { main: { harness: 'claude' } }, paused: o.paused === true } } });
  const main = (await w.call('momoChat:mainChat')).value.chatId;
  const routine = await w.m.routineStore.add(
    { name: 'Bills', prompt: 'Check bills', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
    { approved: true },
  );
  momoChat(w, 'run-1', { momo: 'routine', routineId: routine.id });
  await w.m.routines.begin({ chatId: 'run-1', taskId: routine.id, kind: 'momo-routine', due: 0 });
  w.ran.length = 0;
  return { w, main, routine };
}

test('a finished run sends its paragraph to MoMo’s main chat as one message no human wrote, then the run’s chat is archived', async () => {
  const { w, main } = await runningRoutine();
  await w.live.controller.onFinished({ chatId: 'run-1', completed: true, text: 'Two bills are due: rent and power.' });
  assert.equal(w.ran.length, 1, 'one message');
  const [chatId, item] = w.ran[0];
  assert.equal(chatId, main);
  assert.match(item.text, /“Bills” finished/);
  assert.match(item.text, /Two bills are due: rent and power\./);
  assert.deepEqual(item.opts, { human: false });
  // windows hear the chat's meta first, and it shows the card MoMo’s way: the routine's name and its paragraph
  const shown = w.chats.record(main).meta.authored[item.authored.id];
  assert.deepEqual([shown.title, shown.body], ['“Bills” finished', 'Two bills are due: rent and power.']);
  assert.ok(w.broadcasts.some(([c, p]: any) => c === 'chats:changed' && p.id === main));
  assert.deepEqual(w.live.archived, ['run-1']);
  await done(w);
});

test('a routine whose run didn’t start is told to MoMo’s main chat once, with why', async () => {
  const { w, main } = await runningRoutine();
  await w.m.routines.failed({ id: 'momo.x', name: 'Bills' }, new Error('The harness could not start.'));
  assert.equal(w.ran.length, 1);
  assert.equal(w.ran[0][0], main);
  assert.match(w.ran[0][1].text, /“Bills” didn’t finish/);
  assert.match(w.ran[0][1].text, /The harness could not start\./);
  assert.equal(w.chats.record(main).meta.authored[w.ran[0][1].authored.id].title, '“Bills” didn’t finish');
  await done(w);
});

test('Pause holds the routine’s result, and so does a Reset under way; MoMo off holds it too', async () => {
  const { w } = await runningRoutine({ paused: true });
  const fail = () => w.m.routines.failed({ id: 'momo.x', name: 'Bills' }, new Error('x'));
  await fail();
  assert.deepEqual(w.ran, [], 'paused');
  w.prefs = { ...w.prefs, momo: { ...w.prefs.momo, paused: false } };
  await whileResetting(fail);
  assert.deepEqual(w.ran, [], 'resetting');
  w.allowed = false;
  await fail();
  assert.deepEqual(w.ran, [], 'MoMo off');
  w.allowed = true;
  await fail();
  assert.equal(w.ran.length, 1, 'then it goes');
  await done(w);
});

test('the files of the removed Feed and Topics are deleted at startup and once more by Reset’s routines store; the rest stays', async () => {
  const seed = (dir: string) => {
    for (const f of ['feed.json', 'feed.json.lock', 'feed.json.unreadable-1700000000000', 'state.json'])
      fs.writeFileSync(path.join(dir, f), 'x');
    fs.mkdirSync(path.join(dir, 'topics'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'topics', 'topic.a.json'), 'x');
  };
  const w = world({ allowed: true, seed });
  const left = () => fs.readdirSync(w.m.dir).filter((f) => !['audit', 'workspace'].includes(f));
  assert.deepEqual(left().sort(), ['state.json'], 'at startup, nothing else touched');
  // what a build before this one left, found again later, goes with Reset's routines store
  seed(w.m.dir);
  await w.m.routineStore.add({ name: 'Bills', prompt: 'p', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' }, { approved: true });
  const r = await resetMomoStores();
  assert.ok(r.reset.some((s: any) => s.id === 'routines'));
  for (const f of ['feed.json', 'feed.json.lock', 'feed.json.unreadable-1700000000000', 'topics'])
    assert.equal(fs.existsSync(path.join(w.m.dir, f)), false, f);
  assert.equal(w.m.routineStore.list().length, 0, 'the routines store erased its own too');
  await done(w);
});

test('a folder that can’t be cleaned at startup is noted, never thrown', async () => {
  // a file where MoMo's folder should be: reading it fails with ENOTDIR, which is not "no folder"
  const w = world({
    allowed: false,
    seed: (dir) => {
      fs.rmSync(dir, { recursive: true });
      fs.writeFileSync(dir, 'not a folder');
    },
  });
  assert.ok(w.m.routines, 'MoMo still opened');
  await done(w);
});

test('the Tasks tab’s list (A1) is registered in main over the routine store, the loops and the cards waiting in the main chat; refused while MoMo is not allowed', async () => {
  const w = world({ allowed: true });
  assert.ok(w.handlers.has('momoTasks:list'));
  // no main chat yet: no cards; a run still going shows by its chat, a loop by its id
  const routine = await w.m.routineStore.add(
    { name: 'Daily brief', prompt: 'p', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' },
    { approved: true },
  );
  await w.m.routineStore.beginRun({
    chatId: 'run1',
    taskId: routine.id,
    kind: 'momo-routine',
    due: Date.now(),
    by: { pid: process.pid, started: 1 },
  });
  const said = { text: 'call mum', at: Date.now(), turnId: 't1' };
  await w.m.loops.applyPass(
    { add: [{ kind: 'todo', text: 'Call mum', quote: 'call mum', line: said, tz: 'UTC', confidence: 'sure' }], mention: [], done: [] },
    { chatId: 'mc', harness: 'claude' },
  );
  const first = await w.call('momoTasks:list');
  assert.deepEqual(
    first.tasks.map((t: any) => [t.kind, t.title]),
    [
      ['loop', 'Call mum'],
      ['run', 'Daily brief'],
    ],
  );
  // a run of a routine that is gone keeps a name
  await w.m.routineStore.beginRun({
    chatId: 'run2',
    taskId: 'gone',
    kind: 'momo-routine',
    due: Date.now(),
    by: { pid: process.pid, started: 1 },
  });
  assert.ok((await w.call('momoTasks:list')).tasks.some((t: any) => t.id === 'run:run2' && t.title === 'A routine'));
  // a card waiting in the main chat comes first; another kind of approval does not count
  momoChat(w, 'mc', { momo: 'main' });
  w.live.controller.state.has = (id: string) => id === 'mc';
  w.live.controller.state.get = () => ({
    approvals: [
      { id: 'a1', params: { kind: 'momoAction', momo: { summary: 'Send the mail', source: 'Mail' } } },
      { id: 'a2', params: { kind: 'other' } },
    ],
  });
  const second = await w.call('momoTasks:list');
  assert.deepEqual(
    second.tasks.map((t: any) => t.id),
    ['card:a1', first.tasks[0].id, 'run:run2', 'run:run1'],
  );
  w.allowed = false;
  assert.equal((await w.call('momoTasks:list')).reason, 'not_allowed');
  await done(w);
});
