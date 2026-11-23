// ACP host turns unit cases with shared fake-agent and transcript fixtures.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { dir, tick, settle, until, KEY, CWD, setup, INIT, NO_REPLY } from './fixture';

export function registerTurnsCases() {
  test('send: one prompt at a time; images only to agents that take them; blocks and display default to nothing; a failed prompt ends the turn', async () => {
    let release!: (v: any) => void;
    const t = setup({
      handlers: {
        'session/prompt': (p: any) => (p.prompt.length ? new Promise((r) => (release = r)) : Promise.reject(new Error('empty prompt'))),
      },
    });
    await t.host.ensure(KEY, { cwd: CWD });
    const { turnId } = await t.host.send(KEY, { blocks: [{ type: 'text', text: 'hi' }] }, { uuid: 'u1', human: 1 });
    assert.equal(turnId, 'at-u1');
    assert.equal(t.events.at(-1).human, true);
    await assert.rejects(t.host.send(KEY, {}), /Fake is still working on the last message/);
    await until(() => release);
    release({});
    await until(() => t.kinds().includes('turnEnd'));
    assert.equal(t.events.at(-1).stopReason, 'end_turn');
    await assert.rejects(t.host.send(KEY, { blocks: [{ type: 'image' }, null] }), /Fake can't take images/);
    const r = await t.host.send(KEY, { blocks: 'x', display: 'y' }, { uuid: '' });
    assert.match(r.turnId, /^at-/);
    await until(() => t.events.filter((e) => e.kind === 'turnEnd').length === 2);
    assert.deepEqual([t.events.at(-1).stopReason, t.events.at(-1).error], ['error', 'empty prompt']);
    const user = (await t.items.readAsync(KEY)).filter((x: any) => x.t === 'user').at(-1);
    assert.deepEqual(user.user.content, []);
    const img = setup({
      handlers: {
        initialize: () => INIT({ promptCapabilities: { image: true } }),
        'session/prompt': () => {
          throw 'refused';
        },
      },
    });
    await img.host.send(KEY, { cwd: CWD, blocks: [{ type: 'image' }] });
    await until(() => img.kinds().includes('turnEnd'));
    assert.equal(img.events.at(-1).error, 'refused');
    // finishing a run that is no longer the chat's does nothing
    img.host.finish(img.host.chats.get(KEY), 'end_turn', null, { turnId: 'old' });
    img.host.finish(img.host.chats.get(KEY), 'end_turn', null);
  });

  test('Stop while the agent is still starting: the prompt never goes', async () => {
    let release: (() => void) | null = null;
    const t = setup({ handlers: { initialize: () => new Promise((r) => (release = () => r(INIT()))) } });
    const sent = t.host.send(KEY, { cwd: CWD, blocks: [{ type: 'text', text: 'delete everything' }] });
    // the agent is asked to initialize (however long its start takes on a busy machine)
    await until(() => release);
    // nothing is running yet, and there is no session to cancel: the Stop is kept for the send
    assert.equal(t.host.cancel(KEY), true);
    release!();
    await assert.rejects(sent, /Stopped before the message was sent/);
    assert.equal(
      t.sp.procs[0].received.some((m: any) => m.method === 'session/prompt'),
      false,
    );
    assert.equal(t.host.starting.size, 0);
    // the next message goes: a Stop is for the send it came during
    await t.host.send(KEY, { cwd: CWD, blocks: [] });
    assert.equal(t.sp.procs[0].received.filter((m: any) => m.method === 'session/prompt').length, 1);
    // a Stop with nothing starting or running changes nothing for a later send
    assert.equal(t.host.cancel('acp:fake:idle'), false);
  });

  test('Stop that the agent ignores: cancelled again, then the turn is ended here as one that did not stop', async () => {
    const t = setup({ handlers: { 'session/prompt': () => NO_REPLY } });
    await t.host.send(KEY, { cwd: CWD, blocks: [] });
    assert.equal(t.host.cancel('acp:fake:none'), false);
    assert.equal(t.host.cancel(KEY), true);
    assert.equal(t.host.cancel(KEY), true);
    await until(() => t.kinds().includes('turnEnd'), 1000);
    const cancels = t.sp.procs[0].notes.filter((n: any) => n.method === 'session/cancel');
    assert.equal(cancels.length, 3);
    assert.equal(t.events.at(-1).stopReason, 'error');
    assert.match(t.events.at(-1).error, /did not stop when asked/);
    // a cancel with no prompt running just notifies
    assert.equal(t.host.cancel(KEY), true);
    // a run that ended before the timers fire leaves them idle (a force timer long enough that a busy machine cannot
    // let it end the run first)
    const u = setup({
      handlers: { 'session/prompt': () => new Promise((r) => setTimeout(() => r({ stopReason: 'cancelled' }), 1)) },
      cancelForceMs: 60_000,
    });
    await u.host.send(KEY, { cwd: CWD, blocks: [] });
    u.host.cancel(KEY);
    await until(() => u.kinds().includes('turnEnd'));
    assert.equal(u.events.at(-1).stopReason, 'cancelled');
    const chat = u.host.chats.get(KEY);
    const run = { turnId: 'r' };
    chat.prompting = run;
    // escalate a run that ends at once: both timers fire within the wait below, and leave the turn alone
    u.host.cancelForceMs = 15;
    u.host.escalate(chat, run);
    chat.prompting = null;
    await tick(25);
    assert.equal(u.events.filter((e) => e.kind === 'turnEnd').length, 1);
  });

  test('permissions: sage tools are allowed without a card; with no prompt running it is unattended; cards answered or cancelled', async () => {
    const t = setup({ handlers: { 'session/prompt': () => NO_REPLY } });
    const chat = await t.host.ensure(KEY, { cwd: CWD, chatId: 'chat' });
    const proc = t.sp.procs[0];
    const sid = chat.sessionId;
    const auto = await proc.request('session/request_permission', {
      sessionId: sid,
      toolCall: { title: 'mcp__sage_0123456789ab__click' },
      options: [{ kind: 'allow_once', optionId: 'yes' }],
    });
    assert.deepEqual(auto.result, { outcome: { outcome: 'selected', optionId: 'yes' } });
    // a sage tool with no allow option falls through; nothing running: cancelled, once a second
    const idle = await proc.request('session/request_permission', { sessionId: sid, toolCall: { title: 'mcp__sage_0123456789ab__click' } });
    assert.deepEqual(idle.result, { outcome: { outcome: 'cancelled' } });
    await proc.request('session/request_permission', { sessionId: sid });
    assert.equal(t.kinds().filter((k) => k === 'unattended').length, 1);
    assert.equal(t.notified.length, 1);
    assert.deepEqual(t.notified[0].slice(0, 2), ['approval', 'chat']);
    await t.host.send(KEY, { blocks: [] });
    const p1 = proc.request('session/request_permission', {
      sessionId: sid,
      toolCall: { title: 'rm' },
      options: [{ kind: 'allow_once', optionId: 'y' }],
    });
    await until(() => t.kinds().includes('permission'));
    const card = t.events.find((e) => e.kind === 'permission');
    assert.equal(t.host.permission('nope', 'y'), false);
    assert.equal(t.host.permission(card.requestId, 'y'), true);
    assert.deepEqual((await p1).result, { outcome: { outcome: 'selected', optionId: 'y' } });
    const p2 = proc.request('session/request_permission', { sessionId: sid, options: 'x' });
    await until(() => t.kinds().filter((k) => k === 'permission').length === 2);
    const card2 = t.events.filter((e) => e.kind === 'permission')[1];
    assert.equal(card2.toolCall, null);
    t.host.permission(card2.requestId, '');
    assert.deepEqual((await p2).result, { outcome: { outcome: 'cancelled' } });
    // another chat's card is left alone when this one cancels
    t.host.perms.set('other', { key: 'acp:fake:other', resolve: () => assert.fail('not cancelled') });
    t.host.cancelPermissions(KEY);
    assert.ok(t.host.perms.has('other'));
  });

  test("what the agent sends: updates for another agent's or no session are dropped; tool calls with nothing running are unattended; extensions run", async () => {
    const quirk = {
      label: 'Fake',
      args: [],
      extensions: {
        'x/plan': (p: any) => ({ update: { sessionUpdate: 'plan', entries: p.entries }, result: { ok: true } }),
        'x/quiet': () => undefined,
        'x/noresult': () => ({ update: null }),
      },
    };
    const t = setup({ quirks: () => quirk });
    const chat = await t.host.ensure(KEY, { cwd: CWD });
    const proc = t.sp.procs[0];
    const sid = chat.sessionId;
    const n0 = t.events.length;
    proc.notify('session/update', { sessionId: 'unknown', update: {} });
    proc.notify('session/update');
    proc.notify('x/plan', { sessionId: 'unknown' });
    proc.notify('x/unknown', { sessionId: sid });
    proc.notify('session/update', { sessionId: sid, update: 'not an object' });
    await settle();
    assert.equal(t.events.length, n0);
    proc.notify('session/update', { sessionId: sid, update: { sessionUpdate: 'tool_call_update' } });
    proc.notify('session/update', { sessionId: sid, update: { sessionUpdate: 'current_mode_update', currentModeId: 7 } });
    proc.notify('x/plan', { sessionId: sid, entries: [1] });
    await until(() => t.events.filter((e) => e.kind === 'update').length === 3);
    assert.ok(t.kinds().includes('unattended'));
    assert.equal((await t.items.readAsync(KEY)).filter((r: any) => r.t === 'mode').length, 0);
    // requests: extensions answer; unknown methods and sessions are refused
    assert.deepEqual((await proc.request('x/plan', { sessionId: sid, entries: [] })).result, { ok: true });
    assert.deepEqual((await proc.request('x/quiet', { sessionId: sid })).result, null);
    assert.deepEqual((await proc.request('x/noresult', { sessionId: sid })).result, null);
    assert.equal((await proc.request('x/unknown', { sessionId: sid })).error.code, -32601);
    assert.equal((await proc.request('fs/read_text_file', { sessionId: 'nope' })).error.code, -32602);
    assert.equal((await proc.request('fs/read_text_file')).error.code, -32602);
    // a quirks file without extensions
    const plain = setup();
    const c2 = await plain.host.ensure(KEY, { cwd: CWD });
    assert.equal(plain.host.extension(c2, 'x/plan', {}), undefined);
    // history replayed on load is not recorded
    c2.loading = true;
    plain.host.record(c2, { sessionUpdate: 'agent_message_chunk' });
    assert.equal((await plain.items.readAsync(KEY)).filter((r: any) => r.t === 'update').length, 0);
  });

  test('fs/* and terminal/* requests from the agent, in the chat folder', async () => {
    const t = setup();
    const chat = await t.host.ensure(KEY, { cwd: dir });
    const proc = t.sp.procs[0];
    const sid = chat.sessionId;
    const f = path.join(dir, 'agent.txt');
    assert.equal((await proc.request('fs/write_text_file', { sessionId: sid, path: f, content: 'x' })).result, null);
    assert.deepEqual((await proc.request('fs/read_text_file', { sessionId: sid, path: f })).result, { content: 'x' });
    const { terminalId } = (await proc.request('terminal/create', { sessionId: sid, command: 'ls' })).result;
    assert.equal(t.pty.spawned[0].opts.cwd, dir);
    t.pty.spawned[0].cb.onData('out');
    assert.equal((await proc.request('terminal/output', { sessionId: sid, terminalId })).result.output, 'out');
    t.pty.spawned[0].cb.onExit({ exitCode: 0 });
    assert.deepEqual((await proc.request('terminal/wait_for_exit', { sessionId: sid, terminalId })).result, { exitCode: 0, signal: null });
    assert.equal((await proc.request('terminal/kill', { sessionId: sid, terminalId })).result, null);
    assert.equal((await proc.request('terminal/release', { sessionId: sid, terminalId })).result, null);
  });

  test('settings changes: mode and config options from the next turn; a chat with no session must send first', async () => {
    const t = setup({
      handlers: {
        'session/set_config_option': (p: any) =>
          p.configId === 'model' ? { configOptions: [{ id: 'model', currentValue: p.value }] } : {},
      },
    });
    await assert.rejects(t.host.setMode(KEY, 'plan'), /Send a message first/);
    await t.host.ensure(KEY, { cwd: CWD });
    await t.host.setMode(KEY, 'plan');
    assert.deepEqual(t.events.at(-1).state, { modes: { availableModes: [], currentModeId: 'plan' } });
    t.host.chats.get(KEY).state.modes = { currentModeId: 'ask', availableModes: [{ id: 'ask' }] };
    await t.host.setMode(KEY, 'ask2');
    assert.equal(t.host.chats.get(KEY).state.modes.currentModeId, 'ask2');
    await t.host.setConfigOption(KEY, 'model', 'b');
    assert.deepEqual(t.events.at(-1).state, { configOptions: [{ id: 'model', currentValue: 'b' }] });
    // an answer without the options: the value it took is patched in and the windows hear it all the same
    await t.host.setConfigOption(KEY, 'level', 'x');
    assert.deepEqual(t.events.at(-1).state, { configOptions: [{ id: 'model', currentValue: 'b' }] });
    t.host.chats.get(KEY).state.configOptions = [
      { id: 'model', currentValue: 'b' },
      { id: 'level', currentValue: 'y' },
    ];
    await t.host.setConfigOption(KEY, 'level', 'x');
    assert.deepEqual(t.events.at(-1).state.configOptions[1], { id: 'level', currentValue: 'x' });
    t.host.chats.get(KEY).state = null;
    await t.host.setConfigOption(KEY, 'level', 'z');
    assert.deepEqual(t.events.at(-1).state, { configOptions: [] });
    assert.deepEqual(
      (await t.items.readAsync(KEY)).filter((r: any) => r.t === 'config').map((r: any) => r.value),
      ['b', 'x', 'x', 'z'],
    );
    // reopened from its transcript after the process went
    const u = setup();
    u.items.append(KEY, { t: 'session', sessionId: 'old', cwd: CWD });
    await u.host.setMode(KEY, 'plan');
    assert.ok(u.host.chats.has(KEY));
  });

  test('the agent process going: its chats close, a running turn ends with the reason, other chats stay', async () => {
    const t = setup({ handlers: { 'session/prompt': () => NO_REPLY }, tools: null });
    await t.host.send(KEY, { cwd: CWD, blocks: [] });
    t.host.chats.set('acp:fake:other', { key: 'acp:fake:other', agent: {} });
    t.host.chats.set('acp:fake:nosession', { key: 'acp:fake:nosession', agent: t.host.chats.get(KEY).agent });
    t.sp.procs[0].exit(9);
    await until(() => t.kinds().includes('closed'));
    const end = t.events.find((e) => e.kind === 'turnEnd');
    assert.equal(end.error, 'Fake exited (9)');
    assert.ok(t.host.chats.has('acp:fake:other'));
    assert.equal(t.host.agents.size, 0);
    // an exit with an error, for an agent already replaced
    const u = setup();
    await u.host.ensure(KEY, { cwd: CWD });
    // a terminal the agent started (a dev server) goes with it, as when the chat closes
    u.host.terminals.create(u.host.chats.get(KEY), { command: 'sh' });
    assert.equal(u.host.terminals.byId.size, 1);
    const agent = u.host.chats.get(KEY).agent;
    u.host.agents.clear();
    u.host.onAgentExit(agent, { error: 'spawn failed' });
    assert.equal(u.events.at(-1).error, 'spawn failed');
    assert.equal(u.host.terminals.byId.size, 0);
    u.host.onAgentExit(agent, { code: null });
  });
}
