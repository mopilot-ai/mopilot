// A Codex turn's items as the ACP updates the app draws (host/src/codexItems.mjs): each item type's card, the patch of a file change, what an item heard only at its end brings, what a turn forgets when it ends. A: the item types; W: streamed and finished text, started and finished tool calls; B: items and notifications that say nothing; I: a turn that ends, an app-server that goes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createItemMapper, patchOf } from '../host/src/codexItems.mjs';

const T = 't1';
const item = (i: object, method = 'item/completed', extra: object = {}) => ({ method, p: { turnId: T, item: i, ...extra } });
/** The updates the steps make, in order; their fields are the ACP update's, which a test reads freely. */
const run = (m: ReturnType<typeof createItemMapper>, ...steps: { method: string; p: any }[]): any[] =>
  steps.flatMap(({ method, p }) => m.map(method, p).map((u) => u.update));

test('A: a patch carries a new file as added lines, a removed file as deleted lines, an update as the hunks Codex gave, each with its headers', () => {
  assert.equal(patchOf(undefined), '');
  assert.equal(
    patchOf([
      { path: '/w/new.txt', kind: { type: 'add' }, diff: 'a\nb\n' },
      { path: '/w/gone.txt', kind: { type: 'delete' }, diff: 'x' },
      { path: '/w/up.txt', kind: { type: 'update' }, diff: 'noise\n@@ -1 +1 @@\n-o\n+n\n' },
      { path: '/w/empty.txt', kind: { type: 'add' } },
      { path: '/w/odd.txt', kind: { type: 'update' }, diff: 'no hunks' },
      { path: '/w/none.txt' },
    ]),
    [
      '--- /dev/null\n+++ b//w/new.txt\n@@ -0,0 +1,2 @@\n+a\n+b',
      '--- a//w/gone.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-x',
      '--- a//w/up.txt\n+++ b//w/up.txt\n@@ -1 +1 @@\n-o\n+n\n',
      '--- /dev/null\n+++ b//w/empty.txt\n@@ -0,0 +1,0 @@',
    ].join('\n'),
  );
});

test('A: a command is an execute card that ends with its output and exit code; a declined one ends failed, without output', () => {
  const m = createItemMapper();
  const [start, end] = run(
    m,
    item({ id: 'c1', type: 'commandExecution', command: 'ls', cwd: '/w', status: 'inProgress' }, 'item/started'),
    item({ id: 'c1', type: 'commandExecution', command: 'ls', cwd: '/w', status: 'completed', aggregatedOutput: 'a\n', exitCode: 0 }),
  );
  assert.deepEqual(start, {
    sessionUpdate: 'tool_call',
    toolCallId: 'c1',
    title: 'ls',
    kind: 'execute',
    rawInput: { command: 'ls', cwd: '/w' },
    status: 'in_progress',
  });
  assert.deepEqual(end, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c1',
    content: [{ type: 'content', content: { type: 'text', text: 'a\n' } }],
    rawOutput: { exitCode: 0, output: 'a\n' },
    status: 'completed',
  });
  const [declined] = run(m, item({ id: 'c2', type: 'commandExecution', command: 'rm x', status: 'declined' }));
  assert.deepEqual(
    [declined.sessionUpdate, declined.status, declined.content, declined.rawOutput],
    ['tool_call', 'failed', undefined, { exitCode: null, output: '' }],
  );
  const [nameless] = run(m, item({ id: 'c3', type: 'commandExecution', status: 'inProgress' }, 'item/started'));
  assert.equal(nameless.title, 'Command');
});

