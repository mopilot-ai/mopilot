// Control matrix: action memory (#3571, G4). Routines record and replay through the capability Registry, which every
// harness's tool channel serves (Claude Code, Codex, ACP; a switched chat keeps its MoPilot chat id), so each case
// holds for the in-app browser on every harness: a replay only reads, as the chat's own tool calls with their gates, and the
// steps that act come back as a plan for the model.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { parseUserText } from '../shared/userText.mjs';
import { routineKit, recordSearchTurn, SEARCH, GO, ADD } from './support/routine-kit.ts';

const controls = [SEARCH, GO, ADD];

/** A kit with a saved "Buy" routine recorded in chat1; `o`'s hooks apply from the replay on, not to the recording. */
async function saved(o: Parameters<typeof routineKit>[0] = {}, reads = false) {
  let live = false;
  const k = routineKit({
    controls,
    fail: (t, a) => (live && o.fail ? o.fail(t, a) : null),
    before: (t, a, c) => (live && o.before ? o.before(t, a, c) : undefined),
    current: (c) => (live && o.current ? o.current(c) : true),
  });
  if (reads) {
    // open, read, then add: the two reads run again, the click is left to the model
    await k.call('browser_navigate', { url: 'https://shop.test/' });
    await k.call('browser_read_page', { filter: 'all' });
    await k.call('browser_computer', { action: 'left_click', ref: ADD.ref });
    k.end();
  } else await recordSearchTurn(k);
  await k.call('routine_save', { name: 'Buy' });
  k.end();
  k.did.length = 0;
  live = true;
  return k;
}

/** A gate that holds a fake browser call until released. */
function holdOnce() {
  let release!: () => void;
  let reached!: () => void;
  const atGate = new Promise<void>((r) => (reached = r));
  const gate = new Promise<void>((r) => (release = r));
  let used = false;
  return {
    atGate,
    release: () => release(),
    before: async () => {
      if (used) return;
      used = true;
      reached();
      await gate;
    },
  };
}

test("CM-K46: a completed turn saves as a routine of semantic steps and typed values as parameters; a replay in another chat or harness runs only its reads, as that chat's own tool calls", async () => {
  const k = await saved();
  const r = k.store.get('Buy');
  assert.ok(!JSON.stringify(r.steps).includes('ref_'), 'no ref is stored');
  assert.deepEqual(r.params, [{ name: 'search', example: 'blue mug' }]);
  // on another harness segment of the same chat, or another chat, the routine reads and plans the rest
  const res = await k.call('routine_run', { routine: 'Buy', params: { search: 'teapot' } }, 'chat2', 'acp:gemini:s9');
  assert.equal(res.ok, true);
  assert.deepEqual(
    k.did.map(([t, a]) => [t, a.ref ?? a.text ?? a.url]),
    [['browser_navigate', 'https://shop.test/']],
    'the click, the typing and the rest did not run',
  );
  assert.match(k.text(res), /read 1 of 5 steps again and changed nothing/);
  assert.match(k.text(res), /2\. left_click "Search"\n3\. type "teapot"\n4\. left_click "Go"\n5\. left_click "Add to cart"/);
  // the read went through Registry.invoke on the routine_run call's chat and segment
  const log = k.registry.log.recent(10).filter((e: any) => e.tool.startsWith('browser_'));
  assert.ok(log.slice(-1).every((e: any) => e.chatId === 'chat2' && e.segmentId === 'acp:gemini:s9' && e.outcome === 'ok'));
});

