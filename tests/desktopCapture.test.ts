// electron/capabilities/tools/desktopCapture.cjs: screenshots of the granted apps sized for the model, zoom, and
// desktop_batch with its closing screenshot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTES, MAIL, FINDER, DISPLAY, rig, rejects } from './support/desktop-kit.ts';

test("screenshot: only the granted apps, sized for the model, with the frontmost app's elements", async () => {
  const r = rig();
  await r.grant([NOTES, MAIL]);
  const out = await r.call('desktop_screenshot');
  const shot = r.callsOf('screenshot')[0].args[0];
  assert.deepEqual(shot, {
    includeBundleIds: ['com.apple.Notes', 'com.apple.mail'],
    maxSide: 1568,
    maxPixels: 1_150_000,
    format: 'jpeg',
    quality: 0.75,
  });
  assert.deepEqual(out[0], { type: 'image', data: 'JPEG', mimeType: 'image/jpeg' });
  const lines = out[1].text.split('\n');
  assert.equal(lines[0], 'Screenshot 1000x500 of display 1 (2000x1000 points). Coordinates for desktop tools are pixels of this image.');
  assert.equal(lines[1], 'Shows only: Notes, Mail. Everything else is left out.');
  assert.equal(lines[2], 'Frontmost: Notes (tier full).');
  assert.equal(lines[3], 'Elements (use element_index):');
  assert.equal(lines[4], '[1] Button "Send" at (110, 55)');
  assert.equal(lines[5], '[2] TextField "To: someone" at (250, 110)');
  assert.equal(lines[6], '[3] CheckBox "Bold" at (305, 305) (disabled)');
  assert.equal(lines[8], `[5] Link "${'x'.repeat(80)}" at (455, 55)`);
  assert.equal(lines[9], '[6] Button at (480, 155)');
  assert.deepEqual(r.callsOf('axSnapshot')[0].args[0], { pid: 7, bundleIds: ['com.apple.Notes'] });
  assert.deepEqual(r.d.session('c1').geom, { x: 0, y: 0, ppp: 0.5, width: 1000, height: 500, display: 1 });
  // a chosen display is passed on
  r.d.session('c1').display = 2;
  r.helper.shot = () => ({
    png: 'PNG',
    width: 10,
    height: 10,
    pixelsPerPoint: 1,
    display: { x: 2000, y: 0, width: 10, height: 10 },
    included: ['com.other'],
  });
  r.helper.front = FINDER;
  const other = await r.call('desktop_screenshot');
  assert.equal(r.callsOf('screenshot')[1].args[0].display, 2);
  assert.deepEqual(other[0], { type: 'image', data: 'PNG', mimeType: 'image/png' });
  assert.match(other[1].text, /Shows only: com\.other\./);
  assert.match(other[1].text, /Finder is in front and isn't granted; input brings Notes forward first\./);
  assert.equal(r.d.session('c1').display, 2, 'kept when the helper does not name the display');
  assert.equal(r.d.session('c1').geom.x, 2000);
  r.helper.shot = () => ({ jpeg: 'J', width: 10, height: 10, included: [] });
  r.helper.front = { pid: 3 };
  const empty = await r.call('desktop_screenshot');
  assert.match(
    empty[1].text,
    /No granted app has a window on this display, so the image is empty\. desktop_switch_display picked it; call desktop_switch_display to pick the display the app is on\.\nNo granted app is in front\./,
  );
  assert.match(empty[1].text, /of display  \(0x0 points\)/);
  assert.deepEqual(r.d.session('c1').geom, { x: 0, y: 0, ppp: 1, width: 10, height: 10, display: null });
  assert.equal(empty[0].mimeType, 'image/jpeg');
  // the front lookup or the elements can fail without failing the screenshot, and the model is told so
  r.helper.front = NOTES;
  r.helper.fail.axSnapshot = new Error('ax');
  const noEls = await r.call('desktop_screenshot');
  assert.doesNotMatch(noEls[1].text, /Elements \(use/);
  assert.match(noEls[1].text, /Frontmost: Notes \(tier full\)\. Its elements couldn't be read \(ax\); act by coordinate\./);
  r.helper.fail.targetInfo = new Error('t');
  assert.match((await r.call('desktop_screenshot'))[1].text, /Couldn't tell which app is in front \(t\)\./);
  // a front app without a pid lists no elements
  delete r.helper.fail.targetInfo;
  delete r.helper.fail.axSnapshot;
  r.helper.front = { bundleId: 'com.apple.Notes', name: 'Notes' };
  assert.match((await r.call('desktop_screenshot'))[1].text, /Notes is in front and isn't granted/);
});

test('screenshot: an older helper shows the frontmost granted app only, or asks for one to be brought forward', async () => {
  const r = rig();
  await r.grant([NOTES]);
  r.helper.shot = (o: any) =>
    o.includeBundleIds
      ? { png: 'OLD' }
      : { png: 'APP', width: 100, height: 50, pixelsPerPoint: 2, display: { id: 4, x: 0, y: 0, width: 50, height: 25 } };
  const out = await r.call('desktop_screenshot');
  assert.deepEqual(r.callsOf('screenshot')[1].args[0], { pid: 7, bundleIds: ['com.apple.Notes'], maxSide: 1568 });
  assert.match(out[1].text, /\(only the frontmost app; update the helper to see every granted app\)/);
  r.helper.front = FINDER;
  await rejects(r.call('desktop_screenshot'), 'denied', /Bring a granted app forward/);
  r.helper.front = { bundleId: 'com.apple.Notes' };
  await rejects(r.call('desktop_screenshot'), 'denied');
  // a failed lookup is the helper's failure, not a request to bring an app forward
  r.helper.fail.targetInfo = new Error('x');
  await rejects(r.call('desktop_screenshot'), 'failed', /Computer use failed: x/);
});

test("screenshot: a capture that still fails after the helper's retries reaches the model as advice", async () => {
  const r = rig();
  await r.grant([NOTES, MAIL]);
  await r.call('desktop_screenshot');
  // no granted app has a window on screen (still opening, hidden, or on another Space), even after the helper waited
  r.helper.fail.screenshot = Object.assign(new Error('none of the requested apps has a window on screen'), {
    code: 9,
    reason: 'no_windows',
  });
  const advice =
    /Nothing to capture: none of the granted apps \(Notes, Mail\) has a window on screen; .* Bring one forward with desktop_open_application \(or open a window in it\), then take the screenshot again\./;
  await rejects(r.call('desktop_screenshot'), 'unavailable', advice);
  await rejects(r.call('desktop_zoom', { region: [0, 0, 100, 100] }), 'unavailable', advice);
  const batch = await r.call('desktop_batch', { actions: [{ action: 'wait', duration: 0 }] });
  assert.match(batch.at(-1).text, /^No screenshot after the batch: Nothing to capture: none of the granted apps \(Notes, Mail\)/);
  // ScreenCaptureKit failed again on the helper's retry with fresh content
  r.helper.fail.screenshot = Object.assign(
    new Error(
      'screen capture failed again after a retry: Failed to start stream due to audio/video capture failure (com.apple.ScreenCaptureKit.SCStreamErrorDomain -3811)',
    ),
    { code: 10, reason: 'capture_failed' },
  );
  await rejects(
    r.call('desktop_screenshot'),
    'failed',
    /^The screenshot failed twice in a row \(screen capture failed again after a retry: .*-3811\)\)\. Wait a moment and take it again; if it keeps failing, check that "MoPilot" still has Screen Recording permission in System Settings\.\n\{"action":"screenshot","effect":"refused"/,
  );
  // a capture of one app's windows (an older helper's fallback, the computer_* tools) says the same
  delete r.helper.fail.screenshot;
  r.helper.screenshot = async (o: any) => {
    if (o.pid) throw Object.assign(new Error('none of the requested apps has a window on screen'), { code: 9, reason: 'no_windows' });
    return { png: 'OLD' };
  };
  await rejects(
    r.call('desktop_screenshot'),
    'unavailable',
    /^Nothing to capture: the app has no window on screen \(it may still be opening, be hidden, or be on another Space\)\. Bring it forward or open a window in it, then take the screenshot again\./,
  );
  // anything else is reported as before
  r.helper.screenshot = async () => {
    throw new Error('boom');
  };
  await rejects(r.call('desktop_screenshot'), 'failed', /^Computer use failed: boom/);
  // the frame of the last good screenshot is kept
  assert.deepEqual(r.d.session('c1').geom, { x: 0, y: 0, ppp: 0.5, width: 1000, height: 500, display: 1 });
});

test('zoom: a region of the latest screenshot at full density, from the granted apps only', async () => {
  const r = rig();
  await r.ready([NOTES]);
  r.helper.shot = () => ({ jpeg: 'Z', width: 400, height: 200, included: ['com.apple.Notes'] });
  const out = await r.call('desktop_zoom', { region: [300, 150, 100, 50] });
  assert.deepEqual(r.callsOf('screenshot')[0].args[0], {
    includeBundleIds: ['com.apple.Notes'],
    display: 1,
    region: { x: 200, y: 100, width: 400, height: 200 },
    maxSide: 2000,
    format: 'jpeg',
    quality: 0.85,
  });
  assert.deepEqual(out[0], { type: 'image', data: 'Z', mimeType: 'image/jpeg' });
  assert.equal(out[1].text, "Zoomed view of [100, 50, 300, 150] at 400x200. Its pixels are not coordinates; keep using the screenshot's.");
  r.helper.shot = () => ({ png: 'P', width: 4, height: 2, included: [], mimeType: 'image/png' });
  r.d.session('c1').geom.display = null;
  assert.equal((await r.call('desktop_zoom', { region: [0, 0, 10, 10] }))[0].mimeType, 'image/png');
  assert.equal(r.callsOf('screenshot')[1].args[0].display, undefined);
  await rejects(r.call('desktop_zoom', { region: [0, 0, 1, 10] }), 'bad_args', /too small/);
  await rejects(r.call('desktop_zoom', { region: [0, 0, 10, 1] }), 'bad_args', /too small/);
  await rejects(r.call('desktop_zoom', { region: [0, 0, 10] }), 'bad_args', /region must be/);
  await rejects(r.call('desktop_zoom', { region: [0, 0, 10, Infinity] }), 'bad_args', /region must be/);
  await rejects(r.call('desktop_zoom', {}), 'bad_args');
  r.helper.shot = () => ({ png: 'OLD' });
  await rejects(r.call('desktop_zoom', { region: [0, 0, 10, 10] }), 'unavailable', /updated computer-use helper/);
  const fresh = rig();
  await fresh.grant([NOTES]);
  await rejects(fresh.call('desktop_zoom', { region: [0, 0, 10, 10] }), 'bad_args', /Take a desktop_screenshot first/);
});

/* -- batches ------------------------------------------------------------ */
test('batch: each action checked like its own tool; stops at the first failure; ends with one screenshot', async () => {
  const r = rig();
  await r.ready([NOTES]);
  r.helper.at = (p: any) => (p.x === 40 ? FINDER : NOTES);
  const out = await r.call('desktop_batch', {
    actions: [
      { action: 'left_click', coordinate: [10, 10] },
      { action: 'screenshot' },
      { action: 'type', text: 'hello' },
      { action: 'left_click', coordinate: [20, 20] },
      { action: 'key', text: 'Return' },
    ],
  });
  const summary = JSON.parse(out[0].text);
  assert.equal(summary.completed, 3);
  assert.equal(summary.of, 5);
  assert.equal(summary.stoppedAt, 3);
  assert.deepEqual(
    summary.results.map((x: any) => [x.action, x.effect]),
    [
      ['left_click', 'unverifiable'],
      ['screenshot', 'confirmed'],
      ['type', 'unverifiable'],
      ['left_click', 'refused'],
    ],
  );
  assert.equal(summary.results[1].note, 'taken at the end of the batch');
  assert.match(summary.results[3].reason, /That point is on Finder/);
  assert.equal(r.callsOf('key').length, 0, 'nothing after the failure runs');
  // one consent card for the batch, and the screenshot at the end
  assert.deepEqual(
    r.asks.map((a: any) => a.kind),
    ['computerTakeover'],
  );
  assert.equal(out[1].type, 'image');
  assert.match(out[2].text, /^Screenshot 1000x500/);
  assert.equal(r.callsOf('screenshot').length, 1);
});

test('batch: the frontmost app is re-checked for every item', async () => {
  const r = rig();
  await r.ready([NOTES]);
  let i = 0;
  r.helper.targetInfo = async (p: any) => {
    r.helper.calls.push({ method: 'targetInfo', args: [p] });
    if (p) return NOTES;
    return i++ < 2 ? NOTES : FINDER;
  };
  const out = await r.call('desktop_batch', {
    actions: [
      { action: 'key', text: 'a' },
      { action: 'key', text: 'b' },
      { action: 'key', text: 'c' },
    ],
  });
  const summary = JSON.parse(out[0].text);
  assert.equal(summary.completed, 2);
  assert.match(summary.results[2].reason, /Finder is in front and isn't granted/);
  assert.deepEqual(
    r.callsOf('key').map((c: any) => c.args[0]),
    ['a', 'b'],
  );
});

test('batch: observe-only batches need no consent; zoom images come along; a failed final screenshot is a note', async () => {
  const r = rig({ settleMs: 1 });
  await r.ready([NOTES]);
  r.helper.shot = (o: any) =>
    o.region
      ? { jpeg: 'Z', width: 2, height: 2, included: [] }
      : { jpeg: 'S', width: 1000, height: 500, pixelsPerPoint: 0.5, display: DISPLAY, included: ['com.apple.Notes'] };
  const out = await r.call('desktop_batch', {
    actions: [{ action: 'zoom', region: [0, 0, 10, 10] }, { action: 'wait', duration: 0 }, { action: 'cursor_position' }],
  });
  assert.equal(r.asks.length, 0);
  assert.equal(JSON.parse(out[0].text).completed, 3);
  assert.deepEqual(
    out.map((c: any) => c.data ?? c.type),
    ['text', 'Z', 'text', 'S', 'text'],
  );
  r.helper.fail.screenshot = new Error('display asleep');
  const failed = await r.call('desktop_batch', { actions: [{ action: 'wait', duration: 0 }] });
  assert.equal(failed.at(-1).text, 'No screenshot after the batch: display asleep');
  r.helper.fail.screenshot = () => 'plain';
  const plain = await r.call('desktop_batch', { actions: [{ action: 'wait', duration: 0 }] });
  assert.equal(plain.at(-1).text, 'No screenshot after the batch: plain');
});

test('batch: Esc or an aborted turn stops it before the next action, and no screenshot is taken', async () => {
  const r = rig();
  await r.ready([NOTES]);
  r.helper.click = async () => {
    r.helper.calls.push({ method: 'click', args: [] });
    r.d.interrupt('c1');
    return { ok: true };
  };
  const out = await r.call('desktop_batch', {
    actions: [
      { action: 'left_click', coordinate: [1, 1] },
      { action: 'left_click', coordinate: [2, 2] },
    ],
  });
  const summary = JSON.parse(out[0].text);
  assert.equal(summary.completed, 1);
  assert.deepEqual(summary.results[1], { action: 'left_click', effect: 'refused', route: 'global', reason: 'stopped by the user' });
  assert.equal(out.length, 1, 'no screenshot after a stop');
  const ac = new AbortController();
  ac.abort();
  const aborted = await r.call('desktop_batch', { actions: [{ action: 'wait', duration: 0 }] }, { chatId: 'c1', signal: ac.signal });
  assert.equal(JSON.parse(aborted[0].text).stoppedAt, 0);
  assert.equal(aborted.length, 1);
});

test('batch: bad input, and a missing permission ends the whole batch with the onboarding text', async () => {
  const r = rig();
  await rejects(r.call('desktop_batch', { actions: [] }), 'bad_args', /actions is empty/);
  await rejects(r.call('desktop_batch', {}), 'bad_args');
  await rejects(r.call('desktop_batch', { actions: Array(51).fill({ action: 'wait' }) }), 'bad_args', /At most 50 actions/);
  await rejects(r.call('desktop_batch', { actions: [{ action: 'fly' }] }), 'bad_args', /actions\[0\]\.action must be one of/);
  await rejects(r.call('desktop_batch', { actions: [null] }), 'bad_args');
  await r.ready([NOTES]);
  r.helper.fail.click = Object.assign(new Error('accessibility permission not granted'), { reason: 'permission_denied' });
  await rejects(
    r.call('desktop_batch', { actions: [{ action: 'left_click', coordinate: [1, 1] }] }),
    'permission',
    /cannot use Accessibility yet.*Already on\?/s,
  );
  // a non-ToolError failure inside a batch is reported as a refused record
  r.helper.fail.click = undefined;
  const real = r.d.act.bind(r.d);
  r.d.act = async () => {
    throw 'odd';
  };
  const out = await r.call('desktop_batch', { actions: [{ action: 'left_click', coordinate: [1, 1] }] });
  assert.equal(JSON.parse(out[0].text).results[0].reason, 'odd');
  r.d.act = real;
});

/* -- screenshot size per model ---------------------------------------------- */
test('screenshot size: high-resolution models get up to 2000 px and 3.75 MP; scale asks for less; zoom follows', async () => {
  const r = rig({ modelOf: (c: string) => (c === 'c1' ? 'claude-opus-4-7' : null) });
  await r.grant([NOTES]);
  await r.call('desktop_screenshot');
  assert.deepEqual([r.callsOf('screenshot')[0].args[0].maxSide, r.callsOf('screenshot')[0].args[0].maxPixels], [2000, 3_750_000]);
  await r.call('desktop_screenshot', { scale: 0.5 });
  assert.deepEqual([r.callsOf('screenshot')[1].args[0].maxSide, r.callsOf('screenshot')[1].args[0].maxPixels], [1000, 937_500]);
  r.helper.shot = () => ({ jpeg: 'Z', width: 4, height: 4, included: [] });
  await r.call('desktop_zoom', { region: [0, 0, 100, 100] });
  assert.equal(r.callsOf('screenshot')[2].args[0].maxSide, 2000);
  await r.call('desktop_zoom', { region: [0, 0, 100, 100], scale: 0.5 });
  assert.equal(r.callsOf('screenshot')[3].args[0].maxSide, 1000);
  // an older helper's one-app capture is sized the same
  const old = rig({ modelOf: async () => 'sonnet' });
  await old.grant([NOTES]);
  old.helper.shot = (o: any) =>
    o.includeBundleIds ? { png: 'OLD' } : { png: 'APP', width: 10, height: 10, display: { id: 1, x: 0, y: 0, width: 10, height: 10 } };
  await old.call('desktop_screenshot');
  assert.equal(old.callsOf('screenshot')[1].args[0].maxSide, 2000);
  // the model can't be told: the standard size
  const bad = rig({
    modelOf: async () => {
      throw new Error('x');
    },
  });
  await bad.grant([NOTES]);
  await bad.call('desktop_screenshot');
  assert.equal(bad.callsOf('screenshot')[0].args[0].maxSide, 1568);
});

test('batch: the closing screenshot waits for the screen to settle in the helper (up to settleMs); an older helper gets the fixed wait', async () => {
  const r = rig({ settleMs: 5 });
  await r.ready([NOTES]);
  await r.call('desktop_batch', { actions: [{ action: 'wait', duration: 0 }] });
  assert.deepEqual(
    r.callsOf('call').map((c: any) => [c.args[0], c.args[1], c.args[2]]),
    [['screen.settle', { capMs: 5 }, { timeoutMs: 5005 }]],
  );
  // a helper error: the fixed wait this once, the helper again next time
  r.helper.fail.call = new Error('busy');
  await r.call('desktop_batch', { actions: [{ action: 'wait', duration: 0 }] });
  assert.equal(r.d.screenSettle, true);
  // an older helper without screen.settle: the fixed wait from now on
  r.helper.fail.call = Object.assign(new Error('unknown method screen.settle'), { reason: 'method_not_found' });
  await r.call('desktop_batch', { actions: [{ action: 'wait', duration: 0 }] });
  assert.equal(r.d.screenSettle, false);
  const n = r.callsOf('call').length;
  const out = await r.call('desktop_batch', { actions: [{ action: 'wait', duration: 0 }] });
  assert.equal(r.callsOf('call').length, n);
  assert.equal(out.at(-1).type, 'text');
});
