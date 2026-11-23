// Claude Code goals as Sage tracks them (src/lib/claudeGoals.ts and the parser, reducer and plans it re-exports from
// shared/claudeGoals.mjs). Messages are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { defined } from './support/defined.ts';
import {
  CLAUDE_GOAL_ROUND_LIMIT,
  CLAUDE_GOAL_EXTRA_ROUNDS,
  canExtendClaudeGoal,
  claudeGoalExtended,
  canResumeClaudeGoal,
  claudeGoalAfterTurn,
  claudeGoalClearPlan,
  claudeGoalDetail,
  claudeGoalNote,
  claudeGoalOverLimit,
  claudeGoalPausePlan,
  claudeGoalResumePlan,
  claudeGoalRoundLimit,
  claudeGoalStatusText,
  claudeLocalOutput,
  lastGoalStatus,
  parseClaudeGoalMessage,
  reduceClaudeGoal,
} from '../src/lib/claudeGoals.ts';

const COND = 'all tests pass';
const ctx = { chatId: 'claude:s1', limit: null, now: 100 };
const assistant = (text: string) => ({
  type: 'assistant',
  parent_tool_use_id: null,
  message: { model: '<synthetic>', content: [{ type: 'text', text }] },
});
const feedback = (reason: string) => ({
  type: 'user',
  isSynthetic: true,
  parent_tool_use_id: null,
  message: { role: 'user', content: [{ type: 'text', text: `Stop hook feedback:\n[${COND}]: ${reason}` }] },
});
const local = (content: unknown) => ({ type: 'system', subtype: 'local_command_output', content });
const goal = (status: any, iterations = 0, limit: number | null = null) => ({
  threadId: 'claude:s1',
  objective: COND,
  status,
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 0,
  updatedAt: 0,
  claude: { iterations, lastReason: null, limit },
});

test('parse: Goal set, each unmet check, and /goal output', () => {
  assert.deepEqual(parseClaudeGoalMessage(assistant(`Goal set: ${COND}`)), { kind: 'set', condition: COND });
  assert.deepEqual(parseClaudeGoalMessage(feedback('2 tests still fail')), {
    kind: 'check',
    condition: COND,
    reason: '2 tests still fail',
  });
  // string content, as a transcript may store it
  assert.deepEqual(parseClaudeGoalMessage({ type: 'user', message: { content: `Stop hook feedback:\n[a [b] c]: not yet` } }), {
    kind: 'check',
    condition: 'a [b] c',
    reason: 'not yet',
  });
  assert.deepEqual(parseClaudeGoalMessage(local(`Goal active: ${COND}…`)), { kind: 'active', condition: COND });
  assert.deepEqual(parseClaudeGoalMessage(local(`Goal cleared: ${COND}`)), { kind: 'cleared' });
  assert.deepEqual(parseClaudeGoalMessage(local('No goal set')), { kind: 'none' });
  assert.deepEqual(
    parseClaudeGoalMessage({ type: 'user', message: { content: '<local-command-stdout>No goal set</local-command-stdout>' } }),
    { kind: 'none' },
  );
});

test('parse: ordinary messages say nothing about goals', () => {
  assert.equal(parseClaudeGoalMessage(assistant('The goal set: here is what I did')), null);
  assert.equal(parseClaudeGoalMessage({ ...assistant(`Goal set: ${COND}`), parent_tool_use_id: 'toolu_1' }), null);
  assert.equal(parseClaudeGoalMessage({ type: 'user', message: { content: 'Stop hook feedback is weird' } }), null);
  assert.equal(parseClaudeGoalMessage(local('Current session: 12% used')), null);
  assert.equal(parseClaudeGoalMessage({ type: 'result', subtype: 'success' }), null);
});

test('notes: checks show the reason, /goal output shows as printed', () => {
  assert.equal(claudeGoalNote({ kind: 'set', condition: COND }), `Goal set: ${COND}`);
  assert.equal(claudeGoalNote({ kind: 'check', condition: COND, reason: 'not yet' }), 'Goal not met yet: not yet');
  assert.equal(claudeGoalNote({ kind: 'cleared' }, `Goal cleared: ${COND}\n`), `Goal cleared: ${COND}`);
  assert.equal(claudeGoalNote({ kind: 'none' }), 'No goal set');
});

