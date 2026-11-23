// The helper's early click signal (#3810): a click's cursor goes within a frame of the real mouse-down (click.dispatched), while whether the click worked stays the action's report.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { flush, approachRig, act, ACT, inputAtOf, WIN } from './support/phantomFakes.ts';

const require = createRequire(import.meta.url);
const { AppVisibility } = require('../electron/capabilities/appVisibility.cjs');
const { withCursor } = require('../electron/capabilities/tools/appScopedApproach.cjs');
const { planApproach } = require('../shared/cursorApproach.mjs');
const { FRAME_MS } = require('../electron/capabilities/phantomCursor.cjs');

const plan = () => planApproach({ to: { x: 200, y: 200 }, bounds: { x: 0, y: 0, width: 500, height: 400 } });
const hides = (w: any) => w.calls.filter((x: any) => x[0] === 'hide').length;
const goes = async (t: any, a: { done: Promise<void> }) => {
  await flush();
  t.fireAt(FRAME_MS);
  t.fireAt(inputAtOf(plan()));
  await a.done;
};

test('PhantomCursor.dispatched: the click went out, so the cursor parks on its point; the report later still counts once and moves the previous point', async () => {
  const { e, t, c } = approachRig();
  const a = act(c);
  await goes(t, a);
  const w = e.windows[0];
  assert.equal(hides(w), 0, 'the disc is held after the press');
  assert.equal(c.dispatched({ chatId: 'c1', token: a.token }), true);
  assert.equal(hides(w), 0, "it stays on its point as the click goes out (Sky's does until its next action), and the overlay is free");
  assert.equal(c.active, null);
  assert.equal(c.parked.chatId, 'c1');
  // the answer comes later: it is the action's, not a second park, and it is still one report
  assert.equal(c.finish({ chatId: 'c1', confirmed: true, token: a.token }), true);
  assert.equal(hides(w), 0);
  c.cancel('c1');
  assert.equal(hides(w), 1);
  assert.deepEqual(
    [...c.previous.values()].map((p: any) => [p.x, p.y]),
    [[ACT.points[0].x, ACT.points[0].y]],
  );
});

test('PhantomCursor.dispatched: a failed click does not move the previous point; a wrong chat, a stranger token, a finished or a queued action change nothing', async () => {
  const { e, t, c } = approachRig();
  const a = act(c);
  await goes(t, a);
  const w = e.windows[0];
  assert.equal(c.dispatched({ chatId: 'other', token: a.token }), false, "another chat's signal");
  assert.equal(c.dispatched({ chatId: 'c1', token: {} }), false, 'a token with no approach');
  assert.equal(c.dispatched({ chatId: 'c1', token: undefined }), false);
  assert.equal(hides(w), 0);
  const queued = act(c, { chatId: 'c2' });
  await flush();
  assert.equal(c.dispatched({ chatId: 'c2', token: queued.token }), false, 'a queued action is not the one on the overlay');
  assert.equal(c.dispatched({ chatId: 'c1', token: a.token }), true);
  assert.equal(c.dispatched({ chatId: 'c1', token: a.token }), false, 'once');
  // the click had failed: main interrupts instead of reporting, and the point never became the previous one
  c.cancel('c1');
  assert.equal(
    [...c.previous.values()].some((p: any) => p.chatId === 'c1'),
    false,
  );
  c.cancel('c2');
  // a reported action is done: a late signal for it does nothing
  const b = act(c);
  await flush();
  t.fireAt(FRAME_MS);
  assert.equal(c.finish({ chatId: 'c1', confirmed: true, token: b.token }), true);
  assert.equal(c.dispatched({ chatId: 'c1', token: b.token }), false);
});

