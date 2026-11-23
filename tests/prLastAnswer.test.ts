// src/lib/prLastAnswer.ts: a PR's failed read, or one whose merge-gate words couldn't be read, keeps the last full
// answer, so the inbox's row never blinks to "Status unavailable" on a rate limit or a dropped connection.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastGood } from '../src/lib/prLastAnswer.ts';

const url = 'https://github.com/o/r/pull/7';
const pr = (d: any = {}) => ({
  url,
  number: 7,
  state: 'open' as const,
  details: { checks: 'passing' as const, mergeable: 'MERGEABLE' as const, mergeState: 'CLEAN', ...d },
});

test('a failed read, or one whose gate words could not be read, keeps the last full answer', () => {
  const good = new Map();
  const unknown = { url, number: 7, state: 'unknown' as const };
  // nothing known yet: the failed answer is all there is
  assert.equal(lastGood(url, unknown, good), unknown);
  assert.equal(lastGood(url, null, good), null);
  const full = pr();
  assert.equal(lastGood(url, full, good), full);
  assert.equal(lastGood(url, unknown, good), full);
  assert.equal(lastGood(url, pr({ gateUnread: true }), good), full);
  const next = pr({ checks: 'pending' });
  assert.equal(lastGood(url, next, good), next);
  assert.equal(good.get(url), next);
});
