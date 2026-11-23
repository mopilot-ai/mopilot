// electron/capabilities/tools/desktopGate.cjs: takeover consent, the grant check before each action, the one-chat lock,
// bringing the app an action is for to the front, and hide-before-action.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NOTES, MAIL, TERMINAL, SAFARI, FINDER, MOPILOT, DISPLAY, resolveEntry, rig, rejects, activates } from './support/desktop-kit.ts';

/* -- consent and the gate ---------------------------------------------- */
test('takeover consent: asked once per chat on the first input, never before apps are granted', async () => {
  const r = rig();
  await rejects(r.call('desktop_left_click', { coordinate: [10, 10] }), 'denied', /No apps are granted/);
  assert.equal(r.asks.length, 0);
  await r.ready([NOTES]);
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  await r.call('desktop_left_click', { coordinate: [20, 10] });
  assert.deepEqual(
    r.asks.map((a: any) => a.kind),
    ['computerTakeover'],
  );
  assert.deepEqual(r.asks[0].params, {
    harness: 'claude',
    apps: [{ bundleId: 'com.apple.Notes', name: 'Notes', tier: 'full' }],
    reason: "Working in the background isn't enough for this step: it needs the real pointer and keyboard.",
  });
  // observing never asks
  const r2 = rig();
  await r2.ready([NOTES]);
  await r2.call('desktop_screenshot');
  await r2.call('desktop_cursor_position');
  await r2.call('desktop_wait', { duration: 0 });
  assert.equal(r2.asks.length, 0);
  // denied: no input, asked again next time
  r2.answers.computerTakeover = { decision: 'deny' };
  await rejects(r2.call('desktop_key', { text: 'a' }), 'denied', /didn't allow MoPilot to control the screen/);
  r2.answers.computerTakeover = null;
  await rejects(r2.call('desktop_key', { text: 'a' }), 'denied');
  assert.equal(r2.asks.length, 2);
  assert.equal(r2.callsOf('key').length, 0);
});

test('takeover: a read-only chat can only look; unattended input is refused (switched off, or no consent yet)', async () => {
  const r = rig();
  await r.ready([NOTES]);
  r.state.session = { permission: 'plan' };
  await rejects(r.call('desktop_left_click', { coordinate: [1, 1] }), 'read_only', /read-only mode/);
  r.state.session = null;
  r.state.unattended = 'no input for 10 minutes';
  r.state.unattendedAllowed = false;
  await rejects(r.call('desktop_left_click', { coordinate: [1, 1] }), 'unattended', /switched off \(no input for 10 minutes\)/);
  r.state.unattendedAllowed = true;
  await rejects(r.call('desktop_left_click', { coordinate: [1, 1] }), 'unattended', /needs the user's OK once per chat/);
  assert.deepEqual(
    r.paused.map((p: any) => p.tool),
    ['desktop_input', 'desktop_input'],
  );
  assert.equal(r.asks.length, 0);
  // with consent already given, unattended input (allowed) runs
  r.d.session('c1').consent = true;
  await r.call('desktop_left_click', { coordinate: [1, 1] });
  assert.equal(r.callsOf('click').length, 1);
  // a scheduled task with computer control off
  r.state.session = { scheduled: { computer: false } };
  await rejects(r.call('desktop_screenshot'), 'refused', /Computer control is off for this scheduled task/);
});

test('gate: screenshots work at any tier whatever is in front; input re-checks the frontmost app and its tier', async () => {
  const r = rig();
  await r.ready([SAFARI, TERMINAL, NOTES]);
  r.helper.front = FINDER;
  await r.call('desktop_screenshot');
  // keys go to the frontmost app: it must be granted at full control
  await rejects(r.call('desktop_key', { text: 'a' }), 'denied', /Finder is in front and isn't granted/);
  r.helper.front = SAFARI;
  await rejects(
    r.call('desktop_type', { text: 'hi' }),
    'tier',
    /Safari is granted at tier "read" \(View only\), which doesn't allow type \(it is the frontmost app\)\. Safari is never granted more than this, so don't ask the user for more access\. For a web page use the browser tools/,
  );
  r.helper.front = TERMINAL;
  await rejects(r.call('desktop_key', { text: 'Return' }), 'tier', /For commands use the shell tool/);
  r.helper.front = MOPILOT;
  await rejects(r.call('desktop_key', { text: 'a' }), 'refused', /MoPilot is in front, so keys and text would go to it/);
  r.helper.front = { name: 'Keychain Access', bundleId: 'com.apple.keychainaccess', refused: 'password managers' };
  await rejects(
    r.call('desktop_key', { text: 'a' }),
    'refused',
    /Keychain Access is in front, and MoPilot never controls password managers/,
  );
  r.helper.front = { refused: 'security prompts' };
  await rejects(r.call('desktop_key', { text: 'a' }), 'refused', /^security prompts is in front/);
  r.helper.front = null;
  await rejects(r.call('desktop_key', { text: 'a' }), 'denied', /The frontmost app is in front and isn't granted/);
  r.helper.front = NOTES;
  r.helper.fail.targetInfo = Object.assign(new Error('nope'), { reason: 'target_refused' });
  await rejects(r.call('desktop_key', { text: 'a' }), 'refused', /won't do that: nope/);
  assert.equal(r.callsOf('key').length, 0);
});

test('gate: a pointer action checks the app under the point as well as the frontmost one', async () => {
  const r = rig();
  await r.ready([SAFARI, TERMINAL, NOTES]);
  r.helper.at = SAFARI;
  await rejects(
    r.call('desktop_left_click', { coordinate: [10, 10] }),
    'tier',
    /Safari is granted at tier "read" \(View only\), which doesn't allow left click\./,
  );
  r.helper.at = TERMINAL;
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  await rejects(r.call('desktop_right_click', { coordinate: [10, 10] }), 'tier', /doesn't allow right click/);
  await rejects(r.call('desktop_left_click', { coordinate: [10, 10], text: 'cmd' }), 'tier', /left click/);
  r.helper.at = FINDER;
  await rejects(
    r.call('desktop_left_click', { coordinate: [10, 10] }),
    'denied',
    /That point is on Finder \(com\.apple\.finder\), which isn't granted/,
  );
  r.helper.at = {};
  await rejects(r.call('desktop_left_click', { coordinate: [10, 10] }), 'denied', /That point is on an app, which isn't granted/);
  r.helper.at = { name: 'Dock', refused: 'the Dock' };
  await rejects(r.call('desktop_left_click', { coordinate: [10, 10] }), 'refused', /That point is on Dock, which MoPilot never controls/);
  r.helper.at = { refused: 'the menu bar' };
  await rejects(r.call('desktop_left_click', { coordinate: [10, 10] }), 'refused', /on the menu bar/);
  // the point is fine but the frontmost app is not granted
  r.helper.at = NOTES;
  r.helper.front = FINDER;
  await rejects(
    r.call('desktop_left_click', { coordinate: [10, 10] }),
    'denied',
    /Finder is in front and isn't granted.*desktop_open_application first/,
  );
  r.helper.front = null;
  await rejects(r.call('desktop_left_click', { coordinate: [10, 10] }), 'denied', /The frontmost app is in front/);
  // MoPilot in front: a click on a granted app's window brings that app forward
  r.helper.front = MOPILOT;
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  r.helper.targetInfo = async (p: any) => {
    if (p) throw Object.assign(new Error('gone'), { reason: 'x' });
    return NOTES;
  };
  await rejects(r.call('desktop_left_click', { coordinate: [10, 10] }), 'failed', /gone/);
  assert.equal(r.callsOf('click').length, 2);
});

/* -- the lock ----------------------------------------------------------- */
test('lock: one chat controls the desktop; another is refused at once with busy, not queued', async () => {
  const r = rig();
  await r.ready([NOTES]);
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  assert.equal(r.cu.controlling, 'c1');
  assert.deepEqual(r.callsOf('acquireControl')[0].args, ['chat c1']);
  assert.deepEqual(r.activity.at(-1), ['c1', { app: 'Notes', state: 'active' }]);
  await r.grant([NOTES], 'c2');
  r.d.session('c2').consent = true;
  r.d.session('c2').geom = r.d.session('c1').geom;
  await rejects(r.call('desktop_left_click', { coordinate: [10, 10] }, { chatId: 'c2' }), 'busy', /Another chat is controlling this Mac/);
  assert.equal(r.callsOf('acquireControl').length, 1);
  assert.equal(r.callsOf('click').length, 1);
});

test('lock: held by another profile or app; a helper failure gives the lock back', async () => {
  const r = rig();
  await r.ready([NOTES]);
  r.helper.fail.acquireControl = Object.assign(new Error('the desktop is in use by MoPilot (work profile)'), { reason: 'lock_busy' });
  await rejects(
    r.call('desktop_left_click', { coordinate: [10, 10] }),
    'busy',
    /The desktop is in use by MoPilot \(work profile\)\. Only one controller at a time/,
  );
  assert.equal(r.cu.controlling, null);
  r.helper.fail.acquireControl = Object.assign(new Error('socket closed'), { reason: 'other' });
  await rejects(r.call('desktop_left_click', { coordinate: [10, 10] }), 'failed', /socket closed/);
  assert.equal(r.cu.controlling, null);
  // someone else took it meanwhile: not cleared
  r.helper.fail.acquireControl = () => {
    r.cu.controlling = 'c9';
    return Object.assign(new Error('x'), { reason: 'lock_busy' });
  };
  await rejects(r.call('desktop_left_click', { coordinate: [10, 10] }), 'busy');
  assert.equal(r.cu.controlling, 'c9');
});

test('lock: moving to another granted app renames the activity bar, unless a take-over or reading note shows', async () => {
  const r = rig();
  await r.ready([NOTES, MAIL]);
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  r.helper.front = MAIL;
  r.helper.at = MAIL;
  r.cu.session = () => ({ computer: { state: 'active', app: 'Notes' } });
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  assert.equal(r.cu.app, 'Mail');
  assert.deepEqual(r.activity.at(-1), ['c1', { app: 'Mail', state: 'active' }]);
  const n = r.activity.length;
  r.helper.front = NOTES;
  r.helper.at = NOTES;
  r.cu.session = () => ({ computer: { state: 'takeover', app: 'Mail' } });
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  assert.equal(r.cu.app, 'Notes');
  assert.equal(r.activity.length, n, 'the take-over stays on the bar');
  r.helper.front = MAIL;
  r.helper.at = MAIL;
  r.cu.session = () => ({ computer: { state: 'active', read: 'ocr' } });
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  assert.equal(r.activity.length, n);
  r.cu.session = () => ({});
  r.helper.front = NOTES;
  r.helper.at = NOTES;
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  assert.deepEqual(r.activity.at(-1), ['c1', { app: 'Notes', state: 'active' }]);
  // the same app: nothing changes
  const m = r.activity.length;
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  assert.equal(r.activity.length, m);
  // a coordinator without session(): the bar is updated
  delete r.cu.session;
  r.cu.session = undefined;
  r.helper.front = MAIL;
  r.helper.at = MAIL;
  await r.d.acquire('c1', 'Mail');
  assert.deepEqual(r.activity.at(-1), ['c1', { app: 'Mail', state: 'active' }]);
  await r.d.acquire('c1', null);
  assert.equal(r.cu.app, 'Mail');
});

/* -- the app in front, hide-before-action -------------------------------- */

test('activation: keys go to the app of the latest screenshot, brought forward when another app is in front', async () => {
  const r = rig();
  await r.ready([NOTES, MAIL]);
  activates(r);
  r.helper.front = FINDER;
  const out = await r.json('desktop_key', { text: 'a' });
  assert.deepEqual(r.callsOf('openApp')[0].args, ['com.apple.Notes', { bundleIds: ['com.apple.Notes'] }]);
  assert.equal(out.app, 'Notes');
  assert.equal(r.cu.controlling, 'c1', 'the desktop is taken before anything comes forward');
  // MoPilot in front: the same
  r.helper.front = MOPILOT;
  await r.call('desktop_type', { text: 'x' });
  assert.equal(r.callsOf('openApp').length, 2);
  // a granted app in front: nothing is brought forward, and it is the app keys go to from now on
  r.helper.front = MAIL;
  await r.call('desktop_key', { text: 'b' });
  assert.equal(r.callsOf('openApp').length, 2);
  r.helper.front = FINDER;
  await r.call('desktop_key', { text: 'c' });
  assert.equal(r.callsOf('openApp').at(-1).args[0], 'com.apple.mail');
  // an app that fails to open: refused as before, never acted on
  r.helper.openApp = async (...args: any[]) => {
    r.helper.calls.push({ method: 'openApp', args });
    throw new Error('nope');
  };
  r.helper.front = FINDER;
  await rejects(r.call('desktop_key', { text: 'd' }), 'denied', /Finder is in front and isn't granted/);
  assert.deepEqual(
    r.callsOf('key').map((c: any) => c.args[0]),
    ['a', 'b', 'c'],
  );
  // nothing seen yet: nothing to bring forward
  const none = rig();
  await none.grant([NOTES]);
  none.helper.front = FINDER;
  await rejects(none.call('desktop_key', { text: 'a' }), 'denied', /Finder is in front/);
  assert.equal(none.callsOf('openApp').length, 0);
  // the last app at too weak a tier for keys isn't brought forward
  const t = rig();
  await t.ready([TERMINAL]);
  assert.equal(t.d.session('c1').lastApp, 'com.apple.Terminal', 'the only app shown');
  t.helper.front = FINDER;
  await rejects(t.call('desktop_key', { text: 'a' }), 'denied', /Finder is in front/);
  assert.equal(t.callsOf('openApp').length, 0);
});

test('activation: an app named for keys comes forward first; an app not granted, or one that stays behind, is refused', async () => {
  const r = rig();
  await r.ready([NOTES, MAIL]);
  activates(r);
  assert.equal((await r.json('desktop_type', { text: 'hi', app: 'Mail' })).app, 'Mail');
  assert.deepEqual(r.callsOf('openApp')[0].args, ['com.apple.mail', { bundleIds: ['com.apple.mail'] }]);
  // already in front: nothing to do
  await r.call('desktop_key', { text: 'a', app: 'com.apple.mail' });
  await r.call('desktop_hold_key', { text: 'shift', duration: 0, app: 'mail' });
  assert.equal(r.callsOf('openApp').length, 1);
  await rejects(r.call('desktop_key', { text: 'a', app: 'Ghost' }), 'denied', /Ghost isn't granted in this chat/);
  r.helper.openApp = async () => ({ frontmost: false });
  await rejects(r.call('desktop_key', { text: 'a', app: 'Notes' }), 'denied', /Notes didn't come to the front \(Mail is in front\)/);
  // an empty name names nothing
  await r.call('desktop_key', { text: 'a', app: '' });
  await r.call('desktop_key', { text: 'a', app: null });
  assert.equal(r.callsOf('key').length, 3);
});

test("activation: a click on a granted app's window brings it forward when another app is in front", async () => {
  const r = rig();
  await r.ready([NOTES]);
  activates(r);
  r.helper.front = FINDER;
  r.helper.at = NOTES;
  assert.equal((await r.json('desktop_left_click', { coordinate: [10, 10] })).app, 'Notes');
  assert.deepEqual(r.callsOf('openApp')[0].args[0], 'com.apple.Notes');
  assert.equal(r.callsOf('click').length, 1);
});

test('screenshot: the app keys go to is the frontmost granted one, else the only one shown; opening an app sets it too', async () => {
  const r = rig();
  await r.grant([NOTES, MAIL]);
  r.helper.front = FINDER;
  r.helper.shot = () => ({ jpeg: 'J', width: 1000, height: 500, pixelsPerPoint: 0.5, display: DISPLAY, included: ['com.apple.mail'] });
  const out = await r.call('desktop_screenshot');
  assert.equal(r.d.session('c1').lastApp, 'com.apple.mail');
  assert.match(out[1].text, /Finder is in front and isn't granted; input brings Mail forward first\./);
  r.helper.shot = () => ({
    jpeg: 'J',
    width: 1000,
    height: 500,
    pixelsPerPoint: 0.5,
    display: DISPLAY,
    included: ['com.apple.Notes', 'com.apple.mail'],
  });
  await r.call('desktop_screenshot');
  assert.equal(r.d.session('c1').lastApp, 'com.apple.mail', 'two shown, none in front: unchanged');
  await r.call('desktop_open_application', { app: 'Notes' });
  assert.equal(r.d.session('c1').lastApp, 'com.apple.Notes');
  const fresh = rig();
  await fresh.grant([NOTES, MAIL]);
  fresh.helper.front = FINDER;
  assert.match(
    (await fresh.call('desktop_screenshot'))[1].text,
    /Finder is in front and isn't granted; bring a granted app forward with desktop_open_application/,
  );
  assert.equal(fresh.d.session('c1').lastApp, null);
});

test('hide before action: MoPilot and the apps that are not granted hide while the chat holds the desktop, and come back', async () => {
  const host = {
    hides: 0,
    shown: [] as boolean[],
    hide() {
      this.hides++;
      return true;
    },
    show(f: boolean) {
      this.shown.push(f);
    },
  };
  const r = rig({ hide: true, host });
  await r.ready([NOTES, MAIL]);
  r.d.session('c1').consent = true;
  r.helper.hidden = [
    { pid: 30, bundleId: 'com.tinyspeck.slackmacgap', name: 'Slack' },
    { pid: 31, bundleId: 'com.apple.Safari', name: 'Safari' },
    { name: 'no pid' },
    null,
  ];
  r.helper.front = FINDER;
  r.helper.at = NOTES;
  activates(r);
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  assert.deepEqual(r.callsOf('hideOthers')[0].args, [['com.apple.Notes', 'com.apple.mail']]);
  assert.equal(host.hides, 1);
  assert.deepEqual(r.d.screen.previous, { pid: 11, host: false });
  assert.deepEqual(
    r.d.screen.hidden.map((h: any) => h.pid),
    [30, 31],
  );
  assert.equal(r.cu.app, 'Notes');
  // later input hides nothing more
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  assert.equal(r.callsOf('hideOthers').length, 1);
  assert.equal(host.hides, 1);
  // a card brings MoPilot's windows back (focused); the next input hides them again
  await r.call('desktop_left_click', { element_index: 1 });
  assert.deepEqual(
    r.asks.map((a: any) => a.kind),
    ['computerConfirm'],
  );
  assert.deepEqual(host.shown, [true]);
  assert.equal(host.hides, 2);
  // Safari is granted now: it is shown again
  r.helper.resolved.set('Safari', resolveEntry(SAFARI));
  await r.call('desktop_request_access', { apps: ['Safari'], reason: 'r' });
  assert.deepEqual(r.callsOf('restoreApps')[0].args, [[31]]);
  assert.deepEqual(
    r.d.screen.hidden.map((h: any) => h.pid),
    [30],
  );
  assert.deepEqual(host.shown, [true, true]);
  // granting an app that wasn't hidden, or nothing at all, shows nothing
  r.helper.resolved.set('Terminal', resolveEntry(TERMINAL));
  await r.call('desktop_request_access', { apps: ['Terminal'], reason: 'r' });
  r.answers.computerAccessSet = { decision: 'deny' };
  r.helper.resolved.set('Finder', resolveEntry(FINDER));
  await r.call('desktop_request_access', { apps: ['Finder'], reason: 'r' });
  assert.equal(r.callsOf('restoreApps').length, 1);
  // the turn ends: the hidden apps come back and Finder is in front again; the windows are already shown
  await r.d.turnEnded('c1');
  assert.deepEqual(r.callsOf('restoreApps')[1].args, [[30], 11]);
  assert.deepEqual(host.shown, [true, true]);
  assert.equal(r.d.screen, null);
  await r.d.turnEnded('c1');
  assert.equal(r.callsOf('restoreApps').length, 2, 'once');
});

test('hide before action: MoPilot in front before comes back focused; a stopped helper; failures hide nothing', async () => {
  const host = {
    shown: [] as boolean[],
    hide: () => true,
    show(f: boolean) {
      this.shown.push(f);
    },
  };
  const r = rig({ hide: true, host });
  await r.ready([NOTES]);
  r.helper.front = MOPILOT;
  r.helper.at = NOTES;
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  assert.deepEqual(r.d.screen.previous, { pid: 1, host: true });
  await r.d.turnEnded('c1');
  assert.equal(r.callsOf('restoreApps').length, 0, 'nothing hidden, and MoPilot is not activated by the helper');
  assert.deepEqual(host.shown, [true]);
  // hidden apps, Finder in front before, a stopped (crashed) helper: a relaunched one shows them again; the windows come back unfocused
  r.helper.hidden = [{ pid: 30, bundleId: 'x.y' }];
  r.helper.front = FINDER;
  activates(r);
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  r.helper.running = false;
  const starts = r.callsOf('start').length;
  await r.d.turnEnded('c1');
  assert.equal(r.callsOf('start').length, starts + 1);
  assert.deepEqual(r.callsOf('restoreApps')[0].args[0], [30]);
  assert.deepEqual(host.shown, [true, false]);
  r.helper.running = true;
  // a host that fails to hide or show, a helper without hideOthers, no frontmost app known
  const bad = rig({
    hide: true,
    host: {
      hide: () => {
        throw new Error('x');
      },
      show: () => {
        throw new Error('y');
      },
    },
  });
  await bad.ready([NOTES]);
  bad.helper.hideOthers = async () => ({ hidden: 'odd' });
  bad.helper.front = { name: 'Nobody' };
  bad.helper.at = NOTES;
  await rejects(bad.call('desktop_left_click', { coordinate: [10, 10] }), 'denied', /Nobody is in front/);
  assert.deepEqual(bad.d.screen, { chatId: 'c1', previous: null, hidden: [], others: true, hostHidden: false });
  bad.d.screen.hostHidden = true;
  bad.d.revealHost();
  assert.equal(bad.d.screen.hostHidden, false);
  bad.d.screen.previous = { pid: 1, host: true };
  await bad.d.turnEnded('c1');
  assert.equal(bad.d.screen, null);
  const failing = rig({ hide: true });
  await failing.ready([NOTES]);
  failing.helper.fail.hideOthers = new Error('old helper');
  failing.helper.fail.restoreApps = new Error('gone');
  let first = true;
  failing.helper.targetInfo = async (p: any) => {
    failing.helper.calls.push({ method: 'targetInfo', args: [p] });
    if (!p && first) {
      first = false;
      throw new Error('t');
    }
    return NOTES;
  };
  await failing.call('desktop_left_click', { coordinate: [10, 10] });
  assert.deepEqual(failing.d.screen, { chatId: 'c1', previous: null, hidden: [], others: true, hostHidden: false });
  failing.d.screen.hidden = [{ pid: 9, bundleId: 'com.apple.mail' }];
  failing.helper.resolved.set('Mail', resolveEntry(MAIL));
  await failing.call('desktop_request_access', { apps: ['Mail'], reason: 'r' });
  await failing.d.turnEnded('c1');
  // no host at all, and a stale hold of another chat whose hidden apps carry over
  const bare = rig({ hide: true });
  await bare.ready([NOTES]);
  bare.d.screen = { chatId: 'old', previous: null, hidden: [{ pid: 5, bundleId: 'a.b' }], others: true, hostHidden: false };
  await bare.call('desktop_left_click', { coordinate: [10, 10] });
  assert.deepEqual(
    bare.d.screen.hidden.map((h: any) => h.pid),
    [5],
  );
  bare.d.revealHost();
  await bare.d.unhide('other', ['a.b']);
  bare.d.session('c9');
  await bare.d.forget('c9');
  assert.ok(!bare.ended.includes('c9'), "another chat's hold is not this one's");
  await bare.d.forget('c1');
  assert.deepEqual(bare.callsOf('restoreApps').at(-1).args, [[5], 7]);
  // a takeover card brings the windows back too
  const t = rig({ hide: true, host });
  await t.grant([NOTES]);
  await t.call('desktop_screenshot');
  t.d.screen = { chatId: 'c1', previous: null, hidden: [], others: true, hostHidden: true };
  await t.call('desktop_key', { text: 'a' });
  assert.deepEqual(
    t.asks.map((a: any) => a.kind),
    ['computerAccessSet', 'computerTakeover'],
  );
  assert.equal(host.shown.at(-1), true);
});

test('hide before action: apps that fail to come back still let MoPilot show its windows again', async () => {
  const host = {
    shown: [] as boolean[],
    hide: () => true,
    show(f: boolean) {
      this.shown.push(f);
    },
  };
  const r = rig({ hide: true, host });
  await r.ready([NOTES]);
  r.helper.hidden = [{ pid: 30, bundleId: 'x.y' }];
  r.helper.at = NOTES;
  await r.call('desktop_left_click', { coordinate: [10, 10] });
  r.helper.fail.restoreApps = new Error('the apps quit');
  await r.d.turnEnded('c1');
  assert.deepEqual(r.callsOf('restoreApps')[0].args, [[30], 7]);
  assert.equal(r.d.screen, null);
  assert.deepEqual(host.shown, [false]);
});
