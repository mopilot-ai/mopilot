// A chat's last activity in the real store (src/store/core.ts touchChat): Codex turns and answered approvals on every harness.
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, impl, resetAll, flush, listeners, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, sessions, resetState } = await loadStore();
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

test('repeated live output updates its own chat before completion, and older turns and metadata do not', () => {
  for (const id of ['codex-chat', 'acp:kimi:chat']) {
    const emit = id === 'codex-chat' ? note : S.applyNotification;
    set({ threads: { [id]: chat(id), other: chat('other') }, threadOrder: ['other', id] });
    emit('turn/started', { threadId: id, turn: { id: 'live', status: 'inProgress' } });
    const output = { threadId: id, turnId: 'live', itemId: 'message', delta: 'text' };
    for (const text of ['first', 'second']) {
      set({ threads: { ...st().threads, [id]: chat(id) } });
      emit('item/completed', { ...output, item: { id: text, type: 'agentMessage', text } });
      assert.ok(st().threads[id].recencyAt! > 1, id);
      assert.equal(st().threads.other.recencyAt, 1);
    }
    set({ threads: { ...st().threads, [id]: chat(id) } });
    const answer = { id: 'message', type: 'agentMessage', text: 'complete' };
    emit('item/completed', { ...output, turnId: 'older', item: answer });
    emit('item/completed', { ...output, item: { ...answer, type: 'statusNote' } });
    emit('item/updated', { ...output, item: { id: 'bash', type: 'commandExecution', aggregatedOutput: 'polling output' } });
    emit('item/agentMessage/delta', output);
    emit('thread/name/updated', { threadId: id, threadName: 'Renamed' });
    assert.equal(st().threads[id].recencyAt, 1);
    emit('item/completed', { ...output, item: answer });
    assert.ok(st().threads[id].recencyAt! > 1, id);
    assert.deepEqual(st().threadOrder, ['other', id]);
  }
});

test('a window joining a running chat uses the current turn from main', () => {
  const threadId = 'already-running';
  set({ threads: { [threadId]: chat(threadId) } });
  const item = { id: 'message', type: 'agentMessage', text: 'a reply' };
  note('item/completed', { threadId, turnId: 'current', item });
  assert.equal(st().threads[threadId].recencyAt, 1);
  sessions.useSessions.setState({
    sessions: { [threadId]: { ...sessions.sessionOf(threadId), rev: 1, turn: 'running', activeTurn: { id: 'current', human: true } } },
  });
  note('item/completed', { threadId, turnId: 'retired', item });
  assert.equal(st().threads[threadId].recencyAt, 1);
  S.applyNotification('item/completed', { threadId, turnId: 'current', item }, false);
  assert.equal(st().threads[threadId].recencyAt, 1, 'translated items do not repeat activity already recorded at the source');
  note('item/completed', { threadId, turnId: 'current', item });
  assert.ok(st().threads[threadId].recencyAt! > 1);
  note('turn/started', { threadId, turn: { id: 'current', status: 'inProgress' } });
  set({ threads: { [threadId]: chat(threadId) } });
  sessions.useSessions.setState({
    sessions: { [threadId]: { ...sessions.sessionOf(threadId), rev: 0, turn: 'idle', activeTurn: null } },
  });
  note('item/completed', { threadId, turnId: 'current', item });
  assert.equal(st().threads[threadId].recencyAt, 1);
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
