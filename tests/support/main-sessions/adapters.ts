// Main session adapters wiring cases using shared fake timers and main harness.
import { test, mock, assert, fs, path, calls, ready, delegates } from './fixture.ts';

export function registerCodexAdapter() {
  test('the Codex adapter: options and callbacks go to the controller, state and windows', async () => {
    const h = await ready({ state: { prefs: { model: 'gpt', effort: 'high' } } });
    const codex = h.one('CodexAdapter');
    const ctl = h.one('ChatController');
    const o = codex.opts;
    assert.equal(o.server, h.one('AppServer'));
    assert.equal(o.state, h.one('SessionStore'));
    assert.deepEqual(o.clientInfo, { name: 'sage_codex_desktop', title: 'MoPilot', version: '1.2.3' });
    assert.equal(o.tools, h.one('CodexToolInjection'), 'the thread tool injection, made at startup');
    assert.deepEqual(o.prefs(), { model: 'gpt', effort: 'high', permission: 'default', serviceTier: null, branchPrefix: 'mopilot/' });
    h.writeState({});
    assert.deepEqual(
      o.prefs(),
      { model: null, effort: null, permission: 'default', serviceTier: null, branchPrefix: 'mopilot/' },
      'defaults',
    );
    delegates(o.nativeOf, ctl.ref, ['c']);
    delegates(o.chatOf, ctl.chatOf, ['t']);
    // the chat's own model, effort and tier from its record, and a turn's kept where it has none (adapterSettings)
    const store = h.one('ChatsStore');
    store.records = new Map([['c', { meta: { config: { c: 1 } } }]]);
    store.patchMeta = mock.fn(() => true);
    assert.deepEqual(o.chatConfig('c'), { c: 1 });
    assert.equal(o.chatConfig('gone'), null);
    assert.equal(o.keepSelection('c', { effort: 'low' }), true);
    assert.deepEqual(calls(store.patchMeta).at(-1), ['c', { config: { c: 1, effort: 'low' } }]);
    // the adapter reads the thread provider and a key still being stored from the providers themselves (#2201)
    assert.equal(o.providers, h.one('CodexProviders'));
    delegates(o.observe, ctl.onCodexMessage, [{ m: 1 }]);
    // Codex Computer Use programs hold the desktop lock from the same messages; an exit lets go of them
    assert.deepEqual(calls(h.inst.computerUse[0].nativeHolds.observe).at(-1), [{ m: 1 }]);
    delegates(o.onExit, ctl.onCodexExit, []);
    assert.equal(h.inst.computerUse[0].nativeHolds.clear.mock.callCount(), 1);
    // a problem Codex Computer Use reports reaches the native-control status (Settings → Computer use)
    delegates(o.onSkyProblem, h.one('NativeAvailability').noteSkyProblem, [{ kind: 'versionMismatch', message: 'm' }]);
    // a Stop that reset the plugin's JS kernel: the desktop lock forgets the apps it had bound
    o.onNativeReset('t');
    assert.deepEqual(calls(h.inst.computerUse[0].nativeHolds.reset), [['t']]);
    const w = h.windows[0];
    o.onStatus({ kind: 'crashed' });
    o.onFirstStart();
    assert.deepEqual(w.webContents.on_('codex:status'), [[{ kind: 'crashed' }], [{ kind: 'started' }]]);
    assert.equal(w.webContents.on_('session:capsChanged').length, 1);
    // goals kept across runs, read once
    const goals = o.goalStore;
    assert.deepEqual(goals.read(), {});
    goals.write({ t: { objective: 'x' } });
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(h.userData, 'codex-goals.json'), 'utf8')), { t: { objective: 'x' } });
    assert.deepEqual(goals.read(), { t: { objective: 'x' } });
    // idle threads are released every 2s
    mock.timers.tick(2000);
    assert.equal(codex.releaseIdle.mock.callCount(), 1);
    // session publish goes to windows and computer use
    // the session store reads a chat's goal from the Codex adapter's own record first (#2759)
    codex.ownGoalStatus = mock.fn((id: string) => (id === 'c' ? 'paused' : undefined));
    assert.equal(h.one('SessionStore').opts.ownGoal('c'), 'paused');
    assert.equal(h.one('SessionStore').opts.ownGoal('other'), undefined);
    const pub = h.one('SessionStore').opts.publish;
    const patch = { chatId: 'c', rev: 1, patch: { plan: true } };
    pub(patch);
    assert.deepEqual(w.webContents.on_('session:patch'), [[patch]]);
    assert.deepEqual(calls(h.inst.computerUse[0].onSessionPatch), [[patch]]);
    assert.equal(h.one('ExternalWrites').opts.state, h.one('SessionStore'));
    const source = { kind: 'codex', key: 'native' };
    const controller = h.one('ChatController');
    controller.isCurrentSource.mock.mockImplementation(() => true);
    assert.equal(h.one('ExternalWrites').opts.isCurrent('chat', source), true);
    assert.deepEqual(calls(controller.isCurrentSource), [['chat', source]]);
  });
}

