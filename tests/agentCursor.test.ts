// The agent cursor (electron/capabilities/browser/agentCursor.cjs): labels and overlay arguments for each
// action, the main-process side over a fake CDP tab (its own isolated world, retries, bounds, clear), and
// the overlay script itself against a happy-dom document (pointer, ripple, typing highlight, label,
// concealing for screenshots, idle removal). Typed text never reaches the overlay.
import { test, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
import { labelText } from '../shared/labelText.mjs';

const require = createRequire(import.meta.url);
const {
  AgentCursor,
  cursorOverlay,
  labelFor,
  overlayArgs,
  CURSOR_SOURCE,
  CURSOR_WORLD,
  CURSOR_IDLE_MS,
  TRAVEL_MS_MAX,
} = require('../electron/capabilities/browser/agentCursor.cjs');

/* ------------------------------------------------------------------ */
/* labels                                                              */
/* ------------------------------------------------------------------ */

test('labelFor: each action reads as what the agent is doing, with the element name when known', () => {
  assert.equal(labelFor({ kind: 'click', name: 'Submit' }), 'Clicking “Submit”');
  assert.equal(labelFor({ kind: 'click' }), 'Clicking');
  assert.equal(labelFor({ kind: 'click', button: 'right', name: 'Row' }), 'Right-clicking “Row”');
  assert.equal(labelFor({ kind: 'click', button: 'middle' }), 'Middle-clicking');
  assert.equal(labelFor({ kind: 'click', clickCount: 2 }), 'Double-clicking');
  assert.equal(labelFor({ kind: 'click', clickCount: 3 }), 'Triple-clicking');
  assert.equal(labelFor({ kind: 'hover', name: 'Menu' }), 'Pointing at “Menu”');
  assert.equal(labelFor({ kind: 'hover' }), 'Pointing at');
  assert.equal(labelFor({ kind: 'drag' }), 'Dragging');
  assert.equal(labelFor({ kind: 'scroll', direction: 'up' }), 'Scrolling up');
  assert.equal(labelFor({ kind: 'scroll' }), 'Scrolling down');
  assert.equal(labelFor({ kind: 'type' }), 'Typing');
  assert.equal(labelFor({ kind: 'key', keys: 'cmd+a Backspace' }), 'Pressing cmd+a Backspace');
  assert.equal(labelFor({ kind: 'key' }), 'Pressing ');
  assert.equal(labelFor({ kind: 'nope' }), '');
  // names are one short line
  assert.equal(labelFor({ kind: 'click', name: ` a\n\tb ${'x'.repeat(60)}` }), `Clicking “a b ${'x'.repeat(35)}…”`);
});

test('overlayArgs: coordinates, a ripple for clicks, the focused field for typing, the drag target', () => {
  assert.deepEqual(overlayArgs({ kind: 'click', x: 1, y: 2, name: 'OK' }), { label: 'Clicking “OK”', x: 1, y: 2, click: true });
  assert.deepEqual(overlayArgs({ kind: 'hover', x: 1 }), { label: 'Pointing at' }, 'no point without both coordinates');
  assert.deepEqual(overlayArgs({ kind: 'type' }), { label: 'Typing', focus: true });
  assert.deepEqual(overlayArgs({ kind: 'key', keys: 'Enter' }), { label: 'Pressing Enter', focus: true });
  assert.deepEqual(overlayArgs({ kind: 'drag', x: 0, y: 0, to: { x: 5, y: 6, extra: 1 } }), {
    label: 'Dragging',
    x: 0,
    y: 0,
    to: { x: 5, y: 6 },
  });
  assert.deepEqual(overlayArgs({ kind: 'drag', x: 0, y: 0, to: { x: 5 } }), { label: 'Dragging', x: 0, y: 0 });
  assert.deepEqual(overlayArgs({ kind: 'drag', x: 0, y: 0 }), { label: 'Dragging', x: 0, y: 0 });
  assert.equal(
    JSON.stringify(overlayArgs({ kind: 'type', text: 'secret' } as any)).includes('secret'),
    false,
    'typed text never goes to the page',
  );
});

/* ------------------------------------------------------------------ */
/* main process: the cursor world over CDP                             */
/* ------------------------------------------------------------------ */

const SHOW = 'globalThis.__mopilotCursor.';

/** A tab whose CDP answers come from `o`; `calls` records every command. */
function fakeTab(o: any = {}) {
  let ctx = 0;
  const calls: any[] = [];
  const tab: any = {
    calls,
    async send(method: string, params: any = {}) {
      calls.push([method, params]);
      if (o.send) {
        const r = o.send(method, params);
        if (r !== undefined) return r;
      }
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: ++ctx };
      if (method === 'Runtime.evaluate' && params.expression.startsWith(CURSOR_SOURCE)) return { result: { value: true } };
      if (method === 'Runtime.evaluate' && params.expression.startsWith(SHOW)) return { result: { value: true } };
      return {};
    },
  };
  return tab;
}
const evals = (tab: any) =>
  tab.calls
    .filter((c: any) => c[0] === 'Runtime.evaluate' && c[1].expression.startsWith(SHOW))
    .map((c: any) => [c[1].expression.slice(SHOW.length), c[1].contextId]);
