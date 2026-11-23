// electron/capabilities/phantomCursor.cjs: the desktop phantom cursor's pages (cursorHtml, approachHtml) and its approach/finish/show over a mocked Electron BrowserWindow and fake timers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  PhantomCursor,
  cursorHtml,
  approachHtml,
  HIDE_AFTER_MS,
  STALE_MS,
  LOAD_WAIT_MS,
  FRAME_MS,
  RUN_CSS,
  DRAG_MS,
  PARK_MS,
} = require('../electron/capabilities/phantomCursor.cjs');
const { planApproach } = require('../shared/cursorApproach.mjs');
import { fakeElectron, fakeTimers, flush, page, WIN, approachRig, ACT, act, inputAtOf, playedAtOf } from './support/phantomFakes.ts';

/* -- the phantom cursor ---------------------------------------------------- */
test('cursorHtml: a drag glides evenly through every point with its path drawn as long as it is', () => {
  const drag = cursorHtml({
    width: 500,
    height: 400,
    from: { x: 0, y: 0 },
    points: [
      { x: 0, y: 0 },
      { x: 30, y: 40 },
      { x: 30, y: 50 },
    ],
  });
  assert.match(drag, /default-src 'none'; style-src 'unsafe-inline'/);
  assert.doesNotMatch(drag, /<script/);
  assert.match(drag, /0%\{[^}]*\}33\.3%\{[^}]*\}66\.7%\{[^}]*\}100%\{transform:translate\(30px,50px\)\}/);
  assert.match(drag, /<polyline points="0,0 30,40 30,50"\/>/);
  assert.match(drag, /stroke-dasharray:60;stroke-dashoffset:60/);
  // a path glides evenly: a spring would surge at every point
  assert.ok(drag.includes(`animation:glide ${DRAG_MS}ms cubic-bezier(.2,.8,.2,1) both`));
  assert.ok(drag.includes(`animation:draw ${DRAG_MS}ms ease-in-out both`));
  assert.match(drag, /prefers-reduced-motion:reduce\)\{\.cur,\.path polyline\{animation-duration:1ms;animation-delay:0ms\}\}/);
  assert.doesNotMatch(drag, /ripple/);
});

test('approachHtml: the plan as CSS (start, linear() of the samples, the arrow shrinks and a fog comes up at the press, gone at the end); no script', () => {
  const plan = planApproach({ from: { x: 200, y: 100 }, to: { x: 50, y: 60 } });
  const html = approachHtml({ plan, press: true });
  assert.match(html, /default-src 'none'; style-src 'unsafe-inline'/);
  assert.doesNotMatch(html, /<script/);
  // appears at the plan's start (tip at +2), glides to the target on the sampled progress curve, compositor properties only
  assert.ok(html.includes(`@keyframes glide{from{transform:translate(188px,95.3px)}to{transform:translate(48px,58px)}}`));
  const curve = /glide (\d+(?:\.\d+)?)ms linear\(([^)]*)\) both/.exec(html)!;
  assert.equal(Number(curve[1]), plan.durationMs);
  const stops = curve[2].split(',').map(Number);
  assert.equal(stops.length, plan.durationMs * 0.12 + 1);
  assert.deepEqual([stops[0], stops.at(-1)], [0, 1]);
  assert.ok(stops.every((v, i) => i === 0 || v >= stops[i - 1]));
  assert.doesNotMatch(html, /(?:left|top|width|height)\s*:\s*[^;}]*(?:glide)/);
  // the arrow shrinks at the press and stays, a grey fog comes up under it (Sky's look), everything gone at the end of the plan
  const at = Math.round((plan.pressAtMs / plan.totalMs) * 1e7) / 1e5;
  assert.ok(html.includes(`@keyframes arrow{0%{transform:scale(1)}${at}%{transform:scale(.8)}100%{transform:scale(.8)}}`));
  assert.ok(html.includes(`@keyframes disc{0%{opacity:0}${at}%{opacity:1}100%{opacity:1}}`));
  assert.ok(html.includes(`life ${plan.totalMs}ms step-end both`));
  assert.match(html, /<div class="disc"><\/div>/);
  // without a press (typing, scrolling) the arrow stays and there is no disc
  const quiet = approachHtml({ plan, press: false });
  assert.doesNotMatch(quiet, /class="disc"|keyframes arrow/);
  // reduced motion: no glide at all, the cursor sits on the target, and the page's own media query agrees
  const still = approachHtml({ plan: planApproach({ from: { x: 200, y: 100 }, to: { x: 50, y: 60 }, reducedMotion: true }), press: true });
  assert.doesNotMatch(still, /glide/);
  assert.match(still, /\.cur\{[^}]*transform:translate\(48px,58px\)/);
  assert.match(
    html,
    /\.cur,\.arrow,\.disc\{animation-play-state:paused\}<\/style>/,
    'paused until the main process says run, also under Reduce Motion',
  );
  assert.match(html, /prefers-reduced-motion:reduce\)\{\.cur\{animation:life \d+(\.\d+)?ms step-end both\}\}/);
  // Sky shows no click ring: no page carries one
  assert.doesNotMatch(html, /ripple|ring-fade/);
});

