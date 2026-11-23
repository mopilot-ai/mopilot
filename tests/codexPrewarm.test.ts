// Codex's prewarm hook (electron/harness/codexPrewarm.cjs, #1664) over the real CodexAdapter and a scripted
// app-server: the process and its once-per-process reads warm first; the thread starts with the send's exact
// params; and the thread is neither leased nor shown to the windows until the send takes it. An unused thread is
// unloaded, and one from an app-server that went away is never served.
import { test, assert, require, thread, setup, settle, crash } from './support/codex-adapter/fixture.ts';

const { codexPrewarm, sorted } = require('../../../electron/harness/codexPrewarm.cjs');

const PARAMS = { cwd: '/w', model: 'gpt-6', approvalPolicy: 'on-request', sandbox: 'workspace-write', ephemeral: false };
const leaseEvents = (events: any[]) => events.filter((x) => x.e.kind === 'lease');
const shown = (events: any[], method: string) => events.filter((x) => x.e.kind === 'notification' && x.e.method === method);

function rig(o: { tools?: any; provider?: () => any; noThread?: boolean } = {}) {
  let n = 0;
  const r = setup(
    {
      'config/read': () => ({ config: { model: null, mcp_servers: { mine: {} } } }),
      'model/list': () => ({ data: [{ model: 'gpt-6', isDefault: true }] }),
      'thread/start': () => (o.noThread ? {} : { thread: thread(`pw-${++n}`) }),
      'thread/unsubscribe': () => ({}),
    },
    { tools: o.tools, provider: o.provider },
  );
  return { ...r, hook: codexPrewarm({ adapter: r.a }) };
}

test('the key reads the same for the same params in any order, is null for a temporary chat, and follows the model provider', () => {
  let provider: any = { id: 'a' };
  const { hook } = rig({ provider: () => provider });
  const k = hook.key({ kind: 'codex', params: PARAMS });
  const reordered = Object.fromEntries(Object.entries(PARAMS).reverse());
  assert.equal(hook.key({ kind: 'codex', params: { ...reordered, projectId: undefined } }), k);
  assert.notEqual(hook.key({ kind: 'codex', params: { ...PARAMS, model: 'gpt-6-mini' } }), k);
  assert.equal(hook.key({ kind: 'codex', params: { ...PARAMS, ephemeral: true } }), null);
  assert.equal(typeof hook.key({ kind: 'codex', params: null }), 'string');
  provider = { id: 'b' };
  assert.notEqual(hook.key({ kind: 'codex', params: PARAMS }), k, 'another account');
  assert.deepEqual(sorted([{ b: [{ d: 1, c: 2 }], a: undefined }]), [{ b: [{ c: 2, d: 1 }] }]);
});

test("without a folder yet, only the app-server warms: initialize, config/read and model/list, and the user's MCP servers", async () => {
  const servers: unknown[] = [];
  const tools = { outgoing: (m: any) => m, observe() {}, exited() {}, setUserServers: (s: unknown) => void servers.push(s) };
  const { hook, server } = rig({ tools });
  const h = await hook.warm({ kind: 'codex', params: null });
  assert.equal(h.result, null);
  assert.deepEqual(server.methods(), ['initialize', 'initialized', 'config/read', 'model/list', 'config/read']);
  assert.deepEqual(servers, [{ mine: {} }], 'each user server with its entry (#2999 C4)');
  assert.equal(hook.valid?.(h), true, 'the warm process is still there');
  assert.equal(hook.claim?.(h), null, 'the send still starts its thread, on a warm process');
  await hook.dispose(h);
  assert.ok(!server.methods().includes('thread/unsubscribe'));
});

test('a prewarmed thread is no chat until the send takes it: no lease, nothing shown; the take leases and answers it', async () => {
  const { a, hook, server, events } = rig();
  const h = await hook.warm({ kind: 'codex', params: PARAMS });
  assert.equal(h.result.thread.id, 'pw-1');
  const start = server.sent.find((m: any) => m.method === 'thread/start');
  // the prewarmed thread carries its folder's trust like any other start (#1346)
  assert.deepEqual(start.params, { ...PARAMS, config: { projects: { [PARAMS.cwd]: { trust_level: 'trusted' } } } });
  // as the app-server sends it: after the answer
  server.notify('thread/started', { thread: thread('pw-1') });
  server.notify('thread/status/changed', { threadId: 'pw-1', status: { type: 'idle' } });
  await settle();
  assert.deepEqual(leaseEvents(events), []);
  assert.deepEqual([...shown(events, 'thread/started'), ...shown(events, 'thread/status/changed')], []);
  assert.equal(a.leases.has('pw-1'), false);
  assert.equal(hook.valid?.(h), true);
  assert.deepEqual(hook.claim?.(h), h.result);
  assert.equal(a.leases.has('pw-1'), true);
  // nothing of it is on disk until the send's turn records it: kept loaded until then (#2276)
  assert.equal(a.unrecorded.has('pw-1'), true);
  assert.deepEqual(
    leaseEvents(events).map((x) => [x.e.threadId, x.e.held]),
    [['pw-1', true]],
  );
  // from now on its notifications are its chat's
  server.notify('thread/status/changed', { threadId: 'pw-1', status: { type: 'idle' } });
  await settle();
  assert.equal(shown(events, 'thread/status/changed').length, 1);
});

test('an unused thread is deleted (an unsubscribed one keeps its MCP servers running), and what Codex says of it stays in main', async () => {
  const { a, hook, server, events } = rig();
  const h = await hook.warm({ kind: 'codex', params: PARAMS });
  await hook.dispose(h);
  assert.deepEqual(server.sent.find((m: any) => m.method === 'thread/delete').params, { threadId: 'pw-1' });
  assert.ok(!server.methods().includes('thread/unsubscribe'));
  server.notify('thread/status/changed', { threadId: 'pw-1', status: { type: 'notLoaded' } });
  server.notify('thread/deleted', { threadId: 'pw-1' });
  await settle();
  assert.deepEqual([...shown(events, 'thread/deleted'), ...shown(events, 'thread/status/changed')], []);
  assert.equal(a.prewarmed.size, 0, 'its id is let go once Codex says it is gone');
});

test('a delete Codex refuses lets go of the id and reports the failure', async () => {
  const r = setup({
    'thread/start': () => ({ thread: thread('pw-x') }),
    'thread/delete': () => {
      throw new Error('no such thread');
    },
  });
  const hook = codexPrewarm({ adapter: r.a });
  const h = await hook.warm({ kind: 'codex', params: PARAMS });
  await assert.rejects(hook.dispose(h), /no such thread/);
  assert.equal(r.a.prewarmed.size, 0);
});

test('I2: a thread from an app-server that went away is not served, and nothing is sent to the new one for it', async () => {
  const { a, hook, server } = rig();
  const h = await hook.warm({ kind: 'codex', params: PARAMS });
  crash(server);
  await settle();
  assert.equal(a.prewarmed.size, 0, 'the exit took its threads with it');
  assert.equal(hook.valid?.(h), false);
  await a.connect();
  await settle();
  assert.equal(hook.valid?.(h), false, 'a new process is not the one that had the thread');
  await hook.dispose(h);
  assert.ok(!server.methods().includes('thread/delete'));
  assert.equal(a.prewarmed.size, 0);
});

test('B1: an answer that names no thread fails the warm (the send starts its own)', async () => {
  const { hook } = rig({ noThread: true });
  await assert.rejects(hook.warm({ kind: 'codex', params: PARAMS }), /didn't start a thread/);
});
