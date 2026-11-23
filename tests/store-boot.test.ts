// src/store/store.ts: boot, the Codex connection, what main pushes, persistence, projects and accounts.
import { test, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadStore, callsOf, impl, resetAll, flush, listeners, bootImpls, location, calls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, sessions, resetState } = await loadStore();
const [connection, projects] = await Promise.all([import('../src/store/connection.ts'), import('../src/store/projects.ts')]);
const st = () => S.useStore.getState();
const set = S.useStore.setState;
const [{ ownerOf }, { PREFS_VERSION }] = await Promise.all([import('../src/harness/ownership.ts'), import('../src/store/types.ts')]);
const { windowReady, resetWindowReady } = await import('../src/lib/windowReady.ts');
/** Whether boot marked the window ready (reads main gates on a known window wait for it). */
// microtasks only: these tests run on mocked timers. A resolved mark wins the race by a tick.
const marked = () =>
  Promise.race([
    windowReady().then(() => true),
    Promise.resolve()
      .then(() => undefined)
      .then(() => false),
  ]);
const accounts = (o: any = {}) => ({ active: null, autoSwitch: true, pool: 'spread', relay: false, login: null, accounts: [], ...o });

beforeEach(() => {
  resetState();
  resetAll();
  bootImpls();
});

test('a quick chat window boots projectless, without telling main it is ready, and opens settings in the main window', async () => {
  location.hash = '#thread=t-hash';
  bootImpls({
    'app.info': async () => ({ home: '/home/me', dark: false, codexHome: '/home/me/.codex', username: 'desktopuser' }),
    'state.read': async () => ({
      prefs: { fontSize: 18, language: 'en', prefsVersion: PREFS_VERSION, defaultHarness: 'claude' },
      newChatCwd: '/w',
      newChatProjectId: 'p',
      newChatCloudEnv: { id: 'e' },
      projects: [{ path: '/w', name: 'w' }],
      claudeCache: { status: { state: 'detecting', plan: 'max' }, models: [{ id: 'opus' }] },
      sidebarOpen: false,
    }),
    'chats.snapshot': async () => ({ chats: { c1: { kind: 'claude', meta: { pinned: true } } }, newer: ['x'] }),
  });
  resetWindowReady();
  await S.boot({ quickChat: true });
  const s = st();
  assert.deepEqual(
    [s.newChatCwd, s.newChatProjectId, s.newChatCloudEnv, s.sidebarOpen, s.prefs.fontSize, s.claude.status.plan],
    [null, 'none', null, false, 18, 'max'],
  );
  assert.equal(ownerOf('c1'), 'claude');
  assert.equal(s.pinned.c1, true);
  // the retired pref is dropped in main too, and no defaults patch for current prefs
  assert.deepEqual(callsOf('prefs.patch'), [[{}, ['language']]]);
  assert.equal(callsOf('session.ready').length, 0);
  // main knows Quick Chat without session:ready, so its reads go at once
  assert.equal(await marked(), true);
  assert.deepEqual(s.route, { name: 'home' });
  assert.equal(s.systemUsername, 'desktopuser');
  assert.match(s.toasts[0].text, /newer version/);
  // nothing is persisted from a quick chat window
  set({ sidebarOpen: true });
  mock.timers.tick(300);
  assert.equal(callsOf('state.write').length, 0);
  // Codex wasn't used: it stays idle and its projects are imported in the background
  assert.equal(s.conn, 'idle');
  assert.equal(callsOf('projects.importCodexBackground').length, 1);
  impl['win.quickChatSettings'] = async () => ({ ok: true });
  S.navigate({ name: 'settings', section: 'account' });
  impl['win.quickChatSettings'] = async () => ({ ok: false });
  S.navigate({ name: 'settings' });
  impl['win.quickChatSettings'] = async () => ({ ok: false, error: 'no window' });
  S.navigate({ name: 'settings' });
  impl['win.quickChatSettings'] = () => Promise.reject(new Error('gone'));
  S.navigate({ name: 'settings' });
  impl['win.quickChatSettings'] = () => Promise.reject('plain');
  S.navigate({ name: 'settings' });
  await flush();
  assert.deepEqual(callsOf('win.quickChatSettings')[0], ['account']);
  assert.deepEqual(
    st()
      .toasts.map((t) => t.text)
      .slice(1),
    ['Could not open settings', 'no window', 'gone', 'plain'],
  );
  location.hash = '';
});

test("a window opened on a sub-agent shows that agent's page at full width", async () => {
  location.hash = '#thread=t-hash&agent=k1&title=Track%20A';
  bootImpls({ 'state.read': async () => null, 'codex.used': async () => false });
  await S.boot();
  await flush();
  const tab = st().paneTabs.find((t: any) => t.kind === 'tasks') as any;
  assert.deepEqual(
    [st().route, tab.threadId, tab.views, st().paneFull],
    [{ name: 'thread', id: 't-hash' }, 't-hash', [{ kind: 'agent', key: 'k1', title: 'Track A' }], true],
  );
  // a window on the chat alone opens no pane
  location.hash = '#thread=t-hash';
  resetState();
  await S.boot();
  await flush();
  assert.equal(
    st().paneTabs.some((t: any) => t.kind === 'tasks'),
    false,
  );
  location.hash = '';
});

