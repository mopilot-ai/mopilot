// The computer-use tools over a scripted helper: the element list's formatting, helper errors as tool
// errors, the permission guide's "Check again", taking and letting go of the desktop, and the vision
// tools' screenshots, all without a real screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { defined } from './support/defined.ts';

const require = createRequire(import.meta.url);
const { elementList, elementAt, helperError, missingPermission } = require('../electron/capabilities/tools/computer.cjs');

import { shot, make, ctx } from './support/computer-tools-kit.ts';

/* -- pure helpers ----------------------------------------------------- */
test('elementList: nameless roles, flags, skipped junk, the app name and the overflow note', () => {
  const snap = {
    app: { name: 'Notes' },
    root: {
      role: 'AXApplication',
      title: 'Notes',
      frame: { x: 0, y: 0, w: 100, h: 100 },
      children: [
        null,
        5,
        { id: 'a', role: 7, title: 'Label', frame: { x: 0, y: 0, w: 10, h: 10 }, focused: true },
        { id: 'b', role: 'AXButton', frame: { x: 10, y: 0, w: 10, h: 10 }, enabled: false },
        { id: 'c', role: 'AXButton', frame: { x: 20, y: 0, w: 0, h: 10 } },
        { id: 'd', role: 'AXCheckBox', frame: { x: 30, y: 0, w: 10, h: 10 }, focused: true, enabled: false },
      ],
    },
  };
  const { text, byId } = elementList(snap, undefined, 2);
  assert.equal(
    text,
    'Notes: 2 elements (id, role, label, center)\n[a] Element "Label" at (5, 5) (focused)\n[b] Button at (15, 5) (disabled)\n(1 more not shown)',
  );
  assert.deepEqual([...byId.keys()], ['a', 'b', 'd']);
  assert.match(elementList(snap).text, /\[d\] CheckBox at \(35, 5\) \(focused, disabled\)/);
  assert.equal(elementList(undefined).text, 'no elements found');
  assert.equal(elementList({ app: { name: 'X' }, root: {} }).text, 'X: no elements found');
});

test('elementAt: the smallest element holding the point; none outside every frame', () => {
  const big = { id: 'big', frame: { x: 0, y: 0, w: 100, h: 100 } };
  const small = { id: 'small', frame: { x: 10, y: 10, w: 5, h: 5 } };
  const byId = new Map([
    ['small', small],
    ['big', big],
  ]);
  assert.equal(elementAt(byId, { x: 12, y: 12 }).id, 'small');
  assert.equal(elementAt(byId, { x: 50, y: 50 }).id, 'big');
  for (const p of [
    { x: -1, y: 5 },
    { x: 5, y: -1 },
    { x: 101, y: 5 },
    { x: 5, y: 101 },
  ])
    assert.equal(elementAt(byId, p), null);
});

test('helper errors become tool errors the model can act on', () => {
  const errors = require('../electron/capabilities/tools/computerErrors.cjs');
  assert.equal(helperError, errors.helperError, 'the public API shares helper error normalization');
  assert.equal(missingPermission, errors.missingPermission);
  assert.equal(missingPermission({ reason: 'permission_denied', message: 'nothing named' }), null);
  assert.equal(missingPermission({ reason: 'other' }), null);
  assert.equal(missingPermission(null), null);
  assert.equal(missingPermission({ reason: 'guard_unavailable' }), 'accessibility');
  assert.equal(helperError({ reason: 'target_refused', message: 'Keychain' }).code, 'refused');
  assert.equal(helperError({ reason: 'aborted', message: 'stop' }).code, 'stopped');
  assert.equal(helperError({ reason: 'lock_busy', message: 'busy' }).code, 'busy');
  const g = helperError({ reason: 'guard_unavailable' });
  assert.deepEqual([g.code, g.permission], ['permission', 'accessibility']);
  assert.equal(
    helperError('plain').message,
    'Computer use failed: plain. Try once more; if it fails again, ask the user to open Settings → Computer use, which says what is wrong.',
  );
  assert.equal(
    helperError(null).message,
    'Computer use failed: null. Try once more; if it fails again, ask the user to open Settings → Computer use, which says what is wrong.',
  );
  for (const reason of ['element_changed', 'element_gone']) {
    const error = helperError({ reason, message: 'element 0.1 moved; take a new app_screenshot' });
    assert.equal(error.code, 'changed');
    assert.match(error.message, /element 0\.1 moved\), so nothing was done/);
    assert.match(error.message, /Take a new desktop_screenshot/);
    assert.doesNotMatch(error.message, /app_screenshot/);
  }
  const noWindow = helperError({ reason: 'no_windows' });
  assert.equal(noWindow.code, 'unavailable');
  assert.match(noWindow.message, /app has no window on screen/);
  assert.match(noWindow.message, /Bring it forward/);
  const capture = helperError({ reason: 'capture_failed', message: 'capture timed out' });
  assert.equal(capture.code, 'failed');
  assert.match(capture.message, /failed twice in a row \(capture timed out\)/);
  assert.match(capture.message, /Screen Recording permission/);
});

