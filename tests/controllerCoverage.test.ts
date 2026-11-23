// electron/session/controller.cjs edge cases: sparse queue items and events, callbacks that throw,
// ACP and Claude bookkeeping corners, Codex messages that don't belong to a turn, and the pure helpers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { defined } from './support/defined.ts';
import { registerStartFailures } from './support/controller-coverage/start-failures.ts';
import { setup } from './support/controller-coverage/setup.ts';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const {
  ChatController,
  crashText,
  queueItem,
  acpPlanOn,
  acpStateUpdate,
  noteSubagentCalls,
} = require('../electron/session/controller.cjs');

test('controller keeps the shared event helpers and all harness event methods on one owner', () => {
  const events = require('../electron/session/controllerEvents.cjs');
  assert.equal(crashText, events.crashText);
  assert.equal(acpPlanOn, events.acpPlanOn);
  assert.equal(acpStateUpdate, events.acpStateUpdate);
  assert.equal(noteSubagentCalls, events.noteSubagentCalls);
  for (const name of [
    'onCodexMessage',
    'codexStopped',
    'onCodexOutgoing',
    'onCodexExit',
    'onAcpEvent',
    'patchAcp',
    'onClaudeControl',
    'onClaudeEvent',
  ]) {
    assert.equal(ChatController.prototype[name], events.ControllerEvents.prototype[name]);
  }
});