export function registerHarnessAdapters() {
  test('a Codex goals file that is empty reads as no goals', async () => {
    const h = await ready();
    fs.writeFileSync(path.join(h.userData, 'codex-goals.json'), 'null');
    assert.deepEqual(h.one('CodexAdapter').opts.goalStore.read(), {});
  });

  test('the Claude adapter: turns go through the controller; goals, moves and limits are kept', async () => {
    const h = await ready();
    const o = h.one('ClaudeAdapter').opts;
    const ctl = h.one('ChatController');
    const sessions = h.one('SessionStore');
    const chats = h.one('ChatsStore');
    const codex = h.one('CodexAdapter');
    assert.equal(o.api, h.claude.turnApi);
    delegates(o.probeInfo, h.claude.probeInfo, ['acct']);
    delegates(o.send, ctl.claudeSend, ['c', 'k', {}, 'in', 1, { m: 1 }]);
    delegates(o.enqueue, ctl.send, ['c', { i: 1 }], ['c', { i: 1 }, null]);
    delegates(o.interrupted, ctl.onClaudeControl, ['k'], ['k', 'interrupt']);
    delegates(o.chatOf, ctl.chatOf, ['k']);
    delegates(o.ref, ctl.ref, ['c']);
    // a goal: annotated, patched, and kept in the chat's file when Claude holds it
    ctl.ref = () => ({ kind: 'claude' });
    sessions.patch = mock.fn(() => true);
    sessions.get = () => ({ goal: { g: 1 } });
    chats.patchMeta = mock.fn();
    codex.annotateGoal = (_c: string, g: any) => ({ ...g, note: 1 });
    assert.equal(o.setGoal('c', { g: 1 }), true);
    assert.deepEqual(calls(sessions.patch), [['c', { goal: { g: 1, note: 1 } }]]);
    assert.deepEqual(calls(chats.patchMeta), [['c', { goalHeld: { held: { g: 1 } } }]]);
    ctl.ref = () => ({ kind: 'codex' });
    o.setGoal('c', null);
    ctl.ref = () => ({ kind: 'acp:kimi' });
    o.setGoal('c', null);
    assert.equal(chats.patchMeta.mock.callCount(), 1, 'only Claude goals are held');
    ctl.ref = () => {
      throw new Error('unknown chat');
    };
    o.setGoal('c', null);
    // a chat that moved to another login
    chats.record = () => ({ meta: { notes: ['a'] } });
    o.moved('c', { account: 'acct2', note: 'b' });
    assert.deepEqual(calls(chats.patchMeta).at(-1), ['c', { account: { id: 'acct2', pinned: false }, notes: ['a', 'b'] }]);
    chats.record = () => ({ meta: {} });
    o.moved('c', { account: 'acct3', note: 'c' });
    assert.deepEqual(calls(chats.patchMeta).at(-1)[1].notes, ['c']);
    // the login the file keeps, for a chat no window has pushed since a restart
    chats.records = new Map([
      ['c', { meta: { account: { id: 'acct3', pinned: false } } }],
      ['bare', { meta: {} }],
      ['momo', { meta: { momo: 'main', momoModel: 'haiku' } }],
    ]);
    assert.deepEqual([o.savedAccount('c'), o.savedAccount('bare'), o.savedAccount('gone')], ['acct3', null, null]);
    // the model a MoMo chat's brain names, from its file (#2304)
    assert.deepEqual([o.pinnedModel('momo'), o.pinnedModel('c'), o.pinnedModel('gone')], ['haiku', null, null]);
    // limits and goal notices
    const notifier = h.mod('platform/notify.cjs').registerNotify.mock.calls[0].result;
    // a chat with nowhere to move at its limit is told to the controller, whose hook main's limit continuation joins
    ctl.onLimit = mock.fn();
    o.limitHit('c');
    assert.deepEqual(calls(ctl.onLimit), [['c']]);
    o.notifyLimit('c', 'expired');
    o.notifyLimit('c', 'limited');
    assert.deepEqual(
      calls(notifier.notify).map((c: any) => c[2].body),
      ['Sign in again to continue', 'Usage limit reached · Switch account to continue'],
    );
    o.notifyGoal('c', { status: 'done', body: 'Goal met' });
    assert.deepEqual(h.windows[0].webContents.on_('claude:event').at(-1), [
      { kind: 'goalNotice', chatId: 'c', status: 'done', body: 'Goal met' },
    ]);
    assert.equal(notifier.notify.mock.callCount(), 2, 'a window took it');
    h.windows[0].close();
    o.notifyGoal('c', { status: 'done', body: 'Goal met' });
    assert.deepEqual(calls(notifier.notify).at(-1), ['goal', 'c', { title: 'Claude Code', body: 'Goal met', status: 'done' }]);
  });

  test('ACP turns: sends, titles, and images read as data URLs', async () => {
    const h = await ready();
    const o = h.one('AcpTurns').opts;
    delegates(o.send, h.one('ChatController').acpSend, ['c', 'k', { p: 1 }, { m: 1 }]);
    // `auto`: a title MoPilot wrote, which a later generated title may replace (#2150)
    delegates(o.rename, h.one('AcpHost').rename, ['k', 'n', true]);
    delegates(o.writeTitle, h.one('AcpHost').titleFor, ['k', 'fix it'], ['k', 'fix it', 30_000]);
    // the turn check a Stop during an image read is seen through
    delegates(o.turnCheck, h.one('ChatController').turnCheck, ['c']);
    const host = h.one('AcpHost');
    host.history = async () => [{ t: 'msg' }];
    assert.equal(await o.named('k'), false);
    host.history = async () => [{ t: 'title' }];
    assert.equal(await o.named('k'), true);
    delegates(o.titleOf, h.one('AcpHost').titleOf, ['k']);
    const img = path.join(h.tmp, 'a.JPG');
    fs.writeFileSync(img, 'hi');
    assert.equal(await o.readImage(img), 'data:image/jpeg;base64,aGk=');
    assert.equal(await o.readImage(path.join(h.tmp, 'missing.png')), null);
  });
}
