// The agent cursor's arrival (#1511, as in the Codex app): the overlay's travel time by distance, a new overlay gliding
// in from the tab's last point, the click ring at arrival, no glide on a hidden page or with reduced motion; the main
// process waiting for the arrival (bounded, ended by a stop); and the browser host acting only after it.
import { test, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';
import { drive, setup, tabOf } from './support/browser-host-kit.ts';

const require = createRequire(import.meta.url);
const { AgentCursor, cursorOverlay, TRAVEL_MS_MAX } = require('../electron/capabilities/browser/agentCursor.cjs');
const { guarded } = require('../electron/capabilities/contract/actionGuard.cjs');

/* ------------------------------------------------------------------ */
/* the overlay (in the page)                                           */
/* ------------------------------------------------------------------ */

const win: any = new Window({ url: 'https://site.test/', width: 1000, height: 800 });
const G: any = globalThis;
const saved = { document: G.document, window: G.window, CSSStyleSheet: G.CSSStyleSheet };
const shadows: any[] = [];
const attach = win.HTMLElement.prototype.attachShadow;
win.HTMLElement.prototype.attachShadow = function (init: any) {
  const root = attach.call(this, init);
  shadows.push(root);
  return root;
};
after(() => {
  Object.assign(G, saved);
  delete G.__mopilotCursor;
  win.happyDOM.close();
});
afterEach(() => G.__mopilotCursor?.clear());
beforeEach(() => {
  delete G.__mopilotCursor;
  shadows.length = 0;
  win.document.documentElement.querySelectorAll('mopilot-agent-cursor').forEach((e: any) => e.remove());
  Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
  Object.assign(G, { document: win.document, window: { innerWidth: 1000, innerHeight: 800 }, CSSStyleSheet: win.CSSStyleSheet });
});
const part = (sel: string) => shadows.at(-1).querySelector(sel);
const ripples = () => shadows.at(-1).querySelectorAll('.ripple').length;

test('overlay: a short hop glides 175 ms, a longer move longer (at most 500 ms), the same point not at all', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const api = cursorOverlay(30_000);
  assert.deepEqual(api.show({ x: 100, y: 100, from: { x: 100, y: 100 }, label: '' }), { ms: 0, x: 100, y: 100 });
  assert.equal(part('.pointer').style.transitionDuration, '0ms, 200ms');
  assert.equal(api.show({ x: 196, y: 100, label: '' }).ms, 175, 'up to 196 px: the short glide');
  assert.equal(part('.pointer').style.transitionDuration, '175ms, 200ms');
  assert.equal(part('.label').style.transitionDuration, '175ms, 200ms', 'the label glides with it');
  assert.equal(api.show({ x: 196, y: 400, label: '' }).ms, Math.round(175 + 104 * 1.4), '300 px: 1.4 ms more per px');
  assert.equal(api.show({ x: 900, y: 400, label: '' }).ms, 500, 'capped');
  assert.equal(api.show({ x: 902, y: 401, label: '' }).ms, 500, 'under 4 px: no new glide, the running one still arrives');
});

test('overlay: a new overlay starts from the last point it is given, else a resting point, and glides from there', () => {
  let api = cursorOverlay(30_000);
  const r = api.show({ x: 580, y: 440, label: '' });
  assert.equal(r.ms, 0, 'from the resting point (58%, 55% of the viewport) to itself');
  api.clear();
  api = cursorOverlay(30_000);
  // a new page: from the tab's last point (150 px away), then to the target
  assert.equal(api.show({ x: 100, y: 100, from: { x: 100, y: 250 }, label: '' }).ms, 175);
  assert.equal(part('.pointer').style.transform, 'translate(97px, 98px)');
  api.clear();
  api = cursorOverlay(30_000);
  assert.equal(api.show({ x: 580, y: 440, from: { x: 'a' }, label: '' }).ms, 0, 'a bad last point: the resting point');
});