test('a window opened on a Claude Code chat opens it without Codex, and when Codex fails to start', async () => {
  for (const codex of ['unused', 'failing'] as const) {
    resetState();
    resetAll();
    location.hash = '#thread=claude:abc';
    bootImpls({
      'state.read': async () => null,
      'codex.used': async () => codex === 'failing',
      // main's record names the chat's harness
      'chats.snapshot': async () => ({ chats: { 'claude:abc': { kind: 'claude', meta: {} } }, newer: [] }),
      ...(codex === 'failing' ? { 'codex.start': async () => Promise.reject(new Error('no codex')) } : {}),
    });
    await S.boot();
    await flush();
    assert.deepEqual(st().route, { name: 'thread', id: 'claude:abc' }, codex);
    assert.deepEqual(callsOf('claude.openClaudeThread'), [['claude:abc']], codex);
  }
  location.hash = '';
});

test('a main window boots, opens the chat in its hash, connects Codex and loads what it knows', async () => {
  location.hash = '#thread=t-hash';
  const pushed = { cliVersion: '9', versionStatus: 'ok', probes: {}, flags: {} };
  bootImpls({
    'state.read': async () => null,
    'codex.used': async () => true,
    'codex.leases': async () => ['held1'],
    'session.withApprovals': async () => ['ap1'],
    'session.snapshot': async (id: string) => ({ rev: 1, turn: 'idle', approvals: [], id }),
    'codex.negotiated': async () => pushed,
    'api.threadList': async () => ({ data: [{ id: 't-hash', name: 'Hash' }], nextCursor: 'c2' }),
    'api.threadRead': async () => null,
    'api.threadTurns': async () => ({ data: [], nextCursor: null }),
    'api.modelList': async () => ({ data: [{ model: 'm' }] }),
  });
  resetWindowReady();
  assert.equal(await marked(), false);
  await S.boot();
  await flush();
  const s = st();
  assert.equal(s.conn, 'ready');
  assert.deepEqual([s.codexHome, s.userAgent, s.codexBinInUse, s.codexCompat], ['/home/me/.codex', 'ua', '/bin/codex', pushed]);
  assert.deepEqual(s.route, { name: 'thread', id: 't-hash' });
  assert.equal(s.threadsCursor, 'c2');
  assert.deepEqual(s.models, [{ model: 'm' }]);
  assert.equal(s.modelsLoaded, true);
  assert.deepEqual(s.account, { email: 'a@b' });
  assert.equal(callsOf('session.ready').length, 1);
  assert.equal(await marked(), true);
  assert.equal(callsOf('claude.startClaude').length, 1);
  assert.equal(callsOf('acp.startAcp').length, 1);
  assert.equal(callsOf('win.rendererReady').length, 1);
  assert.deepEqual(
    callsOf('session.snapshot')
      .map(([id]) => id)
      .includes('ap1'),
    true,
  );
  // a new profile gets the version stamped
  assert.deepEqual(callsOf('prefs.patch')[0], [{ prefsVersion: PREFS_VERSION }, []]);
  // and the thread it opened was read
  assert.ok(callsOf('api.threadTurns').some(([id]) => id === 't-hash'));
  location.hash = '';
});

test('what main pushes after boot: prefs, chats, theme, focus, fullscreen, projects and flags', async () => {
  bootImpls({ 'codex.leases': () => Promise.reject(new Error('x')), 'session.withApprovals': () => Promise.reject(new Error('x')) });
  await S.boot();
  await flush();
  listeners['prefs.onChanged']({ set: { fontSize: 30 }, unset: [] });
  assert.equal(st().prefs.fontSize, 30);
  listeners['chats.onChanged']({ id: 'c9', chat: { kind: 'claude', meta: { unread: true } } });
  assert.equal(st().unread.c9, true);
  assert.equal(ownerOf('c9'), 'claude');
  listeners['chats.onReset']({ chats: { r1: { kind: 'claude', meta: { pinned: true } } }, newer: [] });
  assert.deepEqual(st().pinned, { r1: true });
  assert.deepEqual(st().unread, {});
  // none of those went back to main
  assert.equal(callsOf('prefs.patch').length, 1);
  assert.equal(callsOf('chats.patchMeta').length, 0);
  listeners['app.onThemeChanged'](true);
  listeners['win.onFocus'](false);
  listeners['win.onFullscreen'](true);
  listeners['projects.onChanged']({ projects: [{ id: 'p', name: 'P', path: '/p', source: 'sage' }] });
  const rev = st().flagsRev;
  listeners['flags.onChanged']();
  assert.deepEqual([st().dark, st().focused, st().fullscreen, st().flagsRev], [true, false, true, rev + 1]);
  assert.deepEqual(st().savedProjects, [{ id: 'p', name: 'P', roots: [{ path: '/p' }], source: 'sage', codexId: undefined }]);
});

test('a setting or chat change main could not save says so', async () => {
  await S.boot();
  await flush();
  const fail = async () => {
    throw new Error("Error invoking remote method 'prefs:patch': Error: disk full");
  };
  impl['prefs.patch'] = fail;
  impl['chats.patchMeta'] = fail;
  impl['chats.setSegments'] = fail;
  S.setPrefs({ fontSize: 19 });
  set({ pinned: { s1: true, s2: true }, segments: { s1: [{ nativeId: 'n', harness: 'claude', start: 0 }] as any } });
  await flush();
  // two chats failed the same way: one toast
  assert.equal(st().toasts.filter((t) => t.text === "Couldn't save the change to the chat: disk full").length, 1);
  assert.deepEqual(
    st()
      .toasts.slice(-3)
      .map((t) => t.text),
    [
      "Couldn't save the setting: disk full",
      "Couldn't save the chat's harness history: disk full",
      "Couldn't save the change to the chat: disk full",
    ],
  );
});

