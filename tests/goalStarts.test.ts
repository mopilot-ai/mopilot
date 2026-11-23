// The goal tracker that tells a goal starting from an active goal's own updates (#2348).
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const { goalStarts } = createRequire(import.meta.url)('../electron/capabilities/goalStarts.cjs');

test('only a goal that was not active before starts; its usage updates do not', () => {
  const g = goalStarts();
  assert.equal(g.starts('c', { goal: { status: 'active' } }), true);
  assert.equal(g.starts('c', { goal: { status: 'active', tokensUsed: 5 } }), false);
  assert.equal(g.starts('c', { turn: 'idle' }), false);
  // paused, then running again: that starts
  assert.equal(g.starts('c', { goal: { status: 'paused' } }), false);
  assert.equal(g.starts('c', { goal: { status: 'active' } }), true);
  // cleared, then set again: that starts too; another chat's goal is its own
  assert.equal(g.starts('c', { goal: null }), false);
  assert.equal(g.starts('c', { goal: { status: 'active' } }), true);
  assert.equal(g.starts('d', { goal: { status: 'active' } }), true);
});

test("a window's late report of the goal a refusal paused is not the goal starting again; a report after it went inactive is", () => {
  const g = goalStarts();
  // the refusal came before any window reported the goal (#2758): its report of it active is catching up
  assert.equal(g.starts('c', { turn: 'running' }, true), false);
  assert.equal(g.starts('c', { goal: { status: 'active' } }, true), false);
  // then the pause reaches the window, and Resume sets it running again: that starts
  assert.equal(g.starts('c', { goal: { status: 'paused' } }, true), false);
  assert.equal(g.starts('c', { goal: { status: 'active' } }, true), true);
  // the first patch after a refusal may itself carry the late report
  const h = goalStarts();
  assert.equal(h.starts('c', { goal: { status: 'active' } }, true), false);
  // once the refusal is gone (the user was back), a goal set again starts as before
  assert.equal(h.starts('c', { goal: null }, false), false);
  assert.equal(h.starts('c', { goal: { status: 'active' } }, false), true);
  // a refusal on a chat whose goal had been reported active: still only a running update
  const k = goalStarts();
  assert.equal(k.starts('c', { goal: { status: 'active' } }), true);
  assert.equal(k.starts('c', { goal: { status: 'active', tokensUsed: 9 } }, true), false);
});
