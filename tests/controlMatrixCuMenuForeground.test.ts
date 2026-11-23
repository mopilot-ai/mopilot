// Control matrix (group D) and unit cases: desktop_app_menu's brief-foreground rung (appScopedBatch.cjs menuInForeground, #3571 G7 CM-D21): an item an app keeps
// disabled while it isn't active (TextEdit's File > Export as PDF) is pressed once more with the app briefly in front,
// the rung is remembered for the app, and the setting, the tier and other failures keep the background answer; and
// desktop_app_script's unwrapping of a redundant `tell application "<this app>"` (appScopedScript.cjs unwrapTell).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { helperFailure, rig, rejects } from './support/app-scoped-kit.ts';

export const GUARDS = ['electron/capabilities/', 'native/helper/'];

const require = createRequire(import.meta.url);
const L = require('../electron/capabilities/tools/appScopedLadder.cjs');
const { unwrapTell } = require('../electron/capabilities/tools/appScopedScript.cjs');

function ladder(allowed = true) {
  const rungs: Record<string, string> = {};
  const remembered: any[] = [];
  return {
    rungs,
    remembered,
    allowed: () => allowed,
    rung: (bundleId: string, action: string) => rungs[`${bundleId.toLowerCase()}:${action}`] ?? 'background',
    remember(app: any, action: string, rung: string) {
      remembered.push([app.bundleId, action, rung]);
      rungs[`${app.bundleId.toLowerCase()}:${action}`] = rung;
      return true;
    },
  };
}

const PATH = ['File', 'Export as PDF…'];
const disabled = () => helperFailure('menu_disabled', 'disabled');

/** A rig whose app keeps the item disabled in the background and enables it in front (`front` answers that press). */
function menuRig(l: any, front: any = { ok: true, route: 'ax', foreground: { activated: true, restored: true, userTookOver: false } }) {
  const r = rig({ apps: { ladder: l } });
  r.helper.answers['app.menuRefresh'] = () => ({ ok: true, refreshed: true });
  r.helper.answers['app.menu'] = (p: any) => {
    if (!p.foreground) throw disabled();
    if (typeof front === 'function') return front(p);
    return front;
  };
  return r;
}

test('menu is an action the brief-foreground rung may retry, named as menu commands', () => {
  assert.equal(L.mayForeground({ allowed: () => true }, { tier: 'full' }, 'menu'), true);
  assert.equal(L.mayForeground({ allowed: () => true }, { tier: 'click' }, 'menu'), false);
  assert.match(L.foregroundNote('TextEdit', 'menu'), /^TextEdit needs brief foreground for menu commands:/);
});

test('CM-D24: a disabled item is pressed once more in brief foreground, recorded and remembered; the next press goes straight there', async () => {
  const l = ladder();
  const r = menuRig(l);
  const out = JSON.parse((await r.call('desktop_app_menu', { app: 'Notes', path: PATH }))[0].text);
  assert.deepEqual(out, {
    action: 'menu',
    effect: 'confirmed',
    route: 'ax',
    app: 'Notes',
    path: 'File > Export as PDF…',
    rung: 'foreground',
    background_effect: 'disabled',
    ladder:
      'Notes needs brief foreground for menu commands: it was brought to the front for this action, then the previous app and pointer were restored.',
  });
  assert.deepEqual(
    r.callsOf('app.menu').map((c: any) => c.params.foreground ?? false),
    [false, true],
  );
  assert.deepEqual(r.last('app.menu').path, PATH);
  assert.deepEqual(l.remembered, [['com.apple.Notes', 'menu', 'foreground']]);
  // remembered: no background refresh or press first
  r.helper.calls.length = 0;
  const again = JSON.parse((await r.call('desktop_app_menu', { app: 'Notes', path: PATH }))[0].text);
  assert.equal(again.rung, 'foreground');
  assert.equal(again.background_effect, undefined);
  assert.deepEqual(
    r.helper.calls.filter((c: any) => c.method.startsWith('app.menu')).map((c: any) => c.method),
    ['app.menu'],
  );
});

test('the user touching the mouse meanwhile is said; a press that did nothing is ineffective and not remembered', async () => {
  const took = menuRig(ladder(), { ok: true, foreground: { userTookOver: true } });
  const t = JSON.parse((await took.call('desktop_app_menu', { app: 'Notes', path: PATH }))[0].text);
  assert.match(t.ladder, /The user used the mouse or keyboard meanwhile/);
  const l = ladder();
  const none = menuRig(l, { ok: false });
  const n = JSON.parse((await none.call('desktop_app_menu', { app: 'Notes', path: PATH }))[0].text);
  assert.equal(n.effect, 'ineffective');
  assert.deepEqual(l.remembered, []);
});

test('still disabled in front, the setting off, or another failure: the background answer stands', async () => {
  const still = menuRig(ladder(), () => {
    throw disabled();
  });
  await rejects(still.call('desktop_app_menu', { app: 'Notes', path: PATH }), 'disabled', /refreshed the menu first/);
  const off = menuRig(ladder(false));
  await rejects(off.call('desktop_app_menu', { app: 'Notes', path: PATH }), 'disabled');
  assert.equal(off.callsOf('app.menu').filter((c: any) => c.params.foreground).length, 0);
  const other = rig({ apps: { ladder: ladder() } });
  other.helper.answers['app.menuRefresh'] = () => ({ refreshed: true });
  other.helper.fail['app.menu'] = helperFailure('unsupported', 'unsupported(submenu): x');
  await rejects(other.call('desktop_app_menu', { app: 'Notes', path: PATH }), 'unsupported');
  assert.equal(other.callsOf('app.menu').length, 1);
});

