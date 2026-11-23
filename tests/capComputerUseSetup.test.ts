// Computer use wired up in main (setupComputerUse) over fakes: the callbacks it gives the tools,
// the helper's events, the remote switch, Settings' status and IPC, and the card raised for a chat
// paused by an unattended refusal once the user opens it.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { tick } from './support/async-scenarios.ts';

const require = createRequire(import.meta.url);
const { trayTooltip } = require('../electron/capabilities/computerUse.cjs');
const { rig } = await import('./support/computer-use-setup-rig.ts');

const NOTES = { bundleId: 'com.apple.Notes', name: 'Notes' };

test('IPC: the "working in" stack asks for thumbnails (none with computer use off), app names and bringing an app forward', async () => {
  const r = rig({ flags: { 'shared.computerUse.enabled': false } });
  assert.deepEqual(await r.ipc('computer:workingThumb', 'c1', 'TextEdit'), { thumbnail: null, bundleId: null });
  assert.equal(await r.ipc('computer:appIdentity', ''), null, 'no app named: nothing looked up');
  assert.equal(await r.ipc('computer:bringToFront', '', null), false);
});

test('trayTooltip says the computer is in use and names the chat', () => {
  assert.equal(trayTooltip('Chat'), 'Using your computer · Chat');
  assert.equal(trayTooltip(''), 'Using your computer');
});

test('callbacks: the chat of a session, its state, its harness and the unattended switch', () => {
  const r = rig({ kind: 'codex' });
  const { cu } = r.runtime;
  r.states.set('c', { permission: 'ask' });
  assert.equal(cu.chatOf('t1'), 'chat-of-t1');
  assert.deepEqual(cu.session('c'), { permission: 'ask' });
  assert.equal(cu.harness('c'), 'codex');
  assert.equal(cu.unattendedAllowed(), true);
  r.flags['shared.computerUse.unattended'] = false;
  assert.equal(cu.unattendedAllowed(), false);
});

test('Codex Computer Use holds: without main’s Codex hooks no thread is native, a thread asks in chatOf’s chat, and a busy desktop is only noted', () => {
  const r = rig();
  const holds = r.runtime.nativeHolds;
  assert.equal(holds.isNativeThread('t1'), false);
  assert.equal(holds.chatOf('t1'), 'chat-of-t1');
  holds.onBusy('t1', 'u1', 'chat-of-t1', 'other');
  holds.onStop('t1', 'u1');
  // with them: the controller's request chat, and the busy hook
  const busy: any[] = [];
  const { runtime: r2 } = rig({
    codex: {
      nativeThread: (id: string) => id === 'nat',
      requestChat: (id: string) => `req-${id}`,
      onNativeBusy: (...a: any[]) => busy.push(a),
      onNativeStop: (...a: any[]) => busy.push(['stop', ...a]),
    },
  });
  assert.equal(r2.nativeHolds.isNativeThread('nat'), true);
  assert.equal(r2.nativeHolds.chatOf('sub'), 'req-sub');
  r2.nativeHolds.onBusy('nat', 'u1', 'req-nat', 'other');
  r2.nativeHolds.onStop('sub', 's1');
  assert.deepEqual(busy, [
    ['nat', 'u1', 'req-nat', 'other'],
    ['stop', 'sub', 's1'],
  ]);
});

test('unattended: idle time from the helper; a failing helper counts as no idle time', async () => {
  const r = rig({ kind: 'acp:gemini' });
  const { cu, helper } = r.runtime;
  r.states.set('c', { activeTurn: { human: true } });
  helper.idleSeconds = async () => 601;
  assert.equal(await cu.unattended('c', { callId: 'x' }), 'no input for 10 minutes');
  helper.idleSeconds = async () => {
    throw new Error('not running');
  };
  assert.equal(await cu.unattended('c'), null);
  assert.equal(await cu.unattended('c', { callId: 'sub' }), 'a sub-agent');
  r.states.set('s', { scheduled: { unattended: true } });
  assert.equal(await cu.unattended('s'), 'a scheduled task');
  r.states.set('n', {});
  assert.equal(await cu.unattended('n'), 'a tool call outside a prompt');
});

