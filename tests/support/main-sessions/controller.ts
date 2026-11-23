// Main session controller wiring cases using shared fake timers and main harness.
import { test, assert, calls, ready, delegates } from './fixture.ts';

export function registerController() {
  test('the harness switch runner and controller get their collaborators', async () => {
    const h = await ready({ state: { prefs: { permission: 'auto' } } });
    const sw = h.one('SwitchRunner').opts;
    const ctl = h.one('ChatController');
    const codex = h.one('CodexAdapter');
    const turns = h.one('ClaudeAdapter');
    const chats = h.one('ChatsStore');
    assert.equal(sw.home, h.home);
    assert.equal(sw.prefs().permission, 'auto');
    delegates(sw.ref, ctl.ref, ['c']);
    delegates(sw.invalidate, ctl.invalidate, []);
    delegates(sw.claim, ctl.claim, ['k', 'c']);
    delegates(sw.unclaim, ctl.unclaim, ['k', 'c']);
    chats.get = () => ({ id: 'c' });
    sw.changed('c');
    assert.deepEqual(h.windows[0].webContents.on_('chats:changed'), [[{ id: 'c', chat: { id: 'c' } }]]);
    for (const [name, args] of [
      ['startThread', [{ a: 1 }, { onThread: () => {} }]],
      ['ensureResumed', ['t']],
      ['threadTurns', ['t', 2]],
      ['summarize', ['t', 'p']],
      ['cwdOf', ['t']],
    ] as const)
      delegates(sw.codex[name], codex[name], [...args]);
    for (const [name, args] of [
      ['registerSession', ['k', {}]],
      ['isFresh', ['k']],
      ['cwdOf', [{}]],
      ['accountOf', ['c']],
    ] as const)
      delegates(sw.claude[name], turns[name], [...args]);
    delegates(sw.claude.allTurns, h.claude.allTurns, ['s', { open: true }]);
    delegates(sw.claude.summarize, h.claude.summarize, ['s', '/cwd', 'p', 'bin', 'acct', 'c']);
    assert.equal(sw.permissionParams, h.mod('harness/codex.cjs').permissionParams);
    // the controller
    const o = ctl.opts;
    assert.equal(o.acp, h.one('AcpHost'));
    // one map of Codex sub-agents, shared with the thread tool injection (codexParents.cjs)
    assert.equal(o.parents, h.one('CodexToolInjection').parents);
    delegates(o.killed, h.mod('shared/killSwitch.cjs').killedReason, ['codex', 'c1'], ['codex', h.mod('platform/flags.cjs').isEnabled]);
    // and the chat, for what may hold it (MoMo's main chat at its limit: shared/killSwitch.cjs startHold)
    const [off, held, chat] = h.mod('shared/killSwitch.cjs').startHold.mock.calls.at(-1).arguments;
    assert.deepEqual([off, typeof held, chat], ['r', 'function', 'c1']);
    assert.equal(o.acpPlan('acp:gemini'), 'gemini-plan');
    assert.equal(o.acpPlan('acp:other'), null);
    // a crash aborts the chat's calls as a quit; Stop (onInterrupt) as stopped
    delegates(o.onCrash, h.one('Registry').abortChat, ['c'], ['c', 'quit', undefined]);
    delegates(o.onInterrupt, h.one('Registry').abortChat, ['c'], ['c', 'stopped', undefined]);
    // a segment's Stop (an ACP session that isn't current, or one that worked with no prompt) reaches the Registry with it
    delegates(o.onInterrupt, h.one('Registry').abortChat, ['c', 'seg'], ['c', 'stopped', 'seg']);
    // the crash also retired the turn's (chat, turn) tokens (turnTokens.cjs)
    assert.deepEqual(calls(h.one('Registry').turns.retire).at(-1), ['c']);
    const notifier = h.mod('platform/notify.cjs').registerNotify.mock.calls[0].result;
    delegates(o.notify, notifier.notify, ['k', 'c', {}]);
    delegates(o.retract, notifier.retract, ['c']);
    codex.chatName = () => 'Name';
    assert.equal(o.chatTitle('c'), 'Name');
    codex.chatName = () => '';
    assert.equal(o.chatTitle('c'), null);
    assert.equal(o.labelOf('acp:gemini'), 'Gemini');
    assert.equal(o.labelOf('acp:other'), 'other', 'an agent with no name shows its own id, never the wire form');
    assert.equal(o.labelOf('codex'), 'Codex');
    assert.equal(o.labelOf('claude'), 'Claude Code');
    assert.equal(o.labelOf('mystery'), 'mystery');
    o.onSkipped('c');
    assert.deepEqual(calls(notifier.notify).at(-1), [
      'scheduled',
      'c',
      { title: 'Scheduled run skipped: it needed approval', body: '', chatTitle: undefined },
    ]);
    codex.chatName = () => 'Daily';
    o.onSkipped('c');
    assert.deepEqual(calls(notifier.notify).at(-1)[2], {
      title: 'Scheduled run skipped: it needed approval',
      body: 'Daily',
      chatTitle: 'Daily',
    });
  });

  test('the chat being viewed: only by a focused window that is still open', async () => {
    const h = await ready();
    const viewing = h.one('ChatController').opts.viewing;
    const w = h.windows[0];
    assert.equal(viewing('c'), false);
    await h.invoke('app:viewing', { visible: ['c'], primary: 'c', focused: 'c' });
    assert.deepEqual(calls(h.inst.computerUse[0].onViewed), [['c']]);
    assert.equal(viewing('c'), false, 'not focused');
    w.focused = true;
    assert.equal(viewing('c'), true);
    assert.equal(viewing('d'), false);
    await h.invoke('app:viewing', { visible: [], primary: null, focused: null });
    assert.equal(viewing('c'), false);
    await h.invoke('app:viewing', { visible: ['c'], primary: 'c', focused: 'c' });
    w.close();
    assert.equal(viewing('c'), false);
    // a webContents without a window
    const loose = h.wc();
    await h.invokeFrom(loose, 'app:viewing', { visible: ['c'], primary: 'c', focused: 'c' });
    assert.equal(viewing('c'), false);
    await h.invokeFrom(h.wc({ destroyed: true }), 'app:viewing', { visible: ['c'], primary: 'c', focused: 'c' });
    assert.equal(viewing('c'), false);
  });

  test("a paused chat's deferred card: shown() needs no focus, and focusing a window showing the chat counts as opening it", async () => {
    const h = await ready();
    const cu = h.inst.computerUse[0];
    const shown = cu.opts.shown;
    const w = h.windows[0];
    // focusing a window that shows no chat asks for nothing
    w.emit('focus');
    assert.equal(calls(cu.onViewed).length, 0);
    assert.equal(shown('c'), false);
    await h.invoke('app:viewing', { visible: ['c'], primary: 'c', focused: 'c' });
    assert.equal(shown('c'), true, 'on screen, though the window is not focused');
    assert.equal(shown('d'), false);
    w.emit('focus');
    assert.deepEqual(calls(cu.onViewed), [['c'], ['c']]);
    // a closed window shows nothing
    w.close();
    assert.equal(shown('c'), false);
    await h.invokeFrom(h.wc({ destroyed: true }), 'app:viewing', { visible: ['c'], primary: 'c', focused: 'c' });
    assert.equal(shown('c'), false);
  });

  test('capabilities: what each chat can do, from the live objects', async () => {
    const h = await ready();
    const o = h.one('CapsService').opts;
    const ctl = h.one('ChatController');
    delegates(o.ref, ctl.ref, ['c']);
    delegates(o.record, h.one('ChatsStore').record, ['c']);
    delegates(o.session, h.one('SessionStore').get, ['c']);
    delegates(o.codex, h.one('CodexAdapter').info, []);
    delegates(o.claudeLogin, h.one('ClaudeAdapter').pickedLogin, ['c']);
    const id = h.one('IdentityRegistry');
    id.instances = () => ['i'];
    assert.deepEqual(o.instances('codex'), ['i']);
    id.instances = () => undefined;
    assert.deepEqual(o.instances('codex'), []);
    id.driver = () => ({ lane: 'lane' });
    assert.equal(o.accounts('codex'), 'lane');
    id.driver = () => null;
    assert.equal(o.accounts('codex'), null);
    assert.deepEqual(await o.modelCaps(), { m: 1 });
    // the quirks as described, plan marker and permission map both (#1875)
    assert.deepEqual(o.acpQuirks('acp:gemini'), { plan: 'gemini-plan', label: 'Gemini' });
    assert.equal(o.acpQuirks('acp:x'), null);
    calls(h.claude.setProbeListener)[0][0]();
    assert.equal(h.windows[0].webContents.on_('session:capsChanged').length, 1);
  });
}
