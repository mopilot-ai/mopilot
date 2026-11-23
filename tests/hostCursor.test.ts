// The agent's cursor over a Host desktop in the pane (src/lib/hostCursor.ts): the plan runs on the action's clock, the press waits for the Host's answer (capped), and a frame of another geometry version shows nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HOLD_CAP_MS, cursorOver, cursorView, reduceCursor } from '../src/lib/hostCursor.ts';
import { planApproach } from '../shared/cursorApproach.mjs';

const plan = () => {
  const p = planApproach({ from: { x: 600, y: 500 }, to: { x: 400, y: 300 } });
  return { samples: p.samples, to: p.to, pressAtMs: p.pressAtMs, totalMs: p.totalMs, hideAfterClickMs: p.hideAfterClickMs };
};
const approach = (over: any = {}) => ({ kind: 'approach' as const, id: 1, version: 3, press: true, plan: plan(), ...over });

test('an approach starts on the action’s own clock; the cursor glides as an arrow, presses as a disc and holds for the Host’s answer, capped', () => {
  const p = plan();
  const s = reduceCursor(null, approach(), 1000);
  const press = p.pressAtMs + 0.01; // the clock is read in whole ms; float sums land a hair under
  assert.deepEqual(cursorView(s, 999, 3), null, 'not before it starts');
  const start = cursorView(s, 1000, 3)!;
  assert.equal(start.shape, 'arrow');
  assert.deepEqual({ x: start.x, y: start.y }, { x: p.samples[0].x, y: p.samples[0].y });
  const arrived = cursorView(s, 1000 + p.pressAtMs - 1, 3)!;
  assert.equal(arrived.shape, 'arrow');
  assert.ok(Math.abs(arrived.x - 400) < 1 && Math.abs(arrived.y - 300) < 1);
  assert.equal(cursorView(s, 1000 + press, 3)!.shape, 'disc');
  assert.equal(cursorView(s, 1000 + press + HOLD_CAP_MS - 1, 3)!.shape, 'disc', 'it waits for the answer');
  assert.equal(cursorView(s, 1000 + press + HOLD_CAP_MS, 3), null, 'and does not wait for ever');
  assert.equal(cursorOver(s, 1000 + press + HOLD_CAP_MS), true);
  assert.equal(cursorOver(s, 1000 + 10), false);
});

test('the Host’s answer ends the disc a few ms later, never before the press; a message for another action changes nothing', () => {
  const p = plan();
  let s = reduceCursor(null, approach(), 0);
  s = reduceCursor(s, { kind: 'dispatched', id: 2 }, 100);
  assert.equal(s!.dispatchedAt, null, 'a message about another action');
  s = reduceCursor(s, { kind: 'dispatched', id: 1 }, p.pressAtMs + 30);
  assert.equal(cursorView(s, p.pressAtMs + 30 + p.hideAfterClickMs - 1, 3)!.shape, 'disc');
  assert.equal(cursorView(s, p.pressAtMs + 30 + p.hideAfterClickMs, 3), null);
  // an answer before the cursor has arrived still shows the press
  let early = reduceCursor(null, approach(), 0);
  early = reduceCursor(early, { kind: 'dispatched', id: 1 }, 10);
  assert.equal(cursorView(early, p.pressAtMs, 3)!.shape, 'disc');
  assert.equal(cursorView(early, p.pressAtMs + p.hideAfterClickMs, 3), null);
});

test('a frame of another geometry version shows nothing; one that matches shows it again', () => {
  const s = reduceCursor(null, approach(), 0);
  assert.equal(cursorView(s, 50, 2), null);
  assert.equal(cursorView(s, 50, null), null);
  assert.ok(cursorView(s, 50, 3));
  assert.equal(cursorView(null, 50, 3), null);
  assert.equal(cursorOver(null, 0), true);
});

test('an action that does not press is an arrow until the plan has played; hide ends the action it names, or any with id 0; a newer approach replaces', () => {
  const p = plan();
  const m = reduceCursor(null, approach({ press: false }), 0);
  assert.equal(cursorView(m, p.pressAtMs + 1, 3)!.shape, 'arrow');
  assert.equal(cursorView(m, p.totalMs, 3), null);
  assert.equal(reduceCursor(m, { kind: 'hide', id: 9 }, 5), m, 'another action’s hide');
  assert.equal(reduceCursor(m, { kind: 'hide', id: 1 }, 5), null);
  assert.equal(reduceCursor(m, { kind: 'hide', id: 0 }, 5), null);
  const replaced = reduceCursor(m, approach({ id: 2, version: 4 }), 7);
  assert.deepEqual({ id: replaced!.id, startedAt: replaced!.startedAt, version: replaced!.version }, { id: 2, startedAt: 7, version: 4 });
});