test('onUnattended: pauses and notifies once per chat, remembering the refused grant', async () => {
  const r = rig({ stopFails: true });
  const { cu } = r.runtime;
  cu.onUnattended('c', { app: NOTES, need: 'click', tool: 'computer_click' });
  cu.onUnattended('c', { app: NOTES, need: 'click', tool: 'computer_click' });
  cu.onUnattended('d', { app: NOTES, need: null, tool: 'computer_click' });
  await tick();
  assert.deepEqual(r.log, [
    ['stop', 'c'],
    ['notify', 'c', 'Notes'],
    ['stop', 'd'],
    ['notify', 'd', 'Notes'],
  ]);
  // without a notifier the pause still happens
  const quiet = rig({ withNotify: false });
  quiet.runtime.cu.onUnattended('c', { app: NOTES, need: 'view', tool: 'computer_screenshot' });
  assert.deepEqual(quiet.log, [['stop', 'c']]);
});

test('onActivity and onStop: the session shows the activity, the tray the controlling chat; Esc stops the turn', async () => {
  const r = rig({ stopFails: true });
  const { cu } = r.runtime;
  cu.controlling = 'c';
  cu.onActivity('c', { app: 'Notes', state: 'active' });
  assert.deepEqual(r.patches, [['c', { computer: { app: 'Notes', state: 'active' } }]]);
  assert.deepEqual(r.log, [['controlling', 'c']]);
  cu.onStop('c');
  await tick();
  assert.deepEqual(r.log.at(-1), ['stop', 'c']);
  const plain = rig({ withControlling: false });
  plain.runtime.cu.onActivity('c', null);
  assert.deepEqual(plain.log, []);
});

test('helper events: a pause reaches the tools; an exit lets go of the controlling chat', () => {
  const r = rig();
  const { cu, helper } = r.runtime;
  const reasons: any[] = [];
  cu.paused = (why: any) => reasons.push(why);
  helper.emit('paused', { reason: 'takeover' });
  helper.emit('paused', null);
  assert.deepEqual(reasons, ['takeover', undefined]);
  cu.controlling = 'c';
  // what the helper held for the chats (hidden apps, held input) is given back through a relaunched one
  const exited: string[] = [];
  r.runtime.desktop.helperExited = async () => void exited.push('given back');
  helper.emit('exit');
  assert.equal(cu.controlling, null);
  assert.deepEqual(r.patches, [['c', { computer: null }]]);
  assert.deepEqual(r.log, [['controlling', null]]);
  assert.deepEqual(exited, ['given back']);
  const plain = rig({ withControlling: false });
  plain.runtime.desktop.helperExited = async () => {
    throw new Error('the helper would not start');
  };
  plain.runtime.helper.emit('exit');
  assert.deepEqual(plain.patches, []);
});

test('quitting: computer use holds the quit while a chat holds the Mac, gives it back once, then lets the app quit', async () => {
  const r = rig();
  const d = r.runtime.desktop;
  assert.equal(r.runtime.holding(), false);
  d.screen = { chatId: 'c', previous: null, hidden: [], others: true, hostHidden: false };
  assert.equal(r.runtime.holding(), true);
  // another chat works in an app in the background: its calls stop and its app lock goes too
  r.runtime.apps.lock('b', { bundleId: 'com.apple.Notes', name: 'Notes' }, 1);
  await r.runtime.letGo();
  assert.equal(d.screen, null);
  assert.equal(r.runtime.cu.closed, true);
  assert.equal(r.runtime.apps.locks.size, 0);
  assert.deepEqual([r.runtime.cu.epoch('b'), r.runtime.cu.epoch('c')], [1, 1]);
  // asked again on the next before-quit: never holds a second time
  d.screen = { chatId: 'c', previous: null, hidden: [], others: true, hostHidden: false };
  assert.equal(r.runtime.holding(), false);
});

