// Claude sub-agent runs in the Claude translator (core/crates/translate/src/claude): the AgentRun on the Agent row, its report and trailer, the
// heartbeat, background launches that run on until their task settles, child transcripts and replayed task events
// (tests/claudeTaskEvents.test.ts has the live ones).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asst, mk, res, use } from './support/claude-translator-kit.ts';
import { buildTurns, subagentItems } from './support/claude-translate.ts';

const AID = 'a0123456789abcdef';
const trailer = (tokens = 1200, uses = 4, ms = 9000) =>
  `agentId: ${AID} (use SendMessage with to: '${AID}' to continue this agent)\n<usage>subagent_tokens: ${tokens}\ntool_uses: ${uses}\nduration_ms: ${ms}</usage>`;

const sub = (parent: string, content: any[], { message, ...extra }: any = {}) => ({
  type: 'assistant',
  parent_tool_use_id: parent,
  message: { content, ...message },
  ...extra,
});

test('a foreground Agent row carries its run: launch, heartbeat, report and usage', () => {
  const { tr, agent, items } = mk();
  tr.beginTurn('t');
  tr.onMessage(asst([use('Agent', { prompt: 'Look around the repo\nand report', model: 'sonnet' }, 'ag')]));
  const start = agent();
  assert.deepEqual(
    { ...start, startedAt: typeof start.startedAt },
    {
      key: 'ag',
      description: 'Look around the repo',
      prompt: 'Look around the repo\nand report',
      model: 'sonnet',
      background: false,
      status: 'running',
      toolUses: 0,
      latestTool: null,
      tokens: null,
      startedAt: 'number',
      completedAt: null,
      report: null,
      transcript: 'full',
      agentId: null,
    },
  );
  // the sub-agent's first message names its real model; its tool calls are the heartbeat
  tr.onMessage(
    sub('ag', [use('Read', { file_path: 'a' }, 'r1'), use('Grep', { pattern: 'x' }, 'g1')], { message: { model: 'claude-sonnet-5' } }),
  );
  assert.deepEqual([agent().model, agent().toolUses, agent().latestTool], ['claude-sonnet-5', 2, 'Grep']);
  // a model alone is news; the same model again with nothing else is not
  tr.onMessage(sub('ag', [], { message: { model: 'claude-sonnet-6' } }));
  assert.equal(agent().model, 'claude-sonnet-6');
  const n = items('item/updated').length;
  tr.onMessage(sub('ag', [], { message: { model: 'claude-sonnet-6' } }));
  tr.onMessage(sub('ag', [], { message: { model: '<synthetic>' } }));
  tr.onMessage(sub('ag', [{ type: 'text', text: 'thinking aloud' }]));
  assert.equal(items('item/updated').length, n + 1);
  assert.equal(agent().latestTool, 'Grep');
  // progress: usage and the latest tool; a task_started only links the task
  tr.onMessage({ type: 'system', subtype: 'task_started', task_id: 'k', tool_use_id: 'ag' });
  tr.onMessage({
    type: 'system',
    subtype: 'task_progress',
    task_id: 'k',
    tool_use_id: 'ag',
    usage: { total_tokens: 50, tool_uses: 1 },
    last_tool_name: 'Bash',
  });
  assert.deepEqual([agent().tokens, agent().toolUses, agent().latestTool], [50, 2, 'Bash']);
  tr.onMessage({ type: 'system', subtype: 'task_progress', task_id: 'k', tool_use_id: 'ag' });
  assert.deepEqual([agent().tokens, agent().latestTool], [50, 'Bash']);
  tr.onMessage(
    res('ag', [
      { type: 'text', text: 'All good.' },
      { type: 'text', text: trailer() },
    ]),
  );
  const done = agent();
  assert.deepEqual(
    [done.status, done.report, done.agentId, done.tokens, done.toolUses, typeof done.completedAt],
    ['completed', 'All good.', AID, 1200, 4, 'number'],
  );
  assert.equal(items('item/completed').at(-1).status, 'completed');
});