test('CM-K47: a replay hands the steps that act to the model as a plan; a run never changes the routine, whatever the model then does', async () => {
  const k = await saved();
  controls.splice(2, 1, { role: 'button', name: 'Add to bag', ref: 'ref_8' });
  try {
    const shape = () => {
      const { steps, params, rev } = k.store.get('Buy');
      return JSON.stringify({ steps, params, rev });
    };
    const before = shape();
    const res = await k.call('routine_run', { routine: 'Buy' });
    assert.match(k.text(res), /read 1 of 5 steps again and changed nothing/);
    assert.doesNotMatch(k.text(res), /routine is updated/);
    assert.equal(k.did.length, 1, 'only the open ran: nothing acted');
    await k.call('browser_computer', { action: 'left_click', ref: 'ref_8' });
    k.end('chat1', false);
    assert.equal(shape(), before, 'a stopped turn changes nothing');
    await k.call('routine_run', { routine: 'Buy' });
    await k.call('browser_computer', { action: 'left_click', ref: 'ref_8' });
    k.end('chat1', true);
    assert.equal(shape(), before, 'nor does a completed one');
    assert.equal(k.store.get('Buy').rev, 1);
    // the model did nothing further, or something unrelated: still the same routine
    await k.call('routine_run', { routine: 'Buy' });
    k.end('chat1', true);
    await k.call('routine_run', { routine: 'Buy' });
    await k.call('browser_navigate', { url: 'https://elsewhere.test/' });
    k.end('chat1', true);
    assert.equal(shape(), before);
    const after = k.store.get('Buy');
    assert.equal(after.steps.at(-1).target.steps[0].name.s, 'Add to cart');
  } finally {
    controls.splice(2, 1, ADD);
  }
});

test('CM-K48: a password value is never recorded and a replay never fills one, nor puts one in its plan', async () => {
  const PASS = { role: 'password', name: 'Password', ref: 'ref_9' };
  const k = routineKit({ controls: [...controls, PASS] });
  await k.call('browser_form_input', { ref: PASS.ref, value: 'hunter2' });
  await k.call('browser_computer', { action: 'left_click', ref: GO.ref });
  k.end();
  await k.call('routine_save', { name: 'Login' });
  const r = k.store.get('Login');
  assert.ok(!JSON.stringify(r).includes('hunter2'));
  assert.equal(r.steps[0].secret, true);
  k.did.length = 0;
  const res = await k.call('routine_run', { routine: 'Login' });
  assert.match(k.text(res), /read 0 of 2 steps again and changed nothing/);
  assert.doesNotMatch(k.text(res), /hunter2/);
  assert.equal(k.did.length, 0);
});

test('CM-K49: a replayed read a gate refuses (a site refusal, a hidden tool) stops the replay there; nothing past it runs', async () => {
  const k = await saved({ fail: (t) => (t === 'browser_read_page' ? 'This site is on the no-go list' : null) }, true);
  const res = await k.call('routine_run', { routine: 'Buy' });
  assert.match(k.text(res), /stopped before step 2 of 3.*it failed: This site is on the no-go list/s);
  assert.match(k.text(res), /before you act:\n2\. read_page\n3\. left_click "Add to cart"\n/);
  assert.equal(k.did.length, 1, 'only the open ran');
  const h = await saved({}, true);
  h.registry.setHidden(
    (n: string) => n === 'browser_navigate',
    () => 'Browser control is turned off.',
  );
  const off = await h.call('routine_run', { routine: 'Buy' });
  assert.match(h.text(off), /stopped before step 1 of 3.*Browser control is turned off/s);
  assert.equal(h.did.length, 0);
});

test("CM-C06: one replay per chat at a time; another chat runs its own; an older replay's update after a newer edit is dropped", async () => {
  const hold = holdOnce();
  const k = await saved({ before: () => hold.before() });
  const first = k.call('routine_run', { routine: 'Buy' }, 'chat1');
  await hold.atGate;
  const second = await k.call('routine_run', { routine: 'Buy' }, 'chat1');
  assert.equal(second.error.code, 'busy');
  const other = await k.call('routine_run', { routine: 'Buy' }, 'chat2', 'codex-thread');
  assert.equal(other.ok, true, 'another chat is not held up');
  hold.release();
  assert.equal((await first).ok, true);
  // the busy flag is released: the chat can run again
  assert.equal((await k.call('routine_run', { routine: 'Buy' }, 'chat1')).ok, true);
});

test('CM-R14: Stop during a replay ends it at once: no step after it runs, and the routine is not changed', async () => {
  const hold = holdOnce();
  const k = await saved({ before: () => hold.before() });
  const run = k.call('routine_run', { routine: 'Buy' });
  await hold.atGate;
  k.registry.abortChat('chat1', 'stopped');
  hold.release();
  const res = await run;
  assert.equal(res.ok, false);
  assert.equal(res.error.code, 'aborted');
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(k.did.length, 0, 'the held step and every later one never ran');
  k.end('chat1', false);
  assert.equal(k.store.get('Buy').rev, 1);
  assert.equal(k.recorder.replaying.has('chat1'), false);
});

