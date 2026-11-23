// electron/capabilities/tools/desktopAccess.cjs: desktop_request_access and its card: tiers, warnings, refusals, the
// extras, unattended chats, and screen control asked just in time (never on the access card).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defined } from './support/defined.ts';
import {
  DesktopControl,
  NOTES,
  MAIL,
  TERMINAL,
  SAFARI,
  FINDER,
  MOPILOT,
  fakeHelper,
  resolveEntry,
  rig,
  rejects,
  callsOf,
} from './support/desktop-kit.ts';
import { createRequire } from 'node:module';

const { TAKEOVER_REASON } = createRequire(import.meta.url)('../electron/capabilities/tools/desktopGate.cjs');
const { guarded } = createRequire(import.meta.url)('../electron/capabilities/contract/actionGuard.cjs');

/* -- request_access ---------------------------------------------------- */
test("request_access: one card with each app at its kind's tier and broad-reach warnings; grants add up", async () => {
  const r = rig();
  for (const a of [NOTES, TERMINAL, SAFARI]) r.helper.resolved.set(a.name, resolveEntry(a));
  const out = await r.json('desktop_request_access', { apps: [' Notes ', 'Terminal', 'Safari', 'Notes', ''], reason: 'x'.repeat(400) });
  assert.equal(r.asks.length, 1);
  const card = r.asks[0];
  assert.equal(card.kind, 'computerAccessSet');
  assert.equal(card.params.harness, 'claude');
  assert.equal(card.params.reason.length, 300);
  assert.deepEqual(
    card.params.apps.map((a: any) => [a.name, a.tier, a.tierLabel, a.running]),
    [
      ['Notes', 'full', 'Full control', true],
      ['Terminal', 'click', 'Click and scroll', true],
      ['Safari', 'read', 'View only', true],
    ],
  );
  assert.match(card.params.apps[1].warning, /run any command/);
  assert.equal(card.params.apps[0].warning, null);
  assert.deepEqual(callsOf(r, 'resolveApps')[0].args[0], ['Notes', 'Terminal', 'Safari'], 'trimmed and deduplicated');
  assert.deepEqual(out.granted, [
    { app: 'Notes', bundleId: 'com.apple.Notes', tier: 'full' },
    { app: 'Terminal', bundleId: 'com.apple.Terminal', tier: 'click' },
    { app: 'Safari', bundleId: 'com.apple.Safari', tier: 'read' },
  ]);
  assert.match(out.next, /desktop_open_application/);
  assert.equal(out.setup, undefined);
  // asking again: already granted, no card
  const again = await r.json('desktop_request_access', { apps: ['Notes'], reason: '' });
  assert.equal(r.asks.length, 1);
  assert.deepEqual(
    again.granted.map((g: any) => g.app),
    ['Notes'],
  );
  // grants are per chat
  const other = await r.json('desktop_list_granted_applications', {}, { chatId: 'c2' });
  assert.deepEqual(other.apps, []);
});

