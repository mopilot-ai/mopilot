// Stale-source and replacement-session ownership scenarios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, codex, selectSegment } from './fixture';

export function registerOwnershipCases() {
  test('a self-started Claude turn publishes real message activity from the current native session', () => {
    const { c, chats, s } = setup();
    const chat = 'automatic-chat';
    const key = 'claude:automatic';
    selectSegment(c, chats, chat, [['claude', key]]);
    s(chat);
    const reply = () => ({ key, kind: 'message', msg: { type: 'assistant', message: { content: [] } }, activityAt: 0 });
    const current = reply();
    c.onClaudeEvent(current);
    assert.match(s(chat).activeTurn.id, /^auto-/);
    assert.ok(current.activityAt > 0);
    const tool = { ...reply(), msg: { type: 'user', message: { content: [] } } };
    c.onClaudeEvent(tool);
    assert.ok(tool.activityAt >= current.activityAt);
    selectSegment(c, chats, chat, [
      ['claude', key],
      ['codex', 'replacement'],
    ]);
    const retired = reply();
    c.onClaudeEvent(retired);
    assert.equal(retired.activityAt, 0);
  });

  test('a finished Claude rewind is saved for the owning chat only while its segment is current', () => {
    const { c, chats } = setup();
    const chat = 'mixed-rewind';
    const key = 'claude:rewind';
    selectSegment(c, chats, chat, [['claude', key]]);
    const before = Date.now() / 1000;
    c.onClaudeEvent({ key, kind: 'rewound' });
    const rewoundAt = chats.get(chat).meta.rewoundAt;
    assert.ok(rewoundAt >= before);
    assert.equal(chats.get(key), null);
    selectSegment(c, chats, chat, [
      ['claude', key],
      ['codex', 'next'],
    ]);
    c.onClaudeEvent({ key, kind: 'rewound' });
    assert.equal(chats.get(chat).meta.rewoundAt, rewoundAt);
  });

  test('Codex confirms the rewind under the owning chat so all windows receive its activity', () => {
    const { c, chats } = setup();
    const chat = 'codex-rewind';
    const key = 'current-codex';
    selectSegment(c, chats, chat, [['codex', key]]);
    c.onCodexMessage(codex('thread/reverted', {}));
    assert.equal(chats.get(chat).meta.rewoundAt, null);
    c.onCodexMessage(codex('thread/reverted', { threadId: key }));
    const rewoundAt = chats.get(chat).meta.rewoundAt;
    assert.ok(rewoundAt > 0);
    assert.equal(chats.get(key), null);
    const patchMeta = chats.patchMeta;
    chats.patchMeta = () => {
      throw new Error('write refused');
    };
    assert.doesNotThrow(() => c.onCodexMessage(codex('thread/reverted', { threadId: key })));
    chats.patchMeta = patchMeta;
    selectSegment(c, chats, chat, [
      ['codex', key],
      ['claude', 'claude:next'],
    ]);
    c.onCodexMessage(codex('thread/reverted', { threadId: key }));
    assert.equal(chats.get(chat).meta.rewoundAt, rewoundAt);
  });

  test('old Claude messages, controls and exit leave a replacement Codex turn and cards intact', () => {
    const retracted: string[] = [];
    const { c, s, chats, state, crashes, claudeCrashes } = setup({ retract: (id) => retracted.push(id) });
    const key = 'claude:old',
      chat = 'mixed';
    selectSegment(c, chats, chat, [['claude', key]]);
    s(chat);
    c.onClaudeEvent({ key, kind: 'permission', requestId: 'old', agentID: 'child' });
    c.onClaudeEvent({ key, kind: 'tasks', tasks: [{ id: 'old-task', status: 'running' }] });
    selectSegment(c, chats, chat, [
      ['claude', key],
      ['codex', 'new'],
    ]);
    state.patch(chat, {
      turn: 'running',
      activeTurn: { id: 'new-turn', human: true },
      goal: { status: 'active' },
      permission: 'default',
      plan: false,
    });
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'new' }, 201));
    c.onClaudeControl(key, 'interrupt');
    for (const msg of [
      { type: 'system', subtype: 'status', permissionMode: 'plan' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'stale' }] } },
      { type: 'result', subtype: 'success', result: 'stale' },
    ])
      c.onClaudeEvent({ key, kind: 'message', msg });
    c.onClaudeEvent({ key, kind: 'settings', ultracode: true, available: true });
    assert.equal(c.rt(chat).interrupted, false);
    assert.equal(c.rt(chat).lastText, null);
    assert.equal(s(chat).plan, false);
    assert.equal(s(chat).permission, 'default');
    c.onClaudeEvent({ key, kind: 'closed' });
    assert.equal(s(chat).turn, 'awaitingUser');
    assert.equal(s(chat).activeTurn.id, 'new-turn');
    assert.equal(s(chat).goal.status, 'active');
    assert.deepEqual(
      s(chat).approvals.map((a: any) => a.id),
      [201],
    );
    assert.equal(s(chat).tasks[0].status, 'stopped');
    assert.deepEqual(retracted, []);
    assert.deepEqual(crashes, []);
    assert.deepEqual(claudeCrashes, []);
    assert.equal(c.rt(chat).approvalOwners.has('old'), false);
    c.resolveApproval(201);
    assert.equal(c.rt(chat).approvalOwners.size, 0);
  });

  test('old ACP events and cancellation cannot mutate a replacement native session, even in the same family', () => {
    for (const target of [
      ['codex', 'new'],
      ['acp:kimi', 'acp:kimi:new'],
    ] as [string, string][]) {
      const { c, s, state, chats, crashes, acpCancels } = setup();
      const key = 'acp:kimi:old',
        chat = 'mixed';
      selectSegment(c, chats, chat, [['acp:kimi', key]]);
      s(chat);
      c.onAcpEvent({ key, kind: 'permission', requestId: 'old' });
      selectSegment(c, chats, chat, [['acp:kimi', key], target]);
      state.patch(chat, { turn: 'running', activeTurn: { id: 'new-turn', human: true }, plan: false, acp: null });
      c.acpCancel(key);
      c.onAcpEvent({ key, kind: 'turnStart', turnId: 'old-turn' });
      c.onAcpEvent({ key, kind: 'turnEnd', turnId: 'new-turn', stopReason: 'cancelled' });
      c.onAcpEvent({ key, kind: 'session', modes: { currentModeId: 'plan' } });
      c.onAcpEvent({ key, kind: 'state', state: { modes: { currentModeId: 'plan' } } });
      c.onAcpEvent({ key, kind: 'update', update: { sessionUpdate: 'current_mode_update', currentModeId: 'plan' } });
      c.onAcpEvent({ key, kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'old' } } });
      assert.equal(c.rt(chat).interrupted, false);
      assert.equal(c.rt(chat).lastText, null);
      assert.equal(s(chat).acp, null);
      assert.equal(s(chat).plan, false);
      c.onAcpEvent({ key, kind: 'closed' });
      assert.equal(s(chat).turn, 'running');
      assert.equal(s(chat).activeTurn.id, 'new-turn');
      assert.deepEqual(s(chat).approvals, []);
      assert.deepEqual(acpCancels, [key]);
      assert.deepEqual(crashes, []);
    }
  });

  test('Claude task levels and teardown affect only their segment, with bounded private ownership', () => {
    const { c, s, chats, state } = setup();
    const chat = 'tasks',
      old = 'claude:old',
      key = 'claude:new';
    selectSegment(c, chats, chat, [['claude', old]]);
    s(chat);
    c.onClaudeEvent({ key: old, kind: 'tasks', tasks: [{ id: 'old', status: 'running' }] });
    c.onClaudeEvent({ key: old, kind: 'permission', requestId: 'old-card', agentID: 'child' });
    selectSegment(c, chats, chat, [
      ['claude', old],
      ['claude', key],
    ]);
    state.patch(chat, { tasks: [...s(chat).tasks, { id: 'legacy', status: 'running' }] });
    c.onClaudeEvent({ key: old, kind: 'tasks', tasks: [] });
    assert.equal(s(chat).tasks.find((t: any) => t.id === 'legacy').status, 'running');
    const tasks = Array.from({ length: 104 }, (_, i) => ({ id: `new-${i}`, status: 'running', startedAt: i }));
    c.onClaudeEvent({ key, kind: 'tasks', tasks });
    assert.equal(c.rt(chat).taskOwners.size, 106);
    assert.deepEqual(s(chat).tasks.find((t: any) => t.id === 'old').source, { kind: 'claude', key: old });
    assert.deepEqual(s(chat).tasks.find((t: any) => t.id === 'new-0').source, { kind: 'claude', key });
    c.onClaudeEvent({ key, kind: 'tasks', tasks: tasks.map((t) => ({ ...t, status: 'completed', completedAt: t.startedAt + 100 })) });
    assert.equal(s(chat).tasks.length, 100);
    assert.equal(c.rt(chat).taskOwners.size, 100);
    c.onClaudeEvent({ key, kind: 'tasks', tasks: [{ id: 'live-new', status: 'running' }] });
    c.onClaudeEvent({ key: old, kind: 'tasks', tasks: [{ id: 'live-old', status: 'running' }] });
    c.onClaudeEvent({ key, kind: 'permission', requestId: 'new-card' });
    c.onClaudeEvent({ key: old, kind: 'closed' });
    assert.equal(s(chat).tasks.find((t: any) => t.id === 'live-old').status, 'stopped');
    assert.equal(s(chat).tasks.find((t: any) => t.id === 'live-new').status, 'running');
    assert.deepEqual(
      s(chat).approvals.map((a: any) => a.id),
      ['new-card'],
    );
    c.onClaudeEvent({ key, kind: 'error' });
    assert.equal(s(chat).tasks.find((t: any) => t.id === 'live-new').status, 'stopped');
    assert.deepEqual(s(chat).approvals, []);
  });

  test('ending or crashing the selected source preserves cards from a different source', () => {
    for (const action of ['end', 'interrupt', 'crash', 'idle-exit']) {
      const retracted: string[] = [];
      const { c, s, chats, state, crashes } = setup({ retract: (id) => retracted.push(id) });
      const chat = 'mixed',
        old = 'claude:old';
      selectSegment(c, chats, chat, [
        ['claude', old],
        ['codex', 'new'],
      ]);
      s(chat);
      c.onClaudeEvent({ key: old, kind: 'elicitation', requestId: 'old', message: 'Keep this' });
      assert.equal('source' in s(chat).approvals[0], false);
      // Duplicate delivery must not transfer the request to another owner.
      c.addApproval(chat, { id: 'old', source: { kind: 'codex', key: 'new' } });
      if (action !== 'idle-exit') state.patch(chat, { turn: 'running', activeTurn: { id: 'T', human: true } });
      if (action === 'interrupt') c.codexStopped(chat, 'T');
      else if (action === 'end') c.end(chat);
      else c.onCodexExit();
      assert.equal(s(chat).approvals[0].id, 'old');
      assert.deepEqual(retracted, []);
      assert.equal(s(chat).turn, action === 'crash' ? 'crashed' : 'idle');
      assert.deepEqual(crashes, action === 'crash' ? [chat] : []);
      c.onClaudeEvent({ key: old, kind: 'error' });
      assert.deepEqual(s(chat).approvals, []);
      assert.equal(c.rt(chat).approvalOwners.size, 0);
    }
  });

  test('closing the last old-source card resumes a replacement waiting phase without ending its turn', () => {
    const { c, s, chats, state } = setup();
    selectSegment(c, chats, 'mixed', [
      ['claude', 'claude:old'],
      ['codex', 'new'],
    ]);
    state.patch('mixed', { turn: 'running', activeTurn: { id: 'T', human: true } });
    c.onClaudeEvent({ key: 'claude:old', kind: 'permission', requestId: 'old', agentID: 'child' });
    assert.equal(s('mixed').turn, 'awaitingUser');
    c.onClaudeEvent({ key: 'claude:old', kind: 'closed' });
    assert.equal(s('mixed').turn, 'running');
    assert.equal(s('mixed').activeTurn.id, 'T');
    assert.deepEqual(s('mixed').approvals, []);
    c.onClaudeEvent({ key: 'claude:old', kind: 'closed' });
    assert.equal(s('mixed').activeTurn.id, 'T');
  });

  test('stale Codex completion and stop cannot finish a selected Claude turn', () => {
    const { c, s, chats, state } = setup();
    selectSegment(c, chats, 'mixed', [
      ['codex', 'old'],
      ['claude', 'claude:new'],
    ]);
    state.patch('mixed', { turn: 'running', activeTurn: { id: 'T', human: true } });
    c.onCodexMessage(codex('turn/started', { threadId: 'old', turn: { id: 'old' } }));
    c.onCodexMessage(codex('item/completed', { threadId: 'old', item: { type: 'agentMessage', text: 'stale' } }));
    c.onCodexMessage(codex('turn/completed', { threadId: 'old', turn: { id: 'T', status: 'completed' } }));
    c.codexStopped('mixed', 'T');
    assert.equal(s('mixed').turn, 'running');
    assert.equal(s('mixed').activeTurn.id, 'T');
    assert.equal(c.rt('mixed').lastText, null);
  });

  test('unknown selected sessions keep their turn while old-source cards are removed', () => {
    const { c, s, chats, state } = setup();
    chats.ensure('unknown');
    c.onCodexMessage(codex('item/commandExecution/requestApproval', { threadId: 'unknown' }, 202));
    // Future records are opaque to this build; emulate a file read after an upgrade.
    c.ref = () => {
      throw new Error('unsupported harness');
    };
    state.patch('unknown', { turn: 'running', activeTurn: { id: 'future', human: true } });
    c.onClaudeEvent({ key: 'unknown', kind: 'settings', ultracode: true });
    c.onCodexExit();
    assert.deepEqual(s('unknown').approvals, []);
    assert.equal(s('unknown').activeTurn.id, 'future');
  });

  test('a custom approval cannot borrow a Codex child lifetime from coincidental metadata', () => {
    const { c, s } = setup();
    c.onCodexMessage(
      codex('item/started', { threadId: 'root', item: { type: 'collabAgentToolCall', tool: 'spawnAgent', receiverThreadIds: ['kid'] } }),
    );
    c.addApproval('root', { id: 'custom', method: 'custom/permission', params: { threadId: 'kid' } });
    c.end('root');
    assert.deepEqual(s('root').approvals, []);
  });
}
