// The control matrix's Stop and in-flight cases (docs/control-plane/matrix.md, group R; design D1, step 1): after Stop,
// the turn's end, Esc, a crash or quitting, no computer-use or browser-use side effect happens for that turn, nothing
// takes the desktop back, and what the turn changed on the Mac comes back. The desktop, app-scoped, legacy computer_*
// and Your Chrome tools, the Registry, the tool socket and the helper client are the real modules; the helper, Chrome
// and the harnesses are fakes.
import { slowChrome } from './support/extension-wire.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { treeFiles } from '../scripts/source-tree.mjs';
import { createRequire } from 'node:module';
import { rig as desktopRig, NOTES, FINDER, rejects } from './support/desktop-kit.ts';
import { rig as appRig } from './support/app-scoped-kit.ts';
import { deferred, tick } from './support/async-scenarios.ts';
import { waitFor } from './support/waitFor.ts';
export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { Registry, ToolError } = require('../electron/capabilities/contract/registry.cjs');
const { guarded, mayAct, unguarded, pause } = require('../electron/capabilities/contract/actionGuard.cjs');
const { ComputerHelper, GIVES_BACK } = require('../electron/capabilities/computer.cjs');
const { ComputerUse } = require('../electron/capabilities/tools/computer.cjs');
const { ChromeChannel, chromeTools, spawnSpec } = require('../electron/capabilities/browser/extension.cjs');
const { CodexToolInjection } = require('../electron/capabilities/channels/codexConfig.cjs');
const { ToolSessions } = require('../electron/capabilities/contract/session.cjs');
const { ToolSocket } = require('../electron/capabilities/mcp/socket.cjs');
const { ChatController } = require('../electron/session/controller.cjs');

/** Waits until `ok()` holds (a request reached the fake), at most a second. */
async function until(ok: () => boolean) {
  await waitFor(ok, 'the fake to be reached');
  assert.ok(ok(), 'waited for the fake to be reached');
}

/** A desktop_left_click that waits in gate() while openApp brings Notes forward (Finder was in front); hide-before-action on. */
async function clickInFlight(signal: AbortSignal | null) {
  const host = { hide: () => true, show() {} };
  const r = desktopRig({ hide: true, host });
  await r.ready([NOTES]);
  r.helper.front = FINDER;
  r.helper.at = NOTES;
  const opened = deferred();
  const openApp = r.helper.openApp;
  r.helper.openApp = async (...args: any[]) => {
    const out = await openApp(...args);
    await opened.promise;
    r.helper.front = NOTES;
    return out;
  };
  const call = r.call('desktop_left_click', { coordinate: [10, 10] }, { chatId: 'c1', signal });
  await until(() => r.callsOf('openApp').length === 1);
  return { r, call, opened };
}

test('CM-R01: Stop while a desktop click waits in its checks: the click never happens and nothing takes the desktop back', async () => {
  const ac = new AbortController();
  const { r, call, opened } = await clickInFlight(ac.signal);
  assert.equal(r.cu.controlling, 'c1');
  // Stop: the Registry aborts the call, the turn ends and lets go of the desktop, then the helper answers
  ac.abort('The turn was stopped before this finished');
  await r.d.turnEnded('c1');
  assert.equal(r.cu.controlling, null);
  opened.resolve(null);
  await rejects(call, 'stopped', /Stopped by the user/);
  assert.equal(r.callsOf('click').length + r.callsOf('axPress').length, 0, 'no click');
  assert.equal(r.callsOf('acquireControl').length, 1, 'the desktop was never taken again');
  assert.equal(r.cu.controlling, null, 'another chat can take it');
  // stopped while the helper was taking the desktop: it is let go at once
  const r2 = desktopRig();
  await r2.ready([NOTES]);
  const took = deferred();
  r2.helper.acquireControl = async () => {
    r2.helper.calls.push({ method: 'acquireControl', args: [] });
    await took.promise;
  };
  const stop = new AbortController();
  const late = r2.call('desktop_left_click', { coordinate: [10, 10] }, { chatId: 'c1', signal: stop.signal });
  await until(() => r2.callsOf('acquireControl').length === 1);
  stop.abort();
  took.resolve(null);
  await rejects(late, 'stopped');
  assert.deepEqual(r2.released, ['c1']);
  assert.equal(r2.cu.controlling, null);
  assert.equal(r2.callsOf('click').length, 0);
});

