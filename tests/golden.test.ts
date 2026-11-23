// Golden replay for the two first-class harnesses (WP5-21). tests/golden/codex-*.jsonl are sanitized
// app-server messages as the real CLI sends them (shapes from conformance X2..X10); claude-*.jsonl are
// Agent SDK messages (C4, C7, C8, C12, C13, C19). Codex lines go through the real CodexAdapter and the
// helpers in src/harness/codexTranslate.ts; Claude lines through ClaudeTranslator. The ACP goldens are
// in acpGolden.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CodexAdapter } = require('../electron/harness/codex.cjs');
const { SessionStore } = require('../electron/session/state.cjs');
const { emptyTasks, reduceTasks, taskList } = require('../electron/harness/claude/tasks.cjs');
const { presentItems, turnCard, compactionLabel, backgroundTerminals, childThreads } = await import('../src/harness/codexTranslate.ts');
const { ClaudeTranslator } = await import('./support/claude-translate.ts');
const { claudeAnswer } = await import('../src/harness/claudeTranslate.ts');
const { parseClaudeGoalMessage, reduceClaudeGoal, claudeGoalAfterTurn, claudeGoalPausePlan, canResumeClaudeGoal, claudeGoalResumePlan } =
  await import('../src/lib/claudeGoals.ts');

