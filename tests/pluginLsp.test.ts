// Inert LSP configuration is disclosed, covered per harness and bound to plugin trust without launching a server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { tmp, write } from './support/plugin-store-fixture.ts';
import { readManifest, whatRuns, trustConfiguration } from '../shared/plugins/manifest.mjs';
import { componentsOf, pluginReach } from '../shared/plugins/reach.mjs';

const { readPlugin } = createRequire(import.meta.url)('../electron/plugins/read.cjs');
const { PluginStore, trustDigest } = createRequire(import.meta.url)('../electron/plugins/store.cjs');
const config = { command: 'inert-language-server', args: ['--stdio'], extensionToLanguage: { '.test': 'test' } };
const manifest = (root: string, extra: object = {}) =>
  write(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'language', ...extra }));

test('default, inline and named LSP sources merge in order and every field is retained', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  manifest(root, { lspServers: ['./extra.json', { replace: { ...config, command: 'inline-last' } }] });
  write(path.join(root, '.lsp.json'), JSON.stringify({ base: config, replace: config }));
  write(path.join(root, 'extra.json'), JSON.stringify({ named: { ...config, initializationOptions: { flag: true } }, replace: {} }));
  const read = await readPlugin(root);
  assert.equal(read.ok, true);
  assert.deepEqual(read.spec.lspServers, {
    base: config,
    named: { ...config, initializationOptions: { flag: true } },
    replace: { ...config, command: 'inline-last' },
  });
  assert.equal(componentsOf(read.spec).filter((c) => c.kind === 'lspServers').length, 3);
  assert.deepEqual(
    whatRuns(read.spec).filter((line) => line.startsWith('lsp ')),
    Object.entries(read.spec.lspServers)
      .map(([name, value]) => `lsp ${name}: ${JSON.stringify(value)}`)
      .sort(),
  );
  assert.equal(pluginReach(read.spec, 'claude').summary, 'full');
  for (const family of ['codex', 'acp']) {
    assert.equal(pluginReach(read.spec, family).summary, 'none');
    assert.ok(pluginReach(read.spec, family).components.every((c) => c.why === 'plugin.lspClaudeOnly'));
    assert.equal(pluginReach({ ...read.spec, skills: [{ name: 'help' }] }, family).summary, 'partial');
  }
});

test('absent defaults, manifestless defaults and unrecognized server shapes cannot hide LSP configuration', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const loose = path.join(root, 'loose');
  write(path.join(loose, '.lsp.json'), '{"__proto__":{"command":"inert"},"constructor":null,"unknown":[1]}');
  const read = await readPlugin(loose);
  assert.equal(read.ok, true);
  assert.deepEqual(Object.keys(read.spec.lspServers), ['__proto__', 'constructor', 'unknown']);
  assert.equal(whatRuns(read.spec).filter((line) => line.startsWith('lsp ')).length, 3);
  assert.ok(whatRuns(read.spec).includes('lsp constructor: null'));
  manifest(root, { lspServers: { inline: config } });
  assert.deepEqual((await readPlugin(root)).spec.lspServers, { inline: config });
  manifest(root);
  assert.deepEqual((await readPlugin(root)).spec.lspServers, {});
});

test('bad LSP references and unreadable or malformed configs refuse preview with a recoverable error', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const invalid of [null, 7, '../outside.json', ['/absolute.json']]) {
    const result = readManifest(JSON.stringify({ name: 'language', lspServers: invalid }), '.claude-plugin/plugin.json');
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.error, /lspServers/);
  }
  const store = new PluginStore({ dir: () => path.join(root, 'store') });
  manifest(root, { lspServers: './missing.json' });
  assert.match((await store.preview(root)).error, /missing.json: not found/);
  manifest(root);
  for (const content of ['{', 'null', '[]', '42']) {
    write(path.join(root, '.lsp.json'), content);
    const result = await store.preview(root);
    assert.equal(result.ok, false);
    assert.match(result.error, /LSP|\.lsp\.json/);
  }
  fs.rmSync(path.join(root, '.lsp.json'));
  fs.mkdirSync(path.join(root, '.lsp.json'));
  assert.equal((await store.preview(root)).ok, false);
  fs.rmdirSync(path.join(root, '.lsp.json'));
  write(path.join(root, '.lsp.json'), JSON.stringify({ language: config }));
  assert.equal((await store.preview(root)).ok, true);
});

const variants = [
  { ...config, command: 'different-inert-server' },
  { ...config, args: ['one two'] },
  { ...config, args: ['one', 'two'] },
  { ...config, env: { INERT_OPTION: 'changed' } },
  { ...config, extensionToLanguage: { '.other': 'test' } },
  { ...config, initializationOptions: { nesting: { enabled: true } } },
  { ...config, settings: { diagnostic: false } },
  { ...config, unknownFutureField: 'retained' },
];
test('every LSP configuration change invalidates preview and cache trust for every harness', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  manifest(source);
  const store = new PluginStore({ dir: () => path.join(root, 'store') });
  const configure = (folder: string, server: object) => write(path.join(folder, '.lsp.json'), JSON.stringify({ language: server }));
  configure(source, config);
  const preview = await store.preview(source);
  for (const variant of variants) {
    configure(source, variant);
    await assert.rejects(store.install(source, { marketplace: 'inert', trust: preview.trust }), /changed since/);
  }
  configure(source, config);
  const installed = await store.install(source, { marketplace: 'inert', trust: preview.trust });
  assert.equal((await store.enabledFor('claude')).deliver.length, 1);
  for (const variant of variants) {
    configure(installed.record.path, variant);
    for (const family of ['claude', 'codex', 'acp']) {
      const result = await store.enabledFor(family);
      assert.deepEqual(result.deliver, []);
      assert.match(result.withheld[0].why, /changed since/);
    }
  }
  write(path.join(installed.record.path, '.lsp.json'), '{');
  assert.equal((await store.enabledFor('claude')).deliver.length, 0);
  assert.match((await store.enabledFor('claude')).withheld[0].why, /\.lsp\.json/);
});

