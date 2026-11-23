// The control matrix's press-and-hold cases (docs/control-plane/matrix.md, group F): the in-app browser's browser_*
// tools hold a mouse button or keys down for a given time (WebGames button-hold and key-combo), the same for Claude
// Code, a Codex thread and a chat that switched harness, through CDP Input events in the tab's action queue, gated
// like any other write, and nothing stays held after a Stop, a turn end, a failure or the Codex browser plugin letting
// go of the tab. The Registry, the tool channels, BrowserTabs, OriginGrants and IabBackend are real; the page's
// webContents and debugger are fakes that record the CDP commands.
import { waitFor } from './support/waitFor.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { world, claudeSession, claudeInterrupt, codexConnection, switchingChat } from './support/control-matrix-kit.ts';
import { setup, tabOf, drive, flush } from './support/browser-host-kit.ts';
import { browserToolSpecs } from './support/tool-specs.ts';

export const GUARDS = ['electron/', 'shared/'];

const require = createRequire(import.meta.url);
const { createBrowserTools } = require('../electron/capabilities/browser/hostTools.cjs');
const { OriginGrants } = require('../electron/capabilities/browser/origins.cjs');
const { BrowserTabs } = require('../electron/capabilities/browser/host.cjs');
const { IabBackend } = require('../electron/capabilities/browser/iabBackend.cjs');
const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');
const { noteInput, isHolding } = require('../electron/capabilities/browser/heldInput.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const PAGE = 'https://webgames.test/button-hold';

/**
 * One app: the kit's routing world with the real browser_* tools over a real BrowserTabs whose chat `c` has a tab
 * on a WebGames page, the site allowed read and write (`level` lowers it, and the card a write then puts up is answered
 * Read only again: #1319 G22).
 */
function app(t: any, { level = 'write' } = {}) {
  const h = setup(t);
  const wc = h.newWC();
  wc.url = PAGE;
  const tab = tabOf(h, 'tab_aaaaaa', 'c', wc);
  const w = world();
  // the kit's stand-ins give way to the real tools
  for (const n of ['browser_navigate', 'browser_tabs_context']) w.r.tools.delete(n);
  const grants = new OriginGrants({
    anchor: () => 'default',
    ask: async () => ({ decision: 'allow', scope: 'chat', level }),
    confirmAction: async () => true,
  });
  if (level === 'read') grants.allowInChat('c', new URL(PAGE).origin, 'read');
  for (const tool of createBrowserTools({ tabs: h.tabs, grants })) w.r.register(tool);
  const sent = () =>
    wc.debugger.calls
      .filter((c: any) => c.method === 'Input.dispatchMouseEvent' || c.method === 'Input.dispatchKeyEvent')
      .map((c: any) => (c.method === 'Input.dispatchKeyEvent' ? `${c.params.type} ${c.params.key}` : `${c.params.type}`));
  return { h, w, wc, tab, grants, sent };
}

/** The text a tool result carries. */
const textOf = (r: any) => (r?.content ?? r ?? []).map((c: any) => c.text ?? '').join('\n');

/**
 * The harnesses a call of chat `c` can come through: a Claude Code session, a Codex thread, and the chat's Codex
 * thread after it switched from Claude Code (its Claude segment's session first).
 */
async function harnesses(w: any) {
  const claude = claudeSession(w, { chatId: 'c', segmentId: 'claude-1' });
  const codex = codexConnection(w, () => 'c');
  const cx = await codex.session((await codex.startThread()).thread.id);
  const sw = switchingChat(w);
  sw.startOnClaude('c');
  const before = sw.claudeNow('c');
  const after = await sw.codex.session((await sw.switchTo('c', 'codex')).nativeId);
  assert.equal(after.owner.chatId, 'c');
  return {
    'Claude Code': (name: string, args: any) => claude.call(name, args),
    Codex: (name: string, args: any) => cx.call(name, args),
    'Claude Code before the switch': (name: string, args: any) => before.call(name, args),
    'Codex after the switch': (name: string, args: any) => after.call(name, args),
  } as Record<string, (name: string, args: any) => Promise<any>>;
}

test('CM-F01: every harness is offered press and hold on the shared browser_computer and browser_script definitions', async (t) => {
  const specs = Object.fromEntries(browserToolSpecs().map((s: any) => [s.name, s]));
  const computer = specs.browser_computer;
  assert.equal(computer.inputSchema.properties.duration.maximum, 30);
  assert.match(computer.inputSchema.properties.duration.description, /holds each press down/);
  assert.match(computer.description, /Press and hold: duration on a click or key action/);
  assert.match(specs.browser_script.description, /delay \(ms, up to 30000\) on click or press holds/);
  const { w, sent } = app(t);
  // the same Registry definition reaches Claude Code's host server and Codex threads' sage-mcp, before and after a switch
  const via = await harnesses(w);
  for (const [harness, call] of Object.entries(via)) {
    const out = textOf(await drive(t, call('browser_computer', { action: 'left_click', coordinate: [1, 1], duration: 0.1 })));
    assert.match(out, /^left click \(held 0\.1 s\)/, harness);
  }
  assert.equal(sent().filter((e: string) => e === 'mouseReleased').length, 4);
  assert.deepEqual(w.r.tools.get('browser_computer').schema, computer.inputSchema);
});

/** Runs virtual time forward `ms` in 50 ms steps, letting the work it wakes run. */
async function advance(t: any, ms: number) {
  for (let left = ms; left > 0; left -= 50) {
    await flush();
    t.mock.timers.tick(Math.min(50, left));
  }
  await flush();
}
/** Runs virtual time until `ok()` holds. */
async function until(t: any, ok: () => boolean) {
  await waitFor(ok, 'the condition', { step: () => advance(t, 10) }).catch(() => {});
  assert.ok(ok(), 'reached');
}

test('CM-F02: a click with duration holds the mouse button that long, then lets go, for Claude Code, Codex and a chat that switched', async (t) => {
  const { w, wc, sent } = app(t);
  const via = await harnesses(w);
  for (const [harness, call] of Object.entries(via)) {
    wc.debugger.calls.length = 0;
    const p = call('browser_computer', { action: 'left_click', coordinate: [100, 200], duration: 3 });
    await until(t, () => sent().includes('mousePressed'));
    await advance(t, 2800);
    assert.deepEqual(sent(), ['mouseMoved', 'mousePressed'], `${harness}: the button is still down at 2.8 s`);
    const out = textOf(await drive(t, p));
    assert.deepEqual(sent(), ['mouseMoved', 'mousePressed', 'mouseReleased'], harness);
    assert.match(out, /^left click \(held 3 s\) at \(100, 200\)\./, harness);
    const [, press, release] = wc.debugger.sent('Input.dispatchMouseEvent').map((c: any) => c.params);
    assert.deepEqual([press.button, press.buttons, release.button, release.buttons], ['left', 1, 'left', 0]);
  }
});

test('CM-F03: a key chord presses its modifiers as keys (held while the key is pressed), and duration holds them all', async (t) => {
  const { w, wc, sent } = app(t);
  const via = await harnesses(w);
  for (const [harness, call] of Object.entries(via)) {
    wc.debugger.calls.length = 0;
    await drive(t, call('browser_computer', { action: 'key', text: 'ctrl+shift+k' }));
    assert.deepEqual(
      sent(),
      ['rawKeyDown Control', 'rawKeyDown Shift', 'rawKeyDown K', 'keyUp K', 'keyUp Shift', 'keyUp Control'],
      harness,
    );
    // each key carries the modifiers down at that moment, as a keyboard reports them
    assert.deepEqual(
      wc.debugger.sent('Input.dispatchKeyEvent').map((c: any) => c.params.modifiers),
      [2, 10, 10, 10, 2, 0],
    );
    wc.debugger.calls.length = 0;
    const p = call('browser_computer', { action: 'key', text: 'ctrl+shift', duration: 2 });
    await until(t, () => sent().length === 2);
    await advance(t, 1800);
    assert.deepEqual(sent(), ['rawKeyDown Control', 'rawKeyDown Shift'], `${harness}: both keys are still down at 1.8 s`);
    assert.match(textOf(await drive(t, p)), /^Pressed ctrl\+shift \(held 2 s\)\./);
    assert.deepEqual(sent().slice(2), ['keyUp Shift', 'keyUp Control'], harness);
  }
});

test('CM-F04: Stop or the end of the turn during a hold lets go at once and reports the call stopped', async (t) => {
  const { w, h, tab, wc, sent } = app(t);
  // Claude Code's Stop: the CLI aborts the running call
  const claude = claudeSession(w, { chatId: 'c', segmentId: 'claude-stop' });
  const p = claude.call('browser_computer', { action: 'left_click', coordinate: [5, 5], duration: 20 });
  await until(t, () => sent().includes('mousePressed'));
  await advance(t, 1000);
  claudeInterrupt('claude-stop');
  // the button comes up at once, not when the 20 s would have passed
  const out = await drive(t, p, { max: 4 });
  assert.deepEqual(sent(), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  assert.match(textOf(out), /cancelled this call/);
  // the turn ending (its token no longer current, as on Codex and after a switch) during a key hold
  wc.debugger.calls.length = 0;
  let current = true;
  const held = guarded({ token: { chatId: 'c', turn: 1 }, current: () => current }, () =>
    h.tabs.keys(tab, 'shift+a', 1, { holdMs: 20_000 }),
  ).then(
    () => null,
    (e: any) => e,
  );
  await until(t, () => sent().length === 2);
  current = false;
  await advance(t, 100);
  assert.match((await held)?.message, /Stopped by the user before the hold ended/);
  assert.deepEqual(sent(), ['rawKeyDown Shift', 'keyDown A', 'keyUp A', 'keyUp Shift']);
  // a call already stopped presses nothing at all: the tab's queue refuses it
  wc.debugger.calls.length = 0;
  await assert.rejects(
    guarded({ token: { chatId: 'c', turn: 1 }, current: () => false }, () =>
      h.tabs.run(tab, () => h.tabs.click(tab, { x: 1, y: 1 }, { holdMs: 1000 })),
    ),
    /Stopped by the user/,
  );
  assert.deepEqual(sent(), []);
  // a dialog opening under a hold: the action returns at once, and the button comes up instead of staying down
  // behind the next action
  await drive(t, tab.attach());
  const dialog = h.tabs.click(tab, { x: 2, y: 2 }, { holdMs: 20_000 });
  await until(t, () => sent().includes('mousePressed'));
  wc.debugger.event('Page.javascriptDialogOpening', { type: 'confirm', message: 'Keep holding?' });
  assert.equal(await drive(t, dialog, { max: 4 }), 'dialog');
  await advance(t, 100);
  assert.deepEqual(sent(), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('CM-F05: a hold is gated like any other write: a read-only site, or more than 30 s in all, presses nothing', async (t) => {
  const ro = app(t, { level: 'read' });
  const via = await harnesses(ro.w);
  for (const [harness, call] of Object.entries(via)) {
    for (const args of [
      { action: 'left_click', coordinate: [1, 1], duration: 2 },
      { action: 'key', text: 'ctrl+shift', duration: 2 },
    ]) {
      const out = await drive(t, call('browser_computer', args));
      // the first write asks and is answered Read only again (#1319 G22), the rest of the turn is refused at once: nothing pressed
      assert.match(textOf(out), /read-only access|read only for this chat/, `${harness} ${args.action}`);
    }
  }
  assert.deepEqual(ro.sent(), []);
  const { w, sent } = app(t);
  const { Codex: codex } = await harnesses(w);
  for (const args of [
    { action: 'triple_click', coordinate: [1, 1], duration: 11 },
    { action: 'key', text: 'a b', duration: 16 },
    { action: 'key', text: 'a', duration: 10, repeat: 4 },
  ]) {
    const out = await drive(t, codex('browser_computer', args));
    assert.match(textOf(out), /at most 30 seconds in all/, args.action);
  }
  assert.deepEqual(sent(), []);
});

test('CM-F06: a failure mid-hold still lets go of what is down', async (t) => {
  const { h, tab, wc, sent } = app(t);
  let fail = false;
  wc.handlers['Input.dispatchKeyEvent'] = (p: any) => {
    if (fail && p.type === 'keyUp') throw new Error('page went away');
    if (p.key === 'K') throw new Error('renderer busy');
    return {};
  };
  await assert.rejects(drive(t, h.tabs.keys(tab, 'ctrl+shift+k')), /renderer busy/);
  // K never went down for the page, but it is let go too; then Shift and Control, last pressed first
  assert.deepEqual(sent(), ['rawKeyDown Control', 'rawKeyDown Shift', 'rawKeyDown K', 'keyUp K', 'keyUp Shift', 'keyUp Control']);
  // a let-go that fails is noted and the rest still go
  wc.debugger.calls.length = 0;
  fail = true;
  clearIgnored();
  await assert.rejects(drive(t, h.tabs.keys(tab, 'alt+shift+k')), /renderer busy/);
  assert.deepEqual(sent(), ['rawKeyDown Alt', 'rawKeyDown Shift', 'keyDown K', 'keyUp K', 'keyUp Shift', 'keyUp Alt']);
  const noted = recentIgnored().filter((e: any) => /let go of a key or mouse button/.test(e.context));
  assert.equal(
    noted.reduce((n: number, e: any) => n + e.count, 0),
    3,
  );
});

/* ---------- the Codex browser plugin's raw CDP (IabBackend) ---------- */

/** A tab of the in-app browser as IabBackend sees it, recording the CDP its debugger gets directly. */
function pluginTab() {
  const dbg: any = Object.assign(new EventEmitter(), { sent: [] as any[], isAttached: () => true });
  dbg.sendCommand = async (m: string, p: any, sid?: string) => (dbg.sent.push(sid ? [m, p, sid] : [m, p]), {});
  const tab: any = {
    id: 'tab_1',
    url: 'https://webgames.test/key-combo',
    title: 'Key combo',
    closed: false,
    takenOver: false,
    frames: new Map(),
    queue: Promise.resolve(),
    get backend() {
      return this.wc;
    },
    wc: { debugger: dbg, isDestroyed: () => false },
    sends: [] as any[],
    async attach() {},
    hold() {},
    rendererGone: () => false,
    async send(m: string, p: any = {}, sid = '') {
      tab.sends.push([m, p, sid]);
      return {};
    },
    async agent() {
      return { count: 0 };
    },
  };
  return tab;
}

test('CM-F07: keys and buttons the Codex browser plugin pressed and left down are let go when the turn ends or it lets go of the tab', async (t) => {
  const tab = pluginTab();
  const host: any = {
    o: {},
    list: () => [tab],
    current: () => tab,
    create: async () => tab,
    intent: async () => null,
    run: BrowserTabs.prototype.run,
    acted: () => {},
  };
  const grants: any = {
    peek: () => 'ok',
    riskOf: () => ({ level: 'low', credentials: false }),
    require: async () => {},
    act: async () => {},
  };
  const b = new IabBackend({ threadId: 'cx-1', chatOf: () => 'c', tabs: () => host, grants: () => grants, flavor: 'prod' });
  const call = (method: string, params: any = {}) => b.handle(method, { session_id: 'cx-1', ...params });
  await call('getTabs');
  const cdp = (method: string, commandParams: any) => call('executeCdp', { target: { tabId: 1 }, method, commandParams });
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Control', code: 'ControlLeft', modifiers: 2 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: 'k', code: 'KeyK', text: 'k', modifiers: 2 });
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: 'k', code: 'KeyK', modifiers: 2 });
  await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: 40, y: 50, button: 'left', buttons: 1, clickCount: 1 });
  // the plugin's turn ends with the control key and the button still down
  await call('turnEnded', {});
  await flush();
  assert.deepEqual(
    tab.wc.debugger.sent.filter(([m]: any) => m.startsWith('Input.')).map(([m, p]: any) => `${m} ${p.type} ${p.key ?? p.button}`),
    ['Input.dispatchMouseEvent mouseReleased left', 'Input.dispatchKeyEvent keyUp Control'],
  );
  const release = tab.wc.debugger.sent.find(([, p]: any) => p.type === 'mouseReleased')[1];
  assert.deepEqual([release.x, release.y, release.buttons], [40, 50, 0]);
  // the debugger going away (the host detached it): nothing is left to let go of, and nothing is sent later
  await call('attach', { tabId: 1 });
  await cdp('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Alt', code: 'AltLeft', modifiers: 1 });
  assert.equal(isHolding(tab), true);
  const before = tab.wc.debugger.sent.length;
  tab.wc.debugger.emit('detach', {}, 'target closed');
  assert.equal(isHolding(tab), false);
  assert.equal(tab.wc.debugger.sent.length, before);

  // the chat's turn ends in the host (Stop, or a switch away) with a key the plugin left down: let go before CDP detaches
  const { h, tab: iab, wc } = app(t);
  noteInput(iab, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Shift', code: 'ShiftLeft', modifiers: 8 }, 'child-1');
  noteInput(iab, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 3, y: 4, button: 'right' });
  await drive(t, iab.attach());
  const attached: boolean[] = [];
  // a dialog blocks the page: the key-up never gets an answer, and the turn end does not wait for one
  wc.handlers['Input.dispatchKeyEvent'] = () => (attached.push(wc.debugger.isAttached()), new Promise(() => {}));
  // and it goes out before the turn's commands stop: a Chrome tab's relay refuses them after (#1632)
  const order: string[] = [];
  h.tabs.onTurnEnd(() =>
    order.push(`turn over after ${wc.debugger.calls.filter((c: any) => c.method.startsWith('Input.')).length} releases`),
  );
  await drive(t, h.tabs.turnEnded('c'));
  assert.deepEqual(order, ['turn over after 2 releases']);
  const ups = wc.debugger.calls.filter((c: any) => c.method.startsWith('Input.'));
  assert.deepEqual(
    ups.map((c: any) => [c.method, c.params.type, c.params.button ?? c.params.key, c.sessionId]),
    [
      ['Input.dispatchMouseEvent', 'mouseReleased', 'right', undefined],
      ['Input.dispatchKeyEvent', 'keyUp', 'Shift', 'child-1'],
    ],
  );
  assert.deepEqual(attached, [true]);
  assert.equal(wc.debugger.isAttached(), false);
  assert.equal(isHolding(iab), false);
  // a tab whose debugger is already gone sends nothing and forgets what was down
  noteInput(iab, 'Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Meta', code: 'MetaLeft', modifiers: 4 });
  wc.debugger.calls.length = 0;
  iab.detach();
  assert.deepEqual(wc.debugger.calls, []);
  assert.equal(isHolding(iab), false);
});
