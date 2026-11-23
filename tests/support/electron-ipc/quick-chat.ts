// Electron IPC quick-chat unit cases with the shared fake main harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { flush, calls, ready } from './fixture';

export function registerQuickChatCases() {
  test('Quick Chat IPC: only the Quick Chat window may use it, for the chat it owns', async () => {
    const h = await ready();
    const chats = h.one('ChatsStore');
    chats.get = (id: string) => (id === 'q1' ? { id } : null);
    const main = h.windows[0];
    await assert.rejects(
      Promise.resolve().then(() => h.invoke('quick-chat:read')),
      /Invalid Quick Chat sender/,
    );
    assert.deepEqual(await h.invoke('quick-chat:open', 'q1'), { ok: false, error: 'Invalid Quick Chat sender' });
    await h.invoke('window:mini');
    const mini = h.windows[1];
    const from = (ch: string, ...a: any[]) => h.invokeFrom(mini.webContents, ch, ...a);
    assert.deepEqual(await from('quick-chat:read'), { threadId: null, text: '' });
    await from('quick-chat:save', { threadId: null, text: 'typing' });
    assert.deepEqual(mini.webContents.on_('peer:changed'), [], 'a draft alone does not change the chat it speaks for');
    await from('quick-chat:save', { threadId: 'q1', text: 'draft' });
    assert.deepEqual(await from('quick-chat:read'), { threadId: 'q1', text: 'draft' });
    // the chat it owns changed, so its messages view asks main again
    assert.deepEqual(mini.webContents.on_('peer:changed'), [[]]);
    await from('quick-chat:save', { threadId: 'q1', text: 'draft 2' });
    assert.equal(mini.webContents.on_('peer:changed').length, 1);
    assert.deepEqual(await from('quick-chat:open', 'other'), { ok: false, error: 'This chat is no longer available' });
    // the main window has to say it is ready first
    const opening = from('quick-chat:open', 'q1');
    h.emitIpc('window:ready', h.wc());
    h.emitIpc('window:ready', main.webContents);
    assert.deepEqual(await opening, { ok: true });
    assert.deepEqual(main.webContents.on_('app:command'), [['open-chat', 'q1']]);
    assert.equal(mini.visible, false);
    assert.deepEqual(await from('quick-chat:settings', 'voice'), { ok: true });
    assert.deepEqual(await from('quick-chat:settings', 5), { ok: true });
    assert.deepEqual(main.webContents.on_('app:command').slice(1), [
      ['settings', 'voice'],
      ['settings', undefined],
    ]);
    assert.deepEqual(await h.invoke('quick-chat:settings'), { ok: false, error: 'Invalid Quick Chat sender' });
    // a reload makes the window wait again; closing it while waiting fails the request
    main.webContents.emit('did-start-loading');
    const waiting = from('quick-chat:settings');
    await flush();
    h.emitIpc('window:ready', main.webContents);
    main.close();
    assert.deepEqual(await waiting, { ok: false, error: 'The app window was closed' });
    const late = from('quick-chat:open', 'q1');
    await flush();
    mock.timers.tick(30_000);
    assert.deepEqual(await late, { ok: false, error: 'The app is still starting. Try again.' });
    // a failure that is not an Error is reported as text
    const w = h.windows.find((x: any) => !x.destroyed && x !== mini);
    h.emitIpc('window:ready', w.webContents);
    w.webContents.send = () => {
      throw 'send failed';
    };
    assert.deepEqual(await from('quick-chat:open', 'q1'), { ok: false, error: 'send failed' });
    assert.deepEqual(await from('quick-chat:settings'), { ok: false, error: 'send failed' });
    // a closed Quick Chat window is no sender either
    mini.close();
    assert.deepEqual(await from('quick-chat:open', 'q1'), { ok: false, error: 'Invalid Quick Chat sender' });
  });

  for (const channel of ['quick-chat:open', 'quick-chat:settings', 'session:send']) {
    test(`${channel}: a replaced Quick Chat cannot act after waiting for the main window`, async () => {
      const h = await ready();
      h.one('ChatsStore').get = (id: string) => (id === 'q1' ? { id } : null);
      const controller = h.one('ChatController');
      controller.send = mock.fn(() => 'sent');
      const main = h.windows[0];
      await h.invoke('window:mini');
      const mini = h.windows[1];
      mini.emit('ready-to-show');
      await h.invokeFrom(mini.webContents, 'quick-chat:save', { threadId: 'q1', text: 'draft' });
      const pending = h.invokeFrom(mini.webContents, channel, 'q1', { id: 'pending', text: 'hi' }).then(
        (value: any) => ({ value }),
        (error: Error) => ({ error: error.message }),
      );
      await flush();
      mini.close();
      await h.invoke('window:mini');
      const replacement = h.windows[2];
      replacement.emit('ready-to-show');
      h.emitIpc('window:ready', main.webContents);
      const result = await pending;
      assert.deepEqual(
        result,
        channel === 'session:send' ? { error: 'Invalid Quick Chat sender' } : { value: { ok: false, error: 'Invalid Quick Chat sender' } },
      );
      assert.deepEqual(main.webContents.on_('app:command'), []);
      assert.equal(controller.send.mock.callCount(), 0);
      assert.equal(replacement.visible, true);
    });
  }

  test('Quick Chat open rechecks its owned chat after waiting for the main window', async () => {
    const h = await ready();
    h.one('ChatsStore').get = (id: string) => (['q1', 'q2'].includes(id) ? { id } : null);
    const main = h.windows[0];
    await h.invoke('window:mini');
    const mini = h.windows[1];
    mini.emit('ready-to-show');
    const from = (channel: string, ...args: any[]) => h.invokeFrom(mini.webContents, channel, ...args);
    await from('quick-chat:save', { threadId: 'q1', text: '' });
    const pending = from('quick-chat:open', 'q1');
    await flush();
    await from('quick-chat:save', { threadId: 'q2', text: 'new draft' });
    h.emitIpc('window:ready', main.webContents);
    assert.deepEqual(await pending, { ok: false, error: 'This chat is no longer available' });
    assert.deepEqual(main.webContents.on_('app:command'), []);
    assert.equal(mini.visible, true);
  });

  test('Quick Chat accepts a new chat on any harness, and the other windows list a Claude Code chat it starts', async () => {
    const h = await ready();
    h.one('ChatsStore').get = (id: string) => (id === 'codex-1' ? { id } : null);
    const turns = h.one('ClaudeAdapter');
    turns.sessions.set('claude-new', {});
    h.one('AcpTurns').sessions.set('acp:goose:new', {});
    h.one('AcpHost').chats.set('acp:goose:live', {});
    const main = h.windows[0];
    // a Claude Code chat a main window starts is that window's own
    turns.registerSession = mock.fn(() => true);
    assert.equal(await h.invokeFrom(main.webContents, 'session:claudeNew', 'claude-main', { cwd: '/p' }), true);
    await h.invoke('window:mini');
    const mini = h.windows[1];
    const from = (ch: string, ...a: any[]) => h.invokeFrom(mini.webContents, ch, ...a);
    // a saved record, or (before anything is saved) the adapter's session for a new Claude Code or ACP chat
    for (const id of ['codex-1', 'claude-new', 'acp:goose:new', 'acp:goose:live']) {
      await from('quick-chat:save', { threadId: id, text: '' });
      assert.deepEqual(await from('quick-chat:read'), { threadId: id, text: '' });
    }
    await assert.rejects(
      Promise.resolve().then(() => from('quick-chat:save', { threadId: 'missing', text: '' })),
      /Invalid Quick Chat state/,
    );
    assert.deepEqual(main.webContents.on_('claude:event'), []);
    // Quick Chat starts one: every window lists it, as for a chat a scheduled run made
    assert.equal(await from('session:claudeNew', 'claude-quick', { cwd: '/q' }), true);
    assert.deepEqual(main.webContents.on_('claude:event'), [
      [{ kind: 'chatStarted', key: 'claude-quick', chatId: 'claude-quick', cwd: '/q', worktreeOf: null }],
    ]);
    // a temporary chat stays out of the list, and so does a session the adapter did not take
    await from('session:claudeNew', 'claude-temp', { cwd: '/q', ephemeral: true });
    turns.registerSession = mock.fn(() => false);
    assert.equal(await from('session:claudeNew', 'claude-bad', { cwd: '/q' }), false);
    assert.equal(main.webContents.on_('claude:event').length, 1);
  });

  test('Quick Chat sends: once per request id, only for its own chat; main windows send directly', async () => {
    const h = await ready();
    const chats = h.one('ChatsStore');
    chats.get = (id: string) => (id === 'q1' ? { id } : null);
    chats.records.set('q1', {});
    const ctl = h.one('ChatController');
    const receipt = { action: 'started', id: 'r1' };
    ctl.send = mock.fn(async () => receipt);
    const main = h.windows[0];
    h.emitIpc('window:ready', main.webContents);
    await h.invoke('window:mini');
    const mini = h.windows[1];
    await h.invokeFrom(mini.webContents, 'quick-chat:save', { threadId: 'q1', text: '' });
    const item = { id: 'r1', text: 'hi' };
    assert.deepEqual(await h.invokeFrom(mini.webContents, 'session:send', 'q1', item), receipt);
    assert.deepEqual(await h.invokeFrom(mini.webContents, 'session:send', 'q1', item), receipt);
    assert.deepEqual(calls(ctl.send), [['q1', item, mini.webContents.id, true]]);
    await assert.rejects(h.invokeFrom(mini.webContents, 'session:send', 'other', item), /Invalid Quick Chat thread/);
    mini.close();
    await h.invokeFrom(mini.webContents, 'session:send', 'q1', item);
    assert.equal(ctl.send.mock.callCount(), 2, 'a closed Quick Chat is an ordinary sender');
  });
}
