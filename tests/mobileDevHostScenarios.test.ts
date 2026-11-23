// The dev host's bench scenarios: each makes a chat of its own and leaves the fake app in the situation it names.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { until } from './support/mobileStack.ts';
import { SCENARIO_NAMES } from './support/devHostScenarioNames.ts';
import { createFakeApp } from '../scripts/mobile-dev-host/fakeApp.mjs';
import { createScenarios } from '../scripts/mobile-dev-host/scenarios.mjs';

function rig(o: { sleepHook?: (n: number) => void; controls?: object } = {}) {
  let sleeps = 0;
  const logs: string[] = [];
  const app = createFakeApp({
    repo: '/repo',
    log: (l: string) => logs.push(l),
    now: () => 9_000_000,
    sleep: async () => void o.sleepHook?.(++sleeps),
    status: async () => ' M src/price.ts\n',
  });
  const events: any[] = [];
  app.bind({ attached: true, onFeedEvent: (e: any) => events.push(e), onSessionPatch: () => undefined });
  const later: { ms: number; fn: () => void }[] = [];
  const scenarios = createScenarios({
    app,
    now: () => 9_000_000,
    after: (ms: number, fn: () => void) => void later.push({ ms, fn }),
    controls: o.controls as any,
  });
  const run = (name: string, args?: string[]) => scenarios.run(name, args) as string; // the scenarios that wait answer with a promise; the ones used here answer at once
  const chatIn = (message: string) => /chat (dev-bench-\d+)/.exec(message)![1];
  const card = async (id: string) => (await app.ops.cardsOf(id))[0];
  return { app, ops: app.ops, logs, events, scenarios, run, later, chatIn, card };
}

test('the scenarios are listed with their usage, and a wrong name says what exists', () => {
  const r = rig();
  const list = r.scenarios.list();
  assert.deepEqual(
    list.map((s: any) => s.usage.split(' ')[0]).filter((n: string) => !['momo-draft', 'momo-report', 'momo-options'].includes(n)),
    SCENARIO_NAMES,
  );
  assert.ok(list.every((s: any) => s.about.length > 10));
  assert.throws(() => r.scenarios.run('nope'), /No scenario "nope"\. Try: fail-mid-stream, slow-stream/);
  assert.match(r.run('plan'), /a plan card/);
});

test('fail-mid-stream shows half an answer and then fails the turn with a reason', async () => {
  const r = rig();
  const id = r.chatIn(r.run('fail-mid-stream'));
  await r.app.idle();
  const snapshot = await r.ops.items(id, 5);
  assert.match(snapshot.items[0].text, /^The total multiplies before it rounds.*cause is that$/);
  assert.ok(r.logs.some((l) => l.includes(`${id} turn failed (The model connection dropped (bench scenario))`)));
  assert.deepEqual([snapshot.liveTurn?.status, r.ops.turn(id)], ['failed', 'idle']);
});

test('slow-stream streams until it is done, or until the phone presses Stop', async () => {
  const r = rig();
  const id = r.chatIn(r.run('slow-stream', ['2']));
  await r.app.idle();
  assert.match((await r.ops.items(id, 5)).items[0].text, /^word1 word2.* word8$/);
  const stopping: { stop?: () => void } = {};
  const s = rig({ sleepHook: (n) => n === 3 && stopping.stop?.() });
  stopping.stop = () => [...s.app.chats.keys()].forEach((k) => void s.ops.stop(k));
  const stopped = s.chatIn(s.run('slow-stream', ['nonsense']));
  await s.app.idle();
  assert.equal((await s.ops.items(stopped, 5)).liveTurn?.status, 'interrupted');
});

test('flood streams many separate items into one chat, and every run goes to the same chat so a phone that follows it gets every round', async () => {
  const r = rig();
  const said = r.run('flood', ['40']);
  const id = r.chatIn(said);
  assert.match(said, /40 items \(~120 frames\)/);
  await r.app.idle();
  const rows = (await r.ops.items(id, 50)).items.length;
  assert.ok(rows > 0 && rows <= 50, `${rows} items read back`);
  assert.equal(r.chatIn(r.run('flood', ['5'])), id, 'the same chat');
  await r.app.idle();
});