test('PhantomCursor.approach: one capture-excluded click-through window; the click waits for arrival, hover and press; the cursor is gone after', async () => {
  const { e, t, c } = approachRig();
  let went = false;
  const { token, done } = act(c);
  done.then(() => (went = true));
  const w = e.windows[0];
  assert.equal(w.opts.webPreferences.javascript, false);
  assert.equal(w.opts.focusable, false);
  assert.deepEqual(w.calls.slice(0, 3), [
    ['setIgnoreMouseEvents', true],
    ['setAlwaysOnTop', true, 'screen-saver'],
    ['setContentProtection', true],
  ]);
  assert.deepEqual(w.calls.find((x: any) => x[0] === 'setBounds')[1], { x: 100, y: 50, width: 500, height: 400 });
  assert.equal(w.calls.at(-1)[0], 'loadURL');
  // no previous point: the lower-left start, in window points, and the plan of planApproach
  const plan = planApproach({ to: { x: 200, y: 200 }, bounds: { x: 0, y: 0, width: 500, height: 400 } });
  assert.equal(page(w), approachHtml({ plan, press: true, holdMs: PARK_MS }));
  // the window is shown when the page is in, and the clock starts then
  assert.equal(
    w.calls.some((x: any) => x[0] === 'showInactive'),
    false,
  );
  await flush();
  const names = w.calls.map((x: any) => x[0]);
  assert.deepEqual(names.slice(-2), ['showInactive', 'insertCSS'], 'shown when loaded, then told to run');
  assert.equal(w.calls.at(-1)[1], RUN_CSS);
  assert.equal(went, false);
  assert.ok(!t.delays.has(-1) && ![...t.delays.values()].includes(inputAtOf(plan)), 'the plan is not running yet: one frame to go');
  assert.ok([...t.delays.values()].includes(FRAME_MS));
  t.fireAt(FRAME_MS);
  assert.ok([...t.delays.values()].includes(inputAtOf(plan)), 'the input waits for the press');
  t.fireAt(inputAtOf(plan));
  await done;
  assert.equal(went, true);
  assert.ok(c.active, 'the cursor page plays out on its own');
  // the action reported: the click's cursor stays parked on its point (nothing confirmed, no ring); the overlay is free for the next action
  assert.equal(c.finish({ chatId: 'c1', confirmed: false, token }), true);
  assert.notEqual(w.calls.at(-1)[0], 'hide');
  assert.equal(c.active, null);
  assert.deepEqual(c.parked, { chatId: 'c1', key: c.parked.key });
  assert.equal(t.pending.size, 1, 'only the backstop timer is left');
  assert.equal(c.finish({ chatId: 'c1', confirmed: false, token }), true, 'a second report of the same action does nothing');
  assert.notEqual(w.calls.at(-1)[0], 'hide');
  c.cancel('c1');
  assert.equal(w.calls.at(-1)[0], 'hide');
  assert.equal(t.pending.size, 0, 'no timer is left');
  assert.equal(c.finish({ chatId: 'c1', confirmed: false, token: {} }), false, 'an action with no approach');
  assert.equal(c.finish({ chatId: 'c1', confirmed: false }), false, 'no token');
  assert.equal(c.finish({ chatId: 'c2', confirmed: false, token }), false, "another chat's report");
});

