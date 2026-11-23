// An MCP server asking the person for input through a Claude tool (#4001): the Host tells it as a form question (or a card that shows a sign-in link), the answer travels on `chat.answer` as an action and values, and the app shows the form with its own question cards. A: ids and answers; W: a closed or replayed card is not shown; B: what the Host cannot ask or the app cannot take is declined, not left waiting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createChatState } from '../electron/host/remoteChatState.cjs';
import { AcpQuestions } from '../electron/harness/acp/questions.cjs';
import { ELICITATION_LINK_OPTIONS, createTurnBridge } from '../host/src/turnBridge.mjs';
import { parseParams } from '../shared/host/schema.mjs';
import { needsStream2 } from '../shared/host/stream2.mjs';
import { CHAT, FakeItems, createRemoteChats, fakeHost, tick } from './support/host/remoteChatsKit.ts';

const require = createRequire(import.meta.url);
void require;
const SCHEMA = { type: 'object', properties: { name: { type: 'string', title: 'Name' } }, required: ['name'] };

function bridgeWorld() {
  const events: any[] = [];
  const answers: any[] = [];
  const resolved: string[] = [];
  const bridge = createTurnBridge({
    state: { get: () => ({ activeTurn: { id: 'pending-t1' } }) },
    emit: (e: any) => events.push(e),
    controller: () =>
      ({ ref: () => ({ kind: 'claude' }), chatOf: (k: string) => k, resolveApproval: (id: string) => resolved.push(id) }) as any,
    answer: (id: string, result: object) => (answers.push([id, result]), true),
  });
  const ask = (extra: object = {}) =>
    bridge.harnessEvent({
      kind: 'elicitation',
      key: 'claude:a',
      requestId: 'e1',
      serverName: 'srv',
      message: 'Who are you?',
      mode: 'form',
      requestedSchema: SCHEMA,
      ...extra,
    });
  return { bridge, events, answers, resolved, ask, start: () => bridge.patched({ chatId: 'claude:a', patch: { turn: 'running' } }) };
}

test('A: a form is a question card of the turn, and the values the person gives reach the server once', () => {
  const w = bridgeWorld();
  w.start();
  w.ask({ title: 'Profile' });
  const q = w.events.find((e) => e.kind === 'question');
  assert.deepEqual(
    [q.key, q.turnId, q.question.id, q.question.message, q.question.status],
    ['claude:a', 't1', 'e1', 'Profile: Who are you?', 'pending'],
  );
  assert.equal(q.question.form.fields[0].key, 'name');
  assert.equal(w.bridge.permit({ requestId: 'e1', form: { action: 'accept', content: { name: 'Ada' } } }), true);
  assert.deepEqual(JSON.parse(JSON.stringify(w.answers)), [['e1', { action: 'accept', content: { name: 'Ada' } }]]);
  assert.deepEqual(w.resolved, ['e1']);
  // answered once: the card is gone
  assert.equal(w.bridge.permit({ requestId: 'e1', form: { action: 'cancel' } }), false);
});

test('B: values that do not fit the form, or no form answer at all, decline; a cancel is a cancel', () => {
  for (const [given, expected] of [
    [{ action: 'accept', content: { name: 5 } }, { action: 'decline' }],
    [undefined, { action: 'decline' }],
    [{ action: 'cancel' }, { action: 'cancel' }],
  ] as const) {
    const w = bridgeWorld();
    w.start();
    w.ask();
    w.bridge.permit({ requestId: 'e1', form: given as any });
    assert.deepEqual(w.answers, [['e1', expected]]);
  }
});

test('B: a form this app cannot draw is declined, and so is one asked when no turn runs', () => {
  const w = bridgeWorld();
  w.start();
  w.ask({ requestedSchema: { type: 'string' } });
  assert.deepEqual(w.answers, [['e1', { action: 'decline' }]]);
  assert.equal(
    w.events.some((e) => e.kind === 'question'),
    false,
  );
  const idle = bridgeWorld();
  idle.ask();
  assert.deepEqual(idle.answers, [['e1', { action: 'cancel' }]]);
});

