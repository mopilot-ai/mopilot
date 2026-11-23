// A desktop_* call that fails for a missing macOS permission asks macOS once, waits (bounded) for the grant and, for a
// call that only looks, runs again by itself; input is never replayed. Also the shared askPermission/waitForPermission
// on the coordinator and the onboarding text that points the model to the card instead of Settings steps.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import edition from '../shared/edition.json' with { type: 'json' };
import { rig, NOTES, rejects, onboarding } from './support/desktop-kit.ts';
import { rig as appRig, helperFailure } from './support/app-scoped-kit.ts';

const denied = (permission: string) => Object.assign(new Error(`${permission} permission not granted`), { reason: 'permission_denied' });
/** The helper fails the next `method` call once, as macOS would before the grant. */
const failOnce = (r: any, method: string, permission: string) => {
  r.helper.fail[method] = () => {
    delete r.helper.fail[method];
    return denied(permission);
  };
};

test('a screenshot that fails for a missing permission asks macOS once, then runs again and clears the card', async () => {
  const r = rig();
  await r.ready([NOTES]);
  const asked: string[] = [];
  r.helper.requestPermission = async (kind: string) => (asked.push(kind), { screenRecording: true, accessibility: true });
  failOnce(r, 'screenshot', 'screenRecording');
  const out = await r.call('desktop_screenshot');
  assert.ok(out.length > 0);
  assert.deepEqual(asked, ['screenRecording']);
  assert.equal(r.cu.hasPermissionGuide('c1'), false, 'the successful rerun takes the card down');
  // asked once while the coordinator lives: a later miss shows the card and does not prompt again
  failOnce(r, 'screenshot', 'screenRecording');
  await r.call('desktop_screenshot').catch(() => {});
  assert.deepEqual(asked, ['screenRecording']);
});

test('while macOS has not been answered the call waits for the grant, then runs again', async () => {
  const r = rig();
  await r.ready([NOTES]);
  r.helper.requestPermission = async () => ({ accessibility: false, screenRecording: true });
  const waits: string[] = [];
  r.cu.waitForPermission = async (chatId: string, _owner: unknown, permission: string) => (waits.push(`${chatId}:${permission}`), true);
  failOnce(r, 'screenshot', 'accessibility');
  assert.ok((await r.call('desktop_screenshot')).length > 0);
  assert.deepEqual(waits, ['c1:accessibility']);
});

test('a granted permission does not replay input: the call fails telling the model to run it again, and the card goes', async () => {
  const r = rig();
  await r.ready([NOTES]);
  r.helper.requestPermission = async () => ({ accessibility: true, screenRecording: true });
  failOnce(r, 'key', 'accessibility');
  await rejects(r.call('desktop_key', { text: 'a' }), 'permission_granted', /allows Accessibility\. Call desktop_key again\./);
  assert.equal(r.callsOf('key').length, 1, 'the key was not sent again');
  assert.equal(r.cu.hasPermissionGuide('c1'), false);
});

test('not granted in time, or macOS could not be asked: the card stays and the call fails with the onboarding text', async () => {
  const r = rig();
  await r.ready([NOTES]);
  r.helper.requestPermission = async () => ({ accessibility: false });
  r.cu.waitForPermission = async () => false;
  failOnce(r, 'screenshot', 'accessibility');
  await rejects(r.call('desktop_screenshot'), 'permission', /permission card in this chat/);
  assert.equal(r.cu.hasPermissionGuide('c1'), true);
  // macOS could not be asked: nothing to wait for
  const r2 = rig();
  await r2.ready([NOTES]);
  r2.helper.requestPermission = async () => {
    throw new Error('helper gone');
  };
  let waited = false;
  r2.cu.waitForPermission = async () => ((waited = true), true);
  failOnce(r2, 'screenshot', 'accessibility');
  await rejects(r2.call('desktop_screenshot'), 'permission');
  assert.equal(waited, false);
});

test('an unattended chat and a stopped call never prompt', async () => {
  const r = rig();
  await r.ready([NOTES]);
  let asked = 0;
  r.helper.requestPermission = async () => (asked++, { accessibility: true });
  r.state.unattended = 'the screen is locked';
  failOnce(r, 'screenshot', 'accessibility');
  await rejects(r.call('desktop_screenshot'), 'permission');
  assert.equal(asked, 0, 'nobody is there to answer a system dialog');
  // the call was stopped while the card was raised
  r.state.unattended = null;
  r.cu.permissionMayAct = () => false;
  failOnce(r, 'screenshot', 'accessibility');
  await r.call('desktop_screenshot').catch(() => {});
  assert.equal(asked, 0);
});