test('request_access: MoPilot, the apps hosting the agent, helper refusals and the Settings deny list are never granted', async () => {
  const r = rig({ deny: ['com.example.*'] });
  const entries = [
    { query: 'Ghost', app: null },
    resolveEntry(MOPILOT, { refused: undefined }),
    { query: 'Electron', app: { bundleId: 'com.github.Electron', name: 'Electron' } },
    { query: 'Self', app: { bundleId: 'x.self', name: 'Self' }, refused: 'MoPilot' },
    { query: 'Host', app: { bundleId: 'com.googlecode.iterm2', name: 'iTerm', pid: 2 } },
    { query: '1Password', app: { bundleId: 'com.1password.1password', name: '1Password' }, refused: 'password managers' },
    { query: 'Example', app: { bundleId: 'com.example.app', displayName: 'Example App' } },
    { query: 'NoName', app: { bundleId: 'org.noname' } },
  ];
  r.helper.resolveApps = async () => ({ apps: entries });
  r.answers.computerAccessSet = { decision: 'allow' };
  // the call runs inside the registry's guard, which takes each no-go refusal to the chat's transcript (#1724)
  const noGo: any[] = [];
  const out = await guarded({ onNoGo: (n: any) => noGo.push(n) }, () =>
    r.json('desktop_request_access', { apps: entries.map((e) => e.query), reason: 'go' }),
  );
  // MoPilot itself (by bundle id, a development build's Electron, or the helper's refusal), the built-in list and the
  // user's blocked apps are noted; a missing app and an app that only hosts the agent are not no-go apps
  assert.deepEqual(noGo, [
    { reason: 'self', app: 'MoPilot', name: 'MoPilot' },
    { reason: 'self', app: 'Electron', name: 'MoPilot' },
    { reason: 'self', app: 'Self', name: 'MoPilot' },
    { reason: 'builtIn', app: '1Password', name: '1Password' },
    { reason: 'blocked', app: 'Example', name: 'Example App' },
  ]);
  // the model learns where MoPilot's projects, chats and browser pane are reached instead; the card never says it
  assert.match(out.instead, /^MoPilot: Its projects and chats are listed by the list_sidebar tool/);
  assert.deepEqual(
    out.denied.map((d: any) => [d.app, d.reason]),
    [
      ['Ghost', 'no app with that name or bundle id is installed'],
      ['MoPilot', 'MoPilot itself, and the apps hosting this agent, are never granted'],
      ['Electron', 'MoPilot itself, and the apps hosting this agent, are never granted'],
      ['Self', 'MoPilot itself, and the apps hosting this agent, are never granted'],
      ['iTerm', 'MoPilot itself, and the apps hosting this agent, are never granted'],
      ['1Password', 'MoPilot never controls password managers'],
      ['Example App', 'blocked in Settings → Computer use'],
    ],
  );
  assert.deepEqual(out.granted, [{ app: 'org.noname', bundleId: 'org.noname', tier: 'full' }]);
  // the card shows what can't be granted, and why
  assert.equal(r.asks[0].params.denied.length, 7);
  assert.deepEqual(r.asks[0].params.denied[0], { name: 'Ghost', reason: 'no app with that name or bundle id is installed' });
});

test('request_access: the user unchecks apps, denies the card, or it goes away unanswered', async () => {
  const r = rig();
  for (const a of [NOTES, MAIL, FINDER]) r.helper.resolved.set(a.name, resolveEntry(a));
  r.answers.computerAccessSet = { decision: 'allow', apps: ['COM.APPLE.NOTES'] };
  const picked = await r.json('desktop_request_access', { apps: ['Notes', 'Mail'], reason: 'r' });
  assert.deepEqual(
    picked.granted.map((g: any) => g.app),
    ['Notes'],
  );
  assert.deepEqual(picked.denied, [{ app: 'Mail', bundleId: 'com.apple.mail', reason: 'the user did not allow it' }]);
  r.answers.computerAccessSet = { decision: 'deny' };
  const denied = await r.json('desktop_request_access', { apps: ['Finder'], reason: 'r' });
  assert.deepEqual(denied.granted, []);
  assert.equal(denied.next, undefined);
  r.answers.computerAccessSet = null;
  const gone = await r.json('desktop_request_access', { apps: ['Mail'], reason: 'r' });
  assert.equal(gone.denied[0].reason, 'the user did not allow it');
  assert.deepEqual(
    (await r.json('desktop_list_granted_applications')).apps.map((a: any) => a.app),
    ['Notes'],
  );
});

test('request_access: clipboard and system-shortcut extras are asked once and can be refused one by one', async () => {
  const r = rig();
  r.helper.resolved.set('Notes', resolveEntry(NOTES));
  r.answers.computerAccessSet = { decision: 'allow', clipboardWrite: false };
  const out = await r.json('desktop_request_access', {
    apps: ['Notes'],
    reason: 'r',
    clipboardRead: true,
    clipboardWrite: true,
    systemKeyCombos: 'yes',
  });
  assert.equal(r.asks[0].params.clipboardRead, true);
  assert.equal(r.asks[0].params.clipboardWrite, true);
  assert.equal(r.asks[0].params.systemKeyCombos, false, 'only a literal true asks');
  assert.equal(out.clipboardRead, true);
  assert.equal(out.clipboardWrite, false);
  // only an extra: still one card, without apps
  r.answers.computerAccessSet = { decision: 'allow' };
  await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r', clipboardRead: true, systemKeyCombos: true });
  assert.equal(r.asks.length, 2);
  assert.deepEqual(r.asks[1].params.apps, []);
  assert.equal(r.asks[1].params.clipboardRead, false, 'already granted');
  assert.equal(r.asks[1].params.systemKeyCombos, true);
  // denied extras stay off
  r.answers.computerAccessSet = { decision: 'deny' };
  const off = await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r', clipboardWrite: true });
  assert.equal(off.clipboardWrite, false);
});

