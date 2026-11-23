// Main's account startup wiring joins the native turn with account movement without relying on window lifetime or timers.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadMain, unloadMain, flush } from './support/electron-main-harness.ts';
mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());
const calls = (f: any) => f.mock.calls.map((c: any) => c.arguments);

test('ready: accounts, the relay, providers and the server intercepts', async () => {
  const h = await loadMain({ env: { SAGE_DEBUG_TOOLS: '1' }, before: (h) => fs.writeFileSync(path.join(h.tmp, 'sage-mcp'), '') });
  await h.ready();
  const accounts = h.one('Accounts');
  assert.equal(accounts.opts.userData, h.userData);
  assert.equal(await accounts.opts.findBin(), 'codex', 'no copy installed: left to PATH');
  assert.deepEqual(accounts.opts.clientInfo, { name: 'sage_codex_accounts', title: 'MoPilot', version: '1.2.3' });
  const server = h.one('AppServer');
  assert.deepEqual(server.threadConfig, { openai_base_url: 'http://relay' });
  const providers = h.one('CodexProviders');
  assert.deepEqual(calls(providers.sync)[0], ['provider-input', []]);
  assert.equal(providers.opts.command, '/auth-cmd');
  // an accounts event reaches every open window and asks them to re-read capabilities
  const w = h.windows[0];
  providers.sync.mock.mockImplementation(async () => {
    throw new Error('keychain');
  });
  accounts.opts.broadcast({ kind: 'changed' });
  await flush();
  assert.deepEqual(w.webContents.on_('accounts:event'), [[{ kind: 'changed' }]]);
  assert.equal(w.webContents.on_('session:capsChanged').length, 1);
  accounts.opts.openExternal('https://login');
  assert.deepEqual(calls(h.electron.shell.openExternal).at(-1), ['https://login']);
  accounts.opts.forgetProvider('acct');
  assert.deepEqual(calls(providers.forget).at(-1), ['acct']);
  // an added key is stored for its thread provider before it is applied; ready only when the provider is (#2201)
  providers.sync.mock.mockImplementation(async () => {});
  providers.fragment.mock.mockImplementation(async () => ({ modelProvider: 'sage_x' }));
  const syncs = calls(providers.sync).length;
  assert.equal(await accounts.opts.provideKey({ account: 'k' }), true);
  assert.deepEqual(calls(providers.sync).at(-1), [{ account: 'k' }]);
  // the key could not be stored (no helper, keychain refused): not ready, and no provider is followed
  providers.fragment.mock.mockImplementation(async () => null);
  assert.equal(await accounts.opts.provideKey({ account: 'k' }), false);
  assert.equal(calls(providers.sync).length, syncs + 1);
  // no key to provide (the account's key is unreadable)
  assert.equal(await accounts.opts.provideKey(null), false);
  // A move and the original turn's actual end join in main, with no window or timer assumption.
  const ctl = h.one('ChatController');
  const sessions = h.one('SessionStore');
  ctl.chatOf = mock.fn(() => 'chat-9');
  ctl.isCurrentSource = mock.fn(() => true);
  ctl.chats = { records: new Map([['chat-9', {}]]) };
  ctl.chats.isDeleted = () => false;
  ctl.state = sessions;
  ctl.start = mock.fn(async () => ({ started: true }));
  const runtime = { startAttempt: {}, stops: 0 };
  ctl.rt = mock.fn(() => runtime);
  const state = { activeTurn: { id: 'limited' }, turn: 'running', queue: [], pendingSwitch: null };
  sessions.get = mock.fn(() => state);
  const moved = accounts.opts.prepareContinue('t9', 'limited');
  moved();
  mock.timers.tick(10_000);
  assert.equal(ctl.start.mock.callCount(), 0, 'wait for cleanup even beyond the previous 800ms guess');
  Object.assign(state, { activeTurn: null, turn: 'idle' });
  ctl.onFinished({ chatId: 'chat-9', turnId: 'limited' });
  await flush();
  assert.equal(calls(ctl.start).at(-1)[0], 'chat-9');
  assert.equal(calls(ctl.start).at(-1)[1].text, 'Continue where you left off.');
  assert.equal(calls(ctl.start).at(-1)[1].origin, null);
  assert.deepEqual(calls(ctl.chatOf).at(-1), ['t9']);
  // A new turn started while an account move waited: no automatic follow-up into that turn.
  Object.assign(state, { activeTurn: { id: 'next-limited' }, turn: 'running' });
  const late = accounts.opts.prepareContinue('t9', 'next-limited');
  Object.assign(state, { activeTurn: null, turn: 'idle' });
  ctl.onFinished({ chatId: 'chat-9', turnId: 'next-limited' });
  runtime.startAttempt = {};
  late();
  await flush();
  assert.equal(ctl.start.mock.callCount(), 1);
  accounts.opts.notifyLimit('t9');
  const limitNote = calls(h.mod('platform/notify.cjs').registerNotify.mock.calls[0].result.notify).at(-1);
  assert.deepEqual(limitNote, [
    'goal',
    'chat-9',
    { title: 'Codex', body: 'Usage limit reached · Switch account to continue', status: 'usageLimited' },
  ]);
  // the debug echo tool
  assert.deepEqual(calls(h.one('Registry').register)[0], [{ name: 'echo' }]);
  assert.equal(h.one('OperationLog').opts.file, path.join(h.userData, 'capabilities', 'operations.jsonl'));
  // the intercepts: native CUA elicitations are refused, then server requests go to the registry
  // the tool channel is not among them: it reads answers from the Codex adapter, after their hooks (CM-L11)
  const [cua, requests, consent, ...rest] = server.intercepts.list;
  assert.equal(rest.length, 0);
  assert.equal(cua.kind, 'cua');
  cua.o.send({ m: 1 });
  assert.equal(server.send.mock.callCount(), 0, 'no app-server process');
  server.proc = { pid: 42 };
  cua.o.send({ m: 1 });
  requests.o.send({ m: 2 });
  assert.deepEqual(calls(server.send), [[{ m: 1 }], [{ m: 2 }]]);
  cua.o.notify('t1', 'not here');
  assert.deepEqual(w.webContents.on_('codex:item').at(-1), [{ kind: 'toast', level: 'info', text: 'not here', mine: true }]);
  assert.equal(requests.o.registry, h.one('Registry'));
  // a sub-agent's request is charged to its parent's chat (requestChat), as its sage-mcp calls are
  h.one('ChatController').chatOf = (id: string) => `chat-of-${id}`;
  h.one('ChatController').requestChat = (id: string) => `chat-of-${id}`;
  assert.deepEqual(requests.o.owner('th'), { chatId: 'chat-of-th', segmentId: 'th' });
  // the Browser plugin's site consent: an accepted card becomes the chat's site grant (browser/pluginConsent.cjs)
  const siteRequest = (id: number) => ({
    id,
    method: 'mcpServer/elicitation/request',
    params: { threadId: 'th', _meta: { connector_id: 'browser-use', tool_name: 'access_browser_origin', origin: 'https://a.test' } },
  });
  const grants = h.one('OriginGrants');
  grants.consented = mock.fn(() => true);
  h.one('ChatController').onCodexOutgoing = () => true;
  // a subagent thread's card is about its parent's chat (CodexToolInjection.chatThreadOf); the thread's plugin
  // works in the in-app browser (it has an iab backend), so its consent is that browser's grant
  h.one('CodexToolInjection').browserBackends = { has: (id: string) => id === 'th' };
  h.one('CodexToolInjection').chatThreadOf = () => undefined;
  assert.equal(consent(siteRequest(9)), false);
  await h.invoke('codex:respond', 9, { action: 'accept', content: {}, _meta: null });
  h.one('ChatController').chatOf = () => null;
  h.one('CodexToolInjection').chatThreadOf = (id: string) => `parent-of-${id}`;
  consent(siteRequest(10));
  await h.invoke('codex:respond', 10, { action: 'accept', content: {}, _meta: { persist: 'always' } });
  assert.deepEqual(calls(grants.consented), [
    ['chat-of-th', 'https://a.test', 'chat'],
    ['parent-of-th', 'https://a.test', 'always'],
  ]);
  // a thread without the backend: its plugin isn't in the in-app browser, nothing is recorded
  h.one('CodexToolInjection').browserBackends = null;
  consent(siteRequest(11));
  await h.invoke('codex:respond', 11, { action: 'accept', content: {}, _meta: null });
  assert.equal(calls(grants.consented).length, 2);
  h.one('ChatController').chatOf = (id: string) => `chat-of-${id}`;
  // the sage-mcp tool socket and channels
  const socket = h.one('ToolSocket');
  h.app.emit('will-quit');
  assert.equal(socket.close.mock.callCount(), 1);
  const inj = h.one('CodexToolInjection');
  assert.equal(inj.opts.socketPath, '/tmp/sage.sock');
  // a thread's tool session names the process its request goes to: MoMo's app-server for its threads (#2308)
  const asked: any[] = [];
  server.pidFor = (p: any) => (asked.push(p), p?.threadId === 'momo' ? 43 : server.proc?.pid);
  assert.equal(inj.opts.harnessPid({ threadId: 'code' }), 42);
  assert.equal(inj.opts.harnessPid({ threadId: 'momo' }), 43);
  assert.deepEqual(asked, [{ threadId: 'code' }, { threadId: 'momo' }]);
  server.proc = null;
  assert.equal(inj.opts.harnessPid({ threadId: 'code' }), undefined);
  assert.equal(inj.opts.hasTools(), false, 'no tools registered');
  h.one('Registry').list = () => ['t'];
  assert.equal(inj.opts.hasTools(), true);
  // each Codex thread's calls keep that thread's turn token; any other call the chat's
  // (the thread a call's turn metadata names, CodexToolInjection.turnThreadOf)
  const [turnThread] = calls(h.one('Registry').setTurnThread)[0];
  inj.turnThreadOf = (chatId: string, segmentId: string, meta: any) => (segmentId === 'thr' ? (meta?.thread ?? segmentId) : null);
  assert.equal(turnThread('c', 'thr'), 'thr');
  assert.equal(turnThread('c', 'thr', { thread: 'sub' }), 'sub');
  assert.equal(turnThread('c', 'claude:s'), null);
  // a thread's calls belong to the chat its requests do: a sub-agent's parent chat (requestChat)
  h.one('ChatController').requestChat = (id: string) => `chat-of-${id}`;
  assert.equal(inj.opts.chatOf('th'), 'chat-of-th');
  h.one('ChatController').requestChat = () => null;
  assert.equal(inj.opts.chatOf('th'), 'th');
  assert.equal(inj.opts.disableUserNodeRepl(), true);
  assert.equal(h.one('SessionMcp').opts.enabled(), true);
  assert.equal(h.one('SessionMcp').opts.socket, socket);
  // claude finds a session's chat through the controller, at call time, and the key itself without one
  const chatOfKey = calls(h.claude.setChatOf)[0][0];
  h.one('ChatController').chatOf = (id: string) => `chat-of-${id}`;
  assert.equal(chatOfKey('claude:s1'), 'chat-of-claude:s1');
  h.one('ChatController').chatOf = () => null;
  assert.equal(chatOfKey('claude:s1'), 'claude:s1');
  // claude gets the tools
  const tools = calls(h.claude.setTools)[0][0];
  assert.equal(tools.enabled(), true);
  assert.equal(
    calls(h.mod('platform/flags.cjs').isEnabled).some((c: any) => c[0] === 'channel.claude.sdkMcp'),
    true,
  );
});
