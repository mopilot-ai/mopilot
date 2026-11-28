// Auto's two hysteresis policies: a cheaper tier waits for a second ask, and Global Auto moves harness only on a clear lead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { settleTier } = require('../electron/autoRoute/sticky.cjs');
const { decideHarness, COOLDOWN_TURNS } = require('../electron/autoRoute/globalPolicy.cjs');

test('a first or stronger tier applies at once', () => {
  assert.deepEqual(settleTier(null, 'C1'), { tier: 'C1', down: null, held: false });
  assert.deepEqual(settleTier({ tier: 'bogus' }, 'C2'), { tier: 'C2', down: null, held: false });
  assert.deepEqual(settleTier({ tier: 'C1', down: { tier: 'C0', count: 1 } }, 'C3'), { tier: 'C3', down: null, held: false });
  assert.deepEqual(settleTier({ tier: 'C2' }, 'C2'), { tier: 'C2', down: null, held: false });
  assert.throws(() => settleTier(null, 'C9'), /Unknown router tier/);
});

test('one tier cheaper waits for a second ask in a row; two tiers cheaper does not', () => {
  const first = settleTier({ tier: 'C2' }, 'C1');
  assert.deepEqual(first, { tier: 'C2', down: { tier: 'C1', count: 1 }, held: true });
  assert.deepEqual(settleTier({ tier: 'C2', down: first.down }, 'C1'), { tier: 'C1', down: null, held: false });
  // a different cheaper tier starts its own count
  assert.deepEqual(settleTier({ tier: 'C3', down: { tier: 'C1', count: 1 } }, 'C2'), {
    tier: 'C3',
    down: { tier: 'C2', count: 1 },
    held: true,
  });
  assert.deepEqual(settleTier({ tier: 'C3' }, 'C1'), { tier: 'C1', down: null, held: false });
});

test('a failed turn never earns a cheaper model for the retry', () => {
  assert.deepEqual(settleTier({ tier: 'C3' }, 'C0', { failed: true }), { tier: 'C3', down: null, held: true });
});

const scores = (...pairs: [string, number][]) => pairs.map(([kind, score]) => ({ kind, score }));

test('with no measured harness, Global Auto stays', () => {
  const v = decideHarness({ turns: 0, current: 'claude', scores: [], lead: null, lastSwitch: null });
  assert.equal(v.target, null);
  assert.match(v.reason, /No harness/);
});

test('the first turn moves to the best harness; the best one stays', () => {
  assert.equal(
    decideHarness({ turns: 0, current: 'claude', scores: scores(['codex', 0.6], ['claude', 0.55]), lead: null, lastSwitch: null }).target,
    'codex',
  );
  // a first-turn lead too small to tell keeps the chat where it is
  const close = decideHarness({
    turns: 0,
    current: 'claude',
    scores: scores(['codex', 0.6], ['claude', 0.59]),
    lead: null,
    lastSwitch: null,
  });
  assert.equal(close.target, null);
  assert.match(close.reason, /clearly better/);
  assert.equal(decideHarness({ turns: 3, current: 'codex', scores: scores(['codex', 0.6]), lead: null, lastSwitch: null }).target, null);
});

test('later turns need a clear lead held for two turns, outside the cooldown', () => {
  const s = scores(['codex', 0.8], ['claude', 0.5]);
  const small = decideHarness({
    turns: 5,
    current: 'claude',
    scores: scores(['codex', 0.54], ['claude', 0.5]),
    lead: null,
    lastSwitch: null,
  });
  assert.equal(small.target, null);
  assert.match(small.reason, /clear margin/);
  const once = decideHarness({ turns: 5, current: 'claude', scores: s, lead: null, lastSwitch: null });
  assert.deepEqual([once.target, once.lead], [null, { kind: 'codex', count: 1 }]);
  const twice = decideHarness({ turns: 6, current: 'claude', scores: s, lead: once.lead, lastSwitch: null });
  assert.equal(twice.target, 'codex');
  // another harness's lead starts over
  assert.deepEqual(
    decideHarness({ turns: 6, current: 'claude', scores: s, lead: { kind: 'acp:gemini', count: 1 }, lastSwitch: null }).lead,
    {
      kind: 'codex',
      count: 1,
    },
  );
  const cooling = decideHarness({ turns: 6, current: 'claude', scores: s, lead: once.lead, lastSwitch: 6 - COOLDOWN_TURNS + 1 });
  assert.equal(cooling.target, null);
  // an unmeasured current harness counts as far behind
  assert.equal(
    decideHarness({ turns: 6, current: 'acp:cline', scores: s, lead: { kind: 'codex', count: 1 }, lastSwitch: null }).target,
    'codex',
  );
});

test('repeated failures move on any lead, but not inside the cooldown', () => {
  const s = scores(['codex', 0.52], ['claude', 0.5]);
  assert.equal(decideHarness({ turns: 5, current: 'claude', scores: s, lead: null, lastSwitch: null, failures: 2 }).target, 'codex');
  assert.equal(decideHarness({ turns: 5, current: 'claude', scores: s, lead: null, lastSwitch: 4, failures: 2 }).target, null);
});