test('A: a sign-in link is a card that shows it: "I opened it" accepts, anything else cancels', () => {
  const w = bridgeWorld();
  w.start();
  w.ask({ mode: 'url', url: 'https://srv.test/login', requestedSchema: null });
  const card = w.events.find((e) => e.kind === 'permission');
  assert.deepEqual(card.options, ELICITATION_LINK_OPTIONS);
  assert.match(card.toolCall.title, /Who are you\? https:\/\/srv\.test\/login/);
  w.bridge.permit({ requestId: 'e1', optionId: 'done' });
  assert.deepEqual(w.answers.at(-1), ['e1', { action: 'accept' }]);
  w.ask({ mode: 'url', url: null, requestId: 'e2', message: undefined });
  w.bridge.permit({ requestId: 'e2', optionId: 'cancel' });
  assert.deepEqual(w.answers.at(-1), ['e2', { action: 'cancel' }]);
  assert.equal(w.events.filter((e) => e.kind === 'permission').at(-1).toolCall.title, '');
});

test('B: the wire takes a form answer within bounds, and an end without stream2 is not sent a question', () => {
  const base = { chatId: 'claude:a', epoch: 1, key: 'key-form-0000001', requestId: 'e1' };
  assert.deepEqual(parseParams('chat.answer', { ...base, form: { action: 'accept', content: { name: 'Ada' } } }).form, {
    action: 'accept',
    content: { name: 'Ada' },
  });
  assert.deepEqual(parseParams('chat.answer', { ...base, form: { action: 'cancel' } }).form, { action: 'cancel' });
  assert.equal('form' in parseParams('chat.answer', base), false);
  for (const form of [
    'x',
    [],
    { action: 'maybe' },
    { action: 'accept', content: [] },
    { action: 'accept', content: { a: 'x'.repeat(70_000) } },
  ])
    assert.throws(() => parseParams('chat.answer', { ...base, form }), /form answer/);
  assert.equal(needsStream2({ kind: 'question', question: {} }), true);
});

/** Questions as the app keeps them, over a bus the test reads. */
function questionsWorld() {
  const published: any[] = [];
  const q = new AcpQuestions({ emitEvent: (e: any) => published.push(e), chats: new Map(), label: (h: string) => h } as any);
  const sent: any[] = [];
  let result: Promise<boolean> = Promise.resolve(true);
  const view = { id: 'e1', kind: 'question', message: 'Who?', toolCallId: null, form: bridgeFormOf() };
  const open = () => q.openRemote({ chatId: CHAT, label: 'Claude Code', view, send: async (a: any) => (sent.push(a), result) });
  return { q, published, sent, open, willResolve: (p: Promise<boolean>) => (result = p) };
}
function bridgeFormOf() {
  const w = bridgeWorld();
  w.start();
  w.ask();
  return w.events.find((e) => e.kind === 'question').question.form;
}

test('A: the app shows the machine’s question as its own form card; an answer is checked, sent to the machine, and the card says what came of it', async () => {
  const w = questionsWorld();
  w.open();
  assert.equal(w.published.length, 1);
  assert.deepEqual([w.published[0].key, w.published[0].question.harness, w.published[0].question.status], [CHAT, 'Claude Code', 'pending']);
  w.open();
  assert.equal(w.published.length, 1, 'the same question is not opened twice');
  assert.equal(w.q.owner(CHAT, 'e1')?.view.id, 'e1');
  // values that do not fit are refused here, not sent
  assert.deepEqual(w.q.answer(CHAT, 'e1', { action: 'accept', content: { name: 5 } }), {
    status: 'pending',
    error: 'Check the required fields and allowed values.',
  });
  assert.deepEqual(w.sent, []);
  assert.deepEqual(w.q.answer(CHAT, 'e1', { action: 'accept', content: { name: 'Ada' } }), { status: 'written' });
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(w.sent)), [{ action: 'accept', content: { name: 'Ada' } }]);
  // the machine's Host took it: that is the receipt, and the card settles to answered (not left at "written")
  assert.equal(w.q.owner(CHAT, 'e1')?.view.status, 'answered');
  assert.equal(w.published.at(-1).question.status, 'answered');
});