test('overlay: the click ring plays where the pointer lands, when it lands; a click during a glide waits for that glide', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const api = cursorOverlay(30_000);
  api.show({ x: 0, y: 0, from: { x: 0, y: 0 }, label: '' });
  assert.equal(api.show({ x: 150, y: 0, click: true, label: 'Clicking' }).ms, 175);
  assert.equal(ripples(), 0, 'not while it is on its way');
  t.mock.timers.tick(175);
  assert.equal(ripples(), 1);
  assert.equal(part('.ripple').style.left, '150px');
  // a hover starts a glide; the click on the same point comes 100 ms into it
  api.show({ x: 300, y: 0, label: '' });
  t.mock.timers.tick(100);
  assert.equal(api.show({ x: 300, y: 0, click: true, label: 'Clicking' }).ms, 75);
  assert.equal(ripples(), 1);
  t.mock.timers.tick(75);
  assert.equal(ripples(), 2);
  // the overlay went before the glide arrived: no ring
  api.show({ x: 0, y: 0, click: true, label: '' });
  api.clear();
  t.mock.timers.tick(500);
  assert.equal(G.__mopilotCursor.show({ x: 0, y: 0, from: { x: 0, y: 0 }, label: '' }).ms, 0);
  assert.equal(ripples(), 0);
});

test('overlay: a hidden page (no window, a hidden pane) or reduced motion moves at once and waits for nothing', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  Object.defineProperty(win.document, 'visibilityState', { value: 'hidden', configurable: true });
  let api = cursorOverlay(30_000);
  assert.equal(api.show({ x: 800, y: 700, from: { x: 0, y: 0 }, click: true, label: '' }).ms, 0);
  assert.equal(ripples(), 1, 'the ring at once');
  api.clear();
  Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
  G.window = { innerWidth: 1000, innerHeight: 800, matchMedia: (q: string) => ({ matches: q.includes('reduce') }) };
  api = cursorOverlay(30_000);
  assert.equal(api.show({ x: 800, y: 700, from: { x: 0, y: 0 }, label: '' }).ms, 0);
  G.window.matchMedia = () => ({ matches: false });
  assert.equal(api.show({ x: 0, y: 0, label: '' }).ms, 500);
});

/* ------------------------------------------------------------------ */
/* the main process: waiting for the arrival                           */
/* ------------------------------------------------------------------ */

/** A tab whose overlay answers `answer(args)` for each show. */
function fakeTab(answer: (args: any) => any) {
  let ctx = 0;
  const shows: any[] = [];
  return {
    shows,
    async send(method: string, params: any = {}) {
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: ++ctx };
      const m = /^globalThis\.__mopilotCursor\.show\((.*)\)$/.exec(params.expression ?? '');
      if (m) {
        const args = JSON.parse(m[1]);
        shows.push(args);
        return { result: { value: answer(args) } };
      }
      return { result: { value: true } };
    },
  };
}
const settled = (p: Promise<any>) => {
  const s = { done: false, value: undefined as any };
  p.then((v) => Object.assign(s, { done: true, value: v }));
  return s;
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

test('act: resolves once the pointer has arrived (its glide plus a frame), at most TRAVEL_MS_MAX', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cursor = new AgentCursor();
  const tab = fakeTab(() => ({ ms: 175, x: 10, y: 20 }));
  const s = settled(cursor.act(tab, { kind: 'click', x: 10, y: 20 }));
  await flush();
  t.mock.timers.tick(175);
  await flush();
  assert.equal(s.done, false, 'the frame after the glide');
  t.mock.timers.tick(16);
  await flush();
  assert.deepEqual(s, { done: true, value: true });
  const long = settled(
    new AgentCursor().act(
      fakeTab(() => ({ ms: 99_999 })),
      { kind: 'hover', x: 1, y: 1 },
    ),
  );
  await flush();
  t.mock.timers.tick(TRAVEL_MS_MAX + 16);
  await flush();
  assert.equal(long.done, true, 'bounded');
  // no glide, or an older overlay's plain answer: no wait
  assert.equal(
    await new AgentCursor().act(
      fakeTab(() => ({ ms: 0, x: 1, y: 1 })),
      { kind: 'click', x: 1, y: 1 },
    ),
    true,
  );
  assert.equal(
    await new AgentCursor().act(
      fakeTab(() => ({ ms: 'x' })),
      { kind: 'click', x: 1, y: 1 },
    ),
    true,
  );
  assert.equal(
    await new AgentCursor().act(
      fakeTab(() => true),
      { kind: 'click', x: 1, y: 1 },
    ),
    true,
  );
  assert.equal(
    await new AgentCursor().act(
      fakeTab(() => false),
      { kind: 'click', x: 1, y: 1 },
    ),
    false,
  );
});

