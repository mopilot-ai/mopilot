// electron/capabilities/tools/appScoped.cjs: the background desktop_app_* tools every harness gets, over the fakes of
// tests/support/app-scoped-kit.ts. Covers the specs, the pure helpers, access and modes, per-app locks across chats,
// take-over by the user, Stop and the turn-end release. Captures, actions and batches have their own files
// (appScopedCapture, appScopedActions, appScopedBatch).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SPECS,
  TOOL_NAMES,
  appToolSpecs,
  indexWindowElements,
  elementAt,
  normalizeAppKey,
  keyVerdict,
  appHelperError,
  observedEffect,
  withHint,
  NO_CHANGE_HINT,
  TAKEOVER_WAIT_MS,
  ToolError,
  placement,
  NOTES,
  TERMINAL,
  SAFARI,
  tree,
  helperFailure,
  rig,
  rejects,
  tick,
} from './support/app-scoped-kit.ts';

/* -- specs ------------------------------------------------------------- */
test('specs: the official app_* names on mopilot_computer, plain JSON schema, background wording', () => {
  const specs = appToolSpecs();
  assert.deepEqual(
    specs.map((s: any) => s.name),
    TOOL_NAMES,
  );
  assert.deepEqual(
    TOOL_NAMES.map((n: string) => placement(n, 'sage_x')),
    [
      'list_windows',
      'screenshot',
      'zoom',
      'ax_find',
      'click',
      'type',
      'key',
      'scroll',
      'drag',
      'menu',
      'file_panel',
      'focus',
      'bring_to_current_space',
      'batch',
      'release',
    ].map((n) => ({ server: 'mopilot_computer', name: `app_${n}` })),
  );
  for (const s of specs) {
    assert.equal(s.inputSchema.type, 'object');
    assert.ok(s.name.length <= 64);
  }
  for (const s of SPECS.filter((x: any) => !['desktop_app_release'].includes(x.name))) {
    assert.ok(s.schema.required.includes('app'), s.name);
    assert.match(s.description, /BACKGROUND/);
    assert.match(s.description, /Prefer the desktop_app_\* tools/);
  }
  assert.equal(SPECS.find((s: any) => s.name === 'desktop_app_screenshot').policy, 'observe');
  assert.equal(SPECS.find((s: any) => s.name === 'desktop_app_click').policy, 'act');
  assert.deepEqual(SPECS.find((s: any) => s.name === 'desktop_app_batch').schema.properties.actions.items.properties.action.enum, [
    'click',
    'type',
    'key',
    'scroll',
    'drag',
    'screenshot',
    'zoom',
  ]);
});

test('tools(): registry tools that authorize themselves', async () => {
  const r = rig();
  const tools = r.apps.tools();
  // the desktop_app_* tools, then the script and Shortcuts tools (appScopedScript.cjs)
  assert.equal(tools.length, SPECS.length + 3);
  assert.ok(tools.every((t: any) => t.authorizesItself === true));
  const release = tools.find((t: any) => t.name === 'desktop_app_release');
  assert.deepEqual(JSON.parse((await release.handler(undefined, { chatId: 'c1' }))[0].text), { released: [], held: [] });
});

/* -- pure helpers ------------------------------------------------------ */
test('indexWindowElements: listed roles with a label (or actionable), inside the window frame, centers in frame pixels', () => {
  const geom = { x: 100, y: 50, ppp: 2, width: 1000, height: 800 };
  const els = indexWindowElements(tree(), geom);
  assert.deepEqual(
    els.map((e: any) => [e.index, e.role, e.label]),
    [
      [1, 'AXButton', 'Send'],
      [2, 'AXTextArea', 'draft'],
      [3, 'AXPopUpButton', 'Font'],
      [4, 'AXTextField', ''],
      [5, 'AXScrollArea', ''],
      [6, 'AXCheckBox', 'Bold'],
      [7, 'AXButton', 'Plain'],
      [8, 'AXStaticText', 'x'.repeat(100)],
    ],
  );
  assert.deepEqual(els[0].center, { x: 60, y: 40 });
  assert.deepEqual(els[0].actions, ['AXPress']);
  assert.deepEqual(els[3].actions, []);
  assert.equal(els[3].secure, true);
  assert.equal(els[1].focused, true);
  assert.equal(els[5].enabled, false);
  assert.deepEqual(indexWindowElements(null, geom), []);
  assert.deepEqual(
    indexWindowElements({ root: { role: 'AXButton', title: 'x', frame: { x: 100, y: 50, w: 10, h: 10 }, children: 'no' } }, geom).length,
    1,
  );
  // elementAt: the smallest frame holding a point, or null
  assert.equal(elementAt(els, { x: 120, y: 65 }).label, 'Send');
  assert.equal(elementAt(els, { x: 300, y: 200 }).role, 'AXTextArea');
  assert.equal(elementAt(els, { x: 5000, y: 5000 }), null);
});