const lines = (name: string): any[] =>
  fs
    .readFileSync(path.join(import.meta.dirname, 'golden', `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

/** What the windows build from item events: turns with their items, plan and status. */
interface Turn {
  id: string;
  status: string;
  items: any[];
  plan?: any;
}
function fold(events: { method: string; params: any }[]): Turn[] {
  const turns: Turn[] = [];
  const turn = (id: string) => turns.find((t) => t.id === id);
  for (const { method, params: p } of events) {
    if (method === 'turn/started') turns.push({ id: p.turn.id, status: 'inProgress', items: [] });
    else if (method === 'turn/completed') {
      const t = turn(p.turn.id);
      if (t) t.status = p.turn.status;
    } else if (method === 'item/started' || method === 'item/completed' || method === 'item/updated') {
      const t = turn(p.turnId);
      if (!t) continue;
      const i = t.items.findIndex((x) => x.id === p.item.id);
      if (i >= 0) t.items[i] = p.item;
      else t.items.push(p.item);
    } else if (method === 'turn/plan/updated') {
      const t = turn(p.turnId);
      if (t) t.plan = { explanation: p.explanation, steps: p.plan };
    }
  }
  return turns;
}
const types = (t: Turn) => t.items.map((i) => `${i.type}${i.status ? `:${i.status}` : ''}`);

/* -- Codex ------------------------------------------------------------ */

/** The golden's server messages through a real adapter; client replies it records are sent through it. */
function replayCodex(name: string, each?: (line: any, ctx: { state: any; adapter: any }) => void) {
  const sent: any[] = [];
  const listeners = new Set<(e: any) => void>();
  const server = { listeners, proc: {}, start() {}, send: (m: any) => void sent.push(m), emit: (e: any) => listeners.forEach((l) => l(e)) };
  (server as any).on = (l: any) => listeners.add(l);
  const state = new SessionStore();
  const events: any[] = [];
  const observed: any[] = [];
  const adapter = new CodexAdapter({
    server,
    state,
    probe: null,
    nativeOf: (chat: string) => ({ kind: 'codex', id: chat, key: chat }),
    emit: (e: any) => events.push(e),
    observe: (m: any) => observed.push(m),
  });
  state.get('t1');
  const results: any[] = [];
  for (const line of lines(name)) {
    if (line.dir === 's2c') server.emit({ kind: 'message', msg: line.msg });
    else if (line.dir === 'c2s') adapter.respond(line.id, line.result);
    else if (line.dir === 'result') results.push(line);
    each?.(line, { state, adapter });
  }
  const notes = events.filter((e) => e.kind === 'notification').map((e) => ({ method: e.method, params: e.params }));
  return { adapter, state, events, notes, sent, observed, results, turns: fold(notes) };
}

test('codex goal: set, paused mid-turn, resumed, complete, cleared', () => {
  const seen: (string | null)[] = [];
  const { adapter, turns, notes } = replayCodex('codex-goal', (line, { adapter }) => {
    if (line.msg?.method?.startsWith('thread/goal/')) seen.push(adapter.goals.get('t1') ?? null);
  });
  // what the adapter knew of the goal after each goal message; once cleared it records that there is none (#2759)
  assert.deepEqual(seen, ['active', 'paused', 'active', 'complete', null]);
  assert.equal(adapter.goals.get('t1'), null);
  assert.deepEqual(
    notes.filter((n) => n.method.startsWith('thread/goal/')).map((n) => n.params.goal?.status ?? 'cleared'),
    ['active', 'paused', 'active', 'complete', 'cleared'],
  );
  // goal-driven turns have no user message
  assert.deepEqual(
    turns.map((t) => [t.id, t.status]),
    [
      ['turn-1', 'interrupted'],
      ['turn-2', 'completed'],
    ],
  );
  assert.deepEqual(types(turns[0]), ['commandExecution:completed', 'agentMessage']);
  assert.deepEqual(types(turns[1]), ['fileChange:completed']);
  // the usage the final goal reports
  assert.equal(notes.find((n) => n.params.goal?.status === 'complete')?.params.goal.tokensUsed, 2400);
});

test('codex plan: the Plan chip follows the mode; a plan item, or the last message when the model wrote none', () => {
  const chip: boolean[] = [];
  const { turns } = replayCodex('codex-plan', (line, { state }) => {
    if (line.msg?.method === 'thread/settings/updated') chip.push(state.get('t1').plan);
  });
  assert.deepEqual(chip, [true, false]);
  const [t1, t2] = turns;
  assert.deepEqual(
    t1.plan.steps.map((s: any) => s.status),
    ['completed', 'inProgress'],
  );
  const card = turnCard(presentItems(t1.items), true, false);
  assert.equal(card?.kind, 'plan');
  assert.equal(card?.item.text, '1. Read add.ts\n2. Change the operator to +');
  // luna-style: only messages, the last one is the plan; not while running or outside plan mode
  const luna = turnCard(presentItems(t2.items), true, false);
  assert.equal(luna?.kind, 'plan');
  assert.equal(luna?.item.id, 'm3');
  assert.equal((luna?.item as any)?.fromMessage, true);
  assert.equal(turnCard(t2.items, true, true), null);
  assert.equal(turnCard(t2.items, false, false), null);
});

test('codex tasks: a background terminal listed then gone; spawned threads name the sub-agents', () => {
  const { turns, results } = replayCodex('codex-tasks');
  assert.deepEqual(
    backgroundTerminals(results[0].result).map((t) => [t.processId, t.command, t.osPid]),
    [['86937', 'sleep 300', null]],
  );
  assert.deepEqual(backgroundTerminals(results[1].result), []);
  assert.equal(turns[0].items[0].processId, '86937');
  // the wait call spawns nobody; the spawn names two threads, in order
  assert.deepEqual(
    childThreads(turns[0].items).map((c) => [c.id, c.title]),
    [
      ['sub-1', 'Agent 1'],
      ['sub-2', 'Agent 2'],
    ],
  );
});

test('codex review: the result shows once, as the review card', () => {
  const { turns } = replayCodex('codex-review');
  const shown = presentItems(turns[0].items);
  assert.deepEqual(
    shown.map((i) => i.id),
    ['e1', 'u1', 'c1', 'm1', 'x1'],
  );
  const card = turnCard(shown, false, false);
  assert.equal(card?.kind, 'review');
  assert.match(card!.item.review, /^\[P1\] add now subtracts/);
});

test("codex compact: a turn holding only the compaction is the user's; one inside a turn is automatic", () => {
  const { turns } = replayCodex('codex-compact');
  assert.equal(compactionLabel(presentItems(turns[0].items)[0]), 'Context compacted');
  assert.equal(compactionLabel(presentItems(turns[1].items)[1]), 'Context automatically compacted');
});

test('codex approval denied: the request reaches the window once, the decline goes back to the app-server, the step reads declined', () => {
  const { events, sent, turns, observed } = replayCodex('codex-approval');
  const reqs = events.filter((e) => e.kind === 'request');
  assert.equal(reqs.length, 1);
  assert.deepEqual([reqs[0].chatId, reqs[0].request.id, reqs[0].request.method], ['t1', 'srv-1', 'item/commandExecution/requestApproval']);
  // the turn's end also reads what it left running (codexBackgroundWork.cjs), which is not an answer
  assert.deepEqual(
    sent.filter((m: { method?: string }) => m.method !== 'thread/backgroundTerminals/list'),
    [{ id: 'srv-1', result: { decision: 'decline' } }],
  );
  assert.equal(observed.filter((m) => m.id === 'srv-1').length, 1);
  assert.deepEqual(types(turns[0]), ['commandExecution:declined', 'agentMessage']);
  assert.equal(turns[0].status, 'completed');
});

/* -- Claude ----------------------------------------------------------- */

function replayClaude(name: string, each?: (line: any, ctx: { tr: any }) => void) {
  const out: { method: string; params: any }[] = [];
  const tr = new ClaudeTranslator('claude:g', '/repo', (method: string, params: any) => out.push({ method, params }));
  const msgs: any[] = [];
  const snaps: Record<string, any> = {};
  for (const line of lines(name)) {
    if (line.t === 'turn')
      tr.beginTurn(line.id, { id: `u-${line.id}`, clientId: null, content: [{ type: 'text', text: line.text, text_elements: [] }] });
    else if (line.t === 'msg') msgs.push(line.m), tr.onMessage(line.m);
    else if (line.t === 'interrupt') tr.markInterrupted();
    else if (line.t === 'snapshot') snaps[line.name] = line.name;
    each?.(line, { tr });
  }
  return { out, msgs, turns: fold(out), tr };
}

const ctx = { chatId: 'claude:g', limit: null, now: 100 };

test('claude goal: set, an unmet check, met; a pause stops the loop and Sage holds the goal', () => {
  const goals: any[] = [];
  let goal: any = null;
  const { turns, msgs } = replayClaude('claude-goal', (line) => {
    if (line.t === 'msg') {
      const e = parseClaudeGoalMessage(line.m);
      if (e) {
        const next = reduceClaudeGoal(goal, e, ctx);
        if (next !== undefined) goal = next;
        goals.push(goal && { status: goal.status, objective: goal.objective, iterations: goal.claude.iterations });
      }
    }
  });
  // turn 1: set, one check, then the transcript says met
  assert.deepEqual(goals.slice(0, 2), [
    { status: 'active', objective: 'all tests pass', iterations: 0 },
    { status: 'active', objective: 'all tests pass', iterations: 1 },
  ]);
  const t1 = turns[0];
  assert.equal(t1.status, 'completed');
  assert.deepEqual(
    t1.items.filter((i) => i.type === 'statusNote').map((i) => i.text),
    ['Goal set: all tests pass', 'Goal not met yet: 1 test still fails'],
  );
  assert.ok(t1.items.some((i) => i.type === 'commandExecution' && i.status === 'failed' && i.exitCode === 1));
  const status = lines('claude-goal').find((l) => l.t === 'goal_status').status;
  const done = claudeGoalAfterTurn(
    {
      ...goals[1],
      ...({
        threadId: 'claude:g',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 0,
        updatedAt: 0,
        claude: { iterations: 1, lastReason: 'x', limit: null },
      } as any),
    },
    status,
    200,
  );
  assert.equal(done?.status, 'complete');
  // turn 2: set, then pause (the loop is interrupted, the CLI's goal cleared), then resume sends the goal again
  assert.equal(turns[1].status, 'interrupted');
  const active: any = {
    threadId: 'claude:g',
    objective: 'lint is clean',
    status: 'active',
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    createdAt: 0,
    updatedAt: 0,
    claude: { iterations: 0, lastReason: null, limit: null },
  };
  assert.deepEqual(claudeGoalPausePlan(active, true), [{ kind: 'interrupt' }, { kind: 'send', text: '/goal clear' }]);
  const held = { ...active, status: 'paused' };
  const cleared = parseClaudeGoalMessage(msgs.find((m) => m.subtype === 'local_command_output'));
  assert.deepEqual(cleared, { kind: 'cleared' });
  // the CLI reporting its own goal cleared leaves the one Sage is holding
  assert.equal(reduceClaudeGoal(held, cleared!, ctx), undefined);
  assert.equal(canResumeClaudeGoal(held), true);
  assert.deepEqual(claudeGoalResumePlan(held), [{ kind: 'send', text: '/goal lint is clean' }]);
});

test("claude plan: TodoWrite fills the step list; ExitPlanMode is one plan card with the CLI's file", () => {
  const { turns } = replayClaude('claude-plan');
  const t = turns[0];
  assert.deepEqual(t.plan.steps, [
    { step: 'Read add.ts', status: 'completed' },
    { step: 'Fix the operator', status: 'inProgress' },
    { step: 'Run tests', status: 'pending' },
  ]);
  const plans = t.items.filter((i) => i.type === 'plan');
  assert.equal(plans.length, 1);
  assert.equal(plans[0].text, '1. Read add.ts\n2. Change the operator to +');
  assert.equal(plans[0].planFilePath, '/home/u/.claude/plans/fix-add.md');
  assert.equal(turnCard(t.items, true, false)?.kind, 'plan');
  assert.equal(t.status, 'completed');
});

test('claude tasks: an agent card with its progress; the task table follows the level and a stop', () => {
  const table = emptyTasks();
  const lists: Record<string, string[]> = {};
  const { turns } = replayClaude('claude-tasks', (line) => {
    if (line.t === 'msg') reduceTasks(table, line.m);
    if (line.t === 'snapshot') lists[line.name] = taskList(table).map((x: any) => `${x.id}:${x.type}:${x.status}`);
  });
  assert.deepEqual(lists.running, ['task-a:local_agent:running', 'task-b:local_bash:running']);
  // a stopped task stays listed, settled
  assert.deepEqual(lists['after-stop'], ['task-a:local_agent:running', 'task-b:local_bash:stopped']);
  const agent = turns[0].items.find((i) => i.type === 'collabAgentToolCall');
  assert.equal(agent.taskId, 'task-a');
  assert.equal(agent.summary, 'Reading the auth module');
  assert.deepEqual(agent.activity, ['Grep auth']);
  // the background Bash call is an ordinary step; the turn ends while the tasks run on
  assert.ok(turns[0].items.some((i) => i.type === 'commandExecution' && i.command === 'sleep 300'));
  assert.equal(turns[0].status, 'completed');
});

test('claude review: a /code-review turn ends with the review card, not a reply', () => {
  const { turns } = replayClaude('claude-review');
  const items = presentItems(turns[0].items);
  assert.deepEqual(types(turns[0]), ['userMessage', 'enteredReviewMode', 'exitedReviewMode']);
  const card = turnCard(items, false, false);
  assert.equal(card?.kind, 'review');
  assert.equal(card?.item.review, '[P1] add now subtracts: a + b became a - b');
});

test('claude compact: the boundary becomes a divider, manual or automatic as the CLI says', () => {
  const { turns } = replayClaude('claude-compact');
  const k = (t: Turn) => t.items.find((i) => i.type === 'contextCompaction');
  assert.equal(k(turns[0]).trigger, 'manual');
  assert.equal(compactionLabel(presentItems(turns[0].items).find((i) => i.type === 'contextCompaction')), 'Context compacted');
  assert.equal(k(turns[1]).trigger, 'auto');
  assert.equal(compactionLabel(k(turns[1])), 'Context automatically compacted');
});

test('claude approval denied: the answer is a deny, and the rejected steps read declined with no exit code', () => {
  assert.deepEqual(claudeAnswer('item/commandExecution/requestApproval', { command: 'rm -rf build' }, { decision: 'decline' }), {
    behavior: 'deny',
    message: 'The user declined this action.',
  });
  const { turns } = replayClaude('claude-approval');
  assert.deepEqual(types(turns[0]), ['userMessage', 'commandExecution:declined', 'fileChange:declined', 'agentMessage']);
  assert.equal((turns[0].items[1] as any).exitCode, null);
  assert.equal(turns[0].status, 'completed');
});
