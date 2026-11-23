// Independent inert production-reader/store/delivery counterexamples for source accounting.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmp, write } from './support/plugin-store-fixture.ts';
import { whatRuns } from '../shared/plugins/manifest.mjs';
const require = createRequire(import.meta.url);
const { readPlugin } = require('../electron/plugins/read.cjs');
const { PluginStore, trustDigest } = require('../electron/plugins/store.cjs');
const { PluginDelivery } = require('../electron/plugins/delivery.cjs');
const { CodexPluginMirror } = require('../electron/plugins/codexMirror.cjs');
const json = (root: string, file: string, raw: unknown) => write(path.join(root, file), JSON.stringify(raw));
const manifest = (root: string, family: string, extra: object = {}) =>
  json(root, `.${family}-plugin/plugin.json`, { name: 'inert', ...extra });
const setup = (t: { after(fn: () => void): void }) => {
  const base = tmp();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'source');
  fs.mkdirSync(root);
  const store = new PluginStore({ dir: () => path.join(base, 'store') });
  return { base, root, store };
};
const read = async (root: string) => {
  const r = await readPlugin(root);
  assert.equal(r.ok, true, r.error);
  return r.spec;
};
const approveFixture = (store: any, root: string, spec: any) =>
  json(store.o.dir(), 'installed.json', {
    version: 1,
    plugins: { 'inert@fixture': { path: root, enabled: true, trusted: trustDigest(spec), harnesses: {} } },
  });

test('review: alternate-manifest recovery cannot relax the existing Claude LSP refusal', async (t) => {
  const { root, store } = setup(t);
  manifest(root, 'claude', { lspServers: '../outside.json' });
  manifest(root, 'codex', { mcpServers: { safe: { command: 'inert-safe' } } });
  const result = await readPlugin(root);
  if (!result.ok) {
    assert.match(result.error, /lspServers/);
    return;
  }
  approveFixture(store, root, result.spec);
  const delivery = new PluginDelivery({ store, claudeNative: () => new Set() });
  const claude = await delivery.forClaude();
  await claude.release();
  assert.deepEqual(claude.plugins, [], 'a rejected Claude LSP declaration must never cross the native folder boundary');
  assert.equal(result.spec.execution.plans.claude.state, 'withheld');
  assert.equal((await store.enabledFor('codex')).deliver.length, 1);
});

test('review: mixed valid/invalid Codex hook paths select valid paths without default fallback', async (t) => {
  const { root, store } = setup(t);
  const hook = (command: string) => ({ hooks: { Stop: [{ hooks: [{ type: 'command', command }] }] } });
  manifest(root, 'codex', { hooks: ['./named.json', '../invalid.json'] });
  json(root, 'named.json', hook('inert-selected'));
  json(root, 'hooks/hooks.json', hook('inert-ignored'));
  const spec = await read(root);
  assert.deepEqual(
    spec.execution.plans.codex.hooks.map((h: any) => h.command),
    ['inert-selected'],
  );
  assert.deepEqual(
    spec.execution.plans.claude.hooks.map((h: any) => h.command),
    ['inert-ignored'],
  );
  approveFixture(store, root, spec);
  const delivery = new PluginDelivery({ store, claudeNative: () => new Set() });
  const claude = await delivery.forClaude();
  assert.equal(claude.plugins.length, 1);
  await claude.release();
  assert.equal(store.inUse.size, 0);
});

test('review: shared-name alternatives bind opaque names and argv in independently selected manifests', async (t) => {
  const { root, store } = setup(t);
  const servers = (command: string, args: string[]) =>
    JSON.parse(JSON.stringify({ ['__proto__']: { command, args }, constructor: { command: 'inert-constructor' } }));
  manifest(root, 'claude', { mcpServers: servers('inert-claude', ['a b']) });
  manifest(root, 'codex', { mcpServers: servers('inert-codex', ['a', 'b']) });
  const spec = await read(root),
    trusted = trustDigest(spec);
  assert.equal(spec.execution.plans.claude.mcpServers.__proto__.command, 'inert-claude');
  assert.equal(spec.execution.plans.codex.mcpServers.__proto__.command, 'inert-codex');
  assert.match(whatRuns(spec).join('\n'), /claude.*__proto__.*inert-claude/);
  assert.match(whatRuns(spec).join('\n'), /codex.*__proto__.*inert-codex/);
  approveFixture(store, root, spec);
  const delivery = new PluginDelivery({ store, claudeNative: () => new Set() });
  const acp = await delivery.forAcp();
  assert.deepEqual(
    acp.mcpServers.map((s: any) => [s.command, s.args]),
    [
      ['inert-claude', ['a b']],
      ['inert-constructor', []],
    ],
  );
  await acp.release();
  manifest(root, 'codex', { mcpServers: servers('inert-codex', ['a b']) });
  assert.notEqual(trustDigest(await read(root)), trusted);
  for (const family of ['claude', 'codex', 'acp']) assert.equal((await store.enabledFor(family)).deliver.length, 0);
});

