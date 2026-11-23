// The Claude translator (core/crates/translate/src/claude): every tool kind, result shape, system message, stream event and replay case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeTranslator, buildTurns, hookNote } from './support/claude-translate.ts';
import { LIVE_WINDOW_MS } from '../shared/claudeItems/liveWindow.mjs';
import { defined } from './support/defined.ts';

function mk() {
  const events: [string, any][] = [];
  const tr = new ClaudeTranslator('t1', '/repo', (m: string, p: any) => events.push([m, p]));
  const items = (method: string) => events.filter(([m]) => m === method).map(([, p]) => p.item);
  return { tr, events, items };
}
const asst = (content: any[], extra: any = {}) => ({
  type: 'assistant',
  uuid: extra.uuid,
  message: { id: extra.id ?? 'm1', content, model: extra.model },
  ...extra,
});
const use = (name: string, input?: any, id = name) => ({ type: 'tool_use', id, name, input });
const result = (tool_use_id: string, content: any, is_error = false) => ({ type: 'tool_result', tool_use_id, content, is_error });
const userMsg = (content: any, extra: any = {}) => ({ type: 'user', message: { content }, ...extra });
test('each tool becomes its item, with defaults for missing input', () => {
  const { tr, items } = mk();
  tr.beginTurn('turn');
  tr.onMessage(
    asst([
      use('Bash'),
      use('Read'),
      use('Grep', { pattern: 'x', path: 'src' }),
      use('Grep', undefined, 'g2'),
      use('Glob', { pattern: '*.ts' }),
      use('Glob', {}, 'gl2'),
      use('LS', { path: 'lib' }),
      use('LS', {}, 'ls2'),
      use('Edit', { file_path: 'a.ts' }),
      use('MultiEdit', {
        file_path: 'b.ts',
        edits: [
          { old_string: 'a', new_string: 'b' },
          { old_string: 'c', new_string: 'd' },
        ],
      }),
      use('MultiEdit', { file_path: 'c.ts' }, 'me2'),
      use('Write', { file_path: 'w.ts' }),
      use('NotebookEdit', { notebook_path: 'n.ipynb' }),
      use('WebSearch'),
      use('WebFetch'),
      use('Task', { description: 'look', model: 'haiku' }),
      use('Agent', { prompt: 'p' }),
      use('Agent', {}, 'ag2'),
      use('ExitPlanMode'),
      use('AskUserQuestion', { q: 1 }),
      use('mcp__fs__read', { p: 1 }),
      use('mcp__solo'),
      use('Custom'),
      { type: 'server_tool_use', id: 'ws', name: 'web_search', input: { query: 'q' } },
    ]),
  );
  const by = Object.fromEntries(items('item/started').map((i) => [i.id, i]));
  assert.equal(by.Bash.command, '');
  assert.deepEqual(by.Read.commandActions, [{ type: 'read', command: 'Read', name: '', path: '' }]);
  assert.deepEqual(
    [by.Grep.command, by.Grep.commandActions[0].path, by.g2.command, by.g2.commandActions[0].query],
    ['Grep x', 'src', 'Grep ', null],
  );
  assert.deepEqual([by.Glob.command, by.gl2.command, by.gl2.commandActions[0].path], ['Glob *.ts', 'Glob ', null]);
  assert.deepEqual([by.LS.command, by.ls2.command, by.ls2.commandActions[0].path], ['LS lib', 'LS ', null]);
  assert.equal(by.Edit.changes[0].diff, '@@ -1,1 +1,1 @@\n-\n+');
  assert.equal(by.MultiEdit.changes[0].diff, '@@ -1,1 +1,1 @@\n-a\n+b\n@@ -1,1 +1,1 @@\n-c\n+d');
  assert.equal(by.me2.changes[0].diff, '');
  assert.deepEqual(by.Write.changes[0], { path: 'w.ts', kind: { type: 'add' }, diff: '' });
  assert.equal(by.NotebookEdit.changes[0].path, 'n.ipynb');
  assert.deepEqual([by.WebSearch.query, by.WebFetch.action], ['', { type: 'openPage', url: '' }]);
  assert.deepEqual(
    [by.Task.prompt, by.Task.model, by.Agent.prompt, by.ag2.prompt, by.ag2.model, by.Task.senderThreadId],
    ['look', 'haiku', 'p', null, null, 't1'],
  );
  assert.deepEqual(by.ExitPlanMode, { type: 'plan', id: 'ExitPlanMode', text: '', planFilePath: null, approvedInTurn: true });
  assert.equal(by.AskUserQuestion, undefined);
  assert.deepEqual(
    [by.mcp__fs__read.server, by.mcp__fs__read.tool, by.mcp__solo.server, by.mcp__solo.tool, by.Custom.server, by.Custom.tool],
    ['fs', 'read', 'solo', 'mcp__solo', '', 'Custom'],
  );
  assert.deepEqual([by.ws.type, by.ws.query], ['webSearch', 'q']);
});

