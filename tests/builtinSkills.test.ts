// MoPilot's own skills plugin (electron/plugins/builtin.cjs, builtin/mopilot) and the vendor-skill filter for
// Claude sessions (electron/plugins/contract/vendorSkills.cjs): the shipped folder reads as a plugin with the seven skills, it is
// seeded into the store once and kept up to date, a user's removal or own plugin is respected, every harness family
// is handed it, and Claude sessions hide the skills that name Claude Desktop's tools. Folders are temporary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { seedBuiltin, BUILTIN_ID, BUILTIN_SOURCE } = require('../electron/plugins/builtin.cjs');
const { PluginStore, folderDigest } = require('../electron/plugins/store.cjs');
const { PluginDelivery } = require('../electron/plugins/delivery.cjs');
const { readPlugin } = require('../electron/plugins/read.cjs');
const { VENDOR_SKILLS, vendorSkillOverrides, toolNamespaceNote } = require('../electron/plugins/contract/vendorSkills.cjs');
const { buildSessionOptions } = require('../electron/harness/claude/sessionOptions.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-builtin-'));
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
/** A throwaway copy of the shipped plugin, so a test can change it. */
function copyShipped() {
  const dir = path.join(tmp(), 'mopilot');
  fs.cpSync(BUILTIN_SOURCE, dir, { recursive: true });
  return dir;
}
const newStore = () => {
  const dir = tmp();
  return { dir, store: new PluginStore({ dir: () => dir }) };
};

const SKILLS = [
  'built-in-browser',
  'chrome-browser',
  'computer-use',
  'consolidate-memory',
  'explain-usage',
  'frontend-design',
  'pdf-reading',
];

test('the shipped plugin is mopilot@mopilot with the seven skills, each described and named after its folder', async () => {
  assert.equal(BUILTIN_ID, 'mopilot@mopilot');
  const read = await readPlugin(BUILTIN_SOURCE);
  assert.ok(read.ok);
  assert.equal(read.spec.name, 'mopilot');
  assert.deepEqual(read.spec.skills.map((s: any) => s.name).sort(), SKILLS);
  for (const s of read.spec.skills) assert.ok(s.description && s.description.length > 40, `${s.name} has a description`);
  assert.deepEqual(read.spec.problems, []);
  assert.deepEqual([read.spec.hooks, read.spec.commands, read.spec.agents, read.spec.lspServers, read.spec.apps], [[], [], [], {}, []]);
  assert.deepEqual(read.spec.mcpServers, {});
  for (const f of SKILLS) {
    const text = fs.readFileSync(path.join(BUILTIN_SOURCE, 'skills', f, 'SKILL.md'), 'utf8');
    assert.match(text, new RegExp(`^---\\nname: ${f}\\n`), `${f} names itself`);
  }
});

test("the replacement browser and computer skills name MoPilot's tools, never the vendor's as something to call", () => {
  const text = (f: string) => fs.readFileSync(path.join(BUILTIN_SOURCE, 'skills', f, 'SKILL.md'), 'utf8');
  assert.match(text('built-in-browser'), /mcp__mopilot_browser__\*/);
  assert.match(text('computer-use'), /mcp__mopilot_computer__\*/);
  assert.match(text('chrome-browser'), /mcp__mopilot_chrome__\*/);
  // the vendor names appear only to say they don't exist here
  assert.match(text('built-in-browser'), /mcp__Claude_Browser__\*` do not exist/);
  assert.match(text('computer-use'), /mcp__computer-use__\*` do not exist/);
  // consolidate-memory covers every harness's real location
  const memory = text('consolidate-memory');
  assert.match(memory, /Claude Code/);
  assert.match(memory, /\$CODEX_HOME\/memories/);
  assert.match(memory, /ACP/);
  assert.match(text('explain-usage'), /\/status/);
});

test('the digest follows the files and ignores nothing', () => {
  const a = copyShipped();
  const before = folderDigest(a);
  assert.equal(before, folderDigest(BUILTIN_SOURCE));
  write(path.join(a, 'skills/pdf-reading/SKILL.md'), 'changed');
  assert.notEqual(folderDigest(a), before);
});