test('CM-R02: the turn ending (or Esc) while a desktop click waits stops it too; Esc moves the epoch before it lets go', async () => {
  // no abort signal at all: the turn's end moves the chat's epoch, which the call began in
  const { r, call, opened } = await clickInFlight(null);
  await r.d.turnEnded('c1');
  opened.resolve(null);
  await rejects(call, 'stopped');
  assert.equal(r.callsOf('click').length, 0);
  assert.equal(r.cu.controlling, null);
  // Esc (cu.stop): the chat's actions stop first, then the lock goes, so nothing in between can take it back
  const order: string[] = [];
  const cu = new ComputerUse({
    helper: { releaseControl: async () => void order.push('release'), running: true },
    grants: { forChat: () => [], deny: () => [] },
    broker: null,
    session: () => ({}),
    onStop: (chatId: string) => order.push(`stop ${chatId} at epoch ${cu.epoch(chatId)}`),
  });
  cu.controlling = 'c1';
  await cu.stop();
  assert.deepEqual(order, ['stop c1 at epoch 1', 'release']);
  await cu.stop();
  assert.deepEqual(order.length, 2, 'nothing to stop');
});

test('CM-R03: apps hidden for a step after its turn let go of the screen come back at once, not into a dropped record', async () => {
  const host = { hidden: 0, shown: [] as boolean[], hide: () => (host.hidden++, true), show: (f: boolean) => host.shown.push(f) };
  const r = desktopRig({ hide: true, host });
  await r.ready([NOTES]);
  const hid = deferred();
  r.helper.hideOthers = async (keep: string[]) => {
    r.helper.calls.push({ method: 'hideOthers', args: [keep] });
    await hid.promise;
    return { hidden: [{ pid: 30, bundleId: 'x.y' }] };
  };
  const call = r.call('desktop_left_click', { coordinate: [10, 10] });
  await until(() => r.callsOf('hideOthers').length === 1);
  await r.d.turnEnded('c1');
  assert.equal(r.d.screen, null);
  // (an app that quit meanwhile can't be shown; the rest goes on)
  r.helper.fail.restoreApps = new Error('the app quit');
  hid.resolve(null);
  await rejects(call, 'stopped');
  assert.deepEqual(r.callsOf('restoreApps').at(-1).args[0], [30], 'shown again right away');
  assert.equal(r.callsOf('click').length, 0);
  assert.equal(r.d.screen, null, 'no record is left for a turn that is over');
  // MoPilot's windows hidden only after the turn let go come back at once too
  const late = deferred<boolean>();
  const shown: boolean[] = [];
  let hiding = false;
  const r2 = desktopRig({ hide: true, host: { hide: () => ((hiding = true), late.promise), show: (f: boolean) => shown.push(f) } });
  await r2.ready([NOTES]);
  const call2 = r2.call('desktop_left_click', { coordinate: [10, 10] });
  await until(() => hiding);
  await r2.d.turnEnded('c1');
  assert.deepEqual(shown, []);
  late.resolve(true);
  await rejects(call2, 'stopped');
  assert.deepEqual(shown, [false]);
  assert.equal(r2.callsOf('hideOthers').length, 0);
});

/** A legacy computer_* coordinator over a scripted helper, with Notes granted at full control. */
function legacy() {
  const calls: string[] = [];
  const activity: any[] = [];
  const helper: any = {
    running: true,
    fail: {} as Record<string, any>,
    start: async () => ({}),
    targetInfo: async () => ({ pid: 7, bundleId: NOTES.bundleId, name: 'Notes' }),
    glowStart: async () => ({}),
    glowStop: async () => ({}),
    screenshot: async () => ({ png: 'P', width: 10, height: 10, display: { x: 0, y: 0 }, pixelsPerPoint: 1 }),
    axSnapshot: async () => ({ root: { id: '0', role: 'AXApplication', children: [] } }),
  };
  for (const m of ['acquireControl', 'releaseControl', 'click', 'key'])
    helper[m] = async () => {
      calls.push(m);
      if (helper.fail[m]) throw helper.fail[m];
      return {};
    };
  const cu = new ComputerUse({
    helper,
    grants: { forChat: () => [{ bundleId: NOTES.bundleId, level: 'full' }], deny: () => [] },
    broker: null,
    session: () => ({ modality: 'image', permission: 'default' }),
    onActivity: (chatId: string, a: any) => activity.push([chatId, a?.state ?? null]),
    settleMs: 0,
  });
  return { cu, helper, calls, activity };
}

