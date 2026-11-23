// The side panel's empty-state tip cycle (electron/chrome-extension/src/panelTips.mjs, sidepanel.css, sidepanel.html): the lines, the 3 s interval, the 0.2 s leave and enter, the stops (a chat, typed text, a hidden composer or document), reduced motion, and the stylesheet (B7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tick } from './support/extension-background/fixture.ts';
import { el, panelPage } from './support/side-panel-page.ts';

const { PanelTips, TIPS, TIP_MS, SWAP_MS } = await import('../electron/chrome-extension/src/panelTips.mjs');
const { PLACEHOLDER } = await import('../electron/chrome-extension/src/panelConnection.mjs');
const { startSidePanel } = await import('../electron/chrome-extension/src/sidePanel.mjs');

const dir = new URL('../electron/chrome-extension/', import.meta.url);
const css = readFileSync(new URL('sidepanel.css', dir), 'utf8');
const html = readFileSync(new URL('sidepanel.html', dir), 'utf8');

/** A clock a test moves by hand: timers run in order of when they are due. */
function clock() {
  let now = 0;
  let id = 0;
  const waiting = new Map<number, { f: () => void; at: number }>();
  return {
    waiting,
    setTimeout: (f: () => void, ms: number) => (waiting.set(++id, { f, at: now + ms }), id),
    clearTimeout: (t: number) => void waiting.delete(t),
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...waiting].filter(([, w]) => w.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        waiting.delete(next[0]);
        now = next[1].at;
        next[1].f();
      }
      now = end;
    },
  };
}

function tips(o: { reduced?: boolean } = {}) {
  const els: Record<string, any> = {};
  const get = (id: string) => (els[id] ??= el());
  els.tip = el('span');
  els.tip.hidden = true;
  els.composer = el('form');
  const doc: any = {
    hidden: false,
    getElementById: get,
    listeners: {} as Record<string, Function>,
    addEventListener: (t: string, f: Function) => (doc.listeners[t] = f),
  };
  const timers = clock();
  const media: string[] = [];
  const g: any = {
    document: doc,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    matchMedia: (q: string) => (media.push(q), { matches: !!o.reduced }),
  };
  const t = new PanelTips(g);
  return { t, els, doc, timers, media, g, line: () => els.tip.textContent };
}

test('the lines are the classic greeting and tip, then our own, each true of the panel', () => {
  assert.deepEqual([...TIPS], ['Ask anything', 'Use / for commands', 'Type @ to mention a tab or chat']);
  assert.equal(TIPS[0], PLACEHOLDER.new);
  assert.equal(TIP_MS, 3000);
  assert.equal(SWAP_MS, 200);
});

test('a new chat shows the greeting over the box and hides the box’s own placeholder', () => {
  const k = tips();
  k.t.sync(true);
  assert.equal(k.els.tip.hidden, false);
  assert.equal(k.line(), 'Ask anything');
  assert.equal(k.els.text.placeholder, PLACEHOLDER.new);
  assert.equal(k.els.text.dataset.tips, '');
});

test('the line changes every 3 s: it leaves for 0.2 s, then the next one enters for 0.2 s', () => {
  const k = tips();
  k.t.sync(true);
  k.timers.advance(TIP_MS - 1);
  assert.equal(k.line(), TIPS[0]);
  assert.equal(k.els.tip.dataset.phase, undefined);
  k.timers.advance(1);
  // leaving: the old line is still there
  assert.equal(k.els.tip.dataset.phase, 'out');
  assert.equal(k.line(), TIPS[0]);
  k.timers.advance(SWAP_MS);
  assert.equal(k.els.tip.dataset.phase, 'in');
  assert.equal(k.line(), TIPS[1]);
  k.timers.advance(SWAP_MS);
  assert.equal(k.els.tip.dataset.phase, undefined);
  assert.equal(k.line(), TIPS[1]);
  // the interval runs from one change to the next, not from the end of the enter
  k.timers.advance(TIP_MS - SWAP_MS * 2);
  assert.equal(k.els.tip.dataset.phase, 'out');
  k.timers.advance(SWAP_MS);
  assert.equal(k.line(), TIPS[2]);
  // and it comes round to the greeting
  k.timers.advance(TIP_MS);
  k.timers.advance(SWAP_MS);
  assert.equal(k.line(), TIPS[0]);
});

test('repeated syncs and repeated opens keep one timer and do not restart the interval', () => {
  const k = tips();
  k.t.sync(true);
  k.timers.advance(2000);
  for (let i = 0; i < 5; i++) k.t.sync(true);
  assert.equal(k.timers.waiting.size, 1);
  k.timers.advance(1000);
  assert.equal(k.els.tip.dataset.phase, 'out');
});

