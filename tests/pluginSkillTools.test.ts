// Plugin skills for harnesses that don't load plugins themselves: what the delivery offers each family and reads
// (electron/plugins/delivery.cjs skillsFor, readSkill, markNative, reportFailures), the plugin_skills and plugin_skill_read tools
// (electron/capabilities/tools/pluginSkills.cjs), and a plugin skill chip in an ACP prompt. Data is made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { PluginDelivery, READ_LIMIT } = require('../electron/plugins/delivery.cjs');
const { PluginStore } = require('../electron/plugins/store.cjs');
const { registerPluginSkillTools } = require('../electron/capabilities/tools/pluginSkills.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { acpBlocks } = require('../electron/harness/acpTurns.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mopilot-plugin-skills-'));
const write = (file: string, text: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};

async function setup(o: { enabled?: (f: string) => boolean } = {}) {
  const src = path.join(tmp(), 'tidy');
  write(path.join(src, '.claude-plugin/plugin.json'), '{"name":"tidy"}');
  write(path.join(src, 'skills/notes/SKILL.md'), '---\nname: notes\ndescription: Tidy notes\n---\nUse references/style.md');
  write(path.join(src, 'skills/notes/references/style.md'), 'Short lines.');
  write(path.join(src, 'skills/notes/big.md'), 'x'.repeat(READ_LIMIT + 1));
  write(path.join(src, 'commands/go.md'), '---\ndescription: Go\n---\nGo $ARGUMENTS');
  const dir = tmp();
  const store = new PluginStore({ dir: () => dir });
  const p = await store.preview(src);
  const { record } = await store.install(src, { marketplace: 'acme', trust: p.trust });
  return { store, record, delivery: new PluginDelivery({ store, enabled: o.enabled }) };
}

test('the basic tier gets plugin skills and commands from MoPilot; harnesses that load plugins get none here', async () => {
  const { delivery, record } = await setup();
  assert.deepEqual(await delivery.skillsFor('acp'), [
    { name: 'tidy@acme:skill:notes', kind: 'skill', description: 'Tidy notes', file: path.join(record.path, 'skills/notes/SKILL.md') },
    { name: 'tidy@acme:command:go', kind: 'command', description: 'Go', file: path.join(record.path, 'commands/go.md') },
  ]);
  assert.deepEqual(await delivery.skillsFor('claude'), []);
  assert.deepEqual(await delivery.skillsFor('codex'), []);
  const off = new PluginDelivery({ store: delivery.store, enabled: () => false });
  assert.deepEqual(await off.skillsFor('acp'), []);
});

test("reading a skill, a file it keeps, or a command; nothing outside the skill's folder or too large", async () => {
  const { delivery } = await setup();
  assert.match((await delivery.readSkill('acp', 'tidy@acme:skill:notes')).text, /Use references\/style\.md/);
  assert.equal((await delivery.readSkill('acp', 'tidy@acme:skill:notes', 'references/style.md')).text, 'Short lines.');
  assert.match((await delivery.readSkill('acp', 'tidy@acme:command:go')).text, /\$ARGUMENTS/);
  await assert.rejects(
    delivery.readSkill('acp', 'tidy@acme:skill:notes', '../../commands/go.md'),
    /isn't inside the tidy@acme:skill:notes skill/,
  );
  await assert.rejects(delivery.readSkill('acp', 'tidy@acme:command:go', 'x.md'), /Only a skill keeps files/);
  await assert.rejects(delivery.readSkill('acp', 'tidy@acme:skill:notes', 'big.md'), /too large to read here/);
  await assert.rejects(delivery.readSkill('acp', 'tidy@acme:skill:none'), /No plugin skill or command named "tidy@acme:skill:none"/);
  await assert.rejects(delivery.readSkill('claude', 'tidy@acme:skill:notes'), /No plugin skill/);
});

test('a harness that would load plugins but can’t here, or failed to get one, is served them like the basic tier', async () => {
  const { delivery } = await setup();
  delivery.markNative('claude', false);
  assert.deepEqual(
    (await delivery.skillsFor('claude')).map((x: { name: string }) => x.name),
    ['tidy@acme:skill:notes', 'tidy@acme:command:go'],
  );
  delivery.markNative('claude', true);
  assert.deepEqual(await delivery.skillsFor('claude'), []);
  let failed = new Set(['tidy@acme']);
  delivery.reportFailures('codex', () => failed);
  assert.equal((await delivery.skillsFor('codex')).length, 2);
  failed = new Set();
  assert.deepEqual(await delivery.skillsFor('codex'), []);
});

function tools(delivery: unknown, o: { owner?: (ctx: any) => string | null; harness?: string | null } = {}) {
  const registry = new Registry();
  registerPluginSkillTools(registry, {
    delivery,
    owner: o.owner ?? ((ctx: any) => ctx.chatId),
    harnessOf: () => ('harness' in o ? o.harness : 'acp:opencode'),
  });
  return registry;
}
const call = async (registry: any, name: string, args: object) => registry.invoke('chat-1', 'seg', name, args);

test('plugin_skills lists them for the calling chat’s harness, and says when there is nothing', async () => {
  const { delivery } = await setup();
  const listed = await call(tools(delivery), 'plugin_skills', {});
  assert.equal(listed.ok, true);
  assert.equal(listed.content[0].text, '- tidy@acme:skill:notes (skill): Tidy notes\n- tidy@acme:command:go (command): Go');
  const native = await call(tools(delivery, { harness: 'claude' }), 'plugin_skills', {});
  assert.equal(native.content[0].text, 'No plugin skills or commands to load here.');
  const bare = await call(tools({ skillsFor: async () => [{ name: 'p:s', kind: 'skill', file: '/f' }] }), 'plugin_skills', {});
  assert.equal(bare.content[0].text, '- p:s (skill)');
});

test('plugin_skill_read returns the text, or why not', async () => {
  const { delivery } = await setup();
  const r = tools(delivery);
  assert.equal(
    (await call(r, 'plugin_skill_read', { name: 'tidy@acme:skill:notes', file: 'references/style.md' })).content[0].text,
    'Short lines.',
  );
  assert.match((await call(r, 'plugin_skill_read', { name: 'tidy@acme:command:go' })).content[0].text, /Go \$ARGUMENTS/);
  const missing = await call(r, 'plugin_skill_read', { name: 'tidy@acme:skill:none' });
  assert.deepEqual([missing.ok, missing.error.code], [false, 'unreadable']);
  const odd = await call(tools({ readSkill: async () => Promise.reject('plain') }), 'plugin_skill_read', { name: 'x' });
  assert.equal(odd.error.message, 'plain');
});

test('a call from no chat, or from a chat whose harness is unknown, is refused', async () => {
  const { delivery } = await setup();
  const noOwner = await call(tools(delivery, { owner: () => null }), 'plugin_skills', {});
  assert.equal(noOwner.error.code, 'no_owner');
  const noHarness = await call(tools(delivery, { harness: null }), 'plugin_skill_read', { name: 'tidy@acme:skill:notes' });
  assert.equal(noHarness.error.code, 'no_harness');
});

test('in an ACP prompt a plugin skill chip, or a typed /<plugin>:<name>, asks the model to read it; the harness’s own stays a /command', async () => {
  let asked = 0;
  const list = async () => (
    asked++,
    [
      { name: 'tidy@acme:skill:notes', kind: 'skill', file: '/store/notes/SKILL.md' },
      { name: 'tidy@acme:command:go', kind: 'command', file: '/store/go.md' },
    ]
  );
  const blocks = await acpBlocks(
    'tidy up',
    [
      { kind: 'skill', name: 'tidy@acme:skill:notes', path: '/store/notes/SKILL.md' },
      { kind: 'skill', name: 'web', path: '/harness/web' },
    ],
    async () => null,
    list,
  );
  assert.equal(
    blocks[0].text,
    "(Use the tidy@acme:skill:notes skill from MoPilot's plugins: read it with plugin_skill_read and follow it.) /web tidy up",
  );
  const typed = await acpBlocks('/tidy@acme:command:go the docs', [], async () => null, list);
  assert.equal(
    typed[0].text,
    "(Use the tidy@acme:command:go command from MoPilot's plugins: read it with plugin_skill_read and follow it.) the docs",
  );
  // a /<plugin>:<name> that isn't one, or the harness's own /command, is sent as typed
  assert.equal((await acpBlocks('/other:thing now', [], async () => null, list))[0].text, '/other:thing now');
  assert.equal(asked, 3);
  assert.equal((await acpBlocks('/web now', [], async () => null, list))[0].text, '/web now');
  assert.equal(asked, 3, 'nothing to look up: the list is not read');
  assert.equal((await acpBlocks('hi', [{ kind: 'skill', name: 'web', path: '/w' }], async () => null))[0].text, '/web hi');
});

test('marketplace and component kind remain distinct through listing and reading', async () => {
  const { store, delivery } = await setup();
  const source = path.join(tmp(), 'tidy');
  write(path.join(source, '.claude-plugin/plugin.json'), '{"name":"tidy"}');
  write(path.join(source, 'skills/go/SKILL.md'), 'Other market skill');
  write(path.join(source, 'commands/go.md'), 'Other market command');
  const preview = await store.preview(source);
  await store.install(source, { marketplace: 'other', trust: preview.trust });
  const skills = await delivery.skillsFor('acp');
  assert.equal(new Set(skills.map((entry: any) => entry.name)).size, 4);
  for (const [name, text] of [
    ['tidy@other:skill:go', 'Other market skill'],
    ['tidy@other:command:go', 'Other market command'],
  ])
    assert.equal((await delivery.readSkill('acp', name)).text, text);
  assert.match((await delivery.readSkill('acp', 'tidy@acme:command:go')).text, /Go/);
});

test('native capability belongs to its calling chat and cleanup cannot retire a replacement', async () => {
  const { delivery } = await setup();
  const old = delivery.markNative('claude', false, 'old');
  const modern = delivery.markNative('claude', true, 'modern');
  assert.equal((await delivery.skillsFor('claude', 'old')).length, 2);
  assert.equal((await delivery.skillsFor('claude', 'modern')).length, 0);
  const registry = tools(delivery, { harness: 'claude' });
  const read = await registry.invoke('old', 'seg', 'plugin_skill_read', { name: 'tidy@acme:skill:notes' });
  assert.equal(read.ok, true);
  assert.match(read.content[0].text, /Use references/);
  const replacement = delivery.markNative('claude', false, 'old');
  old();
  modern();
  assert.equal((await delivery.skillsFor('claude', 'old')).length, 2);
  replacement();
  assert.equal((await delivery.skillsFor('claude', 'old')).length, 0);
});

test('a failed native delivery keeps fallback tools for that chat while a modern peer stays native', async () => {
  const { delivery } = await setup();
  const { prepareSessionTools } = require('../electron/harness/claude/sessionTools.cjs');
  const original = delivery.forClaude.bind(delivery);
  let failed = true;
  delivery.forClaude = async () => {
    if (failed) throw new Error('temporary delivery failure');
    return original();
  };
  const state = { plugins: delivery };
  const bad: any = {};
  await prepareSessionTools(state, { takesPluginDirs: () => true }, '/cli', {}, bad, { chatId: 'bad' }, 'bad', () => 'bad');
  assert.equal(bad.pluginDirs, false);
  failed = false;
  const good: any = {};
  await prepareSessionTools(state, { takesPluginDirs: () => true }, '/cli', {}, good, { chatId: 'good' }, 'good', () => 'good');
  assert.equal(good.pluginDirs, true);
  const registry = tools(delivery, { harness: 'claude' });
  assert.match((await registry.invoke('bad', 'seg', 'plugin_skills', {})).content[0].text, /tidy@acme:skill:notes/);
  assert.equal((await registry.invoke('good', 'seg', 'plugin_skills', {})).content[0].text, 'No plugin skills or commands to load here.');
  await good.releasePlugins();
  assert.equal((await delivery.skillsFor('claude', 'bad')).length, 2);
  await bad.releasePlugins();
  assert.equal((await delivery.skillsFor('claude', 'bad')).length, 0);
});

test('a late native delivery failure cannot downgrade a replacement session in the same chat', async () => {
  const { delivery } = await setup();
  const { prepareSessionTools } = require('../electron/harness/claude/sessionTools.cjs');
  const original = delivery.forClaude.bind(delivery);
  let rejectOld!: (error: Error) => void;
  let started!: () => void;
  const waiting = new Promise<void>((resolve) => {
    started = resolve;
  });
  let calls = 0;
  delivery.forClaude = () =>
    ++calls === 1
      ? new Promise((_resolve, reject) => {
          rejectOld = reject;
          started();
        })
      : original();
  const state = { plugins: delivery };
  const old: any = {};
  const current: any = {};
  const prepare = (session: any) =>
    prepareSessionTools(state, { takesPluginDirs: () => true }, '/cli', {}, session, { chatId: 'same' }, 'same', () => 'same');
  const pending = prepare(old);
  await waiting;
  await prepare(current);
  rejectOld(new Error('late delivery failure'));
  await pending;
  assert.deepEqual(await delivery.skillsFor('claude', 'same'), []);
  await old.releasePlugins();
  assert.deepEqual(await delivery.skillsFor('claude', 'same'), []);
  await current.releasePlugins();
});