test('a grant that lands while the call waits is not lost when the card was raised by another request', async () => {
  const r = rig();
  await r.ready([NOTES]);
  r.helper.requestPermission = async () => ({ accessibility: false });
  // the user pressed Try again meanwhile: the card is gone, which counts as granted
  r.cu.waitForPermission = r.cu.constructor.prototype.waitForPermission;
  failOnce(r, 'screenshot', 'accessibility');
  r.helper.requestPermission = async () => {
    r.cu.blocked.delete('c1');
    return { accessibility: false };
  };
  assert.ok((await r.call('desktop_screenshot')).length > 0);
});

/* -- the coordinator ----------------------------------------------------- */
test('askPermission: one native prompt per permission shared by every chat; a failed ask is forgotten', async () => {
  const r = rig();
  let calls = 0;
  r.helper.requestPermission = async () => (calls++, { accessibility: true });
  const [a, b] = await Promise.all([r.cu.askPermission('accessibility'), r.cu.askPermission('accessibility')]);
  assert.equal(calls, 1);
  assert.deepEqual(a, b);
  r.helper.requestPermission = async () => {
    throw new Error('no helper');
  };
  assert.equal(await r.cu.askPermission('screenRecording'), null);
  assert.equal(r.cu.permissionRequests.has('screenRecording'), false, 'the next call asks again');
});

test('waitForPermission: true on a reported grant or when the card was cleared; false on timeout, a read error, a stop or shutdown', async () => {
  const r = rig();
  const owner = () => r.cu.permissionOwner('c1');
  const guide = () => r.cu.showPermissionGuide('c1', 'accessibility');
  const fast = { timeoutMs: 200, everyMs: 1 };
  // granted on the third read
  guide();
  let reads = 0;
  r.helper.permissionStatus = async () => ({ accessibility: ++reads >= 3 });
  assert.equal(await r.cu.waitForPermission('c1', owner(), 'accessibility', fast), true);
  assert.equal(reads, 3);
  // the card was cleared (Try again): nothing left to wait for
  r.cu.blocked.delete('c1');
  assert.equal(await r.cu.waitForPermission('c1', owner(), 'accessibility', fast), true);
  // never granted: gives up at the bound
  guide();
  r.helper.permissionStatus = async () => ({ accessibility: false });
  assert.equal(await r.cu.waitForPermission('c1', owner(), 'accessibility', { timeoutMs: 5, everyMs: 1 }), false);
  // a read that fails ends the wait
  r.helper.permissionStatus = async () => {
    throw new Error('helper gone');
  };
  assert.equal(await r.cu.waitForPermission('c1', owner(), 'accessibility', fast), false);
  // Screen Recording reads through a fresh helper process when the helper offers one
  r.helper.freshPermissionStatus = async () => ({ screenRecording: true });
  assert.equal(await r.cu.waitForPermission('c1', owner(), 'screenRecording', fast), true);
  // shutdown ends it
  const live = owner();
  r.cu.closed = true;
  assert.equal(await r.cu.waitForPermission('c1', live, 'accessibility', fast), false);
});