test('PhantomCursor.approach: the next action comes in along the line back to the previous point (set when the last one succeeded) of the same chat and app', async () => {
  const { e, t, c } = approachRig();
  const first = act(c);
  const w = e.windows[0];
  const second = { ...ACT, points: [{ x: 500, y: 250 }] };
  await flush();
  c.finish({ chatId: 'c1', confirmed: false, token: first.token });
  await first.done;
  const next = c.approach(second);
  const plan = planApproach({
    from: { x: 200, y: 200 },
    to: { x: 400, y: 200 },
    bounds: { x: 0, y: 0, width: 500, height: 400 },
  });
  assert.equal(page(w), approachHtml({ plan, press: true, holdMs: PARK_MS }));
  assert.deepEqual(plan.start, { x: 260, y: 200 }, 'on the way back to the previous point, 140 pt away or on it');
  c.cancel('c1');
  await next;
  // an action that never succeeded (no finish) left the previous point where it was
  c.approach({ ...ACT, points: [{ x: 150, y: 100 }], token: {} });
  c.cancel('c1');
  const again = { ...ACT, token: {} };
  c.approach(again);
  assert.equal(
    page(w),
    approachHtml({
      plan: planApproach({ from: { x: 400, y: 200 }, to: { x: 200, y: 200 }, bounds: { x: 0, y: 0, width: 500, height: 400 } }),
      press: true,
      holdMs: PARK_MS,
    }),
  );
  c.cancel('c1');
  // another app of the chat, or another chat, has its own previous point
  for (const other of [
    { ...ACT, bundleId: 'com.apple.Mail' },
    { ...ACT, chatId: 'c2' },
  ]) {
    c.approach(other);
    assert.equal(
      page(w),
      approachHtml({
        plan: planApproach({ to: { x: 200, y: 200 }, bounds: { x: 0, y: 0, width: 500, height: 400 } }),
        press: true,
        holdMs: PARK_MS,
      }),
    );
    c.cancel(other.chatId);
  }
  // an action that already ran (no token) is the previous point at once; the window moved: the point is still where it was on the screen
  c.approach({ ...ACT, points: [{ x: 600, y: 250 }], kind: 'move' });
  c.cancel('c1');
  const moved = { ...ACT, bounds: { ...WIN, x: 0 }, points: [{ x: 300, y: 250 }] };
  c.approach(moved);
  assert.deepEqual(
    page(w),
    approachHtml({
      plan: planApproach({ from: { x: 600, y: 200 }, to: { x: 300, y: 200 }, bounds: { x: 0, y: 0, width: 500, height: 400 } }),
      press: true,
      holdMs: PARK_MS,
    }),
  );
  // a turn end forgets the chat's previous points (and its cursor); another chat keeps its own
  c.forgetPositions('c1');
  assert.equal(c.active, null);
  c.approach(ACT);
  assert.equal(
    page(w),
    approachHtml({
      plan: planApproach({ to: { x: 200, y: 200 }, bounds: { x: 0, y: 0, width: 500, height: 400 } }),
      press: true,
      holdMs: PARK_MS,
    }),
  );
  c.forget('c1');
  assert.equal([...c.previous.values()].filter((v: any) => v.chatId === 'c1').length, 0);
  assert.equal([...c.previous.values()].filter((v: any) => v.chatId === 'c2').length, 1, 'another chat keeps its own');
  c.forget('nobody');
  t.fire();
});