test('a chat opening stops the cycle, clears its timers and brings the box’s own reply placeholder', () => {
  const k = tips();
  k.t.sync(true);
  k.timers.advance(TIP_MS + SWAP_MS);
  assert.equal(k.line(), TIPS[1]);
  k.t.sync(false);
  assert.equal(k.timers.waiting.size, 0);
  assert.equal(k.els.tip.hidden, true);
  assert.equal(k.els.text.dataset.tips, undefined);
  assert.equal(k.els.text.placeholder, PLACEHOLDER.reply);
  k.timers.advance(60_000);
  assert.equal(k.line(), TIPS[0]);
  assert.equal(k.els.tip.hidden, true);
});

test('a chat opening in the middle of a change leaves no motion and no timer', () => {
  const k = tips();
  k.t.sync(true);
  k.timers.advance(TIP_MS);
  assert.equal(k.els.tip.dataset.phase, 'out');
  k.t.sync(false);
  assert.equal(k.els.tip.dataset.phase, undefined);
  assert.equal(k.timers.waiting.size, 0);
});

test('typed text stops the cycle; emptying the box starts it again at the greeting', () => {
  const k = tips();
  k.t.sync(true);
  k.timers.advance(TIP_MS + SWAP_MS);
  assert.equal(k.line(), TIPS[1]);
  k.els.text.value = 'hello';
  k.t.sync(true);
  assert.equal(k.els.tip.hidden, true);
  assert.equal(k.timers.waiting.size, 0);
  // the box's own placeholder is not hidden for a box that has text (it draws none)
  assert.equal(k.els.text.dataset.tips, undefined);
  k.els.text.value = '';
  k.t.sync(true);
  assert.equal(k.els.tip.hidden, false);
  assert.equal(k.line(), TIPS[0]);
  assert.equal(k.timers.waiting.size, 1);
});

test('a hidden composer (the connection’s state, the first run) shows no tip and runs no timer', () => {
  const k = tips();
  k.els.composer.hidden = true;
  k.t.sync(true);
  assert.equal(k.els.tip.hidden, true);
  assert.equal(k.timers.waiting.size, 0);
  k.els.composer.hidden = false;
  k.t.sync(true);
  assert.equal(k.els.tip.hidden, false);
  assert.equal(k.timers.waiting.size, 1);
});

test('a hidden document pauses the cycle without hiding the line; shown again, it counts a full interval', () => {
  const k = tips();
  k.t.sync(true);
  k.timers.advance(TIP_MS);
  k.timers.advance(SWAP_MS);
  assert.equal(k.line(), TIPS[1]);
  k.doc.hidden = true;
  k.doc.listeners.visibilitychange();
  assert.equal(k.timers.waiting.size, 0);
  assert.equal(k.els.tip.hidden, false);
  k.timers.advance(60_000);
  assert.equal(k.line(), TIPS[1]);
  k.doc.hidden = false;
  k.doc.listeners.visibilitychange();
  k.timers.advance(TIP_MS - 1);
  assert.equal(k.line(), TIPS[1]);
  k.timers.advance(1 + SWAP_MS);
  assert.equal(k.line(), TIPS[2]);
});

test('a document hidden in the middle of a change finishes it at once', () => {
  const k = tips();
  k.t.sync(true);
  k.timers.advance(TIP_MS + SWAP_MS - 1);
  assert.equal(k.els.tip.dataset.phase, 'out');
  k.doc.hidden = true;
  k.doc.listeners.visibilitychange();
  assert.equal(k.els.tip.dataset.phase, undefined);
  assert.equal(k.line(), TIPS[1]);
});

test('under reduced motion the line changes at once, with no leave or enter', () => {
  const k = tips({ reduced: true });
  k.t.sync(true);
  k.timers.advance(TIP_MS);
  assert.equal(k.els.tip.dataset.phase, undefined);
  assert.equal(k.line(), TIPS[1]);
  assert.equal(k.timers.waiting.size, 1);
  assert.deepEqual([...new Set(k.media)], ['(prefers-reduced-motion: reduce)']);
  k.timers.advance(TIP_MS);
  assert.equal(k.line(), TIPS[2]);
});

test('a window with no matchMedia cycles with the motion', () => {
  const k = tips();
  delete k.g.matchMedia;
  k.t.sync(true);
  k.timers.advance(TIP_MS);
  assert.equal(k.els.tip.dataset.phase, 'out');
});

