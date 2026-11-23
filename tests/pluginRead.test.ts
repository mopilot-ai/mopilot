// Reading plugin folders and MoPilot's own plugin store (electron/plugins/read.cjs, store.cjs): install
// gated by the trust digest, reinstall into fresh folders, folders a session holds, and what each family gets.
// Data is made up; every folder is a temporary one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { readPlugin } = require('../electron/plugins/read.cjs');

import { tmp, write, claudePlugin } from './support/plugin-store-fixture.ts';

test('a Claude-layout plugin folder reads into one spec', async () => {
  const root = claudePlugin(tmp());
  const r = await readPlugin(root);
  assert.ok(r.ok);
  const s = r.spec;
  assert.equal(s.name, 'stripe');
  assert.equal(s.layout, '.claude-plugin/plugin.json');
  assert.deepEqual(s.skills, [{ name: 'test-cards', description: 'Cards', file: path.join(root, 'skills/test-cards/SKILL.md') }]);
  assert.deepEqual(s.commands.map((c: { name: string }) => c.name).sort(), ['deep:nested', 'explain']);
  assert.deepEqual(
    s.agents.map((c: { name: string }) => c.name),
    ['company-researcher'],
  );
  assert.deepEqual(s.hooks, [{ event: 'SessionStart', matcher: undefined, command: `${root}/hi` }]);
  assert.deepEqual(s.mcpServers, { stripe: { type: 'http', url: 'https://mcp.stripe.com', headers: {} } });
  assert.deepEqual(s.apps, []);
  assert.deepEqual(s.problems, []);
});

test('a Codex-layout plugin with app connectors and named files', async () => {
  const root = tmp();
  write(
    path.join(root, '.codex-plugin/plugin.json'),
    JSON.stringify({
      name: 'gmail',
      skills: './skills/',
      mcpServers: './.mcp.json',
      apps: './.app.json',
      hooks: './missing-hooks.json',
      interface: { displayName: 'Gmail' },
    }),
  );
  write(path.join(root, '.app.json'), JSON.stringify({ apps: { gmail: { id: 'connector_1' } } }));
  write(path.join(root, '.mcp.json'), '{ not json');
  const r = await readPlugin(root);
  assert.ok(r.ok);
  assert.equal(r.spec.displayName, 'Gmail');
  assert.deepEqual(r.spec.apps, ['gmail']);
  assert.deepEqual(r.spec.mcpServers, {});
  assert.equal(r.spec.problems.length, 2);
  assert.match(r.spec.problems[0], /^\.mcp\.json: /);
  assert.equal(r.spec.problems[1], 'missing-hooks.json: not found');
});

test('hooks given inline in the manifest, and a component path that leaves the plugin', async () => {
  const root = tmp();
  write(
    path.join(root, '.claude-plugin/plugin.json'),
    JSON.stringify({ name: 'p', hooks: { Stop: [{ hooks: [{ command: 'bye' }] }] }, apps: '/etc/apps.json' }),
  );
  const r = await readPlugin(root);
  assert.ok(r.ok);
  assert.deepEqual(r.spec.hooks, [{ event: 'Stop', matcher: undefined, command: 'bye' }]);
  assert.deepEqual(r.spec.apps, []);
  assert.deepEqual(r.spec.problems, ['apps: "/etc/apps.json" is not a path inside the plugin']);
});

