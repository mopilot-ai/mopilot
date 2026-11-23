// The agent's marks on its tabs in the user's Chrome (0.3.3 PR 4), in a page: the favicon mark drawn in the cursor world
// (agentTabMark.cjs), the pill's "Waiting for your OK" with Review (agentControlFrame.cjs) and the overlay carrying the chat's turn and
// the turn end's deliverable/handoff mark. Main's side is in agentTabMarkCursor.test.ts.
import { test, after, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { Window } from 'happy-dom';

const require = createRequire(import.meta.url);
const { tabMark, finalMark, MARK_SOURCE } = require('../electron/capabilities/browser/agentTabMark.cjs');
const { cursorOverlay } = require('../electron/capabilities/browser/agentCursor.cjs');
const { controlFrame, FRAME_CSS, STOP_BINDING } = require('../electron/capabilities/browser/agentControlFrame.cjs');

const win: any = new Window({ url: 'https://site.test/page', width: 1024, height: 768 });
const G: any = globalThis;
const KEYS = [
  'document',
  'window',
  'location',
  'fetch',
  'FileReader',
  'MutationObserver',
  'CustomEvent',
  'CSSStyleSheet',
  'requestAnimationFrame',
];
const saved = Object.fromEntries(KEYS.map((k) => [k, G[k]]));
after(() => {
  Object.assign(G, saved);
  delete G.__mopilotMark;
  delete G.__mopilotCursor;
  delete G[STOP_BINDING];
  win.happyDOM.close();
});

let visibility = 'hidden';
Object.defineProperty(win.document, 'visibilityState', { get: () => visibility, configurable: true });
/** address -> what the page's fetch answers */
let served: Record<string, any> = {};
const fetched: string[] = [];

beforeEach(() => {
  delete G.__mopilotMark;
  delete G.__mopilotCursor;
  delete G[STOP_BINDING];
  visibility = 'hidden';
  served = {};
  fetched.length = 0;
  win.document.head.querySelectorAll('link').forEach((l: any) => l.remove());
  win.document.documentElement.querySelectorAll('mopilot-agent-cursor').forEach((e: any) => e.remove());
  Object.assign(G, {
    document: win.document,
    window: { innerWidth: 1024, innerHeight: 768, addEventListener: () => undefined, removeEventListener: () => undefined },
    location: win.location,
    FileReader: win.FileReader,
    MutationObserver: win.MutationObserver,
    CustomEvent: win.CustomEvent,
    CSSStyleSheet: win.CSSStyleSheet,
    requestAnimationFrame: (cb: any) => setTimeout(cb, 0),
    fetch: async (href: string) => {
      fetched.push(href);
      const r = served[href];
      if (r instanceof Error) throw r;
      if (!r) return { ok: false };
      return { ok: true, blob: async () => new win.Blob([r], { type: 'image/png' }) };
    },
  });
});

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};
const icon = (href: string, rel = 'icon') => {
  const l = win.document.createElement('link');
  l.rel = rel;
  l.setAttribute('href', href);
  win.document.head.appendChild(l);
  return l;
};
const svgOf = (l: any) => decodeURIComponent(String(l.getAttribute('href')).slice('data:image/svg+xml,'.length));

/* ---------- the favicon mark in a page ---------- */

test('mark: the tab icon dimmed under the pointer while working, a yellow dot while waiting, and the page icon back after', async () => {
  served['https://site.test/icon.png'] = 'PNG';
  const link = icon('/icon.png');
  const m = tabMark();
  assert.equal(tabMark(), m, 'one per page');
  assert.equal(m.set('active'), true);
  await settle();
  assert.equal(m.state, 'active');
  assert.match(svgOf(link), /<image href="data:image\/png;base64,UE5H" width="32" height="32" opacity="0.3"\/>/);
  assert.match(svgOf(link), /<path d="M3 2 L3 18[^"]*" transform="translate\(3 2\) scale\(1.3\)" fill="#2f6fed"/);
  assert.equal(link.getAttribute('data-mopilot-mark'), '1');
  m.set('waiting');
  await settle();
  assert.match(svgOf(link), /<image href="data:image\/png;base64,UE5H" width="32" height="32"\/>/);
  assert.match(svgOf(link), /<circle cx="24" cy="24" r="7" fill="#facc15"/);
  assert.deepEqual(fetched, ['https://site.test/icon.png'], 'the icon is read once');
  m.set(null);
  assert.equal(link.getAttribute('href'), '/icon.png');
  assert.equal(link.hasAttribute('data-mopilot-mark'), false);
  // a state it doesn't know clears it
  m.set('active');
  m.set('bogus');
  await settle();
  assert.equal(m.state, null);
  assert.equal(link.getAttribute('href'), '/icon.png', 'a draw for an older state paints nothing');
});