test("seeding installs once, then is current; a changed copy replaces the install and keeps the user's on/off choice", async () => {
  const { dir, store } = newStore();
  const source = copyShipped();
  assert.equal(await seedBuiltin(store, { source }), 'installed');
  const { plugins } = await store.list();
  assert.deepEqual(
    plugins.map((p: any) => [p.id, p.origin, p.enabled]),
    [[BUILTIN_ID, 'builtin', true]],
  );
  assert.equal(await seedBuiltin(store, { source }), 'current');
  await store.setEnabled(BUILTIN_ID, false, 'acp');
  write(
    path.join(source, 'skills/pdf-reading/SKILL.md'),
    '---\nname: pdf-reading\ndescription: changed text that is long enough to count\n---\nbody',
  );
  assert.equal(await seedBuiltin(store, { source }), 'installed');
  const after = (await store.list()).plugins[0];
  assert.equal(after.harnesses.acp, false);
  assert.equal(after.spec.skills.find((s: any) => s.name === 'pdf-reading').description, 'changed text that is long enough to count');
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'builtin.json'), 'utf8'))[BUILTIN_ID], folderDigest(source));
});

test('a plugin the user removed stays removed, and one they installed under the same id is left alone', async () => {
  const { store } = newStore();
  const source = copyShipped();
  await seedBuiltin(store, { source });
  await store.uninstall(BUILTIN_ID);
  assert.equal(await seedBuiltin(store, { source }), 'removed');
  assert.deepEqual((await store.list()).plugins, []);

  const other = newStore();
  const own = path.join(tmp(), 'mopilot');
  write(path.join(own, '.claude-plugin/plugin.json'), JSON.stringify({ name: 'mopilot' }));
  const preview = await other.store.preview(own);
  await other.store.install(own, { marketplace: 'mopilot', trust: preview.trust, origin: 'marketplace' });
  assert.equal(await seedBuiltin(other.store, { source }), 'foreign');
  assert.equal((await other.store.list()).plugins[0].origin, 'marketplace');
});

test('a store that cannot be read is left untouched, and a broken shipped folder is reported', async () => {
  const { dir, store } = newStore();
  write(path.join(dir, 'installed.json'), '{ not json');
  assert.equal(await seedBuiltin(store, { source: copyShipped() }), 'unreadable');
  assert.equal(fs.existsSync(path.join(dir, 'builtin.json')), false);

  const fresh = newStore();
  const broken = tmp();
  write(path.join(broken, '.claude-plugin/plugin.json'), '{ nope');
  await assert.rejects(seedBuiltin(fresh.store, { source: broken }), /bundled plugin couldn't be read/);
});

test('a state file that is not a record: no install without a record to go by, a rewrite when the plugin is there', async () => {
  const { dir, store } = newStore();
  const source = copyShipped();
  write(path.join(dir, 'builtin.json'), '[1]');
  assert.equal(await seedBuiltin(store, { source }), 'unreadable');
  assert.deepEqual((await store.list()).plugins, []);
  fs.rmSync(path.join(dir, 'builtin.json'));
  assert.equal(await seedBuiltin(store, { source }), 'installed');
  write(path.join(dir, 'builtin.json'), '[1]');
  assert.equal(await seedBuiltin(store, { source }), 'installed');
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'builtin.json'), 'utf8'))), [BUILTIN_ID]);
});

test('every harness family is handed the plugin once the delivery is ready; basic-tier chats read its skills through plugin_skills', async () => {
  const { store } = newStore();
  const source = copyShipped();
  let ready = 0;
  const delivery = new PluginDelivery({
    store,
    home: tmp(),
    claudeNative: () => new Set(),
    ready: async () => {
      ready++;
      await seedBuiltin(store, { source });
    },
  });
  const claude = await delivery.forClaude({ configDir: tmp() });
  assert.equal(claude.plugins.length, 1);
  assert.equal((await delivery.take('codex')).deliver[0].id, BUILTIN_ID);
  assert.equal((await delivery.take('acp')).deliver[0].id, BUILTIN_ID);
  const skills = await delivery.skillsFor('acp');
  assert.deepEqual(
    skills.map((s: any) => s.name).sort(),
    SKILLS.map((f) => `${BUILTIN_ID}:skill:${f}`),
  );
  const read = await delivery.readSkill('acp', `${BUILTIN_ID}:skill:explain-usage`);
  assert.match(read.text, /Explain usage/);
  // Claude and Codex load plugin skills themselves, so plugin_skills lists nothing for them
  assert.deepEqual(await delivery.skillsFor('claude'), []);
  assert.deepEqual(await delivery.skillsFor('codex'), []);
  assert.ok(ready >= 4);
  // a switched-off family waits for nothing
  const off = new PluginDelivery({ store, enabled: () => false, ready: () => Promise.reject(new Error('not asked')) });
  assert.deepEqual(await off.skillsFor('acp'), []);
  assert.deepEqual((await off.take('acp')).deliver, []);
});

