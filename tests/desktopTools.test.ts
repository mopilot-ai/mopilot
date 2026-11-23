// electron/capabilities/tools/desktop.cjs: the desktop_* tools every harness gets, over the scripted helper, coordinator,
// broker and grant store of tests/support/desktop-kit.ts. Covers the specs and helpers, dispatch and the permission card,
// the serial queue, and the turn-end release, Esc stop and forget. Access, the gate, actions and screenshots have their
// own files (desktopAccess, desktopGrants, desktopGate, desktopActions, desktopCapture).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DesktopControl,
  SPECS,
  ACTION_SPECS,
  ACTIONS,
  TOOL_NAMES,
  desktopToolSpecs,
  indexElements,
  processAncestry,
  onboarding,
  P,
  NOTES,
  snapshot,
  fakeHelper,
  rig,
  rejects,
} from './support/desktop-kit.ts';

/* -- specs ------------------------------------------------------------- */
test('specs: plain JSON schema for every harness; irreversible only on input actions; batch lists the actions', () => {
  const specs = desktopToolSpecs();
  assert.deepEqual(
    specs.map((s: any) => s.name),
    TOOL_NAMES,
  );
  assert.ok(TOOL_NAMES.includes('desktop_request_access') && TOOL_NAMES.includes('desktop_batch'));
  for (const s of specs) assert.equal(s.inputSchema.type, 'object');
  for (const s of ACTION_SPECS) {
    const action = s.name.replace(/^desktop_/, '');
    assert.equal('irreversible' in s.schema.properties, P.INPUT.has(action), s.name);
    assert.equal(s.policy, P.INPUT.has(action) ? 'act' : 'observe', s.name);
  }
  const batch = SPECS.find((s: any) => s.name === 'desktop_batch');
  assert.deepEqual(batch.schema.properties.actions.items.properties.action.enum, ACTIONS);
  assert.doesNotMatch(batch.description, /Actions: screenshot/);
  assert.equal(batch.schema.properties.actions.maxItems, 50);
});

test('tools(): registry tools that authorize themselves and run through the control', async () => {
  const r = rig();
  const tools = r.d.tools();
  assert.equal(tools.length, SPECS.length);
  assert.ok(tools.every((t: any) => t.authorizesItself === true));
  const list = tools.find((t: any) => t.name === 'desktop_list_granted_applications');
  const out = JSON.parse((await list.handler(undefined, { chatId: 'c1' }))[0].text);
  assert.deepEqual(out.apps, []);
});

/* -- helpers ----------------------------------------------------------- */
test('indexElements: interactive, labeled, on-screen elements of the frontmost app, numbered, up to a limit', () => {
  const geom = { x: 0, y: 0, ppp: 0.5, width: 1000, height: 500 };
  const els = indexElements(snapshot(), geom, NOTES);
  assert.deepEqual(
    els.map((e: any) => [e.index, e.role, e.label]),
    [
      [1, 'AXButton', 'Send'],
      [2, 'AXTextField', 'To:  someone'],
      [3, 'AXCheckBox', 'Bold'],
      [4, 'AXImage', 'Logo'],
      [5, 'AXLink', 'x'.repeat(100)],
      [6, 'AXButton', ''],
    ],
  );
  assert.deepEqual(els[0].center, { x: 110, y: 55 }, 'the center in screenshot pixels');
  assert.equal(els[0].pid, 7);
  assert.equal(els[2].enabled, false);
  assert.equal(indexElements(snapshot(), geom, NOTES, 1).length, 1);
  assert.deepEqual(indexElements(null, geom, NOTES), []);
  assert.deepEqual(
    indexElements({ root: { role: 'AXButton', title: 'x', frame: { x: 0, y: 0, w: 10, h: 10 }, children: 'no' } }, geom, NOTES).length,
    1,
  );
});

