// The Codex mirror gives a plugin's agents to Codex as skills: a derived copy of the install folder with a skill per
// agent (Codex loads no agents), installed from there, kept apart from the store's folders, pruned with the plugin
// and when plugins.codex is off. Data is made up.
import { test, assert, fs, path, write, tmp, setup, install } from './support/codex-plugin-mirror-fixture.ts';

function crew(files: Record<string, string>, name = 'crew') {
  const root = path.join(tmp(), name);
  write(path.join(root, '.claude-plugin/plugin.json'), JSON.stringify({ name, version: '1.0.0' }));
  for (const [file, text] of Object.entries(files)) write(path.join(root, file), text);
  return root;
}
const derived = (t: any) => path.join(t.dir, 'cache/acme/.codex-agents');

test('Codex installs a plugin with agents from a copy that has each agent as a skill, and the store folder is untouched', async () => {
  const t = setup();
  const record = await install(
    t.store,
    crew({
      'agents/reviewer.md': '---\ndescription: Reviews\n---\nCheck.\n',
      'agents/deep/probe.md': 'Probe.\n',
      'skills/own/SKILL.md': '---\nname: own\n---\n',
    }),
  );
  await t.mirror.sync();
  const copy = path.join(derived(t), 'crew', path.basename(record.path));
  assert.match(fs.readFileSync(path.join(copy, 'skills/agent-reviewer/SKILL.md'), 'utf8'), /Agent: Reviews/);
  assert.ok(fs.existsSync(path.join(copy, 'skills/agent-deep-probe/SKILL.md')));
  assert.ok(fs.existsSync(path.join(copy, 'skills/own/SKILL.md')), 'the plugin is copied whole');
  assert.equal(fs.existsSync(path.join(record.path, 'skills/agent-reviewer')), false, 'the store’s install folder never changes');
  const manifest = JSON.parse(fs.readFileSync(path.join(t.dir, 'cache/acme/.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(manifest.plugins[0].source.path, `./${path.relative(path.join(t.dir, 'cache/acme'), copy)}`);
  assert.equal(t.mirror.states['crew@acme'].path, record.path, 'the state still records the store folder');
  // a second sync reuses the copy and installs nothing
  t.codex.calls.length = 0;
  await t.mirror.sync();
  assert.deepEqual(t.methods(), ['plugin/list']);
});

test('a skill or command with the agent skill’s name wins; the agent gets no skill', async () => {
  const t = setup();
  const record = await install(
    t.store,
    crew({
      'agents/a.md': 'A.\n',
      'agents/b.md': 'B.\n',
      'commands/agent-a.md': 'cmd\n',
      'skills/agent-b/SKILL.md': '---\nname: other\n---\nown b\n',
    }),
  );
  await t.mirror.sync();
  const copy = path.join(derived(t), 'crew', path.basename(record.path));
  assert.equal(fs.existsSync(path.join(copy, 'skills/agent-a')), false);
  assert.equal(
    fs.readFileSync(path.join(copy, 'skills/agent-b/SKILL.md'), 'utf8').includes('own b'),
    true,
    'a folder already there is kept',
  );
});

test('an upgrade makes a new copy and removes the old; removal and plugins.codex off leave no copy behind', async () => {
  let on = true;
  const t = setup({ enabled: () => on });
  await install(t.store, crew({ 'agents/a.md': 'A.\n' }));
  await t.mirror.sync();
  const first = fs.readdirSync(path.join(derived(t), 'crew'));
  await install(t.store, crew({ 'agents/a.md': 'A2.\n' }));
  await t.mirror.sync();
  const second = fs.readdirSync(path.join(derived(t), 'crew'));
  assert.equal(second.length, 1);
  assert.notDeepEqual(second, first);
  // a stale staging folder from an interrupted copy is swept too
  fs.mkdirSync(path.join(derived(t), 'crew', 'x.tmp'));
  await t.mirror.sync();
  assert.deepEqual(fs.readdirSync(path.join(derived(t), 'crew')), second);

  on = false;
  await t.mirror.sync();
  assert.equal(fs.existsSync(derived(t)), false, 'plugins.codex off: the next sync takes the copy away');

  on = true;
  await t.mirror.sync();
  assert.equal(fs.existsSync(derived(t)), true);
  await t.store.uninstall('crew@acme');
  await t.mirror.sync();
  assert.equal(fs.existsSync(derived(t)), false, 'uninstalled: no orphan');
});

test('a marketplace Codex never accepted still loses its copies once the plugin goes', async () => {
  const t = setup();
  await install(t.store, crew({ 'agents/a.md': 'A.\n' }));
  t.codex.fail['marketplace/add'] = 'refused';
  await t.mirror.sync();
  assert.equal(fs.existsSync(derived(t)), true);
  await t.store.uninstall('crew@acme');
  await t.mirror.sync();
  assert.equal(fs.existsSync(derived(t)), false);
});

test('plugins without agents are installed from their own folder', async () => {
  const t = setup();
  const record = await install(t.store, crew({ 'skills/s/SKILL.md': '---\nname: s\n---\n' }));
  await t.mirror.sync();
  const manifest = JSON.parse(fs.readFileSync(path.join(t.dir, 'cache/acme/.agents/plugins/marketplace.json'), 'utf8'));
  assert.equal(manifest.plugins[0].source.path, `./${path.relative(path.join(t.dir, 'cache/acme'), record.path)}`);
  assert.equal(fs.existsSync(derived(t)), false);
});