test('crashText names a harness without a label by its kind; queue items fill every field', () => {
  assert.match(crashText('acp:kimi'), /^acp:kimi quit while working/);
  const q = queueItem(null);
  assert.match(q.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual([q.text, q.attachments, q.opts, q.origin], ['', [], {}, null]);
  assert.match(queueItem({ id: '', text: 1, opts: null }, 3).id, /^[0-9a-f-]{36}$/);
  assert.equal(queueItem({ text: 1 }, 3).text, '1');
});

test("nativeOf is the key of the chat's current segment", () => {
  const { c } = setup();
  assert.equal(c.nativeOf('cl1'), 'claude:cl1');
  assert.equal(c.nativeOf('cx1'), 'cx1');
});

test('queue: removing or sending an unknown item does nothing; Send now on a busy ACP chat puts it first', () => {
  const { c, state, s } = setup();
  assert.equal(c.removeQueued('cx1', 'nope'), null);
  assert.equal(c.sendNow('cx1', 'nope'), false);
  state.patch('acp1', { turn: 'running' });
  c.send('acp1', { id: 'a', text: 'one' });
  c.send('acp1', { id: 'b', text: 'two', followUp: 'steer' });
  assert.deepEqual(
    s('acp1').queue.map((x: any) => x.id),
    ['a', 'b'],
  );
  assert.equal(c.sendNow('acp1', 'b'), true);
  assert.deepEqual(
    s('acp1').queue.map((x: any) => x.id),
    ['b', 'a'],
  );
});

test("Send now steers a busy Claude chat from the item's own window", async () => {
  const { c, state, log } = setup();
  state.patch('cl1', { turn: 'running' });
  c.send('cl1', { id: 'q', text: 'later' }, 4);
  assert.equal(c.sendNow('cl1', 'q'), true);
  await tick();
  assert.deepEqual(log.at(-1), ['claude-steer', 'cl1', 'later', 4]);
});

registerStartFailures(setup, tick);

test('callbacks that throw are contained: notify, retract, onCrash; an unknown kind notifies as Codex', async () => {
  const seen: any[] = [];
  const { c, state, s } = setup({
    ctl: {
      notify: (kind: string, _id: string, opts: any) => {
        seen.push([kind, opts.title, opts.body]);
        throw new Error('notifier down');
      },
      retract: () => {
        throw new Error('x');
      },
      onCrash: () => {
        throw new Error('y');
      },
    },
  });
  state.patch('bad1', { turn: 'running' });
  c.end('bad1');
  assert.deepEqual(seen, [['turn', 'Codex', 'Task complete']]);
  c.say('turn', 'cx1', { title: 't' });
  assert.equal(defined(seen.at(-1))[2], '');
  state.patch('cx1', { turn: 'running' });
  assert.equal(c.crash('cx1', 'gone'), true);
  assert.equal(s('cx1').crashed, 'gone');
});

test('approvals: a request on an idle chat keeps it idle; an MCP server without a name; resolving skips other chats', () => {
  const said: any[] = [];
  const { c, state, s } = setup({ ctl: { notify: (_k: string, _id: string, o: any) => said.push(o.title) } });
  c.addApproval('cx1', { id: 1, method: 'mcpServer/elicitation/request', params: {} });
  assert.equal(s('cx1').turn, 'idle');
  assert.deepEqual(said, ['An MCP server needs input']);
  state.patch('cx2', { turn: 'running' });
  assert.equal(c.resolveApproval(1), true);
  assert.equal(c.resolveApproval(99), false);
});

test('Codex messages: no method, no params, empty agent text, turns without ids, a completed turn on an idle or other turn', () => {
  const { c, state, s } = setup();
  c.onCodexMessage(null);
  c.onCodexMessage({});
  c.onCodexMessage({ method: 'turn/started' }); // no params, no thread
  state.patch('cx1', { turn: 'idle' });
  c.onCodexMessage({ method: 'item/completed', params: { threadId: 'cx1', item: { type: 'agentMessage' } } });
  assert.equal(c.rt('cx1').lastText, null);
  c.onCodexMessage({ method: 'turn/completed', params: { threadId: 'cx1', turn: { id: 't' } } });
  assert.equal(s('cx1').turn, 'idle');
  // a harness-started turn without an id
  c.onCodexMessage({ method: 'turn/started', params: { threadId: 'cx1' } });
  assert.deepEqual(s('cx1').activeTurn, { id: null, human: false });
  // the same turn again changes nothing; another turn's completion is ignored
  state.patch('cx1', { activeTurn: { id: 'a', human: true } });
  c.onCodexMessage({ method: 'turn/started', params: { threadId: 'cx1', turn: { id: 'a' } } });
  c.onCodexMessage({ method: 'turn/completed', params: { threadId: 'cx1', turn: { id: 'b' } } });
  assert.equal(s('cx1').turn, 'running');
});

test('onCodexExit skips chats of an unknown kind and other harnesses', () => {
  const { c, state, s } = setup();
  for (const id of ['bad1', 'cl1', 'cx1']) state.patch(id, { turn: 'running' });
  assert.deepEqual(c.onCodexExit(), []);
  assert.equal(s('bad1').turn, 'running');
  assert.equal(s('cl1').turn, 'running');
  assert.equal(s('cx1').turn, 'crashed');
});

test("ACP: a send without a uuid names the turn itself; Stop cancels the chat's session", async () => {
  const { c, s, log } = setup({ ids: ['cx1', 'acp1'] });
  await c.acpSend('acp1', 'acp:kimi:acp1', {}, undefined);
  assert.match(s('acp1').activeTurn.id, /^at-[0-9a-f-]{36}$/);
  assert.equal(await c.stopChat('acp1'), true);
  assert.deepEqual(log.at(-1), ['acp-cancel', 'acp:kimi:acp1']);
  assert.equal(c.rt('acp1').interrupted, true);
});

test('ACP events: ignored without a key or an open chat; sparse permission, closed, state and update events', () => {
  const { c, state, s } = setup({ ids: ['acp1'] });
  c.onAcpEvent(null);
  c.onAcpEvent({ key: 'unknown', kind: 'turnStart' });
  assert.equal(state.has('unknown'), false);
  state.patch('acp1', { plan: false });
  c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'turnEnd' }); // not busy
  c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'state', state: { usage: { used: 1 } } });
  assert.deepEqual(s('acp1').acp, { modes: null, configOptions: null, commands: null, usage: { used: 1 } });
  c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'update', update: { sessionUpdate: 'other' } });
  c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'turnStart', turnId: 't1' });
  c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'permission', requestId: 'p' });
  assert.deepEqual(s('acp1').approvals[0].params, { toolCall: null, options: [] });
  c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'closed' });
  assert.equal(s('acp1').crashed, 'The harness exited');
});

