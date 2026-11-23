import { test } from 'node:test';
import assert from 'node:assert/strict';
import { retryAfterModelProgress } from '../src/lib/modelRetry.ts';

const runtime = { retry: 'Reconnecting… 5/5', activeTurnId: 'turn1' };

test('resumed model deltas clear the retry banner before the turn completes', () => {
  for (const method of [
    'item/agentMessage/delta',
    'item/plan/delta',
    'item/reasoning/summaryPartAdded',
    'item/reasoning/summaryTextDelta',
    'item/reasoning/textDelta',
  ]) {
    assert.equal(retryAfterModelProgress(runtime, method, { turnId: 'turn1' }), null, method);
  }
});

test('new model messages, reasoning, and plans also prove stream recovery', () => {
  for (const type of ['agentMessage', 'reasoning', 'plan']) {
    assert.equal(retryAfterModelProgress(runtime, 'item/started', { turnId: 'turn1', item: { type } }), null);
  }
});

test('tool output and user steering retain the model retry indicator', () => {
  for (const method of ['item/commandExecution/outputDelta', 'item/mcpToolCall/progress', 'item/completed', 'thread/tokenUsage/updated']) {
    assert.equal(retryAfterModelProgress(runtime, method, { turnId: 'turn1' }), runtime.retry);
  }
  for (const type of ['userMessage', 'commandExecution', 'mcpToolCall']) {
    assert.equal(retryAfterModelProgress(runtime, 'item/started', { turnId: 'turn1', item: { type } }), runtime.retry);
  }
});

test('late events from another turn or without turn identity cannot clear the active retry', () => {
  for (const params of [{ turnId: 'old-turn' }, {}]) {
    assert.equal(retryAfterModelProgress(runtime, 'item/agentMessage/delta', params), runtime.retry);
  }
  assert.equal(retryAfterModelProgress({ ...runtime, activeTurnId: null }, 'item/agentMessage/delta', {}), runtime.retry);
});

test('normal streaming leaves an already cleared retry unchanged', () => {
  assert.equal(retryAfterModelProgress({ ...runtime, retry: null }, 'item/agentMessage/delta', { turnId: 'turn1' }), null);
});

test('incomplete item-start notifications cannot prove model recovery', () => {
  for (const params of [{ turnId: 'turn1' }, { turnId: 'turn1', item: {} }]) {
    assert.equal(retryAfterModelProgress(runtime, 'item/started', params), runtime.retry);
  }
});
