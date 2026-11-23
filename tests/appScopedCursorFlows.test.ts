// The phantom cursor through the real app-scoped tools, AppVisibility and PhantomCursor (fake window and clock): an action that reports
// twice, a slow action, two chats at once, a failed or dragging action's previous point, a wait that throws, and a turn end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { waitFor } from './support/waitFor.ts';
import { rig, rejects } from './support/app-scoped-kit.ts';
import { phantomRig, BOUNDS } from './support/phantomRig.ts';

import { inputAtOf, playedAtOf } from './support/phantomFakes.ts';
const require = createRequire(import.meta.url);
const { planApproach } = require('../shared/cursorApproach.mjs');
const { approachHtml } = require('../electron/capabilities/phantomCursor.cjs');
const { STALE_MS, PARK_MS } = require('../electron/capabilities/phantomCursor.cjs');

/** the click on Notes' element 7: window-local target (120, 290) of the kit's screenshot */
const TARGET = { x: 120, y: 290 };
const plan = (from?: { x: number; y: number }) => planApproach({ from, to: TARGET, bounds: BOUNDS });
const pageOf = (p: ReturnType<typeof plan>) => approachHtml({ plan: p, press: true, holdMs: PARK_MS });
const brief = { allowed: () => true, rung: () => 'background', remember: () => true };

async function started(o: { ladder?: any } = {}) {
  const p = phantomRig();
  const r = rig({ apps: { visibility: p.visibility, ...(o.ladder ? { ladder: o.ladder } : {}) } });
  await r.shoot();
  return { p, r };
}

test('an action that reports twice (brief-foreground escalation) plays its cursor once', async () => {
  const { p, r } = await started({ ladder: brief });
  let n = 0;
  r.helper.answers['app.click'] = (q: any) =>
    q.foreground ? { ok: true, route: 'pid', effect: 'confirmed' } : (n++, { ok: true, route: 'pid', verify: { effect: 'no_change' } });
  const done = r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  await p.arrive(inputAtOf(plan()));
  await done;
  assert.equal(n, 1);
  assert.equal(r.callsOf('app.click').length, 2, 'the click went in the background, then in front');
  assert.equal(p.approaches().length, 1, 'no second glide from the default offset');
});

test('an action slower than the stale timer does not replay its approach when it reports', async () => {
  const { p, r } = await started();
  let finish = () => {};
  r.helper.answers['app.click'] = () => new Promise((resolve) => (finish = () => resolve({ ok: true, route: 'pid', effect: 'confirmed' })));
  const done = r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  const first = plan();
  await p.arrive(inputAtOf(first));
  await waitFor(() => r.callsOf('app.click').length === 1, 'the click');
  p.fire(playedAtOf(first));
  p.fire(STALE_MS);
  assert.equal(p.windows[0].calls.at(-1), 'hide', 'the stale timer hid the cursor');
  finish();
  await done;
  assert.equal(p.approaches().length, 1, 'the slow result is not played as a new approach');
});

test('two chats acting at once: each click waits for its own arrival and the cursors never replay over each other', async () => {
  const { p, r } = await started();
  await r.shoot('com.apple.Mail', 'c2');
  const a = r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  await waitFor(() => p.approaches().length === 1, "chat 1's cursor");
  const b = r.call('desktop_app_click', { app: 'Mail', element_index: 7 }, { chatId: 'c2' });
  await waitFor(() => p.pending.size > 0, 'the clock');
  assert.equal(
    r.callsOf('app.click').length,
    0,
    "neither click goes before its cursor arrived (chat 2's approach does not release chat 1's)",
  );
  assert.equal(p.approaches().length, 1, 'one overlay: chat 2 waits for its turn');
  await p.arrive(inputAtOf(plan()));
  await a;
  assert.equal(r.callsOf('app.click').length, 1);
  // chat 1 reported: its cursor goes, chat 2's plays now and its click waits for it
  await waitFor(() => p.approaches().length === 2, "chat 2's cursor");
  assert.equal(r.callsOf('app.click').length, 1, "chat 2's click waits for its own arrival");
  await p.arrive(inputAtOf(plan()));
  await b;
  assert.equal(r.callsOf('app.click').length, 2);
  assert.equal(p.approaches().length, 2, 'no ping-pong: nothing was replayed');
});

test("a failed click does not move the chat's previous point; a dragged path does", async () => {
  const { p, r } = await started();
  r.helper.fail['app.click'] = new Error('boom');
  r.helper.fail['app.press'] = new Error('boom');
  // a click at another point (window-local 10, 10)
  const failing = r.call('desktop_app_click', { app: 'Notes', coordinate: [20, 20] });
  await p.arrive(inputAtOf(planApproach({ to: { x: 10, y: 10 }, bounds: BOUNDS })));
  await assert.rejects(failing);
  delete r.helper.fail['app.click'];
  delete r.helper.fail['app.press'];
  // the next click comes in from the default start, not from the point that never got a click
  const next = r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  await waitFor(() => p.approaches().length === 2, 'the next page');
  assert.equal(p.approaches().at(-1), pageOf(plan()));
  await p.arrive(inputAtOf(plan()));
  await next;
  // a drag ends at (100, 50) in the window: the click after it starts on the line back to there
  await r.call('desktop_app_drag', { app: 'Notes', coordinate: [0, 0], to_coordinate: [200, 100] });
  const after = r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  await waitFor(() => p.approaches().length === 3, 'the page after the drag');
  assert.equal(p.approaches().at(-1), pageOf(plan({ x: 100, y: 50 })));
  await p.arrive(inputAtOf(plan({ x: 100, y: 50 })));
  await after;
});

test('a wait that throws after the approach (the user took the app over and never handed it back) clears the cursor', async () => {
  const p = phantomRig();
  const r = rig({ apps: { visibility: p.visibility, takeoverWaitMs: 30 } });
  await r.shoot();
  const done = r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  await waitFor(() => p.approaches().length === 1, 'the cursor');
  r.apps.takeOver('c1', 'com.apple.Notes');
  await p.arrive(inputAtOf(plan()));
  await rejects(done, 'busy', /took over/);
  assert.equal(p.cursor.active, null);
  assert.equal(p.windows[0].shown, false);
});

test("the end of a turn forgets where the chat's cursor was", async () => {
  const { p, r } = await started();
  const one = r.call('desktop_app_click', { app: 'Notes', element_index: 7 });
  await p.arrive(inputAtOf(plan()));
  await one;
  assert.equal(p.cursor.previous.size, 1);
  r.apps.turnEnded('c1');
  assert.equal(p.cursor.previous.size, 0);
});

test('with the real cursor: a drag (no approach) is drawn when it reports, and a batch step gets its arrow after the fact', async () => {
  const { p, r } = await started();
  await r.call('desktop_app_drag', { app: 'Notes', coordinate: [0, 0], to_coordinate: [200, 100] });
  await waitFor(() => p.pages().some((x) => x.includes('<polyline')), "the drag's path");
  assert.equal(p.approaches().length, 0, 'a drag has no approach');
  await waitFor(() => p.windows[0].shown, 'the window shown once the path loaded');
  // a step inside desktop_app_batch is reported without an approach: the arrow, not a ring or a press
  await r.call('desktop_app_batch', { app: 'Notes', actions: [{ action: 'click', element_index: 7 }] });
  await waitFor(() => p.approaches().length === 1, "the batch step's arrow");
  assert.doesNotMatch(p.approaches()[0], /class="disc"/);
});
