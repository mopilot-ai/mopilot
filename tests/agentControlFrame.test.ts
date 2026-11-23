// The control frame on a tab of the user's Chrome (#1632, agentControlFrame.cjs inside agentCursor.cjs): the glow and
// Stop pill drawn in the cursor's world, Stop reaching main through the cursor world's binding (only on a real click
// and only for a tab held this turn), the frame following the agent's first call and each new page, and the app's
// Chrome setup giving the Chrome host such a cursor whose Stop stops the chat.
import { test, after, afterEach, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
import { labelText } from '../shared/labelText.mjs';

const require = createRequire(import.meta.url);
const { AgentCursor, cursorOverlay, CURSOR_WORLD, FRAME_IDLE_MS } = require('../electron/capabilities/browser/agentCursor.cjs');
const { controlFrame, FRAME_CSS, STOP_BINDING, FRAME_SOURCE } = require('../electron/capabilities/browser/agentControlFrame.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

/* ---------- main: the cursor with its frame ---------- */

function fakeTab(o: any = {}) {
  let ctx = 0;
  const calls: any[] = [];
  const dbg: any = new EventEmitter();
  Object.assign(dbg, { isAttached: () => true, sendCommand: async () => ({}) });
  const tab: any = {
    calls,
    chatId: 'chat-1',
    get backend() {
      return this.wc;
    },
    wc: { isDestroyed: () => false, debugger: o.noEvents ? { isAttached: () => true, sendCommand: async () => ({}) } : dbg },
    async send(method: string, params: any = {}) {
      calls.push([method, params]);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: ++ctx };
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    },
  };
  return { tab, dbg };
}
const shows = (tab: any) =>
  tab.calls.filter((c: any) => c[0] === 'Runtime.evaluate' && c[1].expression.startsWith('globalThis.__mopilotCursor.')).length;

test('frame cursor: the binding goes into the cursor world first, and the overlay is made with the frame', async () => {
  const cursor = new AgentCursor({ frame: true });
  const { tab } = fakeTab();
  assert.equal(await cursor.hold(tab), true);
  const names = tab.calls.map((c: any) => c[0]);
  assert.deepEqual(names.slice(0, 3), ['Runtime.addBinding', 'Page.getFrameTree', 'Page.createIsolatedWorld']);
  assert.deepEqual(tab.calls[0][1], { name: STOP_BINDING, executionContextName: CURSOR_WORLD });
  const inject = tab.calls.find((c: any) => c[0] === 'Runtime.evaluate' && c[1].expression.includes(FRAME_SOURCE));
  assert.ok(inject[1].expression.endsWith(`lifeMs: ${FRAME_IDLE_MS} }, ${labelText.toString()}, 500), true`));
  assert.ok(inject[1].expression.includes(JSON.stringify(FRAME_CSS)));
  assert.equal(tab.calls.at(-1)[1].expression, 'globalThis.__mopilotCursor.show({"frame":true})');
  // held: later calls of the turn draw nothing more
  assert.equal(await cursor.hold(tab), null);
  assert.equal(shows(tab), 1);
  // without the frame, or switched off, hold draws nothing
  assert.equal(await new AgentCursor().hold(fakeTab().tab), null);
  assert.equal(await new AgentCursor({ frame: true, enabled: () => false }).hold(fakeTab().tab), null);
  assert.equal(await new AgentCursor({ frame: true }).mark(fakeTab().tab), null, 'not held');
  // a draw that fails is tried again on the next call
  const slow = fakeTab().tab;
  const send = slow.send;
  let fail = true;
  slow.send = (m: string, p: any) => (fail && m === 'Page.getFrameTree' ? Promise.reject(new Error('busy')) : send(m, p));
  const retry = new AgentCursor({ frame: true });
  assert.equal(await retry.hold(slow), null);
  assert.equal(retry.held.has(slow), false);
  fail = false;
  assert.equal(await retry.hold(slow), true);
  assert.equal(retry.held.has(slow), true);
});

test('frame cursor: Stop on a held tab stops its chat; a new page gets the frame; a lost debugger drops the world', async () => {
  const stopped: any[] = [];
  const cursor = new AgentCursor({ frame: true, onStop: (tab: any) => stopped.push(tab.chatId) });
  const { tab, dbg } = fakeTab();
  await cursor.act(tab, { kind: 'click', x: 1, y: 2 });
  dbg.emit('message', {}, 'Runtime.bindingCalled', { name: 'other', payload: 'stop' });
  dbg.emit('message', {}, 'Runtime.bindingCalled', { name: STOP_BINDING, payload: 'stop' });
  assert.deepEqual(stopped, ['chat-1']);
  const before = shows(tab);
  dbg.emit('message', {}, 'Page.domContentEventFired', {});
  await new Promise((r) => setImmediate(r));
  assert.equal(shows(tab), before + 1);
  dbg.emit('message', {}, 'Page.frameNavigated', {});
  // the debugger went: the next draw makes the world again (with its binding)
  dbg.emit('detach', {}, 'target_closed');
  await cursor.act(tab, { kind: 'type' });
  assert.equal(tab.calls.filter((c: any) => c[0] === 'Runtime.addBinding').length, 2);
  // once cleared (turn end) the tab is not held: Stop and new pages do nothing
  cursor.clear(tab);
  dbg.emit('message', {}, 'Runtime.bindingCalled', { name: STOP_BINDING, payload: 'stop' });
  assert.deepEqual(stopped, ['chat-1']);
  // a failing onStop is noted, not thrown; listeners are added once per debugger
  const failing = new AgentCursor({
    frame: true,
    onStop: () => {
      throw new Error('no chat');
    },
  });
  await failing.hold(tab);
  await failing.act(tab, { kind: 'click', x: 1, y: 1 });
  assert.equal(dbg.listenerCount('message'), 2);
  dbg.emit('message', {}, 'Runtime.bindingCalled', { name: STOP_BINDING, payload: 'stop' });
  assert.ok(recentIgnored().some((e: any) => /stop a chat from the page/.test(e.what ?? e.context ?? JSON.stringify(e))));
  // a tab whose debugger has no events still draws; a default onStop does nothing
  const quiet = fakeTab({ noEvents: true });
  assert.equal(await new AgentCursor({ frame: true }).hold(quiet.tab), true);
  new AgentCursor({ frame: true }).onStop(tab);
});

/* ---------- the overlay in a page ---------- */

const win: any = new Window({ url: 'https://site.test/', width: 1024, height: 768 });
const G: any = globalThis;
const saved = { document: G.document, window: G.window, CSSStyleSheet: G.CSSStyleSheet, requestAnimationFrame: G.requestAnimationFrame };
after(() => {
  Object.assign(G, saved);
  delete G.__mopilotCursor;
  delete G[STOP_BINDING];
  win.happyDOM.close();
});
const shadows: any[] = [];
const attach = win.HTMLElement.prototype.attachShadow;
win.HTMLElement.prototype.attachShadow = function (init: any) {
  const root = attach.call(this, init);
  shadows.push(root);
  return root;
};
afterEach(() => G.__mopilotCursor?.clear());

beforeEach(() => {
  delete G.__mopilotCursor;
  delete G[STOP_BINDING];
  shadows.length = 0;
  win.document.documentElement.querySelectorAll('mopilot-agent-cursor').forEach((e: any) => e.remove());
  Object.assign(G, {
    document: win.document,
    window: { innerWidth: 1024, innerHeight: 768, addEventListener: () => undefined, removeEventListener: () => undefined },
    CSSStyleSheet: win.CSSStyleSheet,
    requestAnimationFrame: (cb: any) => setTimeout(cb, 0),
  });
});
const control = (lifeMs = FRAME_IDLE_MS) => ({ frame: controlFrame, css: FRAME_CSS, binding: STOP_BINDING, lifeMs });
const part = (sel: string) => shadows.at(-1).querySelector(sel);
const click = (el: any, trusted = true) => {
  const e = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'isTrusted', { value: trusted });
  el.dispatchEvent(e);
};