test('normalizeAppKey and keyVerdict: del is backspace; menu shortcuts and system combos are refused', () => {
  assert.equal(normalizeAppKey('del'), 'delete');
  assert.equal(normalizeAppKey('shift+Del'), 'shift+delete');
  assert.equal(normalizeAppKey('forward_delete'), 'forwarddelete');
  assert.equal(normalizeAppKey('Return'), 'return');
  assert.equal(normalizeAppKey(undefined), '');
  assert.equal(keyVerdict('').code, 'bad_args');
  assert.equal(keyVerdict('cmd+q').code, 'unsupported');
  assert.match(keyVerdict('cmd+tab').message, /whole Mac.*display-scope desktop_key/);
  assert.equal(keyVerdict('cmd+a'), null);
  assert.equal(keyVerdict('return'), null);
  assert.equal(keyVerdict('cmd+up'), null);
  assert.equal(keyVerdict('shift+cmd+down'), null);
  assert.equal(keyVerdict('tab'), null);
  assert.equal(keyVerdict('alt+left'), null);
  assert.match(keyVerdict('cmd+s').message, /unsupported\(use_app_menu\)/);
  assert.equal(keyVerdict('ctrl+k').code, 'unsupported');
});

test('appHelperError: helper reasons become what the model should do next', () => {
  const t = new ToolError('x', 'bad_args');
  assert.equal(appHelperError(t), t);
  assert.equal(appHelperError(helperFailure('unsupported', 'unsupported(menu): m')).code, 'unsupported');
  assert.match(appHelperError(helperFailure('not_running')).message, /desktop_open_application/);
  assert.equal(appHelperError(helperFailure('window_gone')).code, 'changed');
  assert.equal(appHelperError(helperFailure('element_gone', 'element 0.1 is gone')).message, 'element 0.1 is gone');
  assert.match(appHelperError(helperFailure('method_not_found')).message, /out of date/);
  assert.match(appHelperError(helperFailure('no_windows')).message, /no window/);
  assert.equal(appHelperError(helperFailure('target_refused', 'refused: target is MoPilot')).code, 'refused');
  assert.equal(appHelperError(helperFailure('permission_denied', 'accessibility permission not granted')).code, 'permission');
});