test('processAncestry: this process and its parents, stopping at launchd, a failed core, loops and a depth limit', async () => {
  const table = async () => [
    [100, 50, 100],
    [50, 20, 50],
    [20, 1, 20],
  ];
  assert.deepEqual([...(await processAncestry(100, table))], [100, 50, 20]);
  assert.deepEqual([...(await processAncestry(1, table))], [1]);
  // a failed core is the empty table, and a pid not in it has no parent to name
  assert.deepEqual([...(await processAncestry(100, async () => []))], [100]);
  assert.deepEqual(
    [
      ...(await processAncestry(100, async () => [
        [100, 200, 100],
        [200, 100, 200],
      ])),
    ],
    [100, 200],
    'a loop ends',
  );
  const deep = await processAncestry(1000, async () => Array.from({ length: 40 }, (_, i) => [1000 + i, 1001 + i, 1000 + i]));
  assert.equal(deep.size, 17, 'at most 16 parents');
  // the real one: this process is in it
  assert.ok((await processAncestry()).has(process.pid));
});

test('onboarding: names the exact helper, the pane and its link; Screen Recording needs a relaunch', () => {
  const sr = onboarding('screenRecording', { name: 'H', bundleId: 'b.id', path: '/A/H.app' });
  assert.match(sr, /"H" \(b\.id, \/A\/H\.app\) cannot use Screen Recording yet/);
  assert.match(sr, /unavailable to "H"/);
  assert.match(sr, /Privacy_ScreenCapture/);
  assert.match(sr, /permission card in this chat/);
  assert.match(sr, /relaunches it on the next try/);
  const ax = onboarding('accessibility');
  assert.match(ax, /"MoPilot" \(ai\.mopilot\.code\.computer-use\) cannot use Accessibility yet/);
  assert.doesNotMatch(ax, /relaunch/);
  assert.match(onboarding('inputMonitoring'), /pane x-apple\.systempreferences:com\.apple\.preference\.security\?Privacy_ListenEvent\)/);
  assert.match(onboarding('whatever'), /Accessibility/);
});

/* -- permissions -------------------------------------------------------- */
test('a missing permission shows the card, names the helper, and Screen Recording relaunches the helper', async () => {
  const r = rig();
  await r.grant([NOTES]);
  r.helper.fail.screenshot = Object.assign(new Error('screenRecording permission not granted'), { reason: 'permission_denied' });
  const err: any = await r.call('desktop_screenshot').catch((e: any) => e);
  assert.equal(err.code, 'permission');
  assert.equal(err.permission, 'screenRecording');
  assert.match(err.message, /"Helper" \(ai\.helper, \/Apps\/Helper\.app\) cannot use Screen Recording yet/);
  assert.ok(r.cu.blocked.has('c1'));
  assert.deepEqual(r.activity.at(-1), ['c1', { app: 'your Mac', state: 'permission', permission: 'screenRecording' }]);
  assert.deepEqual(
    r.methods().filter((m: string) => m === 'stop'),
    ['stop'],
  );
  // while a chat holds the desktop the helper keeps running
  r.cu.controlling = 'c2';
  r.cu.app = 'Mail';
  await r.call('desktop_screenshot').catch(() => {});
  assert.deepEqual(
    r.methods().filter((m: string) => m === 'stop'),
    ['stop'],
  );
  assert.equal(r.activity.at(-1)[1].app, 'Mail');
  // the next call that works takes the card down
  r.cu.controlling = null;
  delete r.helper.fail.screenshot;
  await r.call('desktop_screenshot');
  assert.equal(r.cu.blocked.has('c1'), false);
  assert.deepEqual(r.activity.at(-1), ['c1', null]);
  // the guard and an unnamed permission read as Accessibility
  r.helper.fail.screenshot = Object.assign(new Error('x'), { reason: 'guard_unavailable' });
  assert.equal((await r.call('desktop_screenshot').catch((e: any) => e)).permission, 'accessibility');
  r.helper.fail.screenshot = Object.assign(new Error('something permission not granted'), { reason: 'permission_denied' });
  assert.equal((await r.call('desktop_screenshot').catch((e: any) => e)).permission, 'accessibility');
  // a chat holding the desktop whose call works again: the bar shows it active
  delete r.helper.fail.screenshot;
  r.cu.controlling = 'c1';
  r.cu.app = 'Notes';
  await r.call('desktop_screenshot');
  assert.deepEqual(r.activity.at(-1), ['c1', { app: 'Notes', state: 'active' }]);
});

