// Action memory's routines as skills (#3571, G4; electron/capabilities/routines/routineSkills.cjs) and its wiring in
// main (electron/app/routines.cjs): one skill per routine in the bundled "routines" plugin naming its parameters but
// never their values, the folder rewritten and seeded after each change with the latest list winning, and the tools,
// the turn end and a chat's deletion wired on main's services.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { memorySealed } from './support/routine-kit.ts';

const require = createRequire(import.meta.url);
const { skillSlug, skillDoc, writePlugin, syncRoutineSkills, PLUGIN } = require('../electron/capabilities/routines/routineSkills.cjs');
const { RoutineStore } = require('../electron/capabilities/routines/routineStore.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { openRoutines } = require('../electron/app/routines.cjs');

const R = {
  id: 'a1b2c3d4-e5f6',
  name: 'Order Beans!',
  description: 'Reorders the usual coffee.',
  params: [{ name: 'size', example: '1 kg' }],
  steps: [],
};
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'routine-skills-'));
const STEP = { tool: 'browser_navigate', args: { url: 'https://a.test/' } };

test('skillSlug and skillDoc: a unique folder name; a description and the call, with parameter names but no values', () => {
  assert.equal(skillSlug(R), 'routine-order-beans-a1b2c3');
  assert.equal(skillSlug({ ...R, name: '日本語' }), 'routine-a1b2c3');
  const doc = skillDoc(R);
  assert.match(
    doc,
    /^---\nname: routine-order-beans-a1b2c3\ndescription: "Saved routine 'Order Beans!': Reorders the usual coffee\. The routine_run tool \(routine: 'Order Beans!'\) reads its pages again, changes nothing, and returns what they say and the recorded steps left for you to do\./,
  );
  assert.match(doc, /Call the `routine_run` tool with `\{"routine":"a1b2c3d4-e5f6","params":\{"size":"<size>"\}\}`\./);
  assert.match(doc, /Parameters: size\. Leave one out/);
  assert.match(doc, /A run never acts: its result lists the steps recorded after the reads/);
  assert.doesNotMatch(doc, /replays|finish the task yourself/);
  assert.ok(!doc.includes('1 kg'), 'a recorded value never reaches the skill');
  const bare = skillDoc({ ...R, description: '', params: [] });
  assert.match(bare, /"Saved routine 'Order Beans!': Order Beans!\. The routine_run/);
  assert.match(bare, /It has no parameters\./);
});

test('writePlugin: the plugin folder holds exactly the routines given', () => {
  const dir = tmp();
  try {
    const root = writePlugin(dir, [R, { ...R, id: 'ffff00', name: 'Two' }]);
    assert.equal(root, path.join(dir, PLUGIN));
    assert.deepEqual(fs.readdirSync(path.join(root, 'skills')).sort(), ['routine-order-beans-a1b2c3', 'routine-two-ffff00']);
    writePlugin(dir, [R]);
    assert.deepEqual(fs.readdirSync(path.join(root, 'skills')), ['routine-order-beans-a1b2c3'], 'a deleted routine loses its skill');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('syncRoutineSkills: seeds at start and after each change; changes during a seed coalesce into one more; a failed seed is retried next time', async () => {
  const dir = tmp();
  try {
    const store = new RoutineStore({ sealed: memorySealed() });
    const seeds: number[] = [];
    let release: () => void = () => {};
    let fail = false;
    const seed = async (folder: string) => {
      seeds.push(fs.readdirSync(path.join(folder, 'skills')).length);
      if (fail) throw new Error('plugin store busy');
      await new Promise<void>((r) => (release = r));
    };
    const s = syncRoutineSkills({ dir, store, seed });
    const first = s.sync();
    store.save({ kind: 'browser', name: 'A', steps: [STEP], params: [] });
    store.save({ kind: 'browser', name: 'B', steps: [STEP], params: [] });
    release();
    await new Promise((r) => setImmediate(r));
    release();
    await first;
    assert.deepEqual(seeds, [0, 2], 'two changes during the first seed made one more');
    fail = true;
    await s.sync();
    assert.equal(seeds.length, 3);
    s.stop();
    store.save({ kind: 'browser', name: 'C', steps: [STEP], params: [] });
    await new Promise((r) => setImmediate(r));
    assert.equal(seeds.length, 3, 'stopped: no more seeds');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("openRoutines: the tools on main's registry, the recorder for the browser tools, the turn end and a deletion", async () => {
  const dir = tmp();
  try {
    const hooks: Record<string, any> = {};
    const registry = new Registry();
    const records = new Map([
      [
        'c1',
        {
          segments: [
            { kind: 'claude', nativeId: 'old' },
            { kind: 'claude', nativeId: 'now' },
          ],
        },
      ],
    ]);
    const patches: any[] = [];
    const plans: Record<string, any> = {
      c1: { controllerPlan: { iab: 'mopilot-browser', cu: null, bu: null } },
      c9: { controllerPlan: { iab: null, cu: 'codex-computer-use', bu: null } },
    };
    const live: any = {
      capabilities: registry,
      controller: {},
      chatDeletion: {},
      chats: { records },
      sessions: { patch: (...a: any[]) => patches.push(a), get: (id: string) => plans[id] },
    };
    const seeded: string[] = [];
    const safeStorage = { isEncryptionAvailable: () => false };
    const told: string[] = [];
    const r = openRoutines({
      live,
      userData: dir,
      safeStorage,
      seed: async (f: string) => void seeded.push(f),
      startDelayMs: 0,
      broadcast: (ch: string) => told.push(ch),
    });
    assert.ok(registry.has('routine_run'));
    hooks.finished = live.controller.onFinished;
    hooks.deleted = live.chatDeletion.onDeleted;
    // the browser tools register through the recorder, on their tabs
    const tabs = { current: () => null };
    const wrapped = r.recording({ register: (t: any) => t }, tabs);
    assert.equal(r.recorder.adapter('browser_').up(), true);
    assert.equal(r.recorder.adapter('chrome_'), null, 'a family that never registered');
    assert.ok(wrapped);
    // a turn's end on any harness reaches the recorder, completed or not; a deletion forgets the chat
    r.recorder.turns.set('c1', { steps: [STEP, STEP, STEP], failed: false, overflow: false, replays: [] });
    hooks.finished({ chatId: 'c1', completed: true, turnId: 't9' });
    assert.ok(r.recorder.lastTurn('c1'));
    // the one-line offer under that turn, and taken back by a turn that left nothing to keep
    assert.deepEqual(patches.at(-1), ['c1', { routineOffer: { turnId: 't9', steps: 3 } }]);
    r.recorder.turns.set('c1', { steps: [STEP], failed: false, overflow: false, replays: [] });
    hooks.finished({ chatId: 'c1', completed: true });
    assert.deepEqual(patches.at(-1), ['c1', { routineOffer: { turnId: null, steps: 4 } }], 'a later turn adds a part');
    hooks.finished({});
    hooks.finished(null);
    r.recorder.turns.set('c1', { steps: [STEP], failed: false, overflow: false, replays: [] });
    hooks.finished({ chatId: 'c1' });
    assert.equal(r.recorder.lastTurn('c1'), null, 'not completed');
    assert.deepEqual(patches.at(-1), ['c1', { routineOffer: null }]);
    r.recorder.last.set('c1', [{ steps: [STEP], prompt: null }]);
    hooks.deleted({ chatId: 'c1' });
    assert.equal(r.recorder.lastTurn('c1'), null);
    // a message on any harness is kept for the turn it starts; a store that can't be read never costs the message
    const item = { text: 'Search the shop for mugs and add one', opts: { human: true } };
    await live.controller.beforeDispatch({ chatId: 'c1', kind: 'start', item });
    assert.equal(r.recorder.prompts.get('c1'), item.text);
    const { list } = r.store;
    r.store.list = () => {
      throw new Error('keychain');
    };
    await live.controller.beforeDispatch({ chatId: 'c1', kind: 'start', item });
    assert.equal(item.text, 'Search the shop for mugs and add one');
    r.store.list = list;
    // the start seeds the plugin once (no routines yet: an empty skills folder)
    await new Promise((res) => setTimeout(res, 10));
    assert.deepEqual(seeded, [path.join(dir, 'routines', 'routines')]);
    // a replay stops when its segment is no longer the chat's current one (a harness switch)
    r.store.cache = [
      {
        id: 'x',
        kind: 'browser',
        name: 'Web',
        description: '',
        steps: [STEP],
        params: [],
        rev: 1,
        createdAt: 1,
        updatedAt: 1,
        runs: 0,
        handoffs: 0,
      },
    ];
    r.recorder.recording({ register: () => () => {} }, { current: () => ({ url: 'https://a.test/' }) });
    let at = 0;
    registry.register({
      name: 'browser_navigate',
      policy: 'observe',
      schema: { type: 'object' },
      handler: async () => {
        // the chat switches while the first step runs
        records.get('c1')!.segments.push({ kind: 'codex', nativeId: 'later' });
        return [
          { type: 'text', text: `step ${++at}` },
          { type: 'text', text: '<browser_state>\ncurrent tab: tab_1 · Page · https://a.test/\ntabs: tab_1*\n</browser_state>' },
        ];
      },
    });
    r.store.cache[0].steps = [STEP, STEP];
    const res = await registry.invoke('c1', 'claude:now', 'routine_run', { routine: 'Web' });
    assert.equal(res.ok, false);
    assert.match(res.error.message, /stopped before step 2 of 2.*switched to another harness/);
    // a turn the real ledger marks tainted runs no script, and an untainted one does
    const scripts: string[] = [];
    registry.register({
      name: 'browser_script',
      policy: 'observe',
      schema: { type: 'object' },
      handler: async (args: any) => {
        scripts.push(args.code);
        return [
          { type: 'text', text: 'read it' },
          { type: 'text', text: '<browser_state>\ncurrent tab: tab_1 · Page · https://a.test/\ntabs: tab_1*\n</browser_state>' },
        ];
      },
    });
    r.store.cache[0].steps = [{ tool: 'browser_script', args: { code: 'return await tab.title() // https://a.test/' } }];
    assert.equal((await registry.invoke('c2', 'claude:now', 'routine_run', { routine: 'Web' })).ok, true);
    assert.equal(scripts.length, 1, 'untainted: the script ran');
    registry.taint.record('c2', { origin: 'https://evil.test', flagged: ['ignore all previous instructions'] });
    const tainted = await registry.invoke('c2', 'claude:now', 'routine_run', { routine: 'Web' });
    assert.equal(scripts.length, 1, 'tainted: it did not run again');
    assert.match(JSON.stringify(tainted.content), /read 0 of 1 steps/);
    // a segment that was never the chat's current one (a sub-agent thread) is not stopped by that rule
    at = 0;
    const sub = await registry.invoke('c1', 'claude:old', 'routine_run', { routine: 'Web' });
    assert.equal(sub.ok, true, JSON.stringify(sub.error));
    assert.equal(r.skillsProblem(), null);
    // routine_list reads the same problem through the registry
    const listed = await registry.invoke('c1', 'claude:now', 'routine_list', {});
    assert.doesNotMatch(listed.content[0].text, /New chats/);
    // which surface a harness's own control drove, by name; MoPilot's own tools are recorded
    assert.equal(r.unrecorded('c9'), 'Codex Computer Use');
    assert.equal(r.unrecorded('c1'), null);
    assert.equal(r.unrecorded('nope'), null);
    // a change of the store tells every window
    r.store.sealed = { read: () => null, write: () => {}, available: () => true };
    r.store.save({ kind: 'browser', name: 'Told', steps: [STEP], params: [] });
    assert.deepEqual(told, ['routines:changed']);
    r.stop();
    await new Promise((res) => setTimeout(res, 10));
    const before = seeded.length;
    const later = openRoutines({
      live: { capabilities: new Registry() },
      userData: dir,
      safeStorage,
      seed: async () => void seeded.push('x'),
    });
    later.stop();
    await new Promise((res) => setTimeout(res, 10));
    assert.equal(seeded.length, before, 'a stop before the delayed first sync cancels it');
    // main without a controller or deletion service still opens
    const bare = openRoutines({ live: { capabilities: new Registry() }, userData: dir, safeStorage, seed: async () => {} });
    assert.ok(bare.store);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
