// Electron main peer-services wiring unit cases with the shared fake main harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { calls, peerMain, runtime } from './fixture';
import { transcriptItems } from '../acp-transcript.ts';

export function registerPeerServicesCases() {
  test("peer directory, project and native history readers use the chat's recorded harness", async () => {
    const h = await peerMain();
    const o = runtime(h);
    const codex = h.one('CodexAdapter');
    const claudeTurns = h.one('ClaudeAdapter');
    const acpTurns = h.one('AcpTurns');
    const acpHost = h.one('AcpHost');
    // chat titles come from every harness's list, set when IPC registers (app/ipc/chatList.cjs), never Codex's names alone
    assert.equal(o.title, undefined);
    assert.equal(o.titles, undefined);
    const segs: any = {
      cx: { kind: 'codex', nativeId: 'n1' },
      cl: { kind: 'claude', nativeId: 'n2' },
      live: { kind: 'acp:gemini', nativeId: 'live' },
      old: { kind: 'acp:gemini', nativeId: 'old' },
      none: { kind: 'acp:gemini', nativeId: 'none' },
      odd: { kind: 'other', nativeId: 'n' },
    };
    const chats = h.one('ChatsStore');
    chats.records = new Map(Object.keys(segs).map((id) => [id, {}]));
    chats.record = (id: string) => ({ segments: [{ kind: 'codex', nativeId: 'first' }, segs[id]] });
    // a Codex thread's folder from its saved metadata: one untouched since a restart has one too
    codex.folderOf = async (id: string) => `/codex/${id}`;
    claudeTurns.cwdOf = mock.fn(async (r: any) => `/claude/${r.id}`);
    acpTurns.sessions = new Map([['acp:gemini:live', { cwd: '/live' }]]);
    const recordsOf = (key: string) => (key === 'acp:gemini:old' ? [{ t: 'title' }, { t: 'session', cwd: '/old' }] : []);
    // the project and the histories are read without blocking
    acpHost.history = async (key: string) => recordsOf(key);
    assert.deepEqual(await Promise.all(['cx', 'cl', 'live', 'old', 'none', 'odd'].map((id) => o.projectOf(id))), [
      '/codex/n1',
      '/claude/n2',
      '/live',
      '/old',
      null,
      null,
    ]);
    assert.deepEqual(calls(claudeTurns.cwdOf), [[{ key: 'claude:n2', id: 'n2' }]]);
    // reading: the chat's record and a native reader over the adapters, never a window
    const rec = { segments: [] };
    chats.records = new Map([['c', rec]]);
    const reference = await o.readReference('c');
    assert.equal(reference.reference, rec);
    const reader = reference.reader.nativeOpts;
    assert.equal(await reader.projectOf({ kind: 'codex', nativeId: 'n9' }), '/codex/n9');
    h.claude.messages.mock.mockImplementation((id: string) => [`claude:${id}`]);
    h.claude.allTurns.mock.mockImplementation((id: string, opts: any) => [`claude:${id}:${opts.chatId}:${opts.cwd}:${opts.open}`]);
    assert.deepEqual(reader.claudeTurns('s', '/x', { open: true }), ['claude:s:s:/x:true']);
    // the prose-only read goes to the harness's replies reader with the folder
    h.claude.replies.mock.mockImplementation((id: string, opts: any) => [`replies:${id}:${opts.cwd}`]);
    assert.deepEqual(reader.claudeReplies('s', '/x'), ['replies:s:/x']);
    // an ACP chat's turns are read from its host's transcript, whose own record names the folder
    Object.assign(acpHost, { chats: new Map(), items: transcriptItems(recordsOf) });
    const read = await reader.acpTurns('acp:gemini:old', 'old', { find: true });
    assert.equal(read.cwd, '/old');
    codex.threadTurns = mock.fn(() => 'turns');
    assert.equal(reader.codexTurns('t', { limit: 1 }), 'turns');
    assert.deepEqual(calls(codex.threadTurns), [['t', { limit: 1 }]]);
    const page = await o.read('c', { cursor: '1' });
    assert.equal(page.transcript, rec);
    assert.deepEqual(page.options, { cursor: '1' });
    assert.deepEqual((await o.read('c')).options, {});
    // The panel's unbudgeted reader uses the store's current records, even after replacement.
    const history = await o.readHistory('c');
    assert.equal(history.history, rec);
    assert.equal(await history.reader.nativeOpts.projectOf({ kind: 'codex', nativeId: 'n9' }), '/codex/n9');
    const replacement = { segments: [{ kind: 'claude', nativeId: 'new' }] };
    chats.records = new Map([['c', replacement]]);
    assert.equal((await o.readHistory('c')).history, replacement);
    assert.equal((await o.readHistory('missing')).history, undefined);
    // a receipt reads the same native histories
    const receipt = o.readReceipt.receiptOpts;
    assert.deepEqual(receipt.claudeMessages('s'), ['claude:s']);
    assert.deepEqual(await receipt.acpHistory('acp:gemini:x'), []);
    assert.equal(receipt.codexTurns('t', {}), 'turns');
  });

  test('peer tool channels follow their remote switch, and temporary chats are never journaled', async () => {
    const h = await peerMain();
    const o = runtime(h);
    const isEnabled = h.mod('platform/flags.cjs').isEnabled;
    assert.equal(o.channelAvailability(undefined), 'tool_bridge_unavailable');
    assert.equal(o.channelAvailability('channel.claude.sdkMcp'), null);
    isEnabled.mock.mockImplementation((name: string) => name !== 'channel.claude.sdkMcp');
    assert.equal(o.channelAvailability('channel.claude.sdkMcp'), 'tool_bridge_disabled');
    isEnabled.mock.mockImplementation(() => true);
    const chats = h.one('ChatsStore');
    const ctl = h.one('ChatController');
    const codex = h.one('CodexAdapter');
    const claudeTurns = h.one('ClaudeAdapter');
    chats.records = new Map(['cx', 'cx2', 'cl', 'cl2', 'acp'].map((id) => [id, {}]));
    const refs: any = {
      cx: { kind: 'codex', id: 'e' },
      cx2: { kind: 'codex', id: 'kept' },
      cl: { kind: 'claude', key: 'claude:e' },
      cl2: { kind: 'claude', key: 'claude:kept' },
      acp: { kind: 'acp:gemini' },
    };
    ctl.ref = (id: string) => refs[id];
    codex.meta = new Map([['e', { ephemeral: true }]]);
    claudeTurns.sessions = new Map([['claude:e', { ephemeral: true }]]);
    assert.deepEqual(
      ['missing', 'cx', 'cx2', 'cl', 'cl2', 'acp'].map((id) => o.temporary(id)),
      [false, true, false, true, false, false],
    );
  });

  test('the peer gate reads the chat record, session and the account or admission its harness needs', async () => {
    const h = await peerMain();
    const g = runtime(h).gate.gateOpts;
    const chats = h.one('ChatsStore');
    const sessions = h.one('SessionStore');
    const ctl = h.one('ChatController');
    chats.records = new Map([['c', { id: 'c' }]]);
    assert.deepEqual(g.record('c'), { id: 'c' });
    sessions.get = (id: string) => ({ state: id });
    assert.deepEqual(g.state('c'), { state: 'c' });
    // the goal is main's record of it (SessionStore goalStatus), not the state's copy a window wrote (#2759)
    sessions.goalStatus = (id: string) => `goal of ${id}`;
    assert.equal(g.goalStatus('c'), 'goal of c');
    ctl.ref = (id: string) => ({ ref: id });
    assert.deepEqual(g.ref('c'), { ref: 'c' });
    // a killed harness says why
    const killed = h.mod('shared/killSwitch.cjs').killedReason;
    killed.mock.mockImplementation(() => 'harness_disabled');
    assert.equal(await g.availability({ kind: 'codex', id: 'n' }, { id: 'c' }), 'harness_disabled');
    killed.mock.mockImplementation(() => null);
    // a basic harness needs its admission
    const admission = h.one('Admission');
    const acp = { kind: 'acp:gemini', id: 'n' };
    admission.list = () => [{ id: 'gemini', state: 'admitted' }];
    assert.equal(await g.availability(acp, {}), null);
    admission.list = () => [{ id: 'gemini', state: 'signin' }];
    assert.equal(await g.availability(acp, {}), 'login_required');
    admission.list = () => [];
    assert.equal(await g.availability(acp, {}), 'harness_unavailable');
    // one that reads signed out is checked again first: it may have been signed in from a terminal since
    assert.deepEqual(admission.current.mock.calls.at(-1).arguments, ['gemini', { again: true }]);
    // Codex and Claude need a signed-in account: the chat's pin, its own, or the active one
    const identity = h.one('IdentityRegistry');
    const accounts = h.one('Accounts');
    const claudeTurns = h.one('ClaudeAdapter');
    accounts.pins = new Map();
    claudeTurns.own = new Map();
    identity.instances = () => undefined;
    assert.equal(await g.availability({ kind: 'codex', id: 'n' }, { id: 'c' }), 'login_required');
    identity.instances = () => [
      { account: 'a1', status: 'ok' },
      { account: 'a2', status: 'expired', active: true },
    ];
    accounts.pins = new Map([['n', { id: 'a1' }]]);
    claudeTurns.own = new Map([['c', { account: 'a2' }]]);
    // the adapter's pick (its own, else the file's) and the login it runs on: ClaudeAdapter.pickOf / accountOf
    claudeTurns.pickedLogin = (id: string) => claudeTurns.own.get(id)?.account ?? null;
    assert.equal(await g.availability({ kind: 'codex', id: 'n' }, { id: 'c' }), null);
    // a Claude login saved in the same file is not the Codex chat's account
    assert.equal(await g.availability({ kind: 'codex', id: 'n' }, { id: 'c', meta: { account: { id: 'a2' } } }), null);
    assert.equal(await g.availability({ kind: 'claude', id: 'n' }, { id: 'c' }), 'login_required');
    claudeTurns.own = new Map([['c', { account: 'a1' }]]);
    assert.equal(await g.availability({ kind: 'claude', id: 'n' }, { id: 'c' }), null);
    // no pick of its own: the harness's active instance
    assert.equal(await g.availability({ kind: 'claude', id: 'n' }, { id: 'none' }), 'login_required');
    assert.equal(await g.availability({ kind: 'codex', id: 'other' }, { id: 'x' }), 'login_required', 'the active account is signed out');
  });

  test('a newly delivered peer message is announced once, marking the chat unread unless someone is looking', async () => {
    const early = { id: 'early', delivery: 'delivered', sourceChatId: 's', targetChatId: 't', body: 'early' };
    const h = await peerMain(
      [
        { id: 'old', delivery: 'delivered' },
        { id: 'q', delivery: 'queued' },
      ],
      early,
    );
    const o = runtime(h);
    const notifier = h.mod('platform/notify.cjs').registerNotify.mock.calls[0].result;
    const chats = h.one('ChatsStore');
    const codex = h.one('CodexAdapter');
    const w = h.windows[0];
    const initialPeerEvents = w.webContents.on_('peer:changed').length;
    chats.records = new Map([['t', {}]]);
    chats.patchMeta = mock.fn();
    chats.get = (id: string) => ({ chat: id });
    codex.chatName = (id: string) => (id === 's' ? 'Source' : '');
    assert.equal(notifier.notify.mock.callCount(), 0, 'nothing is announced while the journal opens');
    const msg = (id: string, over: any = {}) => ({
      id,
      delivery: 'delivered',
      sourceChatId: 's',
      targetChatId: 't',
      body: `body ${id}`,
      ...over,
    });
    o.publish({
      messages: [msg('old'), early, msg('q', { delivery: 'queued' }), msg('gone', { targetChatId: 'missing', sourceChatId: 'x' })],
    });
    assert.equal(w.webContents.on_('peer:changed').length, initialPeerEvents + 1);
    assert.deepEqual(calls(chats.patchMeta), [['t', { unread: true }]]);
    assert.deepEqual(w.webContents.on_('chats:changed').at(-1), [{ id: 't', chat: { chat: 't' } }]);
    assert.deepEqual(calls(notifier.notify), [
      ['turn', 't', { title: 'Message from Source', body: 'early', chatTitle: undefined, viewing: false }],
      ['turn', 'missing', { title: 'Message from another chat', body: 'body gone', chatTitle: undefined, viewing: false }],
    ]);
    // announced once
    o.publish({ messages: [early] });
    assert.equal(notifier.notify.mock.callCount(), 2);
    // a chat on screen is not marked unread
    w.focused = true;
    await h.invoke('app:viewing', { visible: ['t'], primary: 't', focused: 't' });
    codex.chatName = () => 'Target';
    o.publish({ messages: [msg('seen', { body: 'x'.repeat(300) })] });
    assert.equal(chats.patchMeta.mock.callCount(), 1);
    const [, , seen] = calls(notifier.notify).at(-1);
    assert.equal(seen.viewing, true);
    assert.equal(seen.chatTitle, 'Target');
    assert.equal(seen.body.length, 180);
  });

  test("a chat's permission for the peer hold is its harness's reported mode, else its saved choice", async () => {
    const h = await peerMain();
    const o = runtime(h);
    const chats = h.one('ChatsStore');
    const ctl = h.one('ChatController');
    const live: Record<string, any> = { cl: { permission: 'bypassPermissions' }, saved: {} };
    ctl.state = { get: (id: string) => live[id] ?? {} };
    chats.records = new Map<string, any>([
      ['cl', { meta: {} }],
      ['saved', { meta: { config: { permission: 'read-only' } } }],
    ]);
    assert.equal(o.permission('cl'), 'full-access');
    assert.equal(o.permission('saved'), 'read-only');
  });
}
