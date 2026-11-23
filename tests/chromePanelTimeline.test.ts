// The side panel's work timeline (electron/chrome-extension/src/panelThread.mjs, panelStep.mjs, panelMotion.mjs, sidepanel.css): a step's state, the last three steps of the run a turn is still adding to, the enter and fade marks, and the stylesheet's motion (#3046, B3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { el } from './support/side-panel-page.ts';

const { PanelThread } = await import('../electron/chrome-extension/src/panelThread.mjs');
const { stepElement } = await import('../electron/chrome-extension/src/panelStep.mjs');
const { WINDOW, MOTION_MS, mark, windowed } = await import('../electron/chrome-extension/src/panelMotion.mjs');

/** timers a test runs by hand: what is waiting, and ms of each */
function clock() {
  const waiting: { f: () => void; ms: number }[] = [];
  return {
    waiting,
    setTimeout: (f: () => void, ms: number) => (waiting.push({ f, ms }), waiting.length),
    clearTimeout: () => undefined,
    /** the timers due now go */
    run: () => waiting.splice(0).forEach((w) => w.f()),
  };
}

function thread() {
  const timers = clock();
  const els: Record<string, any> = {};
  const document = {
    getElementById: (id: string) => (els[id] ??= el()),
    createElement: (tag: string) => el(tag),
    createTextNode: (text: string) => ({ textContent: text }),
  };
  const t = new PanelThread({
    document,
    request: () => new Promise(() => undefined),
    onError: () => undefined,
    onOpen: () => undefined,
    timers,
  });
  return { t, els, timers };
}
const step = (text: string, extra: object = {}) => ({ role: 'step', id: `id-${text}`, text, ...extra });
const reply = (text: string) => ({ role: 'assistant', text });
const five = ['One', 'Two', 'Three', 'Four', 'Five'].map((t) => step(t));

test('a step carries its state when it is running or failed, and no other value passes', () => {
  const doc = { createElement: (tag: string) => el(tag) };
  const state = (row: object) => stepElement(doc, { text: 'x', ...row }, 'k', new Set()).dataset.state;
  assert.equal(state({ state: 'running' }), 'running');
  assert.equal(state({ state: 'failed' }), 'failed');
  // done is no state; anything else a read carried is not trusted
  assert.equal(state({}), undefined);
  assert.equal(state({ state: 'done' }), undefined);
  assert.equal(state({ state: '"><b>' }), undefined);
});

test('the chat says what its turn is doing, for the stylesheet', () => {
  const { t, els } = thread();
  t.turn('running');
  assert.equal(els.chat.dataset.turn, 'running');
  t.turn('waiting');
  assert.equal(els.chat.dataset.turn, 'waiting');
  t.turn('idle');
  assert.equal(els.chat.dataset.turn, 'idle');
});

test('only the run at the end of the thread is windowed: its last three steps are the ones not older', () => {
  const { t, els } = thread();
  t.render([step('Early'), step('Earlier'), reply('Halfway'), ...five], false);
  const [first, , last] = els.rows.children;
  // a run a reply follows is not the one the turn adds to
  assert.equal('last' in first.dataset, false);
  assert.deepEqual(
    first.children.slice(1).map((c: any) => 'older' in c.dataset),
    [false, false],
  );
  assert.equal('last' in last.dataset, true);
  assert.deepEqual(
    last.children.slice(1).map((c: any) => [c.textContent, 'older' in c.dataset]),
    [
      ['One', true],
      ['Two', true],
      ['Three', false],
      ['Four', false],
      ['Five', false],
    ],
  );
  // the run stops being the last once the reply comes after it: its marks go
  t.render([step('Early'), step('Earlier'), reply('Halfway'), ...five, reply('Done')], false);
  const folded = els.rows.children[2];
  assert.equal('last' in folded.dataset, false);
  assert.equal(
    folded.children.some((c: any) => 'older' in c.dataset),
    false,
  );
});

test('windowed marks nothing older than WINDOW steps, however many there are', () => {
  assert.equal(WINDOW, 3);
  const box = { dataset: {} as Record<string, string> };
  const els = [1, 2, 3].map(() => ({ dataset: {} as Record<string, string> }));
  windowed(box, els, true);
  assert.deepEqual([box.dataset, ...els.map((e) => e.dataset)], [{ last: '' }, {}, {}, {}]);
});

