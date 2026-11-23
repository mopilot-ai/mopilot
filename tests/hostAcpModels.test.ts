// Host ACP model discovery reads real ACP session declarations, never prompts, and retires probes on timeout or identity/disposal changes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: Host ESM module
import { acpModels, createAcpModels } from '../host/src/acpModels.mjs';
import { fakeSpawn, INIT, NO_REPLY } from './support/electron-acp-fake.ts';
const tick = () => new Promise((r) => setImmediate(r));
const until = async (f: () => boolean) => {
  for (let n = 0; n < 100; n++) {
    if (f()) return;
    await tick();
  }
  throw new Error('not settled');
};
const OPTIONS = [
  { id: 'model', category: 'model', type: 'select', currentValue: 'm', options: [{ value: 'm', name: 'Machine' }, { value: 'other' }] },
  { id: 'think', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'low' }, { value: 'high' }] },
];
test('models and efforts come only from session config declarations', () => {
  assert.deepEqual(acpModels(null), []);
  assert.deepEqual(acpModels({ configOptions: OPTIONS }), [
    { id: 'm', name: 'Machine', default: true, efforts: ['low', 'high'], defaultEffort: 'high', resolvedModel: 'Machine' },
    { id: 'other', name: 'other', default: false, efforts: ['low', 'high'], defaultEffort: 'high' },
  ]);
  assert.deepEqual(acpModels({ configOptions: OPTIONS.slice(0, 1) })[0].efforts, []);
  assert.deepEqual(
    acpModels({ models: { availableModels: [{ modelId: 'read-only' }] } }),
    [],
    'legacy read-only catalogs cannot claim a working picker',
  );
});
function setup(handlers: Record<string, any> = {}, overrides: any = {}) {
  const fake = fakeSpawn({ initialize: () => INIT(), 'session/new': () => ({ sessionId: 's', configOptions: OPTIONS }), ...handlers });
  const errors: unknown[] = [];
  const host = {
    cwd: '/tmp',
    dataDir: '/tmp',
    resolveBin: (id: string) => (id === 'missing' ? null : '/fake'),
    quirksOf: () => ({ args: [], env: { MACHINE: 'yes' } }),
    ...overrides.host,
  };
  const cache = createAcpModels({
    host,
    envFor: () => ({ PATH: '/x' }),
    spawnFn: fake.spawnFn,
    report: (e: unknown) => errors.push(e),
    ...overrides,
  });
  return { ...fake, cache, errors };
}
test('a status returns immediately, coalesces discovery, caches its own list and never sends a prompt', async () => {
  const w = setup();
  try {
    assert.deepEqual(w.cache.get('missing'), []);
    assert.deepEqual(w.cache.get('custom'), []);
    assert.deepEqual(w.cache.get('custom'), []);
    await until(() => w.cache.get('custom').length > 0);
    assert.equal(w.cache.get('custom')[0].id, 'm');
    assert.equal(w.procs.length, 1);
    assert.deepEqual(
      w.procs[0].received.map((r: any) => r.method),
      ['initialize', 'session/new'],
    );
    assert.equal(w.procs[0].stdin.ended, true);
  } finally {
    w.cache.close();
  }
  assert.deepEqual(w.cache.get('custom'), []);
});
test('clear and close retire a pending launch; a replacement can discover models', async () => {
  let resolve: (v: any) => void = () => {};
  let wait = true;
  const host = {
    cwd: '/tmp',
    dataDir: '/tmp',
    resolveBin: () => '/fake',
    quirksOf: () => ({ env: {}, launch: () => (wait ? new Promise((r) => (resolve = r)) : Promise.resolve({ args: [], env: {} })) }),
  };
  const w = setup({}, { host });
  w.cache.get('x');
  w.cache.clear();
  resolve({ args: [], env: {} });
  await until(() => w.errors.length > 0);
  assert.equal(w.procs.length, 0);
  wait = false;
  w.cache.get('x');
  await until(() => w.cache.get('x').length > 0);
  assert.equal(w.procs.length, 1);
  w.cache.close();
});
test('a silent agent times out, privacy refusal starts nothing, and probe requests receive no authority', async () => {
  const silent = setup({ initialize: () => NO_REPLY }, { probeMs: 5 });
  silent.cache.get('x');
  await new Promise((r) => setTimeout(r, 25));
  assert.match(String(silent.errors[0]), /timed out/);
  assert.equal(silent.procs[0].stdin.ended, true);
  silent.cache.close();
  const denied = setup(
    {},
    {
      host: {
        cwd: '/tmp',
        resolveBin: () => '/fake',
        quirksOf: () => ({ args: [], env: {}, admission: { privacyGate: async () => ({ ok: false }) } }),
      },
    },
  );
  denied.cache.get('x');
  await tick();
  await tick();
  assert.equal(denied.procs.length, 0);
  denied.cache.close();
  let permission: any;
  let refused: any;
  const w = setup({
    initialize: async (_: any, proc: any) => {
      permission = await proc.request('session/request_permission', {});
      refused = await proc.request('fs/read_text_file', {});
      return INIT();
    },
  });
  w.cache.get('x');
  await until(() => w.cache.get('x').length > 0);
  assert.deepEqual(permission.result, { outcome: { outcome: 'cancelled' } });
  assert.equal(refused.error.code, -32601);
  w.cache.close();
});