test('B: a send the machine no longer wants, or cannot take, is said on the card; a closed question is cancelled without a reply', async () => {
  const gone = questionsWorld();
  gone.open();
  gone.willResolve(Promise.resolve(false));
  gone.q.answer(CHAT, 'e1', { action: 'decline' });
  await tick();
  assert.equal(gone.q.owner(CHAT, 'e1')?.view.status, 'retired');
  const down = questionsWorld();
  down.open();
  down.willResolve(Promise.reject(new Error('unreachable')));
  down.q.answer(CHAT, 'e1', { action: 'decline' });
  await tick();
  assert.deepEqual(
    [down.q.owner(CHAT, 'e1')?.view.status, down.q.owner(CHAT, 'e1')?.view.error],
    ['failed', 'The machine could not be reached. Ask again.'],
  );
  const closed = questionsWorld();
  closed.open();
  closed.q.closeRemote('e1');
  assert.equal(closed.q.owner(CHAT, 'e1')?.view.status, 'cancelled');
  closed.q.closeRemote('e1');
  closed.q.closeRemote('nobody');
  assert.deepEqual(closed.sent, []);
  // an entry that is not a machine's is left alone; a view with no id opens nothing
  const none = questionsWorld();
  none.q.openRemote({ chatId: CHAT, label: 'x', view: {} as any, send: async () => true });
  assert.equal(none.published.length, 0);
  // retiring the chat's questions cancels them without a send
  const retired = questionsWorld();
  retired.open();
  retired.q.retire(retired.q.owner(CHAT, 'e1')!.chat);
  assert.deepEqual(retired.sent, []);
  // a publish that throws drops the entry
  const broken = new AcpQuestions({
    emitEvent: () => {
      throw new Error('no bus');
    },
    chats: new Map(),
    label: () => '',
  } as any);
  broken.openRemote({ chatId: CHAT, label: 'x', view: { id: 'z' }, send: async () => true });
  assert.equal(broken.owner(CHAT, 'z'), null);
});

test('A: the mirror opens the machine’s question as a form card, answers it through the Host, and closes it with the Host’s cancel; a replayed closed question is not shown again', async () => {
  const opened: any[] = [];
  const closed: string[] = [];
  const host = fakeHost();
  const answered: any[] = [];
  host.answer = async (p: any) => (answered.push(p), { answered: true });
  const items = new FakeItems();
  const chats = createRemoteChats({
    items,
    hostFor: () => host,
    ownerOf: () => ({ hostId: 'm1', folder: null }),
    emit: () => undefined,
    questions: () => ({ openRemote: (o: any) => opened.push(o), closeRemote: (id: string) => closed.push(id) }),
    now: () => 1000,
    report: () => undefined,
  });
  const ev = (event: object) => ({ t: 'event', family: 'claude', event });
  host.reply = {
    snapshot: {
      rev: 4,
      items: [
        ev({ kind: 'turnStart', turnId: 't1', user: { id: 'u', content: [] } }),
        ev({ kind: 'question', turnId: 't1', question: { id: 'old', kind: 'question' } }),
        ev({ kind: 'permissionCancelled', requestId: 'old' }),
        ev({ kind: 'question', turnId: 't1', question: { id: 'e1', kind: 'question', message: 'Who?' } }),
      ],
    },
    patches: null,
    generation: 'g1',
    inflight: [],
  };
  chats.follow('acp:host-claude:c1');
  await chats.settled('acp:host-claude:c1');
  assert.deepEqual(
    opened.map((o) => [o.chatId, o.label, o.view.id]),
    [['acp:host-claude:c1', 'Claude Code', 'acp:host-claude:c1|e1']],
  );
  assert.equal(await opened[0].send({ action: 'cancel' }), true);
  assert.deepEqual(answered, [{ chatId: 'acp:host-claude:c1', requestId: 'e1', form: { action: 'cancel' } }]);
  host.fire.patch('acp:host-claude:c1', 5, ev({ kind: 'permissionCancelled', requestId: 'e1' }));
  await tick();
  assert.ok(closed.includes('acp:host-claude:c1|e1'), 'the card id the app shows is the chat’s own');
  // other chats' labels, a question with no id, and no questions service at all
  host.fire.patch('acp:host-claude:c1', 6, ev({ kind: 'question', turnId: 't2', question: {} }));
  await tick();
  assert.equal(opened.length, 1);
  void CHAT;
});

test('A: the form card names the agent by the chat’s harness', () => {
  const labels: string[] = [];
  const state = createChatState({
    items: new FakeItems() as any,
    emit: () => undefined,
    state: () => null,
    questions: () => ({ openRemote: (o: any) => labels.push(o.label), closeRemote: () => undefined }),
    now: () => 0,
    note: () => undefined,
  });
  for (const chatId of ['acp:host-claude:a', 'acp:host-codex:b', 'acp:kimi:c'])
    state.question({ chatId, host: {} }, { question: { id: 'q' } });
  assert.deepEqual(labels, ['Claude Code', 'Codex', 'The agent']);
});