test('unwrapTell: a tell to this app (by name or id, block or one line) is unwrapped; anything else is left for the check', () => {
  const app = { name: 'TextEdit', bundleId: 'com.apple.TextEdit' };
  assert.equal(unwrapTell('tell application "TextEdit"\n  make new document\nend tell', app), '  make new document');
  assert.equal(unwrapTell('tell app "textedit"\nx\nend', app), 'x');
  assert.equal(unwrapTell('tell application "com.apple.TextEdit"\nx\nend tell\n', app), 'x');
  assert.equal(unwrapTell('tell application id "com.apple.TextEdit"\r\nx\r\nend tell', app), 'x');
  assert.equal(unwrapTell('tell application "TextEdit" to get name of document 1', app), 'get name of document 1');
  // another app, an id that names it by display name, an empty body, or no tell at all: unchanged
  for (const s of [
    'tell application "Finder"\nx\nend tell',
    'tell application id "TextEdit"\nx\nend tell',
    'tell application "TextEdit"\n \nend tell',
    'get name of document 1',
  ])
    assert.equal(unwrapTell(s, app), s);
});

test('desktop_app_script sends the unwrapped body for AppleScript only', async () => {
  const r = rig();
  r.helper.answers['app.script'] = (p: any) => (p.check ? { ok: true, writes: false, irreversible: [] } : { ok: true, output: 'x' });
  await r.call('desktop_app_script', { app: 'Notes', script: 'tell application "Notes"\nget name of note 1\nend tell' });
  assert.equal(r.last('app.script').source, 'get name of note 1');
  await r.call('desktop_app_script', { app: 'Notes', script: 'tell application "Notes" to x', language: 'javascript' });
  assert.equal(r.last('app.script').source, 'tell application "Notes" to x');
});

test('CM-D25: a click that did nothing in the background is retried in front at the HID level, recorded as route hid; a background click stays posted to the process', async () => {
  const l = ladder();
  const r = rig({ apps: { ladder: l } });
  await r.shoot();
  r.helper.answers['app.click'] = (p: any) =>
    p.foreground
      ? { ok: true, route: 'hid', foreground: { activated: true, restored: true, userTookOver: false } }
      : { ok: true, route: 'pid', verify: { effect: 'no_change' } };
  // the kit's element [3] has no press action: the click is a posted one
  const out = JSON.parse((await r.call('desktop_app_click', { app: 'Notes', coordinate: [300, 300] }))[0].text);
  assert.equal(out.route, 'hid');
  assert.equal(out.rung, 'foreground');
  assert.equal(out.background_effect, 'no_change');
  assert.deepEqual(
    r.callsOf('app.click').map((c: any) => !!c.params.foreground),
    [false, true],
  );
  // a click that worked in the background keeps the process route
  r.helper.answers['app.click'] = () => ({ ok: true, route: 'pid', verify: { effect: 'confirmed' } });
  const bg = JSON.parse((await r.call('desktop_app_click', { app: 'Notes', coordinate: [310, 310] }))[0].text);
  assert.equal(bg.route, 'pid');
});

test('CM-D24: a menu listing says (disabled) may only mean the app is not in front, only when the retry in front is allowed and an item is disabled', async () => {
  const items = [{ title: 'Export as PDF…', enabled: false }, { title: 'New' }];
  const listed = async (l: any, found: any[] = items) => {
    const r = rig({ apps: { ladder: l } });
    r.helper.answers['app.menuRefresh'] = () => ({ refreshed: true });
    r.helper.answers['app.menu'] = () => ({ ok: true, items: found });
    return (await r.call('desktop_app_menu', { app: 'Notes', list: 'File' }))[0].text;
  };
  const note = /\(disabled\) can just mean the app is not in front: pressing the item by path retries it with the app briefly in front/;
  const on = await listed(ladder());
  assert.match(on, /Export as PDF… \(disabled\)/);
  assert.match(on, note);
  // the setting off: no promise of a retry; nothing disabled: nothing to say
  assert.doesNotMatch(await listed(ladder(false)), note);
  assert.doesNotMatch(await listed(ladder(), [{ title: 'New' }]), note);
  assert.doesNotMatch(await listed(ladder(), null as any), note);
});

test('CM-D25: a foreground click the helper posted to the process says who owned the window at the point', async () => {
  const r = rig({ apps: { ladder: ladder() } });
  await r.shoot();
  r.helper.answers['app.click'] = (p: any) =>
    p.foreground
      ? { ok: true, route: 'pid', ownerPid: 99, targetPid: 7, verify: { effect: 'no_change' } }
      : { ok: true, route: 'pid', verify: { effect: 'no_change' } };
  const out = JSON.parse((await r.call('desktop_app_click', { app: 'Notes', coordinate: [300, 300] }))[0].text);
  assert.equal(out.route, 'pid');
  assert.equal(out.rung, 'foreground');
  assert.equal(out.owner_pid, 99);
  assert.equal(out.target_pid, 7);
  // the background attempt names nothing
  assert.equal(out.background_effect, 'no_change');
});
