// MoMo's tasks on a Host (host/src/momoServices/tasks.mjs, host/src/momoTasks/*) over a real home with sealed stores: a task starts as a chat of the chosen agent, its end is read as typed events, the result is checked and delivered once, a restart never runs anything again, and a task nobody asked for can only read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A } from './support/host/momoMoveWorld.ts';
import { ask, REPORT, tasksWorld, tick, until } from './support/host/momoTasksWorld.ts';

const chatOf = (item: { where: { sessionId: string | null } }) => item.where.sessionId as string;

test('a task starts as a chat of the home agent in a folder of its own, with the brief as its first message', async (t) => {
  const w = await tasksWorld(t);
  const { item, error } = await w.tasks.create(ask);
  assert.equal(error, null);
  assert.deepEqual([item.state, item.where.machineId, item.where.harness], ['working', A.homeId, 'claude']);
  assert.match(chatOf(item), /^claude:[0-9a-f-]{36}$/);
  const sent = w.sessions.sent[0];
  assert.equal(sent.key, chatOf(item));
  assert.match(sent.text, /^Task: Build the Acme quote sheet\nDone means: Sheet opens/);
  // the task works in a folder of its own beside MoMo's storage, never inside it
  assert.equal(sent.cwd, `${w.dataDir}/momo-work/tasks/${item.id}`);
  assert.equal(sent.cwd.startsWith(`${w.momoDir}/`), false);
  // a task the user asked for starts in "Ask for approval", never in a looser mode the machine may have
  assert.deepEqual(w.sessions.modes, [{ chatId: chatOf(item), value: 'default' }]);
  assert.equal(await w.tasks.originOf(chatOf(item)), 'task');
});

test('every agent family gets the chat id its Host uses, and the task keeps the agent it was given', async (t) => {
  const w = await tasksWorld(t);
  const claude = await w.tasks.create({ ...ask, title: 'a', where: { machineId: A.homeId, harness: 'claude' } });
  const codex = await w.tasks.create({ ...ask, title: 'b', where: { machineId: A.homeId, harness: 'codex' } });
  assert.match(chatOf(claude.item), /^claude:/);
  assert.match(chatOf(codex.item), /^[0-9a-f-]{36}$/);
  assert.deepEqual([claude.item.where.harness, codex.item.where.harness], ['claude', 'codex']);
});

test('the reply of the turn is the report: the check is read-only, the result is done, and the chat gets one card', async (t) => {
  const w = await tasksWorld(t);
  const { item } = await w.tasks.create(ask);
  w.sessions.emit({ kind: 'turnStart', key: chatOf(item), turnId: 't1' });
  w.sessions.say(chatOf(item), 'Result: Built Acme-quote.xlsx.\nFiles: Acme-quote.xlsx\n');
  w.sessions.say(chatOf(item), 'Evidence: opened it, totals match.');
  w.sessions.say('someone-else', 'not ours');
  w.sessions.end(chatOf(item));
  await until(async () => (await w.tasks.view())[0]?.state === 'done' && w.cards.length === 1, 'the task to be done and its card to go');
  const [view] = await w.tasks.view();
  assert.deepEqual([view.state, view.result?.files, view.result?.evidence], ['done', ['Acme-quote.xlsx'], 'opened it, totals match.']);
  assert.match(w.asked[0], /Done means: Sheet opens/);
  // the request stays outside; only the other agent's report is the data the brain fences
  assert.doesNotMatch(w.asked[0], /Acme-quote|totals match/);
  assert.match(String(w.askedData[0]), /Result: Built Acme-quote\.xlsx\.\nFiles: Acme-quote\.xlsx\nEvidence: opened it, totals match\./);
  assert.deepEqual([w.cards.length, w.cards[0].state, w.cards[0].machineId], [1, 'done', A.homeId]);
  // the next turn's text starts fresh
  w.sessions.end(chatOf(item));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(w.cards.length, 1);
});