test('the switch: tools come and go with it; switching off lets go and stops the helper', async () => {
  const r = rig({ flags: { 'shared.computerUse.enabled': false } });
  assert.equal(r.registry.list().length, 0);
  r.flags['shared.computerUse.enabled'] = true;
  r.runtime.sync();
  const n = r.registry.list().length;
  assert.ok(n > 0);
  r.runtime.sync();
  assert.equal(r.registry.list().length, n);
  const calls: string[] = [];
  r.runtime.desktop.turnEnded = async (chatId: string) => void calls.push(`let go ${chatId}`);
  r.runtime.helper.stop = () => calls.push('stop');
  // a chat holding the desktop gives it back before the helper stops, and nothing takes it again
  r.runtime.cu.controlling = 'c1';
  r.flags['shared.computerUse.enabled'] = false;
  r.runtime.sync();
  assert.equal(r.registry.list().length, 0);
  assert.equal(r.runtime.cu.closed, true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['let go c1', 'stop']);
  // switched on again before the letting go finished: the helper stays, and the desktop can be taken again
  r.flags['shared.computerUse.enabled'] = true;
  r.runtime.sync();
  r.flags['shared.computerUse.enabled'] = false;
  r.runtime.sync();
  r.flags['shared.computerUse.enabled'] = true;
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['let go c1', 'stop', 'let go c1']);
  assert.equal(r.runtime.cu.closed, false);
  r.runtime.sync();
  r.runtime.desktop.letGoAll = async () => {
    throw new Error('x');
  };
  r.flags['shared.computerUse.enabled'] = false;
  r.runtime.sync();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['let go c1', 'stop', 'let go c1', 'stop']);
  r.runtime.stop();
  assert.deepEqual(calls, ['let go c1', 'stop', 'let go c1', 'stop', 'stop']);
  assert.equal(r.runtime.cu.closed, true);
});

test("a vision backend gets its consent file under userData; the chat's refusal ends with its turn", () => {
  const r = rig({ vision: { backendFor: () => null, read: async () => '' } });
  assert.equal(r.runtime.cu.vision.consent.file, path.join(r.dir, 'capabilities', 'vision.json'));
  r.runtime.cu.vision.consent.set('c', 'MoPilot', 'refused');
  r.runtime.turnEnded('c');
  assert.equal(r.runtime.cu.vision.consent.get('c', 'MoPilot'), 'unasked');
  const none = rig();
  assert.equal(none.runtime.cu.vision, null);
  none.runtime.turnEnded('c');
});

test('status: off, it lists grants without starting the helper', async () => {
  const r = rig({
    flags: { 'shared.computerUse.enabled': false },
    records: [
      ['c', {}],
      ['gone', null],
      ['empty', {}],
    ],
  });
  r.meta.set('c', { computerGrants: [{ ...NOTES, level: 'view' }] });
  r.meta.set('gone', { computerGrants: [{ ...NOTES, level: 'view' }] });
  r.runtime.helper.start = async () => assert.fail('not started');
  const out = await r.ipc('computer:status');
  assert.equal(out.enabled, false);
  assert.deepEqual(
    out.grants.chats.map((c: any) => c.chatId),
    ['c'],
  );
  assert.equal(out.permissions, null);
  assert.ok(out.deny.builtIn.length > 0);
});

test('status: on, the helper version and permissions; a failing start is reported', async () => {
  const r = rig();
  const { helper } = r.runtime;
  Object.defineProperty(helper, 'installed', { configurable: true, get: () => true });
  helper.start = async () => ({ version: '1.2' });
  helper.permissionStatus = async () => ({ accessibility: true });
  let out = await r.ipc('computer:status');
  assert.deepEqual(out.helper, { running: true, version: '1.2', error: null, path: helper.appPath });
  assert.deepEqual(out.permissions, { accessibility: true });
  helper.start = async () => null;
  out = await r.ipc('computer:status');
  assert.equal(out.helper.version, null);
  helper.start = async () => {
    throw new Error('no helper');
  };
  out = await r.ipc('computer:status');
  assert.deepEqual(out.helper, { running: false, version: null, error: 'no helper', path: helper.appPath });
  helper.start = async () => {
    throw 'odd';
  };
  assert.equal((await r.ipc('computer:status')).helper.error, 'odd');
});