test('review: copying a late-added default rejects approval and retry retains preferences and reservations', async (t) => {
  const { root, store } = setup(t);
  manifest(root, 'claude', { mcpServers: { only: { command: '${PLUGIN_ROOT}/inert', args: ['a b'] } } });
  const initial = await store.preview(root);
  const installed = await store.install(root, { marketplace: 'fixture', trust: initial.trust });
  await store.setEnabled(installed.id, false, 'acp');
  const held = await store.reserveFor('claude');
  const cp = fs.promises.cp;
  fs.promises.cp = async function (source: any, dest: any, options: any) {
    const result = await cp.call(this, source, dest, options);
    json(String(dest), '.mcp.json', { mcpServers: { added: { command: 'inert-added' } } });
    return result;
  } as typeof fs.promises.cp;
  try {
    await assert.rejects(store.install(root, { marketplace: 'fixture', trust: initial.trust }), /changed since/);
  } finally {
    fs.promises.cp = cp;
  }
  assert.equal(store.readRecords().records[installed.id].path, installed.record.path);
  assert.equal(store.inUse.get(installed.record.path), 1);
  json(root, '.mcp.json', { mcpServers: { added: { command: 'inert-added' } } });
  const retry = await store.preview(root);
  const replacement = await store.install(root, { marketplace: 'fixture', trust: retry.trust });
  assert.equal(replacement.record.harnesses.acp, false);
  assert.equal(fs.existsSync(installed.record.path), true);
  await store.release(held.deliver.map((d: any) => d.path));
  assert.equal(fs.existsSync(installed.record.path), false);
  assert.equal(trustDigest(await read(replacement.record.path)), retry.trust);
});

test('review: portable refusal prevents marketplace publication while unaffected family remains delivered', async (t) => {
  const { root, store } = setup(t);
  manifest(root, 'claude', { mcpServers: { safe: { command: 'inert-safe' } } });
  json(root, 'plugin.json', {
    $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
    name: 'inert',
    mcp: { servers: { hidden: { command: 'inert-hidden' } } },
  });
  approveFixture(store, root, await read(root));
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
  assert.equal(store.inUse.size, 0);
  const delivery = new PluginDelivery({ store, claudeNative: () => new Set() });
  const claude = await delivery.forClaude();
  assert.equal(claude.plugins.length, 1);
  await claude.release();
  const acp = await delivery.forAcp();
  assert.deepEqual(
    acp.mcpServers.map((s: any) => s.command),
    ['inert-safe'],
  );
  await acp.release();
  assert.equal(store.inUse.size, 0);
});

test('review: raw integer and floating JSON tokens cannot retain approval when Codex hook parsing differs', async (t) => {
  const { root, store } = setup(t);
  manifest(root, 'claude');
  json(root, 'hooks/hooks.json', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'inert-default' }] }] } });
  const raw = (token: string) =>
    `{"name":"inert","hooks":{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"inert-inline","timeout":${token}}]}]}}}`;
  for (const [integer, fractional] of [
    ['1', '1.0'],
    ['1', '1e0'],
    ['0', '-0'],
  ]) {
    write(path.join(root, '.codex-plugin/plugin.json'), raw(integer));
    const before = await read(root);
    const digest = trustDigest(before);
    approveFixture(store, root, before);
    write(path.join(root, '.codex-plugin/plugin.json'), raw(fractional));
    const after = await read(root);
    assert.notEqual(trustDigest(after), digest, `native integer token ${integer} must not alias ${fractional}`);
    const codex = after.execution.plans.codex;
    assert.ok(codex.state === 'withheld' || codex.hooks.every((h: any) => h.command !== 'inert-inline'), fractional);
    for (const family of ['claude', 'codex', 'acp']) assert.equal((await store.enabledFor(family)).deliver.length, 0);
  }
});

test('review: unrelated root JSON ambiguity cannot shadow supported legacy discovery', async (t) => {
  const { root } = setup(t);
  manifest(root, 'claude');
  for (const raw of ['{"ordinary":9007199254740993}', '{"unrelated":1,"unrelated":2}']) {
    write(path.join(root, 'plugin.json'), raw);
    assert.equal((await read(root)).execution.plans.codex.state, 'supported', raw);
  }
});

test('review: lexical numeric checks cover named hooks, inline lists, and preserve valid fractional MCP input', async (t) => {
  const { root } = setup(t);
  manifest(root, 'claude');
  json(root, 'hooks/hooks.json', { hooks: { Stop: [{ hooks: [{ type: 'command', command: 'inert-default' }] }] } });
  const hook = (field: string, token: string) =>
    `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"inert-selected","${field}":${token}}]}]}}`;
  for (const field of ['timeout', 'additionalContextLimit']) {
    manifest(root, 'codex', { hooks: './named.json' });
    write(path.join(root, 'named.json'), hook(field, '1e0'));
    assert.equal((await read(root)).execution.plans.codex.state, 'withheld', `named ${field}`);
    write(path.join(root, '.codex-plugin/plugin.json'), `{"name":"inert","hooks":[${hook(field, '1e0')}]}`);
    const list = (await read(root)).execution.plans.codex;
    assert.ok(list.state === 'withheld' || list.hooks.every((h: any) => h.command !== 'inert-selected'), `inline list ${field}`);
  }
  const raw =
    '{"name":"inert","hooks":{"hooks":{"Stop":[{"hooks":[{"type":"mcp_tool","server":"inert","tool":"inert","input":{"__proto__":{"decimal":1.5},"constructor":[1.0,2]}}]}]}}}';
  write(path.join(root, '.codex-plugin/plugin.json'), raw);
  const spec = await read(root);
  assert.equal(spec.execution.plans.codex.state, 'supported');
  assert.deepEqual(spec.execution.plans.codex.hooks, []);
  write(
    path.join(root, '.codex-plugin/plugin.json'),
    raw.replace('"__proto__":{"decimal":1.5},"constructor":[1.0,2]', '"constructor":[1.0,2],"__proto__":{"decimal":1.5}'),
  );
  assert.equal(trustDigest(await read(root)), trustDigest(spec), 'lexical metadata must preserve key-order equivalence');
});
