// Unicode prefix limits are bounded by code points without altering the original text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefixCodePoints } from '../shared/textPrefix.mjs';

test('prefixes preserve astral characters and use a code-point budget', () => {
  for (const [input, max, expected] of [
    ['a🙂b', 2, 'a🙂'],
    ['🙂🙂', 1, '🙂'],
    ['𝄞abc', 2, '𝄞a'],
    ['abc', 20, 'abc'],
    ['', 2, ''],
    ['abc', 0, ''],
    ['abc', -2, ''],
    ['abc', NaN, ''],
    ['abc', 1.9, 'a'],
    ['abc', Infinity, 'abc'],
  ] as const) {
    assert.equal(prefixCodePoints(input, max), expected);
    assert.doesNotThrow(() => encodeURIComponent(prefixCodePoints(input, max)));
  }
  assert.equal(prefixCodePoints('x'.repeat(1_000_000), 3), 'xxx');
});