test("act: a new page's overlay starts from the tab's last point; clear forgets it", async () => {
  const cursor = new AgentCursor();
  const tab = fakeTab((a) => ({ ms: 0, x: a.x ?? 7, y: a.y ?? 8 }));
  await cursor.act(tab, { kind: 'click', x: 10, y: 20 });
  await cursor.act(tab, { kind: 'type' });
  await cursor.act(
    fakeTab(() => ({ ms: 0 })),
    { kind: 'type' },
  );
  assert.deepEqual(
    tab.shows.map((a) => a.from),
    [undefined, { x: 10, y: 20 }],
  );
  await cursor.act(tab, { kind: 'hover', x: 1, y: 1 });
  assert.deepEqual(tab.shows.at(-1).from, { x: 7, y: 8 }, 'the point the overlay reported (a typed field)');
  await cursor.clear(tab);
  await cursor.act(tab, { kind: 'hover', x: 1, y: 1 });
  assert.equal(tab.shows.at(-1).from, undefined);
});

test('arrival: waits for the running act on that tab (none: at once); a stop ends the wait early', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const cursor = new AgentCursor();
  const tab = fakeTab(() => ({ ms: 300, x: 1, y: 1 }));
  assert.equal(await cursor.arrival(tab), undefined);
  void cursor.act(tab, { kind: 'hover', x: 1, y: 1 });
  const a = settled(cursor.arrival(tab));
  await flush();
  t.mock.timers.tick(200);
  await flush();
  assert.equal(a.done, false);
  t.mock.timers.tick(116);
  await flush();
  assert.equal(a.done, true);
  // off: nothing to wait for
  assert.equal(await new AgentCursor({ enabled: () => false }).act(tab, { kind: 'click' }), null);
  // a stopped call stops waiting at once
  const ac = new AbortController();
  const s = settled(guarded({ signal: ac.signal }, () => cursor.act(tab, { kind: 'hover', x: 1, y: 1 })));
  await flush();
  ac.abort();
  await flush();
  assert.equal(s.done, true);
});

/* ------------------------------------------------------------------ */
/* the browser host: input after the arrival                           */
/* ------------------------------------------------------------------ */

test('host input: the click is sent only after the cursor has arrived; a call stopped meanwhile sends nothing', async (t) => {
  const h = setup(t);
  const tab = tabOf(h);
  const mouse = () => tab.wc.debugger.sent('Input.dispatchMouseEvent').map((c: any) => c.params.type);
  let arrive: () => void = () => {};
  h.tabs.o.cursor = { act: () => new Promise<void>((r) => (arrive = r)) };
  const p = h.tabs.click(tab, { x: 1, y: 2 });
  await flush();
  assert.deepEqual(mouse(), [], 'nothing while the pointer is on its way');
  arrive();
  assert.equal(await drive(t, p), 'done');
  assert.deepEqual(mouse(), ['mouseMoved', 'mousePressed', 'mouseReleased']);
  // Stop (or Esc, the turn's end) while it glides: the action is refused and nothing reaches the page
  tab.wc.debugger.calls.length = 0;
  const ac = new AbortController();
  h.tabs.o.cursor = { act: async () => ac.abort() };
  await assert.rejects(
    guarded({ signal: ac.signal }, () => h.tabs.typeText(tab, 'x')),
    (e: any) => e.code === 'stopped' && /before the type in the browser/.test(e.message),
  );
  assert.equal(tab.wc.debugger.sent('Input.insertText').length, 0);
});

