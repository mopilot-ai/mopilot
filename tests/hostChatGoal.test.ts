// A machine chat's goal controls on the Host (M58, `chat.goal` and the `goal` flag of chat.send/chat.start): the request's shape (A), what each family does with it and how a repeat is served (W), what an agent without goals or a Host without the feature answers (B), and that a goal's words are the app's own (I).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createEpochStore } from '../host/src/epochs.mjs';
import { createGuard } from '../host/src/guard.mjs';
import { createLedger } from '../host/src/ledger.mjs';
import { createProtocol } from '../host/src/protocol.mjs';
import chatGoal from '../host/src/methods/chatGoal.mjs';
import { createCodexFamily } from '../host/src/codexFamily.mjs';
import { createCodexGoals } from '../host/src/codexGoals.mjs';
import { goalRuntime } from '../host/src/goalRuntime.mjs';
import { agentLabel } from '../shared/host/agentReadiness.mjs';
import { GOAL_ACTIONS, GOAL_FEATURE } from '../shared/host/chatGoal.mjs';
import { FEATURES, helloParams, parseParams, requireFeatures } from '../shared/host/schema.mjs';
import { unsupportedGoalWords } from '../shared/codexGoals.mjs';

const quiet = { report: () => undefined };
const scope = { chatId: 'claude:00000000-0000-4000-8000-000000000001', epoch: 1, key: 'key-goal-0001-00' };
const bad = (e: any) => e.code === 'invalid';

test('A: the request names the chat and one action of the goal bar; only the fields an action takes are kept', () => {
  for (const action of ['pause', 'resume', 'extend'])
    assert.deepEqual(parseParams('chat.goal', { ...scope, action, human: true, tokens: 5, objective: 'x' }), { ...scope, action });
  assert.deepEqual(parseParams('chat.goal', { ...scope, action: 'clear' }), { ...scope, action: 'clear' });
  assert.deepEqual(parseParams('chat.goal', { ...scope, action: 'clear', human: true }), { ...scope, action: 'clear', human: true });
  assert.deepEqual(parseParams('chat.goal', { ...scope, action: 'clear', human: 'yes' }), { ...scope, action: 'clear' });
  assert.deepEqual(parseParams('chat.goal', { ...scope, action: 'budget', tokens: 200_000 }), {
    ...scope,
    action: 'budget',
    tokens: 200_000,
  });
  assert.deepEqual(parseParams('chat.goal', { ...scope, action: 'budget', tokens: null }), { ...scope, action: 'budget', tokens: null });
  assert.deepEqual(parseParams('chat.goal', { ...scope, action: 'edit', objective: '  ship it  ' }), {
    ...scope,
    action: 'edit',
    objective: 'ship it',
  });
  assert.deepEqual([...GOAL_ACTIONS], ['pause', 'resume', 'extend', 'clear', 'budget', 'edit']);
  for (const wrong of [
    {},
    { action: 'set' },
    { action: 7 },
    { action: 'budget' },
    { action: 'budget', tokens: 0 },
    { action: 'budget', tokens: -5 },
    { action: 'budget', tokens: 1.5 },
    { action: 'budget', tokens: '200k' },
    { action: 'edit' },
    { action: 'edit', objective: '   ' },
    { action: 'edit', objective: 'x'.repeat(100_001) },
    { action: 'edit', objective: 9 },
  ])
    assert.throws(() => parseParams('chat.goal', { ...scope, ...wrong }), bad, JSON.stringify(wrong));
  assert.throws(() => parseParams('chat.goal', { action: 'pause', epoch: 1, key: scope.key }), bad);
});