/* -- calls ------------------------------------------------------------ */
test('a scheduled task without computer control is refused with where its person turns it on', async () => {
  const { by } = make({ session: { modality: 'image', scheduled: { computer: false } } });
  await assert.rejects(by.computer_screenshot({}, ctx), (e: any) => e.code === 'refused' && /'Allow computer control'/.test(e.message));
});

test('a helper that will not start makes computer use unavailable', async () => {
  const { by } = make({
    helper: {
      start: async () => {
        throw new Error('no app');
      },
    },
  });
  await assert.rejects(by.computer_screenshot(null, ctx), (e: any) => e.code === 'unavailable' && /no app/.test(e.message));
  const odd = make({
    helper: {
      start: async () => {
        throw 'odd';
      },
    },
  });
  await assert.rejects(odd.by.computer_screenshot({}, ctx), /available: odd/);
});

test('a click needs an element from the list or x and y; a target the helper cannot name is refused', async () => {
  const { by } = make();
  await assert.rejects(by.computer_click({ element: 'e9' }, ctx), (e: any) => e.code === 'bad_args' && /No element e9/.test(e.message));
  await assert.rejects(by.computer_click({ x: 1 }, ctx), /Pass x and y, or element/);
  const broken = make({
    helper: {
      targetInfo: async () => {
        throw { reason: 'target_refused', message: 'no' };
      },
    },
  });
  await assert.rejects(broken.by.computer_click({ x: 1, y: 1 }, ctx), (e: any) => e.code === 'refused');
});

test('a screenshot with MoPilot in front shows the whole screen; other calls there are refused', async () => {
  const { by, calls } = make({
    grants: [{ bundleId: 'ai.mopilot.screen', level: 'view' }],
    helper: { targetInfo: async () => ({ refused: 'MoPilot' }) },
  });
  const out = await by.computer_screenshot({}, ctx);
  assert.equal(out[0].type, 'image');
  assert.deepEqual(
    calls.find((c) => c[0] === 'screenshot'),
    ['screenshot', {}],
  );
  // no pid: no glow
  assert.equal(
    calls.some((c) => c[0] === 'glowStart'),
    false,
  );
  await assert.rejects(by.computer_key({ key: 'a' }, ctx), /never controls MoPilot/);
});

