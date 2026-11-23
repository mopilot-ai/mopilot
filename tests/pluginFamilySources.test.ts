// Inert native-selection, raw-identity and per-family delivery fixtures; no configured command or vendor runtime runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmp, write } from './support/plugin-store-fixture.ts';
import { whatRuns } from '../shared/plugins/manifest.mjs';
import { pluginReach, componentsOf } from '../shared/plugins/reach.mjs';

const require = createRequire(import.meta.url);
const { readPlugin } = require('../electron/plugins/read.cjs');
const { PluginStore, trustDigest } = require('../electron/plugins/store.cjs');
const { PluginDelivery } = require('../electron/plugins/delivery.cjs');
const { CodexPluginMirror } = require('../electron/plugins/codexMirror.cjs');
const json = (root: string, file: string, value: unknown) => write(path.join(root, file), JSON.stringify(value));
const mcp = (command: string) => ({ shared: { command, args: ['--inert'] } });
const hooks = (command: string) => ({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } });
const manifest = (root: string, family = 'claude', extra: object = {}) =>
  json(root, `.${family}-plugin/plugin.json`, { name: 'inert', ...extra });
const read = async (root: string) => {
  const result = await readPlugin(root);
  assert.equal(result.ok, true, result.error);
  return result.spec;
};
function fixture(t: { after(fn: () => void): void }) {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function record(root: string, source: string, trust: string) {
  const store = new PluginStore({ dir: () => path.join(root, 'fixture-store') });
  json(store.o.dir(), 'installed.json', {
    version: 1,
    plugins: { 'inert@fixture': { path: source, enabled: true, trusted: trust, harnesses: {} } },
  });
  return store;
}

test('Claude merges and Codex replaces same-name sources, with both raw alternatives disclosed', async (t) => {
  const root = fixture(t);
  manifest(root, 'claude', { mcpServers: './declared.json', hooks: './declared-hooks.json' });
  json(root, '.mcp.json', { mcpServers: { ...mcp('default'), extra: { command: 'default-extra' } } });
  json(root, 'declared.json', { mcpServers: mcp('declared') });
  json(root, 'hooks/hooks.json', hooks('default-hook'));
  json(root, 'declared-hooks.json', hooks('declared-hook'));
  const spec = await read(root);
  const plans = spec.execution.plans;
  assert.deepEqual(Object.keys(plans.claude.mcpServers), ['shared', 'extra']);
  assert.deepEqual(Object.keys(plans.codex.mcpServers), ['shared']);
  assert.equal(plans.claude.mcpServers.shared.command, 'declared');
  assert.deepEqual(
    plans.claude.hooks.map((h: { command: string }) => h.command),
    ['default-hook', 'declared-hook'],
  );
  assert.deepEqual(
    plans.codex.hooks.map((h: { command: string }) => h.command),
    ['declared-hook'],
  );
  assert.deepEqual(plans.acp.mcpServers, spec.mcpServers);
  assert.match(whatRuns(spec).join('\n'), /claude mcpServers \.mcp\.json: .*default/);
  assert.match(whatRuns(spec).join('\n'), /codex mcpServers declared\.json: .*declared/);
  assert.match(whatRuns(spec).join('\n'), /codex: \.mcp.json: ignored/);
  assert.equal(pluginReach(spec, 'claude').components.find((c) => c.name === 'extra')?.reach, 'native');
  assert.equal(
    pluginReach(spec, 'codex').components.some((c) => c.name === 'extra'),
    false,
  );
  assert.equal(pluginReach(spec, 'acp').summary, 'partial');
  assert.ok(componentsOf(spec).some((c) => c.name === 'extra'));
});

test('malformed defaults withhold only selecting families and valid Codex overrides remain usable', async (t) => {
  const root = fixture(t);
  manifest(root, 'codex', { mcpServers: mcp('override'), hooks: hooks('override-hook') });
  for (const content of ['{', 'null', '[]', '42', '{"mcpServers":null}', '{"bad":7}']) {
    write(path.join(root, '.mcp.json'), content);
    const spec = await read(root);
    assert.equal(spec.execution.plans.claude.state, 'withheld', content);
    assert.equal(spec.execution.plans.codex.state, 'supported', content);
    assert.equal(spec.execution.plans.acp.state, 'supported', content);
    const store = record(root, root, trustDigest(spec));
    assert.equal((await store.reserveFor('claude')).deliver.length, 0);
    assert.equal((await store.enabledFor('codex')).deliver.length, 1);
    assert.equal(pluginReach(spec, 'claude').summary, 'none');
  }
  fs.rmSync(path.join(root, '.mcp.json'));
  fs.mkdirSync(path.join(root, '.mcp.json'));
  assert.equal((await read(root)).execution.plans.codex.state, 'supported');
  fs.rmdirSync(path.join(root, '.mcp.json'));
  json(root, '.mcp.json', { mcpServers: mcp('repaired') });
  assert.equal((await read(root)).execution.plans.claude.state, 'supported');
});

test('Codex MCP fallback follows declaration type and ./ path requirements', async (t) => {
  const root = fixture(t);
  json(root, '.mcp.json', { mcpServers: mcp('fallback') });
  json(root, 'named.json', { mcpServers: mcp('named') });
  for (const value of [null, 4, [], ['./named.json'], 'named.json', './', './../outside', './/absolute']) {
    manifest(root, 'claude', { mcpServers: value });
    const plan = (await read(root)).execution.plans.codex;
    assert.equal(plan.mcpServers.shared.command, 'fallback', JSON.stringify(value));
  }
  manifest(root, 'claude', { mcpServers: {} });
  assert.deepEqual((await read(root)).execution.plans.codex.mcpServers, {});
  manifest(root, 'claude', { mcpServers: './named.json' });
  assert.equal((await read(root)).execution.plans.codex.mcpServers.shared.command, 'named');
});

test('Codex hook declaration fallback distinguishes wrappers, lists, empty values and invalid nested fields', async (t) => {
  const root = fixture(t);
  json(root, 'hooks/hooks.json', hooks('fallback'));
  json(root, 'named.json', hooks('named'));
  const invalid = [
    null,
    7,
    [],
    [null],
    ['./named.json', {}],
    { Stop: [] },
    { hooks: null },
    { extra: true },
    { description: 7 },
    { hooks: { Stop: null } },
    { hooks: { Stop: [null] } },
    { hooks: { Stop: [{ matcher: 7 }] } },
    { hooks: { Stop: [{ hooks: null }] } },
    ...[
      null,
      {},
      { type: 'unknown' },
      { type: 'command' },
      { type: 'command', command: 'x', timeout: -1 },
      { type: 'command', command: 'x', statusMessage: 7 },
      { type: 'command', command: 'x', commandWindows: 7 },
      { type: 'command', command: 'x', command_windows: 7 },
      { type: 'command', command: 'x', commandWindows: 'a', command_windows: 'b' },
      { type: 'command', command: 'x', async: null },
      { type: 'command', command: 'x', additionalContextLimit: -1 },
      { type: 'mcp_tool', server: 's' },
      { type: 'mcp_tool', server: 's', tool: 't', input: null },
      { type: 'mcp_tool', server: 's', tool: 't', input: { a: [null] } },
    ].map((value) => ({ hooks: { Stop: [{ hooks: [value] }] } })),
  ];
  for (const value of invalid) {
    manifest(root, 'codex', { hooks: value });
    const plan = (await read(root)).execution.plans.codex;
    assert.equal(plan.hooks[0].command, 'fallback', JSON.stringify(value));
  }
  for (const value of [{}, { description: null }, { hooks: {} }, { hooks: { Stop: [{}], UnknownEvent: true } }]) {
    manifest(root, 'codex', { hooks: value });
    assert.deepEqual((await read(root)).execution.plans.codex.hooks, []);
  }
  for (const value of ['./named.json', ['./named.json'], [hooks('first'), hooks('second')], hooks('inline')]) {
    manifest(root, 'codex', { hooks: value });
    const plan = (await read(root)).execution.plans.codex;
    assert.ok(plan.hooks.every((h: { command: string }) => h.command !== 'fallback'));
    assert.equal(plan.state, 'supported');
  }
  manifest(root, 'codex', {
    hooks: {
      description: 'inert',
      hooks: {
        Stop: [
          {
            matcher: null,
            hooks: [
              { type: 'command', command: 'x', timeout: null, async: false, commandWindows: null, additionalContextLimit: 0 },
              { type: 'mcp_tool', server: 's', tool: 't' },
              { type: 'mcp_tool', server: 's', tool: 't', input: { a: [1, 's', true] } },
              { type: 'prompt' },
              { type: 'agent' },
            ],
          },
        ],
      },
    },
  });
  const plan = (await read(root)).execution.plans.codex;
  assert.equal(plan.state, 'supported');
  assert.deepEqual(plan.hookEvents, ['Stop']);
});

test('selected named files fail visibly, raw shapes cannot become empty success, and repair retries', async (t) => {
  const root = fixture(t);
  manifest(root, 'claude', { mcpServers: './missing.json', hooks: './missing-hooks.json' });
  let spec = await read(root);
  for (const family of ['claude', 'codex', 'acp']) assert.equal(spec.execution.plans[family].state, 'withheld');
  for (const value of [null, [], 7]) {
    json(root, 'missing.json', value);
    json(root, 'missing-hooks.json', value);
    spec = await read(root);
    for (const family of ['claude', 'codex', 'acp']) assert.equal(spec.execution.plans[family].state, 'withheld');
  }
  json(root, 'missing.json', { mcpServers: mcp('repaired') });
  json(root, 'missing-hooks.json', { hooks: null });
  assert.equal((await read(root)).execution.plans.codex.state, 'withheld');
  json(root, 'missing-hooks.json', hooks('repaired-hook'));
  spec = await read(root);
  for (const family of ['claude', 'codex', 'acp']) assert.equal(spec.execution.plans[family].state, 'supported');
});

test('portable discovery withholds Codex only; unrelated root JSON never shadows legacy selection', async (t) => {
  const root = fixture(t);
  manifest(root, 'claude', { mcpServers: mcp('claude') });
  manifest(root, 'codex', { mcpServers: mcp('codex') });
  for (const schema of [
    'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    'https://agent-plugins.org/schemas/99/plugin.schema.json',
  ]) {
    json(root, 'plugin.json', { $schema: schema, name: 'portable', mcpServers: { opaque: { command: 'hidden' } } });
    const spec = await read(root);
    assert.equal(spec.execution.plans.codex.state, 'withheld');
    assert.equal(spec.execution.plans.codex.layout, 'plugin.json');
    assert.equal(spec.execution.plans.claude.state, 'supported');
    assert.equal(spec.execution.plans.acp.state, 'supported');
    assert.match(whatRuns(spec).join('\n'), /portable root manifest/);
  }
  for (const value of [{}, { $schema: 'https://unrelated.example/schema' }, { $schema: 1 }, null, []]) {
    json(root, 'plugin.json', value);
    assert.equal((await read(root)).execution.plans.codex.state, 'supported');
  }
  write(path.join(root, 'plugin.json'), '{');
  assert.equal((await read(root)).execution.plans.codex.state, 'supported');
  fs.rmSync(path.join(root, 'plugin.json'));
  fs.mkdirSync(path.join(root, 'plugin.json'));
  assert.equal((await read(root)).execution.plans.codex.state, 'withheld');
  fs.rmdirSync(path.join(root, 'plugin.json'));
  fs.symlinkSync('.claude-plugin/plugin.json', path.join(root, 'plugin.json'));
  assert.equal((await read(root)).execution.plans.codex.state, 'withheld');
});

test('bad alternate manifests and native discovery parents withhold only their affected families', async (t) => {
  const root = fixture(t);
  manifest(root, 'codex', { mcpServers: mcp('safe') });
  write(path.join(root, '.claude-plugin/plugin.json'), '{');
  let spec = await read(root);
  assert.equal(spec.execution.plans.claude.state, 'withheld');
  assert.equal(spec.execution.plans.codex.state, 'supported');
  assert.equal(spec.execution.plans.acp.state, 'withheld');
  manifest(root);
  json(root, '.codex-plugin/plugin.json', []);
  assert.equal((await read(root)).execution.plans.codex.state, 'withheld');
  json(root, '.codex-plugin/plugin.json', {});
  assert.equal((await read(root)).execution.plans.codex.state, 'withheld');
  fs.rmSync(path.join(root, '.codex-plugin'), { recursive: true });
  fs.symlinkSync('.claude-plugin', path.join(root, '.codex-plugin'));
  spec = await read(root);
  assert.equal(spec.execution.plans.codex.state, 'withheld');
  assert.equal(spec.execution.plans.claude.state, 'supported');
  fs.unlinkSync(path.join(root, '.codex-plugin'));
  write(path.join(root, '.codex-plugin'), 'inert');
  assert.equal((await read(root)).execution.plans.codex.state, 'withheld');
  fs.rmSync(path.join(root, '.codex-plugin'));
  fs.rmSync(path.join(root, '.claude-plugin'), { recursive: true });
  json(root, '.mcp.json', { mcpServers: mcp('default') });
  spec = await read(root);
  assert.equal(spec.execution.plans.codex.state, 'withheld');
  assert.equal(spec.execution.plans.claude.state, 'supported');
  assert.equal(spec.execution.plans.acp.state, 'supported');
});

test('opaque keys, raw unknown fields, argv and literal root strings are distinct in trust across copies', async (t) => {
  const base = fixture(t);
  const root = path.join(base, 'source');
  const configure = (command: string, args: string[], extra: object = {}) =>
    manifest(root, 'claude', {
      mcpServers: JSON.parse(JSON.stringify({ constructor: { command, args, ...extra } }).replace('constructor', '__proto__')),
    });
  configure('${PLUGIN_ROOT}/inert', ['a b'], { future: { z: 1, a: [1, 2] }, env: { A: 'b' } });
  const spec = await read(root);
  assert.deepEqual(Object.keys(spec.mcpServers), ['__proto__']);
  const digest = trustDigest(spec);
  const store = new PluginStore({ dir: () => path.join(base, 'store') });
  const installed = await store.install(root, { marketplace: 'fixture', trust: digest });
  assert.equal(trustDigest(await read(installed.record.path)), digest);
  configure('${PLUGIN_ROOT}/inert', ['a b'], { env: { A: 'b' }, future: { a: [1, 2], z: 1 } });
  assert.equal(trustDigest(await read(root)), digest);
  for (const [command, args, extra] of [
    [`${root}/inert`, ['a b'], {}],
    ['${PLUGIN_ROOT}/inert', ['a', 'b'], {}],
    ['${PLUGIN_ROOT}/inert', ['a b'], { future: 2 }],
  ] as [string, string[], object][]) {
    configure(command, args, extra);
    assert.notEqual(trustDigest(await read(root)), digest);
  }
  configure(`${root}/inert`, ['literal']);
  const absolute = await store.preview(root);
  assert.ok((await store.install(root, { marketplace: 'fixture', trust: absolute.trust })).record.path);
});

test('duplicate JSON keys and unsafe numbers cannot alias a reviewed source identity', async (t) => {
  const root = fixture(t);
  manifest(root, 'codex', { mcpServers: mcp('override') });
  for (const text of [
    '{"mcpServers":{"x":{"command":"a","command":"b"}}}',
    '{"x":{"number":9007199254740993}}',
    '{"x":{"number":1e500}}',
  ]) {
    write(path.join(root, '.mcp.json'), text);
    const spec = await read(root);
    assert.equal(spec.execution.plans.claude.state, 'withheld');
    assert.equal(spec.execution.plans.codex.state, 'supported');
  }
  json(root, '.mcp.json', { mcpServers: { x: { command: 'a', unknown: { a: -1.2, b: [], c: null, d: true, e: '\\"' } } } });
  assert.equal((await read(root)).execution.plans.claude.state, 'supported');
});

test('new approval identity does not migrate a legacy approval or forget family preferences', async (t) => {
  const root = fixture(t);
  manifest(root, 'claude', { mcpServers: mcp('old') });
  const spec = await read(root);
  const { execution, ...legacy } = spec;
  const store = record(root, root, trustDigest(legacy));
  for (const family of ['claude', 'codex', 'acp']) assert.equal((await store.enabledFor(family)).deliver.length, 0);
  assert.equal(store.readRecords().records['inert@fixture'].enabled, true);
  assert.equal(store.readRecords().records['inert@fixture'].trusted, trustDigest(legacy));
  record(root, root, trustDigest(spec));
  json(root, '.mcp.json', { mcpServers: mcp('added-default') });
  for (const family of ['claude', 'codex', 'acp']) assert.equal((await store.enabledFor(family)).deliver.length, 0);
});

test('actual store reservation gates Claude folders, ACP payloads and Codex native install calls', async (t) => {
  const base = fixture(t);
  const root = path.join(base, 'source');
  manifest(root, 'codex', { mcpServers: mcp('selected') });
  json(root, 'plugin.json', { $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json' });
  write(path.join(root, '.mcp.json'), '{');
  const spec = await read(root);
  const store = record(base, root, trustDigest(spec));
  const delivery = new PluginDelivery({ store, claudeNative: () => new Set() });
  const claude = await delivery.forClaude();
  assert.deepEqual(claude.plugins, []);
  assert.equal(claude.withheld.length, 1);
  const acp = await delivery.forAcp();
  assert.deepEqual(
    acp.mcpServers.map((s: { command: string }) => s.command),
    ['selected'],
  );
  assert.equal(store.inUse.get(root), 1);
  await acp.release();
  await acp.release();
  await claude.release();
  assert.equal(store.inUse.has(root), false);
  const calls: string[] = [];
  const mirror = new CodexPluginMirror({
    store,
    connected: () => true,
    request: async (method: string) => {
      calls.push(method);
      return { marketplaces: [] };
    },
  });
  await mirror.sync();
  assert.deepEqual(calls, ['plugin/list']);
  assert.equal(store.inUse.has(root), false);
});

test('native path conventions preserve literal POSIX backslashes and reject Windows rooted declarations', async (t) => {
  const root = fixture(t);
  json(root, '.mcp.json', { mcpServers: mcp('fallback') });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32' });
  try {
    for (const source of ['./C:outside', './\\outside', './a\\..\\outside']) {
      manifest(root, 'codex', { mcpServers: source });
      assert.equal((await read(root)).execution.plans.codex.mcpServers.shared.command, 'fallback');
    }
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
  json(root, 'literal\\name.json', { mcpServers: mcp('literal-path') });
  manifest(root, 'claude', { mcpServers: './literal\\name.json' });
  fs.rmSync(path.join(root, '.codex-plugin'), { recursive: true });
  const spec = await read(root);
  assert.equal(spec.execution.plans.codex.mcpServers.shared.command, 'literal-path');
  assert.equal(spec.execution.plans.claude.mcpServers.shared.command, 'literal-path');
});

test('internal component links survive inert copy but alternate native plugin names are explicit', async (t) => {
  const base = fixture(t);
  const root = path.join(base, 'source');
  manifest(root, 'claude');
  json(root, 'linked.json', { mcpServers: mcp('${PLUGIN_ROOT}/linked') });
  fs.symlinkSync('linked.json', path.join(root, '.mcp.json'));
  const store = new PluginStore({ dir: () => path.join(base, 'store') });
  const before = await store.preview(root);
  const installed = await store.install(root, { marketplace: 'fixture', trust: before.trust });
  assert.equal(trustDigest(await read(installed.record.path)), before.trust);
  json(root, '.codex-plugin/plugin.json', { name: 'different', mcpServers: mcp('native') });
  const spec = await read(root);
  assert.equal(spec.execution.plans.codex.state, 'withheld');
  assert.match(spec.execution.plans.codex.reasons.join(' '), /different plugin name/);
  assert.equal(spec.execution.plans.claude.state, 'supported');
});

test('metadata fallback cannot bypass the existing Claude LSP refusal', async (t) => {
  const base = fixture(t);
  const root = path.join(base, 'source');
  manifest(root, 'claude', { lspServers: '../outside.json' });
  manifest(root, 'codex', { mcpServers: mcp('independent') });
  const spec = await read(root);
  assert.equal(spec.execution.plans.claude.state, 'withheld');
  assert.match(spec.execution.plans.claude.reasons.join(' '), /lspServers/);
  assert.equal(spec.execution.plans.codex.state, 'supported');
  const store = record(base, root, trustDigest(spec));
  const delivery = new PluginDelivery({ store, claudeNative: () => new Set() });
  const selected = await delivery.forClaude();
  assert.deepEqual(selected.plugins, []);
  assert.match(selected.withheld[0].why, /lspServers/);
  await selected.release();
});

test('root discovery distinguishes a failed metadata lookup from a root file Codex cannot read', async (t) => {
  const root = fixture(t);
  manifest(root, 'claude', { mcpServers: mcp('legacy') });
  json(root, 'plugin.json', { unrelated: true });
  const file = path.join(root, 'plugin.json');
  const readFile = fs.promises.readFile;
  const error = Object.assign(new Error('fixture only'), { code: 'EACCES' });
  const readMock = t.mock.method(fs.promises, 'readFile', async (...args: Parameters<typeof readFile>) => {
    if (args[0] === file) throw error;
    return readFile(...args);
  });
  assert.equal((await read(root)).execution.plans.codex.state, 'supported');
  readMock.mock.restore();
  const lstat = fs.promises.lstat;
  t.mock.method(fs.promises, 'lstat', async (...args: Parameters<typeof lstat>) => {
    if (args[0] === file) throw error;
    return lstat(...args);
  });
  assert.equal((await read(root)).execution.plans.codex.state, 'withheld');
});
