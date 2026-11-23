// Reading plugin folders and MoPilot's own plugin store (electron/plugins/read.cjs, store.cjs): install
// gated by the trust digest, reinstall into fresh folders, folders a session holds, and what each family gets.
// Data is made up; every folder is a temporary one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PluginStore, trustDigest } = require('../electron/plugins/store.cjs');

import { tmp, write, claudePlugin } from './support/plugin-store-fixture.ts';

function setup() {
  const dir = tmp();
  const changes: string[][] = [];
  let t = 1000;
  const store = new PluginStore({ dir: () => dir, onChange: (ids: string[]) => changes.push(ids), now: () => t++ });
  return { dir, store, changes };
}

async function installStripe(store: InstanceType<typeof PluginStore>, src = claudePlugin(tmp())) {
  const p = await store.preview(src);
  assert.ok(p.ok);
  return { src, preview: p, result: await store.install(src, { marketplace: 'official', trust: p.trust, origin: 'marketplace' }) };
}

test('preview shows what a plugin runs and the digest an install must name', async () => {
  const { store } = setup();
  const p = await store.preview(claudePlugin(tmp()));
  assert.ok(p.ok);
  assert.deepEqual(
    p.runs.filter((line: string) => line.includes('mcpServers .mcp.json:')),
    ['acp', 'claude', 'codex'].map(
      (family) => `${family} mcpServers .mcp.json: {"mcpServers":{"stripe":{"type":"http","url":"https://mcp.stripe.com"}}}`,
    ),
  );
  assert.ok(p.runs.some((line: string) => line.startsWith('claude hooks ') && line.includes('${CLAUDE_PLUGIN_ROOT}/hi')));
  assert.equal(p.trust, trustDigest(p.spec));
  const unnamed = path.join(tmp(), 'has space');
  fs.mkdirSync(unnamed);
  assert.deepEqual(await store.preview(unnamed), { ok: false, error: 'No .claude-plugin/plugin.json or .codex-plugin/plugin.json' });
});

test('install copies the plugin (without .git) into its own folder and records it', async () => {
  const { dir, store, changes } = setup();
  const { result } = await installStripe(store);
  assert.equal(result.id, 'stripe@official');
  assert.match(result.record.path, /cache\/official\/stripe\/0\.10\.3-[0-9a-f]{8}$/);
  assert.ok(fs.existsSync(path.join(result.record.path, 'skills/test-cards/SKILL.md')));
  assert.equal(fs.existsSync(path.join(result.record.path, '.git')), false);
  assert.deepEqual(changes, [['stripe@official']]);
  const saved = JSON.parse(fs.readFileSync(path.join(dir, 'installed.json'), 'utf8'));
  assert.equal(saved.version, 1);
  assert.deepEqual(Object.keys(saved.plugins), ['stripe@official']);
  assert.equal(saved.plugins['stripe@official'].installedAt, 1000);
  const listed = await store.list();
  assert.equal(listed.error, null);
  assert.equal(listed.plugins[0].spec.name, 'stripe');
  // nothing is cached: a later edit to the installed folder is what the next read sees
  write(path.join(result.record.path, '.mcp.json'), JSON.stringify({ mcpServers: { added: { command: 'sh' } } }));
  assert.deepEqual((await store.enabledFor('claude')).withheld, [
    { id: 'stripe@official', why: 'What this plugin runs changed since you trusted it.' },
  ]);
});

