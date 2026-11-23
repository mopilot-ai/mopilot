// search_mcp_registry (electron/capabilities/tools/mcpRegistry.cjs): the public MCP registry, keywords only, third-party
// entries returned as data, and an unreachable registry said plainly.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { registerMcpRegistryTool, entryOf, REGISTRY } = require('../electron/capabilities/tools/mcpRegistry.cjs');

const item = (name: string, over: any = {}, meta: any = { status: 'active', isLatest: true }) => ({
  server: { name, description: `${name} server`, ...over },
  _meta: { 'io.modelcontextprotocol.registry/official': meta },
});

function setup(fetchImpl: any) {
  const urls: string[] = [];
  const r = new Registry();
  registerMcpRegistryTool(r, {
    owner: (ctx: any) => (ctx.segmentId === 'seg' ? ctx.chatId : null),
    fetch: async (url: string, init: any) => (urls.push(url), fetchImpl(url, init)),
  });
  const call = async (args: any, seg = 'seg') => {
    const res = await r.invoke('me', seg, 'search_mcp_registry', args);
    return res.ok ? JSON.parse(res.content[0].text) : { error: res.error };
  };
  return { r, call, urls };
}
const ok = (servers: unknown) => ({ ok: true, json: async () => ({ servers }) });

test('an entry: remote url, else package, credentials noted, deleted and old versions skipped', () => {
  const remote = entryOf(
    item('io.x/remote', {
      remotes: [{ type: 'streamable-http', url: 'https://x/mcp', headers: [{ isRequired: true }] }],
      repository: { url: 'https://github.com/x/y' },
    }),
  );
  assert.deepEqual(remote, {
    name: 'io.x/remote',
    description: 'io.x/remote server',
    url: 'https://x/mcp',
    transport: 'streamable-http',
    repository: 'https://github.com/x/y',
    needs_credentials: true,
  });
  assert.deepEqual(entryOf(item('pkg', { packages: [{ identifier: '@x/y', registryType: 'npm' }] })), {
    name: 'pkg',
    description: 'pkg server',
    package: '@x/y',
    registry: 'npm',
    needs_credentials: false,
  });
  assert.equal(entryOf(item('plain', { remotes: [{ type: 'sse' }] }))?.url, undefined);
  assert.equal(entryOf(item('old', {}, { status: 'active', isLatest: false })), null);
  assert.equal(entryOf(item('gone', {}, { status: 'deleted' })), null);
  assert.equal(entryOf({ server: { description: 'no name' } }), null);
  assert.equal(entryOf(null), null);
  assert.equal(entryOf({ server: { name: 'bare' } })?.description, '');
  assert.equal(entryOf(item('long', { description: 'x'.repeat(500) }))?.description.length, 240);
});

test('one search per keyword, entries merged without repeats and capped, only the keywords sent', async () => {
  const t = setup((url: string) =>
    ok(
      new URL(url).searchParams.get('search') === 'asana'
        ? [item('a1'), item('shared'), item('gone', {}, { status: 'deleted' })]
        : Array.from({ length: 12 }, (_, i) => item(i === 0 ? 'shared' : `t${i}`)),
    ),
  );
  assert.equal(t.r.list()[0].policy, 'observe');
  const res = await t.call({ keywords: [' asana ', 'tasks', 'asana', ''] });
  assert.equal(res.results.length, 10);
  assert.deepEqual(
    res.results.slice(0, 3).map((e: any) => e.name),
    ['a1', 'shared', 't1'],
  );
  assert.match(res.note, /not vetted/);
  assert.equal(t.urls.length, 2);
  for (const u of t.urls) {
    const parsed = new URL(u);
    assert.equal(`${parsed.origin}${parsed.pathname}`, REGISTRY);
    assert.deepEqual([...parsed.searchParams.keys()].sort(), ['limit', 'search', 'version']);
  }
});

test('no match, a bad keyword list, an unknown caller, a failing registry and an odd body', async () => {
  const empty = setup(() => ok([]));
  assert.match((await empty.call({ keywords: ['zzz'] })).note, /Nothing found/);
  assert.equal((await empty.call({ keywords: ['  '] })).error.code, 'bad_args');
  assert.equal((await empty.call({ keywords: ['x'] }, 'stranger')).error.code, 'no_owner');
  assert.equal((await setup(() => ({ ok: true, json: async () => ({}) })).call({ keywords: ['x'] })).results.length, 0);
  const down = (await setup(() => ({ ok: false, status: 503 })).call({ keywords: ['x'] })).error;
  assert.deepEqual([down.code, /503/.test(down.message)], ['unavailable', true]);
  const refused = (await setup(() => Promise.reject(new Error('offline'))).call({ keywords: ['x'] })).error;
  assert.match(refused.message, /offline/);
  assert.match((await setup(() => Promise.reject('plain')).call({ keywords: ['x'] })).error.message, /plain/);
});

test('one keyword failing costs only its own matches; every keyword failing fails the tool; a long word is cut', async () => {
  const partial = setup((url: string) =>
    new URL(url).searchParams.get('search') === 'bad' ? { ok: false, status: 429 } : ok([item('kept')]),
  );
  const res = await partial.call({ keywords: ['bad', 'good'] });
  assert.deepEqual(
    res.results.map((e: any) => e.name),
    ['kept'],
  );
  const all = setup(() => ({ ok: false, status: 500 }));
  assert.equal((await all.call({ keywords: ['a', 'b'] })).error.code, 'unavailable');
  await all.call({ keywords: ['x'.repeat(200)] });
  assert.equal(new URL(all.urls.at(-1) as string).searchParams.get('search')?.length, 60);
});

test('the default fetch is the platform’s and a search has a time limit', async () => {
  const seen: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: any) => (seen.push([url, init.signal instanceof AbortSignal]), ok([]))) as any;
  try {
    const r = new Registry();
    registerMcpRegistryTool(r, { owner: (ctx: any) => ctx.chatId });
    await r.invoke('me', 'seg', 'search_mcp_registry', { keywords: ['x'] });
  } finally {
    globalThis.fetch = real;
  }
  assert.deepEqual(
    seen.map((s) => s[1]),
    [true],
  );
});