test('snapshot: set starts at 0 rounds, each check adds one with its reason', () => {
  let g = reduceClaudeGoal(undefined, { kind: 'set', condition: COND }, { ...ctx, limit: 30 });
  assert.equal(g?.status, 'active');
  assert.equal(g?.objective, COND);
  assert.deepEqual(g?.claude, { iterations: 0, lastReason: null, limit: 30 });
  g = reduceClaudeGoal(g, { kind: 'check', condition: COND, reason: 'one' }, ctx);
  g = reduceClaudeGoal(g, { kind: 'check', condition: COND, reason: 'two' }, ctx);
  assert.deepEqual(g?.claude, { iterations: 2, lastReason: 'two', limit: 30 });
  // a check for a goal Sage didn't see set still shows it
  assert.equal(reduceClaudeGoal(null, { kind: 'check', condition: COND, reason: 'x' }, ctx)?.claude?.iterations, 1);
});

test('snapshot: rounds that land while Sage pauses, and the CLI clearing, leave a held goal alone', () => {
  assert.equal(reduceClaudeGoal(goal('paused', 3), { kind: 'check', condition: COND, reason: 'late' }, ctx), undefined);
  assert.equal(reduceClaudeGoal(goal('paused', 3), { kind: 'cleared' }, ctx), undefined);
  assert.equal(reduceClaudeGoal(goal('budgetLimited', 30), { kind: 'none' }, ctx), undefined);
  assert.equal(reduceClaudeGoal(goal('paused'), { kind: 'active', condition: COND }, ctx), undefined);
  // a goal the CLI no longer has is gone
  assert.equal(reduceClaudeGoal(goal('active', 1), { kind: 'cleared' }, ctx), null);
  assert.equal(reduceClaudeGoal(goal('stopped', 1), { kind: 'none' }, ctx), null);
  assert.equal(reduceClaudeGoal(null, { kind: 'none' }, ctx), undefined);
  // bare /goal reports one Sage didn't know of
  assert.equal(reduceClaudeGoal(null, { kind: 'active', condition: COND }, ctx)?.status, 'active');
  assert.equal(reduceClaudeGoal(goal('active', 2), { kind: 'active', condition: COND }, ctx), undefined);
});

test('turn end: complete when the last check was met, stopped otherwise', () => {
  assert.equal(claudeGoalAfterTurn(goal('active', 2), { met: true, condition: COND, reason: 'all green' }, 1)?.status, 'complete');
  assert.equal(
    claudeGoalAfterTurn(goal('active', 2), { met: true, condition: COND, reason: 'all green' }, 1)?.claude?.lastReason,
    'all green',
  );
  assert.equal(claudeGoalAfterTurn(goal('active', 2), { met: false, condition: COND }, 1)?.status, 'stopped');
  assert.equal(claudeGoalAfterTurn(goal('active', 2), { met: true, condition: 'another goal' }, 1)?.status, 'stopped');
  assert.equal(claudeGoalAfterTurn(goal('active', 2), null, 1)?.status, 'stopped');
  assert.equal(claudeGoalAfterTurn(goal('paused', 2), null, 1), undefined);
  assert.equal(claudeGoalAfterTurn(null, { met: true }, 1), undefined);
});

test('transcript: the newest goal_status record wins', () => {
  const rec = (met: boolean, reason: string) =>
    JSON.stringify({ type: 'attachment', attachment: { type: 'goal_status', met, condition: COND, reason } });
  assert.deepEqual(lastGoalStatus([rec(false, 'a'), 'not json goal_status', rec(true, 'b'), ''].join('\n')), {
    met: true,
    condition: COND,
    reason: 'b',
  });
  assert.equal(lastGoalStatus(''), null);
});

test('round limit: off for subscriptions, paused once reached', () => {
  assert.equal(claudeGoalRoundLimit(false), null);
  assert.equal(claudeGoalRoundLimit(true), CLAUDE_GOAL_ROUND_LIMIT);
  assert.equal(CLAUDE_GOAL_ROUND_LIMIT, 30);
  assert.equal(claudeGoalOverLimit(goal('active', 29, 30)), false);
  assert.equal(claudeGoalOverLimit(goal('active', 30, 30)), true);
  assert.equal(claudeGoalOverLimit(goal('active', 500, null)), false);
  assert.equal(claudeGoalOverLimit(goal('paused', 30, 30)), false);
});

