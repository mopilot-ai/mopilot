// Standard ACP forms exercise the real host and JSON-RPC entrypoint with an in-process agent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fakeSpawn } from './support/electron-acp-fake.ts';
const require = createRequire(import.meta.url);
const { AcpHost, CLIENT_CAPABILITIES } = require('../electron/harness/acp.cjs');
const tick = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};
const params = (sessionId = 's1') => ({
  mode: 'form',
  sessionId,
  message: 'Choose a strategy',
  requestedSchema: {
    type: 'object',
    properties: { choice: { type: 'string', oneOf: [{ const: 'opaque', title: 'Friendly label' }] } },
    required: ['choice'],
  },
});
async function setup() {
  const sp = fakeSpawn();
  const events: any[] = [];
  const host = new AcpHost({
    items: { readAsync: async () => [], append() {}, flush() {} },
    quirks: () => ({ label: 'Fake' }),
    resolveBin: () => '/fake',
    spawnFn: sp.spawnFn,
    pty: {},
  });
  host.on('event', (e: any) => events.push(e));
  await host.ensure('acp:fake:one', { chatId: 'chat', cwd: '/work' });
  return { host, p: sp.procs[0], events };
}
test('standard form capability and native typed form response preserve opaque values', async () => {
  assert.equal(CLIENT_CAPABILITIES.elicitation, undefined);
  const { host, p, events } = await setup();
  assert.deepEqual(p.received.find((m: any) => m.method === 'initialize').params.clientCapabilities.elicitation, { form: {} });
  const reply = p.request('elicitation/create', params());
  await tick();
  const form = events.find((e) => e.kind === 'question').question;
  assert.equal(form.kind, 'question');
  assert.equal(host.questions.answer('chat', form.id, { action: 'accept', content: { choice: 'opaque' } }).status, 'written');
  assert.deepEqual((await reply).result, { action: 'accept', content: { choice: 'opaque' } });
  host.closeAll();
});

const latest = (events: any[]) => events.filter((e) => e.kind === 'question').at(-1).question;
async function open(f: any, overrides: any = {}) {
  const reply = f.p.request('elicitation/create', { ...params(), ...overrides });
  await tick();
  return { reply, question: latest(f.events) };
}

test('independent forms settle in both orders and two windows accept the same owner only once', async () => {
  for (const order of [
    [0, 1],
    [1, 0],
  ]) {
    const f = await setup();
    const a = await open(f);
    const b = await open(f);
    const forms = [a, b];
    for (const i of order) {
      const first = f.host.questions.answer('chat', forms[i].question.id, { action: i ? 'decline' : 'cancel' });
      const second = f.host.questions.answer('chat', forms[i].question.id, { action: 'accept', content: { choice: 'opaque' } });
      assert.equal(first.status, 'written');
      assert.equal(second.status, 'written');
      assert.deepEqual((await forms[i].reply).result, { action: i ? 'decline' : 'cancel' });
    }
    assert.equal(f.p.received.filter((m: any) => m.result?.action).length, 2);
    assert.equal(f.host.questions.answer('other', a.question.id, { action: 'cancel' }).status, 'retired');
    const next = await open(f);
    assert.notEqual(next.question.id, a.question.id);
    f.host.cancel('acp:fake:one');
    await next.reply;
    f.host.closeAll();
  }
});

test('main revalidates answers, retains pending state on failure, and never grants a tool permission', async () => {
  const f = await setup();
  const q = await open(f);
  assert.equal(f.host.perms.size, 0);
  for (const answer of [
    null,
    { action: 'yes' },
    { action: 'accept', content: { choice: 'Friendly label' } },
    { action: 'accept', content: {} },
  ]) {
    assert.equal(f.host.questions.answer('chat', q.question.id, answer).status, 'pending');
  }
  assert.equal(
    f.p.received.some((m: any) => m.result?.action),
    false,
  );
  assert.equal(f.host.questions.answer('chat', q.question.id, { action: 'accept', content: { choice: 'opaque' } }).status, 'written');
  await q.reply;
  f.host.closeAll();
});