test('CM-R04: Stop while a computer_* call waits for another chat to let go: the wait ends at once, the desktop is never taken', async () => {
  const { cu, calls, activity } = legacy();
  cu.controlling = 'other';
  cu.pollMs = 60_000;
  const ac = new AbortController();
  const call = cu.run('computer_click', { x: 1, y: 1 }, { chatId: 'c1', signal: ac.signal });
  await until(() => activity.some(([c, s]) => c === 'c1' && s === 'waiting'));
  const started = Date.now();
  ac.abort();
  await rejects(call, 'stopped');
  assert.ok(Date.now() - started < 1000, 'not after the next poll');
  assert.equal(calls.length, 0);
  assert.deepEqual(activity.at(-1), ['c1', null], 'the Waiting strip goes');
  // the turn's end (no signal): the same, and Esc for the chat holding it lets go after stopping its calls
  cu.pollMs = 1;
  const waiting = cu.run('computer_click', { x: 1, y: 1 }, { chatId: 'c1' });
  await tick();
  cu.interrupt('c1');
  await rejects(waiting, 'stopped');
  // stopped while the helper took the desktop: it is let go at once
  cu.controlling = null;
  const took = deferred();
  const turn = new AbortController();
  cu.helper.acquireControl = async () => {
    calls.push('acquireControl');
    await took.promise;
  };
  const late = cu.run('computer_click', { x: 1, y: 1 }, { chatId: 'c1', signal: turn.signal });
  await until(() => calls.includes('acquireControl'));
  turn.abort();
  took.resolve(null);
  await rejects(late, 'stopped');
  assert.deepEqual(calls, ['acquireControl', 'releaseControl']);
  assert.equal(cu.controlling, null);
  // quitting or computer use switched off: nothing takes it again
  cu.closed = true;
  await rejects(cu.run('computer_click', { x: 1, y: 1 }, { chatId: 'c1' }), 'unavailable');
});

test('CM-R05: a helper error while a computer_* call waits for the desktop takes the "Waiting" strip down', async () => {
  const { cu, helper, activity } = legacy();
  cu.controlling = 'other';
  cu.pollMs = 5;
  const call = cu.run('computer_click', { x: 1, y: 1 }, { chatId: 'c1' });
  await until(() => activity.some(([c, s]) => c === 'c1' && s === 'waiting'));
  // the other chat lets go, and the helper fails when this one tries to take it
  helper.fail.acquireControl = Object.assign(new Error('gone'), { reason: 'helper_stopped' });
  cu.controlling = null;
  await rejects(call, 'unavailable');
  assert.deepEqual(activity.at(-1), ['c1', null]);
});

test('CM-R06: Stop while a background (desktop_app_*) action is being checked: no app lock is taken and nothing reaches the app', async () => {
  const r = appRig();
  await r.shoot();
  const asked = deferred<string | null>();
  r.cu.unattended = () => asked.promise;
  const ac = new AbortController();
  const call = r.call('desktop_app_click', { app: 'Notes', element_index: 7 }, { chatId: 'c1', signal: ac.signal });
  await tick();
  ac.abort();
  r.apps.turnEnded('c1');
  asked.resolve(null);
  await assert.rejects(call, /stopped by the user/);
  assert.equal(r.apps.locks.size, 0, 'the app lock is not taken again');
  assert.deepEqual(
    r.helper.calls.filter((c: any) => /^app\.(click|press|setText|key|scroll|drag|focus|batch|menu)$/.test(c.method)),
    [],
  );
  // a menu command and a batch stopped between their steps send nothing more either
  const menuAsked = deferred<string | null>();
  r.cu.unattended = () => menuAsked.promise;
  const turn = new AbortController();
  const menu = r.call('desktop_app_menu', { app: 'Notes', path: ['File', 'New'] }, { chatId: 'c1', signal: turn.signal });
  await tick();
  turn.abort();
  menuAsked.resolve(null);
  await assert.rejects(menu, /stopped by the user/);
  assert.equal(r.callsOf('app.menu').length, 0);
  r.cu.unattended = async () => null;
  const refreshed = deferred();
  r.helper.answers['app.menuRefresh'] = () => refreshed.promise;
  const late = new AbortController();
  const menu2 = r.call('desktop_app_menu', { app: 'Notes', path: ['File', 'New'] }, { chatId: 'c1', signal: late.signal });
  await until(() => r.callsOf('app.menuRefresh').length > 0);
  late.abort();
  refreshed.resolve({ refreshed: true });
  await assert.rejects(menu2, /stopped by the user/);
  assert.equal(r.callsOf('app.menu').length, 0);
  // a batch stopped while it prepares a later step: nothing it prepared is sent
  r.desktop.modelOf = () => (r.apps.interrupt('c1'), null);
  const out = JSON.parse(
    (
      await r.call('desktop_app_batch', {
        app: 'Notes',
        actions: [{ action: 'click', element_index: 7 }, { action: 'screenshot' }],
      })
    )[0].text,
  );
  assert.deepEqual([out.completed, out.stoppedAt, out.results[0].reason], [0, 0, 'stopped by the user']);
  assert.equal(r.callsOf('app.batch').length + r.callsOf('app.press').length + r.callsOf('app.click').length, 0);
});

