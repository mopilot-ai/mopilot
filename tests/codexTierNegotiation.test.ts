// A Codex thread's tools are tiered unless that Codex defers MCP tools itself (G2, CM-X19), which main learns from the
// app-server's experimentalFeature/list (negotiate). A thread/start right after initialize waits for that answer, so the
// thread's config is decided on what this Codex can do, never on a negotiation still in flight. The app-server is a fake.
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { NEGOTIATE_WAIT_MS, negotiatedWithin } = require('../electron/harness/codexConnection.cjs');

function fakeServer() {
  const s = {
    listeners: new Set<(e: any) => void>(),
    sent: [] as any[],
    proc: {},
    start() {},
    send(m: any) {
      s.sent.push(m);
      if (m.id == null || !m.method) return;
      const result =
        m.method === 'initialize'
          ? { userAgent: 'codex/0.166.0', codexHome: '/h' }
          : m.method === 'thread/start'
            ? { thread: { id: 'th' } }
            : {};
      setImmediate(() => s.emit({ kind: 'message', msg: { id: m.id, result } }));
    },
    emit(e: any) {
      for (const l of s.listeners) l(e);
    },
    on(fn: (e: any) => void) {
      s.listeners.add(fn);
      return () => s.listeners.delete(fn);
    },
  };
  return s;
}

/** An adapter over the fake whose negotiation runs `probe`; `seen` gets the flags each outgoing thread/start was decided on. */
function adapter(probe: (request: (m: string, p: any) => Promise<any>) => Promise<any>) {
  const seen: any[] = [];
  const a = new CodexAdapter({
    server: fakeServer(),
    state: new SessionStore(),
    nativeOf: (chat: string) => ({ kind: 'codex', id: chat, key: chat }),
    chatOf: (id: string) => id,
    prefs: () => ({ model: null, effort: null, permission: 'default', serviceTier: null }),
    emit: () => undefined,
    tools: {
      outgoing: (m: any, o?: any) => (m.method === 'thread/start' && !o?.helper && seen.push(a.negotiated?.flags ?? 'none'), m),
      observe() {},
      exited() {},
      setUserServers() {},
      isNativeThread: () => false,
    },
    probe,
  });
  return { a, seen };
}

test("a probe's own thread/start (helper) never waits for the negotiation it is part of, so it cannot deadlock", async () => {
  const { a, seen } = adapter(async (request) => {
    await request('thread/start', { ephemeral: true });
    return { probes: { 'codex.threadProvider': true }, flags: { 'features.tool_search_always_defer_mcp_tools': true } };
  });
  await a.request('thread/start', {});
  assert.deepEqual(seen, [{ 'features.tool_search_always_defer_mcp_tools': true }]);
});

test('a negotiation that never settles holds a thread/start for NEGOTIATE_WAIT_MS at most, then it goes ahead tiered', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { a, seen } = adapter(() => new Promise(() => undefined));
  let done = false;
  const started = a.request('thread/start', {}).then(() => (done = true));
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  assert.equal(done, false);
  t.mock.timers.tick(NEGOTIATE_WAIT_MS);
  await waitFor(() => done, 'thread/start to go ahead');
  await started;
  assert.deepEqual(seen, ['none']);
});

for (const outcome of ['answers', 'fails'] as const)
  test(`thread/start waits for the Codex's negotiation before its tool config is decided (the probe ${outcome})`, async () => {
    let answer!: (v: any) => void;
    let fail!: (e: Error) => void;
    const probed = new Promise((res, rej) => ((answer = res), (fail = rej)));
    const seen: any[] = [];
    const a = new CodexAdapter({
      server: fakeServer(),
      state: new SessionStore(),
      nativeOf: (chat: string) => ({ kind: 'codex', id: chat, key: chat }),
      chatOf: (id: string) => id,
      prefs: () => ({ model: null, effort: null, permission: 'default', serviceTier: null }),
      emit: () => undefined,
      tools: {
        outgoing: (m: any) => (m.method === 'thread/start' && seen.push(a.negotiated?.flags ?? 'none'), m),
        observe() {},
        exited() {},
        setUserServers() {},
        isNativeThread: () => false,
      },
      probe: () => probed,
    });
    const started = a.request('thread/start', {});
    for (let i = 0; i < 8; i++) await tick();
    assert.deepEqual(seen, [], 'nothing goes out while the negotiation is in flight');
    if (outcome === 'answers') answer({ probes: {}, flags: { 'features.tool_search_always_defer_mcp_tools': true } });
    else fail(new Error('probe failed'));
    await started;
    assert.deepEqual(seen, [outcome === 'answers' ? { 'features.tool_search_always_defer_mcp_tools': true } : {}]);
  });

test('negotiatedWithin: no negotiation is nothing to wait for; a rejected one is noted and lets the thread go ahead', async () => {
  assert.equal(negotiatedWithin(null), null);
  assert.equal(await negotiatedWithin(Promise.reject(new Error('app-server went away'))), undefined);
  assert.deepEqual(await negotiatedWithin(Promise.resolve({ flags: {} })), { flags: {} });
});