test('after boot this window sends its own prefs and chat changes to main, and persists its ui state', async () => {
  await S.boot();
  await flush();
  calls.length = 0;
  S.setPrefs({ fontSize: 22 });
  assert.deepEqual(callsOf('prefs.patch'), [[{ fontSize: 22 }, []]]);
  S.setPrefs({});
  assert.equal(callsOf('prefs.patch').length, 1);
  set({ pinned: { a: true }, segments: { a: [{ nativeId: 'b', harness: 'claude', start: 0 }] as any } });
  assert.deepEqual(callsOf('chats.patchMeta'), [['a', { pinned: true }]]);
  assert.deepEqual(callsOf('chats.setSegments'), [['a', [{ nativeId: 'b', harness: 'claude', start: 0 }]]]);
  set({ drafts: { x: { text: '', attachments: [] } } });
  assert.equal(callsOf('chats.patchMeta').length, 1);
  set({ sidebarOpen: false });
  set({ summaryOpen: false });
  mock.timers.tick(250);
  const writes = callsOf('state.write');
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0].sidebarOpen, false);
  assert.equal(writes[0][0].claudeCache.status.state, 'detecting');
  // each persisted key schedules a write
  const keys: any[] = [
    { projects: [] },
    { collapsedProjects: {} },
    { newChatCwd: '/x' },
    { newChatProjectId: 'p' },
    { newChatCloudEnv: { id: 'e', label: 'E' } },
    { codexBin: '/c' },
    { claudeUsage: {} },
    { claude: { ...st().claude, models: [] } },
    { claude: { ...st().claude, status: { ...st().claude.status, usage: {} } } },
    { claude: { ...st().claude, status: { ...st().claude.status, plan: 'pro' } } },
  ];
  for (const k of keys) {
    set(k);
    mock.timers.tick(250);
  }
  assert.equal(callsOf('state.write').length, 1 + keys.length);
});

test('Codex status events from main', async () => {
  await S.boot();
  await flush();
  const on = listeners['codex.onStatus'];
  on({ kind: 'exit', code: 1, signal: null, stderr: 'boom' });
  assert.deepEqual([st().conn, st().connError], ['error', 'Codex app-server exited (1).\nboom']);
  on({ kind: 'exit', code: null, signal: 'SIGKILL', stderr: '', restarting: true });
  assert.match(st().connError!, /SIGKILL/);
  on({ kind: 'error', error: 'bad', restarting: true });
  assert.equal(st().connError, 'bad');
  on({ kind: 'restarting', attempt: 2, inMs: 500 });
  assert.deepEqual(st().codexRestart, { attempt: 2, inMs: 500 });
  on({ kind: 'gaveUp' });
  assert.deepEqual([st().conn, st().codexRestart], ['error', 'gaveUp']);
  // a crashed Codex came back: reload quietly
  on({ kind: 'ready' });
  await flush();
  assert.deepEqual([st().conn, st().codexRestart, st().connError], ['ready', null, null]);
  // started elsewhere while idle: connect
  set({ conn: 'idle' });
  on({ kind: 'started' });
  await flush();
  assert.equal(st().conn, 'ready');
  on({ kind: 'started' });
  on({ kind: 'other' });
});

test('connect fails with the app-server error it already reported, or the thrown one', async () => {
  impl['codex.start'] = () => Promise.reject(new Error('spawn failed'));
  await S.connect();
  assert.deepEqual([st().conn, st().connError], ['error', 'spawn failed']);
  impl['codex.start'] = async () => {
    set({ connError: 'exited 1' });
    throw 'x';
  };
  await S.connect(true);
  assert.equal(st().connError, 'exited 1');
  impl['codex.start'] = () => Promise.reject('plain');
  await S.connect();
  assert.equal(st().connError, 'plain');
  // accounts.apply failing falls back to the list; a failed negotiation leaves compat alone
  impl['codex.start'] = async () => ({ bin: '/b' });
  impl['accounts.apply'] = () => Promise.reject(new Error('x'));
  impl['accounts.list'] = async () => accounts({ active: 'a1' });
  impl['codex.negotiated'] = () => Promise.reject(new Error('x'));
  await S.connect();
  assert.equal(st().accounts.active, 'a1');
  assert.equal(st().codexCompat, null);
  set({ conn: 'idle' });
  await S.ensureCodex();
  assert.equal(st().conn, 'ready');
});

test('connect syncs Codex projects and re-imports from sources the user imported before', async () => {
  set({ prefs: { ...st().prefs, importSync: true, importedSources: ['claude'] }, projects: [{ path: '/w', name: 'w' }] });
  impl['api.projectList'] = async () => ({});
  impl['projects.importCodex'] = async (list: any[]) => ({
    projects: [{ id: 'p', name: 'P', path: '/p', source: 'codex', codexId: 'cx', n: list.length }],
  });
  impl['api.externalConfigDetect'] = async () => ({ items: [{ source: 'claude' }, { source: 'cursor' }] });
  await S.connect();
  await flush(10);
  assert.deepEqual(
    st().savedProjects.map((p) => p.codexId),
    ['cx'],
  );
  assert.deepEqual(callsOf('api.externalConfigDetect'), [[['/w']]]);
  assert.deepEqual(callsOf('api.externalConfigImport'), [[[{ source: 'claude' }]]]);
  // nothing to import, or a detect failure: nothing imported
  calls.length = 0;
  impl['api.externalConfigDetect'] = async () => ({});
  await S.connect();
  await flush(10);
  impl['api.externalConfigDetect'] = () => Promise.reject(new Error('x'));
  await S.connect();
  await flush(10);
  set({ prefs: { ...st().prefs, importSync: false } });
  await S.connect();
  set({ prefs: { ...st().prefs, importSync: true, importedSources: [] } });
  await S.connect();
  await flush(10);
  assert.equal(callsOf('api.externalConfigImport').length, 0);
  // project import failures are recorded in main (a rejection there is ignored)
  impl['api.projectList'] = () => Promise.reject(new Error('no project api'));
  impl['projects.importFailed'] = () => Promise.reject(new Error('x'));
  await projects.syncCodexProjects();
  impl['api.projectList'] = () => Promise.reject('plain');
  await projects.syncCodexProjects();
  await flush();
  assert.deepEqual(callsOf('projects.importFailed'), [['no project api'], ['plain']]);
  // not connected: nothing
  set({ conn: 'connecting' });
  calls.length = 0;
  await projects.syncCodexProjects();
  assert.equal(callsOf('api.projectList').length, 0);
  set({ conn: 'idle' });
  impl['projects.importCodexBackground'] = () => Promise.reject(new Error('x'));
  await projects.syncCodexProjects();
  impl['projects.importCodexBackground'] = async () => ({ projects: [{ id: 'b', name: 'B', path: '/b', source: 'codex' }] });
  await projects.syncCodexProjects();
  assert.deepEqual(
    st().savedProjects.map((p) => p.id),
    ['b'],
  );
});