/* ------------------------------------------------------------------ */
/* only where the user sees the page                                   */
/* ------------------------------------------------------------------ */

const { seenByUser } = require('../electron/capabilities/browser/hostUtil.cjs');

test('seenByUser: a shown, unminimized window with the page in front; anything else is unseen', () => {
  const win = (o: any = {}) => ({ isDestroyed: () => !!o.gone, isVisible: () => o.visible ?? true, isMinimized: () => !!o.min });
  assert.equal(seenByUser(win(), 'front'), true);
  assert.equal(seenByUser(win(), 'back'), false, 'laid out behind the pane');
  assert.equal(seenByUser(win(), undefined), false);
  assert.equal(seenByUser(win({ visible: false }), 'front'), false, 'a hidden window');
  assert.equal(seenByUser(win({ min: true }), 'front'), false, 'minimized');
  assert.equal(seenByUser(win({ gone: true }), 'front'), false);
  assert.equal(seenByUser(null, 'front'), false, 'parked: no window');
});

test('act: a page nobody sees (or a failing check) is drawn still, and the action does not wait', async () => {
  const tab = fakeTab((a) => ({ ms: a.still ? 0 : 175, x: 1, y: 1 }));
  assert.equal(await new AgentCursor({ shown: () => false }).act(tab, { kind: 'click', x: 1, y: 1 }), true);
  assert.equal(
    await new AgentCursor({
      shown: () => {
        throw new Error('gone');
      },
    }).act(tab, { kind: 'click', x: 1, y: 1 }),
    true,
  );
  assert.deepEqual(
    tab.shows.map((a) => a.still),
    [true, true],
  );
  const shown = fakeTab(() => ({ ms: 0 }));
  await new AgentCursor({ shown: () => true }).act(shown, { kind: 'click', x: 1, y: 1 });
  assert.equal(shown.shows[0].still, undefined);
});

test('overlay: drawn still, it moves at once whatever the distance', () => {
  const api = cursorOverlay(30_000);
  assert.equal(api.show({ x: 900, y: 700, from: { x: 0, y: 0 }, still: true, label: '' }).ms, 0);
  assert.equal(part('.pointer').style.transitionDuration, '0ms, 200ms');
});

test('overlay: a point a running glide already heads to keeps that glide; the longest glide is the one main gives', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const api = cursorOverlay(30_000, null, undefined, 300);
  api.show({ x: 0, y: 0, from: { x: 0, y: 0 }, label: '' });
  assert.equal(api.show({ x: 600, y: 0, label: '' }).ms, 300, 'capped at the given 300 ms');
  t.mock.timers.tick(100);
  assert.equal(api.show({ x: 602, y: 0, click: true, label: '' }).ms, 200);
  assert.equal(part('.pointer').style.transitionDuration, '300ms, 200ms', 'the glide is not cut to 0 ms');
  assert.equal(part('.pointer').style.transform, 'translate(597px, -2px)');
  t.mock.timers.tick(200);
  // after it arrived, a small move goes at once
  api.show({ x: 603, y: 0, label: '' });
  assert.equal(part('.pointer').style.transform, 'translate(600px, -2px)');
});

/* ------------------------------------------------------------------ */
/* a planned approach (the Codex app's cursor: in from afar, click, go) */
/* ------------------------------------------------------------------ */

const PLAN = {
  path: [
    [0, -40, 150],
    [50, 60, 80],
    [100, 95, 52],
    [150, 100, 50],
  ],
  durationMs: 150,
  hoverMs: 150,
  hideAfterClickMs: 287,
};