test('structured LSP trust retains argv and opaque names, canonicalizes keys, and preserves old non-LSP approvals', () => {
  const spec = { name: 'language', layout: 'none', mcpServers: {}, hooks: [], apps: [] };
  const oldDigest = crypto
    .createHash('sha256')
    .update(JSON.stringify({ apps: [], hooks: [], layout: 'none', mcpServers: {}, name: 'language' }))
    .digest('hex');
  assert.equal(trustDigest(spec), oldDigest);
  assert.equal(trustDigest({ ...spec, lspServers: {} }), oldDigest);
  const one = {
    ...spec,
    root: '/source',
    lspServers: { 'name:"\\': { command: '${CLAUDE_PLUGIN_ROOT}/inert', args: ['a b'], env: { B: 'b', A: 'a' } } },
  };
  const relocated = {
    ...spec,
    root: '/copy',
    lspServers: { 'name:"\\': { env: { A: 'a', B: 'b' }, args: ['a b'], command: '${CLAUDE_PLUGIN_ROOT}/inert' } },
  };
  assert.equal(trustDigest(one), trustDigest(relocated));
  assert.notEqual(trustDigest(one), oldDigest);
  assert.notEqual(
    trustDigest(one),
    trustDigest({
      ...one,
      lspServers: { 'name:"\\': { command: '${CLAUDE_PLUGIN_ROOT}/inert', args: ['a', 'b'], env: { B: 'b', A: 'a' } } },
    }),
  );
  assert.notEqual(trustDigest(one), trustDigest({ ...one, lspServers: { renamed: config } }));
  assert.deepEqual(trustConfiguration(spec), trustConfiguration({ ...spec, lspServers: {} }));
});

test('a legacy approval cannot authorize an LSP configuration it never accounted for', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  manifest(source);
  const store = new PluginStore({ dir: () => path.join(root, 'store') });
  const legacy = await store.preview(source);
  const installed = await store.install(source, { marketplace: 'inert', trust: legacy.trust });
  write(path.join(installed.record.path, '.lsp.json'), JSON.stringify({ language: config }));
  for (const family of ['claude', 'codex', 'acp']) {
    const result = await store.enabledFor(family);
    assert.deepEqual(result.deliver, []);
    assert.match(result.withheld[0].why, /changed since/);
  }
  assert.equal(store.readRecords().records[installed.id].trusted, legacy.trust);
  assert.equal(store.readRecords().records[installed.id].enabled, true);
});

test('raw LSP strings never alias placeholders with absolute paths and unchanged absolute commands copy safely', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  manifest(source);
  const store = new PluginStore({ dir: () => path.join(root, 'store') });
  const configure = (folder: string, command: string, arg: string) =>
    write(path.join(folder, '.lsp.json'), JSON.stringify({ language: { ...config, command, args: [arg] } }));
  configure(source, 'inert-language-server', '${PLUGIN_ROOT}/payload');
  const preview = await store.preview(source);
  const installed = await store.install(source, { marketplace: 'inert', trust: preview.trust });
  configure(installed.record.path, 'inert-language-server', `${installed.record.path}/payload`);
  assert.equal((await store.enabledFor('claude')).deliver.length, 0);
  configure(source, `${source}/inert-language-server`, 'unchanged');
  const absolute = await store.preview(source);
  assert.ok(absolute.runs.some((line: string) => line.startsWith('lsp ') && line.includes(`${source}/inert-language-server`)));
  const copied = await store.install(source, { marketplace: 'inert', trust: absolute.trust });
  assert.equal((await store.enabledFor('claude')).deliver[0].path, copied.record.path);
});

test('LSP declarations in a Codex-only manifest cannot claim Claude delivery or hide a default server', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, '.codex-plugin/plugin.json');
  write(path.join(root, '.lsp.json'), JSON.stringify({ language: { ...config, command: 'default-inert-server' } }));
  for (const declared of [{ language: config }, {}, [], './.lsp.json']) {
    write(file, JSON.stringify({ name: 'language', lspServers: declared }));
    const rejected = await readPlugin(root);
    assert.equal(rejected.ok, false);
    assert.match(rejected.error, /lspServers.*\.codex-plugin/);
  }
  write(file, JSON.stringify({ name: 'language' }));
  const defaultOnly = await readPlugin(root);
  assert.equal(defaultOnly.ok, true);
  assert.equal(defaultOnly.spec.lspServers.language.command, 'default-inert-server');
  assert.equal(pluginReach(defaultOnly.spec, 'claude').summary, 'full');
});