test('account, rate limits, models and config: a failure leaves the state as it was', async () => {
  impl['api.accountRead'] = async () => ({ account: null, requiresOpenaiAuth: true });
  await connection.refreshAccount();
  assert.equal(st().requiresAuth, true);
  set({ accounts: accounts({ accounts: [{ id: 'a' }] }) });
  await connection.refreshAccount();
  assert.equal(st().requiresAuth, false);
  // with saved accounts, a rate-limit refresh also refreshes their usage
  impl['accounts.refreshUsage'] = async () => accounts({ accounts: [{ id: 'a' }] });
  for (const k of ['api.accountRead', 'api.accountRateLimits', 'api.modelList', 'api.configRead'])
    impl[k] = () => Promise.reject(new Error('x'));
  set({ models: [{ model: 'keep' }] as any, config: { a: 1 }, rateLimits: { r: 1 } as any });
  await Promise.all([connection.refreshAccount(), S.refreshRateLimits(), connection.loadModels(), S.loadConfig()]);
  assert.deepEqual([st().models, st().config, st().rateLimits], [[{ model: 'keep' }], { a: 1 }, { r: 1 }]);
  // a list that failed to load is not "still loading" any more
  assert.equal(st().modelsLoaded, true);
  impl['api.configRead'] = async () => ({ config: { b: 2 } });
  impl['api.accountRateLimits'] = async () => ({ r: 2 });
  await Promise.all([S.loadConfig(), S.refreshRateLimits()]);
  assert.deepEqual([st().config, st().rateLimits], [{ b: 2 }, { r: 2 }]);
});

// moved from tests/codexUsageUI.test.ts, which mocks the store for the usage UI
test('the store adapter refreshes account quotas even when app-server metadata is unavailable', async () => {
  for (const managed of [true, false])
    for (const mainError of [true, false])
      for (const accountError of [true, false]) {
        resetAll();
        set({ accounts: accounts({ accounts: managed ? [{ id: 'a' }] : [] }), rateLimits: null });
        impl['api.accountRateLimits'] = async () => {
          if (mainError) throw new Error('unavailable');
          return { r: 1 };
        };
        impl['accounts.refreshUsage'] = async () => {
          if (accountError) throw new Error('unavailable');
          return accounts({ accounts: [{ id: 'a' }] });
        };
        await S.refreshRateLimits();
        assert.equal(callsOf('accounts.refreshUsage').length > 0, managed);
        assert.equal(st().rateLimits !== null, !mainError);
      }
});

test('loadThreads lists Codex chats, keeps archived ones out and local ones in, and pages', async () => {
  set({ claudeArchived: { arch: 1 }, threadOrder: ['local', 'ghost'], threads: { local: { id: 'local' } as any } });
  impl['api.threadList'] = async (p: any) =>
    p.cursor ? { data: [{ id: 'b' }, { id: 'a' }], nextCursor: null } : { data: [{ id: 'a' }, { id: 'arch' }], nextCursor: 'n' };
  await S.loadThreads();
  assert.deepEqual(st().threadOrder, ['local', 'a']);
  assert.deepEqual(
    callsOf('claude.rememberClaudeThread').map(([t]) => t.id),
    ['arch'],
  );
  await S.loadThreads(true);
  assert.deepEqual(st().threadOrder, ['local', 'a', 'b']);
  assert.equal(callsOf('api.threadList')[1][0].cursor, 'n');
  const err = mock.method(console, 'error', () => {});
  impl['api.threadList'] = () => Promise.reject(new Error('down'));
  await S.loadThreads();
  assert.equal(err.mock.callCount(), 1);
  err.mock.restore();
  // a next page that fails (Show more, or a scroll to the end) says why
  await S.loadThreads(true);
  assert.equal(st().toasts.at(-1)?.text, "Couldn't load more chats: down");
  assert.deepEqual(st().threadOrder, ['local', 'a', 'b']);
});

test('searchThreads merges every source and drops the ones that failed', async () => {
  impl['api.threadList'] = async () => ({ data: [{ id: 'a' }, { id: 'b' }] });
  impl['api.threadSearch'] = async () => ({ data: [{ thread: { id: 'b' } }, { thread: { id: 'c' } }] });
  impl['claude.searchClaudeThreads'] = async () => [{ id: 'cl' }];
  impl['acp.searchAcpThreads'] = () => Promise.reject(new Error('x'));
  assert.deepEqual(await S.searchThreads('q'), { codex: [{ id: 'a' }, { id: 'b' }, { id: 'c' }], claude: [{ id: 'cl' }], sage: [] });
});

