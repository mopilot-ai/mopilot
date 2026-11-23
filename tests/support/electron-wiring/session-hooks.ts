// Electron main session-hooks wiring unit cases with the shared fake main harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { flush, calls, peerMain } from './fixture';

export function registerSessionHooksCases() {
  test('main gives Codex the plugin store when it first starts and after each restart, only while it is up', async () => {
    const { codexPluginMirror, pluginService, builtinReady } = await import('../../../electron/plugins/service.cjs');
    // MoPilot's own plugin is put in the store before the sync; this run's store is the real one, so it is only counted
    const seeded = mock.method(pluginService().store, 'seedBundled', async () => 'current');
    const h = await peerMain();
    await flush();
    const adapter = h.one('CodexAdapter');
    const mirror = codexPluginMirror();
    const synced = mock.method(mirror, 'sync', async () => {
      throw new Error('Codex said no');
    });
    adapter.opts.onFirstStart();
    adapter.opts.onStatus({ kind: 'restarting', attempt: 1, inMs: 10 });
    adapter.opts.onStatus({ kind: 'ready' });
    await flush();
    assert.equal(synced.mock.callCount(), 2, 'the first start and the restart that came back');
    synced.mock.restore();
    assert.equal(seeded.mock.callCount(), 1, 'seeded once, however many syncs follow');
    assert.equal(await builtinReady(), undefined);
    // the mirror talks to this adapter, and only while it is up
    adapter.request = mock.fn(async () => ({ marketplaces: [] }));
    assert.deepEqual(await mirror.request('plugin/list', {}), { marketplaces: [] });
    assert.deepEqual(calls(adapter.request), [['plugin/list', {}]]);
    assert.equal(mirror.connected(), false);
    adapter.readyAt = 1;
    adapter.down = false;
    assert.equal(mirror.connected(), true);
    adapter.readyAt = 0;
    // an ACP turn asks the plugin store for the skills and commands it provides there
    assert.ok(Array.isArray(await h.one('AcpTurns').opts.pluginSkills()));
    seeded.mock.restore();
    // and its first prompt carries the note on what MoPilot's tools reach (#1319 G3), from the live Registry
    const note = h.one('AcpTurns').opts.toolsNote();
    assert.ok(note === null || typeof note === 'string');
  });

  test("main's target leases: the handoff record lists every surface's leases of the chat, and its turn end reaches each", async () => {
    const h = await peerMain();
    await flush();
    const tabs = h.one('BrowserTabs');
    const cu = h.inst.computerUse[0];
    const chrome = h.one('ChromeChannel');
    tabs.leases = mock.fn(() => [{ surface: 'iab', id: 'tab_1' }]);
    cu.leases = mock.fn(() => [{ surface: 'desktop', id: 'desktop' }]);
    chrome.leases = mock.fn(() => [{ surface: 'chrome', id: 'group' }]);
    assert.deepEqual(
      h
        .one('SwitchRunner')
        .opts.held('c')
        .map((l: any) => l.surface),
      ['iab', 'desktop', 'chrome'],
    );
    assert.deepEqual([calls(tabs.leases), calls(cu.leases), calls(chrome.leases)], [[['c']], [['c']], [['c']]]);
    // a switch puts the chat on its account through the Codex pool and the Claude adapter (session/switchAccount.cjs)
    const accounts = h.one('SwitchRunner').opts.accounts;
    assert.equal(accounts.codex(), h.one('Accounts'));
    assert.equal(accounts.claude, h.one('ClaudeAdapter'));
    for (const s of [tabs, cu, chrome]) s.turnEnded = mock.fn();
    h.one('SessionStore').opts.publish({ chatId: 'c', patch: { turn: 'idle' } });
    await flush();
    assert.deepEqual([calls(tabs.turnEnded), calls(cu.turnEnded), calls(chrome.turnEnded)], [[['c']], [['c']], [['c']]]);
  });

  test("main's session hooks: turn ends close browser tabs, turn diffs persist, controller and caps callbacks", async () => {
    const h = await peerMain();
    await flush();
    const tabs = h.one('BrowserTabs');
    const pub = h.one('SessionStore').opts.publish;
    tabs.turnEnded = mock.fn(async () => {});
    pub({ chatId: 'c', patch: { turn: 'idle' } });
    pub({ chatId: 'c', patch: { turn: 'running' } });
    await flush();
    assert.deepEqual(calls(tabs.turnEnded), [['c']]);
    tabs.turnEnded = mock.fn(() => undefined);
    pub({ chatId: 'd', patch: { turn: 'crashed' } });
    await flush();
    assert.deepEqual(calls(tabs.turnEnded), [['d']]);
    // tabs that fail to close (already gone) are let go quietly
    tabs.turnEnded = mock.fn(async () => {
      throw new Error('tab closed');
    });
    pub({ chatId: 'e', patch: { turn: 'idle' } });
    await flush();
    assert.deepEqual(calls(tabs.turnEnded), [['e']]);
    const store = h.one('CodexAdapter').opts.turnChanges.store;
    store.write('t', { u: 'diff' });
    assert.deepEqual(store.read('t'), { u: 'diff' });
    // a turn/completed nobody ended lets go of what the turn held
    const ctl = h.one('ChatController');
    const sessions = h.one('SessionStore');
    ctl.chatOf = (id: string) => `chat-${id}`;
    // a thread's calls are charged to the chat requestChat names; the chat's own turn is its current Codex thread's
    ctl.requestChat = (id: string) => `chat-${id}`;
    ctl.ref = (id: string) => {
      if (id === 'c9') return { kind: 'codex', id: 'thr-9' };
      if (id === 'cl') return { kind: 'claude', id: 's' };
      throw new Error('unknown chat');
    };
    const turns = h.one('Registry').turns;
    // no spawn chains here: each thread is its own group
    h.one('CodexToolInjection').chatThreadOf = (id: string) => id;
    h.one('CodexToolInjection').parents = { rootOf: (id: string) => id };
    // a spawn group stops at the thread that is a chat (requestChat's rule)
    ctl.requestThread = (id: string) => id;
    // the Registry's rule (agentTools.cjs): a thread with its own turns
    h.one('Registry').turnThread = (_chatId: string, id: string) => (id.startsWith('thr-') ? id : null);
    sessions.has = () => true;
    sessions.running = () => false;
    const cu = h.inst.computerUse[0];
    cu.turnEnded = mock.fn();
    tabs.turnEnded = mock.fn();
    h.one('CodexAdapter').opts.observe({ method: 'turn/completed', params: { threadId: 't1' } });
    await flush();
    assert.deepEqual(calls(cu.turnEnded), [['chat-t1']]);
    // no other thread of the chat runs a turn: the chat's tokens go (CM-N09 has a thread's end among running ones)
    assert.deepEqual(calls(turns.retireTurn).at(-1), ['chat-t1', null]);
    sessions.running = () => true;
    h.one('CodexAdapter').opts.observe({ method: 'turn/completed', params: { threadId: 't2' } });
    await flush();
    assert.equal(cu.turnEnded.mock.callCount(), 1, 'a running turn is still holding them');
    ctl.opts.onFinished({ chatId: 'c9' });
    await flush();
    assert.deepEqual(calls(cu.turnEnded).at(-1), ['c9']);
    // a Codex chat's own end retires its current thread's tokens; a Claude Code chat's (and an unknown chat's) the chat's
    assert.deepEqual(calls(turns.retireTurn).at(-1), ['c9', null]);
    // one turn lets go once, whichever paths report its end; a turn/started begins the next one
    ctl.opts.onFinished({ chatId: 'chat-t1' });
    await flush();
    assert.equal(cu.turnEnded.mock.callCount(), 2);
    sessions.running = () => false;
    h.one('CodexAdapter').opts.observe({ method: 'turn/started', params: { threadId: 't1' } });
    h.one('CodexAdapter').opts.observe({ method: 'turn/completed', params: { threadId: 't1' } });
    await flush();
    assert.deepEqual(calls(cu.turnEnded).at(-1), ['chat-t1']);
    assert.equal(cu.turnEnded.mock.callCount(), 3);
    pub({ chatId: 'cl', patch: { turn: 'idle' } });
    assert.deepEqual(calls(turns.retireTurn).at(-1), ['cl', null]);
    pub({ chatId: 'zz', patch: { turn: 'idle' } });
    assert.deepEqual(calls(turns.retireTurn).at(-1), ['zz', null]);
    // every call on a parent's turn named its thread (Registry turns.ridden): its end among its running sub-agents
    // retires its own turn at once (CM-N10); a call that named none keeps it for its spawn group
    const { requestChat } = ctl;
    const { chatThreadOf } = h.one('CodexToolInjection');
    const { ridden } = turns;
    ctl.requestChat = () => 'chat-x';
    h.one('CodexToolInjection').chatThreadOf = (id: string) => (id === 'sub' ? 'par' : id);
    turns.ridden = (chatId: string, thread: string) => chatId !== 'chat-x' || thread !== 'par';
    for (const t of ['par', 'sub']) h.one('CodexAdapter').opts.observe({ method: 'turn/started', params: { threadId: t } });
    h.one('CodexAdapter').opts.observe({ method: 'turn/completed', params: { threadId: 'par' } });
    assert.deepEqual(calls(turns.retireTurn).at(-1), ['chat-x', 'par']);
    turns.ridden = () => true;
    h.one('CodexAdapter').opts.observe({ method: 'turn/started', params: { threadId: 'par' } });
    const before = turns.retireTurn.mock.callCount();
    h.one('CodexAdapter').opts.observe({ method: 'turn/completed', params: { threadId: 'par' } });
    assert.equal(turns.retireTurn.mock.callCount(), before, "otherwise the parent's turn waits for its spawn group");
    h.one('CodexAdapter').opts.observe({ method: 'turn/completed', params: { threadId: 'sub' } });
    ctl.requestChat = requestChat;
    h.one('CodexToolInjection').chatThreadOf = chatThreadOf;
    turns.ridden = ridden;
    // a crash retires every thread of the chat
    pub({ chatId: 'zz', patch: { turn: 'crashed' } });
    assert.deepEqual(calls(turns.retire).at(-1), ['zz']);
    // caps: the chat's instance and the Codex login kind
    const caps = h.one('CapsService').opts;
    const identity = h.one('IdentityRegistry');
    identity.driver = (harness: string) => (harness === 'claude' ? { chatInstance: (key: string) => `inst-${key}` } : {});
    assert.equal(caps.chatInstance('claude', 'k'), 'inst-k');
    assert.equal(caps.chatInstance('codex', 'k'), null);
    const accounts = h.one('Accounts');
    accounts.active = () => null;
    assert.equal(caps.codexAuth(), null);
    accounts.active = () => ({ kind: 'apiKey' });
    assert.equal(caps.codexAuth(), 'apiKey');
    accounts.active = () => ({});
    assert.equal(caps.codexAuth(), 'chatgpt');
  });
}