test('structured results win over the trailer; a failure keeps its text; defaults for a bare call', () => {
  const { tr, agent } = mk();
  tr.beginTurn('t');
  tr.onMessage(
    asst([use('Task', { description: '  ' }, 'a1'), use('Task', { description: 'Fix it', prompt: 7 }, 'a2'), use('Task', undefined, 'a3')]),
  );
  assert.deepEqual(
    [agent('a1').description, agent('a1').prompt, agent('a2').description, agent('a2').prompt],
    ['Agent', null, 'Fix it', null],
  );
  assert.equal(agent('a3').model, null);
  tr.onMessage({
    ...res('a1', 'Done.'),
    tool_use_result: { status: 'completed', agentId: 'a1111111111111111', totalTokens: 9, totalToolUseCount: 3, totalDurationMs: 5 },
  });
  assert.deepEqual(
    [agent('a1').agentId, agent('a1').tokens, agent('a1').toolUses, agent('a1').report],
    ['a1111111111111111', 9, 3, 'Done.'],
  );
  tr.onMessage(res('a2', 'boom', { is_error: true }));
  assert.deepEqual([agent('a2').status, agent('a2').report], ['failed', 'boom']);
  tr.onMessage({ ...res('a3', ''), tool_use_result: 'text only' });
  assert.deepEqual([agent('a3').status, agent('a3').report, agent('a3').tokens], ['completed', null, null]);
  const p = mk();
  p.tr.beginTurn('t');
  p.tr.onMessage(asst([use('Task', {}, 'a4')]));
  p.tr.onMessage(res('a4', '', { is_error: true }));
  assert.equal(p.agent('a4').report, null);
});

test('a long prompt titles the row with its first line, cut short', () => {
  const { tr, agent } = mk();
  tr.beginTurn('t');
  tr.onMessage(asst([use('Agent', { prompt: 'x'.repeat(100) }, 'ag')]));
  assert.equal(agent().description, `${'x'.repeat(79)}…`);
});

test('a background launch keeps running until its task settles (effective status), then takes the report', () => {
  const { tr, agent, items, events } = mk();
  tr.beginTurn('t');
  tr.onMessage(asst([use('Agent', { description: 'Watch CI', run_in_background: true }, 'ag')]));
  assert.equal(agent().background, true);
  tr.onMessage(res('ag', `Async agent launched successfully.\nagentId: ${AID} (use SendMessage ...)`));
  assert.deepEqual([agent().status, agent().agentId, agent().report], ['running', AID, null]);
  tr.onMessage({ type: 'result', subtype: 'success', usage: {} });
  // the turn ended; the row still follows its agent
  tr.onMessage(sub('ag', [use('Bash', { command: 'gh run watch' }, 'b1')]));
  assert.deepEqual([agent().toolUses, agent().latestTool], [1, 'Bash']);
  assert.equal(events.filter(([m]) => m === 'item/updated').at(-1)?.[1].turnId, 't');
  tr.onMessage({ type: 'system', subtype: 'task_progress', task_id: 'k', tool_use_id: 'ag', usage: {} });
  // the SDK's task_notification settles it; the transcript gets one task event, headed into the next turn
  tr.onMessage({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'k',
    tool_use_id: 'ag',
    status: 'completed',
    summary: 'Agent "Watch CI" completed',
    usage: { total_tokens: 77, tool_uses: 6, duration_ms: 1000 },
  });
  assert.deepEqual([agent().status, agent().tokens, agent().toolUses, agent().completedAt - agent().startedAt], ['completed', 77, 6, 1000]);
  // the injected user turn for the same task adds the report, but no second event
  tr.onMessage({
    type: 'user',
    uuid: 'n1',
    message: {
      content: `<task-notification><task-id>k</task-id><tool-use-id>ag</tool-use-id><status>completed</status><result>CI is green.\n${trailer()}</result></task-notification>`,
    },
  });
  assert.equal(agent().report, 'CI is green.');
  const n = items('item/updated').length;
  tr.onMessage({ type: 'system', subtype: 'task_notification', task_id: 'k', tool_use_id: 'ag', status: 'completed' });
  assert.equal(items('item/updated').length, n);
  tr.onMessage(asst([{ type: 'text', text: 'CI passed.' }], { id: 'm2' }));
  const notes = items('item/completed').filter((i) => i.type === 'statusNote');
  assert.deepEqual(
    notes.map((i) => [i.id, i.text, i.task]),
    [
      [
        'task-k-completed',
        'Agent "Watch CI" completed',
        { taskId: 'k', kind: 'agent', title: 'Watch CI', status: 'completed', durationMs: 1000, toolUseId: 'ag' },
      ],
    ],
  );
  // a notification for a call this session didn't launch in the background, or an ambient one, is not an event
  tr.onMessage({ type: 'system', subtype: 'task_notification', task_id: 'z', tool_use_id: 'nope', status: 'completed' });
  tr.onMessage({ type: 'system', subtype: 'task_notification', task_id: 'z', status: 'completed' });
  // without a task id the event goes by the call's id
  tr.onMessage(asst([use('Agent', { run_in_background: true }, 'ag2')], { id: 'm3' }));
  tr.onMessage(res('ag2', 'launched'));
  tr.onMessage({ type: 'system', subtype: 'task_notification', tool_use_id: 'ag2', status: 'failed' });
  assert.equal(
    items('item/completed')
      .filter((i) => i.type === 'statusNote')
      .at(-1).id,
    'task-ag2-failed',
  );
  tr.onMessage({ type: 'system', subtype: 'task_notification', task_id: 'z', tool_use_id: 'ag', status: 'failed', ambient: true });
  assert.equal(items('item/completed').filter((i) => i.type === 'statusNote').length, 2);
});