test('stop, close, reset/unbind, process loss, disposal and owner replacement retire questions before stale submissions', async () => {
  for (const mode of ['stop', 'close', 'unbind', 'exit', 'dispose', 'replace', 'starting-stop']) {
    const f = await setup();
    const q = await open(f);
    const chat = f.host.chats.get('acp:fake:one');
    if (mode === 'stop') f.host.cancel(chat.key);
    if (mode === 'close') f.host.close(chat.key);
    if (mode === 'unbind') f.host.unbindSession(chat, chat.sessionId);
    if (mode === 'exit') f.p.exit(1);
    if (mode === 'dispose') f.host.closeAll();
    if (mode === 'starting-stop') {
      f.host.starting.set(chat.key, { cancelled: false });
      f.host.cancel(chat.key);
    }
    if (mode === 'replace') f.host.chats.set(chat.key, { ...chat });
    assert.notEqual(
      f.host.questions.answer('chat', q.question.id, { action: 'accept', content: { choice: 'opaque' } }).status,
      'written',
      mode,
    );
    if (mode !== 'exit') assert.equal((await q.reply).error.code, -32800, mode);
    assert.equal(
      f.p.received.some((m: any) => m.result?.action === 'accept'),
      false,
    );
    f.host.closeAll();
  }
});

test('session questions survive turn completion and deferred retirement, while native cancellation matches only its connection and typed ID', async () => {
  const f = await setup();
  const a = await open(f);
  const nativeId = f.host.chats.get('acp:fake:one').agent.peer.incoming.live.keys().next().value;
  f.p.notify('$/cancel_request', { requestId: String(nativeId) });
  await tick();
  assert.equal(latest(f.events).status, 'pending');
  f.host.chats.get('acp:fake:one').prompting = { turnId: 't', human: true };
  f.host.finish(f.host.chats.get('acp:fake:one'), 'end_turn', null);
  await tick();
  assert.equal(latest(f.events).status, 'pending');
  f.p.notify('$/cancel_request', { requestId: nativeId });
  await tick();
  assert.equal((await a.reply).error.code, -32800);
  f.p.notify('$/cancel_request', { requestId: nativeId });
  await tick();
  const b = await open(f);
  const chat = f.host.chats.get('acp:fake:one');
  chat.prompting = { turnId: 'later', human: true };
  assert.equal(f.host.retireChat('chat'), 0);
  assert.equal(latest(f.events).status, 'pending');
  f.host.finish(chat, 'end_turn', null);
  await tick();
  assert.equal((await b.reply).error.code, -32800);
  f.host.closeAll();
});

test('numeric/string native IDs are distinct, duplicate live IDs cannot cancel or replace the original, and reconnect never replays', async () => {
  const f = await setup();
  const send = (id: any) => f.p.line(JSON.stringify({ jsonrpc: '2.0', id, method: 'elicitation/create', params: params() }) + '\n');
  send(9);
  send('9');
  send(9);
  await tick();
  const pending = f.events.filter((e) => e.kind === 'question' && e.question.status === 'pending');
  assert.equal(pending.length, 2);
  for (const event of pending) f.host.questions.answer('chat', event.question.id, { action: 'decline' });
  assert.deepEqual(
    f.p.received.filter((m: any) => m.result?.action).map((m: any) => m.id),
    [9, '9'],
  );
  const other = await setup();
  other.p.line(JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'elicitation/create', params: params() }) + '\n');
  await tick();
  const own = latest(other.events);
  f.p.line(JSON.stringify({ jsonrpc: '2.0', method: '$/cancel_request', params: { requestId: 9 } }) + '\n');
  assert.equal(own.status, 'pending');
  assert.equal(f.host.questions.answer('chat', own.id, { action: 'cancel' }).status, 'retired');
  other.host.questions.answer('chat', own.id, { action: 'cancel' });
  assert.equal(other.p.received.at(-1).result.action, 'cancel');
  other.host.closeAll();
  const old = pending[0].question.id;
  f.p.exit(0);
  await f.host.ensure('acp:fake:one', { chatId: 'chat', cwd: '/work' });
  assert.equal(f.host.questions.answer('chat', old, { action: 'cancel' }).status, 'retired');
  f.host.closeAll();
});

