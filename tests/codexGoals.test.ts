// Codex goal commands and the requests Sage sends for them (see src/lib/codexGoals.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canResumeGoal,
  goalBudgetLabel,
  goalBudgetPlan,
  parseTokenBudget,
  goalClearPlan,
  goalEditPlan,
  goalErrorMessage,
  goalPausePlan,
  goalResumePlan,
  parseGoalCommand,
} from '../src/lib/codexGoals.ts';

const goal = (status: any, tokenBudget: number | null = null) => ({
  threadId: 'thr_1',
  objective: 'Make the tests pass',
  status,
  tokenBudget,
  tokensUsed: 1500,
  timeUsedSeconds: 3,
  createdAt: 0,
  updatedAt: 0,
});

test('/goal parsing: bare shows, clear clears, anything else sets', () => {
  assert.deepEqual(parseGoalCommand(''), { kind: 'show' });
  assert.deepEqual(parseGoalCommand('   '), { kind: 'show' });
  assert.deepEqual(parseGoalCommand('clear'), { kind: 'clear' });
  assert.deepEqual(parseGoalCommand(' Clear '), { kind: 'clear' });
  assert.deepEqual(parseGoalCommand('clear the cache'), { kind: 'set', objective: 'clear the cache' });
  // an edit over several lines is still an edit, kept whole; a budget with a line after it is an objective
  assert.deepEqual(parseGoalCommand('edit Ship the fix\n- with tests\n- and docs'), {
    kind: 'edit',
    objective: 'Ship the fix\n- with tests\n- and docs',
  });
  assert.deepEqual(parseGoalCommand('edit\nShip it'), { kind: 'edit', objective: 'Ship it' });
  assert.deepEqual(parseGoalCommand('budget 200k\nthen more'), { kind: 'set', objective: 'budget 200k\nthen more' });
  assert.deepEqual(parseGoalCommand('  ship it '), { kind: 'set', objective: 'ship it' });
});

test('pause sets paused first, then interrupts the running turn', () => {
  assert.deepEqual(
    goalPausePlan('thr_1', goal('active'), 'turn_9').map((r) => [r.method, r.params]),
    [
      ['thread/goal/set', { threadId: 'thr_1', status: 'paused' }],
      ['turn/interrupt', { threadId: 'thr_1', turnId: 'turn_9' }],
    ],
  );
});

test('stop without an active goal only interrupts; idle pause only pauses', () => {
  assert.deepEqual(
    goalPausePlan('thr_1', null, 'turn_9').map((r) => r.method),
    ['turn/interrupt'],
  );
  assert.deepEqual(
    goalPausePlan('thr_1', goal('paused'), 'turn_9').map((r) => r.method),
    ['turn/interrupt'],
  );
  assert.deepEqual(
    goalPausePlan('thr_1', goal('active'), null).map((r) => r.method),
    ['thread/goal/set'],
  );
  assert.deepEqual(
    goalPausePlan('thr_1', goal('active'), 'pending-x').map((r) => r.method),
    ['thread/goal/set'],
  );
});

test('only stopped goals resume; a complete goal would run again', () => {
  for (const s of ['paused', 'blocked', 'usageLimited', 'budgetLimited']) {
    assert.equal(canResumeGoal(goal(s)), true, s);
    assert.deepEqual(goalResumePlan('thr_1', goal(s)), [{ method: 'thread/goal/set', params: { threadId: 'thr_1', status: 'active' } }]);
  }
  for (const s of ['active', 'complete']) {
    assert.equal(canResumeGoal(goal(s)), false, s);
    assert.deepEqual(goalResumePlan('thr_1', goal(s)), []);
  }
  assert.deepEqual(goalResumePlan('thr_1', null), []);
});

test('clear sends goal/clear only when there is a goal', () => {
  assert.deepEqual(goalClearPlan('thr_1', goal('complete')), [{ method: 'thread/goal/clear', params: { threadId: 'thr_1' } }]);
  assert.deepEqual(goalClearPlan('thr_1', null), []);
});

test('errors: goals turned off, temporary chats', () => {
  assert.equal(
    goalErrorMessage({ code: -32600, message: 'goals feature is disabled' }),
    'Goals are turned off in Codex settings: set features.goals = true in config.toml (Settings → Codex → Advanced)',
  );
  assert.equal(
    goalErrorMessage({ code: -32600, message: 'ephemeral thread does not support goals: thr_1' }),
    "Temporary chats can't have goals",
  );
  assert.equal(goalErrorMessage(new Error('boom')), 'boom');
});

test('the budget is labelled as approximate', () => {
  assert.equal(goalBudgetLabel(goal('active')), null);
  assert.equal(goalBudgetLabel(goal('active', 20000)), '20k token budget (soft, checked between turns) · 2k used');
  // just under a million rounds up to 1M, not 1000k
  assert.equal(
    goalBudgetLabel({ ...goal('active', 999_600), tokensUsed: 2_500_000 }),
    '1M token budget (soft, checked between turns) · 2.5M used',
  );
});