test('pause: stop the loop first, then clear the CLI goal', () => {
  assert.deepEqual(claudeGoalPausePlan(goal('active'), true), [{ kind: 'interrupt' }, { kind: 'send', text: '/goal clear' }]);
  assert.deepEqual(claudeGoalPausePlan(goal('active'), false), [{ kind: 'send', text: '/goal clear' }]);
  assert.deepEqual(claudeGoalPausePlan(goal('paused'), true), []);
  assert.deepEqual(claudeGoalPausePlan(null, true), []);
});

test('resume: send the condition again, only for goals that stopped short', () => {
  assert.deepEqual(claudeGoalResumePlan(goal('paused')), [{ kind: 'send', text: `/goal ${COND}` }]);
  assert.deepEqual(claudeGoalResumePlan(goal('budgetLimited')), [{ kind: 'send', text: `/goal ${COND}` }]);
  assert.deepEqual(claudeGoalResumePlan(goal('stopped')), [{ kind: 'send', text: `/goal ${COND}` }]);
  assert.deepEqual(claudeGoalResumePlan(goal('complete')), []);
  assert.deepEqual(claudeGoalResumePlan(goal('active')), []);
  assert.equal(canResumeClaudeGoal(goal('complete')), false);
  assert.equal(canResumeClaudeGoal(undefined), false);
});

test('clear: interrupt a running loop, send /goal clear only where the CLI still has a goal', () => {
  assert.deepEqual(claudeGoalClearPlan(goal('active'), true), [{ kind: 'interrupt' }, { kind: 'send', text: '/goal clear' }]);
  assert.deepEqual(claudeGoalClearPlan(goal('active'), false), [{ kind: 'send', text: '/goal clear' }]);
  assert.deepEqual(claudeGoalClearPlan(goal('stopped'), false), [{ kind: 'send', text: '/goal clear' }]);
  assert.deepEqual(claudeGoalClearPlan(goal('paused'), true), []);
  assert.deepEqual(claudeGoalClearPlan(goal('complete'), false), []);
  // one Sage doesn't know of may still be set in the CLI
  assert.deepEqual(claudeGoalClearPlan(null, false), [{ kind: 'send', text: '/goal clear' }]);
});

test('goal bar text: rounds, and who holds a paused goal', () => {
  assert.equal(claudeGoalStatusText(goal('active')), 'Active');
  assert.equal(claudeGoalStatusText(goal('budgetLimited')), 'Paused');
  assert.equal(claudeGoalStatusText(goal('stopped')), 'Stopped');
  assert.equal(claudeGoalDetail(goal('active', 1)), '1 round');
  assert.equal(claudeGoalDetail(goal('active', 2, 30)), '2 / 30 rounds');
  assert.equal(claudeGoalDetail(goal('complete', 2)), '2 rounds');
  assert.equal(claudeGoalDetail(goal('paused', 4)), 'Goal paused (kept by MoPilot) · Round count restarts when resumed');
  assert.equal(claudeGoalDetail(goal('budgetLimited', 30, 30)), 'Reached the limit (30 rounds). Goal paused · Limit set by MoPilot');
});

test('10 more rounds: only a goal paused at the limit, restarted with a fresh limit that the CLI answer keeps', () => {
  assert.equal(canExtendClaudeGoal(goal('budgetLimited', 30, 30)), true);
  assert.equal(canExtendClaudeGoal(goal('paused', 3, 30)), false);
  assert.equal(canExtendClaudeGoal(goal('active', 3, 30)), false);
  const g = claudeGoalExtended(goal('budgetLimited', 30, 30), 200);
  assert.deepEqual([g.status, g.claude?.iterations, g.claude?.limit], ['active', 0, CLAUDE_GOAL_EXTRA_ROUNDS]);
  assert.deepEqual(claudeGoalResumePlan(goal('budgetLimited', 30, 30)), [{ kind: 'send', text: `/goal ${COND}` }]);
  // "Goal set" from the CLI restarts the goal; the limit Sage just gave it stays
  const set = reduceClaudeGoal(g, { kind: 'set', condition: COND }, { ...ctx, limit: 30 });
  assert.equal(set?.claude?.limit, CLAUDE_GOAL_EXTRA_ROUNDS);
  // a different condition is a new goal on the default limit
  assert.equal(reduceClaudeGoal(g, { kind: 'set', condition: 'other' }, { ...ctx, limit: 30 })?.claude?.limit, 30);
});