test('#4025: Claude’s AskUserQuestion is a form card; the values go back as the tool’s answers, and anything but a fitting accept refuses the call', () => {
  const input = {
    questions: [
      { question: 'Which test runner?', header: 'Runner', options: [{ label: 'node' }, { label: 'vitest' }] },
      { question: 'Pick some', multiSelect: true, options: [{ label: 'a' }, { label: 'b' }] },
    ],
  };
  const ask = (w: ReturnType<typeof bridgeWorld>, extra: object = {}) =>
    w.bridge.harnessEvent({
      kind: 'permission',
      key: 'claude:a',
      requestId: 'p1',
      toolName: 'AskUserQuestion',
      toolUseID: 'tu1',
      input,
      ...extra,
    });
  const w = bridgeWorld();
  w.start();
  ask(w);
  const q = w.events.find((e) => e.kind === 'question');
  assert.deepEqual([q.question.id, q.question.toolCallId, q.question.form.fields.length], ['p1', 'tu1', 2]);
  w.bridge.permit({ requestId: 'p1', form: { action: 'accept', content: { q0: 'vitest', q1: ['a', 'b'] } } });
  assert.deepEqual(JSON.parse(JSON.stringify(w.answers)), [
    ['p1', { behavior: 'allow', updatedInput: { ...input, answers: { 'Which test runner?': 'vitest', 'Pick some': 'a, b' } } }],
  ]);
  for (const given of [{ action: 'decline' }, undefined, { action: 'accept', content: { q0: 'jest', q1: ['a'] } }]) {
    const d = bridgeWorld();
    d.start();
    ask(d);
    d.bridge.permit({ requestId: 'p1', form: given as any });
    assert.deepEqual(d.answers, [['p1', { behavior: 'deny', message: 'The user declined.' }]]);
  }
  // questions this Host cannot draw stay an ordinary allow/deny card
  const plain = bridgeWorld();
  plain.start();
  ask(plain, { input: { questions: 'nope' } });
  assert.equal(
    plain.events.some((e) => e.kind === 'question'),
    false,
  );
  assert.equal(
    plain.events.some((e) => e.kind === 'permission'),
    true,
  );
});

test('B: AskUserQuestion with no questions is a plain card; one without a question text or a tool id is told with what it has', () => {
  const ask = (w: ReturnType<typeof bridgeWorld>, input: any, extra: object = {}) =>
    w.bridge.harnessEvent({ kind: 'permission', key: 'claude:a', requestId: 'p1', toolName: 'AskUserQuestion', input, ...extra });
  const empty = bridgeWorld();
  empty.start();
  ask(empty, { questions: [] });
  assert.equal(
    empty.events.some((e) => e.kind === 'question'),
    false,
  );
  const w = bridgeWorld();
  w.start();
  ask(w, { questions: [{ header: 'Runner', options: [{ label: 'node' }, { label: 'vitest' }] }] });
  assert.equal(w.events.find((e) => e.kind === 'question').question.toolCallId, null);
  w.bridge.permit({ requestId: 'p1', form: { action: 'accept', content: { q0: 'node' } } });
  assert.deepEqual((w.answers[0][1] as any).updatedInput.answers, { q0: 'node' });
});

test('#4025: a rule the CLI suggests is offered as "Always allow" and goes back with the allow; a plan is approved or kept planning', () => {
  const rule = [{ type: 'addRules', rules: [{ toolName: 'Bash', ruleContent: 'npm test:*' }], behavior: 'allow', destination: 'session' }];
  const ask = (w: ReturnType<typeof bridgeWorld>, extra: object) =>
    w.bridge.harnessEvent({
      kind: 'permission',
      key: 'claude:a',
      requestId: 'p1',
      toolName: 'Bash',
      input: { command: 'npm test' },
      ...extra,
    });
  const w = bridgeWorld();
  w.start();
  ask(w, { suggestions: rule });
  const card = w.events.find((e) => e.kind === 'permission');
  assert.deepEqual(
    card.options.map((o: any) => o.optionId),
    ['allow', 'allow_always', 'deny'],
  );
  // the app's own word for a This Mac chat's card: the CLI decides where the rule lands, so never "Always"
  assert.equal(card.options.find((o: any) => o.optionId === 'allow_always').name, 'Allow for this session');
  w.bridge.permit({ requestId: 'p1', optionId: 'allow_always' });
  assert.deepEqual(w.answers, [['p1', { behavior: 'allow', updatedInput: { command: 'npm test' }, updatedPermissions: rule }]]);
  // no suggestion, no extra answer; an "always allow" for a card that had none is only an allow-less refusal
  const none = bridgeWorld();
  none.start();
  ask(none, { suggestions: [] });
  assert.deepEqual(
    none.events.find((e) => e.kind === 'permission').options.map((o: any) => o.optionId),
    ['allow', 'deny'],
  );
  none.bridge.permit({ requestId: 'p1', optionId: 'allow_always' });
  assert.equal((none.answers[0][1] as any).behavior, 'deny');
  const plan = bridgeWorld();
  plan.start();
  ask(plan, { toolName: 'ExitPlanMode', input: { plan: '1. do it' } });
  const planCard = plan.events.find((e) => e.kind === 'permission');
  assert.deepEqual(
    [planCard.toolCall.title, planCard.toolCall.rawInput, planCard.options.map((o: any) => o.name)],
    ['Approve this plan?', '1. do it', ['Approve plan', 'Keep planning']],
  );
  plan.bridge.permit({ requestId: 'p1', optionId: 'allow' });
  assert.equal((plan.answers[0][1] as any).behavior, 'allow');
});

