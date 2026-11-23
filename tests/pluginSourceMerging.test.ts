// Inert default-source accounting fixtures: no plugin install, enabled runtime, server, or hook is launched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmp, write } from './support/plugin-store-fixture.ts';
import { whatRuns } from '../shared/plugins/manifest.mjs';

const { readPlugin } = createRequire(import.meta.url)('../electron/plugins/read.cjs');
const { PluginStore, trustDigest } = createRequire(import.meta.url)('../electron/plugins/store.cjs');
const { PluginDelivery } = createRequire(import.meta.url)('../electron/plugins/delivery.cjs');
const hook = (command: string) => ({ Stop: [{ hooks: [{ type: 'command', command }] }] });
const mcp = (command: string) => ({ shared: { command, args: ['--inert'] } });
const json = (root: string, file: string, value: unknown) => write(path.join(root, file), JSON.stringify(value));

test('Claude defaults accompany explicit hooks and MCP declarations in disclosure', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  json(root, '.claude-plugin/plugin.json', {
    name: 'inert',
    hooks: hook('declared-hook'),
    mcpServers: { declared: { command: 'declared-mcp' } },
  });
  json(root, 'hooks/hooks.json', { hooks: hook('default-hook') });
  json(root, '.mcp.json', { mcpServers: { base: { command: 'default-mcp' } } });
  const read = await readPlugin(root);
  assert.equal(read.ok, true);
  const summary = whatRuns(read.spec).join('\n');
  assert.match(summary, /default-hook/);
  assert.match(summary, /default-mcp/);
});

test('changing an undisclosed Claude default changes trust even with explicit sources', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  json(root, '.claude-plugin/plugin.json', { name: 'inert', hooks: hook('declared-hook'), mcpServers: {} });
  json(root, 'hooks/hooks.json', { hooks: hook('before') });
  const before = trustDigest((await readPlugin(root)).spec);
  json(root, 'hooks/hooks.json', { hooks: hook('after') });
  assert.notEqual(trustDigest((await readPlugin(root)).spec), before);
});

test('Codex-only declarations cannot hide defaults that whole-folder Claude delivery can read', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  json(root, '.codex-plugin/plugin.json', { name: 'inert', hooks: { hooks: hook('codex-hook') }, mcpServers: mcp('codex-mcp') });
  json(root, 'hooks/hooks.json', { hooks: hook('claude-default-hook') });
  json(root, '.mcp.json', { mcpServers: mcp('claude-default-mcp') });
  const read = await readPlugin(root);
  assert.equal(read.ok, true);
  assert.match(whatRuns(read.spec).join('\n'), /claude-default/);
  const before = trustDigest(read.spec);
  json(root, '.mcp.json', { mcpServers: mcp('changed-claude-default') });
  assert.notEqual(trustDigest((await readPlugin(root)).spec), before);
});

test('Codex explicit overrides remain the selected configuration for ACP translation', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  json(root, '.codex-plugin/plugin.json', { name: 'inert', hooks: { hooks: hook('codex-hook') }, mcpServers: mcp('codex-mcp') });
  json(root, 'hooks/hooks.json', { hooks: hook('default-hook') });
  json(root, '.mcp.json', { mcpServers: { ...mcp('default-mcp'), extra: { command: 'default-extra' } } });
  const read = await readPlugin(root);
  assert.equal(read.ok, true);
  assert.deepEqual(
    read.spec.hooks.map((h: { command: string }) => h.command),
    ['codex-hook'],
  );
  assert.deepEqual(Object.keys(read.spec.mcpServers), ['shared']);
  assert.equal(read.spec.mcpServers.shared.command, 'codex-mcp');
});

test('all-family trust refuses delivery after an executable default changes', async (t) => {
  const base = tmp();
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const source = path.join(base, 'source');
  json(source, '.claude-plugin/plugin.json', { name: 'inert', mcpServers: { declared: { command: 'declared-mcp' } } });
  json(source, '.mcp.json', { mcpServers: { base: { command: 'before' } } });
  const store = new PluginStore({ dir: () => path.join(base, 'scratch-store') });
  // Only a fixture record is written. Do not call install, setEnabled, or any real plugin/runtime API.
  json(path.join(base, 'scratch-store'), 'installed.json', {
    version: 1,
    plugins: { 'inert@fixture': { path: source, enabled: true, trusted: trustDigest((await readPlugin(source)).spec) } },
  });
  json(source, '.mcp.json', { mcpServers: { base: { command: 'after' } } });
  const results = await Promise.all(
    ['claude', 'codex', 'acp'].map(async (family) => {
      const result = await store.enabledFor(family);
      return { family, delivered: result.deliver.length, withheld: result.withheld.length };
    }),
  );
  assert.deepEqual(
    results,
    ['claude', 'codex', 'acp'].map((family) => ({ family, delivered: 0, withheld: 1 })),
  );
});

test('native folder and ACP translation demonstrably expose different source sets before any runtime starts', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  json(root, '.claude-plugin/plugin.json', { name: 'inert', mcpServers: { declared: { command: 'declared-mcp' } } });
  json(root, '.mcp.json', { mcpServers: { base: { command: 'default-mcp' } } });
  const read = await readPlugin(root);
  const delivery = new PluginDelivery({
    store: {
      reserveFor: async () => ({ deliver: [{ id: 'inert@fixture', path: root, spec: read.spec }], withheld: [], error: null }),
      release: async () => {},
    },
    claudeNative: () => new Set(),
  });
  const claude = await delivery.forClaude();
  assert.deepEqual(claude.plugins, [{ type: 'local', path: root }]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(claude.plugins[0].path, '.mcp.json'), 'utf8')).mcpServers.base.command, 'default-mcp');
  const acp = await delivery.forAcp();
  assert.deepEqual(
    acp.mcpServers.map((s: { command: string }) => s.command),
    ['declared-mcp'],
  );
  await claude.release();
  await acp.release();
});

test('a Claude-valid MCP list cannot hide a default selected by the admitted Codex fallback', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  json(root, '.claude-plugin/plugin.json', { name: 'inert', mcpServers: ['./declared.json'] });
  json(root, 'declared.json', { mcpServers: mcp('claude-declared') });
  json(root, '.mcp.json', { mcpServers: mcp('codex-default') });
  const read = await readPlugin(root);
  assert.equal(read.ok, true);
  assert.equal(read.spec.mcpServers.shared.command, 'claude-declared');
  assert.match(whatRuns(read.spec).join('\n'), /codex-default/);
});

test('two supported manifests do not hide the Codex-selected execution configuration', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  json(root, '.claude-plugin/plugin.json', { name: 'inert', mcpServers: mcp('claude-config') });
  json(root, '.codex-plugin/plugin.json', { name: 'inert', mcpServers: mcp('codex-config') });
  const read = await readPlugin(root);
  assert.equal(read.ok, true);
  assert.equal(read.spec.layout, '.claude-plugin/plugin.json');
  assert.match(whatRuns(read.spec).join('\n'), /codex-config/);
});
