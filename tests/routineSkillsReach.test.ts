// A saved routine reaches the next chat (#3571, G4): the real plugin store accepts the generated "routines" plugin, lists
// each routine as a skill any harness's delivery serves, follows a change, and a seed the store refuses is told, not
// lost. The seed was a stand-in in the first tests, so a folder the store always refused passed them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { writePlugin, PLUGIN } = require('../electron/capabilities/routines/routineSkills.cjs');
const { PluginStore } = require('../electron/plugins/store.cjs');

const R = {
  id: 'a1b2c3d4-e5f6',
  name: 'Refund run',
  description: 'Issues the refunds that qualify.',
  params: [{ name: 'order', example: 'SO-1' }],
  steps: [],
};

test('the real plugin store installs the routines plugin, each routine one skill, and follows a change', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-reach-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new PluginStore({ dir: () => path.join(dir, 'store') });
  fs.mkdirSync(path.join(dir, 'store'), { recursive: true });
  const seed = () => store.seedBundled(writePlugin(path.join(dir, 'gen'), [R]), { name: PLUGIN, marketplace: 'mopilot' });
  assert.equal(await seed(), 'installed');
  const [p] = (await store.list()).plugins;
  assert.equal(p.id, 'routines@mopilot');
  assert.equal(p.enabled, true);
  assert.deepEqual(
    p.spec.skills.map((s: any) => s.name),
    ['routine-refund-run-a1b2c3'],
  );
  assert.match(p.spec.skills[0].description, /Issues the refunds that qualify/);
  assert.equal(await seed(), 'current');
  // a routine deleted, none left: the plugin stays installed with no skill
  assert.equal(await store.seedBundled(writePlugin(path.join(dir, 'gen'), []), { name: PLUGIN, marketplace: 'mopilot' }), 'installed');
  assert.deepEqual((await store.list()).plugins[0].spec.skills, []);
});

test('what a seed leaves is told: a refused or failed seed is the problem, the next good one clears it, each change said once', async (t) => {
  const { syncRoutineSkills } = require('../electron/capabilities/routines/routineSkills.cjs');
  const { RoutineStore } = require('../electron/capabilities/routines/routineStore.cjs');
  const { memorySealed } = await import('./support/routine-kit.ts');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-problem-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let answer: () => any = () => 'installed';
  let told = 0;
  const s = syncRoutineSkills({
    dir,
    store: new RoutineStore({ sealed: memorySealed() }),
    seed: async () => answer(),
    onProblem: () => told++,
  });
  await s.sync();
  assert.equal(s.problem(), null);
  answer = () => 'removed';
  await s.sync();
  assert.equal(s.problem(), 'The Routines plugin was removed.');
  await s.sync();
  assert.equal(told, 1, 'the same problem is said once');
  answer = () => 'foreign';
  await s.sync();
  assert.equal(s.problem(), 'Another plugin is named routines.');
  answer = () => 'unreadable';
  await s.sync();
  assert.match(s.problem(), /can't be read/);
  answer = () => {
    throw new Error("The bundled plugin couldn't be read: no manifest");
  };
  await s.sync();
  assert.match(s.problem(), /The bundled plugin couldn't be read/);
  answer = () => 'current';
  await s.sync();
  assert.equal(s.problem(), null);
  // with nobody listening it is still kept
  const quiet = syncRoutineSkills({ dir, store: new RoutineStore({ sealed: memorySealed() }), seed: async () => 'removed' });
  await quiet.sync();
  assert.ok(quiet.problem());
});

test('a name or task with double quotes reads plainly in the skill list', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-quotes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new PluginStore({ dir: () => path.join(dir, 'store') });
  fs.mkdirSync(path.join(dir, 'store'));
  await store.seedBundled(writePlugin(path.join(dir, 'gen'), [{ ...R, name: 'The "big" one', description: 'Says "hi"' }]), {
    name: PLUGIN,
    marketplace: 'mopilot',
  });
  const [skill] = (await store.list()).plugins[0].spec.skills;
  assert.match(skill.description, /^Saved routine 'The 'big' one': Says 'hi'\. The routine_run/);
  assert.ok(!skill.description.includes('\\'));
  await store.seedBundled(writePlugin(path.join(dir, 'gen'), [{ ...R, name: 'Line\nbreak\\x', description: '' }]), {
    name: PLUGIN,
    marketplace: 'mopilot',
  });
  assert.match(
    (await store.list()).plugins[0].spec.skills[0].description,
    /^Saved routine 'Line break\/x': Line break\/x\. The routine_run/,
  );
});
