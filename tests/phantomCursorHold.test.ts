// The phantom cursor's click timing against a real helper (#3810): the input goes ahead of the press by the helper's latency, and the disc stays until the action reports (capped), so the cursor is never gone before the click lands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { flush, approachRig, act, ACT, inputAtOf, playedAtOf } from './support/phantomFakes.ts';

const require = createRequire(import.meta.url);
const { INPUT_LEAD_MS, HOLD_CAP_MS, STALE_MS, FRAME_MS, scheduleOf, approachHtml } = require('../electron/capabilities/phantomCursor.cjs');
const { planApproach } = require('../shared/cursorApproach.mjs');

const BOUNDS = { x: 0, y: 0, width: 1000, height: 800 };

test('scheduleOf: a click goes INPUT_LEAD_MS before the press (mid-glide for a long move, at once for a short one) and plays out HOLD_CAP_MS after it', () => {
  const long = planApproach({ from: { x: 900, y: 300 }, to: { x: 300, y: 300 }, bounds: BOUNDS });
  const s = scheduleOf(long, true);
  assert.equal(s.inputAt, long.pressAtMs - INPUT_LEAD_MS);
  assert.ok(s.inputAt < long.durationMs, 'the input is already on its way while the cursor still glides');
  assert.ok(s.inputAt + INPUT_LEAD_MS === long.pressAtMs, 'the click lands at the press when the helper takes INPUT_LEAD_MS');
  assert.equal(s.playedAt, long.pressAtMs + HOLD_CAP_MS);
  // a move so short that the lead exceeds the press: the input goes at once, never at a negative delay
  const near = planApproach({ from: { x: 304, y: 300 }, to: { x: 300, y: 300 }, bounds: BOUNDS, profile: { hoverMs: 20 } });
  assert.equal(scheduleOf(near, true).inputAt, 0);
  // Reduce Motion: no glide, so the press is the hover and the input goes at once
  const still = planApproach({ from: { x: 900, y: 300 }, to: { x: 300, y: 300 }, bounds: BOUNDS, reducedMotion: true });
  assert.equal(still.durationMs, 0);
  assert.deepEqual(scheduleOf(still, true), { inputAt: 0, playedAt: still.pressAtMs + HOLD_CAP_MS });
  // an action that does not press neither waits nor holds: it plays to the plan's end
  assert.deepEqual(scheduleOf(long, false), { inputAt: 0, playedAt: long.totalMs });
});

test('the disc is held until the action reports: the page keeps it HOLD_CAP_MS past the press, and the plan clock agrees', () => {
  const plan = planApproach({ from: { x: 900, y: 300 }, to: { x: 300, y: 300 }, bounds: BOUNDS });
  const held = approachHtml({ plan, press: true, holdMs: HOLD_CAP_MS });
  const total = plan.pressAtMs + HOLD_CAP_MS;
  assert.ok(held.includes(`life ${total}ms step-end both`), 'everything is gone only at the end of the hold');
  assert.ok(held.includes(`animation:disc ${total}ms`));
  // a press-free action ignores the hold, and so does a page asked for none
  assert.ok(approachHtml({ plan, press: false, holdMs: HOLD_CAP_MS }).includes(`life ${plan.totalMs}ms step-end both`));
  assert.ok(approachHtml({ plan, press: true }).includes(`life ${plan.totalMs}ms step-end both`));
});

test('a slow helper: the disc stays after the press, the input already went, and a hung helper cannot leave it up past the cap', async () => {
  const { e, t, c } = approachRig();
  let went = false;
  const { done } = act(c);
  done.then(() => (went = true));
  await flush();
  const plan = planApproach({ to: { x: 200, y: 200 }, bounds: { x: 0, y: 0, width: 500, height: 400 } });
  t.fireAt(FRAME_MS);
  assert.equal(went, false, 'the input waits for its lead');
  t.fireAt(inputAtOf(plan));
  await done;
  assert.equal(went, true);
  const w = e.windows[0];
  // the press passes and the helper has not answered: the overlay is still the click's, nothing hides it
  assert.equal(c.active.played, false);
  assert.equal(w.calls.filter((x: any) => x[0] === 'hide').length, 0, 'no hide before the action reports');
  // the cap: the cursor has played out (its page fades the disc), the overlay is free, and the window goes when nothing reports
  t.fireAt(playedAtOf(plan));
  assert.equal(c.active.played, true);
  t.fireAt(STALE_MS);
  assert.equal(w.calls.at(-1)[0], 'hide');
});

test('the report parks the held disc (it stays until the next action); a failed click, Stop and the end of the turn end it, whatever the lead', async () => {
  const { e, t, c } = approachRig();
  const plan = planApproach({ to: { x: 200, y: 200 }, bounds: { x: 0, y: 0, width: 500, height: 400 } });
  // success: the disc stays on its point when the action reports
  const ok = act(c);
  await flush();
  t.fireAt(FRAME_MS);
  t.fireAt(inputAtOf(plan));
  await ok.done;
  const w = e.windows[0];
  assert.equal(w.calls.filter((x: any) => x[0] === 'hide').length, 0);
  assert.equal(c.finish({ chatId: 'c1', confirmed: true, token: ok.token }), true);
  assert.notEqual(w.calls.at(-1)[0], 'hide');
  c.cancel('c1');
  assert.equal(w.calls.at(-1)[0], 'hide');
  // failure: main interrupts the action (a failed click is no reason to keep showing its cursor), which hides it
  const failed = act(c);
  await flush();
  t.fireAt(FRAME_MS);
  t.fireAt(inputAtOf(planApproach({ from: { x: 200, y: 200 }, to: { x: 200, y: 200 }, bounds: { x: 0, y: 0, width: 500, height: 400 } })));
  await failed.done;
  const hidesBefore = w.calls.filter((x: any) => x[0] === 'hide').length;
  c.cancel('c1');
  assert.equal(w.calls.filter((x: any) => x[0] === 'hide').length, hidesBefore + 1);
  // Stop before the lead has passed: the input is released without the cursor and the overlay hides
  const stopped = act(c, { points: [{ x: 350, y: 300 }] });
  await flush();
  c.cancel(ACT.chatId);
  await stopped.done;
  assert.equal(w.calls.at(-1)[0], 'hide');
});