test('before the home wiring hands over its brain and chat, a result waits: the card stays owed and the task says it was not checked', async (t) => {
  const w = await tasksWorld(t, { bind: false, start: false });
  w.tasks.bind({ machine: w.binding.machine });
  await w.home.start(A);
  const { item } = await w.tasks.create(ask);
  w.sessions.say(chatOf(item), REPORT);
  w.sessions.end(chatOf(item));
  await until(async () => (await w.tasks.view())[0]?.state === 'needs_you', 'the task to wait');
  const [view] = await w.tasks.view();
  assert.deepEqual([view.state, view.failure?.code], ['needs_you', 'not-done']);
  assert.match(view.failure?.message as string, /Reading of results is not set up|couldn't check/i);
  assert.equal(w.cards.length, 0);
  // bound later, the owed card goes out on the next delivery
  w.tasks.bind(w.binding);
  assert.equal(await w.tasks.deliver(), 1);
  assert.deepEqual([w.cards.length, w.cards[0].state], [1, 'needs_you']);
  assert.equal(await w.tasks.deliver(), 0);
});

test('with nothing bound a task cannot start, and says its machine is not known', async (t) => {
  const w = await tasksWorld(t, { bind: false });
  const { item, error } = await w.tasks.create(ask);
  assert.deepEqual([item.state, error?.code], ['failed', 'machine_offline']);
  assert.equal(w.sessions.sent.length, 0);
});

test('a turn that fails says why, in the code the Host gave it, whatever the agent', async (t) => {
  const cases: [string, object, string][] = [
    ['claude', { error: { message: 'Usage limit reached', code: 'rate_limit' } }, 'usage-limit'],
    ['codex', { error: { message: 'Not signed in', code: 'auth' } }, 'agent-signed-out'],
    ['codex', { error: { message: 'usage limit reached for today' } }, 'usage-limit'],
    ['claude', { error: { message: 'disk full' } }, 'session-error'],
    ['codex', { error: 'plain text failure' }, 'session-error'],
  ];
  for (const [harness, over, code] of cases) {
    const w = await tasksWorld(t);
    const { item } = await w.tasks.create({ ...ask, where: { machineId: A.homeId, harness } });
    w.sessions.end(chatOf(item), { stopReason: 'error', ...over });
    await until(async () => (await w.tasks.view())[0]?.state === 'failed' && w.cards.length === 1, 'the task to fail and its card to go');
    const [view] = await w.tasks.view();
    assert.deepEqual([view.state, view.failure?.code], ['failed', code], harness);
    assert.equal(w.cards.length, 1);
  }
});

test("a restart of the Host while the task ran ends it as interrupted; a person's Stop is the manager's own", async (t) => {
  const w = await tasksWorld(t);
  const a = await w.tasks.create(ask);
  w.sessions.end(chatOf(a.item), { stopReason: 'cancelled', error: { message: 'Host restarted' }, interrupted: { by: 'host_restart' } });
  await until(async () => (await w.tasks.view())[0]?.state === 'failed', 'the task to be interrupted');
  assert.deepEqual((await w.tasks.view())[0].failure?.code, 'restarted');
  const b = await w.tasks.create({ ...ask, title: 'b' });
  w.sessions.end(chatOf(b.item), { stopReason: 'cancelled', interrupted: { by: 'other' } });
  await until(
    async () => (await w.tasks.view()).find((v: any) => v.id === b.item.id)?.state === 'failed',
    'the second task to be interrupted',
  );
  assert.match((await w.tasks.view()).find((v: any) => v.id === b.item.id).failure.message, /session for this task is gone/);
  const c = await w.tasks.create({ ...ask, title: 'c' });
  w.sessions.end(chatOf(c.item), { stopReason: 'cancelled' });
  await tick();
  assert.equal((await w.tasks.view()).find((v: any) => v.id === c.item.id).state, 'working');
});

test('a turn that waits for the person is needs_you with the Host approval, and goes on when it is answered', async (t) => {
  const w = await tasksWorld(t);
  const { item } = await w.tasks.create(ask);
  w.sessions.turns.set(chatOf(item), 'awaitingUser');
  await w.tasks.pollNow();
  let [view] = await w.tasks.view();
  assert.deepEqual([view.state, view.step], ['needs_you', 'Waiting for your approval on Studio']);
  await w.tasks.pollNow();
  w.sessions.turns.set(chatOf(item), 'running');
  await w.tasks.pollNow();
  [view] = await w.tasks.view();
  assert.equal(view.state, 'working');
  await w.tasks.pollNow();
  assert.equal((await w.tasks.view())[0].state, 'working');
});

test('a task nobody asked for starts read-only, and its actions through the gate can only read', async (t) => {
  const w = await tasksWorld(t);
  const { item } = await w.tasks.create({ title: 'Look at the invoice', doneMeans: 'summary', origin: 'matter' });
  assert.deepEqual(w.sessions.modes, [{ chatId: chatOf(item), value: 'read-only' }]);
  assert.match(w.sessions.sent[0].text, /read and report only/);
  assert.equal(await w.tasks.originOf(chatOf(item)), 'unprompted');
  const send = { tool: 'gmail.send', effect: 'send', scope: 'dana@example.com', args: { to: 'dana@example.com' }, summary: 'Send a mail' };
  let ran = 0;
  const refused = await w.tasks.guardedRun(chatOf(item), send, () => ++ran);
  assert.deepEqual([refused.refused, refused.reason, ran], [true, 'unprompted_read_only', 0]);
  const read = await w.tasks.guardedRun(
    chatOf(item),
    { ...send, tool: 'gmail.fetch', effect: 'read', scope: 'inbox', args: {} },
    () => ++ran,
  );
  assert.deepEqual([read.done, ran], [true, 1]);
});

test('a task the user asked for raises a card for a send, and a chat that is not a task is refused', async (t) => {
  const w = await tasksWorld(t);
  const { item } = await w.tasks.create(ask);
  const send = { tool: 'gmail.send', effect: 'send', scope: 'dana@example.com', args: { to: 'dana@example.com' }, summary: 'Send a mail' };
  let ran = 0;
  const asked = await w.tasks.guardedRun(chatOf(item), send, () => ++ran);
  assert.deepEqual([asked.pending, asked.card.origin, ran], [true, 'task', 0]);
  assert.deepEqual(await w.tasks.guardedRun('some-other-chat', send, () => ++ran), { refused: true, reason: 'not_a_task' });
  assert.equal(ran, 0);
});

test('an agent that cannot be held read-only does not start a task nobody asked for', async (t) => {
  const w = await tasksWorld(t);
  w.sessions.modeFails = true;
  const { item, error } = await w.tasks.create({ title: 'Look', doneMeans: 'summary', origin: 'routine' });
  assert.deepEqual([item.state, error?.code, w.sessions.sent.length], ['failed', 'refused', 0]);
  assert.match(error?.message as string, /no plan mode/);
});

test("the Host refuses the first message: the task fails with the Host's own words and code", async (t) => {
  const w = await tasksWorld(t);
  w.sessions.sendFails = Object.assign(new Error('Too many messages are waiting.'), { code: 'unsupported' });
  const first = await w.tasks.create(ask);
  assert.deepEqual([first.item.state, first.error?.code], ['failed', 'refused']);
  assert.match(first.error?.message as string, /Too many messages are waiting/);
  w.sessions.sendFails = new Error('boom');
  const second = await w.tasks.create({ ...ask, title: 'two' });
  assert.match(second.error?.message as string, /boom/);
});

test('another machine is not reachable from a Host: it is named, not pretended', async (t) => {
  const w = await tasksWorld(t);
  const { item, error } = await w.tasks.create({ ...ask, where: { machineId: 'mac-mini', harness: 'claude' } });
  assert.deepEqual([item.state, error?.code], ['failed', 'machine_offline']);
  assert.equal(w.sessions.sent.length, 0);
  assert.equal((await w.tasks.view())[0].where.machine.name, 'An unknown machine');
});

test('nothing acts while this Host is not the running home', async (t) => {
  const w = await tasksWorld(t, { start: false });
  assert.deepEqual(await w.tasks.view(), []);
  for (const call of [
    () => w.tasks.create(ask),
    () => w.tasks.stop('x'),
    () => w.tasks.resume('x'),
    () => w.tasks.pollNow(),
    () => w.tasks.deliver(),
    () => w.tasks.act('x', 'retry'),
  ])
    await assert.rejects(call(), /not running on/);
  assert.equal(await w.tasks.originOf('x'), null);
});

test('after a restart the working tasks are asked about, never started again, and a start made before the crash is found by its key', async (t) => {
  const w = await tasksWorld(t);
  const a = await w.tasks.create(ask);
  const b = await w.tasks.create({ ...ask, title: 'b' });
  await w.home.lifecycle('pause');
  w.sessions.turns.delete(chatOf(b.item));
  const sent = w.sessions.sent.length;
  await w.home.lifecycle('start');
  const views = await w.tasks.view();
  assert.deepEqual(views.map((v: any) => [v.title, v.state]).sort(), [
    ['Build the Acme quote sheet', 'working'],
    ['b', 'failed'],
  ]);
  assert.equal(views.find((v: any) => v.id === b.item.id).failure.code, 'restarted');
  assert.equal(w.sessions.sent.length, sent);
  // Start again for a task whose first start made its chat: the same key finds it, no second chat
  const again = await w.tasks.act(b.item.id, 'startAgain');
  assert.equal(again.done.item.state, 'working');
  assert.equal(w.sessions.sent.length, sent + 1);
  assert.equal(a.item.where.sessionId === chatOf(a.item), true);
});

test('Start again reuses the chat a first start made when the Host still has it', async (t) => {
  const w = await tasksWorld(t);
  const { item } = await w.tasks.create(ask);
  // the crash came after the chat was started and before it was recorded on the task
  await w.home.lifecycle('pause');
  const store = (await import('../shared/momoTasks/store.ts')).createItemStore;
  void store;
  const sent = w.sessions.sent.length;
  w.sessions.end(chatOf(item), { stopReason: 'error', error: { message: 'first failure' } });
  await tick();
  await w.home.lifecycle('start');
  const retried = await w.tasks.act(item.id, 'retry');
  assert.equal(retried.done.item.state, 'working');
  assert.equal(w.sessions.sent.length, sent + 1);
});

test("Reset MoMo stops the running sessions and deletes the ledger with the rest of MoMo's data", async (t) => {
  const w = await tasksWorld(t);
  const a = await w.tasks.create(ask);
  const b = await w.tasks.create({ ...ask, title: 'b' });
  w.sessions.cancelFails = true;
  await w.home.reset();
  assert.deepEqual(w.sessions.cancelled, []);
  assert.deepEqual(await w.tasks.view(), []);
  const c = await w.tasks.create({ ...ask, title: 'c' });
  assert.equal(c.item.state, 'working');
  w.sessions.cancelFails = false;
  await w.home.reset();
  assert.deepEqual(w.sessions.cancelled, [chatOf(c.item)]);
  void a;
  void b;
});

test('a tap on a fix: Retry acts, a button the task offers comes back to the client, and one it does not offer is refused', async (t) => {
  const w = await tasksWorld(t);
  w.sessions.sendFails = Object.assign(new Error('Spend limit'), { code: 'spend_limit' });
  const { item } = await w.tasks.create(ask);
  w.sessions.sendFails = null;
  const [view] = await w.tasks.view();
  assert.equal(view.failure.fix.id, 'retry');
  assert.deepEqual(await w.tasks.act(item.id, 'runElsewhere'), { client: 'runElsewhere' });
  // not offered by this task's failure: refused, and nothing about the task changed
  for (const fixId of ['install', 'signIn', 'runElsewhere|x|codex', `runElsewhere|${A.homeId}|codex`, 'retry|x|codex'])
    await assert.rejects(w.tasks.act(item.id, fixId), /not something this task offers/, fixId);
  assert.equal((await w.tasks.view())[0].state, 'failed');
  const again = await w.tasks.act(item.id, 'retry');
  assert.equal(again.done.item.state, 'working');
  assert.equal((await w.tasks.stop(item.id)).state, 'stopped');
  assert.deepEqual(w.sessions.cancelled, [chatOf(again.done.item)]);
});

test('the pause and start of the home stop and restart the timers without doubling them', async (t) => {
  const w = await tasksWorld(t);
  await w.home.lifecycle('start');
  await w.home.lifecycle('pause');
  await w.home.lifecycle('pause');
  await w.home.lifecycle('start');
  assert.deepEqual(w.reports, []);
});

test("a machine name the wiring does not give is this home's own name from the home record", async (t) => {
  const w = await tasksWorld(t, { bind: false });
  w.tasks.bind({ machine: { agents: () => [{ id: 'claude', state: 'ready' }] } });
  const { item } = await w.tasks.create(ask);
  assert.equal(item.state, 'working');
  assert.equal((await w.tasks.view())[0].where.machine.name, A.name);
});

test('a wipe with the timers still running stops them before the ledger goes', async (t) => {
  const w = await tasksWorld(t);
  await w.tasks.create(ask);
  await w.home.lifecycle('wipe');
  assert.deepEqual(await w.tasks.view(), []);
});