test('A: a file change is an edit with its files and patch; an MCP call names its server and tool and ends with its result or its error; a search is a fetch', () => {
  const m = createItemMapper();
  const changes = [{ path: '/w/a.txt', kind: { type: 'add' }, diff: 'hi' }];
  const [edit, done] = run(
    m,
    item({ id: 'f1', type: 'fileChange', changes, status: 'inProgress' }, 'item/started'),
    item({ id: 'f1', type: 'fileChange', changes, status: 'completed' }),
  );
  assert.deepEqual(
    [edit.kind, edit.title, edit.locations, edit.rawInput],
    ['edit', 'Edit /w/a.txt', [{ path: '/w/a.txt' }], { paths: ['/w/a.txt'] }],
  );
  assert.match(done.rawOutput.metadata.diff, /^--- \/dev\/null\n\+\+\+ b\/\/w\/a\.txt\n@@ -0,0 \+1,1 @@\n\+hi$/);
  const [pathless] = run(
    m,
    item({ id: 'f2', type: 'fileChange', changes: [{ kind: { type: 'update' } }, { path: '/w/b' }], status: 'inProgress' }, 'item/started'),
  );
  assert.deepEqual([pathless.title, pathless.locations], ['Edit 2 files', [{ path: '/w/b' }]]);
  const [none] = run(m, item({ id: 'f3', type: 'fileChange', status: 'inProgress' }, 'item/started'));
  assert.deepEqual([none.title, none.locations], ['Edit 0 files', []]);

  const [ok, failed] = run(
    m,
    item({
      id: 'm1',
      type: 'mcpToolCall',
      server: 'sage',
      tool: 'echo',
      arguments: { a: 1 },
      status: 'completed',
      result: { content: [{ type: 'text', text: 'hi' }] },
    }),
    item({ id: 'm2', type: 'mcpToolCall', server: 's', tool: 't', status: 'failed', error: { message: 'boom' } }),
  );
  assert.deepEqual(
    [ok.title, ok.kind, ok.rawInput, ok.content, ok.status],
    ['mcp__sage__echo', 'other', { a: 1 }, [{ type: 'content', content: { type: 'text', text: 'hi' } }], 'completed'],
  );
  assert.deepEqual(
    [failed.rawInput, failed.content, failed.status, failed.rawOutput],
    [{}, [{ type: 'content', content: { type: 'text', text: 'boom' } }], 'failed', { message: 'boom' }],
  );
  const [bare] = run(m, item({ id: 'm3', type: 'mcpToolCall', server: 's', tool: 't', status: 'completed' }));
  assert.deepEqual([bare.content, bare.rawOutput], [[], null]);

  const [search] = run(m, item({ id: 'w1', type: 'webSearch', query: 'weather', status: 'inProgress' }, 'item/started'));
  assert.deepEqual([search.kind, search.title, search.rawInput], ['fetch', 'weather', { query: 'weather' }]);
  const [unnamed] = run(m, item({ id: 'w2', type: 'webSearch', status: 'inProgress' }, 'item/started'));
  assert.equal(unnamed.title, 'Web search');
  // a status Codex has not used before is still running
  const [unknown] = run(m, item({ id: 'w3', type: 'webSearch', query: 'q', status: 'someday' }, 'item/started'));
  assert.equal(unknown.status, 'in_progress');
});

test('W: the text of a message or of reasoning streams once; one heard only at its end arrives whole; an empty one says nothing', () => {
  const m = createItemMapper();
  const delta = (method: string, itemId: string, d: unknown) => ({ method, p: { turnId: T, itemId, delta: d } });
  const out = run(
    m,
    delta('item/agentMessage/delta', 'a1', 'he'),
    delta('item/agentMessage/delta', 'a1', 'llo'),
    delta('item/agentMessage/delta', 'a1', ''),
    delta('item/agentMessage/delta', 'a1', 7),
    item({ id: 'a1', type: 'agentMessage', text: 'hello' }),
    item({ id: 'a2', type: 'agentMessage', text: 'whole' }),
    item({ id: 'a3', type: 'agentMessage', text: '' }),
    item({ id: 'a4', type: 'agentMessage', text: 'x' }, 'item/started'),
    delta('item/reasoning/summaryTextDelta', 'r1', 'hm'),
    item({ id: 'r1', type: 'reasoning', summary: ['hm'] }),
    item({ id: 'r2', type: 'reasoning', summary: ['one', 'two'] }),
    item({ id: 'r3', type: 'reasoning' }),
    item({ id: 'p1', type: 'plan', text: 'the plan' }),
  );
  assert.deepEqual(
    out.map((u) => [u.sessionUpdate, u.messageId, u.content.text]),
    [
      ['agent_message_chunk', 'a1', 'he'],
      ['agent_message_chunk', 'a1', 'llo'],
      ['agent_message_chunk', 'a2', 'whole'],
      ['agent_thought_chunk', 'r1', 'hm'],
      ['agent_thought_chunk', 'r2', 'one\n\ntwo'],
      ['agent_message_chunk', 'p1', 'the plan'],
    ],
  );
});

