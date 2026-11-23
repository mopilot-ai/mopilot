// Stream fragment contracts: string text only, with no coercion or changes to non-text payloads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInvalidStreamNotification, claudeTextDelta, MAX_REASONING_PARTS } from '../shared/streamDelta.mjs';

test('known display deltas require strings, including empty strings', () => {
  for (const method of [
    'item/agentMessage/delta',
    'item/plan/delta',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/textDelta',
    'item/commandExecution/outputDelta',
  ]) {
    for (const delta of [undefined, null, 42, false, [], {}]) assert.equal(isInvalidStreamNotification(method, { delta }), true);
    assert.equal(isInvalidStreamNotification(method, null), true);
    assert.equal(isInvalidStreamNotification(method, { delta: '', summaryIndex: 0, contentIndex: 0 }), false);
    assert.equal(isInvalidStreamNotification(method, { delta: 'Kept', summaryIndex: 0, contentIndex: 0 }), false);
  }
  assert.equal(isInvalidStreamNotification('custom/progress', { delta: {} }), false);
});

test('Claude SDK deltas translate strings and reject unknown or incomplete fragments', () => {
  for (const delta of [
    null,
    undefined,
    {},
    { type: 'input_json_delta', partial_json: '{}' },
    { type: 'text_delta' },
    { type: 'thinking_delta', thinking: 42 },
  ]) {
    assert.equal(claudeTextDelta(delta), null);
  }
  assert.deepEqual(claudeTextDelta({ type: 'text_delta', text: 'Kept' }), { method: 'item/agentMessage/delta', params: { delta: 'Kept' } });
  assert.deepEqual(claudeTextDelta({ type: 'thinking_delta', thinking: '' }), {
    method: 'item/reasoning/summaryTextDelta',
    params: { summaryIndex: 0, delta: '' },
  });
});

test('reasoning indices are bounded integers, with only raw content defaulting to zero', () => {
  for (const [method, field] of [
    ['item/reasoning/summaryPartAdded', 'summaryIndex'],
    ['item/reasoning/summaryTextDelta', 'summaryIndex'],
    ['item/reasoning/textDelta', 'contentIndex'],
  ]) {
    for (const index of [-1, 0.5, '0', false, [], {}, NaN, Infinity, MAX_REASONING_PARTS, 4294967295]) {
      assert.equal(isInvalidStreamNotification(method, { [field]: index, delta: 'x' }), true);
    }
    assert.equal(isInvalidStreamNotification(method, { [field]: 0, delta: 'x' }), false);
    assert.equal(isInvalidStreamNotification(method, { [field]: MAX_REASONING_PARTS - 1, delta: 'x' }), false);
    for (const index of [null, undefined]) {
      assert.equal(isInvalidStreamNotification(method, { [field]: index, delta: 'x' }), field === 'summaryIndex');
    }
  }
  assert.equal(isInvalidStreamNotification('item/reasoning/summaryPartAdded', null), true);
  assert.equal(isInvalidStreamNotification('custom/progress', { summaryIndex: -1 }), false);
});