test('request_access: nobody there to answer refuses, pauses the chat, and asks nothing', async () => {
  const r = rig();
  r.helper.resolved.set('Notes', resolveEntry(NOTES));
  r.state.unattended = 'a scheduled task';
  await rejects(
    r.call('desktop_request_access', { apps: ['Notes'], reason: 'r' }),
    'unattended',
    /Access to Notes needs the user's OK.*a scheduled task/,
  );
  assert.equal(r.asks.length, 0);
  assert.deepEqual(
    r.paused.map((p: any) => [p.app.bundleId, p.tool, p.code]),
    [['com.apple.Notes', 'desktop_request_access', 'unattended']],
  );
  await rejects(
    r.call('desktop_request_access', { apps: ['Ghost'], reason: 'r', clipboardRead: true }),
    'unattended',
    /the clipboard or system shortcuts/,
  );
  assert.equal(r.paused[1].app.bundleId, 'ai.mopilot.screen');
});

test('request_access unattended: the refusal carries the card it would have shown, and its answer grants what was asked', async () => {
  const r = rig();
  r.helper.resolved.set('Notes', resolveEntry(NOTES));
  r.state.unattended = 'a scheduled task';
  await rejects(r.call('desktop_request_access', { apps: ['Notes'], reason: 'nightly', systemKeyCombos: true }), 'unattended');
  const { deferred } = r.paused[0];
  assert.equal(deferred.kind, 'computerAccessSet');
  assert.deepEqual(
    deferred.params.apps.map((a: any) => [a.bundleId, a.tier]),
    [['com.apple.Notes', 'full']],
  );
  assert.equal(deferred.params.reason, 'nightly');
  assert.equal(deferred.params.systemKeyCombos, true);
  assert.equal('takeover' in deferred.params, false, 'the access card never asks for screen control');
  assert.equal('harness' in deferred.params, false, "the harness is the chat's when the card goes up");
  assert.equal(r.asks.length, 0);
  // a denial grants nothing
  assert.deepEqual(await deferred.apply({ decision: 'deny' }), []);
  assert.equal(r.d.granted('c1').size, 0);
  // Allow: the app at its tier and the extra (an old answer's takeover gives no screen control), then the next call runs without a card
  const granted = await deferred.apply({ decision: 'allow', takeover: true });
  assert.deepEqual(
    granted.map((a: any) => a.bundleId),
    ['com.apple.Notes'],
  );
  const s = r.d.session('c1');
  assert.equal(s.systemKeyCombos, true);
  assert.equal(s.consent, false);
  const out = await r.json('desktop_request_access', { apps: ['Notes'], reason: 'nightly' });
  assert.deepEqual(out.granted, [{ app: 'Notes', bundleId: 'com.apple.Notes', tier: 'full' }]);
  assert.equal(r.asks.length, 0);
});

test('display-scope input unattended without consent: the refusal defers the takeover card; only Allow gives screen control', async () => {
  const r = rig();
  await r.grant();
  r.state.unattended = 'a scheduled task';
  await rejects(r.call('desktop_mouse_move', { coordinate: [1, 1] }), 'unattended', /Taking over the screen/);
  const { deferred } = r.paused[0];
  assert.equal(deferred.kind, 'computerTakeover');
  assert.deepEqual(deferred.params.apps, [{ bundleId: 'com.apple.Notes', name: 'Notes', tier: 'full' }]);
  deferred.apply(null);
  assert.equal(r.d.session('c1').consent, false);
  deferred.apply({ decision: 'allow' });
  assert.equal(r.d.session('c1').consent, true);
});