test('sendFeedback attaches the chat only when it is on Codex', async () => {
  set({
    segments: {
      sw: [{ nativeId: 'n2', harness: 'codex', start: 0 }] as any,
      k: [{ nativeId: 'acp:kimi:1', harness: 'codex', start: 0 }] as any,
    },
  });
  S.sendFeedback('sw', 'bug', 'r', true);
  S.sendFeedback('k', 'bug', null, false);
  S.sendFeedback(null, 'good', null, false);
  assert.deepEqual(
    callsOf('api.feedbackUpload').map(([p]) => p.threadId),
    ['n2', null, null],
  );
});

test('cloud tasks and the local project list', async () => {
  impl['cloud.list'] = async () => ({});
  await S.loadCloudTasks();
  assert.deepEqual(st().cloudTasks, []);
  impl['cloud.list'] = async () => ({ tasks: [{ id: 't' }] });
  await S.loadCloudTasks();
  assert.deepEqual(st().cloudTasks, [{ id: 't' }]);
  impl['cloud.list'] = () => Promise.reject(new Error('x'));
  await S.loadCloudTasks();
  impl['projects.list'] = () => Promise.reject(new Error('x'));
  await projects.loadProjects();
  assert.deepEqual(st().cloudTasks, [{ id: 't' }]);
});

test('projects are made, renamed, removed and moved here and, when connected, in Codex', async () => {
  set({ conn: 'ready', prefs: { ...st().prefs, hiddenFolders: ['/w/new', '/other'] } });
  impl['api.projectCreate'] = async () => ({ project: { id: 'cx1' } });
  impl['projects.add'] = async () => 'p-new';
  impl['projects.list'] = async () => ({ projects: [{ id: 'p-new', name: 'new', path: '/w/new', source: 'sage' }] });
  impl['projects.linkCodex'] = async () => ({ id: 'p-new' });
  assert.equal(await S.createProject('/w/new'), 'p-new');
  assert.deepEqual(callsOf('api.projectCreate'), [['new', '/w/new']]);
  assert.deepEqual(callsOf('projects.add'), [[{ path: '/w/new', name: undefined }]]);
  assert.deepEqual(callsOf('projects.linkCodex'), [['p-new', 'cx1']]);
  assert.deepEqual(st().prefs.hiddenFolders, ['/other']);
  // an existing project is reused
  set({
    savedProjects: [
      { id: 'p1', name: 'One', roots: [{ path: '/w/one' }], source: 'codex', codexId: 'c1' },
      { id: 'p2', name: 'Two', roots: [{ path: '/w/two' }], source: 'sage' },
    ],
  });
  assert.equal(await S.createProject('/w/one'), 'p1');
  // Codex answering with a bare id, or failing; adding failing here
  impl['api.projectCreate'] = async () => ({ id: 'cx2' });
  impl['projects.list'] = async () => ({
    projects: st().savedProjects.map((p) => ({ id: p.id, name: p.name, path: p.roots[0].path, source: p.source, codexId: p.codexId })),
  });
  await S.createProject('/w/b', 'B');
  assert.deepEqual(callsOf('projects.linkCodex').at(-1), ['p-new', 'cx2']);
  impl['api.projectCreate'] = () => Promise.reject(new Error('x'));
  impl['projects.add'] = () => Promise.reject(new Error('disk full'));
  assert.equal(await S.createProject('/w/c'), null);
  impl['projects.add'] = () => Promise.reject('plain');
  await S.createProject('/w/c');
  assert.deepEqual(
    st().toasts.map((t) => t.text),
    ["Couldn't add project: disk full", "Couldn't add project: plain"],
  );
  set({ conn: 'idle' });
  impl['projects.add'] = async () => 'p3';
  impl['projects.list'] = async () => ({ projects: [{ id: 'p3', name: 'd', path: '/w/d', source: 'sage' }] });
  await S.createProject('/w/d');
  assert.equal(callsOf('projects.add').at(-1)![0].codexId, undefined);
  // rename / delete / move follow in Codex only for Codex projects while connected
  set({
    conn: 'ready',
    savedProjects: [
      { id: 'p1', name: 'One', roots: [{ path: '/w/one' }], source: 'codex', codexId: 'c1' },
      { id: 'p2', name: 'Two', roots: [{ path: '/w/two' }], source: 'sage' },
    ],
  });
  impl['projects.list'] = async () => ({
    projects: st().savedProjects.map((p) => ({ id: p.id, name: p.name, path: p.roots[0].path, source: p.source, codexId: p.codexId })),
  });
  calls.length = 0;
  impl['api.projectUpdate'] = () => Promise.reject(new Error('x'));
  impl['api.projectDelete'] = () => Promise.reject(new Error('x'));
  impl['api.projectMove'] = () => Promise.reject(new Error('x'));
  await S.renameProject('p1', 'Uno');
  await S.renameProject('p2', 'Dos');
  await S.deleteProject('p1');
  await S.deleteProject('p2');
  await S.moveProject('p1', null);
  await S.moveProject('p1', 'p2');
  await S.moveProject('p1', 'p1');
  await S.moveProject('p2', null);
  set({ conn: 'idle' });
  await S.renameProject('p1', 'x');
  await S.deleteProject('p1');
  await S.moveProject('p1', null);
  await flush();
  assert.deepEqual(callsOf('api.projectUpdate'), [['c1', 'Uno']]);
  assert.deepEqual(callsOf('api.projectDelete'), [['c1']]);
  assert.deepEqual(callsOf('api.projectMove'), [
    ['c1', null],
    ['c1', 'c1'],
  ]);
  assert.equal(callsOf('projects.rename').length, 3);
  // unhideFolder with nothing hidden
  set({ prefs: { ...st().prefs, hiddenFolders: undefined as any } });
  S.unhideFolder('/x');
});