test('CM-R07: Stop while Your Chrome checks the page before a click: the click is never sent to Chrome', async () => {
  const chrome = slowChrome();
  const channel = new ChromeChannel({ fork: chrome.fork, spec: () => spawnSpec({ outputDir: '/o', env: {} }) });
  const grants = { require: async () => {}, act: async () => {} };
  const [click] = chromeTools({ channel, grants, schemas: [{ name: 'browser_click', inputSchema: { type: 'object' } }] });
  const r = new Registry();
  r.register(click);
  const ac = new AbortController();
  // the Codex or ACP Stop path: the Registry's own abort (onInterrupt -> abortChat)
  const res = r.invoke('c1', 'c1', 'sage_browser_click', { element: 'Buy', ref: 'e1' }, { signal: ac.signal });
  await until(() => chrome.sent.length === 1);
  assert.deepEqual(chrome.sent, ['browser_snapshot']);
  ac.abort();
  assert.equal((await res).error.code, 'aborted');
  // the slow snapshot answers after Stop: the handler goes on, and Chrome gets nothing more
  chrome.replies.shift()!();
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(chrome.sent, ['browser_snapshot']);
  channel.stopAll();
  // the same tool runs when nobody stopped it
  const ok = r.invoke('c2', 'c2', 'sage_browser_click', { element: 'Buy', ref: 'e1' });
  // Your Chrome reads what the click targets (its sensitive-action check) between the two snapshots
  for (let i = 0; i < 4; i++) {
    await until(() => chrome.replies.length > 0);
    chrome.replies.shift()!();
  }
  assert.equal((await ok).ok, true);
  assert.deepEqual(chrome.sent.slice(1), ['browser_snapshot', 'browser_evaluate', 'browser_snapshot', 'browser_click']);
  channel.stopAll();
  // Stop while the page a navigation landed on waits for its site permission: leaving that page still happens
  const asked = deferred();
  const ask = {
    require: async (url: string) => {
      if (url !== 'https://a.test/') return;
      await asked.promise;
      throw new ToolError('The user did not allow this site', 'denied');
    },
    act: async () => {},
  };
  const [navigate] = chromeTools({ channel, grants: ask, schemas: [{ name: 'browser_navigate', inputSchema: { type: 'object' } }] });
  const sent = chrome.sent.length;
  const stop = new AbortController();
  const nav = guarded({ signal: stop.signal }, () => navigate.handler({ url: 'https://b.test/' }, { chatId: 'c3', signal: stop.signal }));
  await until(() => chrome.replies.length > 0);
  chrome.replies.shift()!();
  await tick();
  stop.abort();
  asked.resolve(null);
  await until(() => chrome.replies.length > 0);
  chrome.replies.shift()!();
  await assert.rejects(nav, { code: 'denied' });
  assert.deepEqual(chrome.sent.slice(sent), ['browser_navigate', 'browser_navigate']);
  channel.stopAll();
});

