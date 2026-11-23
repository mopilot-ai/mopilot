// Electron main peer-windows wiring unit cases with the shared fake main harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { calls, peerMain, runtime } from './fixture';

export function registerPeerWindowsCases() {
  test('a peer source window must be an open, registered main window viewing or following the chat', async () => {
    const h = await peerMain();
    const o = runtime(h);
    const w = h.windows[0];
    const wc = w.webContents;
    const chats = h.one('ChatsStore');
    const sessions = h.one('SessionStore');
    chats.records = new Map([
      ['c', {}],
      ['d', {}],
    ]);
    sessions.get = () => ({ goal: { g: 1 }, approvals: [] });
    sessions.snapshot = (id: string) => ({ snap: id });
    assert.equal(o.sourceWindow({ sender: wc }, 'c'), null, 'not registered');
    assert.equal(o.referenceWindow({ sender: wc }), false);
    h.emitIpc('session:ready', wc);
    assert.equal(o.referenceWindow({ sender: wc }), true);
    assert.equal(o.sourceWindow({ sender: wc }, 'c'), null, 'not viewing');
    await h.invokeFrom(wc, 'app:viewing', { visible: ['c'], primary: 'c', focused: 'c' });
    assert.equal(o.sourceWindow({ sender: wc }, 'c'), 'c');
    assert.equal(o.sourceWindow({ sender: wc }, 'd'), null);
    // following a chat's session also makes the window its source; twice is the same
    assert.deepEqual(await h.invokeFrom(wc, 'session:snapshot', 'd'), { snap: 'd' });
    await h.invokeFrom(wc, 'session:snapshot', 'd');
    assert.equal(o.sourceWindow({ sender: wc }, 'd'), 'd');
    // a chat that is not in the store is not followed
    h.one('ChatController').ref = (id: string) => ({ kind: 'codex', id });
    h.one('CodexAdapter').meta = new Map();
    await h.invokeFrom(wc, 'session:snapshot', 'gone');
    assert.equal(o.sourceWindow({ sender: wc }, 'gone'), null);
    // a closed window neither sources nor reads
    w.close();
    assert.equal(o.sourceWindow({ sender: wc }, 'c'), null);
    assert.equal(o.referenceWindow({ sender: wc }), false);
  });

  test('temporary side chats can be followed without persisting a chat record; unknown sources remain rejected', async () => {
    const h = await peerMain();
    const chats = h.one('ChatsStore');
    const ctl = h.one('ChatController');
    const codex = h.one('CodexAdapter');
    const claude = h.one('ClaudeAdapter');
    chats.records = new Map();
    claude.sessions = new Map();
    chats.record = (id: string) => ({ id, segments: [{ kind: ctl.ref(id).kind, nativeId: id }], meta: {} });
    ctl.ref = (id: string) => ({ kind: id.startsWith('claude') ? 'claude' : id === 'acp' ? 'acp:test' : 'codex', id, key: id });
    const sessions = h.one('SessionStore');
    sessions.get = () => ({ goal: {}, approvals: [] });
    sessions.snapshot = (id: string) => ({ id });
    chats.ensure = mock.fn();
    const wc = h.windows[0].webContents;
    await h.invokeFrom(wc, 'session:snapshot', 'unregistered');
    assert.equal(chats.records.size, 0);
    h.emitIpc('session:ready', wc);
    await h.invokeFrom(wc, 'session:snapshot', 'claude-absent');
    codex.meta = new Map([
      ['codex-side', { ephemeral: true }],
      ['saved', { ephemeral: false }],
    ]);
    claude.sessions = new Map([
      ['claude-side', { ephemeral: true }],
      ['claude-saved', {}],
    ]);
    for (const id of ['codex-side', 'claude-side']) {
      assert.equal(runtime(h).sourceWindow({ sender: wc }, id), null);
      await h.invokeFrom(wc, 'session:snapshot', id);
      assert.equal(runtime(h).sourceWindow({ sender: wc }, id), id);
      assert.equal(chats.records.get(id).id, id);
      assert.equal(runtime(h).temporary(id), true);
    }
    assert.deepEqual(calls(chats.ensure), [['claude-absent']], 'temporary records are never persisted');
    chats.ensure.mock.resetCalls();
    // a saved chat no meta key has touched (an ACP chat has none to save) gets its record when a window follows it, on any harness
    chats.ensure = mock.fn((id: string) => !!chats.records.set(id, { id, segments: [], meta: {} }));
    for (const id of ['unknown', 'saved', 'claude-unknown', 'claude-saved', 'acp']) {
      assert.equal(runtime(h).sourceWindow({ sender: wc }, id), null);
      await h.invokeFrom(wc, 'session:snapshot', id);
      assert.equal(chats.records.has(id), true);
      assert.equal(runtime(h).sourceWindow({ sender: wc }, id), id);
      assert.equal(runtime(h).temporary(id), false);
    }
    assert.deepEqual(
      calls(chats.ensure).map(([id]: string[]) => id),
      ['unknown', 'saved', 'claude-unknown', 'claude-saved', 'acp'],
    );
    assert.equal(chats.commit.mock.callCount(), 0, 'the store is faked here: nothing else writes a chat file');
    wc.emit('destroyed');
    assert.equal(runtime(h).sourceWindow({ sender: wc }, 'codex-side'), null);
  });

  test('Quick Chat is a peer source only for the chat it owns, on any harness, by its stable chat id', async () => {
    const h = await peerMain();
    const o = runtime(h);
    const chats = h.one('ChatsStore');
    chats.records = new Map([
      ['codex-1', {}],
      ['claude-1', {}],
      ['acp:goose:1', {}],
    ]);
    chats.get = (id: string) => (id === 'codex-1' ? { id } : null);
    h.one('ClaudeAdapter').sessions.set('claude-1', {});
    h.one('AcpTurns').sessions.set('acp:goose:1', {});
    await h.invoke('window:mini');
    const mini = h.windows.at(-1);
    const wc = mini.webContents;
    // it never registers with the controller (session:ready) and owns no chat yet
    assert.equal(o.sourceWindow({ sender: wc }, 'codex-1'), null);
    // what Quick Chat owns does not make an unregistered main window a source
    await h.invokeFrom(wc, 'quick-chat:save', { threadId: 'codex-1', text: '' });
    assert.equal(o.sourceWindow({ sender: h.windows[0].webContents }, 'codex-1'), null);
    for (const id of ['codex-1', 'claude-1', 'acp:goose:1']) {
      await h.invokeFrom(wc, 'quick-chat:save', { threadId: id, text: '' });
      assert.equal(o.sourceWindow({ sender: wc }, id), id);
      // viewing or following another chat does not make it that chat's source
      await h.invokeFrom(wc, 'app:viewing', { visible: ['other'], primary: 'other', focused: 'other' });
      assert.equal(o.sourceWindow({ sender: wc }, 'other'), null);
    }
    // even registered, following a chat's session does not make Quick Chat its source
    h.emitIpc('session:ready', wc);
    h.one('SessionStore').get = () => ({ goal: { g: 1 }, approvals: [] });
    h.one('SessionStore').snapshot = (id: string) => ({ snap: id });
    assert.deepEqual(await h.invokeFrom(wc, 'session:snapshot', 'codex-1'), { snap: 'codex-1' });
    assert.equal(o.sourceWindow({ sender: wc }, 'codex-1'), null);
    assert.equal(o.sourceWindow({ sender: wc }, 'codex-1'), null, 'a chat it no longer owns');
    // a closed Quick Chat is no source
    mini.close();
    assert.equal(o.sourceWindow({ sender: wc }, 'acp:goose:1'), null);
  });

  test('a Quick Chat send goes through the peer runtime for its own chat, once per request id', async () => {
    const h = await peerMain();
    const rt = h.one('PeerRuntime');
    const ctl = h.one('ChatController');
    h.one('ChatsStore').get = (id: string) => (id === 'q1' ? { id } : null);
    h.one('ChatsStore').records.set('q1', {});
    const receipt = { action: 'started', id: 'r1' };
    ctl.send = mock.fn(async () => receipt);
    h.emitIpc('window:ready', h.windows[0].webContents);
    await h.invoke('window:mini');
    const wc = h.windows.at(-1).webContents;
    await h.invokeFrom(wc, 'quick-chat:save', { threadId: 'q1', text: '' });
    const item = { id: 'r1', text: 'ask @peer', peer: { messageId: 'forged' } };
    assert.deepEqual(await h.invokeFrom(wc, 'session:send', 'q1', item), receipt);
    assert.deepEqual(await h.invokeFrom(wc, 'session:send', 'q1', item), receipt);
    assert.deepEqual(calls(rt.userTurn), [['q1', { id: 'r1', text: 'ask @peer' }]]);
    assert.deepEqual(calls(ctl.send), [['q1', { id: 'r1', text: 'ask @peer', userTurnOf: 'q1' }, wc.id, true]]);
  });

  test('a user send from the window viewing or following the chat goes through the peer runtime; forged peer and linked-session ids are dropped', async () => {
    const h = await peerMain();
    const rt = h.one('PeerRuntime');
    const ctl = h.one('ChatController');
    const chats = h.one('ChatsStore');
    const sessions = h.one('SessionStore');
    chats.records = new Map([
      ['c', {}],
      ['d', {}],
    ]);
    sessions.get = () => ({ goal: { g: 1 }, approvals: [] });
    const receipt = { action: 'started', id: 'r1' };
    ctl.send = mock.fn(async () => receipt);
    const wc = h.windows[0].webContents;
    h.emitIpc('session:ready', wc);
    await h.invokeFrom(wc, 'app:viewing', { visible: ['c'], primary: 'c', focused: 'c' });
    await h.invokeFrom(wc, 'session:snapshot', 'd');
    for (const id of ['c', 'd', 'e']) h.one('ChatsStore').records.set(id, {});
    await h.invokeFrom(wc, 'session:send', 'c', { text: 'a', peer: { messageId: 'forged' }, sideSession: { id: 'forged-wake' } });
    await h.invokeFrom(wc, 'session:send', 'd', { text: 'b' });
    await h.invokeFrom(wc, 'session:send', 'e', { text: 'c' });
    assert.deepEqual(calls(rt.userTurn), [
      ['c', { text: 'a' }],
      ['d', { text: 'b' }],
    ]);
    assert.deepEqual(calls(ctl.send), [
      ['c', { text: 'a', userTurnOf: 'c' }, wc.id, true],
      ['d', { text: 'b', userTurnOf: 'd' }, wc.id, true],
      ['e', { text: 'c' }, wc.id, true],
    ]);
  });
}