test('onboarding points the model to the card instead of Settings steps', () => {
  const text = onboarding('accessibility', { name: 'H', bundleId: 'b.id', path: '/bundled/H.app' });
  assert.ok(text.includes('"H" (b.id, /bundled/H.app)'));
  assert.match(text, /permission card in this chat \(Request, Open System Settings, Try again; pane x-apple/);
  assert.match(text, /do not write Settings steps for the user/);
  assert.doesNotMatch(text, /Ask the user to open System Settings/);
  assert.ok(onboarding('accessibility').includes(`(${edition.desktop.appId}.computer-use)`));
});

/* -- desktop_app_* (the background tools take the same road) --------------- */
test('desktop_app_screenshot: a missing Screen Recording asks macOS once, then looks again by itself', async () => {
  const r = appRig();
  r.cu.helper = r.helper; // the coordinator asks macOS through its own helper handle
  const asked: string[] = [];
  r.helper.requestPermission = async (kind: string) => (asked.push(kind), { screenRecording: true });
  let failed = false;
  const real = r.helper.fail;
  r.helper.fail = new Proxy(real, {
    get: (t: any, k: string) =>
      k === 'app.screenshot' && !failed
        ? ((failed = true), helperFailure('permission_denied', 'screenRecording permission not granted'))
        : t[k],
  });
  const out = await r.call('desktop_app_screenshot', { app: 'Notes' });
  assert.equal(out[0].type, 'image');
  assert.deepEqual(asked, ['screenRecording']);
  assert.equal(r.cu.hasPermissionGuide('c1'), false);
});

test('desktop_app_screenshot: when the grant does not come the second failure is the answer, with the card up', async () => {
  const r = appRig();
  r.cu.helper = r.helper; // the coordinator asks macOS through its own helper handle
  r.helper.requestPermission = async () => ({ screenRecording: false });
  r.cu.waitForPermission = async () => false;
  r.helper.fail['app.screenshot'] = helperFailure('permission_denied', 'screenRecording permission not granted');
  await rejects(r.call('desktop_app_screenshot', { app: 'Notes' }), 'permission', /permission card in this chat/);
  assert.ok(r.cu.hasPermissionGuide('c1'));
});

test('a grant that lands after the call was stopped never replays it, and the card keeps its owner', async () => {
  const r = rig();
  await r.ready([NOTES]);
  r.helper.requestPermission = async () => ({ accessibility: true });
  failOnce(r, 'screenshot', 'accessibility');
  const original = r.cu.permissionLive.bind(r.cu);
  r.cu.permissionLive = () => false;
  await rejects(r.call('desktop_screenshot'), 'permission');
  r.cu.permissionLive = original;
  assert.equal(r.callsOf('screenshot').length, 1);
});

test('a call that still fails after the grant is not run a third time: the second refusal is the answer', async () => {
  const r = rig();
  await r.ready([NOTES]);
  r.helper.requestPermission = async () => ({ screenRecording: true });
  r.helper.fail.screenshot = denied('screenRecording');
  await rejects(r.call('desktop_screenshot'), 'permission');
  assert.equal(r.callsOf('screenshot').length, 2, 'once, and once more after the grant');
  const app = appRig();
  app.cu.helper = app.helper;
  app.helper.requestPermission = async () => ({ screenRecording: true });
  app.helper.fail['app.screenshot'] = helperFailure('permission_denied', 'screenRecording permission not granted');
  await rejects(app.call('desktop_app_screenshot', { app: 'Notes' }), 'permission');
  assert.equal(app.helper.calls.filter((c: any) => c.method === 'app.screenshot').length, 2);
});

test('awaitGrant: only the call that raised the prompt waits; a later miss fails at once instead of waiting again', async () => {
  const r = rig();
  r.helper.requestPermission = async () => ({ accessibility: false });
  const waits: string[] = [];
  r.cu.waitForPermission = async (_c: string, _o: unknown, permission: string) => (waits.push(permission), false);
  assert.equal(await r.cu.awaitGrant('c1', {}, 'accessibility'), false);
  assert.equal(await r.cu.awaitGrant('c2', {}, 'accessibility'), false);
  assert.deepEqual(waits, ['accessibility'], 'asked and answered once: the second chat does not wait');
  r.helper.requestPermission = async () => ({ screenRecording: true });
  assert.equal(await r.cu.awaitGrant('c1', {}, 'screenRecording'), true, 'an answer that already says granted needs no wait');
});

test('waitForPermission reads a grant without relaunching the helper unless it is Screen Recording', async () => {
  const r = rig();
  const fast = { timeoutMs: 200, everyMs: 1 };
  r.cu.showPermissionGuide('c1', 'accessibility');
  const owner = r.cu.permissionOwner('c1');
  let fresh = 0;
  r.helper.freshPermissionStatus = async () => (fresh++, { screenRecording: true, accessibility: true });
  r.helper.permissionStatus = async () => ({ accessibility: true, screenRecording: false });
  assert.equal(await r.cu.waitForPermission('c1', owner, 'accessibility', fast), true);
  assert.equal(fresh, 0, 'Accessibility never relaunches the helper');
  // no fresh read on offer: Screen Recording reads the running helper
  delete r.helper.freshPermissionStatus;
  r.helper.permissionStatus = async () => ({ screenRecording: true });
  assert.equal(await r.cu.waitForPermission('c1', owner, 'screenRecording', fast), true);
});

test('waitForPermission: a Try again that still finds it off ends the wait with the card kept', async () => {
  const r = rig();
  r.cu.showPermissionGuide('c1', 'accessibility');
  const owner = r.cu.permissionOwner('c1');
  r.helper.permissionStatus = async () => ({ accessibility: false });
  // the user presses Try again meanwhile: it reads the permission off and re-raises the card
  setTimeout(() => r.cu.showPermissionGuide('c1', 'accessibility', r.cu.permissionOwner('c1')), 5);
  assert.equal(await r.cu.waitForPermission('c1', owner, 'accessibility', { timeoutMs: 5000, everyMs: 2 }), false);
  assert.equal(r.cu.hasPermissionGuide('c1'), true);
});