/** Makes elements animate()-able (happy-dom has no Web Animations) and records each call. */
function recordAnimations() {
  const calls: { el: any; frames: any[]; opts: any; cancelled: boolean }[] = [];
  win.HTMLElement.prototype.animate = function (frames: any[], opts: any) {
    const rec = { el: this, frames, opts, cancelled: false };
    calls.push(rec);
    return { cancel: () => (rec.cancelled = true) };
  };
  return calls;
}
after(() => delete win.HTMLElement.prototype.animate);

test('overlay plan: the pointer comes in along the plan, clicks after the hover and fades 287 ms later', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = recordAnimations();
  const api = cursorOverlay(30_000);
  const r = api.show({ x: 100, y: 50, click: true, label: '', plan: PLAN });
  assert.deepEqual(r, { ms: 300, x: 100, y: 50 }, 'the action lands after the glide and the hover');
  assert.equal(part('.pointer').style.transform, 'translate(97px, 48px)', 'it rests on the target');
  assert.equal(part('.pointer').style.transitionDuration, '0ms, 200ms');
  const [pointer, label] = calls;
  assert.equal(pointer.el, part('.pointer'));
  assert.equal(label.el, part('.label'));
  assert.deepEqual(pointer.opts, { duration: 150, easing: 'linear', fill: 'backwards' });
  assert.deepEqual(
    pointer.frames.map((f: any) => [f.offset, f.transform]),
    [
      [0, 'translate(-3px, 148px)'],
      [1 / 3, 'translate(57px, 78px)'],
      [2 / 3, 'translate(92px, 50px)'],
      [1, 'translate(97px, 48px)'],
    ],
    'a start off the page is held on its edge',
  );
  assert.equal(label.frames.at(-1).transform, 'translate(118px, 68px)');
  // the press ring plays when the pointer has arrived and hovered, shorter than the old ring
  assert.equal(ripples(), 0);
  t.mock.timers.tick(300);
  assert.equal(ripples(), 1);
  assert.equal(shadows.at(-1).querySelector('.ripple').className, 'ripple press');
  // 287 ms after the click the pointer and its label fade out
  t.mock.timers.tick(286);
  assert.equal(part('.pointer').style.opacity, '');
  t.mock.timers.tick(1);
  assert.equal(part('.pointer').style.opacity, '0');
  assert.equal(part('.label').style.opacity, '0');
  t.mock.timers.tick(72);
  assert.equal(ripples(), 1);
  t.mock.timers.tick(1);
  assert.equal(ripples(), 0, 'the ring is gone 360 ms after it started');
});

test('overlay plan: after the fade the next action brings the pointer back in with its spring-in; a visible pointer glides as before', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = recordAnimations();
  const api = cursorOverlay(30_000);
  api.show({ x: 100, y: 50, click: true, label: '', plan: PLAN });
  t.mock.timers.tick(300 + 287);
  assert.equal(part('.pointer').style.opacity, '0');
  const svg = part('.pointer').firstChild;
  svg.style.animation = 'x';
  api.show({ x: 400, y: 300, click: true, label: '', plan: PLAN });
  assert.equal(part('.pointer').style.opacity, '', 'back');
  assert.equal(svg.style.animation, '', 'the spring-in plays again');
  assert.equal(calls.length, 4, 'a second glide for pointer and label');
  assert.equal(calls[0].cancelled && calls[1].cancelled, true, 'the first one is let go');
  // a click that is not followed by a fade (a hover) leaves the pointer: the next action glides from where it is, with no new approach
  t.mock.timers.tick(300);
  api.show({ x: 500, y: 300, label: '', plan: PLAN });
  assert.equal(calls.length, 4);
  assert.equal(part('.pointer').style.transitionDuration, '175ms, 200ms');
  assert.equal(api.show({ x: 700, y: 300, click: true, label: '', plan: PLAN }).ms, 181, 'a visible pointer ignores the plan');
});