test('CM-S03: a harness switch during a replay stops it before its next step', async () => {
  let switched = false;
  const k = await saved({
    current: () => !switched,
    before: (tool) => {
      if (tool === 'browser_navigate') switched = true;
    },
  });
  const res = await k.call('routine_run', { routine: 'Buy' });
  assert.equal(res.ok, false);
  assert.match(res.error.message, /stopped before step 2 of 5.*switched to another harness/);
  assert.equal(k.did.length, 1);
});

test("CM-K57: chrome_* steps record on the user's Chrome; a replay reads there through chrome_* tools and plans the click; a Chrome that is down refuses the run", async () => {
  const k = routineKit({ controls });
  await k.call('chrome_navigate', { url: 'https://shop.test/', tabId: 41 });
  await k.call('chrome_computer', { action: 'left_click', ref: GO.ref, tabId: 41 });
  k.end();
  await k.call('routine_save', { name: 'Chrome go' });
  k.did.length = 0;
  assert.equal((await k.call('routine_run', { routine: 'Chrome go' })).ok, true);
  assert.deepEqual(
    k.did.map(([t]) => t),
    ['chrome_navigate'],
    'the click is left to the model',
  );
  assert.match(k.text(await k.call('routine_run', { routine: 'Chrome go' })), /before you act:\n2\. left_click "Go"\n/);
  k.setChromeUp(false);
  assert.equal((await k.call('routine_run', { routine: 'Chrome go' })).error.code, 'unavailable');
});

test('CM-K58: desktop_app_* steps record by accessibility identity; a replay clicks nothing and takes no screenshot, and plans the step by its label', async () => {
  const k = routineKit();
  const els = [
    { index: 1, role: 'AXButton', label: 'New Note', frame: { x: 0, y: 0, w: 9, h: 9 } },
    { index: 2, role: 'AXButton', label: 'Share', frame: { x: 10, y: 0, w: 9, h: 9 } },
  ];
  const win = { geom: {}, elements: els };
  const apps = {
    sessions: new Map([
      ['chat1', { apps: new Map([['com.apple.notes', { name: 'Notes', lastWindow: 1, windows: new Map([[1, win]]) }]]) }],
    ]),
  };
  const did: any[] = [];
  const rec = k.recorder.recording(k.registry, () => apps, 'desktop_');
  for (const name of ['desktop_app_screenshot', 'desktop_app_click'])
    rec.register({
      name,
      policy: name.endsWith('screenshot') ? 'observe' : 'act',
      authorizesItself: true,
      schema: { type: 'object' },
      handler: async (args: any) => {
        if (name.endsWith('screenshot')) did.push('shot');
        else did.push(args.element_index);
        return 'ok';
      },
    });
  await k.call('desktop_app_click', { app: 'Notes', element_index: 1 });
  k.end();
  await k.call('routine_save', { name: 'New note' });
  did.length = 0;
  const res = await k.call('routine_run', { routine: 'New note' });
  assert.equal(res.ok, true);
  assert.deepEqual(did, [], 'no click and no screenshot');
  assert.match(k.text(res), /read 0 of 1 steps again and changed nothing/);
  assert.match(k.text(res), /before you act:\n1\. click "New Note"$/);
});