/* -- access ------------------------------------------------------------ */
test('access: only granted, running apps; tiers cap what each action may do', async () => {
  const r = rig({
    saved: [
      { bundleId: NOTES.bundleId, name: 'Notes', level: 'full' },
      { bundleId: TERMINAL.bundleId, name: 'Terminal', level: 'full' },
      { bundleId: SAFARI.bundleId, name: 'Safari', level: 'full' },
      { bundleId: 'com.ghost', name: 'Ghost', level: 'full' },
    ],
  });
  await rejects(
    r.call('desktop_app_screenshot', { app: 'com.apple.mail' }),
    'denied',
    /isn't granted in this chat; call desktop_request_access/,
  );
  await rejects(r.call('desktop_app_screenshot', {}), 'denied', /That app isn't granted/);
  await rejects(r.call('desktop_app_screenshot', { app: 'Ghost' }), 'unavailable', /Ghost isn't running/);
  const running = r.helper.apps;
  r.helper.apps = undefined;
  await rejects(r.call('desktop_app_screenshot', { app: 'Notes' }), 'unavailable', /Notes isn't running/);
  r.helper.apps = running;
  // by name works as well as by bundle id
  assert.equal((await r.call('desktop_app_screenshot', { app: 'notes' }))[0].type, 'image');
  // Safari is view only: screenshots yes, clicks no
  await r.shoot('com.apple.Safari');
  await rejects(r.call('desktop_app_click', { app: 'Safari', coordinate: [10, 10] }), 'tier', /tier "read".*browser tools/);
  await rejects(r.call('desktop_app_menu', { app: 'Safari', path: ['File', 'New Window'] }), 'tier', /menu commands/);
  // Terminal clicks and scrolls, but doesn't type, press keys, drag or right/modifier-click
  await r.shoot('com.apple.Terminal');
  assert.equal((await r.record('desktop_app_click', { app: 'Terminal', element_index: 1 })).effect, 'confirmed');
  await rejects(r.call('desktop_app_type', { app: 'Terminal', element_index: 2, text: 'ls' }), 'tier', /typing.*shell tool/);
  await rejects(r.call('desktop_app_key', { app: 'Terminal', combo: 'return' }), 'tier', /keys/);
  await rejects(r.call('desktop_app_click', { app: 'Terminal', element_index: 1, modifiers: 'cmd' }), 'tier', /right or modifier clicks/);
  await rejects(r.call('desktop_app_drag', { app: 'Terminal', coordinate: [1, 1], to_coordinate: [2, 2] }), 'tier', /dragging/);
  // the helper is restricted to the app on every call
  assert.deepEqual(r.last('app.press').bundleIds, ['com.apple.Terminal']);
  assert.equal(r.last('app.press').pid, 9);
});

test('a scheduled task with computer control off, a read-only mode and nobody there stop input; observing still works', async () => {
  const r = rig();
  await r.shoot();
  r.state.session = { permission: 'plan' };
  await rejects(r.call('desktop_app_click', { app: 'Notes', element_index: 1 }), 'read_only', /read-only/);
  assert.equal((await r.call('desktop_app_screenshot', { app: 'Notes' }))[0].type, 'image');
  r.state.session = { permission: 'default', scheduled: { computer: false } };
  await rejects(r.call('desktop_app_screenshot', { app: 'Notes' }), 'refused', /scheduled task/);
  r.state.session = undefined;
  assert.equal((await r.record('desktop_app_click', { app: 'Notes', element_index: 7 })).route, 'pid');
  r.state.session = {};
  r.state.unattended = 'a scheduled task';
  r.state.unattendedAllowed = false;
  await rejects(r.call('desktop_app_click', { app: 'Notes', element_index: 1 }), 'unattended', /switched off \(a scheduled task\)/);
  assert.equal(r.paused[0].tool, 'desktop_app_input');
  assert.equal(r.paused[0].app.bundleId, 'com.apple.Notes');
  // allowed while nobody is there: no takeover card, the action runs
  r.state.unattendedAllowed = true;
  assert.equal((await r.record('desktop_app_click', { app: 'Notes', element_index: 7 })).route, 'pid');
  assert.equal(r.asks.length, 0, 'no takeover card for background control');
});

test('a missing permission raises the permission card through DesktopControl', async () => {
  const r = rig();
  r.helper.fail['app.screenshot'] = helperFailure('permission_denied', 'screenRecording permission not granted');
  await rejects(r.call('desktop_app_screenshot', { app: 'Notes' }), 'permission', /Screen Recording/);
  assert.equal(r.activity.at(-1)[1].state, 'permission');
  assert.ok(r.cu.blocked.has('c1'));
});

test('locks: one chat per app at a time; different chats in different apps; display-scope control excludes others; release and turn end', async () => {
  const r = rig();
  await r.shoot('com.apple.Notes', 'c1');
  await r.shoot('com.apple.mail', 'c2');
  await r.call('desktop_app_click', { app: 'Notes', element_index: 7 }, { chatId: 'c1' });
  // c2 works in Mail at the same time
  await r.call('desktop_app_click', { app: 'Mail', element_index: 7 }, { chatId: 'c2' });
  // but not in Notes while c1 holds it; observing is fine
  await r.shoot('com.apple.Notes', 'c2');
  await rejects(
    r.call('desktop_app_click', { app: 'Notes', element_index: 7 }, { chatId: 'c2' }),
    'busy',
    /Another chat is working in Notes/,
  );
  // what display-scope control asks before acting in an app
  assert.equal(r.apps.lockedBy('COM.APPLE.NOTES', 'c2'), 'c1');
  assert.equal(r.apps.lockedBy('com.apple.Notes', 'c1'), null);
  assert.equal(r.apps.lockedBy('com.apple.TextEdit', 'c2'), null);
  assert.equal(r.apps.lockedBy(undefined, 'c2'), null);
  // what a person's Esc stops besides the chat holding the screen: each chat working in an app, once
  assert.deepEqual(r.apps.workingChats().sort(), ['c1', 'c2']);
  await rejects(r.call('desktop_app_menu', { app: 'Notes', path: ['File', 'New'] }, { chatId: 'c2' }), 'busy');
  // c1 releases Notes window 99 only (it holds window 5): still held; then the app
  assert.deepEqual(JSON.parse(await r.text('desktop_app_release', { app: 'Notes', window_id: 99 })), { released: [], held: ['Notes'] });
  assert.deepEqual(JSON.parse(await r.text('desktop_app_release', { app: 'com.apple.Notes', window_id: 5 })), {
    released: ['Notes'],
    held: [],
  });
  await r.call('desktop_app_click', { app: 'Notes', element_index: 7 }, { chatId: 'c2' });
  assert.deepEqual(JSON.parse(await r.text('desktop_app_release', { app: 'Unknown.App' }, { chatId: 'c2' })), {
    released: [],
    held: ['Mail', 'Notes'],
  });
  // a chat holding the whole screen excludes everyone else's background input, not its own
  r.cu.controlling = 'c3';
  await rejects(r.call('desktop_app_click', { app: 'Mail', element_index: 7 }, { chatId: 'c2' }), 'busy', /taken over the screen/);
  await r.shoot('com.apple.Terminal', 'c3');
  await r.call('desktop_app_click', { app: 'Terminal', element_index: 7 }, { chatId: 'c3' });
  r.cu.controlling = null;
  // the turn ends: c2's locks go; forget drops the session too
  r.apps.turnEnded('c2');
  assert.deepEqual(JSON.parse(await r.text('desktop_app_release', {}, { chatId: 'c2' })), { released: [], held: [] });
  r.apps.forget('c3');
  assert.equal(r.apps.sessions.has('c3'), false);
  assert.equal(r.apps.locks.size, 0);
  r.apps.interrupt('nobody');
  // releasing everything
  await r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  await r.call('desktop_app_click', { app: 'com.apple.Terminal', target: 'focused' });
  assert.deepEqual(JSON.parse(await r.text('desktop_app_release', {})).released.sort(), ['Notes', 'Terminal']);
});

/* -- verification -------------------------------------------------------- */

test('observedEffect and withHint: what the helper saw decides the effect; no change brings a hint instead of a retry', () => {
  assert.deepEqual(observedEffect('unverifiable', undefined), { effect: 'unverifiable' });
  assert.deepEqual(observedEffect('unverifiable', 'confirmed'), { effect: 'unverifiable' });
  assert.deepEqual(observedEffect('unverifiable', { effect: 'maybe' }), { effect: 'unverifiable' });
  assert.deepEqual(observedEffect('unverifiable', { effect: 'confirmed', evidence: ['pixels_changed'], settleMs: 120 }), {
    effect: 'confirmed',
    evidence: ['pixels_changed'],
    settle_ms: 120,
  });
  assert.deepEqual(observedEffect('confirmed', { effect: 'no_change', evidence: [] }), { effect: 'no_change' });
  assert.deepEqual(observedEffect('confirmed', { effect: 'unverifiable', settleMs: 5 }), { effect: 'confirmed', settle_ms: 5 });
  // an accessibility write the app refused stays ineffective whatever else changed
  assert.deepEqual(observedEffect('ineffective', { effect: 'confirmed', evidence: ['focus_changed'], settleMs: 'x' }), {
    effect: 'ineffective',
    evidence: ['focus_changed'],
  });
  assert.equal(withHint({ action: 'click', effect: 'no_change' }).hint, NO_CHANGE_HINT.click);
  assert.equal(withHint({ action: 'type', effect: 'ineffective' }).hint, NO_CHANGE_HINT.type);
  for (const r of [
    { action: 'focus', effect: 'ineffective', reason: 'why' },
    { action: 'click', effect: 'confirmed' },
    { action: 'menu', effect: 'no_change' },
  ])
    assert.deepEqual(withHint(r), r);
  assert.equal(TAKEOVER_WAIT_MS, 600_000);
});

test('appHelperError: a dialog over the point and a resized window are changes to look at again', () => {
  assert.equal(appHelperError(helperFailure('occluded')).code, 'changed');
  assert.match(appHelperError(helperFailure('occluded')).message, /dialog or sheet\) covers that point.*element_index/);
  assert.equal(appHelperError(helperFailure('window_changed')).code, 'changed');
  assert.match(appHelperError(helperFailure('window_changed')).message, /resized since your latest desktop_app_screenshot/);
});

/* -- take over ------------------------------------------------------------ */
test('take over: the user takes an app from the chat; its input there waits for the hand back; Stop and an abort end the wait', async () => {
  // a cap far above any wait here, so a slow machine can't end a wait the hand back should end (the cap has its own test)
  const r = rig({ apps: { takeoverWaitMs: 10_000 } });
  await r.shoot();
  // only an app the chat holds
  assert.equal(r.apps.takeOver('c1', 'com.apple.Notes'), false);
  assert.equal(r.apps.takeOver('c1', ''), false);
  assert.equal(r.apps.takeOver('c1', undefined), false);
  await r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  assert.equal(r.apps.takeOver('c2', 'com.apple.Notes'), false);
  assert.equal(r.apps.takeOver('c1', 'COM.APPLE.NOTES'), true);
  assert.equal(r.apps.takeOver('c1', 'com.apple.Notes'), true, 'taking it again keeps it');
  assert.deepEqual(
    [r.apps.takenOver('c1', 'com.apple.Notes'), r.apps.takenOver('c2', 'com.apple.Notes'), r.apps.takenOver('c1', null)],
    [true, false, false],
  );
  // input waits; looking does not
  const n = r.callsOf('app.click').length;
  const waiting = r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  await tick();
  assert.equal(r.callsOf('app.click').length, n);
  assert.equal((await r.call('desktop_app_screenshot', { app: 'Notes' }))[0].type, 'image');
  // another chat's Stop doesn't end it, nor does a hand back from the wrong chat or app
  r.apps.interrupt('c2');
  assert.equal(r.apps.handBack('c2', 'com.apple.Notes'), false);
  assert.equal(r.apps.handBack('c1', 'com.apple.mail'), false);
  assert.equal(r.apps.handBack('c1', 'com.apple.Notes'), true);
  await waiting;
  assert.equal(r.callsOf('app.click').length, n + 1);
  // Stop
  r.apps.takeOver('c1', 'com.apple.Notes');
  const stopped = r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  await tick();
  r.apps.interrupt('c1');
  await rejects(stopped, 'refused', /Stopped by the user/);
  // an aborted call, during the wait or before it
  const ac = new AbortController();
  const aborted = r.call('desktop_app_click', { app: 'Notes', element_index: 7 }, { chatId: 'c1', signal: ac.signal });
  await tick();
  ac.abort();
  await rejects(aborted, 'refused', /Stopped/);
  await rejects(r.call('desktop_app_click', { app: 'Notes', element_index: 7 }, { chatId: 'c1', signal: ac.signal }), 'refused', /Stopped/);
  // a batch waits too, after what came before has run
  const batch = r.call('desktop_app_batch', { app: 'Notes', actions: [{ action: 'click', element_index: 7 }] });
  await tick();
  r.apps.handBack('c1', 'com.apple.Notes');
  assert.equal(JSON.parse((await batch)[0].text).completed, 1);
  // the turn ends: the take-over goes with the locks
  await r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  r.apps.takeOver('c1', 'com.apple.Notes');
  r.apps.turnEnded('c1');
  assert.equal(r.apps.held.size, 0);
});

test('take over: input that waits longer than the cap is refused as busy', async () => {
  const r = rig({ apps: { takeoverWaitMs: 30 } });
  await r.shoot();
  await r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  assert.equal(r.apps.takeOver('c1', 'com.apple.Notes'), true);
  await rejects(r.call('desktop_app_menu', { app: 'Notes', path: ['File', 'New'] }), 'busy', /took over Notes and hasn't handed it back/);
  await rejects(r.call('desktop_app_bring_to_current_space', { app: 'Notes', window_id: 5 }), 'busy');
  r.apps.turnEnded('c1');
});