test('malformed IDs, unsupported mode/schema/scope, loading sessions and authentication fail closed', async () => {
  const f = await setup();
  for (const [changes, code] of [
    [{ mode: 'url' }, -32602],
    [{ mode: null }, -32602],
    [{ sessionId: 'other' }, -32800],
    [{ requestedSchema: { type: 'object', properties: { secret: { type: 'string', title: 'API key' } } } }, -32602],
    [{ sessionId: null, requestId: 3 }, -32800],
    [{ requestId: 3 }, -32602],
    [{ sessionId: null, requestId: {} }, -32602],
    [{ toolCallId: 9 }, -32602],
  ]) {
    assert.equal((await f.p.request('elicitation/create', { ...params(), ...(changes as any) })).error.code, code);
  }
  const chat = f.host.chats.get('acp:fake:one');
  chat.loading = true;
  assert.equal((await f.p.request('elicitation/create', params())).error.code, -32800);
  chat.loading = false;
  chat.agent.authenticating = true;
  assert.equal((await f.p.request('elicitation/create', params())).error.code, -32800);
  chat.agent.authenticating = false;
  await assert.rejects(f.host.onAgentRequest(chat.agent, 'elicitation/create', params()), { code: -32602 });
  const outside = { ...chat };
  f.host.chats.set(chat.key, outside);
  assert.equal((await f.p.request('elicitation/create', params())).error.code, -32800);
  f.host.chats.set(chat.key, chat);
  for (const id of [[], {}, Number.MAX_SAFE_INTEGER + 1, 1.5, 'x'.repeat(513)])
    f.p.line(JSON.stringify({ id, method: 'elicitation/create', params: params() }) + '\n');
  await tick();
  assert.equal(f.p.received.filter((m: any) => m.error?.code === -32600).length, 5);
  assert.equal(f.host.questions.entries.size, 0);
  f.host.closeAll();
});

test('transport failure is terminal and keeps a non-answerable snapshot; reentrant submission cannot write twice', async () => {
  const f = await setup();
  const q = await open(f);
  const original = f.p.stdin.write;
  let second: any;
  f.p.stdin.write = (s: string) => {
    second = f.host.questions.answer('chat', q.question.id, { action: 'cancel' });
    original(s);
    throw new Error('ambiguous write');
  };
  assert.equal(f.host.questions.answer('chat', q.question.id, { action: 'decline' }).status, 'failed');
  assert.equal(second.status, 'sending');
  assert.equal((await q.reply).result.action, 'decline');
  assert.equal(f.host.questions.answer('chat', q.question.id, { action: 'decline' }).status, 'failed');
  assert.match(latest(f.events).error, /could not be confirmed/);
  f.p.stdin.write = original;
  f.host.closeAll();
});

test('authentication retires old questions and new session questions work after it completes', async () => {
  const f = await setup();
  const q = await open(f);
  await f.host.authenticate('fake', 'login');
  assert.equal((await q.reply).error.code, -32800);
  const next = await open(f, { toolCallId: 'native-tool' });
  assert.equal(next.question.toolCallId, 'native-tool');
  f.host.questions.answer('chat', next.question.id, { action: 'cancel' });
  await next.reply;
  f.host.closeAll();
});

test('question snapshots initialize without a window and do not change turn/approval/composer state', () => {
  const { SessionStore } = require('../electron/session/state.cjs');
  const { ControllerEvents } = require('../electron/session/controllerEvents.cjs');
  const state = new SessionStore();
  const notifications: any[] = [];
  const controller = {
    state,
    chatOf: () => 'chat',
    isCurrentSource: () => true,
    say: (...a: any[]) => notifications.push(a),
    learnSavedName: () => undefined,
    afterName: (_id: string, fn: () => void) => fn(),
  };
  const e = {
    key: 'acp:fake:one',
    kind: 'question',
    question: { status: 'pending', harness: 'Fake' },
    questions: [{ id: 'q', kind: 'question', status: 'pending' }],
  };
  ControllerEvents.prototype.onAcpEvent.call(controller, e);
  assert.equal(state.get('chat').turn, 'idle');
  assert.deepEqual(state.get('chat').approvals, []);
  assert.equal(state.get('chat').questions.length, 1);
  state.patch('chat', { turn: 'running' });
  ControllerEvents.prototype.onAcpEvent.call(controller, { ...e, question: { status: 'cancelled' }, questions: [] });
  assert.equal(state.get('chat').turn, 'running');
  assert.equal(notifications.length, 1);
  controller.isCurrentSource = () => false;
  ControllerEvents.prototype.onAcpEvent.call(controller, e);
  assert.deepEqual(state.get('chat').questions, []);
  state.chats.delete('chat');
  ControllerEvents.prototype.onAcpEvent.call(controller, { ...e, question: { id: 'old', status: 'cancelled' } });
  assert.equal(state.has('chat'), false);
});