test('status: only a helper that ran before the read may be relaunched for a fresh Screen Recording answer, and not under a chat', async () => {
  const r = rig();
  const { helper } = r.runtime;
  Object.defineProperty(helper, 'installed', { configurable: true, get: () => true });
  helper.start = async () => ({ version: '1' });
  const idle: boolean[] = [];
  helper.freshPermissionStatus = async (isIdle: () => boolean) => (idle.push(isIdle()), { accessibility: true, screenRecording: false });
  // not running before: the helper this read launches already reads the current grants
  await r.ipc('computer:status');
  // running before, nothing holds the desktop or an app: a new process may read a grant made since
  Object.defineProperty(helper, 'running', { configurable: true, get: () => true });
  await r.ipc('computer:status');
  // a chat controls the desktop, or holds an app in the background: kept
  r.runtime.cu.controlling = 'c';
  await r.ipc('computer:status');
  r.runtime.cu.controlling = null;
  r.runtime.apps.locks.set('com.apple.notes', { chatId: 'c', name: 'Notes', bundleId: 'com.apple.Notes', windows: new Set() });
  await r.ipc('computer:status');
  r.runtime.apps.locks.clear();
  // computer use giving the Mac back (switched off, quitting): kept
  r.runtime.cu.closed = true;
  await r.ipc('computer:status');
  r.runtime.cu.closed = false;
  // a chat still holding input or hidden apps: kept
  r.runtime.desktop.holders = () => ['c'];
  await r.ipc('computer:status');
  assert.deepEqual(idle, [false, true, false, false, false, false]);
  assert.equal(r.runtime.apps.busy(), false);
});

