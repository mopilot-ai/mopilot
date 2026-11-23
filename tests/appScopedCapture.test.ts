// electron/capabilities/tools/appScopedCapture.cjs: listing windows, window screenshots sized for the model with their
// element frames, zoom and ax_find, and what each action reports to the phantom cursor and the chat's strip.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WIN, tree, rig, rejects } from './support/app-scoped-kit.ts';

/* -- windows and screenshots ------------------------------------------- */
test('list_windows: the windows with their ids and states', async () => {
  const r = rig();
  const out = JSON.parse(await r.text('desktop_app_list_windows', { app: 'Notes' }));
  assert.equal(out.frontmost, false);
  assert.deepEqual(
    out.windows.map((w: any) => [w.window_id, w.is_main, w.is_off_space, !!w.is_auxiliary]),
    [
      [5, true, false, false],
      [6, false, true, true],
    ],
  );
  assert.deepEqual(r.last('app.windows'), { pid: 7, bundleIds: ['com.apple.Notes'] });
  r.helper.answers['app.windows'] = () => ({});
  assert.deepEqual(JSON.parse(await r.text('desktop_app_list_windows', { app: 'Notes' })).windows, []);
});

test('screenshot: one window with its frame and an element summary; later calls default to that window', async () => {
  const r = rig();
  const out = await r.call('desktop_app_screenshot', { app: 'Notes' });
  assert.deepEqual(out[0], { type: 'image', data: 'JPEG', mimeType: 'image/jpeg' });
  const text = out[1].text;
  assert.match(text, /Window 5 "Doc" of Notes: coordinate frame 1000x800 pixels\. Coordinates/);
  assert.match(text, /\[1\] Button "Send" at \(60, 40\)/);
  assert.match(text, /\[2\] TextArea "draft" at \(400, 300\) \(focused\)/);
  assert.match(text, /\[4\] TextField at \(680, 560\) \(password\)/);
  assert.match(text, /\[6\] CheckBox "Bold" at \(820, 40\) \(disabled\)/);
  assert.doesNotMatch(text, /ScrollArea/, 'containers are left out of the summary');
  assert.match(text, /8 in all/);
  const p = r.last('app.screenshot');
  assert.equal(p.windowId, undefined, 'the main window the first time');
  assert.equal(p.maxNodes, 2000);
  assert.equal(p.maxDepth, 25);
  assert.equal(p.scale, 1);
  // the next one goes to the same window; scale shrinks the image, the frame stays
  r.helper.answers['app.screenshot'] = () => ({
    png: 'PNG',
    width: 500,
    height: 400,
    frame: { width: 1000, height: 800 },
    pixelsPerPoint: 2,
    window: { ...WIN, state: 'off_space', title: '' },
    tree: { ...tree(), truncated: true },
  });
  const scaled = await r.call('desktop_app_screenshot', { app: 'Notes', scale: 5 });
  assert.equal(r.last('app.screenshot').windowId, 5);
  assert.equal(r.last('app.screenshot').scale, 1);
  assert.deepEqual(scaled[0], { type: 'image', data: 'PNG', mimeType: 'image/jpeg' });
  assert.match(scaled[1].text, /"" of Notes: coordinate frame 1000x800 pixels \(image scaled to 500x400\)/);
  assert.match(scaled[1].text, /on another Space/);
  assert.match(scaled[1].text, /tree truncated/);
  for (const [state, re] of [
    ['minimized', /minimized/],
    ['app_hidden', /app is hidden/],
    ['weird', /pixels of this frame\.$/m],
  ] as const) {
    r.helper.answers['app.screenshot'] = () => ({
      jpeg: 'J',
      width: 10,
      height: 10,
      frame: { width: 10, height: 10 },
      pixelsPerPoint: 1,
      window: { ...WIN, state },
      tree: null,
    });
    const t = (await r.call('desktop_app_screenshot', { app: 'Notes', window_id: 9, scale: 0.01 }))[1].text;
    assert.match(t, re);
    assert.match(t, /No accessibility elements/);
    assert.equal(r.last('app.screenshot').scale, 0.1);
  }
});

