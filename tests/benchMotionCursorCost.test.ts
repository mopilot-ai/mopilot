// Motion bench jank, taskCost and toolTimes tests on synthetic recordings and transcripts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installJank, JANK_INSTALL_JS, jankSummary, readJank } from '../bench/lib/motion/jank.mjs';
import { taskCost } from '../bench/lib/motion/taskCost.mjs';
import { actionStats, classifyAction, toolCallTimes } from '../bench/lib/motion/toolTimes.mjs';

test('jankSummary, installJank and readJank', async () => {
  const entries = [
    { type: 'longtask', start: 1000, duration: 120 },
    { type: 'longtask', start: 2000, duration: 60, blocking: 5 },
    { type: 'longtask', start: 90_000, duration: 300 },
    { type: 'long-animation-frame', start: 1500, duration: 90, blocking: 40 },
    { type: 'long-animation-frame', start: 1600, duration: 80 },
  ];
  const s = jankSummary(entries, { from: 0, to: 60_000 });
  assert.deepEqual(s, {
    windowMs: 60_000,
    longTasks: 2,
    longTasksPerMin: 2,
    blockingMs: 75,
    worstMs: 120,
    p95Ms: 120,
    loaf: { count: 2, blockingMs: 70, worstMs: 90 },
  });
  const none = jankSummary(entries, { from: 5000, to: 5000 });
  assert.deepEqual([none.longTasks, none.longTasksPerMin, none.worstMs, none.p95Ms, none.loaf.worstMs], [0, null, null, null, null]);
  const calls: string[] = [];
  const page = { evaluate: async (code: string) => (calls.push(code), [{ type: 'longtask' }]) };
  await installJank(page);
  assert.deepEqual(await readJank(page), [{ type: 'longtask' }]);
  assert.equal(calls[0], JANK_INSTALL_JS);
  assert.match(calls[1], /__motionJank/);
  // the observer code runs in a page: here a stub PerformanceObserver feeds it one entry per type and refuses an unknown one
  const seen: any[] = [];
  const g: any = { window: {}, performance: { timeOrigin: 5000 } };
  g.window = g;
  class Observer {
    cb: (l: any) => void;
    constructor(cb: (l: any) => void) {
      this.cb = cb;
    }
    observe({ type }: { type: string }) {
      if (type === 'long-animation-frame') throw new Error('unsupported');
      this.cb({ getEntries: () => [{ startTime: 10, duration: 70 }] });
    }
  }
  new Function('window', 'performance', 'PerformanceObserver', JANK_INSTALL_JS)(g, g.performance, Observer);
  seen.push(...g.__motionJank);
  assert.deepEqual(seen, [{ type: 'longtask', start: 5010, duration: 70, blocking: null }]);
  new Function('window', 'performance', 'PerformanceObserver', JANK_INSTALL_JS)(g, g.performance, Observer);
  assert.equal(g.__motionJank.length, 1, 'a second install adds nothing');
});

test('taskCost: pass rate, steps, tokens and wall time of the cost tasks, UNGRADABLE not counted', () => {
  const run = (task: string, verdict: string, steps: number | null, tokens: number | null, wallMs = 60_000) => ({
    task,
    verdict,
    score: verdict === 'PASS' ? 1 : 0,
    efficiency: { steps, tokens, wallMs },
  });
  const records = [
    run('f4-week-plan', 'PASS', 40, 100_000),
    run('f4-week-plan', 'FAIL', 60, 200_000),
    run('f4-week-plan', 'UNGRADABLE', 5, 1),
    run('f2-onboarding', 'PASS', 20, 50_000),
    run('f2-onboarding', 'PASS', null, null),
    run('other', 'FAIL', 1, 1),
  ];
  const cost = taskCost(records);
  assert.deepEqual([cost.runs, cost.gradable, cost.pass, cost.passRate], [5, 4, 3, 0.75]);
  assert.deepEqual([cost.steps, cost.tokens, cost.wallMs], [40, 100_000, 60_000]);
  assert.equal(cost.byTask['f4-week-plan'].passRate, 0.5);
  assert.equal(cost.byTask['f4-week-plan'].steps, 50);
  assert.equal(cost.byTask['f2-onboarding'].passRate, 1);
  const empty = taskCost([]);
  assert.deepEqual([empty.runs, empty.passRate, empty.steps, empty.tokens], [0, null, null, null]);
  assert.equal(taskCost(records, ['other']).passRate, 0);
});

