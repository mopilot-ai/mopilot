// The Codex adapter in main publishes a chat's background commands and sub-agents on its session (session.backgroundWork,
// electron/harness/codexBackgroundWork.cjs), so every window knows of them without polling: under the chat's current
// thread only, never on a sub-agent's own thread, and cleared when the app-server exits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { CodexThreadParents } = require('../electron/capabilities/contract/codexParents.cjs');

const msg = (method: string, params: object) => ({ method, params });

function rig() {
  const state = new SessionStore();
  const segments = new Map<string, { kind: string; id: string; key: string }>();
  const parents = new CodexThreadParents();
  const lists: { threadId: string; ms: number }[] = [];
  let terminals: unknown[] = [];
  const a = new CodexAdapter({
    server: { listeners: new Set(), send() {} },
    state,
    nativeOf: (chatId: string) => segments.get(chatId) ?? { kind: 'codex', id: chatId, key: chatId },
    chatOf: (id: string) => [...segments].find(([, s]) => s.id === id)?.[0] ?? id,
    tools: { parents, observe: (m: unknown) => parents.observe(m), exited() {} },
    emit() {},
    probe: null,
  });
  a.call = (method: string, params: { threadId: string }, ms: number) => {
    assert.equal(method, 'thread/backgroundTerminals/list');
    lists.push({ threadId: params.threadId, ms });
    return Promise.resolve({ data: terminals });
  };
  const send = (m: { method: string; params: object }) => a.onServer({ kind: 'message', msg: m });
  return { a, state, segments, lists, send, setTerminals: (t: unknown[]) => (terminals = t) };
}

test("a chat's background command reaches its session for every window, under the thread it runs on", async () => {
  const r = rig();
  r.state.patch('chat', { turn: 'running' });
  r.segments.set('chat', { kind: 'codex', id: 'thread-1', key: 'thread-1' });
  r.setTerminals([{ itemId: 'cmd', processId: '7', command: 'npm run dev' }]);
  const lastActivity = r.a.lastActivity;
  r.send(msg('turn/started', { threadId: 'thread-1', turn: { id: 'u1' } }));
  r.send(msg('turn/completed', { threadId: 'thread-1', turn: { id: 'u1', status: 'completed' } }));
  await tick();
  assert.deepEqual(r.lists, [{ threadId: 'thread-1', ms: 10_000 }]);
  assert.deepEqual(r.state.get('chat').backgroundWork, { source: { kind: 'codex', key: 'thread-1' }, shells: 1, agents: 0 });
  assert.ok(r.a.lastActivity >= lastActivity, 'reading the list is no activity (the idle recycler still sees the thread busy)');
  // a new turn's own running command is that turn's work, read on the tick while the earlier command runs
  r.send(msg('turn/started', { threadId: 'thread-1', turn: { id: 'u3' } }));
  r.send(msg('item/started', { threadId: 'thread-1', turnId: 'u3', item: { type: 'commandExecution', id: 'cmd-3' } }));
  r.setTerminals([
    { itemId: 'cmd', processId: '7' },
    { itemId: 'cmd-3', processId: '9' },
  ]);
  r.a.backgroundWork.tick();
  await tick();
  assert.equal(r.state.get('chat').backgroundWork.shells, 1);
  r.send(msg('item/completed', { threadId: 'thread-1', turnId: 'u3', item: { type: 'commandExecution', id: 'cmd-3' } }));
  // a turn the user stopped: its command is being ended with it, so it is not background work
  r.send(msg('turn/started', { threadId: 'thread-1', turn: { id: 'u2' } }));
  r.send(msg('item/started', { threadId: 'thread-1', turnId: 'u2', item: { type: 'commandExecution', id: 'cmd-2' } }));
  r.a.turnCommands.take('thread-1', 'u2');
  r.setTerminals([
    { itemId: 'cmd', processId: '7' },
    { itemId: 'cmd-2', processId: '8' },
  ]);
  r.send(msg('turn/completed', { threadId: 'thread-1', turn: { id: 'u2', status: 'interrupted' } }));
  await tick();
  assert.equal(r.state.get('chat').backgroundWork.shells, 1);
  // the command ends
  r.setTerminals([]);
  r.send(msg('turn/completed', { threadId: 'thread-1', turn: { id: 'u1', status: 'completed' } }));
  await tick();
  assert.equal(r.state.get('chat').backgroundWork, null);
  r.a.backgroundWork.clear();
});