test('A: a message sets the goal with `goal: true` (its text is the objective); anything else leaves the flag out', () => {
  const send = { ...scope, text: 'make the tests pass' };
  assert.equal((parseParams('chat.send', { ...send, goal: true }) as any).goal, true);
  assert.equal('goal' in (parseParams('chat.send', { ...send, goal: 'yes' }) as any), false);
  assert.equal('goal' in (parseParams('chat.send', send) as any), false);
  const start = { ...send, harness: 'codex', projectId: null };
  assert.equal((parseParams('chat.start', { ...start, goal: true }) as any).goal, true);
  assert.equal('goal' in (parseParams('chat.start', { ...start, goal: false }) as any), false);
});

test('I: a goal needs the feature on both ends: an older end or Host is refused, never served a plain message', () => {
  assert.ok(FEATURES.includes(GOAL_FEATURE));
  const full = { features: [...FEATURES] };
  const without = { features: FEATURES.filter((f: string) => f !== GOAL_FEATURE) };
  assert.doesNotThrow(() => requireFeatures('chat.goal', full, {}));
  assert.doesNotThrow(() => requireFeatures('chat.send', full, { goal: true } as any));
  for (const [method, params] of [
    ['chat.goal', {}],
    ['chat.send', { goal: true }],
    ['chat.start', { goal: true }],
  ] as const)
    assert.throws(
      () => requireFeatures(method, without, params as any),
      (e: any) => e.code === 'feature_missing' && e.missing.includes(GOAL_FEATURE),
      method,
    );
  // a message that sets no goal never needs it
  assert.doesNotThrow(() => requireFeatures('chat.send', without, {}));
  assert.doesNotThrow(() => requireFeatures('chat.send', without, { goal: false } as any));
});

/** What the runtime was asked to send. */
const sends: any[] = [];

function protocol(goal?: (p: any) => Promise<unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-goal-'));
  const host: any = new EventEmitter();
  host.cancel = () => undefined;
  const runtime: any = {
    host,
    send: async (p: any) => (sends.push(p), { turnId: 't' }),
    permit: () => true,
    familyOf: () => 'claude',
    ...(goal ? { goal } : {}),
  };
  const epochs = createEpochStore(path.join(dir, 'e.json'), quiet);
  const guard = createGuard({ epochs, ledger: createLedger(path.join(dir, 'l'), quiet) });
  const conn = createProtocol({ runtime, epochs, guard, status: () => ({ running: true, harnesses: [] }) }).connection(() => undefined);
  return {
    conn,
    call: (p: any) => conn.call('chat.goal', { ...scope, ...p }),
    send: (p: any) => conn.call('chat.send', { ...scope, text: 'make it SLOW', ...p }),
  };
}

test('W: the Host runs the action once however often a key is sent, and answers with the goal the chat has after it', async () => {
  const ran: any[] = [];
  const p = protocol(async (a) => (ran.push(a), { objective: 'ship', status: 'paused' }));
  const hello = await p.conn.call('host.hello', helloParams());
  assert.ok(hello.agreed.features.includes(GOAL_FEATURE));
  const first = await p.call({ action: 'pause' });
  assert.deepEqual(first.result, { goal: { objective: 'ship', status: 'paused' } });
  assert.deepEqual((await p.call({ action: 'pause' })).result, first.result);
  assert.deepEqual(ran, [{ ...scope, action: 'pause' }]);
  // another key is another request; a runtime that has no goal to tell answers null
  const none = protocol(async () => undefined);
  await none.conn.call('host.hello', helloParams());
  assert.deepEqual((await none.call({ action: 'clear', human: true })).result, { goal: null });
});

test('W: a message that sets the goal reaches the runtime as one (the text is the objective); any other message does not', async () => {
  sends.length = 0;
  const p = protocol();
  await p.conn.call('host.hello', helloParams());
  await p.send({ goal: true, key: 'key-goal-send-01' });
  await p.send({ key: 'key-goal-send-02' });
  await p.send({ goal: false, key: 'key-goal-send-03' });
  assert.deepEqual(
    sends.map((s) => [s.text, s.goal]),
    [
      ['make it SLOW', true],
      ['make it SLOW', undefined],
      ['make it SLOW', undefined],
    ],
  );
});