test('Claude sends: no input builds an empty message; a send without a uuid names the turn', async () => {
  const { c, s, log } = setup();
  await c.claudeSend('cl1', 'claude:cl1', {}, null, 'next');
  assert.match(s('cl1').activeTurn.id, /^ct-[0-9a-f-]{36}$/);
  assert.equal(log.at(-1)[0], 'claude-send');
  assert.equal(log.at(-1)[2].role, 'user');
  c.onClaudeControl('claude:cl1', 'other');
  assert.equal(c.rt('cl1').interrupted, false);
});

test('Claude events: ignored without a key or open chat; sparse messages, results while idle, sparse settings and tasks', () => {
  const { c, state, s } = setup({ ids: ['cl1'] });
  c.onClaudeEvent(null);
  c.onClaudeEvent({ key: 'nobody', kind: 'message' });
  state.patch('cl1', { plan: false });
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'message' }); // no msg: nothing starts
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'message', msg: { type: 'result' } });
  assert.equal(s('cl1').turn, 'idle');
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'message', msg: { type: 'assistant', message: { content: [{ type: 'tool_use' }] } } });
  assert.equal(c.rt('cl1').lastText, null);
  assert.equal(s('cl1').turn, 'running'); // Claude started work by itself
  c.onClaudeEvent({
    key: 'claude:cl1',
    kind: 'elicitation',
    requestId: 'e',
    serverName: 's',
    title: 'Sign in',
    message: 'Open the page',
    mode: 'url',
  });
  assert.equal(s('cl1').approvals[0].params.message, 'Sign in: Open the page');
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'tasks', tasks: 'nope' });
  assert.deepEqual(s('cl1').tasks, []);
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'settings' });
  assert.deepEqual(s('cl1').ultracode, { on: false, available: false, probe: 'ok' });
  c.end('cl1', { drain: false });
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'closed' }); // idle: nothing crashes
  assert.equal(s('cl1').turn, 'idle');
});

test('sub-agent calls: only assistant content is read, and only the newest 500 ids are kept', () => {
  const r = { subagentCalls: new Set<string>() };
  noteSubagentCalls(r, { type: 'user', message: { content: [{ type: 'tool_use', id: 'x' }] } });
  assert.equal(r.subagentCalls.size, 0);
  noteSubagentCalls(r, {
    type: 'assistant',
    message: { content: Array.from({ length: 502 }, (_, i) => ({ type: 'tool_use', id: `t${i}` })) },
  });
  assert.equal(r.subagentCalls.size, 500);
  assert.equal(r.subagentCalls.has('t0'), false);
  assert.equal(r.subagentCalls.has('t501'), true);
});

test('acp helpers: a marker with neither mode nor option; updates with missing or bad fields', () => {
  assert.equal(acpPlanOn({ modes: null }, { other: 1 }), false);
  assert.equal(acpPlanOn({}, { configOption: 'mode', value: 'plan' }), false);
  assert.deepEqual(acpStateUpdate(null, { sessionUpdate: 'available_commands_update' }).commands, []);
  assert.deepEqual(acpStateUpdate(null, { sessionUpdate: 'current_mode_update', currentModeId: 'plan' }).modes, {
    currentModeId: 'plan',
    availableModes: [],
  });
  assert.deepEqual(
    acpStateUpdate({ modes: { currentModeId: 'a', availableModes: [1] } }, { sessionUpdate: 'current_mode_update', currentModeId: 'b' })
      .modes,
    { currentModeId: 'b', availableModes: [1] },
  );
  assert.equal(acpStateUpdate(null, { sessionUpdate: 'config_option_update' }), null);
  assert.deepEqual(acpStateUpdate(null, { sessionUpdate: 'usage_update' }).usage, { used: null, size: null });
  assert.equal(acpStateUpdate(null, undefined), null);
});

