// electron/capabilities/tools/appScopedActions.cjs: targets, clicks, typing, keys, scrolls, drags and focus in the
// background, their AX-first routes and pid fallbacks, confirmation, and the verified effect each record reports.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defined } from './support/defined.ts';
import { NO_CHANGE_HINT, WIN, helperFailure, rig, rejects } from './support/app-scoped-kit.ts';

/* -- click -------------------------------------------------------------- */
test('click: an element presses through accessibility; a coordinate hits the element there; else a click to the app process', async () => {
  const r = rig();
  await rejects(r.call('desktop_app_click', { app: 'Notes', coordinate: [1, 1] }), 'bad_args', /screenshot of Notes first/);
  await r.shoot();
  const byIndex = await r.record('desktop_app_click', { app: 'Notes', element_index: 1 });
  assert.deepEqual(byIndex, { action: 'click', effect: 'confirmed', route: 'ax', app: 'Notes', window_id: 5, element: 1, label: 'Send' });
  assert.deepEqual(r.last('app.press'), {
    pid: 7,
    bundleIds: ['com.apple.Notes'],
    windowId: 5,
    id: '0.0',
    expectElement: { role: 'AXButton', title: 'Send' },
    action: 'AXPress',
    fallbackClick: { x: 130, y: 70 },
    expectBounds: WIN.bounds,
    verify: true,
    settleCapMs: 600,
  });
  // a coordinate on the Send button presses it too
  assert.equal((await r.record('desktop_app_click', { app: 'Notes', coordinate: [60, 40] })).route, 'ax');
  // an element without a press action (or a failed press) gets a click posted to the app at its center
  const plain = await r.record('desktop_app_click', { app: 'Notes', element_index: 7 });
  assert.deepEqual([plain.effect, plain.route, plain.element, plain.label], ['unverifiable', 'pid', 7, 'Plain']);
  assert.deepEqual(r.last('app.click'), {
    pid: 7,
    bundleIds: ['com.apple.Notes'],
    windowId: 5,
    x: 220,
    y: 340,
    button: 'left',
    count: 1,
    expectBounds: WIN.bounds,
    verify: true,
    settleCapMs: 600,
  });
  // an element with no title or description (a text area known by its value) has no label in the record
  assert.equal((await r.record('desktop_app_click', { app: 'Notes', element_index: 2 })).label, undefined);
  r.helper.answers['app.press'] = () => ({ ok: false });
  assert.equal((await r.record('desktop_app_click', { app: 'Notes', element_index: 1 })).route, 'pid');
  // a double click with modifiers on empty space
  const dbl = await r.record('desktop_app_click', { app: 'Notes', coordinate: [990, 790], count: 2, modifiers: 'Command' });
  assert.equal(dbl.element, undefined);
  assert.deepEqual(
    [r.last('app.click').count, r.last('app.click').modifiers, r.last('app.click').x, r.last('app.click').y],
    [2, 'cmd', 595, 445],
  );
  // count is clamped; coordinate-less clicks reuse the last point
  await r.call('desktop_app_click', { app: 'Notes', count: 9 });
  assert.deepEqual([r.last('app.click').count, r.last('app.click').x], [3, 595]);
  await r.call('desktop_app_click', { app: 'Notes', count: 'x' });
  assert.equal(r.last('app.click').count, 1);
});

test('click: target focused presses the focused element, or clicks its center; menus and right clicks are unsupported', async () => {
  const r = rig();
  // focused needs no screenshot
  assert.deepEqual(await r.record('desktop_app_click', { app: 'Notes', target: 'focused' }), {
    action: 'click',
    effect: 'confirmed',
    route: 'ax',
    app: 'Notes',
    target: 'focused',
  });
  assert.equal(r.last('app.press').focused, true);
  r.helper.answers['app.press'] = () => ({ ok: false, center: { x: 0, y: 9 } });
  assert.equal((await r.record('desktop_app_click', { app: 'Notes', target: 'focused' })).route, 'pid');
  assert.deepEqual([r.last('app.click').x, r.last('app.click').y], [0, 9]);
  r.helper.answers['app.press'] = () => ({ ok: false });
  await rejects(r.call('desktop_app_click', { app: 'Notes', target: 'focused' }), 'unsupported', /unsupported\(no_press\)/);
  await rejects(r.call('desktop_app_click', { app: 'Notes', target: 'focused', count: 2 }), 'unsupported', /unsupported\(focused\)/);
  await r.shoot();
  await rejects(r.call('desktop_app_click', { app: 'Notes', element_index: 3 }), 'unsupported', /unsupported\(menu\).*desktop_app_menu/);
  const right = r.call('desktop_app_click', { app: 'Notes', element_index: 1, button: 'right' });
  await rejects(right, 'unsupported', /unsupported\(context_menu\)/);
  // the refusal carries the action record
  await assert.rejects(
    r.call('desktop_app_click', { app: 'Notes', element_index: 1, button: 'right' }),
    (e: any) => e.record.effect === 'unsupported' && e.record.route === 'none' && /"effect":"unsupported"/.test(e.message),
  );
  await assert.rejects(
    r.call('desktop_app_click', { app: 'Notes', element_index: 99 }),
    (e: any) => e.code === 'bad_args' && e.record.effect === 'refused' && /No element \[99\]/.test(e.message),
  );
});