test('CM-R08: quitting or switching computer use off gives the Mac back first: held input, hidden apps, the clipboard, the lock', async () => {
  const host = { hide: () => true, show() {} };
  const r = desktopRig({ hide: true, host });
  await r.ready([NOTES]);
  r.helper.hidden = [{ pid: 30, bundleId: 'x.y' }];
  r.helper.field = { value: '' };
  await r.call('desktop_type', { text: 'hello\nworld' });
  assert.equal(r.clip(), 'hello\nworld', "typed by paste: the clipboard is the tools'");
  r.d.session('c1').held.keys.add('shift');
  assert.deepEqual(r.d.holders(), ['c1']);
  await r.d.letGoAll();
  assert.deepEqual(r.callsOf('releaseInput').at(-1).args, [{ keys: ['shift'], buttons: [] }]);
  assert.deepEqual(r.callsOf('restoreApps').at(-1).args[0], [30]);
  assert.equal(r.callsOf('restoreClipboard').length, 1);
  assert.equal(r.cu.controlling, null);
  assert.deepEqual(r.d.holders(), []);
  // and nothing takes the desktop, or writes the clipboard put back, again before the helper stops
  await rejects(r.call('desktop_left_click', { coordinate: [10, 10] }), 'unavailable', /shutting down/);
  r.d.session('c1').clipboardWrite = true;
  await rejects(r.call('desktop_write_clipboard', { text: 'late' }), 'unavailable', /shutting down/);
  const apps = appRig();
  await apps.shoot();
  apps.cu.closed = true;
  await assert.rejects(apps.call('desktop_app_click', { app: 'Notes', element_index: 7 }), /shutting down/);
});

test('CM-R09: the helper crashing gives the Mac back through a relaunched helper; the clipboard comes back from main', async () => {
  const host = { hide: () => true, show() {} };
  const r = desktopRig({ hide: true, host });
  await r.ready([NOTES]);
  r.helper.hidden = [{ pid: 30, bundleId: 'x.y' }];
  r.helper.field = { value: '' };
  r.setClip('the user copied this');
  await r.call('desktop_type', { text: 'hello\nworld' });
  // a relaunched helper is running again
  r.helper.start = async () => {
    r.helper.calls.push({ method: 'start', args: [] });
    r.helper.running = true;
    return {};
  };
  r.d.session('c1').held.buttons.add('left');
  // the helper crashed: its copy of the clipboard went with it, so a relaunched one has nothing to put back
  r.helper.running = false;
  r.cu.controlling = null;
  r.helper.restoreClipboard = async () => ({ restored: false });
  const starts = r.callsOf('start').length;
  await r.d.helperExited();
  assert.equal(r.callsOf('start').length, starts + 1, 'relaunched to give things back');
  assert.deepEqual(r.callsOf('restoreApps').at(-1).args[0], [30]);
  assert.deepEqual(r.callsOf('releaseInput').at(-1).args, [{ keys: [], buttons: ['left'] }]);
  assert.equal(r.clip(), 'the user copied this');
  assert.deepEqual(r.d.holders(), []);
  // the helper that can't even be told to put it back: the text kept in main comes back; something the user copied since stays
  r.helper.running = true;
  await r.call('desktop_type', { text: 'again\n' });
  r.helper.fail.restoreClipboard = new Error('helper_not_running');
  await r.d.turnEnded('c1');
  assert.equal(r.clip(), 'the user copied this');
  delete r.helper.fail.restoreClipboard;
  await r.call('desktop_type', { text: 'third\n' });
  r.setClip('copied meanwhile');
  r.helper.fail.restoreClipboard = new Error('helper_not_running');
  await r.d.turnEnded('c1');
  assert.equal(r.clip(), 'copied meanwhile');
});

