import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goalBarDetail } from '../src/lib/goalBarDetail.ts';
import { goalBudgetLabel } from '../src/lib/codexGoals.ts';
import { claudeGoalDetail } from '../src/lib/claudeGoals.ts';
import type { ChatGoal } from '../src/store/types';

const formatters = { codex: goalBudgetLabel, claude: claudeGoalDetail };
const goal = (status: ChatGoal['status'], claude = false): ChatGoal => ({
  threadId: 'chat-1',
  objective: 'Finish the task',
  status,
  tokenBudget: 200000,
  tokensUsed: 50000,
  timeUsedSeconds: 10,
  createdAt: 1,
  updatedAt: 2,
  ...(claude ? { claude: { iterations: 30, limit: 30, lastReason: 'Work remains' } } : {}),
});

test('routine goal states hide budget and round details for both harnesses', () => {
  for (const status of ['active', 'paused', 'blocked', 'usageLimited', 'complete', 'stopped'] as const) {
    for (const claude of [false, true]) {
      const g = goal(status, claude);
      const before = structuredClone(g);
      assert.equal(
        goalBarDetail(g, {
          codex: () => assert.fail('Routine states must not format budget details'),
          claude: () => assert.fail('Routine states must not format round details'),
        }),
        null,
      );
      assert.deepEqual(g, before);
    }
  }
});

test('Codex stopped at its budget explains the existing limit without changing it', () => {
  const g = goal('budgetLimited');
  const before = structuredClone(g);
  assert.equal(goalBarDetail(g, formatters), '200k token budget (soft, checked between turns) · 50k used');
  assert.deepEqual(g, before);
});

test('CC stopped at its round limit explains why it paused', () => {
  assert.equal(goalBarDetail(goal('budgetLimited', true), formatters), 'Reached the limit (30 rounds). Goal paused · Limit set by MoPilot');
});

test('a Codex budget-limited snapshot missing its budget has no fabricated detail', () => {
  assert.equal(goalBarDetail({ ...goal('budgetLimited'), tokenBudget: null }, formatters), null);
});
