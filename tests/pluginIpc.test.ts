// The plugin store's IPC and service (electron/app/ipc/plugins.cjs, electron/plugins/service.cjs): a marketplace
// entry reviewed then installed, every handler's arguments coerced, and changes announced to every window.
// Data is made up; folders are temporary and git is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createPluginService, pluginService, pluginDelivery, codexPluginMirror } = require('../electron/plugins/service.cjs');
const { register } = require('../electron/app/ipc/plugins.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-plugin-ipc-'));
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

function marketplaceDir() {
  const root = tmp();
  write(
    path.join(root, '.claude-plugin/marketplace.json'),
    JSON.stringify({
      name: 'acme',
      plugins: [
        { name: 'tidy', source: './tidy' },
        { name: 'remote', source: { source: 'url', url: 'https://example.test/remote.git' } },
      ],
    }),
  );
  write(path.join(root, 'tidy/.claude-plugin/plugin.json'), '{"name":"tidy","version":"1.0.0"}');
  write(
    path.join(root, 'tidy/.mcp.json'),
    JSON.stringify({ mcpServers: { tidy: { command: 'node', args: ['${CLAUDE_PLUGIN_ROOT}/srv.js'] } } }),
  );
  return root;
}

/** git that checks out `repo` for any fetch, counting checkouts. */
function oneRepoGit(repo: string) {
  let checkouts = 0;
  const git = async (args: string[], cwd: string) => {
    if (args[0] === 'checkout') {
      checkouts++;
      fs.cpSync(repo, cwd, { recursive: true });
    }
    return { ok: true, stdout: '', stderr: '' };
  };
  return { git, checkouts: () => checkouts };
}

/** A service over one temporary folder. */
function fixedService() {
  const dir = tmp();
  return createPluginService({ dir: () => dir, home: '/h' });
}

function harness(service = fixedService(), extra: Record<string, unknown> = {}) {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const sent: unknown[][] = [];
  register(
    {} as never,
    { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn), broadcastAll: (...a: unknown[]) => sent.push(a) },
    { service, delivery: { skillsFor: async (f: string) => [{ name: `for:${f}` }] }, native: () => [], codexStates: () => ({}), ...extra },
  );
  const call = (ch: string, ...args: unknown[]) => {
    const fn = handlers.get(ch);
    assert.ok(fn, ch);
    return fn(...args);
  };
  return { service, handlers, sent, call };
}

test("the list waits for MoPilot's own plugin to be in the store", async () => {
  const order: string[] = [];
  const service = fixedService();
  const list = service.store.list.bind(service.store);
  service.store.list = async () => {
    order.push('list');
    return list();
  };
  const { call } = harness(service, {
    ready: async () => {
      order.push('ready');
    },
  });
  await call('plugins:list');
  assert.deepEqual(order, ['ready', 'list']);
});

test('every plugins channel is handled', () => {
  const { handlers } = harness();
  assert.deepEqual([...handlers.keys()].sort(), [
    'plugins:builtinList',
    'plugins:builtinSet',
    'plugins:catalog',
    'plugins:codexStates',
    'plugins:importNative',
    'plugins:install',
    'plugins:list',
    'plugins:marketplaceAdd',
    'plugins:marketplaceRemove',
    'plugins:marketplaceUpgrade',
    'plugins:native',
    'plugins:preview',
    'plugins:previewNative',
    'plugins:setEnabled',
    'plugins:skillsFor',
    'plugins:uninstall',
  ]);
});