test('overlay plan: without a plan, with reduced motion, an empty one or no Web Animations the pointer still gets there', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  let api = cursorOverlay(30_000);
  // happy-dom has no animate(): the final place is set and the click still follows the plan's timing
  assert.deepEqual(api.show({ x: 100, y: 50, click: true, label: '', plan: PLAN }), { ms: 300, x: 100, y: 50 });
  assert.equal(part('.pointer').style.transform, 'translate(97px, 48px)');
  api.clear();
  delete G.__mopilotCursor;
  const calls = recordAnimations();
  api = cursorOverlay(30_000);
  // reduced motion (a hidden page, still) ignores the plan
  assert.equal(api.show({ x: 100, y: 50, still: true, label: '', plan: PLAN }).ms, 0);
  api.clear();
  delete G.__mopilotCursor;
  api = cursorOverlay(30_000);
  // a one-point path or a zero duration is no plan: the pointer glides the old way from the resting point (500 ms, capped)
  assert.equal(api.show({ x: 100, y: 50, label: '', plan: { ...PLAN, path: [[0, 1, 1]] } }).ms, 500, 'a one-point path is no plan');
  api.clear();
  delete G.__mopilotCursor;
  api = cursorOverlay(30_000);
  assert.equal(api.show({ x: 100, y: 50, label: '', plan: { ...PLAN, durationMs: 0 } }).ms, 150, 'a plan with no duration still hovers');
  assert.equal(calls.length, 0, 'but draws no animation');
});

test('overlay plan: a page with no size yet (a detached frame) is not clamped', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = recordAnimations();
  Object.assign(G, { window: { innerWidth: 0, innerHeight: 0 } });
  const api = cursorOverlay(30_000);
  api.show({ x: 100, y: 50, label: '', plan: { ...PLAN, path: [[0, 5000, 4000], ...PLAN.path.slice(1)] } });
  assert.equal(calls[0].frames[0].transform, 'translate(4997px, 3998px)', 'no upper bound without a size');
});

test('overlay plan: clear() cancels the fade and starts the next overlay fresh', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  recordAnimations();
  let api = cursorOverlay(30_000);
  api.show({ x: 100, y: 50, click: true, label: '', plan: PLAN });
  api.clear();
  delete G.__mopilotCursor;
  api = cursorOverlay(30_000);
  api.show({ x: 100, y: 50, label: '' });
  t.mock.timers.tick(1000);
  assert.equal(part('.pointer').style.opacity, '', 'the old fade did not reach the new pointer');
});

test("overlay plan: a click inside the previous one's linger still fades, glides the old way and lets the running glide go", (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = recordAnimations();
  const api = cursorOverlay(30_000);
  api.show({ x: 100, y: 50, click: true, label: '', plan: PLAN });
  t.mock.timers.tick(100);
  const r = api.show({ x: 140, y: 60, click: true, label: '', plan: PLAN });
  assert.equal(r.ms, 175, 'the pointer is on the page: the short glide, no new approach');
  assert.equal(calls.length, 2, 'no second approach');
  assert.equal(calls[0].cancelled && calls[1].cancelled, true, 'the running glide is let go');
  assert.equal(shadows.at(-1).querySelectorAll('.ripple.press').length, 0);
  t.mock.timers.tick(175);
  assert.equal(shadows.at(-1).querySelector('.ripple').className, 'ripple press', "the planned click's short ring");
  t.mock.timers.tick(286);
  assert.equal(part('.pointer').style.opacity, '');
  t.mock.timers.tick(1);
  assert.equal(part('.pointer').style.opacity, '0', 'the second click fades too');
});

test('overlay plan: in the Chrome frame the idle-hidden pointer comes back with its approach', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const calls = recordAnimations();
  const control = { css: '', binding: 'b', lifeMs: 600_000, frame: () => ({ avoid() {}, leave() {}, status() {}, role() {} }) };
  const api = cursorOverlay(1000, control);
  api.show({ x: 100, y: 50, label: '', plan: PLAN });
  assert.equal(calls.length, 2);
  t.mock.timers.tick(1000);
  assert.equal(part('.pointer').hidden, true);
  api.show({ x: 200, y: 50, label: '', plan: PLAN });
  assert.equal(calls.length, 4, 'it comes in from afar again');
});