test('AppVisibility: a click gets a signal, the helper’s click.dispatched ends its cursor, the report or an interruption forgets the signal', () => {
  const seen: any[] = [];
  const cursor = {
    dispatched: (a: any) => seen.push(['dispatched', a.chatId]),
    finish: (a: any) => (seen.push(['finish', a.chatId]), true),
    cancel: (chatId: string) => seen.push(['cancel', chatId]),
  };
  const v = new AppVisibility({ sessions: { get: () => null, patch: () => {} }, cursor });
  const token = {};
  const signal = v.signalFor('c1', token);
  assert.equal(typeof signal, 'string');
  assert.equal(v.signalFor('c1', token), signal, 'one signal per action, however often it is asked');
  v.clickDispatched(signal);
  v.clickDispatched('unknown');
  v.clickDispatched(undefined);
  v.clickDispatched(5 as any);
  assert.deepEqual(seen, [['dispatched', 'c1']]);
  // the report forgets it (the cursor then finishes once), an interruption too
  v.acted('c1', {
    app: { bundleId: 'com.apple.Notes', name: 'Notes' },
    points: [{ x: 1, y: 1 }],
    bounds: { x: 0, y: 0, width: 10, height: 10 },
    state: 'visible',
    token,
    action: 'click',
  });
  v.clickDispatched(signal);
  assert.equal(seen.filter((x) => x[0] === 'dispatched').length, 1, 'a late signal after the report does nothing');
  const t2 = {};
  const s2 = v.signalFor('c1', t2);
  v.interrupted('c1', t2);
  v.clickDispatched(s2);
  assert.equal(seen.filter((x) => x[0] === 'dispatched').length, 1);
  assert.deepEqual(seen.at(-1), ['cancel', 'c1']);
  v.interrupted('c1');
  // nothing to signal without a cursor or a token
  assert.equal(new AppVisibility({ sessions: { get: () => null, patch: () => {} }, cursor: null }).signalFor('c1', {}), null);
  assert.equal(v.signalFor('c1', undefined), null);
  new AppVisibility({ sessions: { get: () => null, patch: () => {} }, cursor: null }).clickDispatched('x');
});

test('withCursor: a click carries the signal its visibility made; with none (no cursor, an old build) it carries none and the run still goes', async () => {
  const made: any[] = [];
  const control = {
    visibility: {
      signalFor: (chatId: string, token: any) => (made.push([chatId, token]), 'sig-9'),
      approach: async () => {},
      interrupted: (chatId: string, token: any) => made.push(['interrupted', chatId, token]),
    },
    waitForUser: async () => {},
  };
  const c: any = { chatId: 'c1', app: { bundleId: 'b', name: 'N' } };
  const r = { w: { bounds: WIN, state: 'visible' }, t: { point: { x: 1, y: 1 } }, points: [] };
  let seenSignal: any;
  await withCursor(control, c, 'click', r, async () => (seenSignal = c.cursorSignal));
  assert.equal(seenSignal, 'sig-9');
  assert.equal(made[0][0], 'c1');
  assert.equal(made[0][1], c.cursorToken);
  // a run that throws interrupts the cursor with its token
  await assert.rejects(
    withCursor(control, c, 'click', r, async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(made.at(-1)?.slice(0, 2), ['interrupted', 'c1']);
  // no visibility: no signal
  const bare: any = { chatId: 'c1', app: { bundleId: 'b', name: 'N' } };
  await withCursor({ waitForUser: async () => {} }, bare, 'click', r, async () => 1);
  assert.equal(bare.cursorSignal, null);
});

test('signClick: a click and an accessibility press carry the cursor signal (both are answered only after the helper settles); other requests and unsigned ones go as planned', () => {
  const { signClick } = require('../electron/capabilities/tools/appScopedApproach.cjs');
  const c: any = { cursorSignal: 'sig-1' };
  assert.deepEqual(signClick(c, { method: 'app.click', params: { x: 1 } }).params, { x: 1, signal: 'sig-1' });
  assert.deepEqual(signClick(c, { method: 'app.press', params: { action: 'AXPress' } }).params, { action: 'AXPress', signal: 'sig-1' });
  const typed = { method: 'app.setText', params: { text: 'a' } };
  assert.equal(signClick(c, typed), typed, 'typing has no mouse-down to signal');
  const plain = { method: 'app.press', params: {} };
  assert.equal(signClick({ cursorSignal: null }, plain), plain, 'no signal made (no cursor, an old build): the plan is unchanged');
});
