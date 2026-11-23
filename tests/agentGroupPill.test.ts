// The chat's other tabs in the user's Chrome (0.3.3 PR 4b), as Claude in Chrome's "Claude is active in this tab group": the pill on a
// held tab the agent isn't working on now has no glow, says the agent is active in the group, and its Go to tab brings the agent's tab
// to the front (agentControlFrame.cjs role, the overlay's role, AgentCursor's front tab per chat).
import { test, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';

const require = createRequire(import.meta.url);
const { AgentCursor, cursorOverlay } = require('../electron/capabilities/browser/agentCursor.cjs');
const { controlFrame, FRAME_CSS, STOP_BINDING } = require('../electron/capabilities/browser/agentControlFrame.cjs');
const { recentIgnored } = require('../electron/ignored.cjs');

const win: any = new Window({ url: 'https://site.test/', width: 1024, height: 768 });
const G: any = globalThis;
const KEYS = ['document', 'window', 'CSSStyleSheet', 'requestAnimationFrame'];
const saved = Object.fromEntries(KEYS.map((k) => [k, G[k]]));
after(() => {
  Object.assign(G, saved);
  delete G.__mopilotCursor;
  win.happyDOM.close();
});
beforeEach(() => {
  delete G.__mopilotCursor;
  Object.assign(G, {
    document: win.document,
    window: { innerWidth: 1024, innerHeight: 768, addEventListener: () => undefined, removeEventListener: () => undefined },
    CSSStyleSheet: win.CSSStyleSheet,
    requestAnimationFrame: (cb: any) => setTimeout(cb, 0),
  });
});
const click = (el: any, trusted = true) => {
  const e = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'isTrusted', { value: trusted });
  el.dispatchEvent(e);
};

/* ---------- the pill ---------- */

test('pill: on another of the group tabs, no glow, the group words and Go to tab, which calls the binding on a real click', () => {
  const layer = win.document.createElement('div');
  const calls: string[] = [];
  const f = controlFrame({ layer, stop: (p: string) => calls.push(p) > 0 });
  const go = layer.querySelector('.mp-go');
  const words = () => layer.querySelector('.mp-text').textContent;
  assert.equal(go.hidden, true);
  assert.equal(go.tabIndex, -1);
  f.role('group');
  assert.equal(words(), 'MoPilot is active in this tab group');
  assert.equal(layer.querySelector('.mp-frame').hidden, true, 'no glow');
  assert.equal(go.hidden, false);
  click(go, false);
  assert.deepEqual(calls, [], 'a page script cannot press it');
  click(go);
  assert.deepEqual(calls, ['front']);
  // the chat waits: its words win, on every tab
  f.status('waiting');
  assert.equal(words(), 'Waiting for your OK');
  f.status('running');
  assert.equal(words(), 'MoPilot is active in this tab group');
  f.role('front');
  assert.equal(words(), 'MoPilot is working in this tab');
  assert.equal(layer.querySelector('.mp-frame').hidden, false);
  assert.equal(go.hidden, true);
  assert.match(FRAME_CSS, /\.mp-go\[hidden\], \.mp-frame\[hidden\] \{ display: none; \}/);
});

test('overlay: the role reaches the frame, from show, from role, and on a page mounted after it', () => {
  let layer: any = null;
  const control = {
    frame: (o: any) => {
      layer = o.layer;
      return controlFrame(o);
    },
    css: FRAME_CSS,
    binding: STOP_BINDING,
    lifeMs: 60_000,
  };
  const api = cursorOverlay(30_000, control);
  // before the frame is drawn: kept for it
  assert.equal(api.role('group'), true);
  api.show({ x: 5, y: 5, label: 'Reading' });
  assert.equal(layer.querySelector('.mp-text').textContent, 'MoPilot is active in this tab group');
  api.role('front');
  assert.equal(layer.querySelector('.mp-text').textContent, 'MoPilot is working in this tab');
  api.show({ frame: true, role: 'group' });
  assert.equal(layer.querySelector('.mp-go').hidden, false);
  api.show({ frame: true });
  assert.equal(layer.querySelector('.mp-go').hidden, true);
  api.clear();
  // the in-app browser's cursor has no frame
  delete G.__mopilotCursor;
  assert.equal(cursorOverlay(30_000, null).role('group'), true);
});

/* ---------- main: the chat's front tab ---------- */

function fakeTab(chatId = 'c1') {
  let ctx = 0;
  const calls: any[] = [];
  const dbg: any = new EventEmitter();
  Object.assign(dbg, { isAttached: () => true, sendCommand: async () => ({}) });
  const tab: any = {
    calls,
    chatId,
    wc: { isDestroyed: () => false, debugger: dbg },
    get backend() {
      return this.wc;
    },
    async send(method: string, params: any = {}) {
      calls.push([method, params]);
      if (tab.failFront && method === 'Page.bringToFront') throw new Error('tab gone');
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: ++ctx };
      if (method === 'Runtime.evaluate') return { result: { value: true } };
      return {};
    },
  };
  return { tab, dbg };
}
const exprs = (tab: any) =>
  tab.calls
    .filter((c: any) => c[0] === 'Runtime.evaluate' && c[1].expression.startsWith('globalThis.__mopilotCursor.'))
    .map((c: any) => c[1].expression.slice('globalThis.__mopilotCursor.'.length));
