// What the Host holds a task's session to, by agent; how its start is recorded and found again; and what happens to a task whose home was paused, moved or lost. (host/src/momoTasks/, host/src/momoServices/tasks.mjs)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { MOMO_FORM } from '../host/src/momoChats.mjs';
import { loadMomoServices } from '../host/src/momoServices.mjs';
import { A, host } from './support/host/momoMoveWorld.ts';
import { ask, fakeSessions, REPORT, tasksWorld, until, withWorkDir } from './support/host/momoTasksWorld.ts';

const chatOf = (item: { where: { sessionId: string | null } }) => item.where.sessionId as string;
const on = (harness: string) => ({ ...ask, title: `on ${harness}`, where: { machineId: A.homeId, harness } });
const unprompted = (harness: string) => ({
  title: `look ${harness}`,
  doneMeans: 'summary',
  origin: 'matter' as const,
  where: { machineId: A.homeId, harness },
});

test('each agent is held to what its adapter can promise: Claude Code and Codex by their typed modes, a basic agent not at all', async (t) => {
  const w = await tasksWorld(t);
  for (const harness of ['claude', 'codex']) {
    const asked = await w.tasks.create(on(harness));
    assert.deepEqual(w.sessions.modes.at(-1), { chatId: chatOf(asked.item), value: 'default' }, `${harness} asked`);
    const quiet = await w.tasks.create(unprompted(harness));
    assert.deepEqual(w.sessions.modes.at(-1), { chatId: chatOf(quiet.item), value: 'read-only' }, `${harness} unprompted`);
  }
  // a basic agent's modes are its own: none is known to ask first or to read only, so neither kind of task runs on it, and the task says why and what to pick
  const sent = w.sessions.sent.length;
  const modes = w.sessions.modes.length;
  const kimi = await w.tasks.create(on('acp:kimi'));
  assert.deepEqual(
    [kimi.item.state, kimi.error?.code, w.sessions.sent.length, w.sessions.modes.length],
    ['failed', 'refused', sent, modes],
  );
  assert.match(kimi.error?.message as string, /can't be limited to asking first\. Pick Claude Code or Codex\./);
  const refused = await w.tasks.create(unprompted('acp:kimi'));
  assert.deepEqual([refused.item.state, refused.error?.code, w.sessions.sent.length], ['failed', 'refused', sent]);
  assert.match(refused.error?.message as string, /can't be held read-only on this machine/);
  // a task's chat is never a MoMo chat, so it is never given MoMo's own tools
  for (const s of w.sessions.sent) assert.equal(MOMO_FORM.test(s.key), false);
});

test('a mode the agent refuses is told as it was, and the start key is given back so a retry makes a new chat', async (t) => {
  const w = await tasksWorld(t);
  w.sessions.modeFails = true;
  const first = await w.tasks.create(on('claude'));
  assert.deepEqual([first.item.state, first.error?.message, w.sessions.sent.length], ['failed', 'no plan mode', 0]);
  w.sessions.modeFails = false;
  const again = await w.tasks.act(first.item.id, 'retry');
  assert.equal(again.done.item.state, 'working');
  assert.equal(w.sessions.sent.length, 1);
});

test('a session that fails before its start is recorded still fails the task', async (t) => {
  const w = await tasksWorld(t);
  w.sessions.duringSend = ({ key }) =>
    w.sessions.end(key, { stopReason: 'error', error: { message: 'Usage limit reached', code: 'rate_limit' } });
  const { item } = await w.tasks.create(ask);
  await until(async () => (await w.tasks.view())[0]?.state === 'failed' && w.cards.length === 1, 'the fast failure');
  const [view] = await w.tasks.view();
  assert.deepEqual([view.state, view.failure?.code, chatOf(item) === item.where.sessionId], ['failed', 'usage-limit', true]);
});

test('a lease lost while the Host is starting the session stops that session', async (t) => {
  const w = await tasksWorld(t);
  const stamp = w.home.stamp.bind(w.home);
  w.sessions.duringSend = () => void (w.home.stamp = () => null);
  await assert.rejects(w.tasks.create(ask), /not running on this machine/);
  w.home.stamp = stamp;
  assert.equal(w.sessions.cancelled.length, 1);
  assert.equal(w.sessions.cancelled[0], w.sessions.sent[0].key);
});

test('a session that ended while the home was paused is found by the next start, and read as it ended', async (t) => {
  const w = await tasksWorld(t);
  const done = await w.tasks.create(ask);
  const failed = await w.tasks.create({ ...ask, title: 'b' });
  await w.home.lifecycle('pause');
  // the lease is gone too (a move began): the task manager is told nothing, but how each session ended is kept
  const stamp = w.home.stamp.bind(w.home);
  w.home.stamp = () => null;
  w.sessions.say(chatOf(done.item), REPORT);
  w.sessions.end(chatOf(done.item));
  w.sessions.end(chatOf(failed.item), { stopReason: 'error', error: { message: 'disk full' } });
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(await w.tasks.view(), []);
  w.home.stamp = stamp;
  await w.home.lifecycle('start');
  await until(async () => (await w.tasks.view()).every((v: any) => v.state !== 'working') && w.cards.length === 2, 'both tasks to be read');
  const views = await w.tasks.view();
  assert.deepEqual(views.map((v: any) => v.state).sort(), ['done', 'failed']);
  assert.equal(w.sessions.sent.length, 2);
});

test("what a task made stays when MoMo is reset, and its start keys go with the rest of MoMo's data", async (t) => {
  const w = await tasksWorld(t);
  const { item } = await w.tasks.create(ask);
  const folder = path.join(w.dataDir, 'momo-work', 'tasks', item.id);
  fs.writeFileSync(path.join(folder, 'Acme-quote.xlsx'), 'data');
  assert.ok(fs.existsSync(path.join(w.momoDir, 'task-keys.json')));
  await w.home.reset();
  assert.ok(fs.existsSync(path.join(folder, 'Acme-quote.xlsx')));
  assert.equal(fs.existsSync(path.join(w.momoDir, 'task-keys.json')), false);
  assert.equal(fs.existsSync(path.join(w.momoDir, 'tasks.json')), false);
});

test("the real loader finds the tasks service by folder and gives it the Host's harness status", async (t) => {
  const h = await host(t, A);
  withWorkDir(h.home, path.join(h.dir, 'data'));
  const sessions = fakeSessions();
  const harnesses = async () => [{ id: 'claude', detected: true, signedIn: true }];
  const loaded = loadMomoServices({
    deps: { home: h.home, sessions, harnesses },
    report: () => undefined,
  });
  assert.ok(loaded.includes('tasks.mjs'));
  await h.home.start(A);
  t.after(() => h.home.lifecycle('pause'));
  const tasks = h.home.service('tasks');
  const { item } = await tasks.create(ask);
  assert.equal(item.state, 'working');
  assert.equal(sessions.sent.length, 1);
  // without the Host's harness status, nothing is known of this machine's agents and no task starts
  const bare = await host(t, A);
  withWorkDir(bare.home, path.join(bare.dir, 'data'));
  const none = fakeSessions();
  loadMomoServices({ deps: { home: bare.home, sessions: none }, report: () => undefined });
  await bare.home.start(A);
  t.after(() => bare.home.lifecycle('pause'));
  const refused = await bare.home.service('tasks').create(ask);
  assert.deepEqual([refused.item.state, refused.error?.code, none.sent.length], ['failed', 'machine_offline', 0]);
});

test('a watch through the Host: made, read on the tick, a change told to the chat once, and the row waits for the user', async (t) => {
  const w = await tasksWorld(t);
  const item = await w.tasks.createWatch({
    title: 'AWS invoice due today',
    doneMeans: 'Tell me when it changes',
    origin: 'matter',
    watch: { kind: 'tool', tool: 'gmail.search', everyMinutes: 5 },
  });
  assert.equal(item.state, 'watching');
  w.readings.push({ fingerprint: 'a' }, { fingerprint: 'b' });
  w.clock.at += 2_000;
  assert.equal((await w.tasks.tickNow()).watches.checked, 1);
  w.clock.at += 5 * 60_000;
  const second = await w.tasks.tickNow();
  assert.deepEqual([second.watches.changed, w.notices.map((n: any) => n.title)], [1, ['AWS invoice due today']]);
  assert.equal((await w.tasks.view())[0].state, 'needs_you');
  assert.equal((await w.tasks.tickNow()).delivered, 0);
});

test('a task waiting on an approval is still followed after the home restarts', async (t) => {
  const w = await tasksWorld(t);
  const { item } = await w.tasks.create(ask);
  w.sessions.turns.set(chatOf(item), 'awaitingUser');
  await w.tasks.pollNow();
  assert.equal((await w.tasks.view())[0].state, 'needs_you');
  await w.home.lifecycle('pause');
  await w.home.lifecycle('start');
  assert.equal((await w.tasks.view())[0].state, 'needs_you');
});

test('a watch change with no chat bound yet stays owed and is counted, never lost', async (t) => {
  const w = await tasksWorld(t, { bind: false });
  w.tasks.bind({ machine: w.binding.machine });
  const spec = { title: 'Page', doneMeans: 'Tell me', origin: 'matter' as const, watch: { kind: 'tool', tool: 'x', everyMinutes: 5 } };
  // no reader yet: a tool is refused, and a check that is due waits
  await assert.rejects(w.tasks.createWatch(spec), /cannot ask for approval/);
  const http = await w.tasks.createWatch({
    ...spec,
    title: 'Status page',
    watch: { kind: 'http', url: 'https://status.example.com/x', everyMinutes: 5 },
  });
  w.clock.at += 2_000;
  assert.equal((await w.tasks.tickNow()).watches.retrying, 1);
  await w.tasks.stop(http.id);
  // the reader is bound after the home started: it is found
  w.tasks.bind({ machine: w.binding.machine, watches: w.binding.watches });
  await w.tasks.createWatch(spec);
  w.readings.push({ fingerprint: 'a' }, { fingerprint: 'b' });
  w.clock.at += 2_000;
  await w.tasks.tickNow();
  w.clock.at += 5 * 60_000;
  assert.equal((await w.tasks.tickNow()).watches.undelivered, 1);
  w.tasks.bind(w.binding);
  // the next tick delivers what was owed (inside the watch round), once
  await w.tasks.tickNow();
  assert.equal(w.notices.length, 1);
  assert.equal((await w.tasks.tickNow()).delivered, 0);
});

test("the home's wiring hands over only the brain and the chat (no machine): agents come from the harness status, typed refusals keep the result and the card owed, and both flow once they work", async (t) => {
  const h = await host(t, A);
  withWorkDir(h.home, path.join(h.dir, 'data'));
  const sessions = fakeSessions();
  const harnesses = async () => [{ id: 'claude', detected: true, signedIn: true }];
  loadMomoServices({
    deps: { home: h.home, sessions, harnesses, report: () => undefined },
    report: () => undefined,
  });
  await h.home.start(A);
  t.after(() => h.home.lifecycle('pause'));
  const tasks = h.home.service('tasks');
  const refuse = (code: string) => Object.assign(new Error(code), { code });
  let brainUp = false;
  let chatUp = false;
  const rows: any[] = [];
  // what momoWiring does once after the services load: bind({ check, chat }), with no machine
  tasks.bind({
    check: {
      ask: async () =>
        brainUp ? '{"met": true, "reason": "ok", "checked": "opened it"}' : Promise.reject(refuse('momo_check_unavailable')),
    },
    chat: {
      postResult: async (card: any) => (chatUp ? void rows.push(card) : Promise.reject(refuse('momo_chat_unavailable'))),
      postWatchChanged: async () => Promise.reject(refuse('momo_chat_unavailable')),
    },
  });
  const { item } = await tasks.create(ask);
  assert.equal(item.state, 'working');
  sessions.say(chatOf(item), REPORT);
  sessions.end(chatOf(item));
  await until(async () => (await tasks.view())[0]?.state === 'needs_you', 'the task to wait');
  const [view] = await tasks.view();
  assert.deepEqual([view.failure?.code, view.failure?.message], ['not-done', "I couldn't check this result."]);
  assert.equal(rows.length, 0);
  chatUp = true;
  assert.equal(await tasks.deliver(), 1);
  assert.deepEqual([rows.length, rows[0].state, rows[0].itemId], [1, 'needs_you', item.id]);
  assert.equal(brainUp, false);
});