test('targets: one of coordinate, element_index and target; coordinates inside the frame', async () => {
  const r = rig();
  await r.shoot();
  await rejects(
    r.call('desktop_app_click', { app: 'Notes', coordinate: [1, 1], element_index: 1 }),
    'bad_args',
    /not coordinate and element_index/,
  );
  await rejects(r.call('desktop_app_click', { app: 'Notes', target: 'other' }), 'bad_args', /target must be "focused"/);
  await rejects(r.call('desktop_app_click', { app: 'Notes', coordinate: [1] }), 'bad_args', /coordinate must be \[x, y\]/);
  await rejects(r.call('desktop_app_click', { app: 'Notes', coordinate: [1000, 1] }), 'bad_args', /outside the 1000x800 window frame/);
  await rejects(r.call('desktop_app_click', { app: 'Notes', coordinate: [-1, 1] }), 'bad_args', /outside/);
  await rejects(r.call('desktop_app_click', { app: 'Notes', coordinate: [1, -1] }), 'bad_args', /outside/);
  await rejects(r.call('desktop_app_click', { app: 'Notes', coordinate: [1, 800] }), 'bad_args', /outside/);
  await rejects(r.call('desktop_app_click', { app: 'Notes' }), 'bad_args', /Give coordinate, element_index or target/);
  await rejects(r.call('desktop_app_click', { app: 'Notes', window_id: 42, coordinate: [1, 1] }), 'bad_args', /screenshot of Notes first/);
});

/* -- type, key, scroll, drag, focus ------------------------------------- */
test('type: text fields only, through accessibility; focused for canvas apps; overwrite and replace pass through', async () => {
  const r = rig();
  await r.shoot();
  const out = await r.record('desktop_app_type', { app: 'Notes', element_index: 2, text: 'héllo 👋' });
  assert.deepEqual(out, { action: 'type', effect: 'confirmed', route: 'ax', app: 'Notes', window_id: 5, characters: 7, element: 2 });
  assert.deepEqual(r.last('app.setText'), {
    pid: 7,
    bundleIds: ['com.apple.Notes'],
    windowId: 5,
    id: '0.1',
    expectElement: { role: 'AXTextArea' },
    text: 'héllo 👋',
    mode: 'insert',
    overwrite: false,
    verify: true,
    settleCapMs: 600,
  });
  assert.equal(r.callsOf('app.setText').at(-1).opts.timeoutMs, 120000);
  // type follows a click on the field without repeating the point
  await r.call('desktop_app_click', { app: 'Notes', coordinate: [400, 300] });
  r.helper.answers['app.setText'] = () => ({ ok: true, effect: 'confirmed', previous: 'draft' });
  const replaced = await r.record('desktop_app_type', {
    app: 'Notes',
    text: 'new',
    mode: 'replace',
    overwrite_existing: true,
    disable_substitutions: true,
  });
  assert.equal(replaced.previous, 'draft');
  assert.equal(replaced.route, 'ax');
  assert.deepEqual([r.last('app.setText').mode, r.last('app.setText').overwrite, r.last('app.setText').id], ['replace', true, '0.1']);
  // the focused element, keystrokes allowed as a last resort
  r.helper.answers['app.setText'] = () => ({ ok: true, route: 'pid' });
  const focused = await r.record('desktop_app_type', { app: 'Notes', target: 'focused', text: 'x' });
  assert.deepEqual([focused.effect, focused.route, focused.element], ['unverifiable', 'pid', undefined]);
  assert.deepEqual([r.last('app.setText').focused, r.last('app.setText').allowKeys], [true, true]);
  // a button, empty space or a password field: refused
  await rejects(
    r.call('desktop_app_type', { app: 'Notes', element_index: 1, text: 'x' }),
    'unsupported',
    /unsupported\(not_text\): \[1\] Button/,
  );
  await rejects(r.call('desktop_app_type', { app: 'Notes', coordinate: [990, 790], text: 'x' }), 'unsupported', /nothing at that point/);
  await rejects(r.call('desktop_app_type', { app: 'Notes', element_index: 4, text: 'x' }), 'refused', /password/);
  await rejects(r.call('desktop_app_type', { app: 'Notes', element_index: 2, text: 'x'.repeat(20001) }), 'bad_args', /At most 20000/);
  // the helper's own refusal (would replace content) comes back as unsupported
  r.helper.fail['app.setText'] = helperFailure('unsupported', 'unsupported(would_replace_content): pass overwrite_existing');
  await rejects(r.call('desktop_app_type', { app: 'Notes', element_index: 2, text: 'x' }), 'unsupported', /would_replace_content/);
});