test("TodoWrite updates the plan with each step's status", () => {
  const { tr, events } = mk();
  tr.beginTurn('turn');
  tr.onMessage(
    asst([
      use('TodoWrite', {
        todos: [{ content: 'a', status: 'in_progress' }, { activeForm: 'b', status: 'completed' }, { status: 'pending' }],
      }),
      use('TodoWrite', undefined, 'tw2'),
    ]),
  );
  const plans = events.filter(([m]) => m === 'turn/plan/updated').map(([, p]) => p.plan);
  assert.deepEqual(plans, [
    [
      { step: 'a', status: 'inProgress' },
      { step: 'b', status: 'completed' },
      { step: '', status: 'pending' },
    ],
    [],
  ]);
});

test('tool results complete their items by kind', () => {
  const { tr, items } = mk();
  tr.beginTurn('turn');
  tr.onMessage(
    asst([
      use('Bash', { command: 'ls' }, 'b1'),
      use('Bash', { command: 'rm' }, 'b2'),
      use('Edit', { file_path: 'e.ts' }, 'e1'),
      use('Write', { file_path: 'w.ts' }, 'w1'),
      use('Edit', { file_path: 'x.ts' }, 'e2'),
      use('Edit', { file_path: 'y.ts' }, 'e3'),
      use('mcp__s__t', {}, 'm1'),
      use('mcp__s__t', {}, 'm2'),
      use('Task', {}, 'a1'),
      use('Task', {}, 'a2'),
      use('ExitPlanMode', { plan: 'own', planFilePath: '/p.md' }, 'p1'),
      use('ExitPlanMode', {}, 'p2'),
      use('WebSearch', {}, 'ws'),
    ]),
  );
  tr.onMessage(
    userMsg([
      result('b1', [{ type: 'text', text: 'out' }, { type: 'image' }, { type: 'other', x: 1 }, null]),
      result('b2', 'The user rejected this', true),
      result('e1', null, true),
      result('w1', { ok: 1 }),
      result('e2', 'denied: permission denied', true),
      result('e3', 'ok'),
      result('m1', [{ type: 'text', text: 'r' }]),
      result('m2', 'boom', true),
      result('a1', 'x', true),
      result('a2', 'done'),
      result('p1', 'ok'),
      result('ws', 'ok'),
      result('unknown', 'x'),
    ]),
  );
  tr.onMessage({ type: 'user', message: { content: [result('p2', 'ok')] }, tool_use_result: { plan: 'saved', filePath: '/saved.md' } });
  const by = Object.fromEntries(items('item/completed').map((i) => [i.id, i]));
  assert.deepEqual([by.b1.status, by.b1.aggregatedOutput, by.b1.exitCode], ['completed', 'out\n[image]\n{"type":"other","x":1}\nnull', 0]);
  assert.deepEqual([by.b2.status, by.b2.exitCode], ['declined', null]);
  assert.deepEqual([by.e1.status, by.w1.status, by.e2.status, by.e3.status], ['failed', 'completed', 'declined', 'completed']);
  assert.equal(by.e3.changes[0].path, 'y.ts');
  assert.deepEqual(by.m1.result.content, [{ type: 'text', text: 'r' }]);
  assert.deepEqual([by.m2.status, by.m2.result, by.m2.error], ['failed', null, { message: 'boom' }]);
  assert.deepEqual([by.a1.status, by.a2.status], ['failed', 'completed']);
  assert.deepEqual([by.p1.text, by.p1.planFilePath, by.p2.text, by.p2.planFilePath], ['own', '/p.md', 'saved', '/saved.md']);
  assert.equal(by.ws.type, 'webSearch');
  assert.equal(typeof by.m1.durationMs, 'number');
});