test('a step that comes while the turn runs enters, and one whose line changed fades its new line in', () => {
  const { t, els, timers } = thread();
  t.turn('running');
  t.render([step('Opened a page', { state: 'running' })], false);
  const [a] = els.rows.children;
  assert.equal(a.dataset.motion, 'enter');
  // the animation is over: the mark goes, so moving the row into a fold does not play it again
  assert.deepEqual(
    timers.waiting.map((w) => w.ms),
    [MOTION_MS.enter],
  );
  timers.run();
  assert.equal('motion' in a.dataset, false);
  // the same step, now done: a new row that fades; an unchanged row is the same element and plays nothing
  t.render([step('Opened a page'), step('Read the page', { state: 'running' })], false);
  const fold = els.rows.children[0];
  const [, done, fresh] = fold.children;
  assert.equal(done.dataset.motion, 'fade');
  assert.equal(fresh.dataset.motion, 'enter');
  assert.deepEqual(
    timers.waiting.map((w) => w.ms),
    [MOTION_MS.fade, MOTION_MS.enter],
  );
  timers.run();
  t.render([step('Opened a page'), step('Read the page', { state: 'running' })], false);
  assert.deepEqual([fold.children[1], fold.children[2]], [done, fresh]);
  assert.deepEqual([done.dataset.motion, fresh.dataset.motion], [undefined, undefined]);
});

test('a step that only gained a detail or a screenshot is redrawn without a fade', () => {
  const { t, els } = thread();
  t.turn('running');
  t.render([step('Read the page', { state: 'running' })], false);
  // the first draw's mark is over
  delete els.rows.children[0].dataset.motion;
  const before = els.rows.children[0];
  t.render([step('Read the page', { state: 'running', detail: 'Input (preview)' })], false);
  const after = els.rows.children[0];
  assert.notEqual(after, before);
  assert.equal('motion' in after.dataset, false);
});

test('no motion for the rows a chat opens with, nor for those of a turn that is over', () => {
  const { t, els } = thread();
  // the first read of an opened chat: nothing has come, it was there
  t.loaded = false;
  t.turn('running');
  t.render([step('One'), step('Two')], false);
  assert.equal(
    els.rows.children[0].children.some((c: any) => c.dataset.motion),
    false,
  );
  // an idle chat's rows a later read brings
  t.loaded = true;
  t.turn('idle');
  t.render([step('One'), step('Two'), step('Three')], false);
  assert.equal(
    els.rows.children[0].children.some((c: any) => c.dataset.motion),
    false,
  );
  // marking is the helper's alone: a mark and its end
  const e = el();
  const timers = clock();
  mark(e, 'fade', timers);
  assert.equal(e.dataset.motion, 'fade');
  timers.run();
  assert.equal(e.dataset.motion, undefined);
  // each lasts a little longer than its animation in the stylesheet (430ms, .25s)
  assert.ok(MOTION_MS.enter > 430 && MOTION_MS.fade > 250);
});

const css = readFileSync(new URL('../electron/chrome-extension/sidepanel.css', import.meta.url), 'utf8');
/** what the stylesheet says outside and inside its no-preference block */
const [always, motion] = (() => {
  const at = css.indexOf('@media (prefers-reduced-motion: no-preference) {');
  return [css.slice(0, at), css.slice(at, css.indexOf('\n}\n', at))];
})();

test('the stylesheet keeps the timeline’s durations and easings, and draws every animation only without a reduced-motion preference', () => {
  assert.match(motion, /animation: step-enter 430ms cubic-bezier\(\.22, 1, \.36, 1\) backwards/);
  assert.match(motion, /animation: step-fade \.25s ease-in-out/);
  assert.match(motion, /animation: shimmer-text 3s linear infinite/);
  assert.match(css, /15% \{ background-position: 100% 0; animation-timing-function: ease-in-out; \}/);
  // the enter's start: opacity 0, blur 4px, translateY 5px, scale .9, done at 30%
  assert.match(css, /@keyframes step-enter \{ 0% \{ opacity: 0; filter: blur\(4px\); transform: translateY\(5px\) scale\(\.9\); \} 30%/);
  // the shimmer holds 15% at each end
  assert.match(css, /@keyframes shimmer-text \{ 0% .*15% .*85%, 100%/);
  // no animation property outside the block, but the spinner's (its own reduced-motion rule) and the keyframes' own timing
  const used = always.split('\n').filter((l) => /(^|[\s;{])animation:/.test(l) && !l.includes('.spin'));
  assert.deepEqual(used, []);
});

test('the window shows only while the turn runs or waits, and a finished turn ends in a check', () => {
  assert.match(
    css,
    /#chat:is\(\[data-turn="running"\], \[data-turn="waiting"\]\) \.steps\[data-last\]:not\(\[open\]\)::details-content \{ content-visibility: visible; \}/,
  );
  assert.match(css, /\.steps\[data-last\]:not\(\[open\]\) > \[data-older\] \{ display: none; \}/);
  assert.match(css, /\.progress \.dot\.ok \{[^}]*mask: var\(--check\)/);
  // the shimmer is the running state's alone
  assert.match(motion, /#chat\[data-turn="running"\] #progress-text/);
  assert.match(motion, /#chat\[data-turn="running"\] \.step\[data-state="running"\]:not\(details\)/);
});
