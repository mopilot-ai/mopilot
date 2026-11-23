// shared/chatSignals.mjs: what a rejected Claude request and used-up Codex windows say of the limit a chat stopped on (window, and the reset still to come).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeLimitReached, codexLimitReached } from '../shared/chatSignals.mjs';

const now = 1_000_000;

test('a rejected Claude Code request names its window and the reset still to come; any other status is no limit', () => {
  assert.equal(claudeLimitReached({ status: 'allowed_warning', rateLimitType: 'five_hour' }, now), null);
  assert.equal(claudeLimitReached(undefined, now), null);
  assert.deepEqual(claudeLimitReached({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 2000 }, now), {
    window: '5h',
    resetsAt: 2_000_000,
  });
  assert.deepEqual(claudeLimitReached({ status: 'rejected', rateLimitType: 'five_hour', resetsAt: 1 }, now), {
    window: '5h',
    resetsAt: null,
  });
  assert.deepEqual(claudeLimitReached({ status: 'rejected', rateLimitType: 'five_hour' }, now), { window: '5h', resetsAt: null });
  // extra usage has no window words, so no reset either
  assert.deepEqual(claudeLimitReached({ status: 'rejected', rateLimitType: 'overage', resetsAt: 2000 }, now), {
    window: null,
    resetsAt: null,
  });
});

test('Codex windows used up name the window that frees the chat last; none used up is no limit', () => {
  assert.equal(codexLimitReached(null, now), null);
  assert.equal(codexLimitReached({ primary: { usedPercent: 99, resetsAt: 2000 } }, now), null);
  assert.equal(codexLimitReached({ primary: { resetsAt: 2000 } }, now), null);
  const primary = { usedPercent: 100, windowDurationMins: 300, resetsAt: 2000 };
  assert.deepEqual(codexLimitReached({ primary }, now), { window: '5h', resetsAt: 2_000_000 });
  // both used up: the chat runs again only when the later one resets, whichever slot it is in
  const secondary = { usedPercent: 100, windowDurationMins: 10080, resetsAt: 5000 };
  assert.deepEqual(codexLimitReached({ primary, secondary }, now), { window: '7d', resetsAt: 5_000_000 });
  assert.deepEqual(codexLimitReached({ primary: secondary, secondary: primary }, now), { window: '7d', resetsAt: 5_000_000 });
  // a reset already past is not named; a window that is no plan window has none
  assert.deepEqual(codexLimitReached({ primary: { ...primary, resetsAt: 1 } }, now), { window: '5h', resetsAt: null });
  assert.deepEqual(codexLimitReached({ primary: { usedPercent: 100, windowDurationMins: 1000 } }, now), { window: null, resetsAt: null });
  // both used up with no reset still to come: the first stands
  const past = { usedPercent: 100, windowDurationMins: 300, resetsAt: 1 };
  assert.deepEqual(codexLimitReached({ primary: past, secondary: { ...past, windowDurationMins: 10080 } }, now), {
    window: '5h',
    resetsAt: null,
  });
  // a later window that names a reset beats an earlier one that names none
  assert.deepEqual(codexLimitReached({ primary: past, secondary }, now), { window: '7d', resetsAt: 5_000_000 });
});