test('retired segment cards settle without replacing current cards, and late stale-source questions cancel immediately', async () => {
  const f = await setup();
  const { SessionStore } = require('../electron/session/state.cjs');
  const { ControllerEvents } = require('../electron/session/controllerEvents.cjs');
  const state = new SessionStore();
  let current = true;
  const controller = {
    state,
    acp: f.host,
    chatOf: () => 'chat',
    isCurrentSource: () => current,
    say() {},
    learnSavedName: () => undefined,
  };
  f.host.on('event', (e: any) => {
    if (e.kind === 'question') ControllerEvents.prototype.onAcpEvent.call(controller, e);
  });
  const old = await open(f);
  current = false;
  const newer = { id: 'new-owner', status: 'pending', kind: 'question' };
  state.patch('chat', { questions: [...state.get('chat').questions, newer] });
  f.host.questions.retire(f.host.chats.get('acp:fake:one'));
  assert.equal((await old.reply).error.code, -32800);
  assert.equal(state.get('chat').questions[0].status, 'cancelled');
  assert.deepEqual(state.get('chat').questions[1], newer);
  const late = f.p.request('elicitation/create', params());
  await tick();
  assert.equal(f.host.questions.entries.size, 0);
  assert.equal((await late).error.code, -32800);
  assert.deepEqual(state.get('chat').questions[1], newer);
  current = true;
  const replacement = await open(f);
  assert.equal(replacement.question.status, 'pending');
  current = false;
  ControllerEvents.prototype.onAcpEvent.call(controller, {
    key: 'acp:fake:one',
    kind: 'question',
    question: { id: 'unknown', status: 'cancelled' },
  });
  assert.equal(state.get('chat').questions[0].id, replacement.question.id);
  f.host.closeAll();
});

test('trusted session IPC refuses foreign, read-only, stale-source and unknown request owners, with one write for two windows', async () => {
  const { registerQuestions } = require('../electron/session/questionIpc.cjs');
  const handlers: any = {};
  const f = await setup();
  const q = await open(f);
  const a = { id: 1 },
    b = { id: 2 },
    foreign = { id: 3 };
  let current = true;
  const deps = {
    execWindows: new Set([a, b]),
    viewedBy: new Map([
      [1, { visible: ['chat'], focused: 'chat' }],
      // a split pane that isn't focused still answers for its chat
      [2, { visible: ['other', 'chat'], focused: 'other' }],
    ]),
    live: { acpHost: f.host, controller: { isCurrentSource: () => current } },
  };
  registerQuestions({ handle: (n: string, fn: any) => (handlers[n] = fn) }, deps);
  const answer = handlers['session:answerQuestion'];
  for (const [sender, chat, id] of [
    [foreign, 'chat', q.question.id],
    [a, 'other', q.question.id],
    [a, null, q.question.id],
    [a, 'chat', 3],
  ])
    assert.equal(answer({ sender }, chat, id, { action: 'cancel' }).status, 'denied');
  assert.equal(answer({ sender: a }, 'chat', 'unknown', { action: 'cancel' }).status, 'retired');
  assert.equal(answer({ sender: a }, 'chat', q.question.id, { action: 'cancel' }).status, 'written');
  assert.equal(answer({ sender: b }, 'chat', q.question.id, { action: 'decline' }).status, 'written');
  await q.reply;
  const next = await open(f);
  current = false;
  assert.equal(answer({ sender: a }, 'chat', next.question.id, { action: 'decline' }).status, 'retired');
  await next.reply;
  f.host.closeAll();
});

test('native permissions retain allow-once, cancellation, raw tool context and malformed-option behavior', async () => {
  const f = await setup();
  const chat = f.host.chats.get('acp:fake:one');
  chat.serverName = 'sage_0123456789ab';
  const options = [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }];
  const toolCall = { title: 'mcp__sage_0123456789ab__echo', rawInput: {} };
  assert.deepEqual(await f.host.onAgentRequest(chat.agent, 'session/request_permission', { sessionId: 's1', toolCall, options }), {
    outcome: { outcome: 'selected', optionId: 'yes' },
  });
  assert.deepEqual(await f.host.onAgentRequest(chat.agent, 'session/request_permission', { sessionId: 's1', options: 'bad' }), {
    outcome: { outcome: 'cancelled' },
  });
  chat.prompting = { turnId: 't' };
  const reply = f.host.requestPermission(chat, { toolCall, options: [] });
  const id = f.events.find((e) => e.kind === 'permission').requestId;
  assert.equal(f.host.permission(id, 'once'), true);
  assert.deepEqual(await reply, { outcome: { outcome: 'selected', optionId: 'once' } });
  delete f.host.items.flush;
  const noTool = f.host.requestPermission(chat, {});
  const id2 = f.events.filter((e) => e.kind === 'permission').at(-1).requestId;
  f.host.permission(id2, null);
  assert.deepEqual(await noTool, { outcome: { outcome: 'cancelled' } });
  f.host.closeAll();
});

