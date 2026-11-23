// Action memory's tools (#3571, G4; electron/capabilities/routines/routineTools.cjs) on a real capability Registry:
// routine_save keeps the chat's steps since its last save with their typed values as parameters, routine_run reads its pages
// again through the registry and never acts (the steps left come back as a plan), and a run never changes the routine,
// routine_list says what is saved, and each refusal.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { routineKit, recordSearchTurn, SEARCH, GO, ADD } from './support/routine-kit.ts';

const require = createRequire(import.meta.url);
const { createRoutineTools, ROUTINE_TOOL_NAMES } = require('../electron/capabilities/routines/routineTools.cjs');

const controls = [SEARCH, GO, ADD];

test('the three tools register on the registry and unregister', () => {
  const k = routineKit();
  for (const n of ROUTINE_TOOL_NAMES) assert.ok(k.registry.has(n), n);
  k.unregister();
  for (const n of ROUTINE_TOOL_NAMES) assert.equal(k.registry.has(n), false, n);
});

test('routine_save: nothing to save before a completed turn; then the steps, their lines and the parameters', async () => {
  const k = routineKit({ controls });
  const none = await k.call('routine_save', { name: 'Buy' });
  assert.equal(none.ok, false);
  assert.equal(none.error.code, 'nothing_to_save');
  await recordSearchTurn(k);
  const saved = await k.call('routine_save', { name: 'Buy a mug', description: 'Searches and adds the first result.' });
  assert.equal(saved.ok, true);
  assert.match(
    k.text(saved),
    /^Saved routine "Buy a mug" \[.+\] with 5 steps:\n1\. navigate https:\/\/shop.test\/\n2\. left_click "Search"\n3\. type "{{search}}"\n4\. left_click "Go"\n5\. left_click "Add to cart"\nParameters: search\.$/,
  );
  const r = k.store.get('Buy a mug');
  assert.deepEqual(r.params, [{ name: 'search', example: 'blue mug' }]);
  await recordSearchTurn(k);
  const twice = await k.call('routine_save', { name: 'buy a MUG' });
  assert.equal(twice.error.code, 'exists');
});

test('routine_save names no parameters when nothing was typed', async () => {
  const k = routineKit({ controls });
  await k.call('browser_computer', { action: 'left_click', ref: ADD.ref });
  k.end();
  assert.match(k.text(await k.call('routine_save', { name: 'Add' })), /Parameters: none\.$/);
});