test("CM-R10: a Codex sub-agent thread's tool calls are charged to its parent's chat, so Stop on that chat aborts them", async () => {
  const parent = 'thr-parent';
  const child = 'thr-child';
  // the shared sub-agent map links it (codexParents.cjs); requestChat follows the link (agentTools.cjs wires it as the owner)
  const ctl = {
    parents: { parentOf: (k: string) => (k === child ? parent : null) },
    chats: { records: new Map([['chat-1', {}]]) },
    chatOf: (k: string) => (k === parent ? 'chat-1' : k),
  };
  const sessions = new ToolSessions();
  const inj = new CodexToolInjection({
    sessions,
    command: '/bin/sage-mcp',
    socketPath: '/tmp/s.sock',
    harnessPid: () => 1,
    chatOf: (id: string) => ChatController.prototype.requestChat.call(ctl, id),
  });
  inj.outgoing({ id: 5, method: 'thread/resume', params: { threadId: child } });
  inj.observe({ id: 5, result: { thread: { id: child } } });
  const s = sessions.get(inj.byThread.get(child));
  assert.equal(s.chatId, 'chat-1');
  assert.equal(s.segmentId, child);
  const r = new Registry();
  r.setApprover(() => true);
  const reached = deferred();
  r.register({
    name: 'desktop_click',
    policy: 'act',
    handler: (_args: any, ctx: any) =>
      new Promise((_resolve, reject) => {
        reached.resolve(null);
        ctx.signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
  });
  const res = r.invoke(s.chatId, s.segmentId, 'desktop_click', {});
  await reached.promise;
  assert.equal(r.abortChat('chat-1', 'stopped'), 1);
  assert.equal((await res).error.code, 'aborted');
  // a native thread's sub-agent (thread/started names its parent) resolves through the injection's own link too
  inj.nativeThreads.set(parent, { chrome: false, computer: true });
  inj.loaded.add(parent);
  inj.observe({ method: 'thread/started', params: { thread: { id: 'thr-native-sub', parentThreadId: parent } } });
  assert.equal(inj.ownerOf('thr-native-sub'), 'chat-1');
});

test('CM-R11: a Codex or ACP harness cancelling one call (MCP notifications/cancelled) stops that call; sage-mcp leaving stops its calls', async () => {
  const sessions = new ToolSessions();
  const r = new Registry();
  const aborted: string[] = [];
  r.register({
    name: 'desktop_wait',
    policy: 'observe',
    handler: (args: any, ctx: any) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => (aborted.push(args.n), resolve('late')));
        if (args.quick) resolve('done');
      }),
  });
  const sock = new ToolSocket({ sessions, registry: r, verifyPeer: async () => null });
  const socketPath = await sock.listen();
  const { token } = sessions.open('chat-1', { harnessPid: 1 });
  const conn = net.createConnection(socketPath);
  const replies = new Map<any, any>();
  let buf = '';
  conn.setEncoding('utf8');
  conn.on('data', (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const m = JSON.parse(buf.slice(0, i));
      buf = buf.slice(i + 1);
      replies.set(m.id, m);
    }
  });
  const send = (m: any) => conn.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');
  await new Promise((r) => conn.once('connect', r));
  send({ id: 'hello', method: 'hello', params: { token, pid: 2 } });
  await until(() => replies.has('hello'));
  send({ id: 7, method: 'tools/call', params: { name: 'desktop_wait', arguments: { n: 'seven' } } });
  send({ id: '7', method: 'tools/call', params: { name: 'desktop_wait', arguments: { n: 'string seven' } } });
  send({ id: 8, method: 'tools/call', params: { name: 'desktop_wait', arguments: { n: 'eight', quick: true } } });
  await until(() => replies.has(8));
  // a cancel for a call that already finished, or one never made, does nothing
  send({ method: 'notifications/cancelled', params: { requestId: 8 } });
  send({ method: 'notifications/cancelled', params: {} });
  send({ method: 'notifications/cancelled', params: { requestId: 7, reason: 'user interrupt' } });
  await until(() => replies.has(7));
  assert.equal(replies.get(7).result.isError, true);
  assert.match(replies.get(7).result.content.at(-1).text, /harness cancelled this call/);
  assert.deepEqual(aborted, ['seven'], 'only that call: "7" is another request');
  // sage-mcp goes away (its harness quit): its running calls stop
  conn.destroy();
  await until(() => aborted.length === 2);
  assert.deepEqual(aborted, ['seven', 'string seven']);
  sock.close();
});

/** A fake helper on a unix socket that answers every request and records its method. */
async function socketHelper() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmr-'));
  const file = path.join(dir, 'h.sock');
  const got: string[] = [];
  const server = net.createServer((s) => {
    let buf = '';
    s.setEncoding('utf8');
    s.on('data', (d: string) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const m = JSON.parse(buf.slice(0, i));
        buf = buf.slice(i + 1);
        if (m.method !== 'hello') got.push(m.method);
        if (m.id != null) s.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result: { seconds: 0, version: '1' } }) + '\n');
      }
    });
  });
  await new Promise<void>((r) => server.listen(file, () => r()));
  return { file, got, close: () => (server.close(), fs.rmSync(dir, { recursive: true, force: true })) };
}

