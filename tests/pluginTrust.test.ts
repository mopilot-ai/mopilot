// Structured plugin trust preserves execution identity across install copies and detects configuration tampering.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { tmp, write, claudePlugin } from './support/plugin-store-fixture.ts';
const { PluginStore, trustDigest } = createRequire(import.meta.url)('../electron/plugins/store.cjs');

const variants = [
  [
    { command: 'node', args: ['a b'] },
    { command: 'node', args: ['a', 'b'] },
  ],
  [{ command: 'node' }, { command: 'node', env: { NODE_OPTIONS: '--require /changed' } }],
  [
    { command: 'node', env: { K: 'a' } },
    { command: 'node', env: { K: 'b' } },
  ],
  [{ command: 'node', env: { K: 'a' } }, { command: 'node' }],
  ...['http', 'sse'].flatMap((type) => [
    [
      { type, url: 'https://mcp.test/' },
      { type, url: 'https://mcp.test/', headers: { Authorization: 'new' } },
    ],
    [
      { type, url: 'https://mcp.test/', headers: { Authorization: 'old' } },
      { type, url: 'https://mcp.test/', headers: { Authorization: 'new' } },
    ],
    [
      { type, url: 'https://mcp.test/', headers: { Authorization: 'old' } },
      { type, url: 'https://mcp.test/' },
    ],
  ]),
];
for (const [index, [before, after]] of variants.entries()) {
  test(`execution configuration ${index} requires fresh trust at install and after cache tampering`, async (t) => {
    const root = tmp();
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const source = claudePlugin(path.join(root, 'source'));
    const store = new PluginStore({ dir: () => path.join(root, 'store') });
    const configure = (folder: string, server: object) =>
      write(path.join(folder, '.mcp.json'), JSON.stringify({ mcpServers: { local: server } }));
    configure(source, before);
    const preview = await store.preview(source);
    configure(source, after);
    await assert.rejects(store.install(source, { marketplace: 'acme', trust: preview.trust }), /changed since/);
    configure(source, before);
    const installed = await store.install(source, { marketplace: 'acme', trust: preview.trust });
    configure(installed.record.path, after);
    const delivery = await store.enabledFor('acp');
    assert.deepEqual(delivery.deliver, []);
    assert.match(delivery.withheld[0].why, /changed since/);
  });
}

test('trust is stable across root relocation and object key order, but retains structured hook boundaries', () => {
  const spec = {
    name: 'tidy',
    root: '/source',
    apps: ['mail'],
    mcpServers: { run: { type: 'stdio', command: '/source/bin', args: ['one two'], env: { B: '2', A: '/source/data' } } },
    hooks: [{ event: 'Stop', matcher: 'x', command: '/source/hook' }],
  };
  const moved = {
    ...spec,
    root: '/installed',
    mcpServers: { run: { env: { A: '/installed/data', B: '2' }, args: ['one two'], command: '/installed/bin', type: 'stdio' } },
    hooks: [{ command: '/installed/hook', matcher: 'x', event: 'Stop' }],
  };
  assert.equal(trustDigest(spec), trustDigest(moved));
  assert.notEqual(trustDigest(spec), trustDigest({ ...spec, hooks: [{ event: 'Stop (x)', command: '/source/hook' }] }));
  assert.notEqual(trustDigest(spec), trustDigest({ ...spec, name: 'other' }));
  assert.notEqual(trustDigest(spec), trustDigest({ ...spec, apps: ['other'] }));
  assert.equal(trustDigest({}), trustDigest({ mcpServers: {}, hooks: [], apps: [] }));
  assert.notEqual(trustDigest({ name: 'loose' }), trustDigest({ name: 'other' }));
  assert.notEqual(
    trustDigest({ hooks: [{ timeout: 10, enabled: true, matcher: null }] }),
    trustDigest({ hooks: [{ timeout: 20, enabled: false, matcher: null }] }),
  );
});

test('a manifestless plugin keeps its admitted name through copying and later delivery', async (t) => {
  const root = tmp();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'loose');
  write(path.join(source, 'skills/note/SKILL.md'), '---\nname: note\n---\nRead me');
  const store = new PluginStore({ dir: () => path.join(root, 'store') });
  const preview = await store.preview(source);
  assert.equal(preview.ok, true);
  const installed = await store.install(source, { marketplace: 'acme', trust: preview.trust });
  assert.equal(installed.id, 'loose@acme');
  assert.equal((await store.enabledFor('acp')).deliver[0].spec.name, 'loose');
});