test('routine_run: the reads run again and nothing acts; the first click and all after it come back as a plan with the values given', async () => {
  const k = routineKit({ controls });
  await recordSearchTurn(k);
  await k.call('routine_save', { name: 'Buy' });
  k.end();
  k.did.length = 0;
  k.page.url = 'about:blank';
  const res = await k.call('routine_run', { routine: 'buy', params: { search: 'red cup' } });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.deepEqual(
    k.did,
    [['browser_navigate', { url: 'https://shop.test/' }]],
    'the open ran; the click, the typing and the rest did not',
  );
  const text = k.text(res);
  assert.match(text, /^Routine "Buy" read 1 of 5 steps again and changed nothing\. A routine doesn't act: the rest is yours to do\./);
  assert.doesNotMatch(text, /It stopped before/, 'stopping at a step that acts needs no reason');
  assert.match(text, /before you act:\n2\. left_click "Search"\n3\. type "red cup"\n4\. left_click "Go"\n5\. left_click "Add to cart"\n/);
  assert.equal(k.store.get('Buy').runs, 1);
  assert.equal(k.store.get('Buy').handoffs, 1);
});

test('routine_run: a routine of reads is done: what they found comes back, and a completed turn changes no step', async () => {
  const k = routineKit({ controls });
  await k.call('browser_navigate', { url: 'https://shop.test/' });
  await k.call('browser_read_page', { filter: 'all' });
  k.end();
  await k.call('routine_save', { name: 'Look' });
  k.did.length = 0;
  const res = await k.call('routine_run', { routine: 'Look' });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.equal(
    k.text(res),
    'Routine "Look" read all 2 steps again. They only open and read pages, so nothing changed. Its result is below, as the pages are now: reading the same pages again would show the same.\nStep 2 (read_page) found:\nbrowser_read_page ok; Tab 1 is at https://shop.test/.\nbrowser_read_page ok; Tab 1 is at https://shop.test/.\n<browser_state>\ncurrent tab: tab_1 · Page · https://shop.test/\ntabs: tab_1*\n</browser_state>',
  );
  assert.deepEqual(
    k.did.map(([t]) => t),
    ['browser_navigate', 'browser_read_page'],
  );
  assert.equal(k.store.get('Look').runs, 1);
  assert.equal(k.store.get('Look').handoffs, 0);
  assert.deepEqual(k.end(), { offer: false });
  assert.equal(k.store.get('Look').rev, 1);
});

test('routine_run refuses: no such routine, a desktop routine, browser tools not up, turned off', async () => {
  const k = routineKit({ controls });
  assert.equal((await k.call('routine_run', { routine: 'x' })).error.code, 'not_found');
  k.store.save({ kind: 'desktop', name: 'Desk', steps: [{ tool: 'desktop_click', args: {} }], params: [] });
  assert.equal((await k.call('routine_run', { routine: 'Desk' })).error.code, 'unavailable');
  k.store.save({ kind: 'browser', name: 'Web', steps: [{ tool: 'browser_navigate', args: { url: 'https://a.test/' } }], params: [] });
  k.recorder.recording(k.registry, null);
  assert.match((await k.call('routine_run', { routine: 'Web' })).error.message, /isn't available yet/);
  const tools = createRoutineTools({
    store: k.store,
    recorder: k.recorder,
    tabs: () => null,
    invoke: null,
    current: () => true,
    enabled: () => 'Action memory is off.',
  });
  for (const t of tools) await assert.rejects(t.handler({ routine: 'Web', name: 'x' }, { chatId: 'c' }), /Action memory is off/);
});

test('routine_run hands off before the step that acts, and the completed turn leaves the routine as it was', async () => {
  const k = routineKit({ controls });
  await k.call('browser_navigate', { url: 'https://shop.test/' });
  await k.call('browser_read_page', { filter: 'all' });
  await k.call('browser_computer', { action: 'left_click', ref: ADD.ref });
  k.end();
  await k.call('routine_save', { name: 'Buy' });
  // the page now says "Add to bag": the last step's target is gone
  const BAG = { role: 'button', name: 'Add to bag', ref: 'ref_4' };
  controls.splice(2, 1, BAG);
  try {
    k.did.length = 0;
    const res = await k.call('routine_run', { routine: 'Buy' });
    assert.equal(res.ok, true);
    assert.match(k.text(res), /read 2 of 3 steps again and changed nothing\./);
    assert.match(k.text(res), /before you act:\n3\. left_click "Add to cart"\n/);
    assert.deepEqual(
      k.did.map(([t]) => t),
      ['browser_navigate', 'browser_read_page'],
      'the click did not run, and no target was looked for',
    );
    assert.equal(k.store.get('Buy').handoffs, 1);
    // the model finishes the task: the turn completes, and the routine is not changed by it
    const before = JSON.stringify(k.store.get('Buy'));
    await k.call('browser_computer', { action: 'left_click', ref: BAG.ref });
    assert.deepEqual(k.end(), { offer: false });
    const r = k.store.get('Buy');
    assert.equal(r.rev, 1);
    assert.equal(JSON.stringify(r), before);
    assert.deepEqual(
      r.steps.map((s: any) => s.target?.steps.at(-1).name.s ?? s.args.url ?? s.tool),
      ['https://shop.test/', 'browser_read_page', 'Add to cart'],
    );
  } finally {
    controls.splice(2, 1, ADD);
  }
});

test('routine_list: none saved, then each with its parameters and runs', async () => {
  const k = routineKit({ controls });
  assert.equal(k.text(await k.call('routine_list')), 'No routines are saved yet.');
  await recordSearchTurn(k);
  await k.call('routine_save', { name: 'Buy', description: 'Adds a mug.' });
  await recordSearchTurn(k);
  await k.call('routine_save', { name: 'Plain' });
  const r = k.store.get('Buy');
  assert.equal(
    k.text(await k.call('routine_list')),
    `Saved routines:\n- Plain [${k.store.get('Plain').id}]\n  5 steps; parameters: search (recorded: "blue mug"); run 0 time(s)\n- Buy [${r.id}]: Adds a mug.\n  5 steps; parameters: search (recorded: "blue mug"); run 0 time(s)`,
  );
  k.store.save({ kind: 'browser', name: 'Bare', steps: [{ tool: 'browser_navigate', args: { url: 'https://a.test/' } }], params: [] });
  assert.match(k.text(await k.call('routine_list')), /parameters: none/);
});

test("a count that can't be saved never fails the run", async () => {
  const k = routineKit({ controls });
  k.store.save({ kind: 'browser', name: 'Web', steps: [{ tool: 'browser_navigate', args: { url: 'https://shop.test/' } }], params: [] });
  k.sealed.m.available = false;
  const res = await k.call('routine_run', { routine: 'Web' });
  assert.equal(res.ok, true);
});

test("BU: chrome_* steps record on the user's Chrome; a replay reads there through chrome_* tools and plans the clicks; a Chrome that is down refuses the run", async () => {
  const k = routineKit({ controls });
  await k.call('chrome_navigate', { url: 'https://shop.test/', tabId: 41 });
  await k.call('chrome_read_page', { filter: 'all' });
  await k.call('chrome_computer', { action: 'left_click', ref: SEARCH.ref, tabId: 41 });
  await k.call('chrome_computer', { action: 'type', text: 'green tea' });
  k.end();
  await k.call('routine_save', { name: 'Tea' });
  const r = k.store.get('Tea');
  assert.deepEqual(
    r.steps.map((s: any) => s.tool),
    ['chrome_navigate', 'chrome_read_page', 'chrome_computer', 'chrome_computer'],
  );
  assert.deepEqual(r.params, [{ name: 'search', example: 'green tea' }]);
  k.did.length = 0;
  const res = await k.call('routine_run', { routine: 'Tea', params: { search: 'oolong' } });
  assert.equal(res.ok, true, JSON.stringify(res.error));
  assert.deepEqual(k.did, [
    ['chrome_navigate', { url: 'https://shop.test/' }],
    ['chrome_read_page', { filter: 'all' }],
  ]);
  assert.equal(k.chromeTabs.queries, 0, 'no target is looked for: a click is not run');
  assert.match(k.text(res), /read 2 of 4 steps again and changed nothing/);
  assert.match(k.text(res), /before you act:\n3\. left_click "Search"\n4\. type "oolong"\n/);
  k.setChromeUp(false);
  const down = await k.call('routine_run', { routine: 'Tea' });
  assert.equal(down.error.code, 'unavailable');
  assert.match(down.error.message, /Your Chrome isn't available yet/);
});

test('a task of two messages saves as two parts: each run does one part, says the next, and a hand-off changes neither', async () => {
  const k = routineKit({ controls });
  await k.call('browser_navigate', { url: 'https://shop.test/' });
  await k.call('browser_read_page', { filter: 'all' });
  k.end();
  await k.call('browser_computer', { action: 'left_click', ref: GO.ref });
  await k.call('browser_computer', { action: 'left_click', ref: ADD.ref });
  k.end();
  // a later turn that only looked adds no part
  await k.call('browser_read_page', { filter: 'interactive' });
  assert.equal(k.end().offer, false);
  await k.call('routine_save', { name: 'Both' });
  const r = k.store.get('Both');
  assert.deepEqual(
    r.steps.map((s: any) => s.part),
    [1, 1, 2, 2],
  );
  k.did.length = 0;
  const one = await k.call('routine_run', { routine: 'Both' });
  assert.deepEqual(
    k.did.map(([t]) => t),
    ['browser_navigate', 'browser_read_page'],
    'the first part only: the next waits for the user',
  );
  assert.match(k.text(one), /read all 2 steps of part 1 of 2 again\. They only open and read pages, so nothing changed/);
  assert.match(k.text(one), /Step 2 \(read_page\) found:\nbrowser_read_page ok/);
  assert.match(k.text(one), /Run it only when the user asks for it: routine_run with part 2\./);
  k.did.length = 0;
  const two = await k.call('routine_run', { routine: 'Both', part: 2 });
  assert.deepEqual(k.did, [], 'part 2 only acts: none of it ran');
  assert.match(k.text(two), /read 0 of 2 steps of part 2 of 2 again and changed nothing/);
  assert.match(k.text(two), /1\. left_click "Go"\n2\. left_click "Add to cart"$/);
  assert.doesNotMatch(k.text(two), /has not run/);
  assert.equal((await k.call('routine_run', { routine: 'Both', part: 3 })).error.code, 'bad_args');
  k.end();
  // part 2's last control is renamed: the hand-off's completed turn changes neither part
  const shape = () => {
    const { steps, params, rev } = k.store.get('Both');
    return JSON.stringify({ steps, params, rev });
  };
  const saved = shape();
  const BAG = { role: 'button', name: 'Add to bag', ref: 'ref_4' };
  controls.splice(2, 1, BAG);
  try {
    await k.call('routine_run', { routine: 'Both', part: 2 });
    await k.call('browser_computer', { action: 'left_click', ref: GO.ref });
    await k.call('browser_computer', { action: 'left_click', ref: BAG.ref });
    k.end();
    const after = k.store.get('Both');
    assert.equal(shape(), saved);
    assert.deepEqual(
      after.steps.map((s: any) => [s.part, s.target?.steps.at(-1).name.s ?? s.tool]),
      [
        [1, 'browser_navigate'],
        [1, 'browser_read_page'],
        [2, 'Go'],
        [2, 'Add to cart'],
      ],
    );
  } finally {
    controls.splice(2, 1, ADD);
  }
});

test('routine_save takes the last turns asked for; the chat keeps its last five; steps past the limit drop its oldest turns', async () => {
  const { MAX_PARTS } = require('../electron/capabilities/routines/routineRecorder.cjs');
  const { MAX_STEPS } = require('../electron/capabilities/routines/routineStore.cjs');
  const k = routineKit({ controls });
  for (let i = 0; i < MAX_PARTS + 1; i++) {
    await k.call('browser_navigate', { url: `https://shop.test/?t=${i}` });
    k.end();
  }
  assert.equal(k.recorder.lastTurn('chat1').steps.length, MAX_PARTS);
  await k.call('routine_save', { name: 'Last two', turns: 2 });
  assert.deepEqual(
    k.store.get('Last two').steps.map((s: any) => [s.part, s.args.url]),
    [
      [1, `https://shop.test/?t=${MAX_PARTS - 1}`],
      [2, `https://shop.test/?t=${MAX_PARTS}`],
    ],
  );
  // the save cleared what was kept: a small turn, then one that fills the limit and pushes it out
  await k.call('browser_navigate', { url: 'https://shop.test/small' });
  k.end();
  for (let i = 0; i < MAX_STEPS; i++) await k.call('browser_computer', { action: 'key', text: 'a' });
  k.end();
  assert.equal(k.recorder.lastTurn('chat1').steps.length, MAX_STEPS, 'only the turn that fills the limit is left');
});

test('routine_list says when new chats do not list the routines as skills', async () => {
  const k = routineKit({ controls });
  k.store.save({ kind: 'browser', name: 'Web', steps: [{ tool: 'browser_navigate', args: { url: 'https://a.test/' } }], params: [] });
  const list = createRoutineTools({
    store: k.store,
    recorder: k.recorder,
    adapters: () => null,
    invoke: null,
    current: () => true,
    skillsProblem: () => 'The Routines plugin was removed.',
  }).find((t: any) => t.name === 'routine_list');
  assert.match(await list.handler({}, {}), /New chats don't list these as skills: The Routines plugin was removed\.$/);
});

test('part and turns must be whole numbers from 1: nothing runs or saves otherwise; a save starts the next task afresh', async () => {
  const k = routineKit({ controls });
  await k.call('browser_navigate', { url: 'https://shop.test/' });
  k.end();
  const tools = createRoutineTools({ store: k.store, recorder: k.recorder, adapters: () => null, invoke: null, current: () => true });
  const tool = (n: string) => tools.find((t: any) => t.name === n);
  for (const turns of [0, -1, 1.5, '2'])
    await assert.rejects(tool('routine_save').handler({ name: 'X', turns }, { chatId: 'chat1' }), /whole number/);
  await k.call('routine_save', { name: 'First' });
  for (const part of [0, 1.5, '1'])
    await assert.rejects(tool('routine_run').handler({ routine: 'First', part }, { chatId: 'chat1' }), /has 1 part/);
  // what was saved doesn't come along with the chat's next task
  assert.equal(k.recorder.lastTurn('chat1'), null);
  await k.call('browser_computer', { action: 'left_click', ref: ADD.ref });
  k.end();
  await k.call('routine_save', { name: 'Second' });
  assert.equal(k.store.get('Second').steps.length, 1);
});

test('routine_run loads up front once there is a routine to run, and stays deferred with none or when the store cannot be read', async () => {
  const k = routineKit({ controls: [SEARCH, GO, ADD] });
  const { sdkMcpServers } = createRequire(import.meta.url)('../electron/capabilities/mcp/sdkMcp.cjs');
  // the session's tools, as a Claude session gets them: what the SDK is told to load up front
  const loaded = () => {
    const seen: Record<string, boolean> = {};
    sdkMcpServers({
      sdk: {
        tool: (name: string, _d: any, _s: any, _h: any, o: any) => void (seen[name] = o.alwaysLoad),
        createSdkMcpServer: (x: any) => x,
      },
      z: { fromJSONSchema: () => ({}) },
      registry: k.registry,
      serverName: 'sage_test',
      owner: { chatId: 'chat1', segmentId: 'claude:s1' },
    });
    return seen;
  };
  assert.equal(loaded().routine_run, false, 'no routine: no standing cost');
  await recordSearchTurn(k);
  await k.call('routine_save', { name: 'Buy', description: 'Buys a mug.' });
  assert.equal(loaded().routine_run, true);
  assert.equal(loaded().routine_save, false, 'only the run');
  const { list } = k.store;
  k.store.list = () => {
    throw new Error('keychain');
  };
  assert.equal(loaded().routine_run, false);
  k.store.list = list;
});