const worlds = (tab: any) => tab.calls.filter((c: any) => c[0] === 'Page.createIsolatedWorld');

test('act: the overlay goes into a world of its own, made once per page and reused', async () => {
  const cursor = new AgentCursor();
  const tab = fakeTab();
  assert.equal(await cursor.act(tab, { kind: 'click', x: 10, y: 20, name: 'Go' }), true);
  assert.equal(await cursor.act(tab, { kind: 'type' }), true);
  assert.equal(worlds(tab).length, 1);
  assert.deepEqual(worlds(tab)[0][1], { frameId: 'main', worldName: CURSOR_WORLD, grantUniveralAccess: false });
  const inject = tab.calls.find((c: any) => c[0] === 'Runtime.evaluate' && c[1].expression.startsWith(CURSOR_SOURCE));
  assert.equal(inject[1].expression, `${CURSOR_SOURCE}(${CURSOR_IDLE_MS}, null, ${labelText.toString()}, ${TRAVEL_MS_MAX}), true`);
  const [click, typing] = evals(tab);
  // a click with a target point carries its approach (the Codex profile: 140 pt out, a spring of 0.162 s, 150 ms hover, 287 ms linger)
  const shown = JSON.parse(click[0].slice('show('.length, -1));
  const { plan, ...rest } = shown;
  assert.deepEqual(rest, { label: 'Clicking “Go”', x: 10, y: 20, click: true });
  assert.deepEqual([plan.hoverMs, plan.hideAfterClickMs], [150, 287]);
  assert.deepEqual(plan.path.at(-1), [plan.durationMs, 10, 20], 'the path ends on the target at its arrival');
  assert.ok(plan.durationMs > 100 && plan.durationMs < 400);
  assert.ok(plan.path.every(([t]: number[], i: number, all: number[][]) => i === 0 || t > all[i - 1][0]));
  assert.deepEqual(typing, ['show({"label":"Typing","focus":true})', 1]);
  assert.equal(new AgentCursor({ idleMs: 5 }).idleMs, 5);
});

test('act: off (or a failing switch) or no action draws nothing', async () => {
  const tab = fakeTab();
  assert.equal(await new AgentCursor({ enabled: () => false }).act(tab, { kind: 'click' }), null);
  assert.equal(
    await new AgentCursor({
      enabled: () => {
        throw new Error('x');
      },
    }).act(tab, { kind: 'click' }),
    null,
  );
  assert.equal(await new AgentCursor().act(tab, null), null);
  assert.equal(tab.calls.length, 0);
});

test('act: a world lost to a navigation (a failed or throwing evaluate) is made again once; then it gives up', async () => {
  const cursor = new AgentCursor();
  let fail = 0;
  let mode = 'throw';
  const tab = fakeTab({
    send: (method: string, params: any) => {
      if (method !== 'Runtime.evaluate' || !params.expression.startsWith(SHOW) || fail <= 0) return undefined;
      fail--;
      if (mode === 'throw') throw new Error('Cannot find context with specified id');
      return { exceptionDetails: { text: '__mopilotCursor is undefined' } };
    },
  });
  fail = 1;
  assert.equal(await cursor.act(tab, { kind: 'hover', x: 1, y: 1 }), true);
  assert.equal(worlds(tab).length, 2);
  mode = 'exception';
  fail = 1;
  assert.equal(await cursor.act(tab, { kind: 'hover', x: 1, y: 1 }), true);
  assert.equal(worlds(tab).length, 3);
  fail = 2;
  assert.equal(await cursor.act(tab, { kind: 'hover', x: 1, y: 1 }), null);
  // an evaluate that answers with nothing
  const empty = fakeTab({ send: (m: string, p: any) => (m === 'Runtime.evaluate' && p.expression.startsWith(SHOW) ? {} : undefined) });
  assert.equal(await cursor.act(empty, { kind: 'drag' }), null);
});