test("CM-K59: steps a harness's own control ran (the Codex Browser plugin, Claude in Chrome, Codex Computer Use) are not recorded, and saving says so by name", async () => {
  const k = routineKit({ controls });
  const { createRoutineTools } = createRequire(import.meta.url)('../electron/capabilities/routines/routineTools.cjs');
  const save = createRoutineTools({
    store: k.store,
    recorder: k.recorder,
    adapters: () => null,
    invoke: null,
    current: () => true,
    unrecorded: () => 'Claude in Chrome',
  }).find((t: any) => t.name === 'routine_save');
  await assert.rejects(save.handler({ name: 'X' }, { chatId: 'chat1' }), /ran through Claude in Chrome, which MoPilot can't record/);
});

test('CM-K60: a completed turn with steps offers one "Save as routine" line; any other end takes it back', async () => {
  const { openRoutines } = createRequire(import.meta.url)('../electron/app/routines.cjs');
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-k59-'));
  try {
    const patches: any[] = [];
    const { Registry } = createRequire(import.meta.url)('../electron/capabilities/contract/registry.cjs');
    const live: any = { capabilities: new Registry(), controller: {}, sessions: { patch: (...a: any[]) => patches.push(a) } };
    const r = openRoutines({ live, userData: dir, safeStorage: null, seed: async () => {}, startDelayMs: 60_000 });
    const nav = { tool: 'browser_navigate', args: {} };
    r.recorder.turns.set('c', { steps: [nav, nav, nav], failed: false, overflow: false, replays: [] });
    live.controller.onFinished({ chatId: 'c', completed: true, turnId: 't1' });
    assert.deepEqual(patches.at(-1), ['c', { routineOffer: { turnId: 't1', steps: 3 } }]);
    r.recorder.turns.set('c', { steps: [{ tool: 'browser_navigate', args: {} }], failed: false, overflow: false, replays: [] });
    live.controller.onFinished({ chatId: 'c', completed: false, turnId: 't2' });
    assert.deepEqual(patches.at(-1), ['c', { routineOffer: null }]);
    r.stop();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('CM-K61: a saved routine reaches the next chat: the real plugin store installs it as a skill with how to run it, and each run of a task saved from several messages does one part', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const req = createRequire(import.meta.url);
  const { writePlugin, PLUGIN } = req('../electron/capabilities/routines/routineSkills.cjs');
  const { PluginStore } = req('../electron/plugins/store.cjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-k61-'));
  try {
    fs.mkdirSync(path.join(dir, 'store'));
    const store = new PluginStore({ dir: () => path.join(dir, 'store') });
    const k = routineKit({ controls });
    await k.call('browser_navigate', { url: 'https://shop.test/' });
    k.end();
    await k.call('browser_computer', { action: 'left_click', ref: ADD.ref });
    k.end();
    await k.call('routine_save', { name: 'Buy', description: 'Adds a mug to the cart.' });
    assert.equal(
      await store.seedBundled(writePlugin(path.join(dir, 'gen'), k.store.list()), { name: PLUGIN, marketplace: 'mopilot' }),
      'installed',
    );
    const [skill] = (await store.list()).plugins[0].spec.skills;
    assert.match(skill.description, /Adds a mug to the cart\..*routine_run tool \(routine: 'Buy'\)/);
    k.did.length = 0;
    await k.call('routine_run', { routine: 'Buy' }, 'chat2', 'acp:gemini:s1');
    assert.deepEqual(
      k.did.map(([t]) => t),
      ['browser_navigate'],
      'part 1 only opens; the part that acts is never run',
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("CM-K62: the same message in a new chat is told of the routine on every harness, whether it reads or acts; another message isn't", async () => {
  const k = routineKit({ controls });
  const ask = 'Search the shop for a blue mug and add it';
  k.recorder.turnStarting('chat1', ask);
  await k.call('browser_navigate', { url: 'https://shop.test/' });
  await k.call('browser_read_page', {});
  k.end();
  await k.call('routine_save', { name: 'Mugs', description: 'Reads the mugs.' });
  const { routineTurnStarting } = createRequire(import.meta.url)('../electron/capabilities/routines/routineMatch.cjs');
  const send = (chatId: string, text: string) => {
    const item = { text, opts: { human: true }, attachments: [] };
    routineTurnStarting({ recorder: k.recorder, store: k.store, apart: () => false }, { chatId, kind: 'start', item });
    return item.text;
  };
  for (const chat of ['claude-chat', 'codex-chat', 'acp-chat']) {
    const sent = send(chat, ask);
    assert.match(sent, /routine_run call \(routine: '/);
    assert.equal(parseUserText(sent).text, ask);
  }
  assert.equal(send('claude-chat', 'Book a table for two tonight please'), 'Book a table for two tonight please');
  // a part that acts is told of too: a run only reads it and plans the rest
  const buys = 'Buy the blue mug from the shop and pay for it';
  k.recorder.turnStarting('chat1', buys);
  await recordSearchTurn(k);
  await k.call('routine_save', { name: 'Buy', description: 'Buys a mug.' });
  const acts = send('codex-chat', buys);
  assert.match(acts, new RegExp(`routine_run call \\(routine: '${k.store.get('Buy').id}'\\) reads its pages again and changes nothing`));
  assert.equal(parseUserText(acts).text, buys);
});