test('a structured async launch is a background run; a stopped one cuts off its open tools', () => {
  const { tr, agent, child } = mk();
  tr.beginTurn('t');
  tr.onMessage(asst([use('Agent', { description: 'Long job' }, 'ag')]));
  tr.onMessage({ ...res('ag', 'launched'), tool_use_result: { status: 'async_launched', agentId: AID } });
  assert.deepEqual([agent().background, agent().status, agent().agentId], [true, 'running', AID]);
  tr.onMessage(sub('ag', [use('Bash', { command: 'sleep 99' }, 'b1')]));
  assert.equal(child().at(-1)[0].status, 'inProgress');
  tr.onMessage({
    type: 'system',
    subtype: 'task_notification',
    task_id: 'k',
    tool_use_id: 'ag',
    status: 'killed',
    usage: { total_tokens: 'x' },
  });
  assert.deepEqual([agent().status, agent().tokens], ['stopped', null]);
  assert.equal(child().at(-1)[0].status, 'failed');
  // still running: no change
  const t2 = mk();
  t2.tr.beginTurn('t');
  t2.tr.onMessage(asst([use('Agent', { run_in_background: true }, 'ag')]));
  t2.tr.onMessage(res('ag', 'launched'));
  t2.tr.onMessage({
    type: 'user',
    message: { content: '<task-notification><tool-use-id>ag</tool-use-id><status>running</status></task-notification>' },
  });
  assert.equal(t2.agent().status, 'running');
  // a completed one's open tools stay as they were
  t2.tr.onMessage(sub('ag', [use('Read', { file_path: 'a' }, 'r1')]));
  t2.tr.onMessage({
    type: 'user',
    message: {
      content:
        '<task-notification><tool-use-id>ag</tool-use-id><status>completed</status><usage>duration_ms: 5</usage></task-notification>',
    },
  });
  assert.equal(t2.agent().status, 'completed');
  assert.equal(t2.child().at(-1)[0].status, 'inProgress');
});

test('an interrupted turn stops its running agent; a failed one fails it; their open tools are cut off', () => {
  for (const [end, want] of [
    ['interrupted', 'stopped'],
    ['failed', 'failed'],
  ] as const) {
    const { tr, agent, child } = mk();
    tr.beginTurn('t');
    tr.onMessage(asst([use('Agent', { description: 'Dig' }, 'ag'), use('Agent', { description: 'Idle' }, 'ag2')]));
    tr.onMessage(sub('ag', [use('Bash', { command: 'x' }, 'b1')]));
    tr.endTurn(end, null);
    assert.equal(agent().status, want);
    assert.equal(child().at(-1)[0].status, 'failed');
    assert.equal(agent('ag2').status, want);
  }
});