test('sparse events: an item/completed without an item, an assistant message without content, a titled elicitation', () => {
  const { c, state, s } = setup({ ids: ['cx1', 'cl1'] });
  state.patch('cx1', {});
  c.onCodexMessage({ method: 'item/completed', params: { threadId: 'cx1' } });
  assert.equal(c.rt('cx1').lastText, null);
  state.patch('cl1', {});
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'message', msg: { type: 'assistant' } });
  assert.equal(s('cl1').turn, 'running', 'Claude started work on its own');
  assert.equal(c.rt('cl1').lastText, null);
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'elicitation', requestId: 'e1', serverName: 'srv', title: 'Login', message: 'pick one' });
  assert.equal(s('cl1').approvals.at(-1).params.message, 'Login: pick one');
  c.onClaudeEvent({
    key: 'claude:cl1',
    kind: 'message',
    msg: { type: 'assistant', message: { content: [{ type: 'text', text: ' done ' }, null] } },
  });
  assert.equal(c.rt('cl1').lastText, 'done');
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'permissionCancelled', requestId: 'e1' });
  assert.equal(
    s('cl1').approvals.some((a: any) => a.id === 'e1'),
    false,
  );
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'permission', requestId: 'p2', toolName: 'Bash', input: {} });
  c.onCodexMessage({ method: 'serverRequest/resolved', params: { requestId: 'p2' } });
  assert.equal(s('cl1').approvals.length, 0);
});

test('Send now keeps a queued peer item queued while the target awaits approval', () => {
  const { c, state, s } = setup();
  state.patch('cx1', {
    turn: 'awaitingUser',
    activeTurn: { id: 't' },
    queue: [{ id: 'p', text: 'peer', attachments: [], opts: {}, peer: { messageId: 'p' } }],
  });
  assert.equal(c.sendNow('cx1', 'p'), false);
  assert.deepEqual(
    s('cx1').queue.map((q: any) => q.id),
    ['p'],
  );
});

test('a non-Error receipt failure is recorded on the dispatch result', async () => {
  const { c } = setup({
    ctl: {
      onDispatchResult: () => {
        throw 'journal offline';
      },
    },
  });
  const result = await c.dispatch('cx1', 'turn', { id: 'i', text: 'x', opts: {} }, null);
  assert.equal(result.started, true);
  assert.equal(result.receiptError, 'journal offline');
});

test('a killed harness reports the blocked start to the delivery hook, even when that hook throws', async () => {
  const results: any[] = [];
  const { c, s } = setup({
    ctl: {
      killed: () => 'disabled_by_admin',
      onDispatchResult: (e: any) => {
        results.push(e.result);
        throw new Error('ack');
      },
    },
  });
  await c.start('cx1', { id: 'k', text: 'x', opts: {} });
  assert.deepEqual(results, [{ started: false, blocked: 'disabled_by_admin', error: 'disabled_by_admin', code: 'harness_turned_off' }]);
  assert.equal(s('cx1').turn, 'crashed');
  assert.deepEqual(
    s('cx1').queue.map((q: any) => q.id),
    ['k'],
  );
});

test('a turn-finished hook that throws synchronously does not stop the turn from ending', () => {
  const { c, state, s } = setup({
    ctl: {
      onFinished: () => {
        throw new Error('hook');
      },
    },
  });
  state.patch('cx1', { turn: 'running', activeTurn: { id: 't' } });
  c.end('cx1', { drain: false });
  assert.equal(s('cx1').turn, 'idle');
});

test('a turn-finished hook that rejects does not stop the turn from ending or escape', async () => {
  let calls = 0;
  const { c, state, s } = setup({
    ctl: {
      onFinished: async () => {
        calls++;
        throw new Error('hook');
      },
    },
  });
  state.patch('cx1', { turn: 'running', activeTurn: { id: 't' } });
  c.end('cx1', { drain: false });
  await new Promise((r) => setImmediate(r));
  assert.equal(calls, 1);
  assert.equal(s('cx1').turn, 'idle');
});

test('ACP turn ends for another turn are ignored, and text chunks without text add nothing', () => {
  const finished: any[] = [];
  const { c, s, state } = setup({ ids: ['acp1'], ctl: { onFinished: (e: any) => finished.push(e) } });
  state.patch('acp1', { plan: false });
  c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'turnStart', turnId: 't1' });
  c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'turnEnd', turnId: 'other', stopReason: 'end_turn' });
  assert.equal(s('acp1').turn, 'running');
  c.onAcpEvent({
    key: 'acp:kimi:acp1',
    kind: 'update',
    turnId: 't1',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text' } },
  });
  c.onAcpEvent({
    key: 'acp:kimi:acp1',
    kind: 'update',
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Done' } },
  });
  c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' });
  assert.equal(s('acp1').turn, 'idle');
  assert.equal(finished.length, 1);
  assert.equal(finished[0].text, 'Done');
  assert.equal(finished[0].completed, true);
});