test('resume after a crash: clear the CLI goal first, then set it', () => {
  assert.deepEqual(claudeGoalResumePlan(goal('paused'), true), [
    { kind: 'send', text: '/goal clear' },
    { kind: 'send', text: `/goal ${COND}` },
  ]);
  assert.deepEqual(claudeGoalResumePlan(goal('complete'), true), []);
  assert.deepEqual(claudeGoalResumePlan(null, true), []);
});

test('goal attachments follow decoded JSON type spelling', () => {
  const old = JSON.stringify({ type: 'attachment', attachment: { type: 'goal_status', met: false } });
  const latest = String.raw`{"type":"attachment","attachment":{"type":"goal\u005fstatus","met":true,"condition":"work"}}`;
  assert.deepEqual(lastGoalStatus(old + '\n' + latest), { met: true, condition: 'work', reason: undefined });
});

test('goal attachments discard malformed optional metadata strings', () => {
  const row = { type: 'attachment', attachment: { type: 'goal_status', met: true, condition: 42, reason: {} } };
  const status = lastGoalStatus(JSON.stringify(row));
  assert.deepEqual(status, { met: false, condition: undefined, reason: undefined });
  assert.equal(claudeGoalAfterTurn(goal('active'), status, 1)?.status, 'stopped');
});

test('goal completion preserves legacy truthy results and requires a valid optional condition', () => {
  for (const condition of [undefined, null, COND]) {
    const row = { type: 'attachment', attachment: { type: 'goal_status', met: true, condition } };
    assert.equal(lastGoalStatus(JSON.stringify(row))?.met, true);
  }
  assert.equal(lastGoalStatus(JSON.stringify({ attachment: { type: 'goal_status', met: 1 } }))?.met, true);
  for (const met of [false, 0, null]) {
    const row = { type: 'attachment', attachment: { type: 'goal_status', met, condition: COND } };
    assert.equal(lastGoalStatus(JSON.stringify(row))?.met, false);
  }
});

test('non-string text fields cannot invent goal commands', () => {
  assert.equal(parseClaudeGoalMessage({ type: 'assistant', message: { content: [{ type: 'text', text: ['Goal set: Fake'] }] } }), null);
  const content = [
    { type: 'text', text: 42 },
    { type: 'text', text: 'Goal set: Real' },
  ];
  assert.deepEqual(parseClaudeGoalMessage({ type: 'assistant', message: { content } }), { kind: 'set', condition: 'Real' });
});

// raw records in the other shapes a transcript or the CLI stream may hold
const sctx = { chatId: 'c1', limit: 30, now: 100 };
const assistantWith = (content: unknown) => ({ type: 'assistant', message: { content } });
const userWith = (content: unknown) => ({ type: 'user', message: { content } });

test('local command output comes from system messages or tagged user records', () => {
  assert.equal(claudeLocalOutput(local('Goal cleared')), 'Goal cleared');
  assert.equal(claudeLocalOutput(local(undefined)), '');
  assert.equal(claudeLocalOutput(userWith('<local-command-stdout>No goal set</local-command-stdout>')), 'No goal set');
  assert.equal(
    claudeLocalOutput(userWith([{ type: 'text', text: ' <local-command-stdout>x</local-command-stdout>' }, { type: 'text' }, null])),
    'x',
  );
  assert.equal(claudeLocalOutput(userWith('plain')), null);
  assert.equal(claudeLocalOutput({ type: 'user' }), null);
  assert.equal(claudeLocalOutput(null), null);
});