test('an app the helper names partly gets sensible defaults', async () => {
  const seen: any[] = [];
  const none = make({ grants: [], answer: { decision: 'deny' }, helper: { targetInfo: async () => null } });
  await assert.rejects(none.by.computer_key({ key: 'a' }, ctx), /Couldn't tell which app/);
  const idOnly = make({ grants: [], answer: { decision: 'deny' }, helper: { targetInfo: async () => ({ bundleId: 'com.x' }) } });
  await assert.rejects(idOnly.by.computer_key({ key: 'a' }, ctx), /didn't allow controlling com.x/);
  seen.push(idOnly.asked[0][2].app);
  assert.deepEqual(seen, [{ bundleId: 'com.x', name: 'com.x' }]);
});

test('scroll and click: defaults for the distance and button; settling before the observation', async () => {
  const { by, calls, cu } = make({ settleMs: 1 });
  await by.computer_scroll({ x: 2, y: 4 }, ctx);
  assert.deepEqual(
    calls.find((c) => c[0] === 'scroll'),
    ['scroll', 2, 4, 0, 0, { bundleIds: ['com.b'] }],
  );
  await by.computer_scroll({ x: 2, y: 4, dx: 1, dy: 3 }, ctx);
  assert.deepEqual(calls.filter((c) => c[0] === 'scroll')[1].slice(3, 5), [1, 3]);
  assert.equal(cu.controlling, 'c');
});

test('the desktop: an error other than busy fails at once; release and resume edge cases', async () => {
  const { by, cu, activity } = make({
    helper: {
      acquireControl: async () => {
        throw { reason: 'target_refused', message: 'x' };
      },
    },
  });
  await assert.rejects(by.computer_key({ key: 'a' }, ctx), (e: any) => e.code === 'refused');
  await cu.release('nobody');
  cu.controlling = 'c';
  cu.helper.releaseControl = async () => {
    throw new Error('gone');
  };
  await cu.release('c');
  assert.equal(cu.controlling, null);
  assert.deepEqual(activity.at(-1), ['c', null]);
  cu.paused('takeover'); // nobody controls: nothing to show
  assert.equal(await cu.resume(''), false);
  cu.controlling = 'c';
  cu.helper.resumeControl = async () => {
    throw new Error('no');
  };
  assert.equal(await cu.resume('c'), false);
  cu.controlling = null;
  await cu.stop();
});

test('Allow once given for a later call: spent per app, the others kept', async () => {
  const { cu, by } = make({ grants: [] });
  cu.allowOnce('c', { bundleId: 'com.b' }, 'full');
  cu.allowOnce('c', { bundleId: 'com.other' }, 'view');
  cu.allowOnce('c', { bundleId: 'COM.B' }, 'full');
  assert.deepEqual(
    cu.once.get('c').map((g: any) => g.bundleId),
    ['com.other', 'COM.B'],
  );
  await by.computer_key({ key: 'a' }, ctx);
  assert.deepEqual(cu.once.get('c'), [{ bundleId: 'com.other', level: 'view' }]);
});

test('a chat without state is treated as asking; an ACP mode without anchors too', async () => {
  const { by } = make({ session: null });
  assert.equal((await by.computer_screenshot({}, ctx))[0].type, 'image');
  const acp = make({ session: { modality: 'text', acp: { modes: { currentModeId: 'm' } } } });
  const out = await acp.by.computer_screenshot({}, ctx);
  assert.match(out[0].text, /^B: 1 elements/);
});

test('observations: a screenshot without display or scale, of the whole screen for an app without a pid', async () => {
  const { by, calls, cu } = make({
    helper: {
      targetInfo: async () => ({ bundleId: 'com.b', name: 'B' }),
      screenshot: async (a: any) => (calls.push(['screenshot', a]), shot({ display: undefined, pixelsPerPoint: undefined })),
    },
  });
  await by.computer_screenshot({}, ctx);
  assert.deepEqual(
    calls.find((c) => c[0] === 'screenshot'),
    ['screenshot', {}],
  );
  assert.deepEqual(cu.view('c').geom, { x: 0, y: 0, ppp: 1 });
  const partial = make({ helper: { screenshot: async () => shot({ display: { width: 1 } }) } });
  await partial.by.computer_screenshot({}, ctx);
  assert.deepEqual(partial.cu.view('c').geom, { x: 0, y: 0, ppp: 2 });
});

test('a call that works after the guide card was shown takes the card down, back to the active bar', async () => {
  const { by, cu, activity } = make();
  cu.showPermissionGuide('c', 'accessibility');
  cu.controlling = 'c';
  cu.app = 'B';
  await by.computer_screenshot({}, ctx);
  assert.deepEqual(activity.at(-1), ['c', { app: 'B', state: 'active' }]);
  // a chat not holding the desktop just loses the card
  cu.showPermissionGuide('c', 'accessibility');
  cu.controlling = null;
  await by.computer_screenshot({}, ctx);
  assert.deepEqual(activity.at(-1), ['c', null]);
});

/* -- Check again ------------------------------------------------------ */
test('recheck: a helper that cannot answer, a permission still missing, and all granted', async () => {
  const { cu, activity } = make({
    helper: {
      permissionStatus: async () => {
        throw new Error('x');
      },
    },
  });
  assert.equal(await cu.recheck('c'), false);
  cu.helper.permissionStatus = async () => ({ accessibility: true, screenRecording: false, inputMonitoring: false });
  assert.equal(await cu.recheck('c'), false);
  assert.deepEqual(activity, [] as any[]);
  cu.showPermissionGuide('c', 'screenRecording');
  assert.equal(await cu.recheck('c'), false);
  assert.deepEqual(activity.at(-1), ['c', { app: 'your Mac', state: 'permission', permission: 'screenRecording' }]);
  cu.app = 'B';
  assert.equal(await cu.recheck('c'), false);
  assert.equal(defined(activity.at(-1))[1].app, 'B');
  // input monitoring is not needed to clear the card
  cu.helper.permissionStatus = async () => ({ accessibility: true, screenRecording: true, inputMonitoring: false });
  cu.controlling = 'c';
  assert.equal(await cu.recheck('c'), true);
  assert.deepEqual(activity.at(-1), ['c', { app: 'B', state: 'active' }]);
  cu.helper.permissionStatus = async () => null;
  assert.equal(await cu.recheck('c'), false);
  cu.showPermissionGuide('d', 'accessibility');
  assert.equal(await cu.recheck('d'), false);
  cu.helper.permissionStatus = async () => ({ accessibility: true, screenRecording: true });
  assert.equal(await cu.recheck('d'), true);
  assert.deepEqual(activity.at(-1), ['d', null]);
});

test('recheck: a helper that can read a fresh status asks for one, saying whether the desktop is held', async () => {
  const idle: boolean[] = [];
  const { cu } = make({
    helper: {
      freshPermissionStatus: async (isIdle: () => boolean) => (idle.push(isIdle()), { accessibility: true, screenRecording: true }),
    },
  });
  cu.showPermissionGuide('c', 'accessibility');
  assert.equal(await cu.recheck('c'), true);
  cu.controlling = 'c';
  assert.equal(await cu.recheck('c'), true);
  // shutting down: computer use is giving the Mac back
  cu.controlling = null;
  cu.closed = true;
  assert.equal(await cu.recheck('c'), false);
  assert.deepEqual(idle, [true, false]);
});

/* -- vision tools ----------------------------------------------------- */
function vision(o: any = {}) {
  const backend = { vendor: 'V', model: 'vm' };
  return {
    plan: async () => ({ kinds: ['elements'], ocr: false, locate: true, backend }),
    allowing: async () => (o.refuse ? { backend: null, why: 'refused' } : { backend }),
    describe: async (_b: any, _s: any, region: string) => {
      if (o.fail) throw o.fail;
      return `desc ${region ?? ''}`;
    },
    locate: async (_b: any, _s: any, query: string) => ({ text: '', point: o.point === undefined ? { x: 20, y: 20 } : o.point, query }),
  };
}

test('describe: a screenshot that fails, a vision model that fails', async () => {
  const bad = make({
    vision: vision(),
    helper: {
      screenshot: async () => {
        throw { reason: 'aborted', message: 'stop' };
      },
    },
  });
  await assert.rejects(bad.by.computer_describe({}, ctx), (e: any) => e.code === 'stopped');
  const err = make({ vision: vision({ fail: new Error('503') }) });
  await assert.rejects(err.by.computer_describe({ region: 'top' }, ctx), /couldn't read the screen: 503/);
  const odd = make({
    vision: vision({ fail: 'odd' }),
    helper: { screenshot: async () => shot({ display: undefined, pixelsPerPoint: undefined }) },
  });
  await assert.rejects(odd.by.computer_describe({}, ctx), /read the screen: odd/);
  assert.deepEqual(odd.cu.view('c').geom, { x: 0, y: 0, ppp: 1 });
  const part = make({ vision: vision(), helper: { screenshot: async () => shot({ display: {} }) } });
  assert.deepEqual(await part.by.computer_describe({}, ctx), [{ type: 'text', text: 'desc ' }]);
});

test('locate: not found; found over a listed element; a query of nothing', async () => {
  const bare = make({ vision: vision() });
  assert.deepEqual(await bare.by.computer_locate({ query: 'OK' }, ctx), [
    { type: 'text', text: 'Found at (20, 20) in pixels of the latest 100×50 screenshot.' },
  ]);
  const none = make({ vision: vision({ point: null }) });
  assert.deepEqual(await none.by.computer_locate({}, ctx), [{ type: 'text', text: 'Not found on the screen: undefined' }]);
  const { by, cu, activity } = make({ vision: vision() });
  cu.view('c').byId = new Map([['e4', { id: 'e4', frame: { x: 5, y: 5, w: 10, h: 10 } }]]);
  cu.controlling = 'c';
  assert.deepEqual(await by.computer_locate({ query: 'OK' }, ctx), [
    { type: 'text', text: 'Found at (20, 20) in pixels of the latest 100×50 screenshot; element e4.' },
  ]);
  // the chat already held the desktop: the bar stays active while the model reads
  assert.deepEqual(
    activity.map((a: any) => a[1].state),
    ['active', 'active'],
  );
});