test('PhantomCursor.approach: only a click waits and presses; typing and scrolling show the arrow and go at once', async () => {
  const { e, c } = approachRig();
  for (const kind of ['type', 'scroll', 'focus']) {
    await c.approach({ ...ACT, kind });
    assert.doesNotMatch(page(e.windows[0]), /class="disc"/);
    assert.equal(c.active.press, false);
  }
});

test('PhantomCursor.approach: stop, take-over, hide or a failing window release the waiting input at once', async () => {
  const { e, t, c } = approachRig();
  const order: string[] = [];
  const waits = (label: string, extra: object = {}) => c.approach({ ...ACT, ...extra }).then(() => order.push(label));
  // Stop (cancel) for the chat: the window hides and the wait ends
  const a = waits('a');
  c.cancel('someone else');
  await flush();
  assert.equal(order.length, 0, "another chat's Stop does not end it");
  c.cancel('c1');
  await a;
  assert.deepEqual(order, ['a']);
  assert.equal(e.windows[0].calls.at(-1)[0], 'hide');
  assert.equal(t.pending.size, 0);
  c.cancel('c1'); // nothing active: fine
  // a played cursor (its press done, its action still running) hides itself when no result ever comes
  waits('s');
  await flush();
  const plan = planApproach({ to: { x: 200, y: 200 }, bounds: { x: 0, y: 0, width: 500, height: 400 } });
  t.fireAt(FRAME_MS);
  t.fireAt(inputAtOf(plan));
  t.fireAt(playedAtOf(plan));
  assert.ok(c.active.played);
  t.fireAt(STALE_MS);
  assert.equal(c.active, null);
  assert.equal(e.windows[0].calls.at(-1)[0], 'hide');
  await flush();
  assert.ok(order.includes('s'));
  // hide() while it waits
  const h = waits('h');
  c.hide();
  await h;
  assert.ok(order.includes('h'));
  // a drag is not shown over a cursor still on its way; once that has played it may be
  const d = waits('d');
  const path = [
    { x: 110, y: 60 },
    { x: 150, y: 90 },
  ];
  await flush();
  assert.equal(c.show({ bounds: WIN, points: path }), false);
  t.fireAt(FRAME_MS);
  t.fireAt(inputAtOf(plan));
  t.fireAt(playedAtOf(plan));
  assert.equal(c.show({ bounds: WIN, points: path }), true);
  await d;
  c.dispose();
});

test('PhantomCursor.approach: the page load decides when the clock starts; a failed or unfinished load shows nothing and holds nothing', async () => {
  const { e, t, c } = approachRig();
  const plan = planApproach({ to: { x: 200, y: 200 }, bounds: { x: 0, y: 0, width: 500, height: 400 } });
  // loaded: the clock starts, once, and the cap does nothing more
  let went = false;
  const loaded = c.approach(ACT).then(() => (went = true));
  await flush();
  assert.equal([...t.delays.values()].filter((ms) => ms === FRAME_MS).length, 1, 'the clock starts one frame after the page runs');
  t.fireAt(FRAME_MS);
  assert.equal([...t.delays.values()].filter((ms) => ms === inputAtOf(plan)).length >= 1, true);
  assert.equal(
    [...t.pending.keys()].some((k) => t.delays.get(k) === LOAD_WAIT_MS),
    false,
    'the cap is done once the clock runs',
  );
  assert.equal(went, false);
  t.fireAt(inputAtOf(plan));
  await loaded;
  assert.equal(went, true);
  c.hide();
  const w = e.windows[0];
  // never settles: after the cap the input goes on and nothing was shown
  w.loadMode = 'pending';
  const shows = () => w.calls.filter((x: any) => x[0] === 'showInactive').length;
  const before = shows();
  c.approach(ACT).then(() => (went = false));
  await flush();
  assert.equal(went, true);
  t.fireAt(LOAD_WAIT_MS);
  await flush();
  assert.equal(went, false);
  assert.equal(c.active, null);
  assert.equal(shows(), before);
  // the load fails: nothing shown, no wait
  w.loadMode = 'reject';
  await c.approach(ACT);
  await flush();
  assert.equal(c.active, null);
  assert.equal(shows(), before);
  // the load fails after a newer action took the overlay: the newer one is untouched
  w.loadMode = 'resolve';
  c.approach(ACT);
  assert.ok(c.active);
  // loadURL throws: nothing shown, no wait
  c.hide();
  w.loadMode = 'throw';
  await c.approach(ACT);
  assert.equal(c.active, null);
  // a cancel before the load answers does not start a clock
  w.loadMode = 'resolve';
  const gone = c.approach(ACT);
  c.cancel('c1');
  await gone;
  await flush();
  assert.equal(t.pending.size, 0);
  // the window is gone when the page is in: nothing to show
  const d = c.approach(ACT);
  w.destroyed = true;
  await flush();
  c.cancel('c1');
  await d;
  w.destroyed = false;
  // showing fails: the cursor is cosmetic
  c.hide();
  w.throwOn.add('showInactive');
  c.approach(ACT);
  await flush();
  w.throwOn.delete('showInactive');
  c.hide();
});