test('B: a Host whose runtime cannot control a goal says so, and so does a client that did not declare the feature', async () => {
  const p = protocol();
  await p.conn.call('host.hello', helloParams());
  await assert.rejects(p.call({ action: 'pause' }), /cannot control a goal yet. Update it./);
  // the handler itself says so too, for a caller that skipped the gate
  await assert.rejects(chatGoal({ runtime: {} } as any).effects['chat.goal']({ ...scope, action: 'pause' }), /cannot control a goal yet/);
  const old = protocol(async () => null);
  await old.conn.call('host.hello', { ...helloParams(), features: helloParams().features.filter((f: string) => f !== GOAL_FEATURE) });
  await assert.rejects(old.call({ action: 'pause' }), (e: any) => e.code === 'feature_missing');
});

/** The runtime over stand-ins: `kinds` maps each chat to the kind its session runs on. */
function runtimeOf(kinds: Record<string, string>, owners: { claude?: any; codex?: any } = {}) {
  return goalRuntime({
    chats: { records: new Map(Object.keys(kinds).map((id) => [id, {}])) },
    state: { has: () => false },
    controller: { ref: (id: string) => ({ kind: kinds[id] }) },
    familyOf: (kind: string) => (kind.startsWith('acp:') ? 'acp' : kind),
    claude: owners.claude,
    codex: owners.codex,
  });
}

test('W: the goal bar’s action goes to the family the chat runs on now; a chat this Host does not have is unknown', async () => {
  const claude = { goal: async (p: any) => ({ by: 'claude', ...p }) };
  const codex = { goal: async (p: any) => ({ by: 'codex', ...p }) };
  const r = runtimeOf({ a: 'claude', b: 'codex' }, { claude, codex });
  assert.deepEqual(await r.goal({ chatId: 'a', action: 'pause' }), { by: 'claude', chatId: 'a', action: 'pause' });
  assert.deepEqual(await r.goal({ chatId: 'b', action: 'budget', tokens: 5 }), { by: 'codex', chatId: 'b', action: 'budget', tokens: 5 });
  await assert.rejects(r.goal({ chatId: 'zz', action: 'pause' }), (e: any) => e.code === 'chat_unknown');
  // a chat whose session the store holds but whose file is not listed is still this Host's
  const held = goalRuntime({
    chats: { records: new Map() },
    state: { has: (id: string) => id === 'x' },
    controller: { ref: () => ({ kind: 'claude' }) },
    familyOf: (kind: string) => kind,
    claude,
    codex,
  });
  assert.equal(((await held.goal({ chatId: 'x', action: 'resume' })) as any).by, 'claude');
});

test('B: a basic agent has no goals, with the words a chat of that agent shows on this Mac; a family this Host does not run says so', async () => {
  const r = runtimeOf({ k: 'acp:gemini', a: 'claude', b: 'codex' }, { claude: {}, codex: undefined });
  await assert.rejects(
    r.goal({ chatId: 'k', action: 'pause' }),
    (e: any) => e.code === 'unsupported' && e.message === `${agentLabel('gemini')} doesn't support goals`,
  );
  await assert.rejects(r.goal({ chatId: 'a', action: 'pause' }), (e: any) => e.message === 'Claude Code is not available on this Host.');
  await assert.rejects(r.goal({ chatId: 'b', action: 'pause' }), (e: any) => e.message === 'Codex is not available on this Host.');
});