test('overlay with the frame: the frame alone first, then the pointer; the pill moves away from the agent', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = cursorOverlay(30_000, control());
  assert.equal(api.show({ frame: true }), true);
  assert.ok(part('.mp-frame'));
  assert.equal(part('.mp-text').textContent, 'MoPilot is working in this tab');
  assert.equal(part('.mp-stop').textContent, 'Stop MoPilot');
  assert.equal(part('.mp-text').hidden, true);
  assert.equal(part('.mp-stop').tabIndex, -1, 'out of the Tab order the agent presses through');
  assert.equal(part('.pointer').hidden, true, 'no action yet');
  api.show({ x: 10, y: 20, click: true, label: 'Clicking' });
  assert.equal(part('.pointer').hidden, false);
  assert.equal(part('.mp-pill').classList.contains('mp-top'), false);
  // an action near the bottom: the pill goes to the top before the input lands; a drag counts its end
  api.show({ x: 10, y: 700, label: 'Clicking' });
  assert.equal(part('.mp-pill').classList.contains('mp-top'), true);
  api.show({ x: 10, y: 10, to: { x: 10, y: 760 }, label: 'Dragging' });
  assert.equal(part('.mp-pill').classList.contains('mp-top'), true);
  api.show({ x: 10, y: 10, label: 'Clicking' });
  assert.equal(part('.mp-pill').classList.contains('mp-top'), false);
  // idle: the pointer fades, the frame stays
  t.mock.timers.tick(30_000);
  assert.equal(part('.pointer').hidden, true);
  assert.equal(part('.label').hidden, true);
  assert.ok(win.document.documentElement.querySelector('mopilot-agent-cursor'));
  // main gone: it goes by itself after its life, fading out first (--dur-base, --ease-exit)
  t.mock.timers.tick(FRAME_IDLE_MS);
  const host = win.document.documentElement.querySelector('mopilot-agent-cursor');
  assert.equal(host.style.opacity, '0');
  assert.match(host.style.transition, /opacity 200ms cubic-bezier\(0\.8, 0, 0\.4, 1\)/);
  assert.equal(part('.mp-pill').classList.contains('mp-live'), false, 'a fading pill takes no pointer');
  t.mock.timers.tick(199);
  assert.ok(host.isConnected);
  t.mock.timers.tick(1);
  assert.equal(win.document.documentElement.querySelector('mopilot-agent-cursor'), null);
});

