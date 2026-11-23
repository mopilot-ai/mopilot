// Passive native events stay unregistered; only a current compaction owner may establish an editable main-owned hold.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup, selectSegment, codex, tick } from './support/controller/fixture';

const { CodexAdapter } = createRequire(import.meta.url)('../electron/harness/codex.cjs');
const input = (id: string) => ({
  id,
  text: id,
  attachments: [{ kind: 'image', path: '/tmp/diagram.png', name: 'diagram.png' }],
  opts: { human: true, effort: 'high' },
  followUp: 'steer',
});
const compact = (method = 'item/started', turnId = 'turn', threadId = 'native') =>
  codex(method, { threadId, turnId, item: { type: 'contextCompaction', id: 'compact' } });
function nativeFixture() {
  const f = setup({ auto: false });
  selectSegment(f.c, f.chats, 'stable', [['codex', 'native']]);
  const a = new CodexAdapter({
    server: { listeners: new Set() },
    state: f.state,
    nativeOf: (chat: string) => f.c.ref(chat),
    chatOf: (native: string) => f.c.chatOf(native),
    observe: (message: any) => f.c.onCodexMessage(message),
  });
  // Exercise real inbound adapter bookkeeping; outbound transport remains the existing isolated test seam.
  a.steer = f.c.codex.steer;
  a.startTurn = f.c.codex.startTurn;
  f.c.codex = a;
  return { ...f, a };
}

test('ordinary Codex turn and agent-message events do not register an unopened stored chat', () => {
  const { a, c, state } = nativeFixture();
  a.onMessage(codex('turn/started', { threadId: 'native', turn: { id: 'turn' } }));
  assert.equal(state.has('stable'), false);
  assert.equal(c.rts.has('stable'), false);
  a.onMessage(codex('item/completed', { threadId: 'native', turnId: 'turn', item: { type: 'agentMessage', text: 'unseen' } }));
  assert.equal(state.has('stable'), false);
  a.onMessage(codex('turn/completed', { threadId: 'native', turn: { id: 'turn', status: 'completed' } }));
  assert.equal(state.has('stable'), false);
  assert.equal(c.rts.has('stable'), false);
});

test('completion-only, wrong-turn, ended and unknown compactions cannot materialize a session', () => {
  for (const mode of [
    'complete',
    'not-running',
    'missing-running',
    'missing-turn-map',
    'missing-turn-id',
    'wrong-turn',
    'ended',
    'unknown',
    'retired-segment',
    'replacement',
  ]) {
    const { a, c, chats, state } = nativeFixture();
    a.onMessage(codex('turn/started', { threadId: 'native', turn: { id: 'turn' } }));
    if (mode === 'not-running') a.running.delete('native');
    if (mode === 'missing-running') a.running = undefined;
    if (mode === 'missing-turn-map') a.turnOf = undefined;
    if (mode === 'missing-turn-id') a.turnOf.delete('native');
    if (mode === 'ended') a.onMessage(codex('turn/completed', { threadId: 'native', turn: { id: 'turn', status: 'completed' } }));
    if (mode === 'retired-segment')
      selectSegment(c, chats, 'stable', [
        ['codex', 'native'],
        ['claude', 'replacement'],
      ]);
    if (mode === 'replacement') c.codex = { ...c.codex, running: new Set(), turnOf: new Map() };
    a.onMessage(
      compact(
        mode === 'complete' ? 'item/completed' : 'item/started',
        mode === 'wrong-turn' ? 'old' : 'turn',
        mode === 'unknown' ? 'unknown' : 'native',
      ),
    );
    assert.equal(state.has('stable'), false, mode);
    assert.equal(c.rts.has('stable'), false, mode);
    assert.equal(state.has('unknown'), false, mode);
  }
});