test('dispatch: an unknown tool; a call without a context; refusals carry the action record', async () => {
  const r = rig();
  await rejects(r.call('desktop_fly'), 'bad_args', /Unknown desktop tool: desktop_fly/);
  await rejects(r.d.run('desktop_key', { text: 'a' }), 'denied', /No apps are granted/);
  // perform refuses an action it does not know (the switch's default)
  await r.ready([NOTES]);
  const s = r.d.session('c1');
  const prep = await r.d.prepare('c1', s, 'mouse_move', { coordinate: [1, 1] });
  await rejects(r.d.perform('c1', s, 'teleport', {}, prep), 'bad_args', /Unknown action: teleport/);
});

test('consequence: the smallest element under a click decides; nothing known under it is not irreversible', () => {
  const r = rig();
  const el = (label: string, x: number, y: number, w: number, h: number) => ({ label, frame: { x, y, w, h } });
  const prep = (point: any) => ({ g: { front: NOTES }, el: null, point });
  const s = { elements: [el('Toolbar', 0, 0, 500, 100), el('Send', 10, 10, 50, 20), el('Delete everything', 0, 0, 800, 200)] };
  assert.equal(r.d.consequence(s, 'left_click', {}, prep({ x: 20, y: 15 })).verb, 'send', 'the smallest of three nested elements');
  assert.equal(r.d.consequence(s, 'left_click', {}, prep({ x: 600, y: 150 })).verb, 'delete');
  assert.equal(r.d.consequence(s, 'left_click', {}, prep({ x: 900, y: 900 })), null);
  assert.equal(r.d.consequence(s, 'left_click', {}, prep(null)), null);
  assert.equal(r.d.consequence({}, 'left_click', {}, prep({ x: 1, y: 1 })), null);
  // no frontmost app known: the model's own flag still asks, keyed without an app
  const irr = r.d.consequence(s, 'mouse_move', { irreversible: true }, { g: { front: null } });
  assert.deepEqual(irr, { verb: 'do this', summary: 'mouse move', key: '\u0000do this\u0000mouse move' });
});

test('an unknown tier is never enough, and the refusal gives no hint', async () => {
  const r = rig();
  await r.ready([NOTES]);
  r.d.session('c1').apps.set('com.apple.notes', { bundleId: 'com.apple.Notes', name: 'Notes', tier: 'bogus' });
  r.d.session('c1').consent = true;
  await rejects(
    r.call('desktop_key', { text: 'a' }),
    'tier',
    /Notes is granted at tier "bogus" \(undefined\), which doesn't allow key \(it is the frontmost app\)\. Notes is never granted more than this, so don't ask the user for more access\.$/m,
  );
});

test('perform: with no frontmost app known the activity bar says "your Mac"', async () => {
  const r = rig();
  await r.ready([NOTES]);
  const s = r.d.session('c1');
  await r.d.perform(
    'c1',
    s,
    'mouse_move',
    {},
    { g: { front: null, allowed: ['com.apple.Notes'], granted: new Map() }, point: { x: 1, y: 2 } },
  );
  assert.equal(r.cu.app, 'your Mac');
  assert.deepEqual(r.callsOf('move')[0].args, [1, 2, { bundleIds: ['com.apple.Notes'] }]);
});

test('serial: one input call at a time across chats, and a failure does not jam the queue', async () => {
  const r = rig();
  const order: string[] = [];
  const a = r.d.serial(async () => {
    order.push('a1');
    await new Promise((res) => setTimeout(res, 5));
    order.push('a2');
    throw new Error('a');
  });
  const b = r.d.serial(async () => {
    order.push('b');
    return 'b';
  });
  await assert.rejects(a, /a/);
  assert.equal(await b, 'b');
  assert.deepEqual(order, ['a1', 'a2', 'b']);
});