test('overlay with the frame: under reduced motion the frame only fades, and leaves in 120 ms; without the frame the overlay goes at once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  G.window = { ...G.window, matchMedia: (q: string) => ({ matches: q === '(prefers-reduced-motion: reduce)' }) };
  assert.match(
    FRAME_CSS,
    /prefers-reduced-motion: reduce\) \{\s*\.mp-frame, \.mp-pill \{ animation: mp-frame-in 120ms linear both; \} \.mp-glow, \.mp-stop, \.mp-review, \.mp-go \{ animation: none;/,
  );
  // the breath is an opacity animation of its own layer: the compositor runs it
  assert.match(FRAME_CSS, /\.mp-glow \{[^}]*will-change: opacity;[^}]*animation: mp-breathe/);
  assert.match(FRAME_CSS, /@keyframes mp-breathe \{ 0%, 100% \{ opacity: 1; \} 50% \{ opacity: \.68; \} \}/);
  const api = cursorOverlay(30_000, control());
  api.show({ frame: true });
  assert.ok(part('.mp-frame > .mp-glow'));
  api.clear();
  const host = win.document.documentElement.querySelector('mopilot-agent-cursor');
  assert.match(host.style.transition, /opacity 120ms/);
  t.mock.timers.tick(120);
  assert.equal(host.isConnected, false);
  // the plain cursor (the in-app browser) has no frame: cleared, it goes at once
  delete G.__mopilotCursor;
  const plain = cursorOverlay(30_000, null);
  plain.show({ x: 1, y: 1, label: 'x' });
  plain.clear();
  assert.equal(win.document.documentElement.querySelector('mopilot-agent-cursor'), null);
});

test('overlay with the frame: Stop calls the binding once, on a real click only; no binding changes nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls: string[] = [];
  const api = cursorOverlay(30_000, control());
  api.show({ frame: true });
  const stop = part('.mp-stop');
  click(stop);
  assert.equal(stop.disabled, false, 'no binding: still Stop');
  assert.equal(part('.mp-text').textContent, 'MoPilot is working in this tab');
  G[STOP_BINDING] = (p: string) => calls.push(p);
  click(stop, false);
  assert.deepEqual(calls, [], 'a page script cannot press it');
  click(stop);
  assert.deepEqual(calls, ['stop']);
  assert.equal(stop.disabled, true);
  assert.equal(part('.mp-text').textContent, 'Stopping…');
  click(stop);
  assert.deepEqual(calls, ['stop'], 'once');
  // still drawn 1.5 s later: the stop didn't arrive, and Stop works again
  t.mock.timers.tick(1500);
  assert.equal(part('.mp-text').textContent, "Stop didn't reach MoPilot. Press Esc there.");
  assert.equal(stop.disabled, false);
  click(stop);
  assert.deepEqual(calls, ['stop', 'stop']);
  // a stop that arrived removed the overlay: nothing changes afterwards
  api.clear();
  t.mock.timers.tick(1500);
  assert.equal(part('.mp-text').textContent, 'Stopping…');
});