test('native Codex compaction in a stored chat without a window admits only its adapter-owned turn and releases edited input once', async () => {
  const { a, c, state, execs, s } = nativeFixture();
  a.onMessage(codex('turn/started', { threadId: 'native', turn: { id: 'turn' } }));
  assert.equal(state.has('stable'), false);
  a.onMessage(compact());
  assert.equal(s('stable').compaction, 'active');
  assert.equal(s('stable').activeTurn.id, 'turn');
  assert.deepEqual(await c.send('stable', input('held'), 7, true), { action: 'queued', id: 'held' });
  await c.send('stable', input('remove'), 7, true);
  c.removeQueued('stable', 'remove');
  const q = c.removeQueued('stable', 'held');
  await c.send('stable', { ...q, text: 'edited', followUp: 'steer' }, q.origin, true);
  assert.equal(execs.length, 0);
  a.onMessage(compact('item/completed'));
  a.onMessage(compact('item/completed'));
  assert.equal(execs.length, 1);
  assert.equal(execs[0].chatId, 'stable');
  assert.equal(execs[0].kind, 'steer');
  assert.equal(execs[0].item.text, 'edited');
  assert.deepEqual(execs[0].item.attachments, input('held').attachments);
  assert.deepEqual(execs[0].item.opts, input('held').opts);
  assert.equal(execs[0].origin, 7);
  execs[0].done({ started: true });
  await tick();
  assert.equal(s('stable').queue.length, 0);
});

test('only a current active Claude compaction can register an unopened stored chat', async () => {
  for (const mode of [
    'boundary',
    'failed',
    'ended',
    'reset',
    'ordinary',
    'permission',
    'subagent',
    'wrong-account',
    'wrong-source',
    'active',
  ]) {
    const { c, chats, state } = setup();
    selectSegment(c, chats, 'stable', [['claude', 'native']]);
    c.claudeTurns.accountOf = () => 'current';
    let msg: any = { type: 'system', subtype: 'status', session_id: 'native', status: 'compacting' };
    if (mode === 'boundary') msg.subtype = 'compact_boundary';
    if (mode === 'failed') msg = { ...msg, status: null, compact_result: 'failed' };
    if (mode === 'ended') msg.status = null;
    if (mode === 'reset') msg = { type: 'conversation_reset', session_id: 'native', new_conversation_id: 'next' };
    if (mode === 'ordinary') msg = { type: 'assistant', message: { content: [{ type: 'text', text: 'unseen' }] } };
    if (mode === 'subagent') msg.parent_tool_use_id = 'child';
    if (mode === 'wrong-source')
      selectSegment(c, chats, 'stable', [
        ['claude', 'native'],
        ['codex', 'new-native'],
      ]);
    c.onClaudeEvent({
      key: 'claude:native',
      kind: mode === 'permission' ? 'permission' : 'message',
      requestId: 'unused',
      msg,
      account: mode === 'wrong-account' ? 'old' : 'current',
    });
    assert.equal(state.has('stable'), mode === 'active', mode);
    assert.equal(c.rts.has('stable'), mode === 'active', mode);
    if (mode === 'active') {
      assert.deepEqual(await c.send('stable', input('held'), 7, true), { action: 'queued', id: 'held' });
      assert.equal(state.get('stable').queue[0].waitingFor, 'compaction');
    }
  }
});

// Materializing a genuine no-window owner must not weaken its later invalidation or discard full queued input.
test('no-window Codex holds remain retryable after Stop, turn, adapter or segment replacement', async () => {
  for (const mode of ['stop', 'turn', 'adapter', 'segment', 'failed']) {
    const { a, c, chats, execs, s } = nativeFixture();
    a.onMessage(codex('turn/started', { threadId: 'native', turn: { id: 'turn' } }));
    a.onMessage(compact());
    await c.send('stable', input('held'), 7, true);
    if (mode === 'stop') {
      c.noteStop('stable');
      c.end('stable', { drain: false });
    } else if (mode === 'turn') a.onMessage(codex('turn/started', { threadId: 'native', turn: { id: 'next' } }));
    else if (mode === 'failed') a.onMessage(codex('turn/completed', { threadId: 'native', turn: { id: 'turn', status: 'failed' } }));
    else if (mode === 'segment')
      selectSegment(c, chats, 'stable', [
        ['codex', 'native'],
        ['acp:qwen', 'next'],
      ]);
    else {
      c.codex = { ...a };
      c.invalidate();
    }
    a.onMessage(compact('item/completed'));
    await tick();
    assert.equal(execs.length, 0, mode);
    assert.equal(s('stable').queue.length, 1, mode);
    assert.equal(s('stable').queue[0].waitingFor, 'compactionRetry', mode);
    assert.deepEqual(s('stable').queue[0].attachments, input('held').attachments, mode);
    assert.deepEqual(s('stable').queue[0].opts, input('held').opts, mode);
  }
});