test('a sign-in whose browser did not open gives the address', async () => {
  impl['api.loginChatgpt'] = async () => ({ loginId: 'l', authUrl: 'https://auth' });
  impl['shell.openExternal'] = async () => {
    throw new Error('no browser');
  };
  await S.login();
  await flush();
  assert.equal(st().toasts.at(-1)!.text, "Couldn't open the browser to sign in (no browser): https://auth");
});

test('sign-in and sign-out', async () => {
  impl['api.loginChatgpt'] = async () => ({ loginId: 'l', authUrl: 'https://auth' });
  await S.login();
  assert.deepEqual(st().loginPending, { loginId: 'l', authUrl: 'https://auth' });
  assert.deepEqual(callsOf('shell.openExternal'), [['https://auth']]);
  impl['api.loginChatgpt'] = async () => ({ loginId: 'l2' });
  await S.login();
  assert.equal(callsOf('shell.openExternal').length, 1);
  await (await import('../src/store/accounts.ts')).logout();
  assert.equal(callsOf('api.logout').length, 1);
  set({ accounts: accounts({ active: 'a1' }) });
  impl['accounts.remove'] = async () => accounts({ active: 'a2' });
  await (await import('../src/store/accounts.ts')).logout();
  assert.deepEqual(callsOf('accounts.remove'), [['a1']]);
  assert.equal(st().accounts.active, 'a2');
});

test('account actions update the accounts from main; failures say why without the IPC prefix', async () => {
  const next = (active: string) => async () => accounts({ active });
  impl['accounts.switchTo'] = next('s');
  await S.switchAccount('s');
  assert.equal(st().accounts.active, 's');
  impl['accounts.switchTo'] = () => Promise.reject(new Error("Error invoking remote method 'accounts:switch': Error: nope"));
  await S.switchAccount('x');
  impl['accounts.switchTo'] = () => Promise.reject('flat');
  await S.switchAccount('x');
  impl['accounts.setMode'] = next('m');
  await S.setCodexMode('apiKey');
  impl['accounts.setMode'] = () => Promise.reject(new Error("Error invoking remote method 'x': no key"));
  await assert.rejects(S.setCodexMode('apiKey'), /^Error: no key$/);
  impl['accounts.setMode'] = () => Promise.reject('flat');
  await assert.rejects(S.setCodexMode('apiKey'), /flat/);
  impl['accounts.addApiKey'] = next('k');
  await S.addCodexApiKey('sk', 'https://x');
  assert.deepEqual(callsOf('accounts.addApiKey')[0], ['sk', 'https://x', null]);
  impl['accounts.addApiKey'] = () => Promise.reject(new Error('bad key'));
  await assert.rejects(S.addCodexApiKey('sk', undefined, 'r'), /bad key/);
  impl['accounts.login'] = next('l');
  await S.addAccount();
  await S.addAccount('t');
  assert.deepEqual(callsOf('accounts.login'), [[null], ['t']]);
  impl['accounts.login'] = () => Promise.reject(new Error('cancelled'));
  await S.addAccount();
  impl['accounts.login'] = () => Promise.reject('flat');
  await S.addAccount();
  assert.deepEqual(
    st().toasts.map((t) => t.text),
    ['nope', 'flat', 'cancelled', 'flat'],
  );
  impl['accounts.cancelLogin'] = next('c');
  await S.cancelAccountLogin();
  impl['accounts.remove'] = next('r');
  await S.removeAccount('x');
  impl['accounts.refreshUsage'] = next('u');
  await S.refreshAccountsUsage();
  assert.deepEqual(callsOf('accounts.refreshUsage'), [['surface']]);
  impl['accounts.setAutoSwitch'] = next('a');
  await S.setAutoSwitch(false);
  impl['accounts.setPool'] = next('p');
  await S.setAccountPool('single');
  impl['accounts.pinChat'] = next('pin');
  set({ segments: { c: [{ nativeId: 'n', harness: 'codex', start: 0 }] as any } });
  await S.pinCodexChat('c', 'a1');
  assert.deepEqual(callsOf('accounts.pinChat'), [['n', 'a1']]);
  assert.equal(st().accounts.active, 'pin');
});