test('review then install a marketplace plugin, and every change reaches every window', async () => {
  const { call, sent } = harness();
  const mkt = marketplaceDir();
  assert.equal(await call('plugins:marketplaceAdd', mkt), 'acme');
  assert.deepEqual(sent.at(-1), ['plugins:changed', { marketplaces: true }]);
  const catalog = (await call('plugins:catalog')) as { marketplaces: { name: string }[] };
  assert.deepEqual(
    catalog.marketplaces.map((m) => m.name),
    ['acme'],
  );

  const preview = (await call('plugins:preview', 'acme', 'tidy')) as { ok: boolean; runs: string[]; trust: string };
  assert.deepEqual(
    preview.runs.filter((line) => line.includes('mcpServers .mcp.json:')),
    ['acp', 'claude', 'codex'].map(
      (family) => `${family} mcpServers .mcp.json: {"mcpServers":{"tidy":{"command":"node","args":["\${CLAUDE_PLUGIN_ROOT}/srv.js"]}}}`,
    ),
  );
  await assert.rejects(Promise.resolve(call('plugins:install', 'acme', 'tidy', 'not-the-digest')), /changed since you reviewed/);
  const installed = (await call('plugins:install', 'acme', 'tidy', preview.trust)) as { id: string };
  assert.equal(installed.id, 'tidy@acme');
  assert.deepEqual(sent.at(-1), ['plugins:changed', { ids: ['tidy@acme'] }]);

  const off = (await call('plugins:setEnabled', 'tidy@acme', 'yes', 'acp')) as { harnesses: object; enabled: boolean };
  assert.deepEqual(off.harnesses, { acp: false }, 'only true turns a plugin on');
  assert.equal(((await call('plugins:setEnabled', 'tidy@acme', true, null)) as { enabled: boolean }).enabled, true);
  assert.equal(((await call('plugins:list')) as { plugins: unknown[] }).plugins.length, 1);
  assert.equal(await call('plugins:uninstall', 'tidy@acme'), true);
  assert.equal(await call('plugins:uninstall', undefined), false);
  assert.equal(await call('plugins:marketplaceUpgrade', 'acme'), false);
  assert.equal(await call('plugins:marketplaceRemove', 'acme'), true);
  await assert.rejects(Promise.resolve(call('plugins:marketplaceAdd', null)), /isn't a folder/);
});

test('a git entry is fetched for the review and again for the install, and both copies go', async () => {
  const repo = tmp();
  write(path.join(repo, '.claude-plugin/plugin.json'), '{"name":"remote"}');
  const dir = tmp();
  const g = oneRepoGit(repo);
  const service = createPluginService({ dir: () => dir, home: '/h', git: g.git });
  await service.marketplaces.add(marketplaceDir());
  const preview = await service.preview('acme', 'remote');
  assert.ok(preview.ok);
  assert.equal((await service.install('acme', 'remote', preview.trust)).id, 'remote@acme');
  assert.equal(g.checkouts(), 2);
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.startsWith('.staging-')),
    [],
  );
  // a failed review still lets the fetched copy go
  write(path.join(repo, '.claude-plugin/plugin.json'), '{');
  assert.equal((await service.preview('acme', 'remote')).ok, false);
  assert.deepEqual(
    fs.readdirSync(dir).filter((n) => n.startsWith('.staging-')),
    [],
  );
});

test('listeners can unsubscribe', async () => {
  const service = fixedService();
  const heard: unknown[] = [];
  const stop = service.subscribe((e: unknown) => heard.push(e));
  await service.marketplaces.add(marketplaceDir());
  stop();
  await service.marketplaces.remove('acme');
  assert.deepEqual(heard, [{ marketplaces: true }]);
});

test('main runs one service, over ~/.mopilot/plugins by default', () => {
  assert.equal(pluginService(), pluginService());
  const s = createPluginService();
  assert.equal(s.store.file(), path.join(os.homedir(), '.mopilot', 'plugins', 'installed.json'));
  const h = harness();
  assert.ok(h.handlers.size > 0);
});

test('the registered default is the shared service, over the harnesses’ own folders', async () => {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const deps = { handle: (ch: string, fn: (...a: unknown[]) => unknown) => handlers.set(ch, fn), broadcastAll: () => undefined };
  register({} as never, deps as never);
  assert.equal(handlers.size, 16);
  // read-only: what the user's own Claude Code and Codex installed, and the mirror's states
  assert.ok(Array.isArray(await handlers.get('plugins:native')!()));
  assert.equal(typeof (await handlers.get('plugins:codexStates')!()), 'object');
  // CODEX_HOME from the login shell's environment when main has it
  const env = new Map<string, (...a: unknown[]) => unknown>();
  const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  register(
    {} as never,
    {
      ...deps,
      handle: (ch: string, fn: (...a: unknown[]) => unknown) => env.set(ch, fn),
      shellEnv: { childEnv: () => ({ CODEX_HOME: codexHome }) },
    } as never,
  );
  assert.ok(Array.isArray(await env.get('plugins:native')!()));
});

