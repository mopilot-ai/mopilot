// electron/capabilities/tools/desktopActions.cjs: coordinates and elements, clicks, drags, scrolls, typing, keys, waits,
// irreversible-action confirmation, typing routes with their read-back, and the held mouse button.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defined } from './support/defined.ts';
import { NOTES, MAIL, TERMINAL, FINDER, MOPILOT, rig, rejects, field } from './support/desktop-kit.ts';

/* -- actions ------------------------------------------------------------ */

test('coordinates: pixels of the latest screenshot map to global points; outside the image is refused', async () => {
  const r = rig();
  await r.ready([NOTES]);
  await r.call('desktop_left_click', { coordinate: [100, 50] });
  assert.deepEqual(r.callsOf('targetInfo').at(-1).args[0], { x: 200, y: 100 });
  assert.deepEqual(r.callsOf('click')[0].args, [200, 100, { button: 'left', count: 1, bundleIds: ['com.apple.Notes'] }]);
  await rejects(
    r.call('desktop_left_click', { coordinate: [1000, 10] }),
    'bad_args',
    /coordinate \(1000, 10\) is outside the 1000x500 screenshot/,
  );
  await rejects(r.call('desktop_left_click', { coordinate: [-1, 10] }), 'bad_args');
  await rejects(r.call('desktop_left_click', { coordinate: [1, 1000] }), 'bad_args');
  await rejects(r.call('desktop_left_click', { coordinate: [1, -2] }), 'bad_args');
  await rejects(r.call('desktop_left_click', { coordinate: [1] }), 'bad_args', /coordinate must be \[x, y\]/);
  await rejects(r.call('desktop_left_click', { coordinate: [1, NaN] }), 'bad_args');
  await rejects(r.call('desktop_left_click', { coordinate: 'here' }), 'bad_args');
  const err: any = await r.call('desktop_left_click', { coordinate: [5000, 1] }).catch((e: any) => e);
  assert.deepEqual(err.record, { action: 'left_click', effect: 'refused', route: 'global', reason: err.message.split('\n')[0] });
  assert.match(err.message, /\n\{"action":"left_click","effect":"refused"/);
});

test('element_index: a left click presses the element through accessibility, else clicks its center', async () => {
  const r = rig();
  await r.ready([NOTES]);
  const pressed = await r.json('desktop_left_click', { element_index: 2 });
  assert.deepEqual(pressed, { action: 'left_click', effect: 'confirmed', route: 'ax', app: 'Notes', element: 2 });
  assert.deepEqual(r.callsOf('axPress')[0].args, [7, '0.1', { bundleIds: ['com.apple.Notes'], expectElement: { role: 'AXTextField' } }]);
  assert.deepEqual(r.callsOf('targetInfo').at(-1).args[0], { x: 500, y: 220 }, 'the element center is checked');
  assert.equal(r.callsOf('click').length, 0);
  r.helper.press = { ok: false, center: { x: 505, y: 225 } };
  const moved = await r.json('desktop_left_click', { element_index: 2 });
  assert.deepEqual(moved, { action: 'left_click', effect: 'unverifiable', route: 'global', app: 'Notes', element: 2 });
  assert.deepEqual(r.callsOf('click')[0].args.slice(0, 2), [505, 225]);
  r.helper.fail.axPress = new Error('ax');
  await r.call('desktop_left_click', { element_index: 2 });
  assert.deepEqual(r.callsOf('click')[1].args.slice(0, 2), [500, 220]);
  // other clicks and modifier clicks never press
  await r.call('desktop_double_click', { element_index: 2 });
  await r.call('desktop_left_click', { element_index: 2, text: 'shift+Command' });
  assert.equal(r.callsOf('axPress').length, 3);
  assert.deepEqual(r.callsOf('click')[2].args[2], { button: 'left', count: 2, bundleIds: ['com.apple.Notes'] });
  assert.deepEqual(r.callsOf('click')[3].args[2], { button: 'left', count: 1, modifiers: 'shift+cmd', bundleIds: ['com.apple.Notes'] });
  await rejects(r.call('desktop_left_click', { element_index: 99 }), 'bad_args', /No element \[99\]/);
});

test('clicks: buttons and counts; mouse move; scroll direction, amount and clamping', async () => {
  const r = rig();
  await r.ready([NOTES]);
  await r.call('desktop_right_click', { coordinate: [10, 10] });
  await r.call('desktop_middle_click', { coordinate: [10, 10] });
  await r.call('desktop_triple_click', { coordinate: [10, 10] });
  assert.deepEqual(
    r.callsOf('click').map((c: any) => [c.args[2].button, c.args[2].count]),
    [
      ['right', 1],
      ['middle', 1],
      ['left', 3],
    ],
  );
  assert.deepEqual(await r.json('desktop_mouse_move', { coordinate: [10, 10] }), {
    action: 'mouse_move',
    effect: 'unverifiable',
    route: 'global',
    app: 'Notes',
  });
  assert.deepEqual(r.callsOf('move')[0].args, [20, 20, { bundleIds: ['com.apple.Notes'] }]);
  const scrolls: any[] = [];
  for (const [dir, amount] of [
    ['up', undefined],
    ['down', 5],
    ['left', 0],
    ['right', 99],
    ['up', 0.4],
  ]) {
    scrolls.push(await r.json('desktop_scroll', { coordinate: [10, 10], scroll_direction: dir, scroll_amount: amount }));
  }
  assert.deepEqual(
    scrolls.map((s) => [s.direction, s.amount]),
    [
      ['up', 3],
      ['down', 5],
      ['left', 3],
      ['right', 50],
      ['up', 1],
    ],
  );
  assert.deepEqual(
    r.callsOf('scroll').map((c: any) => c.args.slice(2, 4)),
    [
      [0, 3],
      [0, -5],
      [3, 0],
      [-50, 0],
      [0, 1],
    ],
  );
  assert.equal(r.callsOf('scroll')[0].args[4].units, 'line');
  await rejects(r.call('desktop_scroll', { coordinate: [10, 10], scroll_direction: 'sideways' }), 'bad_args', /scroll_direction must be/);
  // scroll at an element
  await r.call('desktop_scroll', { element_index: 1, scroll_direction: 'down' });
  assert.deepEqual(r.callsOf('scroll').at(-1).args.slice(0, 2), [220, 110]);
});

test('drag: both ends must be granted at full control; a failed drag lets go of the button', async () => {
  const r = rig();
  await r.ready([NOTES, TERMINAL]);
  const out = await r.json('desktop_left_click_drag', { start_coordinate: [10, 10], coordinate: [100, 50] });
  assert.deepEqual(out, { action: 'left_click_drag', effect: 'unverifiable', route: 'global', app: 'Notes' });
  assert.deepEqual(r.callsOf('drag')[0].args, [20, 20, 200, 100, { bundleIds: ['com.apple.Notes'] }]);
  assert.equal(r.d.session('c1').held.buttons.size, 0);
  r.helper.at = (p: any) => (p.x === 200 ? TERMINAL : NOTES);
  await rejects(
    r.call('desktop_left_click_drag', { start_coordinate: [10, 10], coordinate: [100, 50] }),
    'denied',
    /The drag would end on Terminal, which isn't granted at full control/,
  );
  r.helper.at = (p: any) => (p.x === 200 ? FINDER : NOTES);
  await rejects(r.call('desktop_left_click_drag', { start_coordinate: [10, 10], coordinate: [100, 50] }), 'denied', /end on Finder/);
  // a failed lookup of where the drag ends is the helper's failure, not a refusal
  r.helper.at = (p: any) => {
    if (p.x === 200) throw new Error('x');
    return NOTES;
  };
  await rejects(
    r.call('desktop_left_click_drag', { start_coordinate: [10, 10], coordinate: [100, 50] }),
    'failed',
    /Computer use failed: x/,
  );
  r.helper.at = (p: any) => (p.x === 200 ? {} : NOTES);
  await rejects(r.call('desktop_left_click_drag', { start_coordinate: [10, 10], coordinate: [100, 50] }), 'denied');
  await rejects(r.call('desktop_left_click_drag', { start_coordinate: [10, 10] }), 'bad_args', /coordinate must be/);
  await rejects(
    r.call('desktop_left_click_drag', { start_coordinate: 'here', coordinate: [10, 10] }),
    'bad_args',
    /start_coordinate must be/,
  );
  r.helper.at = null;
  let heldDuring = 0;
  r.helper.fail.drag = () => {
    heldDuring = r.d.session('c1').held.buttons.size;
    return Object.assign(new Error('timed out'), { reason: 'x' });
  };
  await rejects(r.call('desktop_left_click_drag', { start_coordinate: [10, 10], coordinate: [100, 50] }), 'failed', /timed out/);
  assert.equal(heldDuring, 1);
  assert.deepEqual(r.callsOf('releaseInput')[0].args, [{ buttons: ['left'] }]);
  assert.equal(r.d.session('c1').held.buttons.size, 0);
  r.helper.fail.releaseInput = new Error('also gone');
  await rejects(r.call('desktop_left_click_drag', { start_coordinate: [10, 10], coordinate: [100, 50] }), 'failed', /timed out/);
});

test('type: 50-character chunks, the count from the helper; an element is focused first', async () => {
  const r = rig();
  await r.ready([NOTES]);
  const text = 'a'.repeat(120);
  const out = await r.json('desktop_type', { text });
  assert.deepEqual(
    r.callsOf('type').map((c: any) => c.args[0].length),
    [50, 50, 20],
  );
  assert.deepEqual(r.callsOf('type')[0].args[1], { bundleIds: ['com.apple.Notes'], disableSubstitutions: true });
  assert.deepEqual(out, { action: 'type', effect: 'unverifiable', route: 'global', app: 'Notes', characters: 120, method: 'keys' });
  r.helper.typed = 4;
  assert.equal((await r.json('desktop_type', { text: 'hello' })).characters, 4);
  r.helper.typed = null;
  const focused = await r.json('desktop_type', { text: 'hi', element_index: 2 });
  assert.equal(focused.route, 'ax');
  assert.equal(focused.element, 2);
  assert.deepEqual(r.callsOf('axFocus')[0].args, [7, '0.1', { bundleIds: ['com.apple.Notes'], expectElement: { role: 'AXTextField' } }]);
  r.helper.focus = { ok: false, center: { x: 1, y: 2 } };
  const clicked = await r.json('desktop_type', { text: 'hi', element_index: 2 });
  assert.equal(clicked.route, 'global');
  assert.deepEqual(r.callsOf('click').at(-1).args, [1, 2, { button: 'left', count: 1, bundleIds: ['com.apple.Notes'] }]);
  r.helper.fail.axFocus = new Error('x');
  await r.call('desktop_type', { text: 'hi', element_index: 2 });
  assert.deepEqual(r.callsOf('click').at(-1).args.slice(0, 2), [500, 220]);
  assert.deepEqual(await r.json('desktop_type', {}), {
    action: 'type',
    effect: 'unverifiable',
    route: 'global',
    app: 'Notes',
    characters: 0,
  });
  assert.deepEqual(await r.json('desktop_type', { text: '', element_index: 2 }), {
    action: 'type',
    effect: 'unverifiable',
    route: 'global',
    app: 'Notes',
    characters: 0,
    element: 2,
  });
  r.helper.fail.axFocus = undefined;
  r.helper.focus = { ok: true };
  assert.equal((await r.json('desktop_type', { text: '', element_index: 2 })).route, 'ax');
  assert.equal(r.callsOf('type').length, 7, 'empty text types nothing');
  await rejects(r.call('desktop_type', { text: 'x', element_index: 50 }), 'bad_args', /No element \[50\]/);
});

test('type and key stop between chunks and combinations when the user presses Esc', async () => {
  const r = rig();
  await r.ready([NOTES]);
  r.helper.type = async (chunk: string) => {
    r.helper.calls.push({ method: 'type', args: [chunk] });
    r.d.interrupt('c1');
    return { ok: true };
  };
  await rejects(r.call('desktop_type', { text: 'b'.repeat(120) }), 'stopped', /Stopped by the user after 50 characters/);
  assert.equal(r.callsOf('type').length, 1);
  r.helper.key = async (combo: string) => {
    r.helper.calls.push({ method: 'key', args: [combo] });
    r.d.interrupt('c1');
    return { ok: true };
  };
  await rejects(r.call('desktop_key', { text: 'a b c' }), 'stopped', /Stopped by the user/);
  assert.equal(r.callsOf('key').length, 1);
  r.d.interrupt('nobody');
});

test('key: sequences in order, repeat clamped, Escape lifts the Esc shortcut, whole-Mac combos need a grant', async () => {
  const r = rig();
  await r.ready([NOTES]);
  const out = await r.json('desktop_key', { text: 'ctrl+a Delete', repeat: 2 });
  assert.deepEqual(
    r.callsOf('key').map((c: any) => c.args[0]),
    ['ctrl+a', 'delete', 'ctrl+a', 'delete'],
  );
  assert.deepEqual(out, { action: 'key', effect: 'unverifiable', route: 'global', app: 'Notes', keys: 'ctrl+a delete', repeat: 2 });
  assert.equal((await r.json('desktop_key', { text: 'x', repeat: 1000 })).repeat, 100);
  assert.equal((await r.json('desktop_key', { text: 'x', repeat: -3 })).repeat, 1);
  await r.call('desktop_key', { text: 'Esc' });
  assert.deepEqual(r.escapes, ['suspend']);
  assert.equal(r.callsOf('key').at(-1).args[0], 'escape');
  await rejects(r.call('desktop_key', { text: '  ' }), 'bad_args', /Name a key/);
  await rejects(r.call('desktop_key', { text: 'cmd+tab' }), 'denied', /cmd\+tab acts on the whole Mac; it needs systemKeyCombos/);
  r.d.session('c1').systemKeyCombos = true;
  await r.call('desktop_key', { text: 'cmd+tab' });
  assert.equal(r.callsOf('key').at(-1).args[0], 'cmd+tab');
  // without an indicator, Escape is pressed directly
  const bare = rig({ indicator: false });
  await bare.ready([NOTES]);
  await bare.call('desktop_key', { text: 'escape' });
  assert.equal(bare.callsOf('key').length, 1);
});

test('hold_key: held for the duration (capped), always let go, Escape lifts the shortcut', async () => {
  const r = rig();
  await r.ready([NOTES]);
  const out = await r.json('desktop_hold_key', { text: 'shift', duration: 2.5 });
  assert.deepEqual(r.callsOf('call')[0].args, [
    'input.key',
    { key: 'shift', holdMs: 2500, bundleIds: ['com.apple.Notes'] },
    { timeoutMs: 7500 },
  ]);
  assert.deepEqual(out, { action: 'hold_key', effect: 'unverifiable', route: 'global', app: 'Notes', keys: 'shift', seconds: 2.5 });
  assert.equal((await r.json('desktop_hold_key', { text: 'shift', duration: 60 })).seconds, 60);
  assert.equal((await r.json('desktop_hold_key', { text: 'shift', duration: 500 })).seconds, 100);
  assert.deepEqual(r.callsOf('call').at(-1).args[2], { timeoutMs: 105_000 });
  assert.equal((await r.json('desktop_hold_key', { text: 'shift', duration: 'x' })).seconds, 0);
  await r.call('desktop_hold_key', { text: 'escape', duration: 0 });
  assert.deepEqual(r.escapes, ['suspend']);
  let held = 0;
  r.helper.fail.call = () => {
    held = r.d.session('c1').held.keys.size;
    return Object.assign(new Error('timeout'), { reason: 'x' });
  };
  await rejects(r.call('desktop_hold_key', { text: 'shift', duration: 1 }), 'failed', /timeout/);
  assert.equal(held, 1);
  assert.deepEqual(r.callsOf('releaseInput').at(-1).args, [{ keys: ['shift'] }]);
  assert.equal(r.d.session('c1').held.keys.size, 0);
  r.helper.fail.releaseInput = new Error('x');
  await rejects(r.call('desktop_hold_key', { text: 'shift', duration: 1 }), 'failed');
  const bare = rig({ indicator: false });
  await bare.ready([NOTES]);
  await bare.call('desktop_hold_key', { text: 'escape', duration: 0 });
  assert.equal(bare.callsOf('call').length, 1);
});

test('wait and cursor_position: clamped wait; the pointer in screenshot pixels, or points before any screenshot', async () => {
  const r = rig();
  assert.deepEqual(await r.json('desktop_wait', { duration: -5 }), { action: 'wait', effect: 'confirmed', route: 'global', seconds: 0 });
  assert.deepEqual(await r.json('desktop_wait', { duration: 'soon' }), {
    action: 'wait',
    effect: 'confirmed',
    route: 'global',
    seconds: 0,
  });
  await r.grant([NOTES]);
  assert.deepEqual(await r.json('desktop_cursor_position'), {
    action: 'cursor_position',
    effect: 'confirmed',
    route: 'global',
    points: [200, 100],
  });
  await r.call('desktop_screenshot');
  assert.deepEqual(await r.json('desktop_cursor_position'), {
    action: 'cursor_position',
    effect: 'confirmed',
    route: 'global',
    coordinate: [100, 50],
  });
  await rejects(rig().call('desktop_cursor_position'), 'denied', /No apps are granted/);
});

test('wait: capped at 100 seconds, as the official toolset', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const r = rig();
  const p = r.json('desktop_wait', { duration: 500 });
  await new Promise((res) => setImmediate(res));
  t.mock.timers.tick(100_000);
  assert.equal((await p).seconds, 100);
});