test('status: a helper that is not there is never started; the health record says why and where it looked', async () => {
  const r = rig();
  const helper = Object.assign(r.runtime.helper, { platform: 'darwin' }); // a Mac's, whatever the host
  Object.defineProperty(helper, 'installed', { configurable: true, get: () => false });
  helper.start = async () => assert.fail('not started');
  const out = await r.ipc('computer:status');
  assert.equal(out.health.state, 'unavailable');
  assert.equal(out.health.usable, false);
  assert.match(out.helper.error, /isn't built in this checkout \(.*MoPilot\.app\); rebuild it/);
  assert.equal(out.health.helperPath, helper.appPath);
  // asking for a permission needs the helper: nothing to ask with
  assert.equal(await r.ipc('computer:requestPermission', 'accessibility'), false);
});

test('IPC: open Settings for a permission: the running helper opens its pane, else main opens it; invalid kinds and the switch off are false', async () => {
  const opened: string[] = [];
  const r = rig({ openExternal: async (url: string) => opened.push(url) });
  const { helper } = r.runtime;
  // a running helper opens the pane itself
  Object.defineProperty(helper, 'running', { configurable: true, get: () => true });
  helper.openSettings = async (kind: string) => ({ opened: kind === 'accessibility' });
  assert.equal(await r.ipc('computer:openSettings', 'accessibility'), true);
  assert.deepEqual(opened, []);
  // the helper couldn't: main opens the pane
  assert.equal(await r.ipc('computer:openSettings', 'screenRecording'), true);
  assert.deepEqual(opened, ['x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture']);
  helper.openSettings = async () => {
    throw new Error('helper gone');
  };
  assert.equal(await r.ipc('computer:openSettings', 'accessibility'), true);
  // no helper running (it can't start): main opens the pane without launching one
  Object.defineProperty(helper, 'running', { configurable: true, get: () => false });
  helper.openSettings = async () => assert.fail('the helper is not asked');
  assert.equal(await r.ipc('computer:openSettings', 'inputMonitoring'), true);
  assert.equal(opened.at(-1), 'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent');
  assert.equal(await r.ipc('computer:openSettings', 'camera'), false);
  r.flags['shared.computerUse.enabled'] = false;
  assert.equal(await r.ipc('computer:openSettings', 'accessibility'), false);
  assert.equal(await r.ipc('computer:requestPermission', 'accessibility'), false);
});

test('IPC: open Settings without a way to open a pane, or when opening it fails, is false', async () => {
  const bare = rig();
  assert.equal(await bare.ipc('computer:openSettings', 'accessibility'), false);
  const failing = rig({
    openExternal: async () => {
      throw new Error('no handler');
    },
  });
  assert.equal(await failing.ipc('computer:openSettings', 'accessibility'), false);
});

test("the helper's launches, exits and permissions reach open Settings pages and the health record, once per change", async () => {
  let health = 0;
  const r = rig({ onHealth: () => health++ });
  const { helper } = r.runtime;
  Object.defineProperty(helper, 'installed', { configurable: true, get: () => true });
  const changed = () => r.log.filter((l) => l[0] === 'broadcast' && l[1] === 'computer:changed').length;
  // a launch that failed: Settings and the record hear of it
  helper.lastError = 'open failed (1)';
  helper.emit('state');
  assert.equal(changed(), 1);
  assert.equal(health, 1);
  // nothing changed: nothing is said
  helper.emit('state');
  assert.equal(changed(), 1);
  // permissions the helper reported
  helper.lastError = null;
  helper.permissions = { accessibility: true, screenRecording: false };
  helper.emit('state');
  assert.equal(changed(), 2);
  assert.deepEqual(r.runtime.helperFacts().permissions, { accessibility: true, screenRecording: false });
  assert.equal(r.runtime.health().state, 'permission');
  // the helper exiting is a change too when it was running
  Object.defineProperty(helper, 'running', { configurable: true, get: () => true });
  helper.emit('state');
  Object.defineProperty(helper, 'running', { configurable: true, get: () => false });
  helper.emit('exit');
  assert.equal(changed(), 4);
  // relaunched after the crash (desktop.cjs gives the Mac back through a new helper): running again, and said so
  Object.defineProperty(helper, 'running', { configurable: true, get: () => true });
  helper.emit('state');
  assert.equal(changed(), 5);
  assert.equal(r.runtime.helperFacts().running, true);
  // without an onHealth listener only Settings is told
  const bare = rig();
  bare.runtime.helper.lastError = 'x';
  bare.runtime.helper.emit('state');
  assert.equal(bare.log.filter((l) => l[1] === 'computer:changed').length, 1);
});

test('IPC: answers, revokes, the deny list (pushed to a running helper), resume, recheck and stop', async () => {
  const r = rig();
  const { cu, helper, grants, broker } = r.runtime;
  const p = broker.ask('c', 'computerAccess', {});
  assert.equal(await r.ipc('computer:answer', p.id, { decision: 'deny' }), true);
  assert.deepEqual(await p, { decision: 'deny' });
  grants.grant(null, NOTES, 'view', 'always');
  assert.equal(await r.ipc('computer:revoke', 5, 42), false);
  assert.equal(await r.ipc('computer:revoke', 5, NOTES.bundleId), true);
  grants.grant('c', NOTES, 'view', 'chat');
  assert.equal(await r.ipc('computer:revoke', 'c', NOTES.bundleId), true);
  const pushed: any[] = [];
  helper.setDeny = async (l: any) => {
    pushed.push(l);
    throw new Error('gone');
  };
  // the helper always gets the list: a running one applies it, a stopped one keeps it for its next launch
  assert.deepEqual(await r.ipc('computer:setDeny', ['a']), ['a']);
  assert.deepEqual(pushed, [['a']]);
  helper.socket = {};
  assert.deepEqual(await r.ipc('computer:setDeny', ['b', 'b']), ['b']);
  assert.deepEqual(pushed, [['a'], ['b']]);
  helper.socket = null;
  const calls: any[] = [];
  cu.resume = (id: string) => calls.push(['resume', id]);
  cu.recheck = (id: string) => (calls.push(['recheck', id]), true);
  cu.stop = async (...a: any[]) => void calls.push(['stop', ...a]);
  await r.ipc('computer:resume', 'c');
  assert.equal(await r.ipc('computer:recheck', 7), false);
  assert.equal(await r.ipc('computer:recheck', 'c'), true);
  // a Stop naming no chat is refused: it never falls back to whichever chat holds the desktop (#1866)
  assert.deepEqual([await r.ipc('computer:stop', null), await r.ipc('computer:stop', '')], [false, false]);
  assert.equal(await r.ipc('computer:stop', 'c'), true);
  assert.deepEqual(calls, [
    ['resume', 'c'],
    ['recheck', 'c'],
    ['stop', 'c'],
  ]);
});

/** A chat paused by an unattended refusal for Notes at `need`. */
function pausedChat(o: any = {}) {
  const r = rig(o);
  r.runtime.cu.onUnattended('c', { app: NOTES, need: o.need ?? 'click', tool: 'computer_click' });
  return r;
}

test('onViewed: nothing to show for a chat that was not paused, or with a switch off', () => {
  const r = rig();
  r.runtime.onViewed('c');
  const off = pausedChat({ flags: { 'shared.computerUse.unattended': false } });
  off.runtime.onViewed('c');
  const off2 = pausedChat();
  off2.flags['shared.computerUse.enabled'] = false;
  off2.runtime.onViewed('c');
  // paused with no grant to ask for
  const noNeed = rig();
  noNeed.runtime.cu.onUnattended('c', { app: NOTES, need: null, tool: 'computer_click' });
  noNeed.runtime.onViewed('c');
  assert.deepEqual(
    [r, off, off2, noNeed].map((x) => x.approvals.length),
    [0, 0, 0, 0],
  );
});

test('onViewed: waits for the old turn to end, then raises the card once; a skip-on-approval run gets none', async () => {
  const r = pausedChat();
  r.states.set('c', { activeTurn: { human: false } });
  r.runtime.onViewed('c');
  assert.equal(r.approvals.length, 0);
  // the turn ended and the user is still looking: the card goes up
  r.states.set('c', {});
  r.runtime.onSessionPatch({ chatId: 'c', patch: { turn: 'idle' } });
  assert.equal(r.approvals.length, 1);
  assert.equal(r.approvals[0].params.level, 'click');
  assert.deepEqual(
    r.approvals[0].params.levels.map((l: any) => l.id),
    ['view', 'click', 'full'],
  );
  r.runtime.onViewed('c');
  assert.equal(r.approvals.length, 1);
  const skip = pausedChat();
  skip.states.set('c', { scheduled: { unattended: true, onApproval: 'skip' } });
  skip.runtime.onViewed('c');
  assert.equal(skip.approvals.length, 0);
  // an idle chat that is not being looked at gets no card
  const away = pausedChat({ viewing: false });
  away.runtime.onViewed('c');
  away.states.set('c', {});
  away.runtime.onSessionPatch({ chatId: 'c', patch: { turn: 'crashed' } });
  assert.equal(away.approvals.length, 1);
});

test('a chat that is on screen as it pauses gets its card when the stopped turn ends, with nobody opening it again', () => {
  const shownChat = pausedChat();
  shownChat.states.set('c', { activeTurn: { human: false } });
  assert.equal(shownChat.approvals.length, 0, 'the old turn has not ended yet');
  shownChat.states.set('c', {});
  shownChat.runtime.onSessionPatch({ chatId: 'c', patch: { turn: 'idle' } });
  assert.equal(shownChat.approvals.length, 1);
  assert.equal(shownChat.approvals[0].params.level, 'click');
  // a chat nobody is looking at waits for its user to open it
  const away = pausedChat({ viewing: false });
  away.states.set('c', {});
  away.runtime.onSessionPatch({ chatId: 'c', patch: { turn: 'idle' } });
  assert.equal(away.approvals.length, 0);
});

test('the refusal card: Allow once spends on the next call; Allow in this chat keeps a grant', async () => {
  const once = pausedChat();
  const spent: any[] = [];
  once.runtime.cu.allowOnce = (...a: any[]) => spent.push(a);
  once.runtime.onViewed('c');
  once.runtime.broker.answer(once.approvals[0].id, { decision: 'allow', scope: 'once', level: 'full' });
  await tick();
  assert.deepEqual(spent, [['c', NOTES, 'full']]);
  const chat = pausedChat();
  chat.runtime.onViewed('c');
  chat.runtime.broker.answer(chat.approvals[0].id, { decision: 'allow', scope: 'chat' });
  await tick();
  assert.deepEqual(
    chat.runtime.grants.chat('c').map((g: any) => g.level),
    ['click'],
  );
});

test('the refusal card: a denial or a card that went away grants nothing', async () => {
  const deny = pausedChat();
  deny.runtime.onViewed('c');
  deny.runtime.broker.answer(deny.approvals[0].id, { decision: 'deny' });
  await tick();
  assert.deepEqual(deny.runtime.grants.chat('c'), []);
  // denied: the refusal is gone, so viewing again shows nothing new
  deny.runtime.onViewed('c');
  assert.equal(deny.approvals.length, 1);
  const gone = pausedChat();
  gone.runtime.onViewed('c');
  gone.runtime.onSessionPatch({ chatId: 'c', patch: { approvals: [] } });
  await tick();
  // the refusal stays for a later look
  gone.runtime.onViewed('c');
  assert.equal(gone.approvals.length, 2);
});

test('the user is back: a turn of theirs or the goal running again drops the refusal and its card', async () => {
  const r = pausedChat();
  r.runtime.onViewed('c');
  r.runtime.onSessionPatch({ chatId: 'c', patch: { activeTurn: { human: true } } });
  await tick();
  r.runtime.onViewed('c');
  assert.equal(r.approvals.length, 1);
  const g = pausedChat();
  for (const status of ['paused', 'active']) g.runtime.onSessionPatch({ chatId: 'c', patch: { goal: { status } } });
  g.runtime.onViewed('c');
  assert.equal(g.approvals.length, 0);
  // and the chat can be paused (and notified) again
  g.runtime.cu.onUnattended('c', { app: NOTES, need: 'view', tool: 'computer_screenshot' });
  assert.equal(g.log.filter((l: any) => l[0] === 'notify').length, 2);
});

test('the user joining an automatic turn also counts as being back', () => {
  const r = pausedChat();
  r.runtime.onSessionPatch({ chatId: 'c', patch: { activeTurn: { human: false, userEngaged: true } } });
  r.runtime.onViewed('c');
  assert.equal(r.approvals.length, 0);
  const auto = pausedChat();
  auto.runtime.onSessionPatch({ chatId: 'c', patch: { activeTurn: { human: false } } });
  auto.runtime.onViewed('c');
  assert.equal(auto.approvals.length, 1);
});

test('a turn that ends lets go of the desktop held by its chat only; a session patch alone does not', () => {
  const r = rig();
  const released: any[] = [];
  // every ended turn asks; like the real release, only the chat holding the desktop lets go of it
  r.runtime.cu.release = async (id: string) => {
    if (r.runtime.cu.controlling === id) released.push(id);
  };
  r.runtime.cu.controlling = 'c';
  // main's turn ledger (turnEnd.cjs) calls turnEnded once per turn; the patch itself never lets go a second time
  r.runtime.onSessionPatch({ chatId: 'c', patch: { turn: 'crashed' } });
  assert.deepEqual(released, []);
  r.runtime.turnEnded('d');
  r.runtime.turnEnded('c');
  assert.deepEqual(released, ['c']);
});

test('a failed resumed permission save reports its reason and preserves the refusal for retry', async (t) => {
  const errors = mock.method(console, 'error', () => {});
  t.after(() => errors.mock.restore());
  for (const reason of [new Error('disk unavailable'), 'offline', false]) {
    const notices: any[] = [];
    const r = pausedChat({ notifyKind: (...args: any[]) => notices.push(args) });
    r.runtime.grants.grant = () => {
      if (reason === false) return false;
      throw reason;
    };
    r.runtime.onViewed('c');
    r.runtime.broker.answer(r.approvals[0].id, { decision: 'allow', scope: 'always', level: 'click' });
    await tick();
    assert.equal(notices[0][0], 'computer');
    assert.equal(
      notices[0][2].body,
      reason === false ? "Couldn't save computer permissions. Please try again." : reason instanceof Error ? reason.message : reason,
    );
    r.runtime.onViewed('c');
    assert.equal(r.approvals.length, 2, 'reopening offers another permission card');
  }
  const r = pausedChat();
  r.runtime.grants.grant = () => {
    throw new Error('storage failed');
  };
  r.runtime.onViewed('c');
  r.runtime.broker.answer(r.approvals[0].id, { decision: 'allow', scope: 'always' });
  await tick();
  assert.equal(errors.mock.callCount(), 4, 'every rejection was handled and logged');
});

/** A chat paused by an unattended desktop_request_access refusal: the deferred access card and what it grants. */
function deferredChat(o: any = {}) {
  const r = rig({ ...o, flags: { 'shared.computerUse.parityTools': true, ...o.flags } });
  const applied: any[] = [];
  const apply = o.apply ?? (async (answer: any) => applied.push(answer));
  r.runtime.cu.onUnattended('c', {
    app: NOTES,
    need: null,
    tool: 'desktop_request_access',
    deferred: { kind: 'computerAccessSet', params: { apps: [{ ...NOTES, tier: 'full' }], reason: 'r' }, apply },
  });
  return { ...r, applied };
}

test("a deferred desktop card: raised on view with the chat's harness then; Allow applies the answer once", async () => {
  const r = deferredChat({ kind: 'acp:gemini' });
  r.runtime.onViewed('c');
  assert.deepEqual(
    r.approvals.map((a) => [a.method, a.params.harness, a.params.apps[0].tier, a.params.reason]),
    [['sage/computerAccessSet', 'acp:gemini', 'full', 'r']],
  );
  r.runtime.broker.answer(r.approvals[0].id, { decision: 'allow' });
  await tick();
  assert.deepEqual(r.applied, [{ decision: 'allow' }]);
  r.runtime.onViewed('c');
  assert.equal(r.approvals.length, 1);
});

test('a deferred desktop card that went away applies nothing and stays for a later look; the desktop tools off raise none', async () => {
  const r = deferredChat();
  r.runtime.onViewed('c');
  r.runtime.onSessionPatch({ chatId: 'c', patch: { approvals: [] } });
  await tick();
  assert.deepEqual(r.applied, []);
  r.runtime.onViewed('c');
  assert.equal(r.approvals.length, 2);
  const off = deferredChat({ flags: { 'shared.computerUse.parityTools': false } });
  off.runtime.onViewed('c');
  assert.equal(off.approvals.length, 0);
});

test('a deferred desktop card whose grant fails to apply reports it and offers the card again', async (t) => {
  const errors = mock.method(console, 'error', () => {});
  t.after(() => errors.mock.restore());
  const notices: any[] = [];
  const r = deferredChat({
    notifyKind: (...a: any[]) => notices.push(a),
    apply: async () => {
      throw new Error('disk full');
    },
  });
  r.runtime.onViewed('c');
  r.runtime.broker.answer(r.approvals[0].id, { decision: 'allow' });
  await tick();
  await tick();
  assert.equal(notices[0][2].body, 'disk full');
  r.runtime.onViewed('c');
  assert.equal(r.approvals.length, 2);
});

test('turn end: the card goes up while a window still shows the chat (shown), focused or not; legacy grants too', () => {
  let showing = true;
  const r = pausedChat({ viewing: false, shown: () => showing });
  r.states.set('c', { activeTurn: { human: false } });
  r.runtime.onViewed('c');
  r.states.set('c', {});
  r.runtime.onSessionPatch({ chatId: 'c', patch: { turn: 'idle' } });
  assert.equal(r.approvals.length, 1, 'the window is not focused, but the chat is on screen');
  // the user has moved on to another chat: nothing at turn end
  showing = false;
  const away = pausedChat({ viewing: true, shown: () => showing });
  away.states.set('c', { activeTurn: { human: false } });
  away.runtime.onViewed('c');
  away.states.set('c', {});
  away.runtime.onSessionPatch({ chatId: 'c', patch: { turn: 'idle' } });
  assert.equal(away.approvals.length, 0);
});

test('brief switching: the setting over IPC and in the status, and the ladder the background tools get', async () => {
  const r = rig();
  assert.equal((await r.ipc('computer:status')).briefForeground, true);
  assert.equal(await r.ipc('computer:setBriefForeground', 'yes'), false, 'only true turns it on');
  assert.equal(r.runtime.apps.ladder.allowed(), false);
  assert.equal(await r.ipc('computer:setBriefForeground', true), true);
  assert.equal(r.runtime.apps.ladder.allowed(), true);
  assert.equal(r.runtime.apps.ladder.remember(NOTES, 'type', 'foreground'), true);
  assert.equal(r.runtime.apps.ladder.rung(NOTES.bundleId, 'type'), 'foreground');
});

test('computer-use presentation helpers retain the public entrypoint identities', () => {
  const entry = require('../electron/capabilities/computerUse.cjs');
  const presentation = require('../electron/capabilities/computerPresentation.cjs');
  for (const name of ['hostWindows', 'trayTooltip', 'agentLabel']) assert.equal(entry[name], presentation[name], name);
});