/* -- turn end, Esc, forget ------------------------------------------------ */
test('turnEnded: lets go of held keys and buttons and of the desktop, once; then the indicator comes down', async () => {
  const r = rig();
  await r.ready([NOTES]);
  await r.call('desktop_left_click', { coordinate: [1, 1] });
  const s = r.d.session('c1');
  s.held.keys.add('shift');
  s.held.buttons.add('left');
  const epoch = s.epoch;
  await r.d.turnEnded('c1');
  assert.deepEqual(r.callsOf('releaseInput')[0].args, [{ keys: ['shift'], buttons: ['left'] }]);
  assert.equal(s.held.keys.size + s.held.buttons.size, 0);
  assert.equal(s.epoch, epoch + 1, 'a running batch stops');
  assert.deepEqual(r.released, ['c1']);
  assert.equal(r.cu.controlling, null);
  assert.deepEqual(r.ended, ['c1']);
  // idempotent: nothing more to release
  await r.d.turnEnded('c1');
  assert.equal(r.callsOf('releaseInput').length, 1);
  assert.deepEqual(r.ended, ['c1', 'c1']);
  // a stopped (or crashed) helper is relaunched to let go; one that won't start can't, and the rest still runs
  s.held.keys.add('a');
  r.helper.running = false;
  const starts = r.callsOf('start').length;
  await r.d.turnEnded('c1');
  assert.equal(r.callsOf('start').length, starts + 1);
  assert.deepEqual(r.callsOf('releaseInput')[1].args, [{ keys: ['a'], buttons: [] }]);
  s.held.keys.add('b');
  r.helper.fail.start = new Error('no helper');
  await r.d.turnEnded('c1');
  assert.equal(r.callsOf('releaseInput').length, 2);
  assert.equal(s.held.keys.size, 0);
  delete r.helper.fail.start;
  r.helper.running = true;
  s.held.buttons.add('left');
  r.helper.fail.releaseInput = new Error('x');
  r.cu.release = async () => {
    throw new Error('y');
  };
  await r.d.turnEnded('c1');
  // a chat never seen
  await r.d.turnEnded('unknown');
  // a coordinator whose release returns a non-promise value
  r.cu.release = () => undefined;
  await r.d.turnEnded('c1');
  // the default onTurnEnded
  const bare = new DesktopControl({ helper: fakeHelper(), cu: { release: async () => {} }, grants: null, broker: null });
  await bare.turnEnded('c1');
});

test('turnEnded: done within two seconds whatever the helper does', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig();
  r.d.session('c1').held.keys.add('shift');
  r.helper.releaseInput = () => new Promise(() => {});
  let done = false;
  const p = r.d.turnEnded('c1').then(() => {
    done = true;
  });
  await new Promise((res) => setImmediate(res));
  t.mock.timers.tick(1999);
  await new Promise((res) => setImmediate(res));
  assert.equal(done, false);
  t.mock.timers.tick(1);
  await p;
  assert.equal(done, true);
  assert.deepEqual(r.ended, ['c1']);
});

test('forget: an archived or deleted chat lets go of the desktop and loses its grants, consent and frame', async () => {
  const r = rig();
  await r.ready([NOTES]);
  await r.call('desktop_left_click', { coordinate: [1, 1] });
  await r.d.forget('c1');
  assert.equal(r.cu.controlling, null);
  assert.deepEqual(r.ended, ['c1']);
  assert.equal(r.d.sessions.has('c1'), false);
  assert.equal(r.d.granted('c1').size, 0);
  // holding only a key or a button
  r.d.session('c2').held.keys.add('shift');
  await r.d.forget('c2');
  r.d.session('c3').held.buttons.add('left');
  await r.d.forget('c3');
  assert.deepEqual(r.ended, ['c1', 'c2', 'c3']);
  // holding nothing: no release, just forgotten
  r.d.session('c4');
  await r.d.forget('c4');
  await r.d.forget('never');
  await r.d.forget('');
  assert.deepEqual(r.ended, ['c1', 'c2', 'c3']);
  for (const c of ['c2', 'c3', 'c4', 'never']) assert.equal(r.d.sessions.has(c), false, c);
});