/** Codex's goal controls over a stand-in adapter and store: `goal` is the chat's goal now, `calls` what went to the app-server. */
function codexGoalsOf(o: { goal?: any; thread?: string | null; got?: any; leased?: (m: string, p: any) => any } = {}) {
  const calls: any[] = [];
  const store: any = { goal: o.goal ?? null };
  const state = {
    get: () => ({ goal: store.goal }),
    patch: (_id: string, p: any) => void (calls.push(['patch', p.goal]), (store.goal = p.goal)),
  };
  const adapter = {
    request: async (m: string, p: any) => (
      calls.push(['request', m, p]), o.got === 'fail' ? Promise.reject(new Error('no')) : { goal: o.got ?? null }
    ),
    leased: async (id: string, m: string, p: any) => (
      calls.push(['leased', id, m, p]), o.leased ? o.leased(m, p) : { result: { goal: { status: 'active' } } }
    ),
    codexThread: () => (o.thread === undefined ? 'th' : o.thread),
    stopTurn: async (id: string) => void calls.push(['stop', id]),
  };
  return { run: createCodexGoals({ adapter: adapter as any, state: state as any }), calls, store };
}
const goalIn = (status: string, extra: object = {}) => ({ threadId: 'th', objective: 'ship', status, ...extra });

test('W: Codex runs the goal bar’s actions as the app does on this Mac: the same requests, and the goal they answer with is the chat’s', async () => {
  const resume = codexGoalsOf({ goal: goalIn('paused') });
  assert.deepEqual(await resume.run({ chatId: 'c', action: 'resume' }), { status: 'active' });
  assert.deepEqual(resume.calls, [
    ['leased', 'c', 'thread/goal/set', { threadId: 'th', status: 'active' }],
    ['patch', { status: 'active' }],
  ]);

  const edit = codexGoalsOf({ goal: goalIn('active') });
  await edit.run({ chatId: 'c', action: 'edit', objective: ' ship it now ' });
  assert.deepEqual(edit.calls[0], ['leased', 'c', 'thread/goal/set', { threadId: 'th', objective: 'ship it now' }]);

  const budget = codexGoalsOf({ goal: goalIn('active') });
  await budget.run({ chatId: 'c', action: 'budget', tokens: 200_000 });
  assert.deepEqual(budget.calls[0], ['leased', 'c', 'thread/goal/set', { threadId: 'th', tokenBudget: 200_000 }]);
  await budget.run({ chatId: 'c', action: 'budget' });
  assert.deepEqual(budget.calls.find((c) => c[0] === 'leased' && c[3].tokenBudget === null)?.[3], { threadId: 'th', tokenBudget: null });

  const clear = codexGoalsOf({ goal: goalIn('active') });
  assert.equal(await clear.run({ chatId: 'c', action: 'clear', human: true }), null);
  assert.deepEqual(clear.calls, [
    ['leased', 'c', 'thread/goal/clear', { threadId: 'th' }],
    ['patch', null],
  ]);
});

test('W: Pause is Stop: the goal is paused first and the running turn interrupted, by the adapter that does it for a Stop', async () => {
  const pause = codexGoalsOf({ goal: goalIn('active') });
  assert.deepEqual(await pause.run({ chatId: 'c', action: 'pause' }), goalIn('active'));
  assert.deepEqual(pause.calls, [['stop', 'c']]);
  assert.equal((await codexGoalsOf().run({ chatId: 'c', action: 'pause' })) ?? 'none', 'none');
});

test('W: a chat nobody has opened since the Host started has its goal read from the app-server; a read that fails is no goal', async () => {
  const read = codexGoalsOf({ got: goalIn('paused') });
  await read.run({ chatId: 'c', action: 'resume' });
  assert.deepEqual(read.calls[0], ['request', 'thread/goal/get', { threadId: 'th' }]);
  assert.equal(read.calls[1][2], 'thread/goal/set');
  const none = codexGoalsOf({ got: 'fail' });
  await assert.rejects(none.run({ chatId: 'c', action: 'clear' }), (e: any) => e.message === 'No goal set');
});