test('request_access: bad input, an unavailable or outdated helper, and a missing permission note', async () => {
  const r = rig();
  await rejects(r.call('desktop_request_access', { apps: [' '], reason: 'r' }), 'bad_args', /Name at least one app/);
  await rejects(r.call('desktop_request_access', { apps: 'Notes', reason: 'r' }), 'bad_args');
  r.helper.fail.start = new Error('not built');
  await rejects(
    r.call('desktop_request_access', { apps: ['Notes'], reason: 'r' }),
    'unavailable',
    /Desktop control isn't available: not built/,
  );
  r.helper.fail.start = 'no socket';
  await rejects(
    r.call('desktop_request_access', { apps: ['Notes'], reason: 'r' }),
    'unavailable',
    /Desktop control isn't available: no socket/,
  );
  delete r.helper.fail.start;
  r.helper.fail.resolveApps = Object.assign(new Error('unknown method'), { reason: 'method_not_found' });
  await rejects(r.call('desktop_request_access', { apps: ['Notes'], reason: 'r' }), 'unavailable', /out of date/);
  r.helper.fail.resolveApps = Object.assign(new Error('boom'), { reason: 'other' });
  await rejects(r.call('desktop_request_access', { apps: ['Notes'], reason: 'r' }), 'failed', /Computer use failed: boom/);
  delete r.helper.fail.resolveApps;
  r.helper.resolved.set('Notes', resolveEntry(NOTES));
  assert.deepEqual(
    (await r.json('desktop_request_access', { apps: ['Notes'] })).granted.map((g: any) => g.app),
    ['Notes'],
    'no reason given',
  );
  assert.equal(defined(r.asks.at(-1)).params.reason, '');
  r.helper.perms = { screenRecording: false, accessibility: false };
  const out = await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r' });
  assert.match(out.setup, /cannot use Screen Recording yet.*cannot use Accessibility yet/s);
  assert.match(out.setup, /Already on\?/);
  assert.match(out.setup, /"Helper" \(ai\.helper, \/Apps\/Helper\.app\)/);
  r.helper.fail.permissionStatus = new Error('gone');
  const quiet = await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r' });
  assert.equal(quiet.setup, undefined);
  r.helper.resolveApps = async () => ({});
  assert.deepEqual(await r.json('desktop_request_access', { apps: ['Nothing'], reason: 'r' }), {
    granted: [],
    denied: [],
    clipboardRead: false,
    clipboardWrite: false,
    systemKeyCombos: false,
    screenControl: false,
    tiers: 'read: screenshots only; click: left click and scroll only; full: everything',
  });
});

test('request_access: a failing host-process lookup grants nothing it should not; the default lookup is used', async () => {
  const r = rig({
    hostPids: async () => {
      throw new Error('ps failed');
    },
  });
  r.helper.resolved.set('Notes', resolveEntry(NOTES));
  assert.deepEqual(
    (await r.json('desktop_request_access', { apps: ['Notes'], reason: 'r' })).granted.map((g: any) => g.app),
    ['Notes'],
  );
  // the default: this process and its ancestry (a real ps), looked up once
  const helper = fakeHelper();
  helper.resolved.set('Me', { query: 'Me', app: { bundleId: 'org.node', name: 'node', pid: process.pid } });
  const { ComputerPermissions } = createRequire(import.meta.url)('../electron/capabilities/tools/computerPermissions.cjs');
  const cu: any = Object.assign(new ComputerPermissions(), {
    chatOf: (x: string) => x,
    session: () => ({}),
    harness: () => 'codex',
    unattended: async () => null,
  });
  const d = new DesktopControl({ helper, cu, grants: null, broker: { ask: async () => ({ decision: 'allow' }) } });
  const out = JSON.parse((await d.run('desktop_request_access', { apps: ['Me'], reason: 'r' }, { chatId: 'c1' }))[0].text);
  assert.match(out.denied[0].reason, /apps hosting this agent/);
  assert.equal(d.hostPidsP instanceof Promise, true);
});

/* -- just-in-time takeover --------------------------------------------------- */
test('screen control is asked just in time: never on the access card, then the takeover card on the first display-scope input, with why', async () => {
  const r = rig();
  r.answers.computerAccessSet = { decision: 'allow', takeover: true };
  const out = await r.grant([NOTES]);
  assert.equal('takeover' in r.asks[0].params, false);
  assert.equal(out.screenControl, false, "an answer's takeover field grants nothing");
  await r.call('desktop_screenshot');
  await r.call('desktop_left_click', { coordinate: [1, 1] });
  assert.deepEqual(
    r.asks.map((a: any) => a.kind),
    ['computerAccessSet', 'computerTakeover'],
  );
  assert.equal(defined(r.asks.at(-1)).params.reason, TAKEOVER_REASON);
  // consent given: no second takeover card in this chat
  await r.call('desktop_left_click', { coordinate: [2, 2] });
  assert.equal(r.asks.length, 2);
});