test('a plugin one harness installed is reviewed, then copied into the store under its own marketplace', async () => {
  const src = path.join(tmp(), 'stripe');
  write(path.join(src, '.claude-plugin/plugin.json'), '{"name":"stripe"}');
  write(path.join(src, '.mcp.json'), JSON.stringify({ mcpServers: { stripe: { type: 'http', url: 'https://mcp.stripe.com' } } }));
  const nativeList = [
    { id: 'stripe@claude-plugins-official', name: 'stripe', marketplace: 'claude-plugins-official', path: src, harness: 'claude' },
  ];
  const states = { 'x@m': { state: 'failed' } };
  const { call } = harness(fixedService(), { native: () => nativeList, codexStates: () => states });
  assert.deepEqual(await call('plugins:native'), nativeList);
  assert.equal(await call('plugins:codexStates'), states);
  const preview = (await call('plugins:previewNative', 'stripe@claude-plugins-official')) as { ok: boolean; runs: string[]; trust: string };
  assert.deepEqual(
    preview.runs.filter((line) => line.includes('mcpServers .mcp.json:')),
    ['acp', 'claude', 'codex'].map(
      (family) => `${family} mcpServers .mcp.json: {"mcpServers":{"stripe":{"type":"http","url":"https://mcp.stripe.com"}}}`,
    ),
  );
  const got = (await call('plugins:importNative', 'stripe@claude-plugins-official', preview.trust)) as {
    id: string;
    record: { origin: string };
  };
  assert.equal(got.id, 'stripe@claude-plugins-official');
  assert.equal(got.record.origin, 'claude');
  // only what a harness installed can be copied in: not an arbitrary folder by id
  assert.throws(() => call('plugins:previewNative', '/etc'), { message: "That plugin isn't installed by a harness on this computer" });
});

test('main delivers from the shared store, each family behind its plugins.<family> switch', () => {
  const d = pluginDelivery();
  assert.equal(d, pluginDelivery());
  assert.equal(d.store, pluginService().store);
  for (const family of ['claude', 'codex', 'acp']) assert.equal(d.enabled(family), true, family);
  assert.equal(d.enabled('other'), false);
});

test('the shared Codex mirror syncs when installs change, and a failed sync is recorded, not thrown', async () => {
  const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');
  const m = codexPluginMirror();
  assert.equal(m, codexPluginMirror());
  // a plugin the mirror failed to install in Codex is one plugin_skills serves there
  const states = m.states;
  m.states = {
    'a@m': { codexId: 'a@mopilot-m', path: '/a', state: 'failed' },
    'b@m': { codexId: 'b@mopilot-m', path: '/b', state: 'installed' },
  };
  assert.deepEqual([...pluginDelivery().failedBy.get('codex')()], ['a@m']);
  m.states = states;
  assert.equal(m.enabled(), true, 'plugins.codex is on by default');
  clearIgnored();
  let listed = 0;
  m.attach({
    connected: () => true,
    request: async () => {
      listed++;
      throw new Error('Codex said no');
    },
  });
  // what the store announces, without writing the user's own store
  pluginService().marketplaces.o.onChange();
  pluginService().store.o.onChange(['tidy@acme']);
  await m.chain.catch(() => undefined);
  await new Promise((r) => setImmediate(r));
  assert.equal(listed > 0, true);
  assert.ok(recentIgnored().some((e: { message: string }) => /Codex said no/.test(e.message)));
  m.attach({ connected: () => false, request: async () => ({}) });
  // what it can't clean up in Codex goes to main's log
  const warn = console.warn;
  const lines: string[] = [];
  console.warn = (l: string) => void lines.push(l);
  try {
    m.log('a line');
  } finally {
    console.warn = warn;
  }
  assert.deepEqual(lines, ['a line']);
});

test("the / menu asks for a family's plugin skills", async () => {
  const { call } = harness();
  assert.deepEqual(await call('plugins:skillsFor', 'acp'), [{ name: 'for:acp' }]);
  assert.deepEqual(await call('plugins:skillsFor', undefined), [{ name: 'for:' }]);
});