test('act: an overlay that fails to inject, a page that hangs or a CDP error never fails the action', async () => {
  const cursor = new AgentCursor({ callMs: 20 });
  const broken = fakeTab({
    send: (m: string, p: any) =>
      m === 'Runtime.evaluate' && p.expression.startsWith(CURSOR_SOURCE) ? { exceptionDetails: { text: 'CSP' } } : undefined,
  });
  assert.equal(await cursor.act(broken, { kind: 'click' }), null);
  assert.equal(evals(broken).length, 0, 'nothing is shown');
  assert.equal(await cursor.act(broken, { kind: 'click' }), null);
  assert.equal(worlds(broken).length, 2, 'not remembered: tried again next time');
  const hung = fakeTab({ send: () => new Promise(() => {}) });
  assert.equal(await cursor.act(hung, { kind: 'click' }), null);
  const failing = fakeTab({ send: (m: string) => (m === 'Page.getFrameTree' ? Promise.reject(new Error('Target closed')) : undefined) });
  assert.equal(await cursor.act(failing, { kind: 'click' }), null);
});

test('conceal and reveal: only where the overlay is drawn (no world is made for a screenshot)', async () => {
  const cursor = new AgentCursor();
  const tab = fakeTab();
  assert.equal(await cursor.conceal(tab), null);
  assert.equal(await cursor.reveal(tab), null);
  assert.equal(tab.calls.length, 0);
  await cursor.act(tab, { kind: 'click', x: 1, y: 1 });
  assert.equal(await cursor.conceal(tab), true);
  assert.equal(await cursor.reveal(tab), true);
  assert.deepEqual(
    evals(tab)
      .slice(1)
      .map((e: any) => e[0]),
    ['conceal(true)', 'conceal(false)'],
  );
  const conceal = tab.calls.filter((c: any) => c[0] === 'Runtime.evaluate' && c[1].expression.endsWith('conceal(true)'))[0][1];
  assert.equal(conceal.awaitPromise, true);
});

test('clear: removes the overlay now and resolves once the page did; nothing drawn, a gone page or a page that hangs resolves false', async () => {
  const cursor = new AgentCursor({ callMs: 30 });
  const tab = fakeTab();
  assert.equal(await cursor.clear(tab), false);
  await cursor.act(tab, { kind: 'click', x: 1, y: 1 });
  assert.equal(await cursor.clear(tab), true);
  assert.deepEqual(evals(tab).at(-1), ['clear()', 1]);
  assert.equal(await cursor.clear(tab), false, 'forgotten: the next action makes a new world');
  // a page that answers with an exception, throws, or never answers: false, and the world is forgotten
  let mode = 'exception';
  const failing = fakeTab({
    send: (m: string, p: any) => {
      if (m !== 'Runtime.evaluate' || p.expression !== 'globalThis.__mopilotCursor.clear()') return undefined;
      if (mode === 'exception') return { exceptionDetails: { text: 'gone' } };
      if (mode === 'throw') throw new Error('Target closed');
      return new Promise(() => {});
    },
  });
  for (const m of ['exception', 'throw', 'hang']) {
    mode = m;
    await cursor.act(failing, { kind: 'click', x: 1, y: 1 });
    assert.equal(await cursor.clear(failing), false, m);
    assert.equal(cursor.worlds.has(failing), false, m);
  }
});

/* ------------------------------------------------------------------ */
/* the overlay in a page                                               */
/* ------------------------------------------------------------------ */

const win: any = new Window({ url: 'https://site.test/', width: 1024, height: 768 });
const G: any = globalThis;
const saved = { document: G.document, window: G.window, CSSStyleSheet: G.CSSStyleSheet, requestAnimationFrame: G.requestAnimationFrame };
after(() => {
  Object.assign(G, saved);
  delete G.__mopilotCursor;
  win.happyDOM.close();
});
/** Every shadow root attached (the overlay's is closed, so it is caught here). */
const shadows: any[] = [];
const attach = win.HTMLElement.prototype.attachShadow;
win.HTMLElement.prototype.attachShadow = function (init: any) {
  const root = attach.call(this, init);
  shadows.push(root);
  return root;
};
let frames: ((t: number) => void)[] = [];

afterEach(() => G.__mopilotCursor?.clear());