test('W: a tool call that ends with no start arrives whole; one that started ends as an update; a turn’s end forgets them', () => {
  const m = createItemMapper();
  const cmd = (status: string) =>
    item(
      { id: 'c', type: 'commandExecution', command: 'ls', status, aggregatedOutput: 'o', exitCode: 1 },
      status === 'inProgress' ? 'item/started' : 'item/completed',
    );
  assert.deepEqual(
    run(m, cmd('failed')).map((u) => [u.sessionUpdate, u.status, u.title, u.rawOutput.exitCode]),
    [['tool_call', 'failed', 'ls', 1]],
  );
  assert.deepEqual(
    run(m, cmd('inProgress'), cmd('failed')).map((u) => u.sessionUpdate),
    ['tool_call', 'tool_call_update'],
  );
  // started, then the turn ended and the app-server restarted: the next end is whole again
  run(m, cmd('inProgress'));
  m.forget(T);
  assert.equal(run(m, cmd('completed'))[0].sessionUpdate, 'tool_call');
  run(m, cmd('inProgress'));
  m.reset();
  assert.equal(run(m, cmd('completed'))[0].sessionUpdate, 'tool_call');
});

test('A: the plan carries its steps and their states, and token usage the context in use and the window', () => {
  const m = createItemMapper();
  const [plan] = run(m, {
    method: 'turn/plan/updated',
    p: { turnId: T, plan: [{ step: 'a', status: 'inProgress' }, { step: 'b', status: 'pending' }, { step: 'c', status: 'weird' }, {}] },
  });
  assert.deepEqual(plan, {
    sessionUpdate: 'plan',
    entries: [
      { content: 'a', status: 'in_progress', priority: 'medium' },
      { content: 'b', status: 'pending', priority: 'medium' },
      { content: 'c', status: 'pending', priority: 'medium' },
      { content: '', status: 'pending', priority: 'medium' },
    ],
  });
  assert.deepEqual(run(m, { method: 'turn/plan/updated', p: { turnId: T } })[0].entries, []);
  const usage = (tokenUsage: object, extra: object = {}) => ({
    method: 'thread/tokenUsage/updated',
    p: { turnId: T, tokenUsage, ...extra },
  });
  assert.deepEqual(run(m, usage({ total: { totalTokens: 900 }, last: { totalTokens: 42 }, modelContextWindow: 1000 })), [
    { sessionUpdate: 'usage_update', used: 42, size: 1000 },
  ]);
  assert.deepEqual(run(m, usage({ total: { totalTokens: 900 } })), [{ sessionUpdate: 'usage_update', used: 900, size: null }]);
  assert.deepEqual(run(m, usage({})), []);
  assert.deepEqual(run(m, { method: 'thread/tokenUsage/updated', p: {} }), []);
  assert.deepEqual(run(m, { method: 'thread/tokenUsage/updated', p: { turnId: T } }), []);
});

test('B: a report that names no turn takes the turn open now, or says nothing; errors, names and unknown notifications say nothing, and an error that will not be retried is kept for a turn that fails without one', () => {
  const m = createItemMapper();
  const usage = { method: 'thread/tokenUsage/updated', p: { tokenUsage: { last: { totalTokens: 5 } } } };
  assert.deepEqual(m.map(usage.method, usage.p), []);
  assert.deepEqual(
    m.map(usage.method, usage.p, () => 't9').map((u) => u.turnId),
    ['t9'],
  );
  for (const [method, p] of [
    ['error', { turnId: T, error: { message: 'retrying' }, willRetry: true }],
    ['error', { turnId: T }],
    ['thread/name/updated', { turnId: T, threadName: 'x' }],
    ['item/completed', { turnId: T, item: { id: 'x', type: 'userMessage' } }],
    ['item/completed', { turnId: T }],
    ['turn/diff/updated', { turnId: T }],
  ] as const)
    assert.deepEqual(m.map(method, p), [], method);
  assert.equal(m.errorOf(T), undefined);
  m.map('error', { turnId: T, error: { message: 'out of credits' }, willRetry: false });
  assert.equal(m.errorOf(T), 'out of credits');
  m.forget(T);
  assert.equal(m.errorOf(T), undefined);
});

test('#4003: a finished compaction item is told once as a compaction update; one that has only started says nothing', () => {
  const m = createItemMapper();
  assert.deepEqual(m.map('item/started', { turnId: 't1', item: { id: 'cp1', type: 'contextCompaction' } }), []);
  assert.deepEqual(m.map('item/completed', { turnId: 't1', item: { id: 'cp1', type: 'contextCompaction', trigger: 'auto' } }), [
    { turnId: 't1', update: { sessionUpdate: 'compaction', id: 'cp1', trigger: 'auto' } },
  ]);
  assert.equal((m.map('item/completed', { turnId: 't1', item: { id: 'cp2', type: 'contextCompaction' } })[0].update as any).trigger, null);
  assert.deepEqual(m.map('item/completed', { turnId: 't1', item: { type: 'contextCompaction' } }), []);
});