test('goal messages parse into set, active, cleared, none and check events', () => {
  assert.equal(parseClaudeGoalMessage(null), null);
  assert.equal(parseClaudeGoalMessage({ ...assistantWith('Goal set: x'), parent_tool_use_id: 't' }), null);
  assert.deepEqual(parseClaudeGoalMessage(assistantWith([{ type: 'text', text: 'Goal set: tests pass\n' }])), {
    kind: 'set',
    condition: 'tests pass',
  });
  assert.equal(parseClaudeGoalMessage(assistantWith('hello')), null);
  assert.equal(parseClaudeGoalMessage({ type: 'assistant' }), null);
  assert.deepEqual(parseClaudeGoalMessage(local('Goal set: a\nmore')), { kind: 'set', condition: 'a' });
  assert.deepEqual(parseClaudeGoalMessage(local('Goal active: long…')), { kind: 'active', condition: 'long' });
  assert.deepEqual(parseClaudeGoalMessage(local('Goal cleared.')), { kind: 'cleared' });
  assert.equal(parseClaudeGoalMessage(local('other')), null);
  assert.deepEqual(parseClaudeGoalMessage(userWith('Stop hook feedback:\n[tests pass]: 2 failing\n')), {
    kind: 'check',
    condition: 'tests pass',
    reason: '2 failing',
  });
  assert.equal(parseClaudeGoalMessage(userWith('hi')), null);
  assert.equal(parseClaudeGoalMessage({ type: 'result' }), null);
});

test('a set starts a fresh goal, keeping the limit a resume set', () => {
  const fresh = defined(reduceClaudeGoal(null, { kind: 'set', condition: 'a' }, sctx));
  assert.deepEqual(fresh, {
    threadId: 'c1',
    objective: 'a',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 100,
    updatedAt: 100,
    claude: { iterations: 0, lastReason: null, limit: 30 },
  });
  const resumed = { ...fresh, claude: { iterations: 0, lastReason: null, limit: 10 } };
  assert.equal(defined(reduceClaudeGoal(resumed, { kind: 'set', condition: 'a' }, sctx)).claude?.limit, 10);
  assert.equal(
    defined(reduceClaudeGoal({ ...resumed, claude: { iterations: 2, limit: 10 } as any }, { kind: 'set', condition: 'a' }, sctx)).claude
      ?.limit,
    30,
  );
});

test('checks count rounds unless the goal is no longer active', () => {
  const g = defined(reduceClaudeGoal(null, { kind: 'check', condition: 'a', reason: 'r1' }, sctx));
  assert.deepEqual(g.claude, { iterations: 1, lastReason: 'r1', limit: 30 });
  const legacy = { objective: 'a', status: 'active' };
  assert.deepEqual(defined(reduceClaudeGoal(legacy as any, { kind: 'check', reason: 'r' } as any, sctx)).claude, {
    iterations: 1,
    lastReason: 'r',
    limit: 30,
  });
  assert.equal(reduceClaudeGoal({ ...g, status: 'paused' }, { kind: 'check', reason: 'r' } as any, sctx), undefined);
});

test('active reports keep a known goal and start an unknown one; clears drop running goals', () => {
  const g = defined(reduceClaudeGoal(null, { kind: 'set', condition: 'a' }, sctx));
  assert.equal(reduceClaudeGoal(g, { kind: 'active', condition: 'a' }, sctx), undefined);
  assert.equal(reduceClaudeGoal({ ...g, status: 'paused' }, { kind: 'active', condition: 'a' }, sctx), undefined);
  assert.equal(reduceClaudeGoal({ ...g, status: 'budgetLimited' }, { kind: 'active', condition: 'a' }, sctx), undefined);
  assert.equal(defined(reduceClaudeGoal({ ...g, status: 'complete' }, { kind: 'active', condition: 'a' }, sctx)).status, 'active');
  assert.equal(defined(reduceClaudeGoal(g, { kind: 'active', condition: 'b' }, sctx)).objective, 'b');
  assert.equal(defined(reduceClaudeGoal(null, { kind: 'active', condition: 'b' }, sctx)).objective, 'b');
  assert.equal(reduceClaudeGoal(g, { kind: 'cleared' }, sctx), null);
  assert.equal(reduceClaudeGoal({ ...g, status: 'stopped' }, { kind: 'none' }, sctx), null);
  assert.equal(reduceClaudeGoal({ ...g, status: 'paused' }, { kind: 'cleared' }, sctx), undefined);
  assert.equal(reduceClaudeGoal(null, { kind: 'none' }, sctx), undefined);
  assert.equal(reduceClaudeGoal(g, { kind: 'other' as any }, sctx), undefined);
});