test('pending capacity is bounded and a failed snapshot publisher cancels rather than leaking a resolver', async () => {
  const f = await setup();
  const pending: any[] = [];
  for (let i = 0; i < 24; i++) pending.push((await open(f)).reply);
  assert.equal((await f.p.request('elicitation/create', params())).error.code, -32800);
  f.host.cancel('acp:fake:one');
  await Promise.all(pending);
  // Simulate other sessions' still-pending questions at the host-wide bound.
  for (let i = 0; i < 128; i++) f.host.questions.entries.set(`other-${i}`, { chat: {}, view: { id: `other-${i}`, status: 'pending' } });
  assert.equal((await f.p.request('elicitation/create', params())).error.code, -32800);
  f.host.questions.entries.clear();
  f.host.on('event', (e: any) => {
    if (e.kind === 'question') throw new Error('unavailable publisher');
  });
  assert.equal((await f.p.request('elicitation/create', params())).error.code, -32800);
  assert.equal(f.host.chats.get('acp:fake:one').agent.peer.incoming.live.size, 0);
  f.host.closeAll();
});

test('deferred transport refuses an already-owned id and a second response; normal request defaults/errors remain backward compatible', async () => {
  const { IncomingRequests } = require('../electron/harness/acp/incoming.cjs');
  const frames: any[] = [];
  const incoming = new IncomingRequests({ send: (m: any) => frames.push(m) });
  const one = incoming.context(1);
  one.defer(() => {});
  assert.throws(() => incoming.context(1).defer(() => {}), { code: -32600 });
  assert.equal(one.respond({}).status, 'written');
  assert.equal(one.respond({}).status, 'retired');
  const { RpcPeer, AcpAgent } = require('../electron/harness/acp.cjs');
  const { PassThrough } = require('node:stream');
  const output = { write: (s: string) => frames.push(JSON.parse(s)) };
  const peer = new RpcPeer({
    input: new PassThrough(),
    output,
    onRequest: (method: string) => {
      if (method === 'bad') throw 'bad';
      if (method === 'weird') throw { code: 'oops', message: undefined };
    },
  });
  peer.receive({ id: 3, method: 'empty' });
  peer.receive({ id: 4, method: 'bad' });
  peer.receive({ id: 5, method: 'weird' });
  await tick();
  assert.equal(frames.find((m) => m.id === 3).result, null);
  assert.equal(frames.find((m) => m.id === 4).error.code, -32603);
  const sp = fakeSpawn();
  const agent = new AcpAgent({ harness: 'login', command: '/fake', env: {}, cwd: '/work', spawnFn: sp.spawnFn, onRequest: () => null });
  agent.start();
  await agent.initialize();
  assert.equal(sp.procs[0].received[0].params.clientCapabilities.elicitation, undefined);
  agent.kill();
  peer.close();
});

test('explicit bearer-token credentials settle unsupported at the native entrypoint', async () => {
  const f = await setup();
  const reply = f.p.request('elicitation/create', {
    ...params(),
    message: 'Paste your bearer token to sign in',
    requestedSchema: { type: 'object', properties: { credential: { type: 'string', title: 'Bearer token' } }, required: ['credential'] },
  });
  await tick();
  try {
    assert.equal(f.host.questions.entries.size, 0);
    assert.equal((await reply).error.code, -32602);
  } finally {
    f.host.closeAll();
    await reply;
  }
});

test('impossible enum constraints settle unsupported before a native form is displayed', async () => {
  const f = await setup();
  const reply = f.p.request('elicitation/create', {
    ...params(),
    requestedSchema: { type: 'object', properties: { choice: { type: 'string', enum: ['a'], minLength: 2 } }, required: ['choice'] },
  });
  await tick();
  try {
    assert.equal(f.host.questions.entries.size, 0);
    assert.equal((await reply).error.code, -32602);
  } finally {
    f.host.closeAll();
    await reply;
  }
});