test("a child's transcript: the main transcript's item shapes, results merged, unchanged items keep their identity", () => {
  const { tr, child, items } = mk();
  tr.beginTurn('t');
  tr.onMessage(asst([use('Agent', { description: 'Explore' }, 'ag')]));
  tr.onMessage(
    sub(
      'ag',
      [{ type: 'thinking', thinking: 'plan first' }, { type: 'text', text: 'Reading.' }, use('Read', { file_path: '/r/a.ts' }, 'r1')],
      { uuid: 's1' },
    ),
  );
  tr.onMessage({
    type: 'user',
    parent_tool_use_id: 'ag',
    message: {
      content: [
        { type: 'text', text: 'a note' },
        { type: 'tool_result', tool_use_id: 'r1', content: 'file body' },
        { type: 'tool_result', tool_use_id: 'other', content: 'x' },
      ],
    },
  });
  tr.onMessage(
    sub(
      'ag',
      [
        use('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' }, 'e1'),
        use('mcp__fs__read', { path: 'x' }, 'm1'),
        { type: 'server_tool_use', id: 'w1', name: 'web_search', input: { query: 'q' } },
        use('TodoWrite', { todos: [] }, 'td'),
        use('AskUserQuestion', {}, 'q1'),
        { type: 'redacted_thinking' },
        { type: 'text', text: ' ' },
        { type: 'image' },
      ],
      { uuid: 's2' },
    ),
  );
  const lists = child();
  assert.equal(lists.length, 3);
  const last = lists.at(-1);
  assert.deepEqual(
    last.map((i: any) => [i.id, i.type, i.status ?? null]),
    [
      ['s1:0', 'reasoning', null],
      ['s1:1', 'agentMessage', null],
      ['r1', 'commandExecution', 'completed'],
      ['e1', 'fileChange', 'inProgress'],
      ['m1', 'mcpToolCall', 'inProgress'],
      ['w1', 'webSearch', null],
    ],
  );
  assert.equal(last[2].aggregatedOutput, 'file body');
  // settled items read the same from one update to the next
  assert.deepEqual(lists[1][0], lists[0][0]);
  assert.deepEqual(last[0], lists[0][0]);
  assert.deepEqual(last[2], lists[1][2]);
  assert.notDeepEqual(lists[1][2], lists[0][2]);
  // child messages never become the main thread's items; nothing for an empty or unknown message
  assert.ok(!items().some((i) => i.id === 's1:1'));
  tr.onMessage(sub('ag', []));
  tr.onMessage({ type: 'user', parent_tool_use_id: 'ag', message: { content: 'prompt text' } });
  tr.onMessage({ type: 'system', parent_tool_use_id: 'ag' });
  tr.onMessage(sub('unknown', [{ type: 'text', text: 'lost' }]));
  assert.equal(child().length, 3);
  assert.equal(child('unknown').length, 0);
});

test('nested agents get transcripts of their own', () => {
  const { tr, child } = mk();
  tr.beginTurn('t');
  tr.onMessage(asst([use('Agent', { description: 'Lead' }, 'ag')]));
  tr.onMessage(sub('ag', [use('Agent', { description: 'Helper' }, 'n1')], { uuid: 's1' }));
  assert.equal(child().at(-1)[0].agent.description, 'Helper');
  tr.onMessage(sub('n1', [{ type: 'text', text: 'helping' }], { uuid: 'h1' }));
  assert.deepEqual(
    child('n1')
      .at(-1)
      .map((i: any) => i.text),
    ['helping'],
  );
  tr.onMessage({
    type: 'user',
    parent_tool_use_id: 'ag',
    message: { content: [{ type: 'tool_result', tool_use_id: 'n1', content: `Helped.\n${trailer()}` }] },
  });
  assert.deepEqual([child().at(-1)[0].agent.status, child().at(-1)[0].agent.report], ['completed', 'Helped.']);
});

test('stored transcripts translate the same way; a settled run cuts off open tools; timestamps time the steps', () => {
  const messages = [
    { type: 'user', uuid: 'p', message: { content: 'the prompt' } },
    {
      type: 'assistant',
      uuid: 's1',
      timestamp: '2026-01-01T00:00:00.000Z',
      message: { content: [use('Bash', { command: 'ls' }, 'b1'), use('Bash', { command: 'sleep' }, 'b2')] },
    },
    {
      type: 'user',
      uuid: 'u2',
      timestamp: '2026-01-01T00:00:02.000Z',
      message: { content: [{ type: 'tool_result', tool_use_id: 'b1', content: 'a\nb' }] },
      toolUseResult: { stdout: 'a\nb', stderr: '', interrupted: false },
    },
    { type: 'assistant', message: { id: 'mid', content: [{ type: 'text', text: 'done' }] } },
  ];
  const items = subagentItems(messages, 'chat', '/repo');
  assert.deepEqual(
    items.map((i: any) => [i.id, i.status ?? null]),
    [
      ['b1', 'completed'],
      ['b2', 'inProgress'],
      ['mid:0', null],
    ],
  );
  assert.equal((items[0] as any).durationMs, 2000);
  assert.equal((subagentItems(messages, 'chat', '/repo', true)[1] as any).status, 'failed');
});