beforeEach(() => {
  delete G.__mopilotCursor;
  shadows.length = 0;
  frames = [];
  win.document.documentElement.querySelectorAll('mopilot-agent-cursor').forEach((e: any) => e.remove());
  win.document.body.innerHTML = '';
  Object.assign(G, {
    document: win.document,
    window: { innerWidth: 1024, innerHeight: 768 },
    CSSStyleSheet: win.CSSStyleSheet,
    requestAnimationFrame: (cb: any) => frames.push(cb),
  });
});

const box = (el: any, left: number, top: number, width = 100, height = 20) => {
  el.getBoundingClientRect = () => ({ left, top, width, height, right: left + width, bottom: top + height });
  return el;
};
/** A part of the newest overlay (pages may attach shadow roots of their own). */
const part = (sel: string) =>
  shadows
    .filter((r) => r.querySelector('.layer'))
    .at(-1)
    .querySelector(sel);

test('overlay: one aria-hidden host with a closed shadow root; a click moves the pointer, ripples and labels', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = cursorOverlay(30_000);
  assert.equal(cursorOverlay(30_000), api, 'installed once per world');
  assert.equal(G.__mopilotCursor, api);
  // from where it already is: no glide, so the ripple plays at once
  assert.deepEqual(api.show({ x: 100, y: 50, from: { x: 100, y: 50 }, click: true, label: 'Clicking “Go”' }), { ms: 0, x: 100, y: 50 });
  const host = win.document.documentElement.querySelector('mopilot-agent-cursor');
  assert.equal(host.getAttribute('aria-hidden'), 'true');
  assert.match(host.style.cssText, /pointer-events: none/);
  assert.equal(win.document.body.contains(host), false, 'outside the body the page text is read from');
  assert.equal(shadows.length, 1);
  assert.equal(shadows[0].adoptedStyleSheets.length, 1);
  assert.equal(part('.pointer').style.transform, 'translate(97px, 48px)');
  assert.equal(part('.label').style.transform, 'translate(118px, 68px)');
  assert.equal(part('.label').textContent, 'Clicking “Go”');
  assert.equal(part('.label').hidden, false);
  assert.equal(part('.focus').hidden, true);
  assert.ok(part('.pointer svg path'));
  assert.equal(shadows[0].querySelectorAll('.ripple').length, 1);
  t.mock.timers.tick(700);
  assert.equal(shadows[0].querySelectorAll('.ripple').length, 0, 'the ripple goes');
  // the next action without coordinates stays where the pointer is; no label hides it
  api.show({ label: '' });
  assert.equal(part('.pointer').style.transform, 'translate(97px, 48px)');
  assert.equal(part('.label').hidden, true);
  assert.equal(shadows.length, 1, 'the same overlay');
});

test('overlay: near the right edge the label goes to the left of the pointer; no width reads as 0', () => {
  const api = cursorOverlay(30_000);
  api.show({ x: 1000, y: 10, label: 'Clicking' });
  assert.equal(part('.label').style.transform, 'translate(calc(990px - 100%), 28px)');
  G.window = {};
  api.show({ label: 'x' });
  assert.equal(part('.pointer').style.transform, 'translate(997px, 8px)', 'the last point');
  api.clear();
  api.show({ label: 'Scrolling down' });
  assert.equal(part('.pointer').style.transform, 'translate(-3px, -2px)', 'the center of a viewport with no size');
});

test('overlay: a field with several labels that repeat a word is named once', () => {
  const api = cursorOverlay(30_000);
  const doc = win.document;
  doc.body.innerHTML =
    '<label id="h" for="pw"><span>Password</span><span>Password</span></label><label><span>Password</span><input id="pw" type="password"></label>';
  // happy-dom has no layout: give the label the line break a browser's innerText has between its blocks
  Object.defineProperty(doc.getElementById('h'), 'innerText', { value: 'Password\nPassword' });
  box(doc.getElementById('pw'), 0, 0, 100, 20).focus();
  api.show({ focus: true, label: 'Typing' });
  assert.equal(part('.label').textContent, 'Typing in “Password”');
  // a hidden label (no rendered text) still names its field by its text
  doc.body.innerHTML = '<label id="hid" for="q">Search</label><input id="q">';
  Object.defineProperty(doc.getElementById('hid'), 'innerText', { value: '' });
  box(doc.getElementById('q'), 0, 0, 100, 20).focus();
  api.show({ focus: true, label: 'Typing' });
  assert.equal(part('.label').textContent, 'Typing in “Search”');
});

