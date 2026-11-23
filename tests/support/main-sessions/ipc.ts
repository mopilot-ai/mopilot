// Main session ipc wiring cases using shared fake timers and main harness.
import { test, mock, assert, fs, path, calls, ready } from './fixture.ts';

export function registerIpc() {
  test('codex IPC: start, used, restart, and adapter calls that return errors as values', async () => {
    const h = await ready();
    const server = h.one('AppServer');
    const codex = h.one('CodexAdapter');
    const ctl = h.one('ChatController');
    assert.deepEqual(await h.invoke('codex:start'), { bin: 'codex', status: 'idle' });
    assert.equal(server.start.mock.callCount(), 1);
    assert.equal(await h.invoke('codex:restart'), true);
    assert.deepEqual([server.stop.mock.callCount(), server.start.mock.callCount()], [1, 2]);
    assert.equal(await h.invoke('codex:used'), false);
    fs.mkdirSync(path.join(h.home, '.codex'));
    assert.equal(await h.invoke('codex:used'), false, 'empty');
    fs.writeFileSync(path.join(h.home, '.codex', 'config.toml'), '');
    assert.equal(await h.invoke('codex:used'), true);
    h.mod('platform/env.cjs').childEnv.mock.mockImplementation(() => ({ CODEX_HOME: path.join(h.tmp, 'nope') }));
    assert.equal(await h.invoke('codex:used'), false);
    codex.connect = async () => ({ ok: 1 });
    assert.deepEqual(await h.invoke('codex:connect'), { value: { ok: 1 } });
    codex.request = mock.fn(async () => {
      throw Object.assign(new Error('bad'), { code: 'E1' });
    });
    assert.deepEqual(await h.invoke('codex:request', 7, undefined), { error: { message: 'bad', code: 'E1' } });
    assert.deepEqual(calls(codex.request), [['7', {}]]);
    await h.invoke('codex:request', 'm', { p: 1 });
    assert.deepEqual(calls(codex.request).at(-1), ['m', { p: 1 }]);
    codex.api = mock.fn(async () => {
      throw 'plain';
    });
    assert.deepEqual(await h.invoke('codex:api', 'x', [1]), { error: { message: 'plain', code: null } });
    ctl.onCodexOutgoing = () => false;
    // retired (another window answered first, or the card came from an app-server that has since restarted): the
    // window hears false, and nothing reaches the app-server
    assert.deepEqual(await h.invoke('codex:respond', 1, 'ok'), { value: false });
    assert.equal(codex.respond.mock.callCount(), 0, 'another window answered first');
    ctl.onCodexOutgoing = () => true;
    assert.deepEqual(await h.invoke('codex:respond', 1, 'ok'), { value: true });
    assert.deepEqual(calls(codex.respond), [[1, 'ok']]);
    codex.leaseList = () => ['l'];
    assert.deepEqual(await h.invoke('codex:leases'), { value: ['l'] });
    codex.negotiation = () => 'n';
    assert.deepEqual(await h.invoke('codex:negotiated'), { value: 'n' });
    assert.deepEqual(await h.invoke('codex:resume', 5), { value: { ok: true } });
    codex.ensureResumed = async () => {
      throw Object.assign(new Error('held'), { code: 'locked' });
    };
    assert.deepEqual(await h.invoke('codex:resume', 't'), { value: { locked: true } });
    codex.ensureResumed = async () => {
      throw new Error('gone');
    };
    assert.deepEqual(await h.invoke('codex:resume', 't'), { error: { message: 'gone', code: null } });
    codex.ensureResumed = async () => {
      throw null;
    };
    assert.deepEqual(await h.invoke('codex:resume', 't'), { error: { message: 'null', code: null } });
    await h.invoke('codex:pinLease', 1, 1);
    assert.deepEqual(calls(codex.pin), [['1', true]]);
    await h.invoke('codex:leased', 1, 2, null);
    await h.invoke('codex:leased', 'c', 'm', { a: 1 });
    assert.deepEqual(calls(codex.leased), [
      ['1', '2', {}],
      ['c', 'm', { a: 1 }],
    ]);
    // deleting a thread is ChatDeletion's (chats:delete): a window can't send it on either channel
    const refused = { error: { message: "A window can't send thread/delete; deleting the chat deletes its thread", code: null } };
    assert.deepEqual(await h.invoke('codex:request', 'thread/delete', { threadId: 't' }), refused);
    assert.deepEqual(await h.invoke('codex:leased', 'c', 'thread/delete', {}), refused);
    // a goal change other than a pause, or a review, runs on the thread's own settings: only codex:leased applies the chat's permission first
    for (const [method, params] of [
      ['thread/goal/set', { threadId: 't', status: 'active' }],
      ['review/start', { threadId: 't' }],
      ['thread/goal/set', { threadId: 't', tokenBudget: 5 }],
    ] as const)
      assert.deepEqual(await h.invoke('codex:request', method, params), {
        error: { message: `A window sends ${method} through codex:leased, which applies the chat's permission`, code: null },
      });
    // a pause carries nothing on, so a window may still send it raw
    await h.invoke('codex:request', 'thread/goal/set', { threadId: 't', status: 'paused' });
    assert.equal(calls(codex.request).length, 3);
    assert.equal(calls(codex.leased).length, 2);
    await h.invoke('codex:startThread', 'nope');
    assert.deepEqual(calls(codex.startThread), [[{}]]);
    await h.invoke('codex:fork', { p: 1 }, 0);
    assert.deepEqual(calls(codex.fork), [[{ p: 1 }, false]]);
  });

  test('session IPC: snapshots restore a held Claude goal, patches keep it', async () => {
    const h = await ready();
    const sessions = h.one('SessionStore');
    const ctl = h.one('ChatController');
    const chats = h.one('ChatsStore');
    assert.equal(await h.invoke('session:snapshot', ''), null);
    assert.equal(await h.invoke('session:snapshot', 5), null);
    sessions.get = () => ({ goal: null, approvals: [] });
    sessions.snapshot = (id: string) => ({ snap: id });
    chats.record = () => ({ meta: { goalHeld: { g: 1 } } });
    ctl.ref = () => ({ kind: 'claude' });
    sessions.patch = mock.fn();
    assert.deepEqual(await h.invoke('session:snapshot', 'c'), { snap: 'c' });
    assert.deepEqual(calls(sessions.patch), [['c', { goal: { restored: { g: 1 }, id: 'c' } }]]);
    // only a harness whose goal MoPilot holds gets one back: Codex keeps its own, a basic harness has none
    ctl.ref = () => ({ kind: 'codex' });
    await h.invoke('session:snapshot', 'c');
    ctl.ref = () => ({ kind: 'acp:kimi' });
    await h.invoke('session:snapshot', 'c');
    chats.record = () => ({ meta: {} });
    await h.invoke('session:snapshot', 'c');
    chats.record = () => {
      throw new Error('no record');
    };
    await h.invoke('session:snapshot', 'c');
    sessions.get = () => ({ goal: { g: 2 }, approvals: [1] });
    await h.invoke('session:snapshot', 'c');
    assert.equal(sessions.patch.mock.callCount(), 1);
    // chats waiting on a card
    sessions.all = () => ['a', 'b'];
    sessions.get = (id: string) => ({ approvals: id === 'a' ? [1] : [] });
    assert.deepEqual(await h.invoke('session:withApprovals'), ['a']);
    // a window's patch: a goal is annotated and held
    sessions.clientPatch = mock.fn(() => 'changed');
    h.one('CodexAdapter').annotateGoal = (_c: string, g: any) => ({ ...g, a: 1 });
    ctl.ref = () => ({ kind: 'claude' });
    sessions.get = () => ({ goal: { g: 3 } });
    chats.patchMeta = mock.fn();
    assert.equal(await h.invoke('session:patch', 'c', { goal: { g: 3 } }), 'changed');
    assert.deepEqual(calls(sessions.clientPatch)[0], ['c', { goal: { g: 3, a: 1 } }]);
    assert.equal(chats.patchMeta.mock.callCount(), 1);
    await h.invoke('session:patch', 'c', { draft: 'x' });
    await h.invoke('session:patch', 'c', null);
    await h.invoke('session:patch', 'c', 'str');
    assert.deepEqual(calls(sessions.clientPatch).slice(1), [
      ['c', { draft: 'x' }],
      ['c', null],
      ['c', 'str'],
    ]);
    assert.equal(chats.patchMeta.mock.callCount(), 1);
    // a MoMo chat never turns plan mode on or sets a goal (shared/momoCommands.mjs), though either may be cleared
    h.one('ChatsStore').records.set('m', { meta: { momo: 'main' } });
    await h.invoke('session:patch', 'm', { plan: true, goal: { g: 4 }, draft: 'y' });
    await h.invoke('session:patch', 'm', { plan: false, goal: null });
    // nor a window's permission or harness switch, set or cleared: only MoMo's brain change sets those, in main
    const ps = { harness: 'codex', model: 'm', modelLabel: 'M', mode: 'auto' };
    await h.invoke('session:patch', 'm', { permission: 'full-access', pendingSwitch: ps, modality: 'voice' });
    await h.invoke('session:patch', 'm', { pendingSwitch: null, permission: null });
    // a coding chat's window still sets both
    await h.invoke('session:patch', 'c', { permission: 'full-access', pendingSwitch: ps });
    assert.deepEqual(calls(sessions.clientPatch).slice(4), [
      ['m', { draft: 'y' }],
      ['m', { plan: false, goal: { a: 1 } }],
      ['m', { modality: 'voice' }],
      ['m', {}],
      ['c', { permission: 'full-access', pendingSwitch: ps }],
    ]);
  });

  test('session IPC: caps hints are cleaned; sends, queue and Claude/ACP calls reach the controller', async () => {
    // what a harness's page reads is electron/session/harnessCaps.cjs's (tests/harnessCaps.test.ts): here, what reaches it
    const harnessCaps = mock.fn(async (_service: any, kind: string, _admission?: any, _health?: any) => ({ kind, works: {} }));
    const h = await ready({ before: (x: any) => (x.mods['electron/session/harnessCaps.cjs'] = { harnessCaps }) });
    const caps = h.one('CapsService');
    const ctl = h.one('ChatController');
    const turns = h.one('ClaudeAdapter');
    const acpTurns = h.one('AcpTurns');
    caps.get = mock.fn(async () => 'caps');
    assert.equal(await h.invoke('session:caps', 'c', { kind: 'codex', model: 'm', temporary: true, elsewhere: 1 }), 'caps');
    await h.invoke('session:caps', '', 'junk');
    await h.invoke('session:caps', 5, { kind: 1, model: 2 });
    assert.deepEqual(calls(caps.get), [
      ['c', { kind: 'codex', model: 'm', temporary: true, elsewhere: false }],
      [null, { kind: undefined, model: undefined, temporary: false, elsewhere: false }],
      [null, { kind: undefined, model: undefined, temporary: false, elsewhere: false }],
    ]);
    // a harness's page: what a new chat on it gets once its session opens, from the caps, admission and health
    assert.deepEqual(await h.invoke('session:harnessCaps', 'acp:opencode'), { kind: 'acp:opencode', works: {} });
    const [service, kind, admission, health] = harnessCaps.mock.calls[0].arguments;
    assert.deepEqual([service, kind], [caps, 'acp:opencode']);
    // the basic harnesses' admission and the capability-health record main holds
    assert.equal(admission, h.one('Admission'));
    assert.equal(health?.constructor.name, 'CapabilityHealth');
    assert.equal(await h.invoke('session:harnessCaps', ''), null);
    assert.equal(await h.invoke('session:harnessCaps', 7), null);
    assert.equal(harnessCaps.mock.callCount(), 1, 'no kind: nothing is read');
    harnessCaps.mock.mockImplementationOnce(async () => {
      throw new Error('x');
    });
    assert.equal(await h.invoke('session:harnessCaps', 'claude'), null, 'a failed read is unknown');
    caps.get = async () => {
      throw new Error('x');
    };
    assert.equal(await h.invoke('session:caps', 'c'), null);
    const w = h.windows[0];
    h.one('ChatsStore').records.set('c', {});
    const receipt = { action: 'started', id: 'r1' };
    ctl.send = mock.fn(async () => receipt);
    assert.deepEqual(await h.invokeFrom(w.webContents, 'session:send', 'c', { t: 1 }), receipt);
    assert.deepEqual(calls(ctl.send), [['c', { t: 1 }, w.webContents.id, true]]);
    ctl.removeQueued = mock.fn(() => 1);
    assert.equal(await h.invoke('session:removeQueued', 'c', 'q'), true);
    ctl.removeQueued = mock.fn(() => 0);
    assert.equal(await h.invoke('session:removeQueued', 'c', 'q'), false);
    await h.invokeFrom(w.webContents, 'session:sendNow', 'c', 'q');
    assert.deepEqual(calls(ctl.sendNow), [['c', 'q', w.webContents.id, true]]);
    await h.invoke('session:claudeNew', 1, null);
    await h.invoke('session:claudeNew', 'k', { a: 1 });
    assert.deepEqual(calls(turns.registerSession), [
      ['1', {}],
      ['k', { a: 1 }],
    ]);
    await h.invoke('session:claudeOwn', 1, { o: 1 });
    assert.deepEqual(calls(turns.setOwn), [['1', { o: 1 }]]);
    await h.invoke('session:claudeHandover', 1, 1);
    assert.deepEqual(calls(turns.setHandover), [['1', true]]);
    await h.invoke('session:claudeGoal', 1, 2, 0);
    assert.deepEqual(calls(turns.goalAction), [['1', '2', false]]);
    // a Stop for the turn a button showed: main stops only while that turn runs, else answers 'retired' (#1866)
    ctl.turnIs = mock.fn((_chat: string, turnId?: string) => turnId !== 'old');
    ctl.ref = () => ({ kind: 'claude' });
    h.one('ChatsStore').records.set('1', {});
    await h.invoke('session:claudeStop', 1);
    assert.deepEqual(calls(turns.stop), [['1']]);
    assert.equal(await h.invoke('session:claudeStop', 1, 'old'), 'retired');
    assert.deepEqual(calls(turns.stop), [['1']]);
    assert.deepEqual(calls(ctl.turnIs).at(-1), ['1', 'old']);
    await h.invoke('session:acpNew', 1, 'x');
    await h.invoke('session:acpNew', 'k', { b: 1 });
    assert.deepEqual(calls(acpTurns.registerSession), [
      ['1', {}],
      ['k', { b: 1 }],
    ]);
    await h.invoke('session:acpCancel', 1);
    await h.invoke('session:acpCancel', 'k', 't1');
    assert.deepEqual(calls(ctl.acpCancel), [
      ['1', undefined],
      ['k', 't1'],
    ]);
    const sw = h.one('SwitchRunner');
    sw.summaryNote = mock.fn(async () => 'summary');
    assert.deepEqual(await h.invoke('session:handoffNote', 1, 2), { text: 'summary' });
    assert.deepEqual(calls(sw.summaryNote), [['1', '2']]);
    sw.summaryNote = async () => {
      throw new Error('no harness');
    };
    assert.deepEqual(await h.invoke('session:handoffNote', 'c', 'B'), { error: 'no harness' });
    sw.summaryNote = async () => {
      throw 'raw';
    };
    assert.deepEqual(await h.invoke('session:handoffNote', 'c', 'B'), { error: 'raw' });
    // a registered window is forgotten when it goes away
    h.emitIpc('session:ready', w.webContents);
    w.webContents.emit('destroyed');
    h.one('CodexAdapter').opts.emit({ k: 1 }, w.webContents.id);
    assert.deepEqual(w.webContents.on_('codex:item').at(-1), [{ k: 1, mine: true }], 'falls back to the first window');
  });
}