test('replay: the Agent row has its run with report and agent id; a background one settles on its notification', () => {
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const turns = buildTurns(
    [
      { type: 'user', uuid: 'u1', timestamp: at(0), message: { content: 'go' } },
      {
        type: 'assistant',
        uuid: 'a1',
        timestamp: at(1),
        message: {
          id: 'm1',
          content: [use('Agent', { description: 'Fore' }, 'f'), use('Agent', { description: 'Back', run_in_background: true }, 'b')],
        },
      },
      {
        type: 'user',
        uuid: 'r1',
        timestamp: at(5),
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'f', content: [{ type: 'text', text: `Fore report\n${trailer(10, 2, 4000)}` }] }],
        },
      },
      {
        type: 'user',
        uuid: 'r2',
        timestamp: at(6),
        message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: `launched\nagentId: ${AID} (use SendMessage)` }] },
      },
      { type: 'assistant', uuid: 'a2', timestamp: at(7), message: { id: 'm2', content: [{ type: 'text', text: 'Waiting.' }] } },
      {
        type: 'user',
        uuid: 'n1',
        timestamp: at(30),
        message: {
          content:
            '<task-notification><task-id>k</task-id><tool-use-id>b</tool-use-id><status>completed</status><summary>Agent "Back" completed</summary><result>Back report</result><usage>total_tokens: 5\ntool_uses: 1\nduration_ms: 29000</usage></task-notification>',
        },
      },
      { type: 'assistant', uuid: 'a3', timestamp: at(31), message: { id: 'm3', content: [{ type: 'text', text: 'Both done.' }] } },
    ],
    'chat',
    '/repo',
  );
  assert.equal(turns.length, 2);
  const [fore, back] = turns[0].items.filter((i: any) => i.type === 'collabAgentToolCall').map((i: any) => i.agent);
  assert.deepEqual(
    [fore.status, fore.report, fore.agentId, fore.tokens, fore.completedAt - fore.startedAt],
    ['completed', 'Fore report', AID, 10, 4000],
  );
  assert.deepEqual(
    [back.status, back.report, back.background, back.completedAt - back.startedAt],
    ['completed', 'Back report', true, 29000],
  );
  assert.deepEqual(
    turns[1].items.map((i: any) => [i.id, i.type, i.task?.kind ?? null, i.task?.title ?? null]),
    [
      ['note-n1', 'statusNote', 'agent', 'Back'],
      ['m3:t1', 'agentMessage', null, null],
    ],
  );
});

test('replay: a task event mid-turn stays in it; a duplicate shows once; a trailing one heads a turn of its own', () => {
  const turns = buildTurns(
    [
      { type: 'user', uuid: 'u1', message: { content: 'go' } },
      { type: 'assistant', message: { id: 'm1', content: [use('Bash', { command: 'x' }, 'b')] } },
      {
        type: 'user',
        uuid: 'n1',
        message: { content: '<task-notification><task-id>k</task-id><status>completed</status></task-notification>' },
      },
      {
        type: 'user',
        uuid: 'n2',
        message: { content: '<task-notification><task-id>k</task-id><status>completed</status></task-notification>' },
      },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'ok' }] } },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'done' }] } },
      {
        type: 'user',
        uuid: 'n3',
        message: { content: '<task-notification><task-id>j</task-id><status>failed</status></task-notification>' },
      },
      {
        type: 'user',
        uuid: 'n4',
        message: { content: '<task-notification><task-id>j</task-id><status>failed</status></task-notification>' },
      },
    ],
    'chat',
    '/repo',
  );
  assert.deepEqual(
    turns.map((t: any) => [t.id, t.items.map((i: any) => i.id)]),
    [
      ['h-u1', ['u1', 'b', 'note-n1', 'm2:t0']],
      ['h-n4', ['note-n3']],
    ],
  );
});