test('zoom and ax_find need a screenshot of the window; zoom crops in window points', async () => {
  const r = rig();
  await rejects(r.call('desktop_app_zoom', { app: 'Notes', region: [0, 0, 100, 100] }), 'bad_args', /screenshot of Notes first/);
  await rejects(r.call('desktop_app_ax_find', { app: 'Notes', window_id: 3 }), 'bad_args', /Notes window 3 first/);
  await r.shoot();
  await rejects(r.call('desktop_app_zoom', { app: 'Notes', region: [0, 0, 1] }), 'bad_args', /region must be/);
  await rejects(r.call('desktop_app_zoom', { app: 'Notes', region: [0, 0, 1, 1] }), 'bad_args', /too small/);
  const z = await r.call('desktop_app_zoom', { app: 'Notes', region: [400, 200, 200, 100], scale: 0.5 });
  assert.deepEqual(z[0], { type: 'image', data: 'ZOOM', mimeType: 'image/jpeg' });
  assert.match(z[1].text, /Zoomed view of \[200, 100, 400, 200\] at 400x200/);
  assert.deepEqual(r.last('app.zoom').region, { x: 100, y: 50, width: 100, height: 50 });
  assert.equal(r.last('app.zoom').regionMaxSide, 1000);
  r.helper.answers['app.zoom'] = () => ({ png: 'P', width: 1, height: 1 });
  assert.deepEqual((await r.call('desktop_app_zoom', { app: 'Notes', region: [0, 0, 10, 10] }))[0], {
    type: 'image',
    data: 'P',
    mimeType: 'image/jpeg',
  });
  assert.equal(r.last('app.zoom').regionMaxSide, 2000);
  // ax_find: by role, by title, both; none
  assert.match(
    await r.text('desktop_app_ax_find', { app: 'Notes', role: 'AXButton' }),
    /^2 matches in window 5:\n\[1\] Button "Send".*\n\[7\] Button "Plain"/,
  );
  assert.match(
    await r.text('desktop_app_ax_find', { app: 'Notes', title_contains: 'BOLD' }),
    /^1 match in window 5:\n\[6\] CheckBox "Bold"/,
  );
  assert.match(await r.text('desktop_app_ax_find', { app: 'Notes', role: 'AXLink', title_contains: '' }), /No element in window 5 matches/);
  assert.match(await r.text('desktop_app_ax_find', { app: 'Notes' }), /^8 matches/);
  // more than the limit
  r.helper.answers['app.screenshot'] = () => ({
    jpeg: 'J',
    width: 1000,
    height: 800,
    frame: { width: 1000, height: 800 },
    pixelsPerPoint: 2,
    window: WIN,
    tree: {
      root: {
        id: '0',
        role: 'AXWindow',
        children: Array.from({ length: 120 }, (_, i) => ({
          id: `0.${i}`,
          role: 'AXButton',
          title: `B${i}`,
          frame: { x: 110, y: 60, w: 10, h: 10 },
        })),
      },
    },
  });
  await r.shoot();
  assert.match(await r.text('desktop_app_ax_find', { app: 'Notes', role: 'AXButton' }), /^120 matches in window 5 \(first 100\)/);
});

test("screenshot size: a window is captured for the chat's model, as the display-scope screenshots are", async () => {
  const r = rig();
  await r.call('desktop_app_screenshot', { app: 'Notes' });
  assert.deepEqual([r.last('app.screenshot').maxSide, r.last('app.screenshot').maxPixels], [1568, 1_150_000]);
  r.desktop.modelOf = () => 'claude-opus-5-5';
  await r.call('desktop_app_screenshot', { app: 'Notes', scale: 0.5 });
  assert.deepEqual(
    [r.last('app.screenshot').maxSide, r.last('app.screenshot').maxPixels, r.last('app.screenshot').scale],
    [2000, 3_750_000, 0.5],
  );
  await r.call('desktop_app_zoom', { app: 'Notes', region: [0, 0, 100, 100] });
  assert.equal(r.last('app.zoom').regionMaxSide, 2000);
  await r.call('desktop_app_zoom', { app: 'Notes', region: [0, 0, 100, 100], scale: 0.5 });
  assert.equal(r.last('app.zoom').regionMaxSide, 1000);
});