test('mark: a page with no icon link gets one, from /favicon.ico, removed after; an unreadable icon gives a plain tile', async () => {
  const m = tabMark();
  m.set('active');
  await settle();
  assert.deepEqual(fetched, ['https://site.test/favicon.ico']);
  const added = win.document.head.querySelector('link[data-mopilot-mark]');
  assert.equal(added.rel, 'icon');
  assert.match(svgOf(added), /<rect x="3" y="3" width="26" height="26" rx="7" fill="#9aa0a6" opacity="0.3"\/>/);
  m.set('waiting');
  await settle();
  assert.match(svgOf(win.document.head.querySelector('link[data-mopilot-mark]')), /fill="#9aa0a6"\/><circle/);
  m.set(null);
  assert.equal(win.document.head.querySelector('link'), null);
  // too large, a failed fetch, a reader error: the tile
  served['https://site.test/big.png'] = 'x'.repeat(64 * 1024 + 1);
  const big = icon('https://site.test/big.png');
  m.set('waiting');
  await settle();
  assert.match(svgOf(big), /<rect/);
  m.set(null);
  big.remove();
  served['https://site.test/down.png'] = new Error('offline');
  const down = icon('https://site.test/down.png');
  const warn = mock.method(console, 'warn', () => undefined);
  m.set('waiting');
  await settle();
  assert.match(String(warn.mock.calls[0].arguments[0]), /couldn't read this tab's icon/);
  warn.mock.restore();
  assert.match(svgOf(down), /<rect/);
  m.set(null);
  down.remove();
  served['https://site.test/odd.png'] = 'ODD';
  const odd = icon('https://site.test/odd.png');
  const Reader = G.FileReader;
  G.FileReader = class {
    onerror: any;
    onload: any;
    result: any = null;
    readAsDataURL() {
      setTimeout(() => this.onerror(), 0);
    }
  };
  m.set('waiting');
  await settle();
  assert.match(svgOf(odd), /<rect/);
  m.set(null);
  odd.remove();
  G.FileReader = class {
    onload: any;
    result: any = new ArrayBuffer(1);
    readAsDataURL() {
      setTimeout(() => this.onload(), 0);
    }
  };
  served['https://site.test/odd2.png'] = 'ODD';
  const odd2 = icon('https://site.test/odd2.png');
  m.set('waiting');
  await settle();
  assert.deepEqual(fetched.slice(-1), ['https://site.test/odd2.png']);
  assert.match(svgOf(odd2), /<rect/, 'a reader that gives no text');
  G.FileReader = Reader;
  m.set(null);
});

test('mark: a data: icon goes in as it is (a huge one gives the tile); a quote in it is escaped', async () => {
  const link = icon('data:image/png;base64,QQ"x');
  const m = tabMark();
  m.set('waiting');
  await settle();
  assert.deepEqual(fetched, []);
  assert.match(svgOf(link), /<image href="data:image\/png;base64,QQ%22x"/);
  m.set(null);
  link.setAttribute('href', `data:image/png;base64,${'A'.repeat(64 * 1024 * 2)}`);
  m.set('waiting');
  await settle();
  assert.match(svgOf(link), /<rect/);
  m.set(null);
});

test('mark: a turn-end mark stays until the tab is seen: it comes into view, or the user clicks, types or scrolls in it', async () => {
  served['https://site.test/i.png'] = 'I';
  const link = icon('/i.png');
  const m = tabMark();
  const fire = (type: string, trusted: boolean) => {
    const e = new win.Event(type, { bubbles: true });
    Object.defineProperty(e, 'isTrusted', { value: trusted });
    win.document.dispatchEvent(e);
  };
  // a held page reads visible (Chrome's input emulation): the mark goes on all the same
  visibility = 'visible';
  m.set('deliverable');
  await settle();
  assert.match(svgOf(link), /fill="#22c55e"/);
  // a page script's event, or the user acting while it is out of view, isn't a look
  fire('pointerdown', false);
  visibility = 'hidden';
  fire('keydown', true);
  fire('visibilitychange', false);
  assert.equal(m.state, 'deliverable');
  visibility = 'visible';
  fire('visibilitychange', false);
  assert.equal(m.state, null);
  assert.equal(link.getAttribute('href'), '/i.png');
  // already in view: the user's own click takes it off
  m.set('handoff');
  await settle();
  assert.match(svgOf(link), /fill="#facc15"/);
  fire('wheel', true);
  assert.equal(m.state, null);
  // a working mark is not cleared by a look
  m.set('active');
  await settle();
  fire('pointerdown', true);
  assert.equal(m.state, 'active');
  m.set(null);
});