const fronts = (tab: any) => tab.calls.filter((c: any) => c[0] === 'Page.bringToFront').length;

test('AgentCursor: the tab the agent moves to works, the one it left shows the group pill; a page loaded there keeps its role', async () => {
  const cursor = new AgentCursor({ frame: true });
  const a = fakeTab().tab;
  const b = fakeTab().tab;
  const other = fakeTab('c2').tab;
  await cursor.hold(a);
  await cursor.hold(other);
  assert.deepEqual(exprs(a), ['show({"frame":true})'], 'another chat changes nothing here');
  await cursor.hold(b);
  assert.deepEqual(exprs(a), ['show({"frame":true})', 'role("group")']);
  assert.deepEqual(exprs(b), ['show({"frame":true})']);
  // back to a: it works again, b is the group's
  await cursor.hold(a);
  assert.equal(exprs(a).at(-1), 'role("front")');
  assert.equal(exprs(b).at(-1), 'role("group")');
  // the same tab again: nothing to change
  const n = exprs(a).length;
  await cursor.hold(a);
  assert.equal(exprs(a).length, n);
  // a new page on b starts as the group's, and waiting
  await cursor.status('c1', 'waiting');
  await cursor.mark(b);
  assert.equal(exprs(b).at(-1), 'show({"frame":true,"status":"waiting","role":"group"})');
  // an action leads too
  await cursor.act(b, { kind: 'click', x: 1, y: 1 });
  await new Promise((r) => setImmediate(r));
  assert.ok(exprs(b).includes('role("front")'));
  // a tab left after it was cleared hears nothing
  await cursor.clear(b);
  assert.equal(cursor.front.get('c1'), a, 'the front tab cleared: the one held before leads');
  await cursor.hold(a);
  assert.equal(exprs(b).at(-1).startsWith('clear'), true);
  // the turn's end forgets the chat's front tab
  await cursor.status('c1', 'done');
  assert.equal(cursor.front.has('c1'), false);
  // switched off, or without the frame: nothing
  assert.equal(await new AgentCursor({ frame: true, enabled: () => false }).hold(a), null);
  assert.equal(await new AgentCursor().hold(a), null);
});

test('AgentCursor: Go to tab brings the agent tab to the front; on that tab itself, or with none, nothing; a failure is noted', async () => {
  const cursor = new AgentCursor({ frame: true });
  const a = fakeTab();
  const b = fakeTab();
  await cursor.hold(a.tab);
  await cursor.hold(b.tab);
  a.dbg.emit('message', {}, 'Runtime.bindingCalled', { name: STOP_BINDING, payload: 'front' });
  await new Promise((r) => setImmediate(r));
  assert.equal(fronts(b.tab), 1);
  b.dbg.emit('message', {}, 'Runtime.bindingCalled', { name: STOP_BINDING, payload: 'front' });
  await new Promise((r) => setImmediate(r));
  assert.equal(fronts(b.tab), 1, 'already the front tab');
  b.tab.failFront = true;
  a.dbg.emit('message', {}, 'Runtime.bindingCalled', { name: STOP_BINDING, payload: 'front' });
  await new Promise((r) => setImmediate(r));
  assert.ok(recentIgnored().some((e: any) => /bring the agent tab to the front/.test(JSON.stringify(e))));
  cursor.front.delete('c1');
  a.dbg.emit('message', {}, 'Runtime.bindingCalled', { name: STOP_BINDING, payload: 'front' });
  await new Promise((r) => setImmediate(r));
  assert.equal(fronts(b.tab), 2);
});

test('AgentCursor: when the agent tab goes (closed, handed over, cleared), the chat tab it held last leads; with none left, none does', async () => {
  const cursor = new AgentCursor({ frame: true });
  const a = fakeTab();
  const b = fakeTab();
  const c = fakeTab();
  await cursor.hold(a.tab);
  await cursor.hold(b.tab);
  await cursor.hold(c.tab);
  assert.equal(cursor.front.get('c1'), c.tab);
  // the front tab closed: its debugger detaches, and b (held last before it) leads
  c.dbg.emit('detach', {}, 'target_closed');
  await new Promise((r) => setImmediate(r));
  assert.equal(cursor.front.get('c1'), b.tab);
  assert.equal(exprs(b.tab).at(-1), 'role("front")');
  // another chat's tab going changes nothing here
  const o = fakeTab('c2');
  await cursor.hold(o.tab);
  o.dbg.emit('detach', {}, 'target_closed');
  assert.equal(cursor.front.get('c1'), b.tab);
  assert.equal(cursor.front.has('c2'), false);
  // b handed to the user (cleared): a leads
  await cursor.clear(b.tab, 'handoff');
  await new Promise((r) => setImmediate(r));
  assert.equal(cursor.front.get('c1'), a.tab);
  await cursor.clear(a.tab);
  await new Promise((r) => setImmediate(r));
  assert.equal(cursor.front.has('c1'), false, 'none left');
  await cursor.clear(c.tab);
});