test('PhantomCursor.approach: Reduce Motion jumps to the target (system setting, or the page) and the press still waits its hover', async () => {
  const { e, c } = approachRig({ reducedMotion: () => true });
  c.approach(ACT);
  const html = page(e.windows[0]);
  assert.doesNotMatch(html, /glide/);
  assert.equal(html, approachHtml({ plan: planApproach({ to: { x: 200, y: 200 }, reducedMotion: true }), press: true, holdMs: PARK_MS }));
  c.hide();
  // the default reads Electron's animation settings
  for (const [settings, want] of [
    [{ getAnimationSettings: () => ({ prefersReducedMotion: true }) }, true],
    [{ getAnimationSettings: () => ({ prefersReducedMotion: false }) }, false],
    [{ getAnimationSettings: () => ({}) }, false],
    [
      {
        getAnimationSettings: () => {
          throw new Error('no');
        },
      },
      false,
    ],
    [{}, false],
    [undefined, false],
  ] as const) {
    const r = approachRig({ electron: { BrowserWindow: fakeElectron().electron.BrowserWindow, systemPreferences: settings } });
    assert.equal(r.c.reducedMotion(), want);
  }
  assert.equal(new PhantomCursor({ electron: null }).reducedMotion(), false);
});

test('PhantomCursor.finish: a click leaves no ring and parks its cursor; another action hides at once', async () => {
  const { e, t, c } = approachRig();
  for (const [kind, confirmed] of [
    ['click', true],
    ['click', false],
    ['type', true],
  ] as const) {
    const a = act(c, { kind });
    await flush();
    t.fireAt(FRAME_MS);
    const loads = e.windows[0].calls.filter((x: any) => x[0] === 'loadURL').length;
    assert.equal(c.finish({ chatId: 'c1', confirmed, token: a.token }), true);
    await a.done;
    const w = e.windows[0];
    assert.equal(w.calls.filter((x: any) => x[0] === 'loadURL').length, loads, `${kind} ${confirmed}: no ring page`);
    if (kind === 'click') {
      assert.notEqual(w.calls.at(-1)[0], 'hide', `${kind} ${confirmed}: parked on its point`);
      assert.equal(t.pending.size, 1, `${kind} ${confirmed}: only the backstop timer`);
      c.cancel('c1');
    } else assert.equal(w.calls.at(-1)[0], 'hide', `${kind} ${confirmed}: hidden at once`);
    assert.equal(t.pending.size, 0, `${kind} ${confirmed}: no linger timer`);
  }
});