test("structured file results replace the diff: a created file, and a patch for the item's path", () => {
  const { tr, items } = mk();
  tr.beginTurn('turn');
  tr.onMessage(
    asst([use('Write', { file_path: 'w.ts' }, 'w1'), use('Edit', { file_path: 'e.ts' }, 'e1'), use('Write', { file_path: 'v.ts' }, 'w2')]),
  );
  tr.onMessage({ ...userMsg([result('w1', 'ok')]), tool_use_result: { type: 'create', filePath: '/abs/w.ts', content: 'body' } });
  tr.onMessage({
    ...userMsg([result('e1', 'ok')]),
    tool_use_result: { structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-a', '+b'] }] },
  });
  tr.onMessage({ ...userMsg([result('w2', 'ok')]), tool_use_result: { type: 'create' } });
  const [w1, e1, w2] = items('item/completed');
  assert.deepEqual(w1.changes, [{ path: '/abs/w.ts', kind: { type: 'add' }, diff: 'body' }]);
  assert.deepEqual(e1.changes, [{ path: 'e.ts', kind: { type: 'update', move_path: null }, diff: '@@ -1,1 +1,1 @@\n-a\n+b' }]);
  assert.deepEqual(w2.changes, [{ path: 'v.ts', kind: { type: 'add' }, diff: '' }]);
});

test('turn bookkeeping: a new turn interrupts the old one, steers count only in a turn, cut-off tools are closed', () => {
  const { tr, events } = mk();
  tr.addSteer();
  tr.endTurn('completed', null);
  assert.equal(events.length, 0);
  tr.beginTurn('a', { id: 'u', content: [{ type: 'text', text: '/review now' }, null] } as any);
  tr.onMessage(
    asst([use('Bash', { command: 'x' }, 'b'), use('Edit', { file_path: 'e' }, 'e'), use('mcp__a__b', {}, 'm'), use('WebSearch', {}, 'w')]),
  );
  tr.beginTurn('b');
  const cut = events
    .filter(([m, p]) => m === 'item/completed' && p.turnId === 'a' && p.item.type !== 'userMessage')
    .map(([, p]) => [p.item.id, p.item.status, p.item.cutOff]);
  assert.deepEqual(cut, [
    ['b', 'failed', true],
    ['e', 'failed', true],
    ['m', 'failed', true],
    ['w', undefined, undefined],
  ]);
  assert.equal(events.find(([m]) => m === 'turn/completed')![1].turn.status, 'interrupted');
  tr.onMessage(asst([use('Bash', { command: 'y' }, 'b2')]));
  tr.endTurn('completed', 'oops');
  const last = events.at(-1)![1].turn;
  assert.deepEqual([last.status, last.error, last.durationMs], ['completed', { message: 'oops' }, null]);
  assert.equal(events.at(-2)![1].item.status, 'completed');
  tr.beginTurn('b');
  tr.beginTurn('b');
  assert.equal(events.filter(([m]) => m === 'turn/completed').length, 2);
});

test('results: steers wait for their own result; failures carry their errors or subtype', () => {
  const { tr, events } = mk();
  const done = () => events.filter(([m]) => m === 'turn/completed').map(([, p]) => p.turn);
  tr.beginTurn('a');
  tr.addSteer();
  tr.onMessage({
    type: 'result',
    subtype: 'success',
    usage: {
      input_tokens: 1,
      output_tokens: 2,
      cache_read_input_tokens: 3,
      cache_creation_input_tokens: 4,
      output_tokens_details: { thinking_tokens: 1 },
    },
    modelUsage: { m: {}, n: { contextWindow: 200000 } },
  });
  assert.equal(done().length, 0);
  tr.onMessage({ type: 'result', subtype: 'success', usage: { iterations: [{ input_tokens: 10, output_tokens: 1 }] } });
  assert.deepEqual(done()[0].status, 'completed');
  const usage = () => events.findLast(([m]) => m === 'thread/tokenUsage/updated')![1].tokenUsage;
  assert.deepEqual(usage().last, {
    inputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 1,
    reasoningOutputTokens: 0,
    totalTokens: 11,
  });
  assert.equal(usage().total.totalTokens, 21);
  assert.equal(usage().modelContextWindow, null);
  tr.beginTurn('b');
  tr.onMessage({ type: 'result', subtype: 'error_during_execution', errors: ['x', 'y'] });
  tr.beginTurn('c');
  tr.onMessage({ type: 'result', subtype: 'error_max_turns' });
  tr.beginTurn('d');
  tr.onMessage({ type: 'result', subtype: 'success', is_error: true });
  tr.beginTurn('e');
  tr.markInterrupted();
  tr.onMessage({ type: 'result', subtype: 'error_during_execution', errors: ['z'] });
  assert.deepEqual(
    done()
      .slice(1)
      .map((t) => [t.status, t.error]),
    [
      ['failed', { message: 'x\ny' }],
      ['failed', { message: 'error_max_turns' }],
      ['failed', null],
      ['interrupted', null],
    ],
  );
  const fresh = mk();
  fresh.tr.onMessage({ type: 'result', subtype: 'success' });
  assert.equal(fresh.events.find(([m]) => m === 'thread/tokenUsage/updated')![1].tokenUsage.total.totalTokens, 0);
});

test('system messages: review start, task progress, bash output, hooks, goals, compaction', () => {
  const { tr, events, items } = mk();
  tr.onMessage({ type: 'system', subtype: 'hook_response', outcome: 'error', hook_id: 'h0' });
  tr.onMessage({ type: 'system', subtype: 'compact_boundary', uuid: 'c0' });
  tr.beginTurn('a', { id: 'u', content: [{ type: 'text', text: '/code-review low' }] } as any);
  tr.onMessage({ type: 'system', subtype: 'task_started', task_id: 'k', description: '/code-review low' });
  tr.onMessage({ type: 'system', subtype: 'task_started', task_id: 'k2' });
  tr.onMessage(asst([use('Task', {}, 'ag'), use('Bash', { command: 'x' }, 'b')]));
  tr.onMessage({ type: 'system', subtype: 'task_progress', tool_use_id: 'ag', task_id: 't1', summary: 'half' });
  tr.onMessage({ type: 'system', subtype: 'task_progress', tool_use_id: 'ag' });
  tr.onMessage({ type: 'system', subtype: 'task_started', tool_use_id: 'ag' });
  tr.onMessage({ type: 'system', subtype: 'task_progress', tool_use_id: 'b', summary: 'no' });
  tr.onMessage({ type: 'system', subtype: 'task_progress' });
  tr.onMessage({ type: 'system', subtype: 'sage_bash_output', tool_use_id: 'b', output: 'partial' });
  tr.onMessage({ type: 'system', subtype: 'sage_bash_output', tool_use_id: 'b', output: 'tail', truncated: true });
  tr.onMessage({ type: 'system', subtype: 'sage_bash_output', tool_use_id: 'b', output: 5 });
  tr.onMessage({ type: 'system', subtype: 'sage_bash_output', tool_use_id: 'ag', output: 'x' });
  tr.onMessage({ type: 'system', subtype: 'sage_bash_output', tool_use_id: 'zz', output: 'x' });
  tr.onMessage({ type: 'system', subtype: 'informational', level: 'warning', uuid: 'notice-h1', content: 'Hook policy requires changes.' });
  tr.onMessage({ type: 'system', subtype: 'informational', level: 'notice', uuid: 'hu', content: 'Try again after setup.' });
  tr.onMessage({ type: 'system', subtype: 'hook_response', outcome: 'success' });
  tr.onMessage({ type: 'system', subtype: 'local_command_output', content: 'Goal cleared', uuid: 'g' });
  tr.onMessage({ type: 'system', subtype: 'compact_boundary', uuid: 'c1', compact_metadata: { trigger: 'auto' } });
  tr.onMessage({ type: 'system', subtype: 'compact_boundary', uuid: 'c2' });
  tr.onMessage({ type: 'system', subtype: 'init' });
  const updates = items('item/updated');
  assert.deepEqual(
    updates.slice(0, 3).map((i) => [i.taskId, i.summary]),
    [
      ['t1', 'half'],
      ['t1', 'half'],
      ['t1', 'half'],
    ],
  );
  assert.deepEqual(
    updates.slice(3).map((i) => i.aggregatedOutput),
    ['partial', '…\ntail'],
  );
  const completed = items('item/completed');
  assert.deepEqual(
    completed.map((i) => i.type),
    ['userMessage', 'enteredReviewMode', 'hookPrompt', 'hookPrompt', 'statusNote', 'contextCompaction', 'contextCompaction'],
  );
  assert.deepEqual([completed[1].id, completed[1].review], ['review-k', 'with /code-review low']);
  assert.deepEqual(
    [completed[2].id, completed[2].fragments[0].text, completed[3].id],
    ['notice-h1', 'Hook policy requires changes.', 'hu'],
  );
  assert.deepEqual([completed[5].trigger, completed[6].trigger], ['auto', null]);
  assert.equal(events.filter(([m]) => m === 'item/completed' && m).length, 7);
});

test("a sub-agent's steps fill its card; other parents or empty steps are ignored", () => {
  const { tr, items } = mk();
  tr.onMessage({ type: 'assistant', parent_tool_use_id: 'ag', message: { content: [{ type: 'text', text: 'x' }] } });
  tr.beginTurn('a');
  tr.onMessage(asst([use('Task', {}, 'ag'), use('Bash', { command: 'x' }, 'b')]));
  tr.onMessage({
    type: 'assistant',
    parent_tool_use_id: 'ag',
    message: {
      content: [
        { type: 'text', text: ' ' },
        { type: 'text', text: `${'y'.repeat(170)}\nmore` },
        use('Bash', { command: 'npm test' }),
        use('mcp__fs__read_file', { path: 'a' }),
        use('Glob'),
        { type: 'image' },
      ],
    },
  });
  tr.onMessage({ type: 'assistant', parent_tool_use_id: 'ag', message: { content: [use('Read', { file_path: 'b.ts' })] } });
  tr.onMessage({ type: 'assistant', parent_tool_use_id: 'ag', message: {} });
  tr.onMessage({ type: 'assistant', parent_tool_use_id: 'b', message: { content: [{ type: 'text', text: 'x' }] } });
  tr.onMessage({ type: 'user', parent_tool_use_id: 'ag', message: { content: [] } });
  const ups = items('item/updated');
  assert.equal(ups.length, 2);
  assert.deepEqual(ups[1].activity, [`${'y'.repeat(160)}…`, 'Bash npm test', 'fs · read_file a', 'Glob', 'Read b.ts']);
  const many = {
    type: 'assistant',
    parent_tool_use_id: 'ag',
    message: { content: Array.from({ length: 40 }, (_, i) => ({ type: 'text', text: `s${i}` })) },
  };
  tr.onMessage(many);
  assert.equal(items('item/updated').at(-1).activity.length, 30);
});

test('streamed text and thinking open items that the full message completes under the same ids', () => {
  const { tr, events, items } = mk();
  tr.onMessage({ type: 'stream_event' });
  tr.onMessage({ type: 'stream_event', event: { type: 'content_block_delta', index: 0 } });
  tr.onMessage({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm1' } } });
  for (const [i, kind] of ['text', 'thinking', 'tool_use', 'thinking'].entries())
    tr.onMessage({ type: 'stream_event', event: { type: 'content_block_start', index: i, content_block: { type: kind } } });
  tr.onMessage({ type: 'stream_event', event: { type: 'content_block_start', index: 9 } });
  tr.onMessage({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hi' } } });
  tr.onMessage({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: 'hmm' } },
  });
  tr.onMessage({ type: 'stream_event', event: { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta' } } });
  tr.onMessage({ type: 'stream_event', event: { type: 'content_block_stop', index: 0 } });
  assert.deepEqual(
    items('item/started').map((i) => [i.id, i.type]),
    [
      ['m1:0', 'agentMessage'],
      ['m1:1', 'reasoning'],
      ['m1:3', 'reasoning'],
    ],
  );
  assert.deepEqual(
    events.filter(([m]) => m.includes('elta')).map(([m, p]) => [m, p.itemId]),
    [
      ['item/agentMessage/delta', 'm1:0'],
      ['item/reasoning/summaryTextDelta', 'm1:1'],
    ],
  );
  tr.onMessage(
    asst(
      [
        { type: 'text', text: 'Hi' },
        { type: 'thinking', thinking: 'hmm' },
        { type: 'redacted_thinking' },
        { type: 'thinking' },
        { type: 'thinking', thinking: 'later' },
        { type: 'text' },
        { type: 'other' },
      ],
      { id: 'm1' },
    ),
  );
  const done = items('item/completed');
  assert.deepEqual(
    done.map((i) => [i.id, i.type, i.text ?? i.summary?.[0]]),
    [
      ['m1:0', 'agentMessage', 'Hi'],
      ['m1:1', 'reasoning', 'hmm'],
      ['m1:r0', 'reasoning', 'later'],
      ['m1:t1', 'agentMessage', ''],
    ],
  );
  tr.onMessage({ type: 'assistant', uuid: 'u9', message: { content: [use('Bash', { command: 'x' }, 'bb')] } });
  tr.onMessage({ type: 'assistant', uuid: 'u10', message: {} });
});

test('a note before any turn heads the turn Claude starts', () => {
  const { tr, items } = mk();
  tr.onMessage({ type: 'user', uuid: 'n0', origin: { kind: 'peer' }, message: { content: 'hello' } });
  assert.equal(tr.turnId, null);
  tr.onMessage({ type: 'assistant', message: { id: 'm', content: [] } });
  const turn = defined(tr.turnId);
  assert.match(turn, /^auto-/);
  assert.deepEqual(
    items('item/completed').map((i) => [i.type, i.kind, i.text]),
    [['statusNote', 'peer', 'Message from another Claude session']],
  );
  tr.onMessage({ type: 'assistant', message: { id: 'n', content: [] } });
  assert.equal(tr.turnId, turn);
  const other = mk();
  other.tr.onMessage({ type: 'assistant', message: { id: 'm', content: [] } });
  assert.match(defined(other.tr.turnId), /^auto-/);
  assert.equal(other.items('item/completed').length, 0);
});

test('user messages: goal checks, task and peer notes, results without a turn', () => {
  const { tr, items } = mk();
  tr.onMessage(userMsg('Stop hook feedback:\n[ship]: not yet'));
  tr.beginTurn('a');
  tr.onMessage(userMsg('Stop hook feedback:\n[ship]: not yet', { uuid: 'g1' }));
  tr.onMessage(userMsg('<task-notification><summary>done</summary></task-notification>'));
  tr.onMessage(userMsg([{ type: 'text', text: 'hi from b' }], { origin: { kind: 'peer' } }));
  tr.onMessage(userMsg('<cross-session-message name="B">x</cross-session-message>', { uuid: 'p2' }));
  tr.onMessage(userMsg('plain'));
  tr.onMessage(userMsg([{ type: 'text', text: 'not a result' }]));
  tr.onMessage({ type: 'user' });
  assert.deepEqual(
    items('item/completed').map((i) => [i.id.replace(/note-.*/, 'note'), i.kind, i.text]),
    [
      ['g1', 'goal', 'Goal not met yet: not yet'],
      ['note', 'task', 'done'],
      ['note', 'peer', 'Message from another Claude session'],
      ['p2', 'peer', 'Message from another Claude session · B'],
    ],
  );
  const t2 = mk();
  t2.tr.beginTurn('a');
  t2.tr.onMessage(asst([use('Bash', { command: 'x' }, 'b')]));
  t2.tr.endTurn('completed', null);
  const ended = t2.items('item/completed').length;
  t2.tr.onMessage(userMsg([result('b', 'ok')]));
  assert.equal(t2.items('item/completed').length, ended, 'a result with no turn says nothing');
});

const at = (s: number) => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

test('replay: prompts, commands, images and interrupted turns', () => {
  const turns = buildTurns(
    [
      {
        type: 'user',
        message: { content: [{ type: 'text', text: '<command-name>/effort</command-name><command-args> high </command-args>' }] },
      },
      { type: 'user', uuid: 'c2', message: { content: '<command-name>/clear</command-name>' } },
      {
        type: 'user',
        uuid: 'img',
        message: {
          content: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
            { type: 'image', source: { type: 'url', url: 'x' } },
          ],
        },
      },
      { type: 'user', uuid: 'r', message: { content: '<system-reminder>only</system-reminder>' } },
      { type: 'user', uuid: 'o', message: { content: '<local-command-stdout>x</local-command-stdout>' } },
      { type: 'user', uuid: 'odd', message: { content: 5 } },
      { type: 'user', uuid: 'i', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
      { type: 'user', uuid: 'i2', message: { content: '[Request interrupted by user for tool use]' } },
    ],
    't',
    '/r',
  );
  assert.deepEqual(
    turns.map((t: any) => [t.id, t.status, t.items[0].content.map((c: any) => c.text ?? c.url)]),
    [
      ['h-0', 'completed', ['/effort high']],
      ['h-c2', 'completed', ['/clear']],
      ['h-img', 'interrupted', ['data:image/png;base64,AAA']],
    ],
  );
});

test('replay: notes start or join turns, task notifications end a replied turn', () => {
  const turns = buildTurns(
    [
      { type: 'user', uuid: 'u1', timestamp: at(0), message: { content: 'go' } },
      { type: 'assistant', uuid: 'a1', timestamp: at(1), message: { id: 'm1', content: [use('Bash', { command: 'x' }, 'b')] } },
      { type: 'user', uuid: 'p1', timestamp: 'bad', message: { content: '<cross-session-message name="B">hi</cross-session-message>' } },
      { type: 'user', timestamp: at(2), message: { content: [result('b', 'ok')] } },
      { type: 'user', uuid: 'q', timestamp: at(3), message: { content: 'also this' } },
      { type: 'assistant', uuid: 'a2', timestamp: at(4), message: { id: 'm2', content: [{ type: 'text', text: 'done' }] } },
      { type: 'user', uuid: 'p2', message: { content: '<cross-session-message>later</cross-session-message>' } },
      { type: 'assistant', uuid: 'a3', message: { id: 'm3', content: [{ type: 'text', text: 'ok' }] } },
      { type: 'user', message: { content: '<task-notification><status>completed</status></task-notification>' } },
      { type: 'user', message: { content: '<task-notification></task-notification>' } },
      { type: 'assistant', uuid: 'a4', message: { id: 'm4', content: [{ type: 'text', text: 'after task' }] } },
      { type: 'user', uuid: 'p3', message: { content: '<cross-session-message>x</cross-session-message>' } },
      { type: 'user', uuid: 'g', message: { content: 'Stop hook feedback:\n[c]: no' } },
      { type: 'assistant', parent_tool_use_id: 'none', message: { content: [] } },
      { type: 'system', subtype: 'init' },
    ],
    't',
    '/r',
  );
  assert.deepEqual(
    turns.map((t: any) => [t.id, t.items.map((i: any) => i.type)]),
    [
      ['h-u1', ['userMessage', 'commandExecution', 'statusNote', 'userMessage', 'agentMessage']],
      ['h-p2', ['statusNote', 'agentMessage']],
      ['h-9', ['statusNote', 'statusNote', 'agentMessage']],
      ['h-p3', ['statusNote', 'statusNote']],
    ],
  );
  assert.equal(turns[0].durationMs, 4000);
  assert.equal(turns[1].startedAt, null);
});

test('replay: a task notification mid-turn stays in it; a plan and items for a closed turn are dropped', () => {
  const turns = buildTurns(
    [
      { type: 'user', uuid: 'u1', message: { content: 'go' } },
      {
        type: 'assistant',
        message: { id: 'm1', content: [use('Bash', { command: 'x' }, 'b'), use('TodoWrite', { todos: [{ content: 'a' }] })] },
      },
      { type: 'user', uuid: 'tn', message: { content: '<task-notification><summary>s</summary></task-notification>' } },
      { type: 'user', message: { content: [result('b', 'ok')] } },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'done' }] } },
    ],
    't',
    '/r',
  );
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].plan, { explanation: null, steps: [{ step: 'a', status: 'pending' }] });
  // a translator emitting for an unknown turn is ignored by the replay
  const live = buildTurns([{ type: 'user', uuid: 'u', timestamp: new Date().toISOString(), message: { content: 'go' } }], 't', '/r', {
    liveTail: true,
  });
  assert.equal(live[0].status, 'inProgress');
  const old = buildTurns(
    [{ type: 'user', uuid: 'u', timestamp: new Date(Date.now() - LIVE_WINDOW_MS * 2).toISOString(), message: { content: 'go' } }],
    't',
    '/r',
    { liveTail: true },
  );
  assert.equal(old[0].status, 'completed');
  const untimed = buildTurns(
    [
      { type: 'user', uuid: 'u', message: { content: 'go' } },
      { type: 'assistant', message: { id: 'x', content: [{ type: 'text', text: 'hi' }] } },
    ],
    't',
    '/r',
    { liveTail: true },
  );
  assert.equal(untimed[0].status, 'completed');
  assert.deepEqual(buildTurns([], 't', '/r', { liveTail: true }), []);
});

