// What the owner says in words and the notes core keeps out of the notes becomes a suggested rule that waits for a tap: the same order is one suggestion however it is written, no more than twenty wait at once, and one the owner turned down can be suggested again.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SUGGESTED_MAX, declineRule, emptyLearning, suggestRule, undoRule } from '../shared/momoCore/learning.ts';

const deps = () => {
  let n = 0;
  return { newId: () => `r${++n}`, now: () => 5 };
};
const order = (text: string) => ({ text, sourceId: 'm1', quote: text });

test('the same order again, written another way, is one suggestion', () => {
  const d = deps();
  let state = suggestRule(emptyLearning(), order('Always send invoices to accounting@example.com'), d).state;
  for (const again of ['always  send invoices to ACCOUNTING@example.com', 'Always send invoices to accounting@example.com.']) {
    const next = suggestRule(state, order(again), d);
    if (again.endsWith('.')) assert.equal(next.rule?.status, 'suggested', 'a different ending is a different order');
    else assert.equal(next.rule, undefined);
    state = next.state;
  }
});

test('no more than twenty wait for a tap, and one the owner declined is not suggested again, while one they undid can be', () => {
  const d = deps();
  let state = emptyLearning();
  for (let i = 0; i < SUGGESTED_MAX; i++) state = suggestRule(state, order(`Always do thing number ${i} for me`), d).state;
  assert.equal(state.rules.length, SUGGESTED_MAX);
  assert.equal(suggestRule(state, order('Always do one more thing for me'), d).rule, undefined);
  state = declineRule(state, 'r1', 9);
  const again = suggestRule(state, order('Always do thing number 0 for me'), d);
  assert.equal(again.rule, undefined, 'a turned-down order is not asked about again');
  assert.equal(suggestRule(state, order('Always do thing number 21 for me'), d).rule?.status, 'suggested', 'its place is free for another');
  const undone = undoRule(state, 'r2', 9);
  assert.equal(
    suggestRule(undone, order('Always do thing number 1 for me'), d).rule?.status,
    'suggested',
    'an undone one can be suggested again',
  );
});