test('type and key: Return in a messaging app, cmd+delete and flagged actions are confirmed first', async () => {
  const r = rig();
  await r.shoot('com.apple.mail');
  await r.call('desktop_app_type', { app: 'Mail', element_index: 2, text: 'hi\n' });
  assert.equal(r.asks.length, 1);
  assert.deepEqual(
    [r.asks[0].kind, r.asks[0].params.verb, r.asks[0].params.tool, r.asks[0].params.app.name],
    ['computerConfirm', 'send', 'desktop_app_type', 'Mail'],
  );
  await r.call('desktop_app_key', { app: 'Mail', element_index: 2, combo: 'Return' });
  assert.equal(defined(r.asks.at(-1)).params.summary, 'press Return');
  // a click on Send is confirmed by its label; the user says no
  r.answers.computerConfirm = { decision: 'deny' };
  await rejects(r.call('desktop_app_click', { app: 'Mail', element_index: 1 }), 'denied', /didn't confirm: send in Mail/);
  r.answers.computerConfirm = { decision: 'allow' };
  // flagged by the model
  await r.call('desktop_app_scroll', { app: 'Mail', element_index: 2, dy: 1, irreversible: true });
  assert.equal(defined(r.asks.at(-1)).params.verb, 'do this');
  await r.call('desktop_app_drag', {
    app: 'Mail',
    coordinate: [1, 1],
    to_coordinate: [5, 5],
    irreversible: true,
    action_summary: 'Moves the mail',
  });
  assert.equal(defined(r.asks.at(-1)).params.summary, 'Moves the mail');
  // nobody there to confirm: refused, the chat pauses
  r.state.unattended = 'a turn MoPilot started';
  await rejects(r.call('desktop_app_key', { app: 'Mail', combo: 'cmd+delete' }), 'unsupported', /use_app_menu/);
  await rejects(
    r.call('desktop_app_key', { app: 'Mail', element_index: 2, combo: 'return' }),
    'unattended',
    /can't be undone.*nobody is here/,
  );
  assert.equal(r.paused.at(-1).tool, 'desktop_app_key');
});

test('key: the AX route or a keystroke to the app; refusals for menu shortcuts and whole-Mac combos', async () => {
  const r = rig();
  await r.shoot();
  const out = await r.record('desktop_app_key', { app: 'Notes', element_index: 2, combo: 'del' });
  assert.deepEqual(out, { action: 'key', effect: 'unverifiable', route: 'pid', app: 'Notes', window_id: 5, keys: 'delete' });
  assert.deepEqual(r.last('app.key'), {
    pid: 7,
    bundleIds: ['com.apple.Notes'],
    windowId: 5,
    combo: 'delete',
    id: '0.1',
    expectElement: { role: 'AXTextArea' },
    verify: true,
    settleCapMs: 600,
  });
  r.helper.answers['app.key'] = () => ({ ok: true, route: 'ax', action: 'AXConfirm' });
  const confirm = await r.record('desktop_app_key', { app: 'Notes', target: 'focused', combo: 'enter' });
  assert.deepEqual(
    [confirm.effect, confirm.route, confirm.via, r.last('app.key').focused, r.last('app.key').combo],
    ['confirmed', 'ax', 'AXConfirm', true, 'return'],
  );
  r.helper.answers['app.key'] = () => ({ ok: false });
  const nothing = await r.record('desktop_app_key', { app: 'Notes', coordinate: [990, 790], combo: 'tab' });
  assert.deepEqual([nothing.effect, nothing.route, r.last('app.key').id], ['ineffective', 'pid', undefined]);
  await rejects(r.call('desktop_app_key', { app: 'Notes', combo: 'cmd+s' }), 'unsupported', /desktop_app_menu/);
  await rejects(r.call('desktop_app_key', { app: 'Notes', combo: 'cmd+q' }), 'unsupported', /whole Mac/);
  await rejects(r.call('desktop_app_key', { app: 'Notes', combo: ' ' }), 'bad_args', /Name a key/);
});

test('scroll: through the scroll bar when the element has one, else a wheel event to the app', async () => {
  const r = rig();
  await r.shoot();
  const ax = await r.record('desktop_app_scroll', { app: 'Notes', element_index: 2, dy: 3 });
  assert.deepEqual([ax.effect, ax.route, ax.dy], ['confirmed', 'ax', 3]);
  assert.deepEqual(r.last('app.scroll'), {
    pid: 7,
    bundleIds: ['com.apple.Notes'],
    windowId: 5,
    id: '0.1',
    expectElement: { role: 'AXTextArea' },
    x: 300,
    y: 200,
    dy: 3,
    expectBounds: WIN.bounds,
    verify: true,
    settleCapMs: 600,
  });
  r.helper.answers['app.scroll'] = () => ({ ok: true, route: 'pid', saturated: true });
  const wheel = await r.record('desktop_app_scroll', { app: 'Notes', coordinate: [990, 790], dy: -2 });
  assert.deepEqual([wheel.effect, wheel.route, wheel.note], ['unverifiable', 'pid', 'reached the end of the scroll range']);
  assert.equal(r.last('app.scroll').id, undefined);
  r.helper.answers['app.scroll'] = () => ({ ok: true });
  assert.equal((await r.record('desktop_app_scroll', { app: 'Notes', dy: 1 })).route, 'pid');
  await rejects(r.call('desktop_app_scroll', { app: 'Notes', element_index: 2, dy: 0 }), 'bad_args', /non-zero/);
  await rejects(r.call('desktop_app_scroll', { app: 'Notes', target: 'focused', dy: 1 }), 'bad_args', /coordinate or element_index/);
});

test('drag: a line or a path, every point inside the frame, sent in global points', async () => {
  const r = rig();
  await rejects(
    r.call('desktop_app_drag', { app: 'Notes', coordinate: [1, 1], to_coordinate: [2, 2] }),
    'bad_args',
    /drag points are of the latest screenshot/,
  );
  await r.shoot();
  const out = await r.record('desktop_app_drag', { app: 'Notes', coordinate: [0, 0], to_coordinate: [200, 100] });
  assert.deepEqual([out.effect, out.route, out.points], ['unverifiable', 'pid', 2]);
  assert.deepEqual(r.last('app.drag').points, [
    [100, 50],
    [200, 100],
  ]);
  await r.call('desktop_app_drag', {
    app: 'Notes',
    path: [
      [0, 0],
      [2, 2],
      [4, 4],
    ],
  });
  assert.equal(r.last('app.drag').points.length, 3);
  await rejects(
    r.call('desktop_app_drag', {
      app: 'Notes',
      path: [
        [0, 0],
        [1, 1],
      ],
      coordinate: [1, 1],
    }),
    'bad_args',
    /not both/,
  );
  await rejects(r.call('desktop_app_drag', { app: 'Notes', path: [[0, 0]] }), 'bad_args', /2 to 20/);
  await rejects(r.call('desktop_app_drag', { app: 'Notes', path: Array.from({ length: 21 }, () => [1, 1]) }), 'bad_args', /2 to 20/);
  await rejects(r.call('desktop_app_drag', { app: 'Notes', coordinate: [1, 1] }), 'bad_args', /drag point 2 must be/);
  await rejects(r.call('desktop_app_drag', { app: 'Notes', coordinate: [1, 1], to_coordinate: [1, 900] }), 'bad_args', /outside/);
});

test('focus: moves keyboard focus to an element; says when it did not move', async () => {
  const r = rig();
  await r.shoot();
  assert.deepEqual(await r.record('desktop_app_focus', { app: 'Notes', element_index: 2 }), {
    action: 'focus',
    effect: 'confirmed',
    route: 'ax',
    app: 'Notes',
    window_id: 5,
    element: 2,
  });
  assert.equal(r.last('app.focus').id, '0.1');
  r.helper.answers['app.focus'] = () => ({ ok: true, moved: false });
  const stuck = await r.record('desktop_app_focus', { app: 'Notes' });
  assert.equal(stuck.effect, 'ineffective');
  assert.match(stuck.reason, /another of its windows/);
  await rejects(r.call('desktop_app_focus', { app: 'Notes', target: 'focused' }), 'bad_args', /coordinate or element_index/);
  await rejects(r.call('desktop_app_focus', { app: 'Notes', coordinate: [990, 790] }), 'bad_args', /No element at that point/);
  r.helper.fail['app.focus'] = helperFailure('unsupported', 'unsupported(frontmost): the user is working in this app');
  await rejects(r.call('desktop_app_focus', { app: 'Notes', element_index: 2 }), 'unsupported', /frontmost/);
});

test('verification: the record says what changed; no change brings a hint; a window that moved takes its frame and elements along', async () => {
  const r = rig();
  await r.shoot();
  r.helper.answers['app.click'] = () => ({ ok: true, route: 'pid', verify: { effect: 'no_change', evidence: [], settleMs: 180 } });
  const still = await r.record('desktop_app_click', { app: 'Notes', element_index: 7 });
  assert.deepEqual([still.effect, still.settle_ms, still.hint], ['no_change', 180, NO_CHANGE_HINT.click]);
  // the window moved 10 points right and 5 up since the screenshot: the helper moved the point; so does the frame
  r.helper.answers['app.click'] = () => ({
    ok: true,
    route: 'pid',
    moved: { dx: 10, dy: -5 },
    verify: { effect: 'confirmed', evidence: ['window_opened'], settleMs: 90 },
  });
  const moved = await r.record('desktop_app_click', { app: 'Notes', element_index: 7 });
  assert.deepEqual(
    [moved.effect, moved.evidence, moved.note],
    ['confirmed', ['window_opened'], 'the window had moved since the screenshot; the point moved with it'],
  );
  r.helper.answers['app.click'] = () => ({ ok: true, route: 'pid', moved: { dx: 0, dy: 0 } });
  assert.equal((await r.record('desktop_app_click', { app: 'Notes', coordinate: [990, 790] })).note, undefined);
  assert.deepEqual(
    [r.last('app.click').x, r.last('app.click').y, r.last('app.click').expectBounds],
    [605, 440, { x: 110, y: 45, width: 500, height: 400 }],
  );
  await r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  assert.deepEqual([r.last('app.click').x, r.last('app.click').y], [230, 335]);
  // a dialog of the app over the point, or a resized window: refused before anything is posted
  r.helper.fail['app.click'] = helperFailure('occluded');
  await rejects(r.call('desktop_app_click', { app: 'Notes', element_index: 7 }), 'changed', /dialog or sheet/);
  r.helper.fail['app.click'] = helperFailure('window_changed');
  await rejects(r.call('desktop_app_click', { app: 'Notes', element_index: 7 }), 'changed', /resized/);
  delete r.helper.fail['app.click'];
  // a press the helper turned into a click (the element can't be pressed): posted, verified like a click
  r.helper.answers['app.press'] = () => ({
    ok: true,
    route: 'pid',
    fallback: true,
    verify: { effect: 'confirmed', evidence: ['pixels_changed'] },
  });
  const fell = await r.record('desktop_app_click', { app: 'Notes', element_index: 1 });
  assert.deepEqual([fell.route, fell.effect, fell.label], ['pid', 'confirmed', 'Send']);
  // the focused element: no frame to move without a screenshot, nor a last point with one
  r.helper.answers['app.press'] = () => ({ ok: true, route: 'pid', fallback: true, center: { x: 1, y: 2 }, moved: { dx: 3 } });
  assert.equal((await r.record('desktop_app_click', { app: 'Mail', target: 'focused' })).note, undefined);
  r.helper.answers['app.press'] = () => ({ ok: true, route: 'ax', moved: { dy: 2 } });
  await r.shoot('com.apple.mail');
  assert.match((await r.record('desktop_app_click', { app: 'Mail', target: 'focused' })).note, /moved/);
  assert.equal(r.apps.session('c1').apps.get('com.apple.mail').windows.get(5).geom.y, 52);
});

test('type: empty text is refused unless it replaces the whole field, so a selection is never deleted by "typing nothing" (#1381 f2)', async () => {
  const r = rig();
  await r.shoot();
  for (const args of [
    { app: 'Notes', target: 'focused', text: '' },
    { app: 'Notes', element_index: 2, text: '', mode: 'insert' },
    { app: 'Notes', element_index: 2 },
  ])
    await rejects(r.call('desktop_app_type', args), 'bad_args', /text is empty.*desktop_app_ax_find.*mode: "replace"/);
  assert.equal(r.callsOf('app.setText').length, 0);
  // a batch step goes through the same check
  const batch = JSON.parse(await r.text('desktop_app_batch', { app: 'Notes', actions: [{ action: 'type', element_index: 2, text: '' }] }));
  assert.equal(batch.completed, 0);
  assert.match(JSON.stringify(batch.results[0]), /text is empty/);
  // clearing a field on purpose still works
  await r.record('desktop_app_type', { app: 'Notes', element_index: 2, text: '', mode: 'replace' });
  assert.equal(r.last('app.setText').mode, 'replace');
});