test('A: a question asked as the app’s own card takes the card’s answers (an Other, a skip), declines or cancels, refuses anything else, and comes back to be answered when the machine is unreachable', async () => {
  const published: any[] = [];
  const q = new AcpQuestions({ emitEvent: (e: any) => published.push(e), chats: new Map(), label: (h: string) => h } as any);
  const sent: any[] = [];
  let result: Promise<boolean> = Promise.resolve(true);
  const asked = [
    { id: 'q1', question: 'Which?', header: null, options: [{ label: 'a' }], multiSelect: false, isOther: true, isSecret: false },
  ];
  const open = (id: string) =>
    q.openRemote({
      chatId: CHAT,
      label: 'Codex',
      view: { id, kind: 'question', message: 'A question for you', form: { fields: [] }, asked },
      send: async (a: any) => (sent.push(a), result),
    });
  open('k1');
  const own = { action: 'accept', content: { answers: { q1: { answers: ['my own words'] }, stray: { answers: ['x'] } } } };
  assert.deepEqual(q.answer(CHAT, 'k1', own), { status: 'written' });
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{ action: 'accept', content: { answers: { q1: { answers: ['my own words'] } } } }]);
  assert.equal(q.owner(CHAT, 'k1')?.view.status, 'answered');
  for (const action of ['decline', 'cancel']) {
    open(`k-${action}`);
    assert.deepEqual(q.answer(CHAT, `k-${action}`, { action }), { status: 'written' });
  }
  await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(sent.slice(1))), [{ action: 'decline' }, { action: 'cancel' }]);
  // not an answer to these questions: refused here, nothing sent
  open('k2');
  const before = sent.length;
  for (const bad of [{ action: 'accept', content: { q1: 'a' } }, { action: 'accept' }, { action: 'maybe' }, null])
    assert.deepEqual(q.answer(CHAT, 'k2', bad), { status: 'pending', error: 'Check the required fields and allowed values.' });
  assert.equal(sent.length, before);
  // the machine cannot be reached: the card is pending again, with the cause (a form stays failed)
  result = Promise.reject(new Error('unreachable'));
  q.answer(CHAT, 'k2', own);
  await tick();
  assert.equal(q.owner(CHAT, 'k2')?.view.status, 'pending');
  assert.equal(q.owner(CHAT, 'k2')?.view.error, 'The machine could not be reached. Ask again.');
  result = Promise.resolve(true);
  assert.deepEqual(q.answer(CHAT, 'k2', own), { status: 'written' });
  await tick();
  assert.equal(q.owner(CHAT, 'k2')?.view.status, 'answered');
  assert.ok(published.length > 3);
});

test('B: the Mac reads the machine’s asked questions again within the bounds: a list that is not one, or has nothing to ask, is the form card', () => {
  const opened: any[] = [];
  const state = createChatState({
    items: {} as any,
    emit: () => undefined,
    state: {} as any,
    questions: () => ({ openRemote: (o: any) => opened.push(o), closeRemote: () => undefined }),
    now: () => 1,
    note: () => undefined,
  } as any);
  const ask = (asked: unknown) =>
    state.question({ chatId: 'acp:host-codex:1', host: {} } as any, { question: { id: 'q', form: { fields: [] }, asked } });
  ask('abc');
  ask([{ nothing: 1 }]);
  ask(Array.from({ length: 40 }, (_, i) => ({ id: i, question: 'q' })));
  ask(undefined);
  assert.deepEqual(
    opened.map((o) => (o.view.asked === undefined ? 'none' : o.view.asked.length)),
    [0, 0, 16, 'none'],
  );
});
