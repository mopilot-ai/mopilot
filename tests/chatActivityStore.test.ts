// A chat's last activity in the real store (src/store/core.ts touchChat): Codex turns and answered approvals on every harness.
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resetAll, flush, listeners, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const note = (method: string, params: any) => listeners['codex.onItem']({ kind: 'notification', chatId: params.threadId, method, params });
const chat = (id: string) => ({ id, preview: '', updatedAt: 1, recencyAt: 1 }) as any;

before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
});

test('touchChat stamps activity now; only a starting turn leads the list and names the chat', () => {
  set({ threads: { a: chat('a') }, threadOrder: ['b', 'a'] });
  const before = Date.now() / 1000;
  S.touchChat('a');
  assert.ok(st().threads.a.recencyAt! >= before);
  assert.equal(st().threads.a.updatedAt, st().threads.a.recencyAt);
  assert.deepEqual(st().threadOrder, ['b', 'a']);
  S.touchChat('a', { text: 'hi' });
  assert.deepEqual(st().threadOrder, ['a', 'b']);
  assert.equal(st().threads.a.preview, 'hi');
});

test("every turn's start and end is activity, also a turn not sent from here; the list order is the send's", () => {
  set({ threads: { g: chat('g') }, threadOrder: ['x', 'g'] });
  // a goal's next round (or another app's turn) starts with no send here
  note('turn/started', { threadId: 'g', turn: { id: 'G1', status: 'inProgress' } });
  assert.ok(st().threads.g.recencyAt! > 1);
  assert.deepEqual(st().threadOrder, ['x', 'g']);
  set({ threads: { g: chat('g') } });
  // its end (the agent's last output, or a stop) is activity too, as in Claude Code
  note('turn/completed', { threadId: 'g', turn: { id: 'G1', status: 'interrupted', items: [] } });
  assert.ok(st().threads.g.recencyAt! > 1);
  assert.equal(st().threads.g.updatedAt, st().threads.g.recencyAt);
  // Claude Code's and the basic harnesses' translators report their turns through the same handler
  for (const id of ['claude-chat', 'acp:kimi:chat']) {
    set({ threads: { ...st().threads, [id]: chat(id) } });
    S.applyNotification('turn/completed', { threadId: id, turn: { id: 'T', status: 'completed', items: [] } });
    assert.ok(st().threads[id].recencyAt! > 1, id);
  }
});

test('an answer that reached the agent is activity in its chat on every harness; one that failed is not', async () => {
  set({
    threads: { c: chat('c'), k: chat('k'), x: chat('x'), f: chat('f') },
    pending: [
      { id: 'cperm-1', method: 'x', threadId: 'c' },
      { id: 2, method: 'acp/permission', threadId: 'k' },
      { id: 3, method: 'item/x', threadId: 'x' },
      { id: 4, method: 'item/x', threadId: 'f' },
      { id: 5, method: 'item/x', threadId: null },
    ] as any,
  });
  impl['codex.respondToCodex'] = async (id: number) => {
    if (id === 4) throw new Error('main is gone');
    return true;
  };
  impl['claude.resolveClaudeRequest'] = async () => true;
  impl['acp.resolveAcpRequest'] = async () => true;
  for (const id of ['cperm-1', 2, 3, 4, 5]) S.resolveRequest(id, 'ok');
  await flush();
  for (const id of ['c', 'k', 'x']) assert.ok(st().threads[id].recencyAt! > 1, id);
  assert.equal(st().threads.f.recencyAt, 1);
});

test('a repeated start of a turn a read showed as interrupted runs it again; a finished one stays finished', () => {
  set({
    runtime: {
      i: {
        ...S.useStore.getState().runtime.i,
        turns: [
          { id: 'T', status: 'interrupted', items: [] },
          { id: 'D', status: 'completed', items: [] },
        ],
      },
    },
  } as any);
  note('turn/started', { threadId: 'i', turn: { id: 'T', status: 'inProgress' } });
  assert.deepEqual(
    st().runtime.i.turns.map((t: any) => t.status),
    ['inProgress', 'completed'],
  );
  assert.equal(st().runtime.i.activeTurnId, 'T');
  note('turn/started', { threadId: 'i', turn: { id: 'D', status: 'inProgress' } });
  assert.equal(st().runtime.i.turns.find((t: any) => t.id === 'D').status, 'completed');
});