test('mark: an icon the page changes or adds while marked is marked too, and the page icon is the one given back', async () => {
  served['https://site.test/a.png'] = 'A';
  served['https://site.test/b.png'] = 'B';
  const link = icon('/a.png');
  const m = tabMark();
  m.set('active');
  await settle();
  // the page swaps its icon (an unread count)
  link.setAttribute('href', '/b.png');
  await settle();
  assert.match(svgOf(link), /base64,Qg==/);
  const extra = icon('/a.png', 'shortcut icon');
  await settle();
  assert.match(svgOf(extra), /opacity="0.3"/);
  m.set(null);
  assert.equal(link.getAttribute('href'), '/b.png');
  assert.equal(extra.getAttribute('href'), '/a.png');
  // cleared: a page change draws nothing
  link.setAttribute('href', '/a.png');
  await settle();
  assert.equal(link.getAttribute('href'), '/a.png');
});

test("mark: only icon changes redraw it; a later turn's script takes over from an earlier one, which gives the icon back and stops", async () => {
  served['https://site.test/i.png'] = 'I';
  const link = icon('/i.png');
  const first = tabMark();
  first.set('deliverable');
  await settle();
  const marked = link.getAttribute('href');
  assert.match(svgOf(link), /#22c55e/);
  // styles, scripts and a link that isn't an icon don't redraw it
  const changes: any[] = [];
  const spy = new win.MutationObserver((r: any[]) => changes.push(...r));
  spy.observe(link, { attributes: true });
  const style = win.document.createElement('style');
  win.document.head.appendChild(style);
  const plain = win.document.createElement('link');
  win.document.head.appendChild(plain);
  plain.remove();
  style.remove();
  await settle();
  assert.equal(changes.length, 0);
  assert.equal(link.getAttribute('href'), marked);
  // the next turn's world: a new script in the same page
  delete G.__mopilotMark;
  const second = tabMark();
  assert.notEqual(second, first);
  assert.equal(first.state, null, 'the earlier one let go');
  assert.equal(link.getAttribute('href'), '/i.png');
  second.set('active');
  await settle();
  assert.match(svgOf(link), /opacity="0.3"/);
  changes.length = 0;
  await settle();
  assert.equal(changes.length, 0, 'nobody redraws over it');
  second.set(null);
  assert.equal(link.getAttribute('href'), '/i.png', 'the page icon, not the earlier mark');
  spy.disconnect();
});

test('mark: a document with no head marks in the root element', async () => {
  const head = win.document.head;
  head.remove();
  const m = tabMark();
  m.set('waiting');
  await settle();
  const added = win.document.documentElement.querySelector('link[data-mopilot-mark]');
  assert.ok(added);
  m.set(null);
  assert.equal(win.document.documentElement.querySelector('link[data-mopilot-mark]'), null);
  win.document.documentElement.prepend(head);
});

test('finalMark: the turn own mark, or a hand-off the user still holds; an earlier turn mark lapses', () => {
  assert.equal(finalMark({ mark: 'deliverable', markTurn: 2 }, 2), 'deliverable');
  assert.equal(finalMark({ mark: 'deliverable', markTurn: 1 }, 2), null);
  assert.equal(finalMark({ mark: 'handoff', markTurn: 0, signin: {} }, 2), 'handoff');
  assert.equal(finalMark({ mark: null, markTurn: 2 }, 2), null);
  assert.equal(finalMark({}, 0), null);
  assert.match(MARK_SOURCE, /^\(function tabMark\(\)/);
});

/* ---------- the pill and the overlay ---------- */

const click = (el: any, trusted = true) => {
  const e = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'isTrusted', { value: trusted });
  el.dispatchEvent(e);
};

test('pill: waiting for the OK it says so in yellow with Review, which calls the binding on a real click; a Stop on its way keeps its words', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const layer = win.document.createElement('div');
  win.document.body.appendChild(layer);
  const calls: string[] = [];
  const f = controlFrame({ layer, stop: (p: string) => calls.push(p) > 0 });
  const pill = layer.querySelector('.mp-pill');
  const review = layer.querySelector('.mp-review');
  assert.equal(review.hidden, true);
  assert.equal(review.tabIndex, -1);
  f.status('waiting');
  assert.equal(pill.classList.contains('mp-waiting'), true);
  assert.equal(layer.querySelector('.mp-text').textContent, 'Waiting for your OK');
  assert.equal(review.hidden, false);
  click(review, false);
  assert.deepEqual(calls, [], 'a page script cannot press it');
  click(review);
  assert.deepEqual(calls, ['review']);
  f.status('running');
  assert.equal(layer.querySelector('.mp-text').textContent, 'MoPilot is working in this tab');
  assert.equal(review.hidden, true);
  assert.equal(pill.classList.contains('mp-waiting'), false);
  // Stop pressed: the turn changing doesn't hide "Stopping…"
  click(layer.querySelector('.mp-stop'));
  f.status('waiting');
  assert.equal(layer.querySelector('.mp-text').textContent, 'Stopping…');
  // it didn't arrive: the notice stays over the turn's words until Stop is pressed again
  t.mock.timers.tick(1500);
  f.status('running');
  assert.equal(layer.querySelector('.mp-text').textContent, "Stop didn't reach MoPilot. Press Esc there.");
  click(layer.querySelector('.mp-stop'));
  t.mock.timers.tick(1500);
  click(layer.querySelector('.mp-stop'));
  assert.equal(layer.querySelector('.mp-text').textContent, 'Stopping…');
  assert.match(FRAME_CSS, /\.mp-waiting \.mp-dot \{ background: #facc15;/);
  layer.remove();
});

test('overlay: the frame and favicon follow the turn; a later page starts waiting; clear leaves the turn-end mark', async () => {
  served['https://site.test/i.png'] = 'I';
  const link = icon('/i.png');
  const control = { frame: controlFrame, mark: tabMark, css: FRAME_CSS, binding: STOP_BINDING, lifeMs: 60_000 };
  // not mounted yet: the turn is kept for the frame, the favicon untouched
  const api = cursorOverlay(30_000, control);
  assert.equal(api.status('waiting'), true);
  await settle();
  assert.equal(link.getAttribute('href'), '/i.png');
  api.show({ frame: true, status: 'waiting' });
  await settle();
  assert.match(svgOf(link), /fill="#facc15"/);
  assert.equal(G.__mopilotMark.state, 'waiting');
  api.status('running');
  await settle();
  assert.equal(G.__mopilotMark.state, 'active');
  // an action while marked doesn't draw again
  const before = link.getAttribute('href');
  api.show({ x: 5, y: 5, label: 'Clicking' });
  assert.equal(link.getAttribute('href'), before);
  // the frame shown again with no status: working
  api.status('waiting');
  api.show({ frame: true });
  assert.equal(G.__mopilotMark.state, 'active');
  api.clear('deliverable');
  await settle();
  assert.equal(G.__mopilotMark.state, 'deliverable');
  // the overlay's own timers clear with no mark
  api.show({ frame: true });
  api.clear();
  assert.equal(G.__mopilotMark.state, null);
  // a page mounted while the chat waits: the pill says so from the start
  delete G.__mopilotCursor;
  delete G.__mopilotMark;
  let layer: any = null;
  const next = cursorOverlay(30_000, {
    ...control,
    frame: (o: any) => {
      layer = o.layer;
      return controlFrame(o);
    },
  });
  next.status('waiting');
  next.show({ x: 5, y: 5, label: 'Reading' });
  assert.equal(layer.querySelector('.mp-text').textContent, 'Waiting for your OK');
  next.clear();
  // the in-app browser's cursor has no marks
  delete G.__mopilotCursor;
  delete G.__mopilotMark;
  const plain = cursorOverlay(30_000, null);
  assert.equal(plain.status('waiting'), true);
  plain.clear('deliverable');
  assert.equal(G.__mopilotMark, undefined);
});

test('overlay: on another of the group tabs the favicon has no pointer, and the yellow dot while the chat waits', async () => {
  served['https://site.test/i.png'] = 'I';
  const link = icon('/i.png');
  const api = cursorOverlay(30_000, { frame: controlFrame, mark: tabMark, css: FRAME_CSS, binding: STOP_BINDING, lifeMs: 60_000 });
  api.show({ frame: true, role: 'group' });
  await settle();
  assert.equal(G.__mopilotMark.state, null);
  assert.equal(link.getAttribute('href'), '/i.png');
  api.status('waiting');
  assert.equal(G.__mopilotMark.state, 'waiting');
  api.status('running');
  api.role('front');
  assert.equal(G.__mopilotMark.state, 'active');
  api.role('group');
  assert.equal(G.__mopilotMark.state, null);
  api.clear();
});