test("a sub-agent's own thread and a chat no turn ran in get no session; a thread the chat switched away from only takes its own record down", async () => {
  const r = rig();
  r.state.patch('chat', { turn: 'running' });
  // the sub-agent is linked by its thread/started, and runs a turn while the chat's turn has ended
  r.send(msg('thread/started', { thread: { id: 'kid', parentThreadId: 'chat' } }));
  r.send(msg('turn/started', { threadId: 'kid', turn: { id: 'k1' } }));
  assert.deepEqual(r.state.get('chat').backgroundWork, { source: { kind: 'codex', key: 'chat' }, shells: 0, agents: 1 });
  assert.equal(r.state.has('kid'), false);
  r.send(msg('turn/completed', { threadId: 'kid', turn: { id: 'k1', status: 'completed' } }));
  assert.equal(r.state.get('chat').backgroundWork, null);
  // a thread whose chat main doesn't track: nothing is made for it
  r.setTerminals([{ itemId: 'c', processId: '1' }]);
  r.send(msg('turn/completed', { threadId: 'stray', turn: { id: 's1' } }));
  await tick();
  assert.equal(r.state.has('stray'), false);
  // the chat switched to another harness while its old thread's command runs: that record is taken down at its next
  // change (windows already hide a record of another source), and the new segment's record is never touched by it
  r.setTerminals([{ itemId: 'c', processId: '1' }]);
  r.send(msg('turn/completed', { threadId: 'chat', turn: { id: 'c1' } }));
  await tick();
  assert.deepEqual(r.state.get('chat').backgroundWork, { source: { kind: 'codex', key: 'chat' }, shells: 1, agents: 0 });
  r.segments.set('chat', { kind: 'claude', id: 'claude-1', key: 'claude:claude-1' });
  const reads = r.lists.length;
  r.send(msg('turn/completed', { threadId: 'chat', turn: { id: 'c1' } }));
  assert.equal(r.lists.length, reads, 'a thread no chat shows is not read');
  r.a.backgroundWork.tick();
  assert.equal(r.state.get('chat').backgroundWork, null, "the next tick takes the old thread's record down");
  assert.equal(r.a.backgroundWork.timer, null);
  // a Codex segment that replaced it owns the record now; the old thread's changes leave it alone
  r.segments.set('chat', { kind: 'codex', id: 'thread-2', key: 'thread-2' });
  r.state.patch('chat', { backgroundWork: { source: { kind: 'codex', key: 'thread-2' }, shells: 1, agents: 0 } });
  r.a.publishWork('chat', { shells: 0, agents: 0 });
  assert.deepEqual(r.state.get('chat').backgroundWork, { source: { kind: 'codex', key: 'thread-2' }, shells: 1, agents: 0 });
  r.a.backgroundWork.clear();
});

test('the app-server exiting clears every chat it ran work for', async () => {
  const r = rig();
  r.state.patch('chat', { turn: 'running' });
  r.setTerminals([{ itemId: 'c', processId: '1' }]);
  r.send(msg('turn/completed', { threadId: 'chat', turn: { id: 'c1' } }));
  await tick();
  assert.equal(r.state.get('chat').backgroundWork.shells, 1);
  r.a.onServer({ kind: 'exit', code: 1 });
  assert.equal(r.state.get('chat').backgroundWork, null);
  assert.equal(r.a.backgroundWork.timer, null);
  clearTimeout(r.a.restartTimer);
});
