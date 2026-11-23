// Codex adapter connection cases using the shared scripted app-server and session fixtures.
import { test, assert, require, thread, setup, wait, crash, inits } from './fixture.ts';
import { waitFor } from '../waitFor.ts';

export function registerInitialize() {
  test('initialize goes out once per process, before any request, followed by initialized', async () => {
    const { a, server } = setup({ 'thread/list': () => ({ data: [] }) });
    await Promise.all([a.request('thread/list', {}), a.request('thread/list', {}), a.initialize()]);
    assert.deepEqual(server.methods(), ['initialize', 'initialized', 'thread/list', 'thread/list']);
    assert.equal(server.sent[0].params.clientInfo.name, 'sage_codex_desktop');
    // the process went away: requests fail at once until a window connects again, which initializes the new one
    server.emit({ kind: 'exit', code: 1, signal: null, stderr: '' });
    await assert.rejects(a.request('thread/list', {}), /isn't connected/);
    await a.connect();
    await a.request('thread/list', {});
    assert.deepEqual(server.methods().slice(4), ['initialize', 'initialized', 'thread/list']);
  });
}

export function registerConnectionRecovery() {
  test('each thread the adapter starts or resumes gets its sage-mcp; a resume rotates the token, an exit ends it', async () => {
    const { CodexToolInjection } = require('../../../electron/capabilities/channels/codexConfig.cjs');
    const { ToolSessions } = require('../../../electron/capabilities/contract/session.cjs');
    const sessions = new ToolSessions();
    const tools = new CodexToolInjection({ sessions, command: '/bin/sage-mcp', socketPath: '/tmp/s.sock', harnessPid: () => 42 });
    const { a, server } = setup(
      {
        'thread/start': () => ({ thread: thread('t9') }),
        'config/read': () => ({ config: { mcp_servers: { node_repl: { command: 'x' } } } }),
      },
      { tools },
    );
    await a.startThread({ cwd: '/w' });
    const start = server.sent.find((m) => m.method === 'thread/start');
    // the user's own node_repl is switched off for the thread (X14)
    assert.deepEqual(start.params.config.mcp_servers.node_repl, { enabled: false });
    const [name] = Object.keys(start.params.config.mcp_servers);
    assert.match(name, /^sage_/);
    assert.equal(start.params.config.plugins['unified-computer-use@openai-bundled'].enabled, false);
    const first = start.params.config.mcp_servers[name].env.SAGE_MCP_TOKEN;
    // unloaded, then resumed for a turn: a new token for the same thread
    server.notify('thread/closed', { threadId: 't9' });
    await a.ensureResumed('t9');
    const resume = server.sent.find((m) => m.method === 'thread/resume');
    const again = resume.params.config.mcp_servers[name] as any;
    assert.notEqual(again.env.SAGE_MCP_TOKEN, first);
    // the app-server went away: so did the thread's server
    server.emit({ kind: 'exit', code: 1, signal: null, stderr: '' });
    assert.equal(tools.loaded.size, 0);
  });

  test('a crashed app-server comes back after a backoff; one that keeps crashing is given up on after the last try', async () => {
    const { a, server, statuses } = setup({}, { backoff: [5, 10, 20] });
    await a.connect();
    crash(server);
    assert.deepEqual(statuses, [
      { kind: 'exit', code: 1, signal: null, stderr: 'boom', restarting: true },
      { kind: 'restarting', attempt: 1, inMs: 5 },
    ]);
    // nothing happens before the wait is over
    assert.equal(inits(server), 1);
    // each restart is awaited until it is ready: a fixed sleep can end before the fake answers on a busy machine
    const ready = async (n: number) => {
      await waitFor(() => inits(server) === n && statuses.at(-1)?.kind === 'ready', `restart ${n} to be ready`);
      assert.equal(inits(server), n);
      assert.deepEqual(statuses.at(-1), { kind: 'ready' });
    };
    await ready(2);
    // it quits again right away: the waits grow, then the windows are told to ask the user
    crash(server);
    await ready(3);
    crash(server);
    await ready(4);
    assert.deepEqual(
      statuses.filter((s) => s.kind === 'restarting').map((s) => s.inMs),
      [5, 10, 20],
    );
    assert.equal(inits(server), 4);
    crash(server);
    // it named the copy it gave up on (each of these quit after it answered, so none was set aside)
    assert.deepEqual(statuses.at(-1), { kind: 'gaveUp', copy: { path: 'codex', version: null, via: null, from: null }, pinned: false });
    await wait(40);
    assert.equal(inits(server), 4);
  });

  test('a Codex that never started (no binary) or was stopped on purpose is not restarted', async () => {
    const { a, server, statuses } = setup({}, { backoff: [5] });
    server.emit({ kind: 'error', error: 'spawn codex ENOENT' });
    await wait(20);
    assert.deepEqual(statuses, [{ kind: 'error', error: 'spawn codex ENOENT', restarting: false }]);
    // connected again (a window's Restart): every window hears it is ready, not only the one that asked
    await a.connect();
    assert.deepEqual(statuses.at(-1), { kind: 'ready' });
    // connected while up: nothing to tell
    await a.connect();
    server.emit({ kind: 'stopped' });
    await wait(20);
    assert.equal(statuses.length, 2);
  });
}

export function registerProtocol() {
  test('WP5-20: each app-server is negotiated once: its version from userAgent, and the probes', async () => {
    const { a, events } = setup(
      { initialize: () => ({ userAgent: 'sage_codex_desktop/0.170.0 (Mac OS)', codexHome: '/h' }) },
      {
        probe: async (request: any) => (
          await request('collaborationMode/list', {}), { probes: { 'codex.collaborationModes': true }, flags: {} }
        ),
      },
    );
    const n = await a.negotiation();
    assert.deepEqual(n, { cliVersion: '0.170.0', versionStatus: 'unverified', probes: { 'codex.collaborationModes': true }, flags: {} });
    assert.deepEqual(events.find((x) => x.e.kind === 'negotiated')!.e.negotiated, n);
  });

  test('thread/start, fork and resume get the model provider even without sage-mcp (a real app-server refuses a resume without it, #2201)', async () => {
    const frag = { modelProvider: 'sage_x', config: { model_providers: { sage_x: { name: 'N' } } } };
    const { a, server } = setup(
      { 'thread/start': () => ({ thread: thread('t1') }), 'thread/fork': () => ({ thread: thread('t2') }) },
      { provider: () => frag },
    );
    await a.request('thread/start', { cwd: '/w' });
    await a.request('thread/fork', { threadId: 't1' });
    const start = server.sent.find((m) => m.method === 'thread/start');
    assert.equal(start.params.modelProvider, 'sage_x');
    assert.equal(start.params.cwd, '/w');
    assert.equal(server.sent.find((m) => m.method === 'thread/fork').params.modelProvider, 'sage_x');
    const own = setup({ 'thread/start': () => ({ thread: thread('t3') }) }, { provider: () => null });
    await own.a.request('thread/start', { cwd: '/w' });
    assert.equal(own.server.sent.find((m) => m.method === 'thread/start').params.modelProvider, undefined);
  });

  test("thread/start carries its folder's trust instead of the app-server writing the user's config (#1346); the user's own entries win", async () => {
    const trustOf = (server: any) => server.sent.find((m: any) => m.method === 'thread/start').params.config?.projects;
    // no sage-mcp: still carried; the config is read first
    const plain = setup({
      'thread/start': () => ({ thread: thread('t1') }),
      'config/read': () => ({ config: { projects: { '/mine': { trust_level: 'untrusted' } } } }),
    });
    await plain.a.request('thread/start', { cwd: '/w', sandbox: 'workspace-write' });
    assert.deepEqual(trustOf(plain.server), { '/w': { trust_level: 'trusted' } });
    assert.ok(plain.server.methods().indexOf('config/read') < plain.server.methods().indexOf('thread/start'));
    // a folder the user's config decides, and a read-only thread, are left as they are
    await plain.a.request('thread/start', { cwd: '/mine/app', sandbox: 'workspace-write' });
    await plain.a.request('thread/start', { cwd: '/ro', sandbox: 'read-only' });
    assert.deepEqual(
      plain.server.sent.filter((m: any) => m.method === 'thread/start').map((m: any) => m.params.config?.projects),
      [{ '/w': { trust_level: 'trusted' } }, undefined, undefined],
    );
    // fork and resume are not starts: no folder given, nothing added
    const other = setup({ 'thread/fork': () => ({ thread: thread('t2') }) });
    await other.a.request('thread/fork', { threadId: 't1' });
    assert.equal(other.server.sent.find((m: any) => m.method === 'thread/fork').params.config, undefined);
    // an unreadable config: the thread still carries its trust, and the read is tried again at the next start
    let reads = 0;
    const broken = setup({
      'thread/start': () => ({ thread: thread('t3') }),
      'config/read': () => {
        reads++;
        throw new Error('no config');
      },
    });
    await broken.a.request('thread/start', { cwd: '/w' });
    await broken.a.request('thread/start', { cwd: '/w2' });
    assert.equal(reads, 2);
    assert.deepEqual(trustOf(broken.server), { '/w': { trust_level: 'trusted' } });
  });

  test('named calls: each one is its app-server request, a chat takes its thread from nativeOf, and only listed names run', async () => {
    const seen: [string, any][] = [];
    const reply = (method: string, result: any = {}) => [method, (p: any) => (seen.push([method, p]), result)] as const;
    const { a } = setup(
      Object.fromEntries([
        reply('account/read', { account: null, requiresOpenaiAuth: true }),
        reply('model/list', { data: [] }),
        reply('configRequirements/read', { requirements: null }),
        reply('thread/list', { data: [] }),
        reply('thread/search', { data: [] }),
        reply('thread/turns/list', { data: [], nextCursor: null }),
        reply('thread/attachment/list', { data: [], nextCursor: null }),
        reply('thread/goal/get', { goal: null }),
        reply('thread/backgroundTerminals/list', { terminals: [] }),
        reply('thread/archive'),
        reply('project/create', { project: { id: 'p1' } }),
        reply('project/move'),
        reply('account/login/start', { type: 'chatgpt', loginId: 'l', authUrl: 'u' }),
        reply('account/login/cancel', { status: 'canceled' }),
        reply('configRequirements/read', { requirements: null }),
      ]),
      { segments: { chat1: 'seg2' } },
    );
    assert.deepEqual(await a.api('accountRead', []), { account: null, requiresOpenaiAuth: true });
    await a.api('modelList', []);
    assert.deepEqual(await a.api('configRequirementsRead', []), { requirements: null });
    await a.api('threadList', [{ limit: 100, cursor: null, sortKey: 'updated_at' }]);
    await a.api('threadSearch', ['needle', 12]);
    await a.api('threadTurns', ['t1', { limit: 30, itemsView: 'full' }]);
    assert.deepEqual(await a.api('threadAttachments', ['t1', 'next-page']), { data: [], nextCursor: null });
    // a chat's own thread is the one asked about, not the chat's id
    await a.api('threadGoal', ['chat1']);
    await a.api('backgroundTerminals', ['chat1']);
    await a.api('threadArchive', ['t9']);
    await a.api('projectCreate', ['Proj', '/work/proj']);
    await a.api('projectMove', ['p1', undefined]);
    await a.api('loginChatgpt', []);
    await a.api('loginCancel', ['login-1']);
    assert.deepEqual(await a.api('configRequirementsRead', []), { requirements: null });
    const at = (m: string) => seen.find(([x]) => x === m)![1];
    assert.deepEqual(at('configRequirements/read'), {});
    assert.deepEqual(at('account/login/cancel'), { loginId: 'login-1' });
    assert.deepEqual(at('account/read'), { refreshToken: false });
    assert.deepEqual(at('model/list'), { includeHidden: false });
    assert.deepEqual(at('thread/list'), { limit: 100, cursor: null, sortKey: 'updated_at' });
    assert.deepEqual(at('thread/search'), { searchTerm: 'needle', limit: 12, sortKey: 'updated_at' });
    assert.deepEqual(at('thread/turns/list'), { threadId: 't1', limit: 30, itemsView: 'full' });
    assert.deepEqual(at('thread/attachment/list'), { threadId: 't1', cursor: 'next-page', limit: 100 });
    assert.deepEqual(at('thread/goal/get'), { threadId: 'seg2' });
    assert.deepEqual(at('thread/backgroundTerminals/list'), { threadId: 'seg2' });
    assert.deepEqual(at('thread/archive'), { threadId: 't9' });
    assert.deepEqual(at('project/create').roots, [{ path: '/work/proj' }]);
    assert.equal(typeof at('project/create').idempotencyKey, 'string');
    assert.deepEqual(at('project/move'), { projectId: 'p1', beforeProjectId: null });
    assert.deepEqual(at('account/login/start'), { type: 'chatgpt' });
    // only what is listed: not a method of the adapter, and not an app-server method by name
    await assert.rejects(a.api('request', ['thread/list', {}]), /Unknown Codex call/);
    await assert.rejects(a.api('constructor', []), /Unknown Codex call/);
  });
}