const ASYNC = `Async agent launched successfully. (internal metadata)\nagentId: ${AID} (use SendMessage with to: '${AID}' to continue this agent.)\nThe agent is working in the background.`;
const handbackMsg = (report: string, from = AID) => ({
  type: 'user',
  uuid: `hb-${from}`,
  origin: { kind: 'peer', from, name: 'general-purpose', handback: true },
  message: {
    content: `Another Claude session sent a message:\n<agent-message from="${from}">\n[Subagent hand-back] The text below is the final report.\nThe report follows:\n${report
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n')}\n</agent-message>\n\nThat "other Claude session" is an agent.`,
  },
});
const doneNotification = (tool: string) => ({
  type: 'user',
  uuid: `n-${tool}`,
  origin: { kind: 'task-notification' },
  message: {
    content: `<task-notification><task-id>t1</task-id><tool-use-id>${tool}</tool-use-id><status>completed</status><summary>Agent "X" finished</summary><result>This agent's report was delivered to you as a message from "${AID}" (its SubagentHandback call). Read it there; it is not repeated here.\n</result><usage><subagent_tokens>55212</subagent_tokens><tool_uses>2</tool_uses><duration_ms>19751</duration_ms></usage></task-notification>`,
  },
});

test('a launch the CLI reports only in words is a background run; its report is the hand-back, not the launch text or the notice', () => {
  const { tr, items, agent } = mk();
  tr.onMessage({ type: 'stream_event', event: { type: 'message_start', message: { id: 'x' } } });
  tr.onMessage(asst([use('Agent', { description: 'Track B' }, 'ag')]));
  // no structured status and no run_in_background: only the text says it went to the background
  tr.onMessage(res('ag', ASYNC));
  assert.deepEqual([agent().status, agent().background, agent().report, agent().agentId], ['running', true, null, AID]);
  // the report arrives as a message from the agent: it is the row's report, and shows nowhere else
  const before = items().length;
  tr.onMessage(handbackMsg('done (it printed b)\nsecond line'));
  assert.equal(agent().report, 'done (it printed b)\nsecond line');
  assert.equal(items().length, before + 1);
  assert.ok(items().every((i) => i.type !== 'statusNote'));
  // the same report again changes nothing; one for an agent that isn't here is dropped
  const n = items().length;
  tr.onMessage(handbackMsg('done (it printed b)\nsecond line'));
  tr.onMessage(handbackMsg('who', 'a9999999999999999'));
  assert.equal(items().length, n);
  // its notification settles the row without replacing that report by "delivered to you as a message"
  tr.onMessage(doneNotification('ag'));
  assert.equal(agent().status, 'completed');
  assert.equal(agent().report, 'done (it printed b)\nsecond line');
  assert.deepEqual([agent().tokens, agent().toolUses], [55212, 2]);
});

test("replay: a hand-back message is the agent's report, ends the turn it follows and heads the reply it gets", () => {
  const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();
  const rows: any[] = [
    { type: 'user', uuid: 'u1', timestamp: at(0), message: { content: 'go' } },
    { type: 'assistant', uuid: 'a1', timestamp: at(1), message: { id: 'm1', content: [use('Agent', { description: 'Track B' }, 'ag')] } },
    { type: 'user', uuid: 'r1', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 'ag', content: ASYNC }] } },
    { type: 'assistant', uuid: 'a2', timestamp: at(3), message: { id: 'm2', content: [{ type: 'text', text: 'Launched.' }] } },
    { ...handbackMsg('done'), timestamp: at(9) },
    { type: 'assistant', uuid: 'a3', timestamp: at(10), message: { id: 'm3', content: [{ type: 'text', text: 'It reported done.' }] } },
    { ...doneNotification('ag'), timestamp: at(12) },
    { type: 'assistant', uuid: 'a4', timestamp: at(13), message: { id: 'm4', content: [{ type: 'text', text: 'All done.' }] } },
  ];
  const turns = buildTurns(rows, 'chat', '/repo');
  const run = ((turns[0].items as any[]).find((i) => i.type === 'collabAgentToolCall') as any).agent;
  assert.deepEqual([run.status, run.report, run.background], ['completed', 'done', true]);
  assert.equal(turns.length, 3);
  assert.ok(turns.every((t: any) => t.items.every((i: any) => i.type !== 'statusNote' || i.task)));
  assert.deepEqual(
    turns.map((t: any) => t.items.filter((i: any) => i.type === 'agentMessage').map((i: any) => i.text)),
    [['Launched.'], ['It reported done.'], ['All done.']],
  );
  // a hand-back in the middle of a turn's own work stays in that turn
  const mid = buildTurns(
    [
      { type: 'user', uuid: 'u1', timestamp: at(0), message: { content: 'go' } },
      { type: 'assistant', uuid: 'a1', timestamp: at(1), message: { id: 'm1', content: [use('Agent', { description: 'T' }, 'ag')] } },
      { type: 'user', uuid: 'r1', timestamp: at(2), message: { content: [{ type: 'tool_result', tool_use_id: 'ag', content: ASYNC }] } },
      { ...handbackMsg('mid report'), timestamp: at(3) },
      { type: 'assistant', uuid: 'a2', timestamp: at(4), message: { id: 'm2', content: [{ type: 'text', text: 'ok' }] } },
    ],
    'chat',
    '/repo',
  );
  assert.equal(mid.length, 1);
  assert.equal(((mid[0].items as any[]).find((i) => i.type === 'collabAgentToolCall') as any).agent.report, 'mid report');
});

