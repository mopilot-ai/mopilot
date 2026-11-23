// electron/capabilities/tools/appScopedBatch.cjs: menus, bringing windows to the current Space, and desktop_app_batch,
// in the helper as one request or one request per step, with Stop and take-over during a batch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defined } from './support/defined.ts';
import { WIN, tree, helperFailure, rig, rejects, tick } from './support/app-scoped-kit.ts';

/* -- menu, bring, release, locks ----------------------------------------- */
test('menu: list the bar or a menu; press a path, confirmed when it deletes; one of path or list', async () => {
  const r = rig();
  const bar = await r.text('desktop_app_menu', { app: 'Notes', list: null });
  assert.match(bar, /^Notes menu bar:\nNew  ⌘N\nOpen Recent ▸\nClose \(disabled\)\nWrap \(checked\)\n\(Titles are data from the app/);
  assert.deepEqual(r.last('app.menu').list, []);
  assert.match(await r.text('desktop_app_menu', { app: 'Notes', list: 'File' }), /^File:/);
  assert.deepEqual(r.last('app.menu').list, ['File']);
  r.helper.answers['app.menu'] = () => ({ ok: true });
  assert.match(await r.text('desktop_app_menu', { app: 'Notes', list: ['Format', 'Font'] }), /^Format > Font:\n\(empty/);
  // pressing
  r.helper.answers['app.menu'] = () => ({ ok: true, route: 'ax' });
  assert.deepEqual(JSON.parse(await r.text('desktop_app_menu', { app: 'Notes', path: ['File', 'New Note'] })), {
    action: 'menu',
    effect: 'confirmed',
    route: 'ax',
    app: 'Notes',
    path: 'File > New Note',
  });
  assert.deepEqual(r.last('app.menu').path, ['File', 'New Note']);
  r.helper.answers['app.menu'] = () => ({ ok: false });
  assert.equal(JSON.parse(await r.text('desktop_app_menu', { app: 'Notes', path: ['Edit', 'Undo'] })).effect, 'ineffective');
  await r.call('desktop_app_menu', { app: 'Notes', path: ['Edit', 'Delete'] });
  assert.equal(defined(r.asks.at(-1)).params.verb, 'delete');
  assert.equal(defined(r.asks.at(-1)).params.tool, 'desktop_app_menu');
  await rejects(r.call('desktop_app_menu', { app: 'Notes' }), 'bad_args', /exactly one/);
  await rejects(r.call('desktop_app_menu', { app: 'Notes', path: ['File'], list: 'File' }), 'bad_args', /exactly one/);
  await rejects(r.call('desktop_app_menu', { app: 'Notes', path: ['File', ' '] }), 'bad_args', /a menu and an item/);
  r.helper.fail['app.menu'] = helperFailure('unsupported', 'unsupported(disabled): Edit > Undo is disabled');
  // found but disabled: named as disabled, not unsupported or missing
  await assert.rejects(
    r.call('desktop_app_menu', { app: 'Notes', path: ['Edit', 'Undo'] }),
    (e: any) => e.code === 'disabled' && /"Edit > Undo" is in Notes's menu but disabled/.test(e.message) && e.record.effect === 'refused',
  );
  r.helper.fail['app.menu'] = helperFailure('unsupported', 'unsupported(submenu): Edit > Find is a submenu');
  await assert.rejects(
    r.call('desktop_app_menu', { app: 'Notes', path: ['Edit', 'Find'] }),
    (e: any) => e.code === 'unsupported' && e.record.effect === 'unsupported',
  );
  r.helper.fail['app.menu'] = helperFailure('target_refused', 'refused: target is X');
  await assert.rejects(
    r.call('desktop_app_menu', { app: 'Notes', path: ['Edit', 'Undo'] }),
    (e: any) => e.code === 'refused' && e.record.effect === 'refused',
  );
});

test('bring_to_current_space: un-minimizes or unhides; the old frame is dropped', async () => {
  const r = rig();
  await r.shoot();
  const out = await r.text('desktop_app_bring_to_current_space', { app: 'Notes', window_id: 5 });
  assert.match(out, /"changed":true/);
  assert.match(out, /Take a new desktop_app_screenshot/);
  assert.deepEqual(r.last('app.bringToCurrentSpace'), { pid: 7, bundleIds: ['com.apple.Notes'], windowId: 5 });
  await rejects(r.call('desktop_app_click', { app: 'Notes', element_index: 1 }), 'bad_args', /screenshot of Notes first/);
  r.helper.answers['app.bringToCurrentSpace'] = () => ({ ok: true });
  assert.match(await r.text('desktop_app_bring_to_current_space', { app: 'Notes', window_id: 5 }), /"changed":false/);
  r.helper.fail['app.bringToCurrentSpace'] = helperFailure('unsupported', 'unsupported(off_space): no public API');
  await rejects(r.call('desktop_app_bring_to_current_space', { app: 'Notes', window_id: 6 }), 'unsupported', /off_space/);
});

/* -- batch -------------------------------------------------------------- */
test('batch: actions in order against one window; screenshots and zooms inline; stops at the first failure', async () => {
  const r = rig();
  const out = await r.call('desktop_app_batch', {
    app: 'Notes',
    actions: [
      { action: 'screenshot' },
      { action: 'click', element_index: 2 },
      { action: 'type', text: 'hi' },
      { action: 'key', combo: 'tab' },
      { action: 'zoom', region: [0, 0, 100, 100] },
    ],
  });
  const summary = JSON.parse(out[0].text);
  assert.deepEqual([summary.completed, summary.of, summary.stoppedAt], [5, 5, undefined]);
  assert.deepEqual(
    summary.results.map((x: any) => x.action),
    ['screenshot', 'click', 'type', 'key', 'zoom'],
  );
  assert.deepEqual(
    out.slice(1).map((c: any) => c.type),
    ['image', 'text', 'image', 'text'],
  );
  assert.equal(r.last('app.setText').id, '0.1', 'type reused the click point');
  // a type item without text is refused before anything is written (over a selection it would delete it)
  const n = r.callsOf('app.setText').length;
  await r.call('desktop_app_batch', { app: 'Notes', actions: [{ action: 'type', element_index: 2 }] });
  assert.equal(r.callsOf('app.setText').length, n);
  // an unsupported action stops it; an ineffective one does not
  r.helper.answers['app.key'] = () => ({ ok: false });
  const stop = JSON.parse(
    (
      await r.call('desktop_app_batch', {
        app: 'Notes',
        window_id: 5,
        actions: [
          { action: 'key', element_index: 2, combo: 'tab' },
          { action: 'click', element_index: 3 },
          { action: 'click', element_index: 1 },
        ],
      })
    )[0].text,
  );
  assert.deepEqual([stop.completed, stop.stoppedAt, stop.results[0].effect, stop.results[1].effect], [1, 1, 'ineffective', 'unsupported']);
  r.helper.fail['app.press'] = helperFailure('target_refused', 'refused: target is X');
  const refused = JSON.parse(
    (await r.call('desktop_app_batch', { app: 'Notes', actions: [{ action: 'click', element_index: 1 }] }))[0].text,
  );
  assert.equal(refused.results[0].effect, 'refused');
  // a missing permission ends the batch with the permission error
  r.helper.fail['app.press'] = helperFailure('permission_denied', 'accessibility permission not granted');
  await rejects(r.call('desktop_app_batch', { app: 'Notes', actions: [{ action: 'click', element_index: 1 }] }), 'permission');
  await rejects(r.call('desktop_app_batch', { app: 'Notes', actions: [] }), 'bad_args', /empty/);
  await rejects(
    r.call('desktop_app_batch', { app: 'Notes', actions: Array.from({ length: 51 }, () => ({ action: 'screenshot' })) }),
    'bad_args',
    /At most 50/,
  );
  await rejects(r.call('desktop_app_batch', { app: 'Notes', actions: [{ action: 'menu' }] }), 'bad_args', /must be one of/);
  await rejects(r.call('desktop_app_batch', { app: 'Notes', actions: [null] }), 'bad_args');
  await rejects(r.call('desktop_app_batch', { app: 'Notes' }), 'bad_args', /empty/);
});

test('batch: Esc or Stop stops before the next action; an aborted call stops too', async () => {
  const r = rig();
  await r.shoot();
  let n = 0;
  r.helper.answers['app.press'] = () => {
    if (++n === 1) r.apps.interrupt('c1');
    return { ok: true };
  };
  const out = JSON.parse(
    (
      await r.call('desktop_app_batch', {
        app: 'Notes',
        actions: [
          { action: 'click', element_index: 1 },
          { action: 'click', element_index: 1 },
        ],
      })
    )[0].text,
  );
  assert.deepEqual([out.completed, out.stoppedAt, out.results[1].reason], [1, 1, 'stopped by the user']);
  const ac = new AbortController();
  ac.abort();
  const aborted = JSON.parse(
    (await r.call('desktop_app_batch', { app: 'Notes', actions: [{ action: 'screenshot' }] }, { chatId: 'c1', signal: ac.signal }))[0].text,
  );
  assert.equal(aborted.completed, 0);
});

/* -- batches in the helper -------------------------------------------------- */
test('batch: input runs as one helper request gated once, with a screenshot after it; attendance is checked once; the last step brings the thumbnail', async () => {
  let due = true;
  const r = rig({ apps: { visibility: { thumbnailDue: () => due, acted: () => {}, approach: async () => {}, interrupted: () => {} } } });
  await r.shoot();
  let checks = 0;
  r.cu.unattended = async () => (checks++, null);
  const out = await r.call('desktop_app_batch', {
    app: 'Notes',
    actions: [
      { action: 'click', element_index: 7 },
      { action: 'type', element_index: 2, text: 'x' },
      { action: 'key', combo: 'tab' },
      { action: 'screenshot' },
      { action: 'click', element_index: 7 },
    ],
  });
  const summary = JSON.parse(out[0].text);
  assert.deepEqual([summary.completed, summary.results.map((x: any) => x.action)], [5, ['click', 'type', 'key', 'screenshot', 'click']]);
  assert.equal(checks, 1, 'the attendance check runs once for the batch');
  const batches = r.callsOf('app.batch');
  assert.equal(batches.length, 1);
  assert.deepEqual(
    batches[0].params.steps.map((s: any) => s.method),
    ['app.click', 'app.setText', 'app.key', 'app.screenshot'],
  );
  assert.deepEqual(
    batches[0].params.steps.map((s: any) => !!s.params.thumbnail),
    [false, false, false, true],
  );
  assert.match(batches[0].params.batchId, /^c1:\d+$/);
  assert.equal(batches[0].opts.timeoutMs, 30000 + 120000 + 30000 + 45000);
  assert.equal(r.apps.session('c1').batchId, null);
  // the last click went alone, as its own request
  assert.equal(r.callsOf('app.click').at(-1).opts?.batch, undefined);
  assert.equal(out[1].type, 'image');
  // a screenshot that ends the batch
  due = false;
  await r.call('desktop_app_batch', { app: 'Notes', actions: [{ action: 'click', element_index: 7 }, { action: 'screenshot' }] });
  assert.deepEqual(
    r
      .callsOf('app.batch')
      .at(-1)
      .params.steps.map((s: any) => [s.method, !!s.params.thumbnail]),
    [
      ['app.click', false],
      ['app.screenshot', false],
    ],
  );
});

test('batch in the helper: a failing step stops it where it failed; a refused or broken batch request', async () => {
  const r = rig();
  await r.shoot();
  r.helper.fail['app.key'] = helperFailure('unsupported', 'unsupported(x): no');
  const out = JSON.parse(
    (
      await r.call('desktop_app_batch', {
        app: 'Notes',
        actions: [
          { action: 'click', element_index: 7 },
          { action: 'type', element_index: 2, text: 'x' },
          { action: 'key', combo: 'tab' },
          { action: 'click', element_index: 7 },
        ],
      })
    )[0].text,
  );
  assert.deepEqual(
    [out.completed, out.stoppedAt, out.results.map((x: any) => x.effect)],
    [2, 2, ['unverifiable', 'confirmed', 'unsupported']],
  );
  delete r.helper.fail['app.key'];
  // the helper refuses the whole batch: it stops at the first step
  r.helper.fail['app.batch'] = helperFailure('target_refused', 'refused: target is X');
  const refused = JSON.parse(
    (
      await r.call('desktop_app_batch', {
        app: 'Notes',
        actions: [
          { action: 'click', element_index: 7 },
          { action: 'click', element_index: 7 },
        ],
      })
    )[0].text,
  );
  assert.deepEqual([refused.completed, refused.results[0].effect], [0, 'refused']);
  delete r.helper.fail['app.batch'];
  // a batch result with nothing in it, or an error the helper names
  r.helper.answers['app.batch'] = () => ({});
  const empty = JSON.parse(
    (
      await r.call('desktop_app_batch', {
        app: 'Notes',
        actions: [
          { action: 'click', element_index: 7 },
          { action: 'click', element_index: 7 },
        ],
      })
    )[0].text,
  );
  assert.deepEqual([empty.completed, empty.results[0].effect], [0, 'refused']);
  assert.match(empty.results[0].reason, /the helper stopped the batch/);
  r.helper.answers['app.batch'] = () => ({ results: [], error: { reason: 'window_gone', message: 'gone' } });
  const gone = JSON.parse(
    (
      await r.call('desktop_app_batch', {
        app: 'Notes',
        actions: [
          { action: 'click', element_index: 7 },
          { action: 'click', element_index: 7 },
        ],
      })
    )[0].text,
  );
  assert.match(gone.results[0].reason, /desktop_app_list_windows/);
});

test('batch in the helper: a result that needs another request, or that refuses, while finishing; zooms and screenshots stop at a failure before them', async () => {
  const r = rig();
  await r.shoot();
  // the focused element can't be pressed and has no position: refused while finishing the step
  r.helper.answers['app.press'] = () => ({ ok: false });
  const nopress = JSON.parse(
    (
      await r.call('desktop_app_batch', {
        app: 'Notes',
        actions: [
          { action: 'click', target: 'focused' },
          { action: 'click', element_index: 7 },
        ],
      })
    )[0].text,
  );
  assert.deepEqual([nopress.completed, nopress.results[0].effect], [0, 'unsupported']);
  assert.match(nopress.results[0].reason, /unsupported\(no_press\)/);
  // an older helper's failed press: the click goes as its own request
  const clicks = r.callsOf('app.click').length;
  const fell = JSON.parse(
    (
      await r.call('desktop_app_batch', {
        app: 'Notes',
        actions: [
          { action: 'scroll', element_index: 2, dy: 1 },
          { action: 'click', coordinate: [60, 40] },
        ],
      })
    )[0].text,
  );
  assert.equal(fell.completed, 2);
  assert.equal(r.callsOf('app.click').length, clicks + 1);
  r.helper.answers['app.press'] = () => ({ ok: true, route: 'ax' });
  // a failure before a zoom or a screenshot ends the batch there
  r.helper.fail['app.click'] = helperFailure('unsupported', 'unsupported(y): no');
  for (const last of [{ action: 'zoom', region: [0, 0, 10, 10] }, { action: 'screenshot' }]) {
    const out = JSON.parse(
      (await r.call('desktop_app_batch', { app: 'Notes', actions: [{ action: 'click', element_index: 7 }, last] }))[0].text,
    );
    assert.deepEqual([out.completed, out.stoppedAt, out.results.length], [0, 0, 1], last.action);
  }
});

test('batch: Stop cancels a batch running in the helper; Stop while preparing drops what was not sent; an older helper runs one request per step', async () => {
  const r = rig();
  await r.shoot();
  let n = 0;
  r.helper.answers['app.click'] = () => {
    if (++n === 1) r.apps.interrupt('c1');
    return { ok: true, route: 'pid' };
  };
  const cancelled = JSON.parse(
    (
      await r.call('desktop_app_batch', {
        app: 'Notes',
        actions: [
          { action: 'click', element_index: 7 },
          { action: 'click', element_index: 7 },
          { action: 'click', element_index: 7 },
        ],
      })
    )[0].text,
  );
  assert.deepEqual([cancelled.completed, cancelled.stoppedAt, cancelled.results[1].reason], [1, 1, 'stopped by the user']);
  assert.equal(r.callsOf('app.cancel').length, 1);
  // Stop arrives while a later action is being confirmed: what was prepared and not sent doesn't run
  Object.defineProperty(r.answers, 'computerConfirm', { configurable: true, get: () => (r.apps.interrupt('c1'), { decision: 'allow' }) });
  n = 1;
  const clicks = r.callsOf('app.click').length;
  const halted = JSON.parse(
    (
      await r.call('desktop_app_batch', {
        app: 'Notes',
        actions: [
          { action: 'click', element_index: 7 },
          { action: 'click', element_index: 1 },
          { action: 'click', element_index: 7 },
        ],
      })
    )[0].text,
  );
  assert.deepEqual([halted.completed, halted.stoppedAt, halted.results.at(-1).reason], [1, 1, 'stopped by the user']);
  assert.equal(r.callsOf('app.click').length, clicks + 1);
  Object.defineProperty(r.answers, 'computerConfirm', { configurable: true, value: { decision: 'allow' } });
  // Stop during a screenshot: the batch ends before the next action
  r.helper.answers['app.screenshot'] = () => (
    r.apps.interrupt('c1'),
    { jpeg: 'J', width: 1000, height: 800, frame: { width: 1000, height: 800 }, pixelsPerPoint: 2, window: WIN, tree: tree() }
  );
  const shot = JSON.parse(
    (await r.call('desktop_app_batch', { app: 'Notes', actions: [{ action: 'screenshot' }, { action: 'click', element_index: 7 }] }))[0]
      .text,
  );
  assert.deepEqual([shot.completed, shot.stoppedAt], [1, 1]);
  // an older helper: no app.batch; from then on one request per step, Stop checked between them
  r.helper.answers['app.screenshot'] = () => ({
    jpeg: 'J',
    width: 1000,
    height: 800,
    frame: { width: 1000, height: 800 },
    pixelsPerPoint: 2,
    window: WIN,
    tree: tree(),
  });
  r.helper.fail['app.batch'] = helperFailure('method_not_found');
  n = 0;
  const old = JSON.parse(
    (
      await r.call('desktop_app_batch', {
        app: 'Notes',
        actions: [
          { action: 'click', element_index: 7 },
          { action: 'click', element_index: 7 },
        ],
      })
    )[0].text,
  );
  assert.deepEqual([old.completed, old.stoppedAt], [1, 1]);
  assert.equal(r.apps.noHelperBatch, true);
  const before = r.callsOf('app.batch').length;
  n = 5;
  assert.equal(
    JSON.parse(
      (
        await r.call('desktop_app_batch', {
          app: 'Notes',
          actions: [
            { action: 'click', element_index: 7 },
            { action: 'click', element_index: 7 },
          ],
        })
      )[0].text,
    ).completed,
    2,
  );
  assert.equal(r.callsOf('app.batch').length, before);
});

test('a batch the helper cannot cancel: Stop and a take over still return, and the call settles', async () => {
  for (const how of ['takeOver', 'interrupt'] as const) {
    const r = rig();
    await r.shoot();
    r.helper.fail['app.cancel'] = new Error('helper gone');
    let first = true;
    r.helper.answers['app.click'] = () => {
      if (first && how === 'takeOver') assert.equal(r.apps.takeOver('c1', 'com.apple.Notes'), true);
      else if (first) r.apps.interrupt('c1');
      first = false;
      return { ok: true, route: 'pid' };
    };
    const done = r.call('desktop_app_batch', {
      app: 'Notes',
      actions: [
        { action: 'click', element_index: 7 },
        { action: 'click', element_index: 7 },
      ],
    });
    await done.then(
      () => {},
      () => {},
    );
    await tick();
    assert.equal(r.callsOf('app.cancel').length, 1, `${how} asked the helper to cancel`);
    assert.equal(r.callsOf('app.cancel')[0].params.batchId, r.callsOf('app.batch')[0].params.batchId);
  }
});