test('account events: changes, switches with a note in the chat, resumes and sign-in results (expiry: signInAgain.test.ts)', async () => {
  await S.boot();
  await flush();
  const on = listeners['accounts.onEvent'];
  calls.length = 0;
  set({ accounts: accounts({ active: 'a' }) });
  on({ type: 'changed', state: accounts({ active: 'a' }) });
  on({ type: 'changed', state: accounts({ active: 'b' }) });
  set({ accounts: accounts({ active: null }) });
  on({ type: 'changed', state: accounts({ active: 'c' }) });
  await flush();
  assert.equal(callsOf('api.accountRead').length, 1);
  set({ toasts: [] });
  // no chat with turns: a toast
  on({ type: 'event', kind: 'switched', reason: 'limit', from: 'x@y', to: null, threadId: null });
  on({ type: 'event', kind: 'moved', reason: 'expired', from: null, to: 'z@y', threadId: 'nochat' });
  on({ type: 'event', kind: 'switched', reason: 'other', from: 'a', to: 'b' });
  assert.deepEqual(
    st().toasts.map((t) => t.text),
    [
      'Switched to another account — x@y reached its usage limit',
      'Moved this chat to z@y — another account needs to sign in again',
      "Switched to b — a isn't available",
    ],
  );
  // a chat with turns gets a note instead
  set({ toasts: [], runtime: { ch: { turns: [{ id: 't', items: [] }] } as any } });
  on({ type: 'event', kind: 'moved', reason: 'limit', from: 'a', to: 'b', threadId: 'ch' });
  assert.equal(st().toasts.length, 0);
  assert.equal(st().chatNotes.ch.length, 1);
  // resume: the window says where the chat went on; main continues it (once, with or without a window)
  on({ type: 'event', kind: 'resume', threadId: 'ch', from: 'a', to: 'b' });
  on({ type: 'event', kind: 'resume', threadId: 'gone', from: null, to: null });
  assert.match(st().toasts[0].text, /^Continuing on another account/);
  mock.timers.tick(800);
  await flush();
  assert.deepEqual(callsOf('proxy.send'), []);
  set({ toasts: [] });
  on({ type: 'event', kind: 'exhausted' });
  st().toasts[0].action!.run();
  assert.deepEqual(st().route, { name: 'settings', section: 'account' });
  on({ type: 'event', kind: 'signedIn', email: 'e@x', mismatch: 'o@x', added: true });
  on({ type: 'event', kind: 'signedIn', email: 'e@x', mismatch: 'o@x', added: false });
  on({ type: 'event', kind: 'signedIn', email: 'e@x', added: true });
  on({ type: 'event', kind: 'signedIn', email: null, added: false });
  on({ type: 'event', kind: 'loginFailed', error: 'denied' });
  on({ type: 'event', kind: 'unknown' });
  assert.deepEqual(
    st()
      .toasts.slice(1)
      .map((t) => t.text),
    [
      'Signed in as e@x, not o@x. It was added as a new account.',
      'Signed in as e@x, not o@x. ',
      'Added e@x',
      'Signed in again as another account',
      'denied',
    ],
  );
});

test('sessions: approvals from main become cards, and a crash ends the chat turn', async () => {
  await S.boot();
  await flush();
  impl['claude.resolveClaudeRequest'] = () => {};
  set({ threads: { c: { id: 'c', cwd: '/w', status: { type: 'active' } } as any } });
  const approval = { id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'c', command: 'ls' } };
  sessions.useSessions.setState({ sessions: { c: { ...sessions.sessionOf('c'), rev: 1, approvals: [approval] } } });
  assert.equal(st().pending.length, 1);
  assert.equal(st().pending[0].threadId, 'c');
  // the same approvals list again: nothing changes
  const pending = st().pending;
  sessions.useSessions.setState((s) => ({ sessions: { ...s.sessions } }));
  assert.equal(st().pending, pending);
  // cleared in main: the card goes
  sessions.useSessions.setState({ sessions: { c: { ...sessions.sessionOf('c'), approvals: [] } } });
  assert.deepEqual(st().pending, []);
  sessions.useSessions.setState({
    sessions: { c: { ...sessions.sessionOf('c'), approvals: [] }, d: { ...sessions.sessionOf('d'), approvals: [] } },
  });
  // crash: the running turn fails with the reason and the cards go
  set({
    pending: [{ id: 1, threadId: 'c' } as any, { id: 2, threadId: 'x' } as any],
    runtime: {
      c: {
        activeTurnId: 't2',
        turns: [
          { id: 't1', status: 'completed' },
          { id: 't2', status: 'inProgress' },
        ],
      } as any,
    },
  });
  sessions.useSessions.setState({ sessions: { c: { ...sessions.sessionOf('c'), turn: 'crashed', crashed: 'Claude quit' } } });
  assert.deepEqual(
    st().pending.map((p) => p.id),
    [2],
  );
  assert.deepEqual((st().threads.c as any).status, { type: 'idle' });
  assert.deepEqual(
    st().runtime.c.turns.map((t) => [t.status, t.error?.message]),
    [
      ['completed', undefined],
      ['failed', 'Claude quit'],
    ],
  );
  assert.equal(st().runtime.c.activeTurnId, null);
  // already crashed: nothing again
  sessions.useSessions.setState((s) => ({ sessions: { ...s.sessions } }));
  // no active turn: the last unfinished one, with a default reason; historical failures are not crash owners
  set({
    runtime: {
      e: { activeTurnId: null, turns: [{ id: 'f', status: 'inProgress', error: null }] } as any,
      g: { activeTurnId: null, turns: [{ id: 'k', status: 'completed' }] } as any,
    },
  });
  sessions.useSessions.setState((s) => ({
    sessions: {
      ...s.sessions,
      e: { ...sessions.sessionOf('e'), turn: 'crashed', crashed: null },
      g: { ...sessions.sessionOf('g'), turn: 'crashed', crashed: 'off' },
      h: { ...sessions.sessionOf('h'), turn: 'crashed', crashed: null },
    },
  }));
  assert.deepEqual(
    st().runtime.e.turns.map((t) => [t.status, t.error?.message]),
    [['failed', 'The harness quit while working']],
  );
  assert.equal(st().toasts.at(-1)!.text, 'off');
  set({ runtime: { i: { activeTurnId: null, turns: [{ id: 'k', status: 'inProgress' }] } as any } });
  sessions.useSessions.setState((s) => ({
    sessions: { ...s.sessions, i: { ...sessions.sessionOf('i'), turn: 'crashed', crashed: null } },
  }));
  assert.equal(st().runtime.i.turns[0].status, 'failed');
});

test('resolveRequest answers the harness that asked', () => {
  set({
    pending: [
      { id: 'cperm-1', method: 'x' },
      { id: 2, method: 'acp/permission' },
      { id: 3, method: 'item/x' },
    ] as any,
  });
  S.resolveRequest('cperm-1', 'ok');
  S.resolveRequest(2, 'ok');
  S.resolveRequest(3, 'ok');
  // a card this window no longer shows goes nowhere: never a stray answer on the Codex app-server
  S.resolveRequest(4, 'ok');
  S.resolveRequest('cperm-gone', 'ok');
  assert.equal(callsOf('claude.resolveClaudeRequest').length, 1);
  assert.equal(callsOf('acp.resolveAcpRequest').length, 1);
  assert.deepEqual(callsOf('codex.respondToCodex'), [[3, 'ok']]);
  assert.deepEqual(st().pending, []);
});