test('PhantomCursor.approach: nothing to show, no Electron, or a window that fails', async () => {
  const { e, c } = approachRig();
  for (const bad of [
    null,
    { ...WIN, width: 0 },
    { ...WIN, height: -1 },
    { ...WIN, x: NaN },
    { ...WIN, y: undefined },
    { ...WIN, width: Infinity },
  ])
    await c.approach({ ...ACT, bounds: bad });
  await c.approach({ ...ACT, points: [{ x: NaN, y: 1 }, null] });
  await c.approach({ ...ACT, points: undefined });
  assert.equal(e.windows.length, 0);
  await new PhantomCursor({ electron: null }).approach(ACT);
  await new PhantomCursor({}).approach(ACT);
  await new PhantomCursor({ electron: fakeElectron({ makeThrows: true }).electron }).approach(ACT);
  // placing the window fails: the input is not held
  c.approach({ ...ACT, kind: 'type' });
  c.hide();
  e.windows[0].throwOn.add('setBounds');
  await c.approach(ACT);
  assert.equal(c.active, null);
});

test('PhantomCursor.show (a drag): glides from the last point; hides after a while; failures are quiet', () => {
  const e = fakeElectron();
  const t = fakeTimers();
  const c = new PhantomCursor({ electron: e.electron, timers: t.timers });
  const drag = [
    { x: 300, y: 250 },
    { x: 310, y: 260 },
  ];
  assert.equal(c.show({ bounds: WIN, points: drag }), true);
  const w = e.windows[0];
  // the first point in a window: the pointer comes in from up and to the left
  assert.match(page(w), /0%\{transform:translate\(164px,172px\)\}/);
  // the next drag in the same window glides from where the last one ended; one window is reused
  c.show({ bounds: WIN, points: [{ x: 110, y: 60 }] });
  assert.match(page(w), /0%\{transform:translate\(210px,210px\)\}100%\{transform:translate\(10px,10px\)\}/);
  assert.equal(e.windows.length, 1);
  assert.equal(t.pending.size, 1, 'one hide timer, reset by each show');
  assert.equal([...t.delays.values()].at(-1), HIDE_AFTER_MS);
  c.show({ bounds: { ...WIN, x: 0 }, points: [{ x: 50, y: 60 }] });
  assert.match(page(w), /0%\{transform:translate\(14px,-18px\)\}/);
  t.fire();
  assert.equal(w.calls.at(-1)[0], 'hide');
  assert.equal(c.last, null);
  c.dispose();
  assert.equal(w.destroyed, true);
  assert.equal(c.window, null);
  c.show({ bounds: WIN, points: drag });
  assert.equal(e.windows.length, 2);
  c.hide();
  c.hide();
  // nothing to show
  for (const bad of [null, { ...WIN, width: 0 }, { ...WIN, x: NaN }]) assert.equal(c.show({ bounds: bad, points: drag }), false);
  assert.equal(c.show({ bounds: WIN, points: [{ x: NaN, y: 1 }, null] }), false);
  assert.equal(c.show({ bounds: WIN, points: undefined }), false);
  assert.equal(new PhantomCursor({ electron: null }).show({ bounds: WIN, points: drag }), false);
  assert.equal(new PhantomCursor({ electron: fakeElectron({ makeThrows: true }).electron }).show({ bounds: WIN, points: drag }), false);
  // showing fails: nothing scheduled; hiding or destroying fails: ignored
  assert.equal(c.show({ bounds: WIN, points: drag }), true);
  const w2 = e.windows.at(-1);
  w2.throwOn.add('setBounds');
  assert.equal(c.show({ bounds: WIN, points: drag }), false);
  w2.throwOn.add('hide');
  w2.throwOn.add('destroy');
  c.hide();
  c.dispose();
  assert.equal(c.window, null);
  // the load fails (cosmetic); a fractional window is rounded, never below one point
  const c2 = new PhantomCursor({ electron: e.electron, timers: t.timers });
  c2.show({ bounds: { x: 1.4, y: 2.6, width: 0.2, height: 10.5 }, points: [{ x: 1.4, y: 2.6 }] });
  assert.deepEqual(e.windows.at(-1).calls.find((x: any) => x[0] === 'setBounds')[1], { x: 1, y: 3, width: 1, height: 11 });
  // real timers by default
  const c3 = new PhantomCursor({ electron: e.electron });
  c3.show({ bounds: WIN, points: [{ x: 101, y: 51 }] });
  c3.approach(ACT);
  c3.dispose();
});