test('overlay: typing highlights the focused field and names it, never its value; through open shadow roots', () => {
  const api = cursorOverlay(30_000);
  const doc = win.document;
  doc.body.innerHTML =
    '<label for="e">Email   address</label><input id="e" value="secret@x.test"><input id="p" placeholder="Search"><div id="d" tabindex="0"></div><input id="n"><textarea id="l" aria-label="' +
    'n'.repeat(60) +
    '"></textarea>';
  const email = box(doc.getElementById('e'), 10, 100, 200, 30);
  email.focus();
  api.show({ x: 15, y: 110, focus: true, label: 'Typing' });
  assert.equal(part('.label').textContent, 'Typing in “Email address”');
  assert.equal(part('.focus').hidden, false);
  assert.deepEqual(
    [part('.focus').style.left, part('.focus').style.top, part('.focus').style.width, part('.focus').style.height],
    ['8px', '98px', '204px', '34px'],
  );
  assert.equal(shadows[0].textContent.includes('secret'), false);
  // no point given: the pointer goes to the field
  box(doc.getElementById('p'), 0, 0, 100, 20).focus();
  api.show({ focus: true, label: 'Typing' });
  assert.equal(part('.label').textContent, 'Typing in “Search”');
  assert.equal(part('.pointer').style.transform, 'translate(9px, 8px)');
  box(doc.getElementById('n'), 0, 0, 2, 20).focus();
  api.show({ focus: true, label: 'Pressing Enter' });
  assert.equal(part('.label').textContent, 'Pressing Enter', 'a field without a name');
  assert.equal(part('.pointer').style.transform, 'translate(-5px, 8px)');
  box(doc.getElementById('l'), 0, 0).focus();
  api.show({ x: 1, y: 1, focus: true, label: 'Typing' });
  assert.equal(part('.label').textContent, `Typing in “${'n'.repeat(39)}…”`);
  const d = box(doc.getElementById('d'), 0, 0);
  d.setAttribute('title', 'Editor');
  d.focus();
  api.show({ x: 1, y: 1, focus: true, label: 'Typing' });
  assert.equal(part('.label').textContent, 'Typing in “Editor”', 'an element without labels');
  // a field inside a component's open shadow root
  doc.body.innerHTML = '<x-field></x-field>';
  const inner = doc.querySelector('x-field').attachShadow({ mode: 'open' });
  inner.innerHTML = '<input name="q">';
  box(inner.querySelector('input'), 0, 0).focus();
  api.show({ x: 1, y: 1, focus: true, label: 'Typing' });
  assert.equal(part('.label').textContent, 'Typing in “q”');
  // nothing focused: no highlight, the pointer stays put
  (doc.activeElement as any)?.blur?.();
  inner.querySelector('input').blur();
  doc.body.innerHTML = '';
  api.show({ focus: true, label: 'Typing' });
  assert.equal(part('.focus').hidden, true);
  assert.equal(part('.label').textContent, 'Typing');
  // a focused component whose shadow root has no focus of its own is the field; the root or nothing is no field
  doc.body.innerHTML = '<x-box tabindex="0" aria-label="Canvas"></x-box>';
  const xbox = box(doc.querySelector('x-box'), 0, 0);
  xbox.attachShadow({ mode: 'open' });
  xbox.focus();
  api.show({ x: 1, y: 1, focus: true, label: 'Typing' });
  assert.equal(part('.label').textContent, 'Typing in “Canvas”');
  for (const active of [null, doc.documentElement]) {
    Object.defineProperty(doc, 'activeElement', { configurable: true, get: () => active });
    api.show({ x: 1, y: 1, focus: true, label: 'Typing' });
    assert.equal(part('.focus').hidden, true);
    delete (doc as any).activeElement;
  }
});

test('overlay: a drag glides to its target; a target after the overlay went is dropped', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = cursorOverlay(30_000);
  api.show({ x: 0, y: 0, from: { x: 0, y: 0 }, to: { x: 50, y: 60 }, label: 'Dragging' });
  assert.equal(part('.pointer').style.transform, 'translate(-3px, -2px)');
  t.mock.timers.tick(280);
  assert.equal(part('.pointer').style.transform, 'translate(47px, 58px)');
  api.show({ x: 0, y: 0, to: { x: 5, y: 5 }, label: 'Dragging' });
  api.clear();
  t.mock.timers.tick(280);
  api.show({ x: 0, y: 0, to: { x: 5 } as any, label: 'Dragging' });
  t.mock.timers.tick(280);
  assert.equal(part('.pointer').style.transform, 'translate(-3px, -2px)', 'an incomplete target is ignored');
});