test('an answer that never reached main puts its card back while main still has it, and says why', async () => {
  const fail = async () => {
    throw new Error("Error invoking remote method 'codex:respond': Error: main is gone");
  };
  impl['codex.respondToCodex'] = fail;
  impl['claude.resolveClaudeRequest'] = fail;
  // main still holds approvals 5, 6 and cperm-7 for chat c; 9 is gone (main took that answer before failing)
  const open = (id: string | number) => ({ id, method: 'sage/x', params: {} });
  sessions.useSessions.setState({
    sessions: { c: { ...sessions.sessionOf('c'), rev: 1, approvals: [open(5), open(6), open('cperm-7')] } as any },
  });
  const card = (id: string | number, method = 'item/x') => ({ id, method, threadId: 'c' }) as any;
  set({ pending: [card(5), card(6), card('cperm-7', 'x'), card(9), { id: 10, method: 'item/x', threadId: null }] as any });
  S.resolveRequest(5, 'ok');
  // a card already back is not added twice
  S.resolveRequest(6, 'ok');
  set((s) => ({ pending: [...s.pending, card(6)] }));
  S.resolveRequest('cperm-7', 'ok');
  S.resolveRequest(9, 'ok');
  S.resolveRequest(10, 'ok');
  // no card here (another window's answer): nothing is sent, and it reads as already answered
  S.resolveRequest(8, 'ok');
  await flush();
  assert.deepEqual(
    st().pending.map((p: any) => p.id),
    [6, 5, 'cperm-7'],
  );
  assert.deepEqual(
    st()
      .toasts.slice(-6)
      .map((t) => [t.text, t.kind]),
    [['Already answered', 'info'], ...Array(5).fill(["Couldn't send your answer: main is gone", 'error'])],
  );
});

test('a rejected local project write never creates a native project', async () => {
  set({ conn: 'ready', prefs: { ...st().prefs, hiddenFolders: ['/owned/project'] } });
  impl['projects.add'] = async () => {
    throw new Error('Project list was saved by a newer version');
  };
  impl['api.projectCreate'] = async () => ({ project: { id: 'orphan' } });
  assert.equal(await S.createProject('/owned/project'), null);
  assert.deepEqual(callsOf('api.projectCreate'), []);
  assert.match(st().toasts.at(-1)!.text, /newer version/);
  assert.deepEqual(st().prefs.hiddenFolders, ['/owned/project']);
});

test('project creation keeps its durable local result when optional native creation or linking fails', async () => {
  set({ conn: 'ready' });
  for (const mode of ['no-id', 'native-failure', 'link-failure']) {
    calls.length = 0;
    let adds = 0;
    impl['projects.add'] = async () => {
      adds++;
      return 'durable-local';
    };
    impl['projects.list'] = async () => ({ projects: [{ id: 'durable-local', path: `/owned/${mode}`, name: mode, source: 'sage' }] });
    impl['projects.linkCodex'] = async () => {
      if (mode === 'link-failure') throw new Error('link refused');
      return { id: 'durable-local' };
    };
    impl['api.projectCreate'] = async () => {
      assert.equal(adds, 1, 'native creation follows the durable write');
      if (mode === 'native-failure') throw new Error('native refused');
      return mode === 'no-id' ? {} : { project: { id: 'native' } };
    };
    assert.equal(await S.createProject(`/owned/${mode}`), 'durable-local');
    assert.equal(callsOf('projects.add').length, 1);
    assert.equal(callsOf('projects.linkCodex').length, mode === 'link-failure' ? 1 : 0);
  }
  calls.length = 0;
  impl['projects.add'] = async () => null;
  assert.equal(await S.createProject('/refused'), null);
  assert.deepEqual(callsOf('api.projectCreate'), []);
});

test('deleting a project while native creation waits cannot resurrect it or return a deleted id', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'project-create-race-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const { ProjectsStore } = createRequire(import.meta.url)('../electron/platform/projects.cjs');
  const main = new ProjectsStore(path.join(dir, 'projects.json'));
  set({ conn: 'ready' });
  impl['projects.add'] = async (opts: any) => main.add(opts);
  impl['projects.list'] = async () => main.list();
  impl['projects.linkCodex'] = async (id: string, nativeId: string) => main.linkCodex(id, nativeId);
  let release!: (value: any) => void;
  impl['api.projectCreate'] = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const creating = S.createProject('/owned/racing');
  await flush();
  const admitted = main.list().projects[0].id;
  main.remove(admitted);
  main.importCodex([{ id: 'late-native', roots: [{ path: '/owned/racing' }] }]);
  assert.deepEqual(main.list().projects, [], 'an import before the native reply respects deletion');
  release({ project: { id: 'late-native' } });
  assert.equal(await creating, null);
  assert.deepEqual(main.list().projects, []);
  main.importCodex([{ id: 'late-native', roots: [{ path: '/owned/racing' }] }]);
  assert.deepEqual(main.list().projects, [], 'a later native import does not undo deletion');
});

test('a saved project with an unavailable final list is reported without returning an unverified id', async () => {
  set({ conn: 'idle' });
  impl['projects.add'] = async () => 'saved';
  impl['projects.list'] = async () => {
    throw new Error('list unavailable');
  };
  assert.equal(await S.createProject('/owned/saved'), null);
  assert.match(st().toasts.at(-1)!.text, /Project saved.*could not be refreshed/);
});
