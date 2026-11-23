// UTF-16-bounded cuts that never split a surrogate pair (prefixUnits and suffixUnits in shared/textPrefix.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prefixUnits, suffixUnits, wellFormedText } from '../shared/textPrefix.mjs';
import { promptTitle } from '../src/lib/agentRun.ts';

/** No lone surrogate (String#isWellFormed, which the TypeScript lib here does not know). */
const wellFormed = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

test('a cut never ends or starts with half of an emoji', () => {
  assert.ok(wellFormed(prefixUnits(`${'x'.repeat(1999)}🙂`, 2000)));
  assert.equal(wellFormed('a\uD83D'), false);
  assert.equal(prefixUnits('ab🙂cd', 3), 'ab', 'the pair would be split: drop its first half');
  assert.equal(prefixUnits('ab🙂cd', 4), 'ab🙂');
  assert.equal(prefixUnits('abc', 10), 'abc');
  assert.equal(prefixUnits('abc', 0), '');
  assert.equal(prefixUnits('abc', -1), '');
  assert.equal(suffixUnits('ab🙂cd', 3), 'cd', 'the pair would be split: drop its second half');
  assert.equal(suffixUnits('ab🙂cd', 4), '🙂cd');
  assert.equal(suffixUnits('abc', 10), 'abc');
  assert.equal(suffixUnits('abc', 0), '');
  assert.equal(suffixUnits('abc', -2), '');
});

test('previews cut before an emoji rather than through it', () => {
  // an agent's prompt as its run's title: 78 characters, then an emoji across the cut
  assert.equal(promptTitle(`${'x'.repeat(78)}🙂 more`), `${'x'.repeat(78)}…`);
});

test('wellFormedText replaces only unpaired halves, keeping whole emoji', () => {
  assert.equal(wellFormedText('a\uD83D'), 'a\uFFFD');
  assert.equal(wellFormedText('\uDE42b'), '\uFFFDb');
  assert.equal(wellFormedText('🙂 ok'), '🙂 ok');
  assert.ok(wellFormed(wellFormedText(`${'x'.repeat(49999)}🙂`.slice(0, 50000))));
});