test('overlay: concealed for a screenshot until the next frame (or 100 ms); shown again after', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = cursorOverlay(30_000);
  assert.equal(api.conceal(true), false, 'nothing drawn');
  api.show({ x: 1, y: 1, label: 'Clicking' });
  const p = api.conceal(true);
  assert.equal(part('.layer').classList.contains('concealed'), true);
  frames.shift()!(0);
  frames.shift()!(0);
  assert.equal(await p, true);
  const q = api.conceal(false);
  assert.equal(part('.layer').classList.contains('concealed'), false);
  t.mock.timers.tick(100);
  assert.equal(await q, true, 'a page that draws no frame (hidden) still answers');
  api.conceal(true);
  api.show({ x: 1, y: 1, label: 'Clicking' });
  assert.equal(part('.layer').classList.contains('concealed'), false, 'the next action shows it');
});

test('overlay: removed after the idle time, by clear, and mounted again if the page removed it', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const api = cursorOverlay(1000);
  const hosts = () => win.document.documentElement.querySelectorAll('mopilot-agent-cursor').length;
  api.show({ x: 1, y: 1, label: 'a' });
  t.mock.timers.tick(900);
  api.show({ x: 1, y: 1, label: 'b' });
  t.mock.timers.tick(900);
  assert.equal(hosts(), 1, 'each action restarts the idle time');
  t.mock.timers.tick(100);
  assert.equal(hosts(), 0);
  assert.equal(api.clear(), true, 'clearing twice is fine');
  api.show({ x: 1, y: 1, label: 'c' });
  win.document.documentElement.querySelector('mopilot-agent-cursor').remove();
  api.show({ x: 1, y: 1, label: 'd' });
  assert.equal(hosts(), 1);
  assert.equal(shadows.length, 3, 'a new overlay each time');
  api.clear();
  assert.equal(hosts(), 0);
});

test('overlay: without constructed stylesheets the styles go in a <style>; no document element draws nothing', () => {
  delete G.CSSStyleSheet;
  const api = cursorOverlay(30_000);
  api.show({ x: 1, y: 1, label: 'a' });
  assert.ok(shadows[0].querySelector('style').textContent.includes('.pointer'));
  api.clear();
  G.document = { documentElement: null };
  assert.equal(api.show({ x: 1, y: 1, label: 'a' }), false);
});

test("overlay motion is the Codex app's cursor: a two-layer glow, a spring-in from scale .4 and a 5px blur, a spring glide", () => {
  const src = CURSOR_SOURCE;
  assert.match(
    src,
    /filter: drop-shadow\(0 0 6px color-mix\(in srgb, #2f6fed 90%, transparent\)\) drop-shadow\(0 0 15px color-mix\(in srgb, #2f6fed 48%, transparent\)\)/,
  );
  assert.match(src, /@keyframes mp-appear \{ from \{ transform: scale\(\.4\); filter: blur\(5px\); opacity: 0; \} \}/);
  // SwiftUI-style springs (stiffness (2π/response)², damping 2ζ√stiffness), sampled from rest
  const spring = (response: number, z: number) => {
    const w0 = (2 * Math.PI) / response;
    const wd = w0 * Math.sqrt(1 - z * z);
    return (t: number) => 1 - Math.exp(-z * w0 * t) * (Math.cos(wd * t) + ((z * w0) / wd) * Math.sin(wd * t));
  };
  const check = (re: RegExp, x: (t: number) => number, settleMs: number) => {
    const m = re.exec(src);
    assert.ok(m);
    assert.equal(Number(m[1]), settleMs);
    const pts = m[2].split(',').map(Number);
    assert.equal(pts.at(-1), 1);
    pts.slice(0, -1).forEach((p, i) => assert.ok(Math.abs(p - x((settleMs / 1000) * (i / (pts.length - 1)))) < 0.001, `sample ${i}`));
  };
  check(/\.pointer svg \{[^}]*animation: mp-appear (\d+)ms linear\(([^)]*)\) both;/, spring(0.42, 0.86), 585);
  check(/const GLIDE =\s+'transform (\d+)ms linear\(([^)]*)\), opacity 200ms';/, spring(0.19, 0.9), 175);
  // the pointer and its label glide on the same curve
  assert.match(src, /\.pointer \{[^}]*transition: \$\{GLIDE\};/);
  assert.match(src, /\.label \{[^}]*transition: \$\{GLIDE\};/);
  assert.match(src, /\.ripple, \.focus, \.pointer svg \{ animation: none; \}/, 'held still with reduced motion');
});
