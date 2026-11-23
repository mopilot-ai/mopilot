// Claude/ACP event, stop, plan and native-routing scenarios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crashText, assertCodexRef, setup, tick, codex } from './fixture';

export function registerHarnessesCases() {
  test('Claude: sends run in main; steers add prompts; the turn ends on the last result', async () => {
    const { c, s, claudeSends } = setup();
    const chat = 'claude:s1';
    // the window built the message for the turn the controller started
    c.send(chat, { text: 'hi', opts: { human: true } }, 1);
    await c.claudeSend(chat, chat, { sessionId: 's1' }, { role: 'user', content: 'hi' }, undefined, { human: true, uuid: 'u1' });
    await c.claudeSend(chat, chat, {}, { role: 'user', content: 'more' }, 'now', { uuid: 'u2' });
    assert.equal(claudeSends.length, 2);
    c.send(chat, { text: 'after', opts: { plan: true } }, 1);
    c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'result', subtype: 'success' } });
    assert.equal(s(chat).turn, 'running');
    c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'result', subtype: 'success' } });
    // the queued message went out as the next turn
    assert.equal(s(chat).queue.length, 0);
    assert.equal(s(chat).turn, 'running');
  });

  test('Claude: a steer whose send failed takes back its result; a turn whose result already came then ends', async () => {
    const { c, s } = setup();
    const chat = 'claude:s1';
    c.send(chat, { text: 'hi', opts: { human: true } }, 1);
    await c.claudeSend(chat, chat, {}, { role: 'user', content: 'hi' }, undefined, { human: true, uuid: 'u1' });
    // the steer fails before the turn's result: that result ends the turn
    (c as any).claude.send = async () => {
      throw new Error('send failed');
    };
    await assert.rejects(c.claudeSend(chat, chat, {}, { role: 'user', content: 'more' }, 'now', { uuid: 'u2' }));
    c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'result', subtype: 'success' } });
    assert.equal(s(chat).turn, 'idle');

    // the turn's result comes while the steer is failing: the turn ends when it fails
    (c as any).claude.send = async () => ({ elsewhere: [] });
    c.send(chat, { text: 'again', opts: { human: true } }, 1);
    await c.claudeSend(chat, chat, {}, { role: 'user', content: 'again' }, undefined, { human: true, uuid: 'u3' });
    let fail!: (e: Error) => void;
    (c as any).claude.send = () => new Promise((_r, rej) => (fail = rej));
    const steer = c.claudeSend(chat, chat, {}, { role: 'user', content: 'more' }, 'now', { uuid: 'u4' });
    c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'result', subtype: 'success' } });
    assert.equal(s(chat).turn, 'running');
    fail(new Error('send failed'));
    await assert.rejects(steer);
    assert.equal(s(chat).turn, 'idle');
  });

  test("Claude: a tool call a sub-agent made is marked, the main agent's is not", () => {
    const { c } = setup();
    const chat = 'claude:s1';
    c.claudeSend(chat, chat, {}, {}, undefined, { uuid: 'u1', human: true });
    const use = (id: string, parent: string | null) => ({
      type: 'assistant',
      parent_tool_use_id: parent,
      message: { content: [{ type: 'tool_use', id, name: 'mcp__sage__computer_click', input: {} }] },
    });
    c.onClaudeEvent({ key: chat, kind: 'message', msg: use('toolu_main', null) });
    c.onClaudeEvent({ key: chat, kind: 'message', msg: use('toolu_sub', 'toolu_agent') });
    assert.equal(c.isSubagentCall(chat, 'toolu_sub'), true);
    assert.equal(c.isSubagentCall(chat, 'toolu_main'), false);
    assert.equal(c.isSubagentCall(chat, null), false);
    assert.equal(c.isSubagentCall('other', 'toolu_sub'), false);
  });

  test('Claude: interrupt ends the turn on the next result and keeps the queue; a crash keeps it too', () => {
    const { c, s } = setup();
    const chat = 'claude:s1';
    c.claudeSend(chat, chat, {}, {}, undefined, { uuid: 'u1', human: true });
    assert.deepEqual(s(chat).activeTurn, { id: 'ct-u1', human: true });
    c.claudeSend(chat, chat, {}, {}, 'now', { uuid: 'u2' });
    c.send(chat, { text: 'q' }, 1);
    // the permission mode is what the harness reports
    c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'system', subtype: 'init', permissionMode: 'plan' } });
    assert.equal(s(chat).permission, 'plan');
    c.onClaudeControl(chat, 'interrupt');
    c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'result', subtype: 'error_during_execution' } });
    assert.equal(s(chat).turn, 'idle');
    assert.equal(s(chat).queue.length, 1);
    // Claude Code starts work by itself, then its process dies
    c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'stream_event', event: { type: 'message_start' } } });
    assert.equal(s(chat).turn, 'running');
    assert.equal(s(chat).activeTurn.human, false);
    c.onClaudeEvent({ key: chat, kind: 'permission', requestId: 'cperm-1', toolName: 'Bash' });
    assert.equal(s(chat).turn, 'awaitingUser');
    c.onClaudeEvent({ key: chat, kind: 'closed' });
    assert.equal(s(chat).turn, 'crashed');
    assert.equal(s(chat).crashed, crashText('claude'));
    assert.deepEqual(s(chat).approvals, []);
    assert.equal(s(chat).queue.length, 1);
  });

  test('ACP: a basic-tier chat runs in main; follow-ups always queue; the stop reason ends the turn', async () => {
    const { c, s, execs, acpSends, acpCancels } = setup();
    const chat = 'acp:kimi:k1';
    assert.deepEqual(c.ref(chat), { kind: 'acp:kimi', id: 'k1', instance: null, key: chat });
    c.send(chat, { text: 'one', opts: { human: true } }, 1);
    await tick();
    assert.equal(execs.length, 1);
    await c.acpSend(chat, chat, { blocks: [] }, { uuid: 'u1', human: true });
    assert.equal(acpSends[0][2].chatId, chat);
    c.onAcpEvent({ key: chat, kind: 'turnStart', turnId: 'at-u1', human: true });
    assert.deepEqual(s(chat).activeTurn, { id: 'at-u1', human: true });
    // there is nothing to steer into: a steer request queues
    assert.equal(c.send(chat, { text: 'two', opts: {}, followUp: 'steer' }, 1).action, 'queued');
    c.onAcpEvent({ key: chat, kind: 'permission', requestId: 'acpperm-1', toolCall: { title: 'x' }, options: [] });
    assert.equal(s(chat).turn, 'awaitingUser');
    assert.equal(s(chat).approvals[0].method, 'acp/permission');
    c.onAcpEvent({ key: chat, kind: 'permissionCancelled', requestId: 'acpperm-1' });
    assert.equal(s(chat).turn, 'running');
    c.onAcpEvent({ key: chat, kind: 'turnEnd', turnId: 'at-u1', stopReason: 'end_turn' });
    await tick();
    // the queued follow-up went out as the next turn
    assert.equal(execs.length, 2);
    assert.equal(execs[1].item.text, 'two');
    // Stop: cancel, and the cancelled turn doesn't drain the queue
    c.send(chat, { text: 'three', opts: {} }, 1);
    assert.equal(c.acpCancel(chat), true);
    assert.deepEqual(acpCancels, [chat]);
    c.onAcpEvent({ key: chat, kind: 'turnEnd', turnId: 'at-u2', stopReason: 'cancelled' });
    assert.equal(s(chat).turn, 'idle');
    assert.equal(s(chat).queue.length, 1);
  });

  test('ACP: the harness process going away crashes the chat and keeps its queue', () => {
    const { c, s } = setup();
    const chat = 'acp:dsh:d1';
    c.acpSend(chat, chat, {}, { uuid: 'u1' });
    c.send(chat, { text: 'later', opts: {} }, 1);
    c.onAcpEvent({ key: chat, kind: 'closed', error: 'dsh exited (1)' });
    assert.equal(s(chat).turn, 'crashed');
    assert.equal(s(chat).crashed, 'dsh exited (1)');
    assert.equal(s(chat).queue.length, 1);
  });

  test('ACP: session-level updates become the chat’s acp state', () => {
    const { c, s } = setup();
    const chat = 'acp:kimi:k2';
    c.acpSend(chat, chat, {}, { uuid: 'u1' });
    c.onAcpEvent({
      key: chat,
      kind: 'session',
      modes: {
        currentModeId: 'a',
        availableModes: [
          { id: 'a', name: 'A' },
          { id: 'b', name: 'B' },
        ],
      },
      configOptions: [],
    });
    assert.equal(s(chat).acp.commands, null);
    c.onAcpEvent({
      key: chat,
      kind: 'update',
      turnId: null,
      update: { sessionUpdate: 'available_commands_update', availableCommands: [{ name: 'goal', description: 'Set a goal' }] },
    });
    c.onAcpEvent({ key: chat, kind: 'update', turnId: null, update: { sessionUpdate: 'current_mode_update', currentModeId: 'b' } });
    c.onAcpEvent({ key: chat, kind: 'update', turnId: null, update: { sessionUpdate: 'usage_update', used: 5, size: 10 } });
    c.onAcpEvent({ key: chat, kind: 'state', state: { configOptions: [{ id: 'model' }] } });
    assert.deepEqual(s(chat).acp.commands, [{ name: 'goal', description: 'Set a goal' }]);
    assert.equal(s(chat).acp.modes.currentModeId, 'b');
    assert.deepEqual(s(chat).acp.usage, { used: 5, size: 10 });
    assert.deepEqual(s(chat).acp.configOptions, [{ id: 'model' }]);
    // a session reopened later keeps the catalog it had
    c.onAcpEvent({ key: chat, kind: 'session', modes: null, configOptions: null });
    assert.equal(s(chat).acp.commands.length, 1);
  });

  test('Claude: Stop goes to the Claude adapter, and a crash is told to it before the chat is marked', async () => {
    const { c, s, stops, claudeCrashes } = setup();
    const chat = 'claude:s7';
    assert.equal(await c.stopChat(chat), true);
    assert.deepEqual(stops, [chat]);
    c.claudeSend(chat, chat, {}, {}, undefined, { uuid: 'u1', human: true });
    c.onClaudeEvent({ key: chat, kind: 'closed' });
    assert.deepEqual(claudeCrashes, [chat]);
    assert.equal(s(chat).turn, 'crashed');
    // a stop the user asked for is no crash
    c.claudeSend(chat, chat, {}, {}, undefined, { uuid: 'u2', human: true });
    c.onClaudeControl(chat, 'interrupt');
    c.onClaudeEvent({ key: chat, kind: 'closed' });
    assert.deepEqual(claudeCrashes, [chat]);
  });

  test('pause journal failure does not prevent native stop or interrupted cleanup', async () => {
    const notices: any[] = [];
    const { c, s, stops, acpCancels } = setup({ notify: (...args: any[]) => notices.push(args) });
    c.onStopped = () => {
      throw new Error('disk full');
    };
    assert.equal(await c.stopChat('claude:s7'), true);
    assert.deepEqual(stops, ['claude:s7']);
    assert.equal(await c.stopChat('acp:test:one'), true);
    assert.deepEqual(acpCancels, ['acp:test:one']);
    let codexStopped = false;
    c.codex.stopTurn = async () => {
      codexStopped = true;
      return true;
    };
    assert.equal(await c.stopChat('t1'), true);
    assert.equal(codexStopped, true);
    c.acpSend('acp:test:one', 'acp:test:one', {}, { uuid: 'u1' });
    c.send('acp:test:one', { text: 'Keep queued', opts: {} }, 1);
    c.onAcpEvent({ key: 'acp:test:one', kind: 'turnEnd', turnId: 'at-u1', stopReason: 'cancelled' });
    assert.equal(s('acp:test:one').turn, 'idle');
    assert.equal(s('acp:test:one').queue.length, 1);
    assert.equal(c.rt('acp:test:one').inputToken, null);
    assert.equal(notices.length, 4);
    assert.ok(notices.every((n) => n[2].title === 'Stop could not be saved'));
  });

  test("Stop on Codex and ACP lets go of the chat's running tool calls (onInterrupt): at once, and when a stopped turn ends", async () => {
    const { c, s } = setup();
    const seen: string[] = [];
    c.onInterrupt = (chatId: string) => void seen.push(chatId);
    c.codex.stopTurn = async () => true;
    // stopChat on ACP and Codex
    await c.stopChat('acp:test:one');
    await c.stopChat('t1');
    assert.deepEqual(seen, ['acp:test:one', 't1']);
    // a window's ACP Stop
    seen.length = 0;
    c.acpCancel('acp:test:two');
    assert.deepEqual(seen, ['acp:test:two']);
    // a Codex turn a window interrupted itself (turn/interrupt) lets go when it ends interrupted; a completed one doesn't
    seen.length = 0;
    c.send('t2', { text: 'go', opts: {} }, 1);
    await tick();
    c.onCodexMessage(codex('turn/completed', { threadId: 't2', turn: { id: 'x', status: 'completed' } }));
    assert.deepEqual(seen, []);
    c.send('t2', { text: 'again', opts: {} }, 1);
    await tick();
    c.onCodexMessage(codex('turn/completed', { threadId: 't2', turn: { id: 'y', status: 'interrupted' } }));
    assert.equal(s('t2').turn, 'idle');
    assert.deepEqual(seen, ['t2']);
    // a hook that throws does not keep the stop from the harness
    c.onInterrupt = () => {
      throw new Error('registry gone');
    };
    assert.equal(await c.stopChat('t3'), true);
  });

  test("Stop on Claude Code leaves the chat's calls to the SDK's per-call cancel: background agents' calls keep running", async () => {
    const { c, s, stops } = setup();
    const seen: string[] = [];
    c.onInterrupt = (chatId: string) => void seen.push(chatId);
    // the Claude adapter's channel cancels each call itself (sdkMcp passes the SDK's extra.signal)
    c.claudeTurns.cancelsToolCalls = true;
    assert.equal(await c.stopChat('claude:s7'), true);
    assert.deepEqual(stops, ['claude:s7']);
    c.claudeSend('claude:s7', 'claude:s7', {}, {}, undefined, { uuid: 'u1', human: true });
    c.onClaudeControl('claude:s7', 'interrupt');
    c.onClaudeEvent({ key: 'claude:s7', kind: 'message', msg: { type: 'result', subtype: 'error_during_execution', is_error: true } });
    assert.equal(s('claude:s7').turn, 'idle');
    assert.deepEqual(seen, [], 'no blanket abort for a Claude Code chat');
    // an adapter that does not cancel its calls itself gets the blanket abort
    c.claudeTurns.cancelsToolCalls = false;
    await c.stopChat('claude:s8');
    assert.deepEqual(seen, ['claude:s8']);
  });

  test('Claude: plan follows the mode Claude reports; an approved plan turns it off', () => {
    const { c, s, state } = setup();
    const chat = 'claude:p1';
    state.clientPatch(chat, { plan: true });
    c.claudeSend(chat, chat, {}, {}, undefined, { uuid: 'u1', human: true });
    c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'system', subtype: 'status', status: null, permissionMode: 'plan' } });
    assert.equal(s(chat).plan, true);
    // ExitPlanMode approved with setMode: the CLI reports the mode it went back to
    c.onClaudeEvent({
      key: chat,
      kind: 'message',
      msg: { type: 'system', subtype: 'status', status: null, permissionMode: 'acceptEdits' },
    });
    assert.equal(s(chat).plan, false);
    assert.equal(s(chat).permission, 'acceptEdits');
    // the model entering plan mode on its own turns it on
    c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'system', subtype: 'status', status: null, permissionMode: 'plan' } });
    assert.equal(s(chat).plan, true);
    // a status without a mode (compacting) changes nothing
    c.onClaudeEvent({ key: chat, kind: 'message', msg: { type: 'system', subtype: 'status', status: 'compacting' } });
    assert.equal(s(chat).plan, true);
  });

  test('Claude: the task table and ultracode follow what main reports; a dead process leaves its tasks stopped', () => {
    const { c, s } = setup();
    const chat = 'claude:t1';
    c.claudeSend(chat, chat, {}, {}, undefined, { uuid: 'u1', human: true });
    const task = {
      id: 'a1',
      type: 'local_agent',
      description: 'Explore',
      status: 'running',
      summary: null,
      toolUseId: 't',
      subagentType: null,
      workflowName: null,
      parentTaskId: null,
      ambient: false,
    };
    c.onClaudeEvent({ key: chat, kind: 'tasks', tasks: [task] });
    assert.deepEqual(s(chat).tasks, [{ ...task, source: { kind: 'claude', key: chat } }]);
    c.onClaudeEvent({ key: chat, kind: 'settings', probe: 'ok', ultracode: true, available: true });
    assert.deepEqual(s(chat).ultracode, { on: true, available: true, probe: 'ok' });
    c.onClaudeEvent({ key: chat, kind: 'closed' });
    assert.deepEqual(
      s(chat).tasks.map((t: any) => [t.id, t.status, t.summary]),
      [['a1', 'stopped', 'Ended when the Claude Code process exited']],
    );
    // a new process reports none of its own yet: the finished task stays listed
    c.onClaudeEvent({ key: chat, kind: 'tasks', tasks: [] });
    assert.deepEqual(
      s(chat).tasks.map((t: any) => t.id),
      ['a1'],
    );
    c.onClaudeEvent({ key: chat, kind: 'tasks' });
    assert.equal(s(chat).tasks.length, 1);
  });

  test('Claude: an MCP elicitation waits for the user like an approval', () => {
    const { c, s } = setup();
    const chat = 'claude:e1';
    c.claudeSend(chat, chat, {}, {}, undefined, { uuid: 'u1', human: true });
    c.onClaudeEvent({ key: chat, kind: 'elicitation', requestId: 'cperm-e', serverName: 'linear', message: 'Sign in', mode: 'url' });
    assert.equal(s(chat).turn, 'awaitingUser');
    assert.equal(s(chat).approvals[0].method, 'mcpServer/elicitation/request');
    c.resolveApproval('cperm-e');
    assert.equal(s(chat).turn, 'running');
  });

  test('Claude: main builds the message from what was typed and attached', async () => {
    const { c, claudeSends } = setup();
    const chat = 'claude:m1';
    await c.claudeSend(chat, chat, {}, { text: '/goal done', attachments: [], prefix: 'handoff' }, undefined, { uuid: 'u1' });
    assert.deepEqual(claudeSends[0][2], {
      role: 'user',
      content: [
        { type: 'text', text: 'handoff' },
        { type: 'text', text: '/goal done' },
      ],
    });
    await c.claudeSend(chat, chat, {}, { role: 'user', content: 'as is' }, 'now', { uuid: 'u2' });
    assert.deepEqual(claudeSends[1][2], { role: 'user', content: 'as is' });
  });

  test('routing: a Claude chat never reaches Codex, whatever its id looks like', async () => {
    const { c, chats, execs, claudeSends, s } = setup();
    chats.setSegments('claude:c1', [{ harness: 'claude', nativeId: 'claude:c1', start: 0, count: null }]);
    c.invalidate();
    c.send('claude:c1', { text: 'hi', attachments: [], opts: { human: true } }, 1);
    await tick();
    // the Claude turn goes to the Claude adapter, and nothing was handed to the Codex adapter
    assert.deepEqual(
      execs.map((e) => e.kind),
      ['claude-turn'],
    );
    assert.equal(execs[0].ref.kind, 'claude');
    assert.equal(execs[0].ref.id, 'c1');
    assert.equal(s('claude:c1').turn, 'running');
    // a Codex-first chat that switched to Claude goes by its last segment, not by its first id
    chats.setSegments('t9', [
      { harness: 'codex', nativeId: 't9', start: 0, count: 1 },
      { harness: 'claude', nativeId: 'claude:s9', start: 1, count: null },
    ]);
    c.invalidate();
    c.send('t9', { text: 'again', attachments: [], opts: {} }, 1);
    await tick();
    assert.equal(execs.at(-1)!.kind, 'claude-turn');
    assert.equal(execs.at(-1)!.ref.kind, 'claude');
    assert.equal(claudeSends.length, 0);
  });

  test('routing: a Codex segment holding a claude: id fails instead of reaching Codex', async () => {
    const { c, chats, execs, s } = setup();
    // the Codex adapter checks the ref before its rpc layer (electron/harness/codexRef.cjs); the turn ends without a start
    const start = c.codex.startTurn;
    c.codex.startTurn = (chatId: string, ref: any, item: any, origin: number | null) => (
      assertCodexRef(ref), start(chatId, ref, item, origin)
    );
    chats.setSegments('bad', [
      { harness: 'codex', nativeId: 'bad', start: 0, count: 1 },
      { harness: 'codex', nativeId: 'claude:oops', start: 1, count: null },
    ]);
    c.invalidate();
    c.send('bad', { text: 'hi', attachments: [], opts: {} }, 1);
    await tick();
    assert.equal(execs.length, 0);
    assert.equal(s('bad').turn, 'crashed');
    assert.ok(s('bad').crashed, 'the routing failure is visible');
  });

  test('routing: a segment kind this build does not know is an error', async () => {
    const { c, chats, execs, s } = setup();
    chats.setSegments('x', [
      { harness: 'codex', nativeId: 'x', start: 0, count: 1 },
      { harness: 'gemini', nativeId: 'g1', start: 1, count: null },
    ]);
    c.invalidate();
    assert.throws(() => c.ref('x'), /Unknown harness kind/);
    // nothing is sent: the turn ends before it starts
    c.send('x', { text: 'hi', attachments: [], opts: {} }, 1);
    await tick();
    assert.equal(execs.length, 0);
    assert.equal(s('x').turn, 'crashed');
    assert.ok(s('x').crashed, 'the routing failure is visible');
  });

  test('ACP: the Plan chip follows the mode or config value the quirks mark as plan', () => {
    const { c, s } = setup();
    const modes = (id: string) => ({ currentModeId: id, availableModes: [{ id: 'default' }, { id: 'plan' }] });
    const qwen = 'acp:qwen:q1';
    c.send(qwen, { text: 'x', opts: {} }, 1);
    c.onAcpEvent({ key: qwen, kind: 'session', modes: modes('default'), configOptions: null });
    assert.equal(s(qwen).plan, false);
    c.onAcpEvent({ key: qwen, kind: 'state', state: { modes: modes('plan') } });
    assert.equal(s(qwen).plan, true);
    // a usage update does not move the chip
    c.onAcpEvent({ key: qwen, kind: 'update', update: { sessionUpdate: 'usage_update', used: 1, size: 10 } });
    assert.equal(s(qwen).plan, true);
    // the agent leaves plan mode itself
    c.onAcpEvent({ key: qwen, kind: 'update', update: { sessionUpdate: 'current_mode_update', currentModeId: 'default' } });
    assert.equal(s(qwen).plan, false);
    // a config value marks it on kimi
    const kimi = 'acp:kimi:k2';
    c.send(kimi, { text: 'x', opts: {} }, 1);
    const cfg = (v: string) => [{ id: 'mode', currentValue: v, options: [] }];
    c.onAcpEvent({ key: kimi, kind: 'session', modes: null, configOptions: cfg('build') });
    assert.equal(s(kimi).plan, false);
    c.onAcpEvent({ key: kimi, kind: 'update', update: { sessionUpdate: 'config_option_update', configOptions: cfg('plan') } });
    assert.equal(s(kimi).plan, true);
  });
}