test('B: what Codex cannot do is refused with the app’s words and changes nothing', async () => {
  const refused = (p: any, o: any, say: RegExp | string) =>
    assert.rejects(
      codexGoalsOf(o).run({ chatId: 'c', ...p }),
      (e: any) => e.code === 'unsupported' && (typeof say === 'string' ? e.message === say : say.test(e.message)),
    );
  await refused({ action: 'extend' }, {}, unsupportedGoalWords('Codex', 'extend'));
  await refused({ action: 'resume' }, {}, 'No goal set');
  await refused({ action: 'resume' }, { goal: goalIn('complete') }, "This goal can't be resumed.");
  await refused({ action: 'edit', objective: ' ' }, { goal: goalIn('active') }, 'No goal set');
  await refused({ action: 'clear' }, { thread: null }, "This chat isn't running on Codex.");
  await refused({ action: 'clear' }, { goal: goalIn('active'), leased: () => ({ locked: true }) }, /open in another Codex app/);
  await refused(
    { action: 'clear' },
    { goal: goalIn('active'), leased: () => Promise.reject(new Error('The goals feature is disabled')) },
    /features\.goals = true/,
  );
  await refused({ action: 'clear' }, { goal: goalIn('active'), leased: () => Promise.reject('plain') }, 'plain');
  // an answer with no goal in it leaves the store as it was
  const quiet = codexGoalsOf({ goal: goalIn('paused'), leased: () => ({ result: {} }) });
  assert.deepEqual(await quiet.run({ chatId: 'c', action: 'resume' }), goalIn('paused'));
  assert.deepEqual(
    quiet.calls.filter((c) => c[0] === 'patch'),
    [],
  );
});

/** The Codex family over stand-ins, for what it does with a goal's events. */
function codexFamilyOf(held = true) {
  const patched: any[] = [];
  const controller: any = {
    chatOf: (id: string) => (id === 'th' ? 'chat' : id),
    requestChat: (id: string) => id,
    isCurrentSource: () => true,
    ref: () => ({ kind: 'codex', id: 'th', key: 'th' }),
    onCodexMessage: () => undefined,
  };
  const ctx: any = {
    paths: { dataDir: '/data' },
    state: {
      has: (id: string) => held && id === 'chat',
      get: () => ({ approvals: [], turn: 'idle', goal: null }),
      all: () => [],
      patch: (id: string, p: any) => patched.push([id, p]),
    },
    chats: { records: new Map(), get: () => null, patchMeta: () => undefined, commit: () => true },
    controller: () => controller,
    emit: () => undefined,
  };
  const family = createCodexFamily({ env: {}, which: () => '/bin/codex', probe: async () => true, now: () => 1000 })(ctx);
  return { family, adapter: family.codex, patched };
}

test('W: a Codex goal’s own changes reach the chat’s state lane: the agent met it, a client changed it, it was cleared', () => {
  const s = codexFamilyOf();
  const goal = goalIn('paused');
  s.adapter.observe({ method: 'thread/goal/updated', params: { threadId: 'th', goal } });
  s.adapter.observe({ method: 'thread/goal/updated', params: { threadId: 'th' } });
  s.adapter.observe({ method: 'thread/goal/cleared', params: { threadId: 'th' } });
  // the adapter's own set of a goal (its objective sent as a message)
  s.adapter.emit({ kind: 'goal', chatId: 'chat', goal });
  s.adapter.emit({ kind: 'goal', chatId: 'chat' });
  assert.deepEqual(s.patched, [
    ['chat', { goal }],
    ['chat', { goal: null }],
    ['chat', { goal: null }],
    ['chat', { goal }],
    ['chat', { goal: null }],
  ]);
  // a chat this Host does not hold has no lane
  const none = codexFamilyOf(false);
  none.adapter.observe({ method: 'thread/goal/updated', params: { threadId: 'th', goal } });
  none.adapter.emit({ kind: 'goal', chatId: 'chat', goal });
  assert.deepEqual(none.patched, []);
});

test('B: the family refuses the actions Codex has no form of, before it asks the app-server anything', async () => {
  await assert.rejects(
    codexFamilyOf().family.goal({ chatId: 'chat', action: 'extend' }),
    (e: any) => e.message === unsupportedGoalWords('Codex', 'extend'),
  );
});