test('follow-error fails the next chat reads with a reason, then reads work again', async () => {
  const r = rig();
  const id = r.chatIn(r.run('flood', ['3']));
  await r.app.idle();
  assert.match(r.run('follow-error', ['2']), /next 2 chat reads fail/);
  await assert.rejects(r.ops.items(id, 5), /couldn't read this chat/);
  await assert.rejects(r.ops.items(id, 5), /couldn't read this chat/);
  assert.ok((await r.ops.items(id, 5)).items.length > 0, 'the read after them works');
  assert.match(r.run('follow-error'), /next 1 chat read fail/);
  await assert.rejects(r.ops.items(id, 5), /couldn't read this chat/);
  assert.ok((await r.ops.items(id, 5)).items.length > 0);
});

test('cards starts an approval, a question card and a plan card at once, each in a chat of its own', async () => {
  const r = rig();
  const ids = r.run('cards').match(/dev-bench-\d+/g)!;
  assert.equal(new Set(ids).size, 3);
  for (const id of ids) await until(async () => (await r.ops.cardsOf(id)).length, `a card in ${id}`);
  const kinds = await Promise.all(ids.map(async (id) => (await r.ops.cardsOf(id))[0]));
  assert.deepEqual(
    kinds.map((c: any) => (c.questions ? 'question' : c.kind === 'plan' ? 'plan' : 'approval')),
    ['approval', 'question', 'plan'],
  );
});

test('ask-question puts up a question card and says the answers the phone sent back', async () => {
  const r = rig();
  const id = r.chatIn(r.run('ask-question'));
  await until(async () => (await r.ops.cardsOf(id)).length, 'the question card');
  const card = (await r.ops.cardsOf(id))[0];
  assert.deepEqual(
    card.questions.map((q: any) => q.id),
    ['where', 'checks', 'extra'],
  );
  assert.deepEqual(card.choices, [{ key: 'answer', label: 'Send answers' }]);
  const values = { where: ['At the end'], checks: ['Unit', 'End to end'], extra: ['no'] };
  assert.equal(await r.ops.answer({ chatId: id, approvalId: card.id, choice: 'answer', values }), true);
  await r.app.idle();
  assert.match((await r.ops.items(id, 5)).items.at(-1).text, /^You answered: .*"where":\["At the end"\].*"extra":\["no"\]/);
  assert.equal(await r.ops.answer({ chatId: 'no-such-chat', approvalId: 'a1', choice: 'answer', values }), false, 'a chat with no turn');
  const plain = r.chatIn(r.run('plan'));
  await until(async () => (await r.ops.cardsOf(plain)).length, 'the plan card');
  const asked = (await r.ops.cardsOf(plain))[0];
  assert.equal(
    await r.ops.answer({ chatId: plain, approvalId: asked.id, choice: 'approve' }),
    true,
    'an answer without values still settles',
  );
  await r.app.idle();
});

test('a streamed reply is one row: the history row has the rowId of the item that streamed it', async () => {
  const r = rig();
  const id = r.chatIn(r.run('ask-question'));
  await until(async () => (await r.ops.cardsOf(id)).length, 'the question card');
  const card = (await r.ops.cardsOf(id))[0];
  await r.ops.answer({ chatId: id, approvalId: card.id, choice: 'answer', values: {} });
  await r.app.idle();
  const streamed = (await r.ops.items(id, 10)).items.map((i: any) => i.rowId);
  const rows = (await r.ops.read(id)).rows.filter((row: any) => row.role === 'assistant').map((row: any) => row.id);
  assert.equal(streamed.length, 2);
  assert.deepEqual(rows, streamed, 'a reply row has the rowId of its item');
});

test('chat-link says links to a chat on the phone and to one it does not have, and puts up a plan card that links too', async () => {
  const r = rig();
  const id = r.chatIn(r.run('chat-link', ['dev-seed-login']));
  await until(async () => (await r.ops.cardsOf(id)).length, 'the plan card');
  const said = (await r.ops.items(id, 5)).items[0].text;
  assert.match(said, /\(mopilot:chat\/dev-seed-login\).*\(mopilot:chat\/no-such-chat\)/);
  assert.match((await r.ops.cardsOf(id))[0].plan.text, /\(mopilot:chat\/dev-seed-login\)/);
  assert.equal(await r.ops.answer({ chatId: id, approvalId: (await r.ops.cardsOf(id))[0].id, choice: 'approve' }), true);
  await r.app.idle();
  assert.match(r.run('chat-link'), /linking to dev-seed-readme/);
});

test('stream-reply streams a Markdown reply, evenly or in clumps', async () => {
  const sleeps: number[] = [];
  const r = rig({ sleepHook: (n: number) => sleeps.push(n) });
  const fast = r.chatIn(r.run('stream-reply'));
  const clumped = r.chatIn(r.run('stream-reply', ['bursty']));
  await r.app.idle();
  for (const id of [fast, clumped])
    assert.match((await r.ops.items(id, 5)).items[0].text, /^The total multiplies \*\*before\*\*.*```ts\n/s);
  assert.match(r.logs.join('\n') + r.run('stream-reply', ['bursty']), /14 words every 700 ms/);
  assert.ok(sleeps.length > 0);
});

test('stream-reply table streams the owner’s table and CJK reply (#4644) as one message', async () => {
  const r = rig();
  const message = r.run('stream-reply', ['table']);
  assert.match(message, /a word every 160 ms/);
  const id = r.chatIn(message);
  await r.app.idle();
  const text = (await r.ops.items(id, 5)).items[0].text;
  assert.match(
    text,
    /^正面宽 21\.5″ 对上 LMC1575.*\*\*LG 官方的 30″.*嵌入框。\*\*清单里的/s,
    'bold run closing on CJK punctuation and followed by a CJK character',
  );
  assert.match(text, /\n\| 办法 \| 花费 \| 说明 \|\n\|---\|---\|---\|\n\| \*\*推荐\*\*：/, 'the table follows a paragraph line directly');
  assert.match(text, /~~直接换整台~~/);
});

test('work runs many command steps, asks for an approval halfway, goes on once allowed and ends with an answer', async () => {
  const r = rig();
  const id = r.chatIn(r.run('work', ['4', '1']));
  await until(() => r.card(id), 'the approval');
  const card = await r.card(id);
  assert.equal(card.detail, 'rm -rf dist coverage');
  assert.equal(r.ops.turn(id), 'awaitingUser');
  await r.ops.answer({ chatId: id, approvalId: card.id, choice: 'once' });
  await r.app.idle();
  assert.match((await r.ops.items(id, 40)).items.at(-1).text, /^The discount is applied before rounding/);
  assert.equal(r.ops.turn(id), 'idle');
  // a denied approval still ends the turn with the answer; a bad count falls back to 8 steps
  const denied = r.chatIn(r.run('work', ['x']));
  await until(() => r.card(denied), 'the approval');
  await r.ops.answer({ chatId: denied, approvalId: (await r.card(denied)).id, choice: 'deny' });
  await r.app.idle();
  assert.equal(r.ops.turn(denied), 'idle');
});

test('huge-output prints a command output over one frame, then a normal reply follows', async () => {
  const r = rig();
  const id = r.chatIn(r.run('huge-output', ['8']));
  await r.app.idle();
  assert.ok(JSON.stringify(r.events).includes('line 000001 xxxxxxxxxx'));
  assert.match((await r.ops.items(id, 5)).items.at(-1).text, /^The run printed 8 KB/);
  assert.equal(r.ops.turn(id), 'idle');
  assert.match(r.run('huge-output', ['0']), /a 600 KB command output/);
  await r.app.idle();
});

test('overflow adds models to the model menu, and 0 puts it back', async () => {
  const r = rig();
  assert.match(r.run('overflow', ['3']), /3 more models/);
  const models = (await r.ops.options({})).models;
  assert.deepEqual(
    models.map((m: any) => m.id),
    ['dev-fast', 'dev-deep', 'dev-extra-1', 'dev-extra-2', 'dev-extra-3'],
  );
  assert.equal(models.at(-1).label, 'Dev Model 3');
  await r.ops.choose({ model: 'dev-extra-1' });
  const chosen = await r.ops.options({});
  assert.equal(chosen.model, 'dev-extra-1');
  assert.equal(chosen.effort, null, 'an extra model has no efforts, so none is picked');
  assert.match(r.run('overflow'), /30 more models/);
  assert.equal((await r.ops.options({})).models.length, 32);
  r.run('overflow', ['0']);
  assert.deepEqual(
    (await r.ops.options({})).models.map((m: any) => m.id),
    ['dev-fast', 'dev-deep'],
  );
});

test('long-history makes a chat with that many saved rows, capped', async () => {
  const r = rig();
  const id = r.chatIn(r.run('long-history', ['30']));
  const rows = (await r.ops.read(id)).rows;
  assert.equal(rows.length, 30);
  assert.deepEqual([...new Set(rows.map((x: any) => x.role))].sort(), ['assistant', 'step', 'user']);
  const capped = r.chatIn(r.run('long-history', ['999999']));
  assert.equal((await r.ops.read(capped)).rows.length, 20_000);
  assert.equal((await r.ops.read(r.chatIn(r.run('long-history')))).rows.length, 500);
});

test('answered-elsewhere answers the card on the Mac after the delay, and the turn goes on', async () => {
  const r = rig();
  const message = r.run('answered-elsewhere', ['5']);
  assert.match(message, /after 5s/);
  const id = r.chatIn(message);
  await until(() => r.card(id), 'the card');
  assert.equal(r.later.at(-1)!.ms, 5000);
  assert.equal(r.ops.turn(id), 'awaitingUser');
  r.later.at(-1)!.fn();
  await r.app.idle();
  assert.equal(await r.card(id), undefined);
  assert.match((await r.ops.read(id)).rows.at(-1).text, /answered on the Mac/);
  assert.ok(r.logs.some((l) => l.includes('answered on the Mac with "once"')));
  assert.equal(r.app.macAnswers(id, 'once'), false, 'nothing is waiting any more');
  assert.match(r.run('answered-elsewhere'), /after 20s/);
});

test('site-approval raises a browser approval that carries its destination label, or none', async () => {
  const r = rig();
  const withLabel = r.chatIn(r.run('site-approval'));
  await until(() => r.card(withLabel), 'the approval');
  const first = await r.card(withLabel);
  assert.equal(first.to, 'shop.example');
  // answering it lets the turn go on
  await r.ops.answer({ chatId: withLabel, approvalId: first.id, choice: 'once' });
  await r.app.idle();
  assert.match((await r.ops.read(withLabel)).rows.at(-1).text, /^Done\.$/);
  const named = r.chatIn(r.run('site-approval', ['pay.example']));
  await until(() => r.card(named), 'the approval');
  assert.equal((await r.card(named)).to, 'pay.example');
  const bare = r.chatIn(r.run('site-approval', ['none']));
  await until(() => r.card(bare), 'the approval');
  assert.ok(!('to' in (await r.card(bare))), 'no line without a label');
});

test('plan raises a plan card with its text; approving goes on, asking for changes waits', async () => {
  const r = rig();
  const id = r.chatIn(r.run('plan'));
  await until(() => r.card(id), 'the plan card');
  const card = await r.card(id);
  assert.equal(card.kind, 'plan');
  assert.match(card.plan.text, /^# Plan: round the checkout total once/);
  assert.equal(card.plan.clipped, undefined);
  assert.equal(card.plan.file, 'plans/rounding.md');
  assert.deepEqual(
    card.choices.map((c: any) => [c.key, !!c.deny]),
    [
      ['approve', false],
      ['revise', true],
    ],
  );
  assert.equal(r.app.chats.get(id).harness, 'claude');
  await r.ops.answer({ chatId: id, approvalId: card.id, choice: 'approve' });
  await r.app.idle();
  assert.match((await r.ops.read(id)).rows.at(-1).text, /Plan approved/);

  const long = r.chatIn(r.run('plan', ['long']));
  await until(() => r.card(long), 'the long plan card');
  const clipped = await r.card(long);
  assert.equal(clipped.plan.clipped, true);
  assert.equal(clipped.plan.text.length, 4000);
  await r.ops.answer({ chatId: long, approvalId: clipped.id, choice: 'revise' });
  await r.app.idle();
  assert.match((await r.ops.read(long)).rows.at(-1).text, /Tell me what to change/);
});

test('bulk chats spread over projects (and none), two of them named alike with ids of their own, so the phone tells them apart', async () => {
  const r = rig();
  r.run('chats', ['12']);
  const bulk = (await r.ops.recent(50)).filter((c: any) => c.id.startsWith('dev-bulk-'));
  const pairs = [...new Set(bulk.map((c: any) => `${c.project}|${c.projectId}`))].sort();
  assert.deepEqual(pairs, ['app|app-1', 'app|app-2', 'dev-repo|dev-repo', 'docs|docs', 'null|null', 'site|site']);
  assert.equal((await r.ops.recent(1, false, 0)).length, 1);
});

test('chats adds the missing bulk chats up to the number asked for', async () => {
  const r = rig();
  assert.match(r.run('chats', ['10']), /^10 chats added \(10 bulk chats in all\)/);
  assert.match(r.run('chats', ['12']), /^2 chats added \(12 bulk chats in all\)/);
  assert.match(r.run('chats', ['12']), /^0 chats added/);
  const recent = await r.ops.recent(100);
  assert.equal(recent.filter((c: any) => c.id.startsWith('dev-bulk-')).length, 12);
  assert.ok(new Set(recent.map((c: any) => c.harness)).size === 2);
  assert.match(r.run('chats'), /\(200 bulk chats in all\)/);
});

test('the Mac’s late answer belongs to its own card: after the phone answered, a later card in the chat is left alone', async () => {
  const r = rig();
  const id = r.chatIn(r.run('answered-elsewhere', ['5']));
  await until(() => r.card(id), 'the card');
  const timer = r.later.at(-1)!.fn;
  await r.ops.answer({ chatId: id, approvalId: (await r.card(id)).id, choice: 'deny' });
  await r.app.idle();
  // the tester sends another message; its turn asks its own question
  await r.ops.send({ chatId: id, text: 'and now?' });
  await until(async () => (await r.card(id))?.detail === 'git status --short', 'the next card');
  timer();
  assert.equal(r.ops.turn(id), 'awaitingUser', 'the old timer did not answer the new card');
  await r.ops.answer({ chatId: id, approvalId: (await r.card(id)).id, choice: 'once' });
  await r.app.idle();
});

test('a Stop in slow-stream keeps the streamed text on the phone', async () => {
  const stopping: { stop?: () => void } = {};
  const r = rig({ sleepHook: (n) => n === 4 && stopping.stop?.() });
  stopping.stop = () => [...r.app.chats.keys()].forEach((k) => void r.ops.stop(k));
  const id = r.chatIn(r.run('slow-stream', ['10']));
  await r.app.idle();
  const snapshot = await r.ops.items(id, 5);
  assert.equal(snapshot.items[0].text, 'word1 word2 word3 word4 ');
  assert.equal(snapshot.liveTurn?.status, 'interrupted');
});

test('the switch scenarios pass their arguments to the host’s controls, and ask for on or off', async () => {
  const calls: [string, unknown][] = [];
  const controls = {
    momo: (on: boolean) => (calls.push(['momo', on]), 'momo done'),
    brainSwitch: (on: boolean) => (calls.push(['brainSwitch', on]), 'brain done'),
    direct: async (on: boolean) => (calls.push(['direct', on]), 'direct done'),
    hostCard: async (text?: string) => (calls.push(['hostCard', text]), 'card done'),
    hostChat: async (agent: string, text: string) => (calls.push(['hostChat', [agent, text]]), 'chat done'),
    hostStatus: async () => (calls.push(['hostStatus', undefined]), 'status done'),
    hostAnswer: async (kind: string) => (calls.push(['hostAnswer', kind]), 'answer done'),
    s3: async (step: string) => (calls.push(['s3', step]), 's3 done'),
    sleep: (n: number) => (calls.push(['sleep', n]), 'sleep done'),
    unplug: (n: number) => (calls.push(['unplug', n]), 'unplug done'),
    restartRelay: (n: number) => (calls.push(['restartRelay', n]), 'restart done'),
    revoke: async (n: number) => (calls.push(['revoke', n]), 'revoke done'),
    advanceTx: async (n: number, pairId?: string) => (calls.push(['advanceTx', [n, pairId]]), 'gap done'),
    titles: async (on: boolean) => (calls.push(['titles', on]), 'titles done'),
    hosts: () => (calls.push(['hosts', null]), 'hosts done'),
    agent: (m: string, a: string, st: string) => (calls.push(['agent', [m, a, st]]), 'agent done'),
    momoTasks: (on: boolean) => (calls.push(['momoTasks', on]), 'tasks done'),
    remind: (title?: string) => (calls.push(['remind', title]), 'remind done'),
    pushPayload: (kind: string, chat: string, card?: string) => (calls.push(['pushPayload', [kind, chat, card]]), 'payload'),
  };
  const r = rig({ controls });
  assert.equal(r.scenarios.run('hosts'), 'hosts done');
  assert.deepEqual(calls.shift(), ['hosts', null]);
  assert.equal(r.scenarios.run('agent', ['studio', 'codex', 'missing']), 'agent done');
  assert.deepEqual(calls.shift(), ['agent', ['studio', 'codex', 'missing']]);
  assert.throws(() => r.scenarios.run('agent', ['studio']), /Usage: agent studio/);
  assert.equal(r.scenarios.run('momo-remind', ['Call', 'the', 'bank']), 'remind done');
  assert.equal(r.scenarios.run('momo-remind'), 'remind done');
  assert.equal(r.scenarios.run('momo-tasks'), 'tasks done');
  assert.equal(r.scenarios.run('momo-tasks', ['off']), 'tasks done');
  assert.throws(() => r.scenarios.run('momo-tasks', ['maybe']), /Say on or off: run momo-tasks \[on\|off\]/);
  assert.equal(r.scenarios.run('push-payload'), 'payload');
  assert.equal(r.scenarios.run('push-payload', ['momoNeedsYou', 'c1', 'a2']), 'payload');
  assert.deepEqual(calls.splice(0), [
    ['remind', 'Call the bank'],
    ['remind', undefined],
    ['momoTasks', true],
    ['momoTasks', false],
    ['pushPayload', ['needsYou', 'dev-seed-waiting', undefined]],
    ['pushPayload', ['momoNeedsYou', 'c1', 'a2']],
  ]);
  assert.equal(r.scenarios.run('momo', ['on']), 'momo done');
  assert.equal(r.scenarios.run('momo', ['off']), 'momo done');
  assert.equal(r.scenarios.run('brain-switch', ['on']), 'brain done');
  assert.equal(await r.scenarios.run('direct', ['off']), 'direct done');
  assert.throws(() => r.scenarios.run('direct', ['maybe']), /Say on or off: run direct on\|off/);
  assert.equal(await r.scenarios.run('host-card', ['PERMIT', 'it']), 'card done');
  assert.equal(await r.scenarios.run('host-card'), 'card done');
  assert.equal(await r.scenarios.run('host-chat', ['claude', 'say', 'hi']), 'chat done');
  assert.equal(await r.scenarios.run('host-chat', ['codex']), 'chat done');
  assert.throws(() => r.scenarios.run('host-chat', ['gemini']), /Say fake, claude or codex/);
  assert.equal(await r.scenarios.run('host-status'), 'status done');
  assert.equal(await r.scenarios.run('host-answer', ['deny']), 'answer done');
  assert.equal(await r.scenarios.run('s3', ['elsewhere']), 's3 done');
  assert.equal(await r.scenarios.run('s3', []), 's3 done', 'no step is passed on as empty, for the control to refuse');
  assert.throws(() => r.scenarios.run('host-answer', ['maybe']), /Say allow or deny: run host-answer allow\|deny/);
  assert.throws(() => r.scenarios.run('momo', []), /Say on or off: run momo on\|off/);
  assert.throws(() => r.scenarios.run('brain-switch', ['maybe']), /Say on or off: run brain-switch on\|off/);
  assert.equal(r.scenarios.run('sleep', ['9']), 'sleep done');
  assert.equal(r.scenarios.run('sleep'), 'sleep done');
  assert.equal(r.scenarios.run('unplug', ['4']), 'unplug done');
  assert.equal(r.scenarios.run('unplug'), 'unplug done');
  assert.equal(r.scenarios.run('restart-relay', ['2']), 'restart done');
  assert.equal(r.scenarios.run('restart-relay'), 'restart done');
  assert.equal(await r.scenarios.run('titles', ['on']), 'titles done');
  assert.equal(await r.scenarios.run('titles', ['off']), 'titles done');
  assert.throws(() => r.scenarios.run('titles', []), /Say on or off: run titles on\|off/);
  assert.equal(await r.scenarios.run('revoke', ['2']), 'revoke done');
  assert.equal(await r.scenarios.run('revoke'), 'revoke done');
  for (const typo of ['two', '0', '1.5', '-1'])
    assert.throws(() => r.scenarios.run('revoke', [typo]), /Say which phone: run revoke \[n=1\]/, typo);
  assert.equal(await r.scenarios.run('gap'), 'gap done');
  assert.equal(await r.scenarios.run('gap', ['40', 'p_1']), 'gap done');
  assert.equal(await r.scenarios.run('gap', ['9999999']), 'gap done');
  assert.deepEqual(calls, [
    ['momo', true],
    ['momo', false],
    ['brainSwitch', true],
    ['direct', false],
    ['hostCard', 'PERMIT it'],
    ['hostCard', undefined],
    ['hostChat', ['claude', 'say hi']],
    ['hostChat', ['codex', 'Reply with only the word OK.']],
    ['hostStatus', undefined],
    ['hostAnswer', 'deny'],
    ['s3', 'elsewhere'],
    ['s3', ''],
    ['sleep', 9],
    ['sleep', 20],
    ['unplug', 4],
    ['unplug', 20],
    ['restartRelay', 2],
    ['restartRelay', 3],
    ['titles', true],
    ['titles', false],
    ['revoke', 2],
    ['revoke', 1],
    ['advanceTx', [5000, undefined]],
    ['advanceTx', [40, 'p_1']],
    ['advanceTx', [1_000_000, undefined]],
  ]);
});

test('child-ask makes a waiting sub-session under a chat, child-answer has the Mac answer it, and both refuse what is not there', async () => {
  const r = rig();
  const said = r.run('child-ask');
  const child = said.match(/chat (dev-bench-\d+):/)![1];
  assert.match(said, /a sub-session of dev-seed-readme that waits/);
  await until(async () => (await r.ops.cardsOf(child)).length > 0, 'the sub-session to ask');
  const listed = (await r.ops.recent(20)).find((c: any) => c.id === child) as any;
  assert.equal(listed.parentId, 'dev-seed-readme');
  assert.equal(r.ops.state.get(child).turn, 'awaitingUser');
  assert.equal(r.run('child-answer', [child]), `${child}: answered "once" on the Mac`);
  await r.app.idle();
  assert.notEqual(r.ops.state.get(child).turn, 'awaitingUser');
  assert.throws(() => r.run('child-answer', [child]), /has no card waiting/);
  assert.throws(() => r.run('child-answer', ['nope']), /No chat nope/);
  assert.throws(() => r.run('child-ask', ['nope']), /No chat nope/);
  // the seeded waiting sub-session is the default to answer
  assert.equal(r.run('child-answer'), 'dev-seed-linked-ask: answered "once" on the Mac');
});