test('every hooks and MCP file the manifest lists is read, and linked commands are followed', async () => {
  const root = tmp();
  write(
    path.join(root, '.claude-plugin/plugin.json'),
    JSON.stringify({
      name: 'p',
      hooks: ['./h1.json', './h2.json'],
      mcpServers: ['./m1.json', { two: { command: 'b' } }],
      apps: ['./a1.json', './a2.json'],
    }),
  );
  write(path.join(root, 'h1.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'one' }] }] } }));
  write(path.join(root, 'h2.json'), JSON.stringify({ hooks: { Stop: [{ hooks: [{ command: 'two' }] }] } }));
  write(path.join(root, 'm1.json'), JSON.stringify({ mcpServers: { one: { command: 'a' } } }));
  write(path.join(root, 'a1.json'), JSON.stringify({ apps: { gmail: {} } }));
  write(path.join(root, 'a2.json'), JSON.stringify({ apps: { gmail: {}, drive: {} } }));
  write(path.join(root, 'elsewhere/cmds/go.md'), 'go');
  write(path.join(root, 'elsewhere/one.md'), 'one');
  fs.mkdirSync(path.join(root, 'commands'));
  fs.symlinkSync('../elsewhere/cmds', path.join(root, 'commands/linked'));
  fs.symlinkSync('../elsewhere/one.md', path.join(root, 'commands/one.md'));
  fs.symlinkSync('../nowhere.md', path.join(root, 'commands/broken.md'));
  const r = await readPlugin(root);
  assert.ok(r.ok);
  assert.deepEqual(
    r.spec.hooks.map((h: { command: string }) => h.command),
    ['one', 'two'],
  );
  assert.deepEqual(Object.keys(r.spec.mcpServers), ['one', 'two']);
  assert.deepEqual(r.spec.apps, ['drive', 'gmail']);
  assert.deepEqual(r.spec.commands.map((c: { name: string }) => c.name).sort(), ['linked:go', 'one']);
});

test('a command link that loops is an error, not a skipped file', async () => {
  const root = tmp();
  write(path.join(root, '.claude-plugin/plugin.json'), '{"name":"p"}');
  fs.mkdirSync(path.join(root, 'commands'));
  fs.symlinkSync('loop', path.join(root, 'commands/loop'));
  const r = await readPlugin(root);
  assert.equal(r.ok, false);
  assert.match(r.error, /ELOOP/);
});

test('manifest problems and MCP problems both reach the spec', async () => {
  const root = tmp();
  write(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'p', commands: '../out' }));
  write(path.join(root, '.mcp.json'), JSON.stringify({ mcpServers: { bad: {} } }));
  const r = await readPlugin(root);
  assert.ok(r.ok);
  assert.deepEqual(r.spec.problems, [
    'commands: "../out" is not a path inside the plugin',
    'MCP server "bad" isn\'t a local command or an http/sse URL',
  ]);
});

test('a folder without a manifest is a plugin named after itself, if the name is usable', async () => {
  const base = tmp();
  const named = path.join(base, 'just-skills');
  write(path.join(named, 'skills/a/SKILL.md'), 'x');
  const r = await readPlugin(named);
  assert.ok(r.ok);
  assert.equal(r.spec.name, 'just-skills');
  assert.equal(r.spec.layout, 'none');
  const unnamed = path.join(base, 'has space');
  fs.mkdirSync(unnamed);
  assert.deepEqual(await readPlugin(unnamed), { ok: false, error: 'No .claude-plugin/plugin.json or .codex-plugin/plugin.json' });
  // a folder that isn't there (or a file) is not a manifest-less plugin
  assert.deepEqual(await readPlugin(path.join(base, 'gone')), { ok: false, error: `${path.join(base, 'gone')} isn't a plugin folder` });
  write(path.join(base, 'file'), 'x');
  assert.equal((await readPlugin(path.join(base, 'file'))).ok, false);
  // a folder that can't be looked at says why, rather than "not a plugin folder"
  const shut = path.join(base, 'shut');
  fs.mkdirSync(path.join(shut, 'inner'), { recursive: true });
  fs.chmodSync(shut, 0o000);
  try {
    const r2 = await readPlugin(path.join(shut, 'inner'));
    assert.equal(r2.ok, false);
    assert.match(r2.error, /EACCES/);
  } finally {
    fs.chmodSync(shut, 0o755);
  }
});

test('unreadable manifests and component folders are errors, not empty plugins', async () => {
  const dirManifest = tmp();
  fs.mkdirSync(path.join(dirManifest, '.claude-plugin/plugin.json'), { recursive: true });
  const a = await readPlugin(dirManifest);
  assert.equal(a.ok, false);
  assert.match(a.error, /^\.claude-plugin\/plugin\.json: /);

  const badJson = tmp();
  write(path.join(badJson, '.claude-plugin/plugin.json'), '{');
  assert.deepEqual(await readPlugin(badJson), { ok: false, error: 'plugin.json is not valid JSON' });

  const skillDir = tmp();
  write(path.join(skillDir, '.claude-plugin/plugin.json'), '{"name":"p"}');
  fs.mkdirSync(path.join(skillDir, 'skills/x/SKILL.md'), { recursive: true });
  const b = await readPlugin(skillDir);
  assert.equal(b.ok, false);
  assert.match(b.error, /EISDIR/);

  const locked = tmp();
  write(path.join(locked, '.claude-plugin/plugin.json'), '{"name":"p"}');
  fs.mkdirSync(path.join(locked, 'commands'));
  fs.chmodSync(path.join(locked, 'commands'), 0o000);
  try {
    const c = await readPlugin(locked);
    assert.equal(c.ok, false);
    assert.match(c.error, /EACCES/);
  } finally {
    fs.chmodSync(path.join(locked, 'commands'), 0o755);
  }
});