test('overlay with the frame: the pill takes the pointer only while the mouse is over it, and stops listening once gone', () => {
  const layer = win.document.createElement('div');
  win.document.body.appendChild(layer);
  const listeners: any[] = [];
  G.window = {
    innerWidth: 1024,
    innerHeight: 768,
    addEventListener: (_t: string, f: any) => listeners.push(f),
    removeEventListener: (_t: string, f: any) => listeners.splice(listeners.indexOf(f), 1),
  };
  controlFrame({ layer, stop: () => true });
  const pill = layer.querySelector('.mp-pill');
  pill.getBoundingClientRect = () => ({ left: 400, right: 600, top: 700, bottom: 740 });
  const move = (x: number, y: number) => listeners[0]({ clientX: x, clientY: y });
  move(10, 10);
  assert.equal(pill.classList.contains('mp-live'), false);
  move(395, 745);
  assert.equal(pill.classList.contains('mp-live'), true);
  move(500, 600);
  assert.equal(pill.classList.contains('mp-live'), false);
  layer.remove();
  move(500, 720);
  assert.equal(listeners.length, 0);
});

test('overlay with the frame: avoid ignores a missing point; the idle fade after clear is harmless', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const layer = win.document.createElement('div');
  const f = controlFrame({ layer, stop: () => true });
  f.avoid(null);
  f.avoid(Number.NaN);
  G.window = { addEventListener: () => undefined };
  f.avoid(10);
  assert.equal(layer.querySelector('.mp-pill').classList.contains('mp-top'), true, 'a viewport with no size');
  G.window = { innerWidth: 1024, innerHeight: 768, addEventListener: () => undefined, removeEventListener: () => undefined };
  const api = cursorOverlay(1000, control());
  api.show({ x: 1, y: 1, label: 'x' });
  api.clear();
  t.mock.timers.tick(1000);
  // a stylesheet the page refuses: the styles go in a <style>
  delete G.__mopilotCursor;
  G.CSSStyleSheet = class {
    replaceSync() {
      throw new Error('blocked');
    }
  };
  const fallback = cursorOverlay(1000, control());
  fallback.show({ frame: true });
  assert.ok(shadows.at(-1).querySelector('style').textContent.includes('.mp-pill'));
});

/* ---------- the app: the Chrome host's cursor ---------- */

test('setupChromeRelay: the Chrome host draws the frame cursor, switched by the agent cursor flag, and its Stop stops the chat', () => {
  const appRelay = require('../electron/app/chromeRelay.cjs');
  const stop = mock.fn();
  const controller: any = { stopChat: stop };
  const flags = new Set(['shared.browser.agentCursor']);
  const r = appRelay.setupChromeRelay({
    registry: { register: () => () => undefined },
    grants: {},
    token: () => null,
    profileDir: () => '',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: (k: string) => flags.has(k) || k === 'shared.browser.chromeRelay',
    controller,
  });
  const cursor = r.tabs.o.cursor;
  assert.equal(cursor.frame, true);
  assert.equal(cursor.enabled(), true);
  flags.clear();
  assert.equal(cursor.enabled(), false);
  cursor.onStop({ chatId: 'c9' });
  assert.deepEqual(stop.mock.calls[0].arguments, ['c9']);
  // the controller's turn ends tell the Chrome host the agent's reply (its named tabs stay at let-go)
  controller.onFinished({ chatId: 'c9', text: 'Opened https://shop.test/cart for you.' });
  assert.equal(r.tabs.replies.get('c9'), 'Opened https://shop.test/cart for you.');
  r.stop();
  // without a controller, Stop does nothing
  const quiet = appRelay.setupChromeRelay({
    registry: { register: () => () => undefined },
    grants: {},
    token: () => null,
    profileDir: () => '',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: () => true,
  });
  quiet.tabs.o.cursor.onStop({ chatId: 'c9' });
  quiet.stop();
});