test('a finished turn completes a met goal and stops an unmet one', () => {
  const g = defined(reduceClaudeGoal(null, { kind: 'set', condition: 'a' }, sctx));
  assert.equal(claudeGoalAfterTurn(null, null, 5), undefined);
  assert.equal(claudeGoalAfterTurn({ ...g, status: 'paused' }, null, 5), undefined);
  assert.deepEqual(claudeGoalAfterTurn(g, { met: true, reason: 'ok' }, 5), {
    ...g,
    status: 'complete',
    updatedAt: 5,
    claude: { ...g.claude, lastReason: 'ok' },
  });
  assert.equal(defined(claudeGoalAfterTurn(g, { met: true, condition: 'a' }, 5)).status, 'complete');
  assert.equal(defined(claudeGoalAfterTurn(g, { met: true, condition: 'other' }, 5)).status, 'stopped');
  const legacy = claudeGoalAfterTurn({ objective: 'a', status: 'active' } as any, null, 5);
  assert.deepEqual(legacy, { objective: 'a', status: 'stopped', updatedAt: 5, claude: { iterations: 0, lastReason: null, limit: null } });
});

test('transcript: partial, malformed and unrelated goal_status records', () => {
  const jsonl = [
    JSON.stringify({ attachment: { type: 'goal_status', met: false, condition: 'a', reason: 'old' } }),
    JSON.stringify({ attachment: { type: 'goal_status', met: 1 } }),
    '{"goal_status": broken',
    JSON.stringify({ attachment: { type: 'other', note: 'goal_status' } }),
    'plain line',
  ].join('\n');
  assert.deepEqual(lastGoalStatus(jsonl), { met: true, condition: undefined, reason: undefined });
  assert.equal(lastGoalStatus('nothing'), null);
  assert.equal(lastGoalStatus('"goal_status"'), null);
  assert.equal(lastGoalStatus('{"x":"goal_status"}'), null);
});

test('edges of the round limit, resume, extend and clear plans', () => {
  const g = defined(reduceClaudeGoal(null, { kind: 'set', condition: 'a' }, sctx));
  assert.equal(claudeGoalOverLimit(g), false);
  assert.equal(claudeGoalOverLimit({ ...g, claude: { iterations: 30, limit: null } as any }), false);
  assert.equal(claudeGoalOverLimit(null), false);
  assert.equal(canResumeClaudeGoal(null), false);
  assert.equal(canResumeClaudeGoal({ ...g, status: 'usageLimited' }), true);
  assert.equal(canExtendClaudeGoal({ ...g, status: 'budgetLimited' }), true);
  assert.equal(canExtendClaudeGoal({ status: 'budgetLimited' } as any), false);
  assert.equal(canExtendClaudeGoal(null), false);
  assert.deepEqual(claudeGoalExtended({ ...g, status: 'budgetLimited' }, 9).claude, {
    iterations: 0,
    lastReason: null,
    limit: CLAUDE_GOAL_EXTRA_ROUNDS,
  });
  assert.deepEqual(claudeGoalResumePlan(null), []);
  assert.deepEqual(claudeGoalResumePlan({ ...g, status: 'stopped' }, true), [
    { kind: 'send', text: '/goal clear' },
    { kind: 'send', text: '/goal a' },
  ]);
  assert.deepEqual(claudeGoalClearPlan({ ...g, status: 'stopped' }, true), [{ kind: 'send', text: '/goal clear' }]);
});

test('notes: a check without its condition, printed output trimmed or empty, and an active goal', () => {
  assert.equal(claudeGoalNote({ kind: 'check', reason: 'r' } as any), 'Goal not met yet: r');
  assert.equal(claudeGoalNote({ kind: 'cleared' }, ' Goal cleared (by you) '), 'Goal cleared (by you)');
  assert.equal(claudeGoalNote({ kind: 'cleared' }, ''), 'Goal cleared');
  assert.equal(claudeGoalNote({ kind: 'active', condition: 'a' }), 'Goal active: a');
});