test('awaited Send now reports peer guard refusals as queued and actual delivery failures as failed', async () => {
  for (const turn of ['awaitingUser', 'running', 'idle']) {
    const { c, state, s } = setup({ result: { started: false, error: 'peer refused' } });
    c.codex.peerCapabilities = () => ({ messaging: true, read: true, steer: true });
    state.patch('cx1', {
      turn,
      activeTurn: turn === 'idle' ? null : { id: 'live' },
      queue: [{ id: 'p', text: 'peer', attachments: [], opts: {}, peer: { messageId: 'p' } }],
    });
    const result = await c.sendNow('cx1', 'p', 1, true);
    assert.equal(result.status, turn === 'awaitingUser' ? 'queued' : 'failed');
    assert.ok(result.error);
    assert.equal(s('cx1').queue.length, turn === 'awaitingUser' ? 1 : 0);
  }
});

test('initial send recovery handles exceptions and existing requeues without taking over peer failures', async () => {
  for (const scenario of ['throws', 'already-queued', 'kill-switch', 'peer']) {
    const { c, state, s } = setup({ result: { started: false } });
    if (scenario === 'throws')
      c.codex.startTurn = async () => {
        throw new Error('connection lost');
      };
    else if (scenario === 'kill-switch') c.killed = () => 'disabled';
    else if (scenario === 'already-queued')
      c.beforeDispatch = (delivery: any) => {
        state.patch('cx1', { queue: [delivery.item] });
        throw Object.assign(new Error('retained'), { queuedFallback: true });
      };
    const sent = c.send('cx1', { text: 'keep', opts: {}, ...(scenario === 'peer' ? { peer: { messageId: 'peer' } } : {}) }, 1);
    await tick();
    assert.equal(s('cx1').queue.length, scenario === 'peer' ? 0 : 1);
    if (scenario !== 'peer') assert.equal(s('cx1').queue[0].id, sent.id);
  }
});

test('main completion text agrees with the validated Claude and ACP content', () => {
  const finished: any[] = [];
  const { c, state } = setup({ ids: ['cl1', 'acp1'], ctl: { onFinished: (e: any) => finished.push(e) } });
  state.patch('cl1', { plan: false });
  state.patch('acp1', { plan: false });
  const content = [
    { type: 'text', text: 42 },
    { type: 'text', text: {} },
    { type: 'text', text: 'Kept' },
  ];
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'message', msg: { type: 'assistant', message: { content } } });
  c.onClaudeEvent({ key: 'claude:cl1', kind: 'message', msg: { type: 'result', subtype: 'success' } });
  c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'turnStart', turnId: 't' });
  for (const text of [42, {}, ['Fake'], 'Kept']) {
    c.onAcpEvent({
      key: 'acp:kimi:acp1',
      kind: 'update',
      turnId: 't',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
  }
  c.onAcpEvent({ key: 'acp:kimi:acp1', kind: 'turnEnd', turnId: 't', stopReason: 'end_turn' });
  assert.deepEqual(
    finished.map((e) => e.text),
    ['Kept', 'Kept'],
  );
});

test('a superseded internal command is discarded while the next queued input still starts', async () => {
  const { c, state, s } = setup();
  const sent: string[] = [];
  c.codex.startTurn = async (_id: string, _ref: any, item: any) => {
    sent.push(item.text);
    return item.text === 'obsolete' ? { started: false, discarded: true } : { started: true };
  };
  state.patch('cx1', { queue: [queueItem({ text: 'obsolete' }), queueItem({ text: 'human input' })] });
  await c.drain('cx1');
  await tick();
  assert.deepEqual(sent, ['obsolete', 'human input']);
  assert.equal(s('cx1').queue.length, 0);
  c.drain = async () => {
    throw new Error('later dispatch failed');
  };
  await c.startOrKeep('cx1', queueItem({ text: 'obsolete' }));
  await tick();
  assert.equal(s('cx1').queue.length, 0, 'an obsolete command is never requeued after a later failure');
});