test('install is refused when the folder no longer matches what the user trusted, or names a bad marketplace', async () => {
  const { store } = setup();
  const src = claudePlugin(tmp());
  const p = await store.preview(src);
  write(path.join(src, '.mcp.json'), JSON.stringify({ mcpServers: { evil: { command: 'curl', args: ['x'] } } }));
  await assert.rejects(store.install(src, { marketplace: 'official', trust: p.trust }), /changed since you reviewed/);
  await assert.rejects(store.install(src, { marketplace: 'bad name', trust: p.trust }), /isn't a usable marketplace name/);
  await assert.rejects(store.install(path.join(tmp(), 'gone'), { marketplace: 'm', trust: 'x' }), /isn't a plugin folder/);
  // a failed mutation doesn't block the next one
  assert.equal((await installStripe(store)).result.id, 'stripe@official');
});

test('a copy that fails leaves no staging folder behind', async () => {
  const { dir, store } = setup();
  const src = claudePlugin(tmp());
  const p = await store.preview(src);
  write(path.join(src, 'scripts/run.sh'), 'echo');
  fs.chmodSync(path.join(src, 'scripts/run.sh'), 0o000);
  try {
    await assert.rejects(store.install(src, { marketplace: 'official', trust: p.trust }), /EACCES/);
  } finally {
    fs.chmodSync(path.join(src, 'scripts/run.sh'), 0o644);
  }
  assert.deepEqual(fs.readdirSync(path.join(dir, 'cache')), []);
});

test('links are installed as what they point at; one leading out of the plugin fails the install', async () => {
  const { dir, store } = setup();
  const src = claudePlugin(tmp());
  write(path.join(src, 'shared/common/SKILL.md'), '---\nname: common\n---\n');
  fs.symlinkSync('../shared/common', path.join(src, 'skills/common'));
  fs.symlinkSync(path.join(src, 'nowhere'), path.join(src, 'skills/broken'));
  const p = await store.preview(src);
  assert.deepEqual(p.spec.skills.map((x: { name: string }) => x.name).sort(), ['common', 'test-cards']);
  const { record } = await store.install(src, { marketplace: 'official', trust: p.trust });
  // a real folder in the install, not a link back into the source
  assert.equal(fs.lstatSync(path.join(record.path, 'skills/common')).isSymbolicLink(), false);
  assert.equal(fs.existsSync(path.join(record.path, 'skills/broken')), false);

  const outside = tmp();
  write(path.join(outside, 'secret'), 'x');
  fs.symlinkSync(outside, path.join(src, 'escape'));
  await assert.rejects(store.install(src, { marketplace: 'official', trust: p.trust }), /escape links outside the plugin/);
  assert.deepEqual(
    fs.readdirSync(path.join(dir, 'cache')).filter((n) => n.startsWith('.staging-')),
    [],
  );
});

test('a copied manifest removed during copying is refused like any other trust change', async (t) => {
  const { store } = setup();
  const src = claudePlugin(tmp());
  const p = await store.preview(src);
  assert.ok(p.ok);
  const copy = fs.promises.cp;
  t.mock.method(fs.promises, 'cp', async (source, destination, options) => {
    await copy(source, destination, options);
    fs.unlinkSync(path.join(String(destination), '.claude-plugin/plugin.json'));
  });
  await assert.rejects(store.install(src, { marketplace: 'official', trust: p.trust }), /changed since you reviewed/);
});

test('a link whose target cannot be looked at fails the install with why', async () => {
  const { store } = setup();
  const src = claudePlugin(tmp());
  const shut = tmp();
  fs.mkdirSync(path.join(shut, 'in'));
  fs.symlinkSync(path.join(shut, 'in'), path.join(src, 'link'));
  const p = await store.preview(src);
  fs.chmodSync(shut, 0o000);
  try {
    await assert.rejects(store.install(src, { marketplace: 'official', trust: p.trust }), /EACCES/);
  } finally {
    fs.chmodSync(shut, 0o755);
  }
});

test('an old folder that cannot be removed now does not fail the install', async (t) => {
  const { store } = setup();
  const first = (await installStripe(store)).result.record.path;
  const rm = fs.promises.rm;
  t.mock.method(fs.promises, 'rm', async (p: string, o: object) => {
    if (p === first) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    return rm(p, o);
  });
  assert.equal((await installStripe(store)).result.id, 'stripe@official');
  assert.ok(fs.existsSync(first));
});

test('a list saved by a newer MoPilot is left alone', async () => {
  const { dir, store } = setup();
  fs.mkdirSync(dir, { recursive: true });
  const newer = JSON.stringify({ version: 2, plugins: { 'a@m': { path: '/x', enabled: true, trusted: 't', future: 1 } } });
  fs.writeFileSync(path.join(dir, 'installed.json'), newer);
  const listed = await store.list();
  assert.deepEqual(listed.plugins, []);
  assert.match(listed.error, /newer MoPilot/);
  await assert.rejects(store.setEnabled('a@m', false), /newer MoPilot/);
  assert.equal(fs.readFileSync(path.join(dir, 'installed.json'), 'utf8'), newer);
});

test('reinstall keeps the on/off choices, and old folders go unless a session holds them', async () => {
  const { store } = setup();
  const first = (await installStripe(store)).result.record.path;
  await store.setEnabled('stripe@official', false, 'codex');
  store.hold([first]);
  store.hold([first]);
  const second = (await installStripe(store, claudePlugin(tmp(), { version: 'has space' }))).result.record;
  assert.match(second.path, /stripe\/local-[0-9a-f]{8}$/);
  assert.deepEqual(second.harnesses, { codex: false });
  assert.equal(second.installedAt, 1000);

  assert.ok(fs.existsSync(first), 'held by two sessions');
  await store.release([first]);
  assert.ok(fs.existsSync(first), 'still held by one session');
  await store.release([first]);
  assert.equal(fs.existsSync(first), false, 'released and replaced');
  // releasing the current folder, or one never held, deletes nothing
  store.hold([second.path]);
  await store.release([second.path]);
  await store.release(['/never/held']);
  assert.ok(fs.existsSync(second.path));
  const noVersion = tmp();
  claudePlugin(noVersion);
  write(path.join(noVersion, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'stripe' }));
  assert.match((await installStripe(store, noVersion)).result.record.path, /stripe\/local-/);
});

test('a reinstall that does not say where it came from keeps the recorded origin', async () => {
  const { store } = setup();
  await installStripe(store);
  const src = claudePlugin(tmp());
  const p = await store.preview(src);
  assert.equal((await store.install(src, { marketplace: 'official', trust: p.trust })).record.origin, 'marketplace');
});

test('a folder held again before its cleanup runs is kept', async () => {
  const { store } = setup();
  const first = (await installStripe(store)).result.record.path;
  store.hold([first]);
  await installStripe(store);
  const releasing = store.release([first]);
  store.hold([first]);
  await releasing;
  assert.ok(fs.existsSync(first));
});

test('cleanup that cannot read the list is recorded, not thrown', async () => {
  const { dir, store } = setup();
  const first = (await installStripe(store)).result.record.path;
  store.hold([first]);
  fs.writeFileSync(path.join(dir, 'installed.json'), '{ broken');
  await store.release([first]);
  assert.ok(fs.existsSync(first));
});

test('uninstall removes the record and its folders', async () => {
  const { store, changes } = setup();
  const { record } = (await installStripe(store)).result;
  assert.equal(await store.uninstall('nothing@here'), false);
  assert.equal(await store.uninstall('stripe@official'), true);
  assert.equal(fs.existsSync(record.path), false);
  assert.deepEqual((await store.list()).plugins, []);
  assert.deepEqual(changes.at(-1), ['stripe@official']);
});

test('uninstall when the cache folder is already gone', async () => {
  const { dir, store } = setup();
  await installStripe(store);
  fs.rmSync(path.join(dir, 'cache'), { recursive: true });
  assert.equal(await store.uninstall('stripe@official'), true);
});

test('turning a plugin off everywhere or for one family', async () => {
  const { store } = setup();
  await installStripe(store);
  assert.equal((await store.setEnabled('stripe@official', false)).enabled, false);
  assert.deepEqual((await store.setEnabled('stripe@official', false, 'acp')).harnesses, { acp: false });
  await assert.rejects(store.setEnabled('nope@x', true), /isn't installed/);
  await assert.rejects(store.setEnabled('stripe@official', true, 'cursor'), /Unknown harness family/);
});

test('what each family gets, and why anything is withheld', async () => {
  const { store } = setup();
  const { record } = (await installStripe(store)).result;
  const other = claudePlugin(tmp(), { name: 'other' });
  const p = await store.preview(other);
  const otherRec = (await store.install(other, { marketplace: 'official', trust: p.trust })).record;
  const third = claudePlugin(tmp(), { name: 'third' });
  const q = await store.preview(third);
  await store.install(third, { marketplace: 'official', trust: q.trust });
  await store.setEnabled('third@official', false, 'codex');

  const claude = await store.enabledFor('claude');
  assert.deepEqual(
    claude.deliver.map((d: { id: string }) => d.id),
    ['other@official', 'stripe@official', 'third@official'],
  );
  assert.deepEqual(claude.withheld, []);
  assert.deepEqual(
    (await store.enabledFor('codex')).deliver.map((d: { id: string }) => d.id),
    ['other@official', 'stripe@official'],
  );

  await store.setEnabled('other@official', false);
  // the installed folder now runs something else (a fresh store reads it again from disk)
  write(path.join(record.path, '.mcp.json'), JSON.stringify({ mcpServers: { x: { command: 'sh' } } }));
  fs.rmSync(otherRec.path, { recursive: true });
  const fresh = new PluginStore({ dir: () => store.o.dir() });
  const acp = await fresh.enabledFor('acp');
  assert.deepEqual(
    acp.deliver.map((d: { id: string }) => d.id),
    ['third@official'],
  );
  assert.deepEqual(acp.withheld, [{ id: 'stripe@official', why: 'What this plugin runs changed since you trusted it.' }]);
  await fresh.setEnabled('other@official', true);
  const again = await fresh.enabledFor('acp');
  assert.equal(again.withheld[0].id, 'other@official');
  assert.match(again.withheld[0].why, /isn't a plugin folder/);
});

test('an unreadable installed list is reported and never written over', async () => {
  const { dir, store } = setup();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'installed.json'), '{ broken');
  const listed = await store.list();
  assert.deepEqual(listed.plugins, []);
  assert.match(listed.error, /JSON/);
  await assert.rejects(installStripe(store), /couldn't be read, so it wasn't changed/);
  assert.equal(fs.readFileSync(path.join(dir, 'installed.json'), 'utf8'), '{ broken');
});

test('records that are not plugin ids or usable records are dropped', async () => {
  const { dir, store } = setup();
  fs.mkdirSync(dir, { recursive: true });
  const good = { path: '/nowhere', enabled: true, trusted: 'x' };
  fs.writeFileSync(
    path.join(dir, 'installed.json'),
    JSON.stringify({
      plugins: {
        'ok@m': good,
        'no-at': good,
        'bad@m': { path: 1 },
        'odd@m': { ...good, harnesses: 'x' },
        'fine@m': { ...good, harnesses: {} },
      },
    }),
  );
  assert.deepEqual(
    (await store.list()).plugins.map((p: { id: string }) => p.id),
    ['fine@m', 'ok@m'],
  );
});

test('a store without an onChange listener still writes', async () => {
  const dir = tmp();
  const store = new PluginStore({ dir: () => dir });
  await installStripe(store);
  assert.equal((await store.setEnabled('stripe@official', false)).enabled, false);
});