test('replay ignores items and plans the translator reports for turns it never started', () => {
  const { tr } = mk();
  void tr;
  const turns = buildTurns([{ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' } } }], 't', '/r');
  assert.equal(turns.length, 1);
  const orphan = buildTurns(
    [
      { type: 'user', uuid: 'u1', message: { content: 'go' } },
      { type: 'user', uuid: 'i', message: { content: '[Request interrupted by user]' } },
      { type: 'assistant', parent_tool_use_id: 'x', message: { content: [] } },
    ],
    't',
    '/r',
  );
  assert.deepEqual(
    orphan.map((t: any) => t.status),
    ['interrupted'],
  );
});

test('plan cards without any plan, text blocks without text, progress without ids, notes without uuids', () => {
  const { tr, items } = mk();
  tr.beginTurn('a');
  tr.onMessage(asst([use('ExitPlanMode', {}, 'p'), use('Task', {}, 'ag')]));
  tr.onMessage(userMsg([result('p', 'ok')]));
  assert.deepEqual([items('item/completed')[0].text, items('item/completed')[0].planFilePath], ['', null]);
  tr.onMessage({ type: 'system', subtype: 'task_progress', tool_use_id: 'ag' });
  const up = items('item/updated')[0];
  assert.deepEqual([up.taskId, 'summary' in up], [null, false]);
  const turns = buildTurns(
    [
      { type: 'user', message: { content: [{ type: 'text' }, { type: 'text', text: 'hi' }] } },
      { type: 'assistant', message: { id: 'm', content: [use('Bash', { command: 'x' }, 'b')] } },
      { type: 'user', message: { content: '<cross-session-message>mid</cross-session-message>' } },
      { type: 'user', message: { content: [result('b', 'ok')] } },
      { type: 'assistant', message: { id: 'm2', content: [{ type: 'text', text: 'done' }] } },
      { type: 'user', message: { content: '<cross-session-message>new</cross-session-message>' } },
    ],
    't',
    '/r',
  );
  assert.deepEqual(
    turns.map((t: any) => [t.id, t.items.filter((i: any) => i.type === 'statusNote').map((i: any) => i.id)]),
    [
      ['h-0', ['note-2']],
      ['h-5', ['note-5']],
    ],
  );
  assert.deepEqual(
    (turns[0].items[0] as any).content.map((c: any) => c.text),
    ['hi'],
  );
});

test('hook execution outcomes do not manufacture notices from internal diagnostics', () => {
  assert.equal(hookNote(null), null);
  assert.equal(hookNote({ subtype: 'other' }), null);
  assert.equal(hookNote({ subtype: 'hook_response', outcome: 'success', output: '  ' }), null);
  assert.equal(
    hookNote({ subtype: 'hook_response', outcome: 'success', hook_event: 'PreToolUse', hook_name: 'lint', output: 'ok\nmore' }),
    null,
  );
  assert.equal(hookNote({ subtype: 'hook_response', outcome: 'cancelled' }), null);
  assert.equal(hookNote({ subtype: 'hook_response', outcome: 'error', exit_code: 2, stderr: 'x'.repeat(300) }), null);
  assert.equal(hookNote({ subtype: 'hook_response', outcome: 'error', exit_code: null }), null);
});

test('tool-result text fields are validated while raw metadata keeps its serialized meaning', () => {
  const { tr, items } = mk();
  tr.beginTurn('turn');
  tr.onMessage(asst([use('Bash', { command: 'echo kept' }, 'b')]));
  tr.onMessage(userMsg([result('b', [{ type: 'text', text: 42 }, { type: 'text', text: 'Kept' }, null, { extra: 1 }])]));
  assert.equal(items('item/completed')[0].aggregatedOutput, 'Kept\nnull\n{"extra":1}');
});

test('Claude stream translation never emits non-string text or thinking deltas', () => {
  const { tr, events } = mk();
  tr.beginTurn('turn');
  tr.onMessage({ type: 'stream_event', event: { type: 'message_start', message: { id: 'm' } } });
  for (const value of [undefined, null, 42, false, [], { toString: 'not callable' }]) {
    tr.onMessage({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } } });
    tr.onMessage({
      type: 'stream_event',
      event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: value } },
    });
  }
  assert.equal(events.filter(([method]) => method.includes('Delta') || method.endsWith('/delta')).length, 0);
  tr.onMessage({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Kept' } } });
  tr.onMessage({ type: 'stream_event', event: { type: 'content_block_delta', index: 1, delta: { type: 'thinking_delta', thinking: '' } } });
  assert.deepEqual(
    events.filter(([method]) => method.includes('Delta') || method.endsWith('/delta')).map(([, p]) => p.delta),
    ['Kept', ''],
  );
});

test('replay ignores a text block with no text and retains the following prompt', () => {
  const turns = buildTurns(
    [userMsg([{ type: 'text' }, { type: 'text', text: 'Keep this prompt' }], { uuid: 'missing-text' })],
    'chat',
    '/repo',
  );
  assert.equal(turns.length, 1);
  assert.deepEqual(turns[0].items[0], {
    type: 'userMessage',
    id: 'missing-text',
    clientId: null,
    content: [{ type: 'text', text: 'Keep this prompt', text_elements: [] }],
  });
});

test('a dropped steer completes only a turn whose remaining results are already done', () => {
  const { tr, events } = mk();
  tr.dropSteer();
  assert.equal(events.length, 0);
  tr.beginTurn('turn');
  tr.addSteer();
  tr.dropSteer();
  assert.equal(tr.turnId, 'turn');
  tr.addSteer();
  tr.onMessage({ type: 'result', subtype: 'success' });
  assert.equal(tr.turnId, 'turn');
  tr.dropSteer();
  assert.equal(tr.turnId, null);
  assert.equal(events.filter(([method]) => method === 'turn/completed').length, 1);
  tr.beginTurn('interrupted');
  tr.markInterrupted();
  tr.dropSteer();
  assert.equal(tr.turnId, 'interrupted');
  tr.onMessage({ type: 'result', subtype: 'success' });
  assert.equal(events.at(-1)?.[1].turn.status, 'interrupted');
});

test('empty assistant text completes an empty item and missing reasoning stays quiet', () => {
  const { tr, items } = mk();
  tr.beginTurn('turn');
  tr.onMessage(asst([{ type: 'text' }, { type: 'thinking' }, { type: 'redacted_thinking' }]));
  assert.deepEqual(
    items('item/completed').map((item) => [item.type, item.text]),
    [['agentMessage', '']],
  );
});