test('/goal budget: a token count, or none; other text stays an objective', () => {
  assert.deepEqual(parseGoalCommand('budget 200k'), { kind: 'budget', tokens: 200000 });
  assert.deepEqual(parseGoalCommand('budget 1.5m'), { kind: 'budget', tokens: 1500000 });
  assert.deepEqual(parseGoalCommand('budget none'), { kind: 'budget', tokens: null });
  assert.deepEqual(parseGoalCommand('budget the Q3 numbers'), { kind: 'set', objective: 'budget the Q3 numbers' });
  assert.deepEqual(parseGoalCommand('budget'), { kind: 'set', objective: 'budget' });
  assert.equal(parseTokenBudget('50,000 tokens'), 50000);
  assert.equal(parseTokenBudget(''), null);
  assert.equal(parseTokenBudget('lots'), undefined);
  assert.equal(parseTokenBudget('0'), undefined);
});

test('the budget request touches only the budget, and only when there is a goal', () => {
  assert.deepEqual(goalBudgetPlan('thr_1', goal('paused'), 300000), [
    { method: 'thread/goal/set', params: { threadId: 'thr_1', tokenBudget: 300000 } },
  ]);
  assert.deepEqual(goalBudgetPlan('thr_1', goal('active', 1000), null), [
    { method: 'thread/goal/set', params: { threadId: 'thr_1', tokenBudget: null } },
  ]);
  assert.deepEqual(goalBudgetPlan('thr_1', null, 1000), []);
});

test('pause, resume and edit are commands; a lone or unrelated word is still an objective', () => {
  assert.deepEqual(parseGoalCommand('pause'), { kind: 'pause' });
  assert.deepEqual(parseGoalCommand(' Resume '), { kind: 'resume' });
  assert.deepEqual(parseGoalCommand('edit ship the beta'), { kind: 'edit', objective: 'ship the beta' });
  assert.deepEqual(parseGoalCommand('edit'), { kind: 'set', objective: 'edit' });
  assert.deepEqual(parseGoalCommand('pause the deploy'), { kind: 'set', objective: 'pause the deploy' });
  assert.deepEqual(parseGoalCommand('resume work on x'), { kind: 'set', objective: 'resume work on x' });
});

test('the edit request changes only the objective, and only when there is a goal', () => {
  assert.deepEqual(goalEditPlan('thr_1', goal('paused'), ' new aim '), [
    { method: 'thread/goal/set', params: { threadId: 'thr_1', objective: 'new aim' } },
  ]);
  assert.deepEqual(goalEditPlan('thr_1', null, 'new aim'), []);
  assert.deepEqual(goalEditPlan('thr_1', goal('active'), '  '), []);
});

test('the plans and the words are shared/codexGoals.mjs, which a Host runs too: this module re-exports them, and the refusals read the same everywhere', async () => {
  const shared = await import('../shared/codexGoals.mjs');
  const here = await import('../src/lib/codexGoals.ts');
  for (const name of ['goalPausePlan', 'goalResumePlan', 'goalEditPlan', 'goalBudgetPlan', 'goalClearPlan', 'canResumeGoal'] as const)
    assert.equal(here[name], shared[name], name);
  assert.match(shared.goalErrorWords('The goals feature is disabled'), /features\.goals = true/);
  assert.equal(shared.goalErrorWords('Cannot set a goal on an ephemeral thread'), "Temporary chats can't have goals");
  assert.equal(shared.goalErrorWords('boom'), 'boom');
  assert.equal(here.goalErrorMessage(new Error('boom')), 'boom');
  assert.equal(shared.unsupportedGoalWords('Codex', 'extend'), "Codex can't add rounds to this goal. Clear it and set a new one.");
  assert.equal(shared.unsupportedGoalWords('Claude Code', 'budget'), "Claude Code can't budget this goal. Clear it and set a new one.");
  assert.equal(shared.unsupportedGoalWords('Claude Code', 'edit'), "Claude Code can't edit this goal. Clear it and set a new one.");
  // the app's refusal of a goal action an agent has no form of says the same, from the first word of the request
  const { unsupportedGoal } = await import('../src/harness/adapters/semantics.ts');
  assert.throws(() => unsupportedGoal('Codex', 'extend'), { message: shared.unsupportedGoalWords('Codex', 'extend') });
  assert.throws(() => unsupportedGoal('Claude Code', 'budget 5k'), { message: shared.unsupportedGoalWords('Claude Code', 'budget') });
  assert.throws(() => unsupportedGoal('Claude Code', 'edit x y'), { message: shared.unsupportedGoalWords('Claude Code', 'edit') });
});
