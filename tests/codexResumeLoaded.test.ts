// electron/capabilities/channels/codexConfig.cjs (#2500): Codex 0.164 shuts a still-loaded thread down on thread/resume
// and spawns it again from that request's config, so a resume while loaded carries the config the thread loaded with.
// Also electron/capabilities/channels/codexTurnThread.cjs, the call-to-turn rule the injection delegates to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { turnThreadOf } = require('../electron/capabilities/channels/codexTurnThread.cjs');

function setup(o: any = {}) {
  const calls: any[] = [];
  const backends = {
    available: () => true,
    has: (id: string) => calls.some((c) => c[0] === 'loaded' && c[1] === id),
    loaded: (id: string, opts?: any) => (calls.push(['loaded', id, opts]), Promise.resolve('/tmp/x.sock')),
    unloaded: (id: string) => calls.push(['unloaded', id]),
    exited: () => calls.push(['exited']),
  };
  let native = true;
  const inj = new CodexToolInjection({
    sessions: new ToolSessions(),
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    nativeEnabled: () => native,
    nativeSurfaces: () => ({ chrome: true, computer: true }),
    browserBackends: backends,
    ...o,
  });
  return { inj, calls, setNative: (v: boolean) => (native = v) };
}

const servers = (m: any) => ({ mcp: m.params.config.mcp_servers, plugins: m.params.config.plugins });

test('#2500: a second resume of a loaded thread carries the config it loaded with, so a respawn keeps sage-mcp and the plugin', () => {
  const { inj, calls, setNative } = setup();
  const first = inj.outgoing({ id: 1, method: 'thread/resume', params: { threadId: 'th' } });
  inj.observe({ id: 1, result: { thread: { id: 'th' } } });
  // the Mac changed meanwhile: the loaded thread keeps its path, the window's own config is merged on top
  setNative(false);
  const again = inj.outgoing({ id: 2, method: 'thread/resume', params: { threadId: 'th', config: { model: 'm2' } } });
  assert.deepEqual(servers(again), servers(first));
  assert.equal(again.params.config.model, 'm2');
  assert.ok(Object.keys(again.params.config.mcp_servers).some((n) => n.startsWith('sage_')));
  // nothing reloads on its answer: the backend and the session stay as they are
  inj.observe({ id: 2, result: { thread: { id: 'th' } } });
  assert.deepEqual(calls, [['loaded', 'th', { surfaces: { chrome: true, computer: true } }]]);
  assert.equal(inj.isNativeThread('th'), true);
  // unloaded, the next resume decides the path again
  inj.observe({ method: 'thread/closed', params: { threadId: 'th' } });
  const reload = inj.outgoing({ id: 3, method: 'thread/resume', params: { threadId: 'th' } });
  assert.equal(reload.params.config.plugins['unified-computer-use@openai-bundled'].enabled, false);
});

test('#2500: a native thread loaded without sage-mcp gets its plugin config again; the app-server exit forgets it', () => {
  const { inj } = setup({ hasTools: () => false });
  const first = inj.outgoing({ id: 1, method: 'thread/start', params: {} });
  inj.observe({ id: 1, result: { thread: { id: 'th' } } });
  const again = inj.outgoing({ id: 2, method: 'thread/resume', params: { threadId: 'th' } });
  assert.deepEqual(again.params.config, first.params.config);
  assert.equal(again.params.config.plugins['unified-computer-use@openai-bundled'].enabled, true);
  inj.exited();
  // a new app-server: the resume loads the thread again, with the path decided now
  const after = inj.outgoing({ id: 3, method: 'thread/resume', params: { threadId: 'th' } });
  assert.equal(inj.isLoadedThread('th'), false);
  assert.ok(after.params.config);
});

test('#2500: an isolated chat thread resumed while loaded keeps its tools off', () => {
  const { ISOLATED_THREAD } = require('../electron/harness/codexIsolation.cjs');
  const { inj } = setup();
  const { inj: own } = setup();
  own.setUserServers(['rea']);
  inj.setUserServers(['rea']);
  const started = inj.outgoing({ id: 1, method: 'thread/start', params: { [ISOLATED_THREAD]: true } });
  inj.observe({ id: 1, result: { thread: { id: 'iso' } } });
  // the isolated config exactly as it loaded: its tools and the user's servers stay off
  const again = inj.outgoing({ id: 2, method: 'thread/resume', params: { threadId: 'iso', [ISOLATED_THREAD]: true } });
  assert.deepEqual(again.params.config, started.params.config);
  // and it differs from a chat thread's, which keeps them
  const chat = own.outgoing({ id: 1, method: 'thread/start', params: {} });
  assert.notDeepEqual(Object.keys(again.params.config).sort(), Object.keys(chat.params.config).sort());
});

test('turnThreadOf: the named thread for the session or its own chat, the session thread otherwise, null for others', () => {
  const owners: Record<string, string> = { sub: 'chat', other: 'elsewhere' };
  const threads = {
    hasThread: (id: string) => id === 'seg',
    isLoadedThread: () => false,
    ownerOf: (id: string) => {
      if (id === 'bad') throw new Error('gone');
      return owners[id] ?? id;
    },
  };
  // Codex's turn metadata on a sub-agent's call (codexThreadContracts.cjs codexCallThread)
  const meta = (thread: string) => ({ 'x-codex-turn-metadata': { thread_source: 'subagent', thread_id: thread, session_id: 'seg' } });
  const noted: unknown[] = [];
  const of = (seg: string, m: unknown = null) => turnThreadOf(threads, 'chat', seg, m, (e: unknown) => noted.push(e));
  assert.equal(of('acp'), null);
  assert.deepEqual(of('seg'), { thread: 'seg', named: false });
  assert.deepEqual(of('seg', meta('seg')), { thread: 'seg', named: true });
  assert.deepEqual(of('seg', meta('sub')), { thread: 'sub', named: true });
  assert.deepEqual(of('seg', meta('other')), { thread: 'seg', named: false });
  assert.deepEqual(noted, []);
  // an owner lookup that fails is noted, and the call rides on the session's thread
  assert.deepEqual(of('seg', meta('bad')), { thread: 'seg', named: false });
  assert.equal(String(noted[0]), 'Error: gone');
});