test('a delivery with no seeding step behaves as before', async () => {
  const { store } = newStore();
  const delivery = new PluginDelivery({ store, home: tmp() });
  assert.deepEqual((await delivery.take('acp')).deliver, []);
  assert.deepEqual(await delivery.skillsFor('acp'), []);
});

test('vendor skills that name Claude Desktop tools are off in a Claude session, except the Chrome one while Claude in Chrome is on', () => {
  assert.deepEqual(Object.keys(VENDOR_SKILLS).sort(), [
    'anthropic-skills:built-in-browser',
    'anthropic-skills:chrome-browser',
    'anthropic-skills:computer-use',
  ]);
  // each is keyed by its listed name and by its bare name
  assert.deepEqual(Object.keys(vendorSkillOverrides()).sort(), [
    'anthropic-skills:built-in-browser',
    'anthropic-skills:chrome-browser',
    'anthropic-skills:computer-use',
    'built-in-browser',
    'chrome-browser',
    'computer-use',
  ]);
  assert.deepEqual(Object.keys(vendorSkillOverrides({ nativeChrome: true })).sort(), [
    'anthropic-skills:built-in-browser',
    'anthropic-skills:computer-use',
    'built-in-browser',
    'computer-use',
  ]);
  assert.ok(Object.values(vendorSkillOverrides()).every((v) => v === 'off'));
  const off = buildSessionOptions({ cwd: tmp() }, {});
  assert.deepEqual(off.settings, { skillOverrides: vendorSkillOverrides() });
  const fast = buildSessionOptions({ cwd: tmp(), fast: true }, { nativeChrome: true });
  assert.deepEqual(fast.settings, { fastMode: true, skillOverrides: vendorSkillOverrides({ nativeChrome: true }) });
});

test('the system prompt names the namespaces this app serves, and hands Chrome to claude-in-chrome only when it is on', () => {
  const plain = toolNamespaceNote();
  assert.match(plain, /mcp__mopilot_browser__\*/);
  assert.match(plain, /mcp__mopilot_computer__\*/);
  assert.match(plain, /user's Chrome is mcp__mopilot_chrome__\*/);
  assert.match(plain, /mcp__Claude_Browser__\*, mcp__computer-use__\* and mcp__claude-in-chrome__\* do not exist here/);
  assert.match(plain, /\(and mopilot:chrome-browser\)/);
  const chrome = toolNamespaceNote({ nativeChrome: true });
  assert.match(chrome, /user's Chrome is mcp__claude-in-chrome__\* \(Claude in Chrome is on\)/);
  assert.match(chrome, /mcp__Claude_Browser__\* and mcp__computer-use__\* do not exist here/);
  assert.doesNotMatch(chrome, /mopilot_chrome|mopilot:chrome-browser/);
  assert.equal(buildSessionOptions({ cwd: tmp() }, {}).systemPrompt.append, plain);
});

test('seeding refuses a shipped folder under another name, and leaves a removal alone when builtin.json cannot be read', async () => {
  const { dir, store } = newStore();
  await assert.rejects(store.seedBundled(BUILTIN_SOURCE, { name: 'other', marketplace: 'mopilot' }), /is named mopilot, not other/);
  // nothing was left behind by the refused staging
  assert.deepEqual(fs.readdirSync(path.join(dir, 'cache')), []);
  write(path.join(dir, 'builtin.json'), '{ not json');
  assert.equal(await seedBuiltin(store, { source: copyShipped() }), 'unreadable');
  assert.deepEqual((await store.list()).plugins, []);
});

test('a change from the Plugins page that is already queued is not overwritten by the seed', async () => {
  const { store } = newStore();
  const source = copyShipped();
  await seedBuiltin(store, { source });
  const user = store.uninstall(BUILTIN_ID);
  // queued behind the uninstall: it sees the plugin gone and honors it, instead of deciding on a stale read
  const seeding = seedBuiltin(store, { source: copyShipped() });
  await user;
  assert.equal(await seeding, 'removed');
  assert.deepEqual((await store.list()).plugins, []);
});