test('the page going away stops the cycle; a window with no listener hook starts all the same', () => {
  const k = tips();
  const hooks: Record<string, Function> = {};
  k.g.addEventListener = (type: string, f: Function) => (hooks[type] = f);
  const t = new PanelTips(k.g);
  t.sync(true);
  assert.equal(k.timers.waiting.size, 1);
  hooks.pagehide();
  assert.equal(k.timers.waiting.size, 0);
  // the cycle is only stopped, not retired: the next sync of a page that stayed starts it again
  t.sync(true);
  assert.equal(k.timers.waiting.size, 1);
});

test('a line that is already right is not written again by the syncs that follow', () => {
  const k = tips();
  k.t.sync(true);
  k.timers.advance(TIP_MS + SWAP_MS);
  assert.equal(k.line(), TIPS[1]);
  let writes = 0;
  let value = k.els.tip.textContent;
  Object.defineProperty(k.els.tip, 'textContent', {
    get: () => value,
    set: (v: string) => {
      writes++;
      value = v;
    },
  });
  k.els.text.value = 'typed';
  k.t.sync(true);
  k.t.sync(false);
  k.t.sync(false);
  assert.equal(writes, 1);
  assert.equal(value, TIPS[0]);
});

test('the tip goes in as text, never as markup', () => {
  const k = tips();
  k.t.sync(true);
  assert.equal(Object.getOwnPropertyDescriptor(k.els.tip, 'innerHTML'), undefined);
  assert.equal(k.els.tip.textContent, TIPS[0]);
  const source = readFileSync(new URL('src/panelTips.mjs', dir), 'utf8');
  assert.doesNotMatch(source, /innerHTML|insertAdjacentHTML/);
});

test('the panel: a new chat shows the tip line; typing, a chat and the empty box again follow it', async () => {
  const p = panelPage();
  await startSidePanel(p.g).ready;
  await tick();
  p.els.composer.hidden = false;
  assert.equal(p.els.tip.hidden, false);
  assert.equal(p.els.tip.textContent, TIPS[0]);
  assert.equal(p.els.text.placeholder, PLACEHOLDER.new);
  p.els.text.value = 'x';
  p.els.text.listeners.input();
  assert.equal(p.els.tip.hidden, true);
  p.els.text.value = '';
  p.els.text.listeners.input();
  assert.equal(p.els.tip.hidden, false);
  assert.ok(p.timers.timeouts.some((w: any) => w.ms === TIP_MS));
});

test('the page has the overlay beside the box, hidden from assistive tech and from the first paint', () => {
  assert.match(
    html,
    /<div class="text-wrap"><textarea id="text"[^>]*><\/textarea><span id="tip" class="empty-tip" aria-hidden="true" hidden><\/span><\/div>/,
  );
});

test('the stylesheet draws the overlay and its motion as the classic carousel', () => {
  const rule = (start: string) => css.split('\n').find((l) => l.startsWith(start)) ?? '';
  // the overlay shares the box's grid cell, so it starts where the box's own text starts
  assert.match(rule('.empty-tip {'), /align-self: start; padding: 1px 0;/);
  assert.match(rule('.text-wrap > *'), /grid-area: 1 \/ 1;/);
  assert.match(rule('.empty-tip {'), /pointer-events: none;/);
  assert.match(rule('.empty-tip {'), /color: var\(--muted\);/);
  // panel.css (shared with the options page) styles .tip with a margin; the overlay must not take that class
  assert.doesNotMatch(readFileSync(new URL('panel.css', dir), 'utf8'), /\.empty-tip/);
  assert.match(readFileSync(new URL('panel.css', dir), 'utf8'), /\.tip\b/);
  assert.match(rule('.text-wrap {'), /display: grid;/);
  assert.match(rule('#text[data-tips]::placeholder'), /color: transparent;/);
  // the motion is off under reduced motion, and is the classic's 0.2 s ease-in-out and +-6 px
  const at = css.indexOf('@media (prefers-reduced-motion: no-preference) {');
  const media = css.slice(at, css.indexOf('\n}\n', at));
  assert.match(media, /\.empty-tip\[data-phase="out"\] \{ animation: tip-out 0\.2s ease-in-out forwards; \}/);
  assert.match(media, /\.empty-tip\[data-phase="in"\] \{ animation: tip-in 0\.2s ease-in-out; \}/);
  assert.match(css, /@keyframes tip-out \{ to \{ opacity: 0; transform: translateY\(-6px\); \} \}/);
  assert.match(css, /@keyframes tip-in \{ from \{ opacity: 0; transform: translateY\(6px\); \} \}/);
  assert.match(rule('.empty-mark {'), /width: 56px; height: 56px; opacity: 0\.3;/);
});