test('CM-R12: the guard: once a call is stopped, the helper refuses every request but those that give the Mac back, and the Registry runs every handler inside it', async () => {
  const fake = await socketHelper();
  const helper = new ComputerHelper({ connectTo: fake.file, callTimeoutMs: 2000 });
  // the helper's own launch never carries a call's guard
  await guarded({ signal: AbortSignal.abort() }, () => helper.start());
  const requests = Object.getOwnPropertyNames(ComputerHelper.prototype).filter(
    (n) => !['constructor', 'start', 'call', 'stop', 'running'].includes(n) && typeof (helper as any)[n] === 'function',
  );
  assert.ok(requests.length >= 30, 'every request the helper client has');
  // outside a call: every one of them reaches the helper
  for (const n of requests) await (helper as any)[n]();
  const all = [...fake.got];
  assert.equal(all.length, requests.length);
  // inside a stopped call: only the requests that give something back
  fake.got.length = 0;
  const refused: string[] = [];
  await guarded({ signal: AbortSignal.abort() }, async () => {
    for (const n of requests)
      await (helper as any)[n]().catch((e: any) => {
        assert.equal(e.reason, 'aborted', `${n}: ${e.message}`);
        refused.push(n);
      });
  });
  assert.deepEqual(new Set(fake.got), new Set(all.filter((m) => GIVES_BACK.has(m))));
  assert.equal(refused.length + fake.got.length, requests.length);
  assert.ok(refused.includes('click') && refused.includes('acquireControl') && refused.includes('hideOthers'));
  // a guard whose chat epoch moved, nested in a live one: refused too; a live one goes through
  let epoch = 0;
  await guarded({ signal: new AbortController().signal }, () =>
    guarded({ epoch: () => epoch }, async () => {
      await helper.click(1, 1);
      epoch++;
      await assert.rejects(helper.click(1, 1), { reason: 'aborted' });
      assert.equal(mayAct(), false);
      assert.equal(
        unguarded(() => mayAct()),
        true,
      );
    }),
  );
  helper.stop();
  fake.close();
  // the Registry: a handler still running after its call was aborted can no longer act
  const r = new Registry();
  const seen: boolean[] = [];
  const held = deferred();
  r.register({
    name: 'desktop_probe',
    policy: 'observe',
    handler: async () => {
      seen.push(mayAct());
      await held.promise;
      seen.push(mayAct());
    },
  });
  const ac = new AbortController();
  const res = r.invoke('c1', 'c1', 'desktop_probe', {}, { signal: ac.signal });
  await tick();
  ac.abort();
  assert.equal((await res).error.code, 'aborted');
  held.resolve(null);
  await tick();
  assert.deepEqual(seen, [true, false]);
  assert.equal(mayAct(), true, 'outside any call');
  // a wait in a call stopped meanwhile ends early
  const waiting = new AbortController();
  const t0 = Date.now();
  const p = guarded({ signal: waiting.signal }, () => pause(60_000));
  waiting.abort();
  await p;
  await guarded({ signal: AbortSignal.abort() }, () => pause(60_000));
  assert.ok(Date.now() - t0 < 1000);
  assert.ok(new ToolError('x', 'stopped') instanceof Error);
});

/** The statement that takes a lock and the function around it: the guard's check comes first in that function. */
test('CM-R13: every place that takes the desktop or an app lock checks the call may still act before it does', () => {
  const root = path.join(import.meta.dirname, '..', 'electron');
  const files = treeFiles(root, /\.cjs$/);
  const takes: string[] = [];
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split('\n');
    lines.forEach((line, i) => {
      if (!/\.controlling = (?!null)\w|this\.locks\.set\(/.test(line)) return;
      const rel = `${path.relative(root, f)}:${i + 1}`;
      takes.push(rel);
      // the enclosing method: the nearest line above that opens one at class-member indentation
      let start = i;
      while (start > 0 && !/^ {2}(async )?[#\w]+\(.*\) \{$/.test(lines[start])) start--;
      const before = lines.slice(start, i).join('\n');
      assert.match(before, /checkAct\(|stillActing\(/, `${rel} takes a lock without checking the call may still act`);
    });
  }
  assert.ok(takes.length >= 3, `found the lock takers: ${takes.join(', ')}`);
});