/* -- irreversible actions ----------------------------------------------- */
test('irreversible: a click on a Send control is confirmed every time, by element or by point', async () => {
  const r = rig();
  await r.ready([NOTES]);
  r.d.session('c1').consent = true;
  await r.call('desktop_left_click', { element_index: 1 });
  await r.call('desktop_left_click', { coordinate: [110, 55] });
  assert.deepEqual(
    r.asks.map((a: any) => a.kind),
    ['computerConfirm', 'computerConfirm'],
  );
  assert.deepEqual(r.asks[0].params, {
    harness: 'claude',
    app: { bundleId: 'com.apple.Notes', name: 'Notes' },
    verb: 'send',
    summary: 'Send',
    tool: 'desktop_left_click',
  });
  assert.equal(r.callsOf('axPress').length + r.callsOf('click').length, 2);
  // ordinary controls and empty places don't ask
  await r.call('desktop_left_click', { element_index: 2 });
  await r.call('desktop_left_click', { coordinate: [999, 499] });
  assert.equal(r.asks.length, 2);
  r.answers.computerConfirm = { decision: 'deny' };
  await rejects(r.call('desktop_left_click', { element_index: 1 }), 'denied', /The user didn't confirm: send in Notes/);
  r.answers.computerConfirm = null;
  await rejects(r.call('desktop_left_click', { element_index: 1 }), 'denied');
  assert.equal(r.callsOf('axPress').length, 2);
});

test("irreversible: Return in a messaging app, cmd+delete, a typed newline in Mail, and the model's own flag", async () => {
  const r = rig();
  await r.ready([NOTES, MAIL]);
  r.d.session('c1').consent = true;
  r.helper.front = MAIL;
  r.helper.at = MAIL;
  await r.call('desktop_key', { text: 'Return' });
  await r.call('desktop_hold_key', { text: 'enter', duration: 0 });
  await r.call('desktop_type', { text: 'hi\n' });
  r.helper.front = NOTES;
  r.helper.at = NOTES;
  await r.call('desktop_key', { text: 'a cmd+Delete' });
  await r.call('desktop_key', { text: 'Return' });
  await r.call('desktop_type', { text: 'hi\n' });
  await r.call('desktop_mouse_move', { coordinate: [1, 1], irreversible: true });
  await r.call('desktop_scroll', { coordinate: [1, 1], scroll_direction: 'up', irreversible: true });
  await r.call('desktop_scroll', { coordinate: [1, 1], scroll_direction: 'up', irreversible: 'yes' });
  assert.deepEqual(
    r.asks.map((a: any) => [a.params.verb, a.params.summary, a.params.app.name, a.params.tool]),
    [
      ['send', 'press Return', 'Mail', 'desktop_key'],
      ['send', 'press Return', 'Mail', 'desktop_hold_key'],
      ['send', 'hi', 'Mail', 'desktop_type'],
      ['delete', 'press cmd+delete', 'Notes', 'desktop_key'],
      ['do this', 'mouse move', 'Notes', 'desktop_mouse_move'],
      ['do this', 'scroll', 'Notes', 'desktop_scroll'],
    ],
  );
});

test('irreversible: nobody there to confirm refuses and pauses; a confirmation is checked again before it runs', async () => {
  const r = rig();
  await r.ready([NOTES]);
  r.d.session('c1').consent = true;
  r.state.unattended = 'a sub-agent';
  await rejects(
    r.call('desktop_left_click', { element_index: 1 }),
    'unattended',
    /This would send in Notes, which can't be undone, and nobody is here to confirm it \(a sub-agent\)/,
  );
  assert.deepEqual(r.paused.at(-1).app, { bundleId: 'com.apple.Notes', name: 'Notes' });
  assert.equal(r.paused.at(-1).tool, 'desktop_left_click');
  r.state.unattended = null;
  // the screen changed while the user was confirming: a different control is now under the point
  let n = 0;
  r.answers.computerConfirm = () => {
    n++;
    r.d.session('c1').elements[0].label = `Delete ${n}`;
    return { decision: 'allow' };
  };
  await rejects(
    r.call('desktop_left_click', { coordinate: [110, 55] }),
    'changed',
    /What this action reaches changed while the user was confirming it/,
  );
  assert.equal(n, 2);
  assert.equal(r.callsOf('click').length, 0);
  // unchanged after the confirmation: runs once
  r.answers.computerConfirm = { decision: 'allow' };
  await r.call('desktop_left_click', { coordinate: [110, 55] });
  assert.equal(r.callsOf('click').length, 1);
  // a front app without a bundle id or name
  r.helper.front = MOPILOT;
  r.helper.at = NOTES;
  await r.call('desktop_left_click', { coordinate: [110, 55] });
  assert.deepEqual(defined(r.asks.at(-1)).params.app, { bundleId: 'com.apple.Notes', name: 'Notes' });
  const conf: any[] = [];
  r.broker.ask = async (_c: string, kind: string, params: any) => (conf.push(params), { decision: 'allow' });
  await r.d.confirm('c1', 'key', { verb: 'send', summary: 'x' }, null, {});
  assert.deepEqual(conf[0].app, { bundleId: '', name: 'this app' });
});

/* -- typing --------------------------------------------------------------- */

test('type: through accessibility where the field takes it, read back and confirmed; an ignored insert is typed instead', async () => {
  const r = rig();
  await r.ready([NOTES]);
  const { f, put } = field(r, 'Hello ');
  r.helper.insertText = async (t: string, o: any) => (r.helper.calls.push({ method: 'insertText', args: [t, o] }), put(t), { ok: true });
  assert.deepEqual(await r.json('desktop_type', { text: 'world' }), {
    action: 'type',
    effect: 'confirmed',
    route: 'ax',
    app: 'Notes',
    characters: 5,
    method: 'ax',
  });
  assert.deepEqual(r.callsOf('insertText')[0].args, ['world', { bundleIds: ['com.apple.Notes'] }]);
  assert.equal(r.callsOf('type').length, 0);
  assert.equal(f.value, 'Hello world');
  // the app says done but the field didn't change: typed as keys, substitutions off
  r.helper.insertText = async () => ({ ok: true });
  const keys = await r.json('desktop_type', { text: '!' });
  assert.deepEqual([keys.method, keys.effect, keys.route], ['keys', 'confirmed', 'global']);
  assert.deepEqual(r.callsOf('type')[0].args[1], { bundleIds: ['com.apple.Notes'], disableSubstitutions: true });
  // a helper without the insert
  r.helper.insertText = async () => {
    throw Object.assign(new Error('unknown method'), { reason: 'method_not_found' });
  };
  assert.equal((await r.json('desktop_type', { text: '?' })).method, 'keys');
  // a field the insert is refused for (a password field) is refused, not typed into
  r.helper.insertText = async () => {
    throw Object.assign(new Error('refused: target is a password field'), { reason: 'target_refused' });
  };
  await rejects(r.call('desktop_type', { text: 'secret' }), 'refused', /password field/);
  // an unreadable field: inserted, nothing to confirm it with
  f.readable = false;
  r.helper.insertText = async () => ({ ok: true });
  assert.deepEqual(await r.json('desktop_type', { text: 'x' }), {
    action: 'type',
    effect: 'unverifiable',
    route: 'ax',
    app: 'Notes',
    characters: 1,
    method: 'ax',
  });
  r.helper.fail.focusedText = new Error('old helper');
  assert.equal((await r.json('desktop_type', { text: 'x' })).effect, 'unverifiable');
});

test('type: autocorrect or a mask that changes the text reads as a mismatch; disable_substitutions false types like a person', async () => {
  const r = rig();
  await r.ready([NOTES]);
  const { f } = field(r, '');
  r.helper.type = async (chunk: string, o: any) => {
    r.helper.calls.push({ method: 'type', args: [chunk, o] });
    f.value += chunk.replace('teh', 'the');
    f.sel = { location: f.value.length, length: 0 };
    return { ok: true };
  };
  r.d.verifyMs = 1;
  const out = await r.json('desktop_type', { text: 'teh cat', disable_substitutions: false });
  assert.equal(out.effect, 'mismatch');
  assert.match(out.reason, /the field reads differently from the text typed/);
  assert.equal(out.method, 'keys');
  assert.equal(r.callsOf('insertText').length, 0, 'no accessibility insert when substitutions are wanted');
  assert.deepEqual(r.callsOf('type')[0].args[1], { bundleIds: ['com.apple.Notes'] });
  assert.equal(r.callsOf('focusedText').length, 1 + 3, 'read before, then up to three times after');
  // read back until the app shows it
  r.d.verifyMs = 0;
  let late = 0;
  f.value = '';
  f.sel = { location: 0, length: 0 };
  r.helper.type = async (chunk: string) => ((late = 2), (f.value = chunk), (f.sel = { location: chunk.length, length: 0 }), { ok: true });
  r.helper.field = () => (late-- > 0 ? { value: '', selection: { location: 0, length: 0 } } : { value: f.value, selection: f.sel });
  assert.equal((await r.json('desktop_type', { text: 'abc' })).effect, 'confirmed');
});

test('type: long or multi-line text is pasted through the clipboard, which comes back at the turn end', async () => {
  const r = rig();
  await r.ready([NOTES]);
  const { f, put } = field(r, '');
  r.setClip('mine');
  r.helper.paste = async (o: any) => (r.helper.calls.push({ method: 'paste', args: [o] }), put(r.clip()), { ok: true });
  const out = await r.json('desktop_type', { text: 'line 1\nline 2' });
  assert.deepEqual(out, { action: 'type', effect: 'confirmed', route: 'global', app: 'Notes', characters: 13, method: 'paste' });
  assert.deepEqual(r.callsOf('paste')[0].args, [{ bundleIds: ['com.apple.Notes'] }]);
  assert.equal(f.value, 'line 1\nline 2');
  assert.equal(r.callsOf('saveClipboard').length, 1);
  await r.d.turnEnded('c1');
  assert.deepEqual(r.callsOf('restoreClipboard')[0].args, [true]);
  // a helper without paste: the next way is used
  r.helper.paste = async () => {
    throw Object.assign(new Error('unknown method'), { reason: 'method_not_found' });
  };
  assert.equal((await r.json('desktop_type', { text: 'x'.repeat(250) })).method, 'keys');
  // no clipboard: never pasted
  const bare = rig({ clipboard: false });
  await bare.ready([NOTES]);
  assert.equal((await bare.json('desktop_type', { text: 'a\nb' })).method, 'keys');
  assert.equal(bare.callsOf('paste').length, 0);
});

/* -- the mouse button, held ----------------------------------------------- */
test('left_mouse_down and left_mouse_up: held across calls, let go anyway, never refused to let go', async () => {
  const r = rig();
  await r.ready([NOTES, TERMINAL]);
  const down = await r.json('desktop_left_mouse_down', { coordinate: [10, 10] });
  assert.deepEqual(down, { action: 'left_mouse_down', effect: 'unverifiable', route: 'global', app: 'Notes' });
  assert.deepEqual(r.callsOf('button')[0].args, ['left', true, { x: 20, y: 20 }, { bundleIds: ['com.apple.Notes'] }]);
  assert.ok(r.d.session('c1').held.buttons.has('left'));
  await r.call('desktop_mouse_move', { coordinate: [50, 50] });
  // letting go works whatever is in front
  r.helper.front = FINDER;
  assert.deepEqual(await r.json('desktop_left_mouse_up', {}), { action: 'left_mouse_up', effect: 'unverifiable', route: 'global' });
  assert.deepEqual(r.callsOf('button')[1].args, ['left', false, null, { bundleIds: ['com.apple.Notes', 'com.apple.Terminal'] }]);
  assert.equal(r.d.session('c1').held.buttons.size, 0);
  await r.call('desktop_left_mouse_up', { coordinate: [5, 5] });
  assert.deepEqual(r.callsOf('button')[2].args[2], { x: 10, y: 10 });
  // pressed where the pointer is, checked like a click there
  r.helper.front = NOTES;
  await r.call('desktop_left_mouse_down', {});
  assert.deepEqual(r.callsOf('button')[3].args[2], { x: 200, y: 100 });
  assert.deepEqual(r.callsOf('targetInfo').at(-1).args[0], { x: 200, y: 100 });
  // pressing and holding needs full control
  r.helper.at = TERMINAL;
  await rejects(r.call('desktop_left_mouse_down', { coordinate: [1, 1] }), 'tier', /doesn't allow left mouse down/);
  r.helper.at = null;
  // a press that fails lets go of the button
  r.d.session('c1').held.buttons.clear();
  r.helper.fail.button = Object.assign(new Error('timed out'), { reason: 'x' });
  await rejects(r.call('desktop_left_mouse_down', { coordinate: [1, 1] }), 'failed', /timed out/);
  assert.deepEqual(r.callsOf('releaseInput').at(-1).args, [{ buttons: ['left'] }]);
  assert.equal(r.d.session('c1').held.buttons.size, 0);
  r.helper.fail.releaseInput = new Error('gone');
  await rejects(r.call('desktop_left_mouse_down', { coordinate: [1, 1] }), 'failed', /timed out/);
  // a drag without a start begins where the pointer is
  delete r.helper.fail.button;
  await r.call('desktop_left_click_drag', { coordinate: [100, 50] });
  assert.deepEqual(r.callsOf('drag')[0].args.slice(0, 4), [200, 100, 200, 100]);
  // in a batch
  const out = await r.call('desktop_batch', {
    actions: [
      { action: 'left_mouse_down', coordinate: [10, 10] },
      { action: 'mouse_move', coordinate: [20, 20] },
      { action: 'left_mouse_up' },
    ],
  });
  assert.equal(JSON.parse(out[0].text).completed, 3);
});