test('a hand-back is recognised by its frame alone, a frame without a report is empty, and a peer message that is not one stays a peer note', () => {
  const { tr, items, agent } = mk();
  tr.onMessage({ type: 'stream_event', event: { type: 'message_start', message: { id: 'x' } } });
  tr.onMessage(asst([use('Agent', { description: 'T' }, 'ag')]));
  tr.onMessage(res('ag', ASYNC));
  // no origin at all: the text names the sender and says what it is
  tr.onMessage({
    type: 'user',
    message: {
      content: `<agent-message from="${AID}">\n[Subagent hand-back] frame\nThe report follows:\n  from the frame\n</agent-message>`,
    },
  });
  assert.equal(agent().report, 'from the frame');
  // a hand-back whose report marker is missing has nothing to report
  tr.onMessage({ type: 'user', origin: { kind: 'peer', from: AID, handback: true }, message: { content: 'no marker here' } });
  assert.equal(agent().report, '');
  // a peer message that is no hand-back, or names no sender, is a note about another session
  tr.onMessage({ type: 'user', uuid: 'p1', origin: { kind: 'peer', handback: false }, message: { content: 'hi' } });
  tr.onMessage({ type: 'user', uuid: 'p2', message: { content: '[Subagent hand-back] but from nobody' } });
  assert.equal(items().filter((i) => i.type === 'statusNote').length, 1);
  // replay: a hand-back without a uuid still ends the turn it follows
  const turns = buildTurns(
    [
      { type: 'user', message: { content: 'go' } },
      { type: 'assistant', message: { id: 'm1', content: [use('Agent', { description: 'T' }, 'ag')] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'ag', content: ASYNC }] } },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'ok' }] } },
      {
        type: 'user',
        origin: { kind: 'peer', from: AID, handback: true },
        message: { content: 'x\nThe report follows:\n  r\n</agent-message>' },
      },
      { type: 'assistant', message: { id: 'm3', content: [{ type: 'text', text: 'next' }] } },
    ],
    'chat',
    '/repo',
  );
  assert.equal(turns.length, 2);
});

test('subagent transcripts ignore non-record blocks and retain valid text', () => {
  const items = subagentItems(
    [
      { type: 'assistant', uuid: 'a', message: { content: [null, 42, [], { type: 'text', text: 'Kept' }] } },
      { type: 'user', message: { content: [null] } },
    ],
    'chat',
    '/repo',
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].text, 'Kept');
  assert.equal(items[0].id, 'a:3', 'skipped entries must not renumber transcript item identities');
});

test('malformed subagent text and reasoning fields cannot hide valid content', () => {
  const content = [
    { type: 'text', text: 42 },
    { type: 'thinking', thinking: {} },
    { type: 'text', text: 'Kept' },
    { type: 'thinking', thinking: 'Reason' },
  ];
  assert.deepEqual(
    subagentItems([{ type: 'assistant', uuid: 'a', message: { content } }], 'chat', '/repo').map((item: any) => [
      item.id,
      item.text ?? item.summary,
    ]),
    [
      ['a:2', 'Kept'],
      ['a:3', ['Reason']],
    ],
  );
});
