// Answering a card on every harness (Codex, Claude Code, ACP, MoPilot's own): only a card the window still
// shows is sent, through the harness that raised it, and an answer main retired reads as "Already answered".
import { beforeEach, mock, test } from 'node:test';
import { installFakeRuntime } from './support/ports/runtime.ts';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';
import { stubSlice } from './support/stubs.ts';

const state: any = { pending: [] };
const toasts: [string, string | undefined][] = [];
const touched: string[] = [];
const notes: string[] = [];
const sent: [string, unknown][] = [];
const replies: Record<string, () => Promise<unknown>> = {};
const reply = (kind: string, id: unknown) => (sent.push([kind, id]), replies[kind]());

stubSlice('src/store/core.ts', {
  get: () => state,
  set: (f: any) => Object.assign(state, typeof f === 'function' ? f(state) : f),
  patchRuntime: () => {},
  upsertThread: () => {},
  touchChat: (id: string) => void touched.push(id),
  patchTurn: () => {},
  patchItem: () => {},
  patchStreamedItem: () => {},
  toast: (text: string, kind?: string) => void toasts.push([text, kind]),
});
stubSlice('src/store/chats.ts', {
  suggestOtherHarness: () => {},
  chatFamily: () => 'codex',
  nativeOf: (id: string) => id,
  chatOf: (id: string) => id,
  noteReportedWindow: () => {},
  usageHarnessOf: () => 'codex',
});
stubSlice('src/store/connection.ts', { loadThreads: async () => {}, refreshAccount: async () => {}, refreshRateLimits: async () => {} });
stubSlice('src/store/projects.ts', { syncCodexProjects: async () => {} });
stubSlice('src/store/actions.ts', { setGoalState: async () => false });
mock.module('../src/store/answersNote.ts', { namedExports: { answersNote: (chatId: string) => void notes.push(chatId) } });
mock.module('../src/store/session/useSession.ts', {
  namedExports: { flushSessionPatches: () => {}, sessionOf: () => ({ approvals: [] }) },
});
mock.module('../src/harness/adapters/codex.ts', { namedExports: { respondToCodex: (id: unknown) => reply('codex', id) } });
// Claude Code's and ACP's answers go through the runtime main installs
installFakeRuntime({
  resolveClaudeRequest: (req: any) => reply('claude', req.id) as Promise<boolean>,
  resolveAcpRequest: (req: any) => reply('acp', req.id) as Promise<boolean>,
});

// the modules notifications.ts reaches read the preload's bridge when they load
(globalThis as any).window ??= new EventTarget();
const { resolveRequest } = await import('../src/store/notifications.ts');
const { answerTaken, ALREADY_ANSWERED } = await import('../src/store/answerRetired.ts');
const require = createRequire(import.meta.url);
const { ApprovalBroker } = require('../electron/capabilities/contract/approvals.cjs');

const card = (id: number | string, method: string, threadId: string | null = 'c1') => ({
  id,
  method,
  params: { questions: [] },
  threadId,
  receivedAt: 0,
});
const CARDS = [
  ['codex', card(0, 'item/commandExecution/requestApproval')],
  ['claude', card('cperm-1', 'item/commandExecution/requestApproval')],
  ['acp', card('acpperm-1-ab', 'acp/permission')],
] as const;

beforeEach(() => {
  state.pending = [];
  for (const a of [toasts, touched, notes, sent]) a.length = 0;
  for (const k of ['codex', 'claude', 'acp']) replies[k] = async () => true;
});

for (const [kind, req] of CARDS) {
  test(`${kind}: an answer main took goes to its own harness and counts as activity`, async () => {
    state.pending = [req];
    resolveRequest(req.id, {});
    await tick();
    assert.deepEqual(sent, [[kind, req.id]]);
    assert.deepEqual(touched, ['c1']);
    assert.deepEqual(toasts, []);
    assert.deepEqual(state.pending, []);
  });

  test(`${kind}: an answer main retired says "Already answered", drops the card and is not activity`, async () => {
    replies[kind] = async () => false;
    state.pending = [req];
    resolveRequest(req.id, {});
    await tick();
    assert.deepEqual(sent, [[kind, req.id]]);
    assert.deepEqual(toasts, [[ALREADY_ANSWERED, undefined]]);
    assert.deepEqual(touched, []);
    assert.deepEqual(state.pending, []);
  });

  test(`${kind}: a card already gone from the window sends nothing to any harness`, async () => {
    state.pending = [];
    resolveRequest(req.id, {});
    await tick();
    assert.deepEqual(sent, [], 'never falls through to the Codex app-server');
    assert.deepEqual(toasts, [[ALREADY_ANSWERED, undefined]]);
  });
}

test('a retired question card leaves no answered-questions note; a taken one does', async () => {
  replies.claude = async () => false;
  state.pending = [card('cperm-q', 'item/tool/requestUserInput')];
  resolveRequest('cperm-q', { answers: {} });
  await tick();
  assert.deepEqual(notes, []);
  replies.claude = async () => true;
  state.pending = [card('cperm-q2', 'item/tool/requestUserInput')];
  resolveRequest('cperm-q2', { answers: {} });
  await tick();
  assert.deepEqual(notes, ['c1']);
});

test('a card with no chat is answered without touching any chat', async () => {
  state.pending = [card(5, 'item/commandExecution/requestApproval', null)];
  resolveRequest(5, {});
  await tick();
  assert.deepEqual(sent, [['codex', 5]]);
  assert.deepEqual(touched, []);
});

test('a send that failed puts nothing back for a card main dropped, and says it failed', async () => {
  replies.codex = async () => {
    throw new Error('ipc down');
  };
  state.pending = [card(3, 'item/commandExecution/requestApproval')];
  resolveRequest(3, {});
  await tick();
  assert.deepEqual(state.pending, []);
  assert.deepEqual(toasts, [["Couldn't send your answer: ipc down", 'error']]);
});

test('answerTaken: only true counts as delivered', () => {
  const said: string[] = [];
  const say = (t: string) => void said.push(t);
  assert.equal(answerTaken(true, say), true);
  for (const r of [false, undefined, { ok: true }]) assert.equal(answerTaken(r, say), false);
  assert.deepEqual(said, [ALREADY_ANSWERED, ALREADY_ANSWERED, ALREADY_ANSWERED]);
});

test("MoPilot's own cards: the broker takes an answer once and refuses an id it no longer holds", () => {
  const added: any[] = [];
  const resolved: string[] = [];
  const broker = new ApprovalBroker({
    controller: { addApproval: (_c: string, a: any) => added.push(a), resolveApproval: (id: string) => (resolved.push(id), true) },
  });
  const answer = broker.ask('c1', 'browserOrigin', { origin: 'https://a.test' });
  assert.equal(broker.answer('sage-browserOrigin-99', { decision: 'allow' }), false);
  assert.equal(broker.answer(answer.id, { decision: 'allow' }), true);
  assert.equal(broker.answer(answer.id, { decision: 'deny' }), false);
  assert.deepEqual(resolved, [answer.id]);
});