test('toolCallTimes and actionStats: Claude and Codex transcripts, results matched by id, kinds from names', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 10, 5, 12, 0, s)).toISOString();
  const claude = [
    { type: 'assistant', timestamp: at(0), message: { content: [{ type: 'tool_use', id: 'a', name: 'mcp__cu__screenshot', input: {} }] } },
    { type: 'user', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 'a' }] } },
    {
      type: 'assistant',
      timestamp: at(3),
      message: {
        content: [
          { type: 'text', text: 'hi' },
          { type: 'tool_use', id: 'b', name: 'computer', input: { action: 'left_click' } },
        ],
      },
    },
    {
      type: 'user',
      timestamp: at(4),
      message: {
        content: [
          { type: 'tool_result', tool_use_id: 'b' },
          { type: 'tool_result', tool_use_id: 'zzz' },
        ],
      },
    },
    {
      type: 'assistant',
      timestamp: at(5),
      message: { content: [{ type: 'tool_use', id: 'c', name: 'computer', input: { action: 'scroll' } }] },
    },
    {
      type: 'assistant',
      timestamp: at(6),
      message: {
        content: [
          { type: 'tool_use', id: 'd', name: 'type_text', input: 'x' },
          { type: 'tool_use', id: 'e', name: 'ToolSearch', input: null },
        ],
      },
    },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'f', name: 'x' }] } },
    { type: 'user', timestamp: at(7), message: { content: 'plain text' } },
  ]
    .map((l) => JSON.stringify(l))
    .join('\n');
  const calls = toolCallTimes('claude', `${claude}\n{"broken`);
  assert.deepEqual(
    calls.map((c) => [c.kind, c.name, c.endMs === null ? null : c.endMs - c.startMs]),
    [
      ['screenshot', 'mcp__cu__screenshot', 2000],
      ['click', 'computer', 1000],
      ['scroll', 'computer', null],
      ['type', 'type_text', null],
      ['other', 'ToolSearch', null],
    ],
  );
  const stats = actionStats(calls);
  assert.deepEqual(
    [stats.screenshot.count, stats.screenshot.p50, stats.click.p50, stats.scroll.count, stats.type.count],
    [1, 2000, 1000, 0, 0],
  );
  const codex = [
    { type: 'response_item', timestamp: at(0), payload: { type: 'function_call', name: 'click', call_id: '1', arguments: '{"x":1}' } },
    { type: 'response_item', timestamp: at(1), payload: { type: 'function_call_output', call_id: '1' } },
    { type: 'response_item', timestamp: at(2), payload: { type: 'custom_tool_call', call_id: '2', arguments: 'not json' } },
    { type: 'response_item', timestamp: at(3), payload: { type: 'custom_tool_call_output', call_id: '2' } },
    { type: 'response_item', timestamp: at(4), payload: { type: 'function_call_output', call_id: '9' } },
    { type: 'response_item', timestamp: at(5), payload: { type: 'function_call', name: 'press_key', call_id: '3' } },
    { type: 'response_item', timestamp: at(5), payload: { type: 'message' } },
    { type: 'response_item', timestamp: at(5) },
    { type: 'event_msg', timestamp: at(5), payload: { type: 'task_started' } },
  ]
    .map((l) => JSON.stringify(l))
    .join('\n');
  const codexCalls = toolCallTimes('codex', codex);
  assert.deepEqual(
    codexCalls.map((c) => [c.kind, c.name, c.endMs === null ? null : c.endMs - c.startMs]),
    [
      ['click', 'click', 1000],
      ['other', 'custom_tool_call', 1000],
      ['type', 'press_key', null],
    ],
  );
  assert.equal(classifyAction('get_app_state', null), 'screenshot');
  assert.equal(classifyAction('computer', { action: 'mouse_move' }), 'click');
  assert.equal(classifyAction('wheel', undefined), 'scroll');
  assert.equal(classifyAction('mystery', 5), 'other');
});