test('restart ownership is checked before any harness dispatch or pending switch', async () => {
  for (const id of ['cx1', 'cl1', 'acp1']) {
    const { c, state, log, s } = setup({ ids: [id] });
    state.patch(id, { queue: [queueItem({ text: 'obsolete goal', opts: { goalRestart: 'old' } }), queueItem({ text: 'human input' })] });
    await c.drain(id);
    await tick();
    assert.deepEqual(
      log.map((entry: any) => entry[2]),
      ['human input'],
      id,
    );
    assert.equal(s(id).queue.length, 0);
  }
  const { c, state, log, s } = setup({ ids: ['cl1'] });
  c.claudeTurns.goalRestartCurrent = () => true;
  state.patch('cl1', { pendingSwitch: { harness: 'codex' } });
  assert.deepEqual(await c.start('cl1', queueItem({ text: 'obsolete goal', opts: { goalRestart: 'old' } })), {
    started: false,
    discarded: true,
  });
  assert.deepEqual(s('cl1').pendingSwitch, { harness: 'codex' });
  assert.deepEqual(log, []);
  state.patch('cl1', { pendingSwitch: null });
  assert.equal(defined(await c.start('cl1', queueItem({ text: 'current goal', opts: { goalRestart: 'current' } }))).started, true);
  assert.deepEqual(
    log.map((entry: any) => entry[2]),
    ['current goal'],
  );
});

test('superseded goal commands cannot escape through Send now or a late dispatch', async () => {
  for (const id of ['cx1', 'cl1', 'acp1']) {
    const { c, log } = setup({ ids: [id] });
    const item = queueItem({ text: 'obsolete goal', opts: { goalRestart: 'old' } });
    assert.deepEqual(await c.steer(id, item), { started: false, discarded: true });
    assert.deepEqual(await c.dispatch(id, 'turn', item), { started: false, discarded: true });
    assert.deepEqual(log, [], id);
    c.claudeTurns = null;
    assert.deepEqual(await c.start(id, item), { started: false, discarded: true });
  }
});

test('a restart retired during dispatch is not requeued by steering or awaited Send now', async () => {
  for (const turn of ['idle', 'running']) {
    const { c, state, s } = setup({ ids: ['cl1'], result: { started: false, discarded: true } });
    c.claudeTurns.goalRestartCurrent = () => true;
    const item = queueItem({ text: 'obsolete', opts: { goalRestart: 'old' } });
    state.patch('cl1', { turn, queue: [item] });
    const result = await c.sendNow('cl1', item.id, null, { waitForDelivery: true });
    assert.equal(result.status, 'failed');
    assert.equal(s('cl1').queue.length, 0, turn);
  }
});

test('resolved Codex requests suppress late cards and evict only the oldest withdrawal history', () => {
  const { c, state, s } = setup();
  state.patch('cx1', {});
  const resolved = (id: string) => c.onCodexMessage({ method: 'serverRequest/resolved', params: { requestId: id } });
  const approval = (id: string) => c.onCodexMessage({ id, method: 'item/commandExecution/requestApproval', params: { threadId: 'cx1' } });
  resolved('oldest');
  approval('oldest');
  assert.deepEqual(s('cx1').approvals, [], 'withdrawn requests cannot become delayed approval cards');
  for (let i = 0; i < 500; i++) resolved(`recent-${i}`);
  assert.equal(c.resolvedRequests.size, 500);
  assert.equal(c.resolvedRequests.has('oldest'), false);
  assert.equal(c.resolvedRequests.has('recent-499'), true);
  approval('recent-499');
  assert.deepEqual(s('cx1').approvals, [], 'the most recent withdrawal still suppresses its late card');
  approval('oldest');
  assert.equal(s('cx1').approvals.length, 1, 'an id outside the bounded history is usable again');
  assert.equal(s('cx1').approvals[0].id, 'oldest');
});