test('discovery authenticates with the same lent key as real ACP sessions before reading models', async () => {
  let authenticated = false;
  const w = setup(
    {
      initialize: () => INIT({}, { authMethods: [{ id: 'api-key' }] }),
      authenticate: (p: any) => {
        assert.equal(p.methodId, 'api-key');
        authenticated = true;
        return {};
      },
      'session/new': () => {
        assert.equal(authenticated, true);
        return { sessionId: 's', configOptions: OPTIONS };
      },
    },
    {
      host: {
        cwd: '/tmp',
        dataDir: '/tmp',
        resolveBin: () => '/fake',
        quirksOf: () => ({ args: [], env: {} }),
        lentAuthFn: () => 'api-key',
      },
    },
  );
  w.cache.get('x');
  try {
    await until(() => w.cache.get('x').length > 0);
    assert.equal(w.errors.length, 0);
  } finally {
    w.cache.close();
  }
});

test('clearing an active protocol probe closes its input and prevents any later session request', async () => {
  let finish: ((value: any) => void) | undefined;
  const w = setup({ initialize: () => new Promise((resolve) => (finish = resolve)) });
  w.cache.get('x');
  await until(() => !!finish);
  w.cache.clear();
  assert.equal(w.procs[0].stdin.ended, true);
  finish!(INIT());
  await until(() => w.errors.length > 0);
  assert.equal(
    w.procs[0].received.some((r: any) => r.method === 'session/new'),
    false,
  );
  w.cache.close();
});

test('the real Host runtime gives catalog probes the agent-scoped env and invalidates their cache on credential changes', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { createAcpRuntime } = await import('../host/src/acp.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'host-model-env-'));
  const envCalls: string[] = [];
  let changed: (id: string) => void = () => {};
  const runtime = createAcpRuntime({
    paths: { dataDir: dir },
    env: { FAKE_ACP_STATE: path.join(dir, 'agent'), FAKE_ACP_PROFILE: JSON.stringify({ configOptions: OPTIONS }) },
    leases: {
      envFor: (id: string) => (envCalls.push(id), {}),
      has: () => false,
      hasOrg: () => false,
      orgLease: () => null,
      onChange: (fn: any) => (changed = fn),
    },
    hostOptions: {
      resolveBin: () => process.execPath,
      quirks: () => ({ id: 'gemini', label: 'Fixture', args: [path.join(import.meta.dirname, 'fixtures/fake-acp-agent.mjs')], env: {} }),
    },
  });
  const wait = async () => {
    const deadline = Date.now() + 8000;
    while (!runtime.models('gemini').length) {
      if (Date.now() > deadline) throw new Error('no catalog');
      await new Promise((r) => setTimeout(r, 10));
    }
  };
  try {
    assert.deepEqual(runtime.models('gemini'), []);
    await wait();
    assert.equal(runtime.models('gemini')[0].id, 'm');
    assert.deepEqual(envCalls, ['acp', 'gemini']);
    changed('codex');
    assert.equal(runtime.models('gemini')[0].id, 'm', 'unrelated credentials do not retire ACP');
    changed('gemini');
    assert.deepEqual(runtime.models('gemini'), []);
    await wait();
    assert.deepEqual(envCalls, ['acp', 'gemini', 'acp', 'gemini']);
  } finally {
    runtime.close();
    await runtime.drain();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