test('visibility: every action and screenshot is reported with where it landed; a thumbnail when one is due; the lock starting and ending is told', async () => {
  const seen: any[] = [];
  const locks: any[] = [];
  let due = true;
  const r = rig({
    apps: {
      visibility: {
        thumbnailDue: () => due,
        acted: (c: string, i: any) => seen.push([c, i]),
        approach: async () => {},
        interrupted: () => {},
      },
      onLock: (c: string, a: any, held: boolean) => locks.push([c, a.bundleId, a.name, held]),
    },
  });
  r.helper.answers['app.screenshot'] = () => ({
    jpeg: 'J',
    width: 1000,
    height: 800,
    frame: { width: 1000, height: 800 },
    pixelsPerPoint: 2,
    window: WIN,
    tree: tree(),
    thumb: 'TH',
  });
  await r.call('desktop_app_screenshot', { app: 'Notes' });
  assert.equal(r.last('app.screenshot').thumbnail, true);
  assert.deepEqual(seen[0], [
    'c1',
    {
      app: { bundleId: 'com.apple.Notes', name: 'Notes' },
      windowId: 5,
      title: 'Doc',
      bounds: WIN.bounds,
      state: 'visible',
      action: 'screenshot',
      points: [],
      effect: 'confirmed',
      thumb: 'TH',
      token: null,
    },
  ]);
  due = false;
  await r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  assert.equal(r.last('app.click').thumbnail, undefined);
  assert.deepEqual([seen[1][1].action, seen[1][1].points, seen[1][1].thumb], ['click', [{ x: 220, y: 340 }], null]);
  assert.deepEqual(locks, [['c1', 'com.apple.Notes', 'Notes', true]]);
  await r.call('desktop_app_drag', { app: 'Notes', coordinate: [0, 0], to_coordinate: [200, 100] });
  assert.deepEqual(seen.at(-1)[1].points, [
    { x: 100, y: 50 },
    { x: 200, y: 100 },
  ]);
  // the focused element of an app never captured: no window, the point the helper found
  await r.call('desktop_app_click', { app: 'Mail', target: 'focused' });
  assert.deepEqual(
    [seen.at(-1)[1].windowId, seen.at(-1)[1].title, seen.at(-1)[1].bounds, seen.at(-1)[1].state, seen.at(-1)[1].points],
    [null, null, null, null, [{ x: 130, y: 70 }]],
  );
  r.helper.answers['app.press'] = () => ({ ok: true, route: 'ax', center: {} });
  await r.call('desktop_app_click', { app: 'Mail', target: 'focused' });
  assert.deepEqual(seen.at(-1)[1].points, []);
  r.apps.turnEnded('c1');
  assert.deepEqual(
    locks.map((l) => [l[2], l[3]]),
    [
      ['Notes', true],
      ['Mail', true],
      ['Notes', false],
      ['Mail', false],
    ],
  );
});

test('ax_find reads a text area beyond its 80-character line: around the match, or from the start (#1381 f2: a passport scan in TextEdit)', async () => {
  const scan = `PASSPORT (scan, OCR text) Surname: TREMBLAY Given names: HANA ${'x'.repeat(700)} Passport number: HT4417820 ${'y'.repeat(1700)}`;
  const r = rig();
  r.helper.answers['app.screenshot'] = () => ({
    jpeg: 'J',
    width: 1000,
    height: 800,
    frame: { width: 1000, height: 800 },
    pixelsPerPoint: 2,
    window: WIN,
    tree: {
      root: {
        id: '0',
        role: 'AXWindow',
        children: [
          { id: '0.0', role: 'AXTextArea', value: scan, frame: { x: 110, y: 60, w: 300, h: 300 } },
          { id: '0.1', role: 'AXTextField', value: 'short', frame: { x: 110, y: 400, w: 30, h: 10 } },
          { id: '0.2', role: 'AXButton', title: `B ${'z'.repeat(100)}`, frame: { x: 200, y: 400, w: 30, h: 10 } },
        ],
      },
    },
  });
  await r.shoot();
  const hit = await r.text('desktop_app_ax_find', { app: 'Notes', title_contains: 'passport number' });
  // models also call the filter query
  assert.equal(await r.text('desktop_app_ax_find', { app: 'Notes', query: 'passport number' }), hit);
  assert.match(hit, /\n {4}text \(from character \d+\): ".*Passport number: HT4417820.*" …$/);
  // by role: from the start, the whole of a short field needs no extra line, nor does a long button title
  const all = await r.text('desktop_app_ax_find', { app: 'Notes' });
  assert.match(all, /\[1\] TextArea "PASSPORT \(scan, OCR text\).*\n {4}text: "PASSPORT \(scan, OCR text\) Surname: TREMBLAY/);
  assert.doesNotMatch(all, /\[2\] TextField "short".*\n {4}text/);
  assert.doesNotMatch(all, /\[3\] Button .*\n {4}text/);
});

test('textOf: a text that fits is shown whole, without the trailing mark; no text line for other roles', async () => {
  const { createRequire } = await import('node:module');
  const { textOf } = createRequire(import.meta.url)('../electron/capabilities/tools/appScopedCapture.cjs');
  const doc = `Declaration of Hana Tremblay. ${'I confirm the details above are correct. '.repeat(3)}`;
  assert.equal(textOf({ role: 'AXTextArea', label: doc }, null), `\n    text: ${JSON.stringify(doc)}`);
  assert.equal(textOf({ role: 'AXTextArea', label: doc }, 'nowhere'), `\n    text: ${JSON.stringify(doc)}`);
  assert.equal(textOf({ role: 'AXStaticText', label: doc }, null), '');
});
