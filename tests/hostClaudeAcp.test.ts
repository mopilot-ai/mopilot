// Claude Code's SDK messages as ACP session updates (host/src/claudeAcp.mjs): every tool's card, results of every shape, the plan, thinking, sub-agent calls and how a turn's result ends it (B: messages of every shape).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acpUsage, createClaudeAcp } from '../host/src/claudeAcp.mjs';

const use = (name: string, input: any, id = `tu-${name}`, parent: string | null = null) => ({
  type: 'assistant',
  ...(parent ? { parent_tool_use_id: parent } : {}),
  message: { id: `m-${id}`, content: [{ type: 'tool_use', id, name, input }] },
});
const result = (id: string, content: any, extra: any = {}, parent: string | null = null) => ({
  type: 'user',
  ...(parent ? { parent_tool_use_id: parent } : {}),
  message: { content: [{ type: 'tool_result', tool_use_id: id, content, ...extra }] },
});
/** The one tool_call update a tool_use makes. */
const call = (name: string, input: any) => createClaudeAcp().message(use(name, input))[0] as any;

test('B: each tool is a card of its kind, titled as a person would say it, with the file it names', () => {
  const cases: [string, any, string, string, string?][] = [
    ['Bash', { command: 'npm test' }, 'execute', 'npm test'],
    ['Bash', {}, 'execute', 'Run a command'],
    ['Read', { file_path: '/a.ts' }, 'read', 'Read /a.ts', '/a.ts'],
    ['Read', {}, 'read', 'Read a file'],
    ['NotebookRead', { notebook_path: '/n.ipynb' }, 'read', 'Read /n.ipynb', '/n.ipynb'],
    ['Write', { file_path: '/w.ts', content: 'x' }, 'edit', 'Write /w.ts', '/w.ts'],
    ['Write', {}, 'edit', 'Write a file'],
    ['Edit', { file_path: '/e.ts' }, 'edit', 'Edit /e.ts', '/e.ts'],
    ['Edit', {}, 'edit', 'Edit a file'],
    ['MultiEdit', { path: '/m.ts' }, 'edit', 'Edit /m.ts', '/m.ts'],
    ['NotebookEdit', { notebook_path: '/n.ipynb' }, 'edit', 'Edit /n.ipynb', '/n.ipynb'],
    ['Grep', { pattern: 'foo' }, 'search', 'grep foo'],
    ['Grep', {}, 'search', 'grep'],
    ['Glob', { pattern: '*.ts' }, 'search', 'Find *.ts'],
    ['Glob', {}, 'search', 'Find files'],
    ['LS', { path: '/src' }, 'search', 'List /src', '/src'],
    ['LS', {}, 'search', 'List a folder'],
    ['WebFetch', { url: 'https://x.test' }, 'fetch', 'Fetch https://x.test'],
    ['WebFetch', {}, 'fetch', 'Fetch a page'],
    ['WebSearch', { query: 'cats' }, 'fetch', 'cats'],
    ['WebSearch', {}, 'fetch', 'Search the web'],
    ['Task', { description: 'dig' }, 'think', 'dig'],
    ['Agent', {}, 'think', 'Sub-agent'],
    ['ExitPlanMode', { plan: 'p' }, 'switch_mode', 'ExitPlanMode'],
    ['mcp__srv__tool', { a: 1 }, 'other', 'mcp__srv__tool'],
  ];
  for (const [name, input, kind, title, path] of cases) {
    const u = call(name, input);
    assert.equal(u.sessionUpdate, 'tool_call');
    assert.deepEqual([u.kind, u.title, u.status, u.toolCallId], [kind, title, 'in_progress', `tu-${name}`], name);
    assert.deepEqual(u.locations, path ? [{ path }] : undefined, name);
    assert.equal(u._meta.claudeCode.toolName, name);
    assert.deepEqual(u.rawInput, input);
  }
});

test('B: a file written whole does not make a frame of megabytes: long input strings are cut and short ones are kept', () => {
  const u = call('Write', { file_path: '/big.txt', content: 'x'.repeat(256_040), mode: 'w' });
  assert.equal(u.rawInput.file_path, '/big.txt');
  assert.equal(u.rawInput.mode, 'w');
  assert.match(u.rawInput.content, /\[40 more characters not shown\]$/);
  assert.equal(u.rawInput.content.length < 256_100, true);
});

test('B: a tool call with no input object still has a card, a MultiEdit shows its edits as diffs, and a sub-agent’s call names its parent', () => {
  const noInput = createClaudeAcp().message({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: 't', name: 'Bash', input: 'oops' }] },
  })[0] as any;
  assert.deepEqual(noInput.rawInput, {});
  const multi = call('MultiEdit', { file_path: '/m.ts', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'c' }, 'junk'] });
  assert.deepEqual(multi.content, [
    { type: 'diff', path: '/m.ts', oldText: 'a', newText: 'b' },
    { type: 'diff', path: '/m.ts', oldText: 'c', newText: '' },
  ]);
  assert.equal(call('MultiEdit', { file_path: '/m.ts' }).content, undefined);
  assert.equal(call('MultiEdit', { edits: [] }).content, undefined, 'no file, no diffs');
  const nested = createClaudeAcp().message(use('Read', { file_path: '/x' }, 'tu-child', 'tu-parent'))[0] as any;
  assert.equal(nested._meta.claudeCode.parentToolUseId, 'tu-parent');
  // a block without an id is not a call
  assert.deepEqual(
    createClaudeAcp().message({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } }),
    [],
  );
});

test('B: the todo list is the plan, with unknown statuses pending; a sub-agent’s is an ordinary call', () => {
  const t = createClaudeAcp();
  const plan = t.message(
    use('TodoWrite', { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'weird' }, { status: 'pending' }, 'junk'] }),
  )[0] as any;
  assert.deepEqual(plan, {
    sessionUpdate: 'plan',
    entries: [
      { content: 'a', priority: 'medium', status: 'completed' },
      { content: 'b', priority: 'medium', status: 'pending' },
    ],
  });
  // its result is not a card of its own
  assert.deepEqual(t.message(result('tu-TodoWrite', 'ok')), []);
  assert.equal((t.message(use('TodoWrite', { todos: [] }, 'tu-sub', 'tu-parent'))[0] as any).sessionUpdate, 'tool_call');
  assert.equal((t.message(use('TodoWrite', 'not a list'))[0] as any).sessionUpdate, 'tool_call');
});

test('B: a result completes or fails the call it answers: text and images shown, the rest cut or left out, and only once', () => {
  const t = createClaudeAcp();
  t.message(use('Bash', { command: 'x' }, 'a'));
  const big = 'x'.repeat(64_050);
  const got = t.message(
    result('a', [
      { type: 'text', text: 'out' },
      { type: 'text', text: '' },
      { type: 'text', text: big },
      { type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/jpeg' } },
      { type: 'image', source: { type: 'base64', data: 'B'.repeat(1_500_001) } },
      { type: 'image', source: { type: 'url', url: 'https://x' } },
      { type: 'document' },
      null,
    ]),
  )[0] as any;
  assert.equal(got.status, 'completed');
  assert.equal(got.content.length, 4);
  assert.equal(got.content[0].content.text, 'out');
  assert.match(got.content[1].content.text, /\[50 more characters not shown\]$/);
  assert.deepEqual(got.content[2].content, { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' });
  assert.equal(got.content[3].content.text, '[an image too large to show]');
  assert.match(got.rawOutput.output, /^out\n/);
  assert.deepEqual(t.message(result('a', 'again')), [], 'told once');
  // a failure, an image with no type, an empty result and one of an unknown call
  t.message(use('Bash', { command: 'y' }, 'b'));
  t.message(use('Bash', { command: 'z' }, 'c'));
  t.message(use('Bash', { command: 'w' }, 'd'));
  const failed = t.message(result('b', 'boom', { is_error: true }, 'tu-parent'))[0] as any;
  assert.deepEqual([failed.status, failed._meta.claudeCode.parentToolUseId], ['failed', 'tu-parent']);
  const bare = t.message(result('c', [{ type: 'image', source: { type: 'base64', data: 'CC' } }]))[0] as any;
  assert.equal(bare.content[0].content.mimeType, 'image/png');
  const empty = t.message(result('d', 42))[0] as any;
  assert.equal(empty.content, undefined);
  assert.deepEqual(empty.rawOutput, { output: '' });
  assert.deepEqual(t.message(result('nobody', 'x')), []);
  assert.deepEqual(t.message({ type: 'user', message: { content: 'plain text' } }), []);
  assert.deepEqual(t.message({ type: 'user', message: { content: [{ type: 'text', text: 'hi' }, null] } }), []);
});

test('B: words and thoughts stream by message, arrive whole when not streamed, and a sub-agent’s carry the call they belong to', () => {
  const t = createClaudeAcp();
  const stream = (event: any, extra = {}) => ({ type: 'stream_event', event, ...extra });
  t.message(stream({ type: 'message_start', message: {} }));
  assert.deepEqual(t.message(stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } })), [
    { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hm' } },
  ]);
  const t2 = createClaudeAcp();
  t2.message(stream({ type: 'message_start', message: { id: 'm1' } }));
  assert.equal(
    (t2.message(stream({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hm' } }))[0] as any).messageId,
    'm1',
  );
  assert.equal((t2.message(stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'hi' } }))[0] as any).messageId, 'm1');
  assert.deepEqual(t2.message(stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: '' } })), []);
  // a sub-agent's words are told with their call (#4 of the Host stream gaps), in message ids of their own
  const child = (event: any) => stream(event, { parent_tool_use_id: 'p' });
  t2.message(child({ type: 'message_start', message: { id: 'sub1' } }));
  assert.deepEqual(t2.message(child({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'x' } })), [
    {
      sessionUpdate: 'agent_message_chunk',
      messageId: 'sub1',
      content: { type: 'text', text: 'x' },
      _meta: { claudeCode: { parentToolUseId: 'p' } },
    },
  ]);
  assert.deepEqual(t2.message(child({ type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'y' } })), [
    {
      sessionUpdate: 'agent_thought_chunk',
      messageId: 'sub1',
      content: { type: 'text', text: 'y' },
      _meta: { claudeCode: { parentToolUseId: 'p' } },
    },
  ]);
  // the chat's own message id is not disturbed by a sub-agent's
  assert.equal(
    (t2.message(stream({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'again' } }))[0] as any).messageId,
    'm1',
  );
  // a sub-agent delta before its message_start has no id (and still carries the call)
  assert.equal(
    (createClaudeAcp().message(child({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'z' } }))[0] as any).messageId,
    undefined,
  );
  assert.deepEqual(t2.message(stream({ type: 'content_block_delta', delta: { type: 'signature_delta' } })), []);
  assert.deepEqual(t2.message(stream({ type: 'content_block_delta', delta: { type: 'thinking_delta' } })), []);
  assert.deepEqual(t2.message(stream({ type: 'content_block_delta', delta: { type: 'text_delta' } })), []);
  // the streamed message's blocks are not told again; another message's are
  const whole = (id: string | undefined, content: any[], parent?: string) => ({
    type: 'assistant',
    ...(parent ? { parent_tool_use_id: parent } : {}),
    message: { ...(id ? { id } : {}), content },
  });
  assert.deepEqual(
    t2.message(
      whole('m1', [
        { type: 'text', text: 'hi' },
        { type: 'thinking', thinking: 'hm' },
      ]),
    ),
    [],
  );
  const other = t2.message(
    whole('m2', [
      { type: 'thinking', thinking: 'deep' },
      { type: 'text', text: 'ok' },
      { type: 'text' },
      { type: 'thinking' },
      { type: 'redacted_thinking' },
      null,
    ]),
  );
  assert.deepEqual(
    other.map((u: any) => [u.sessionUpdate, u.content.text, u.messageId]),
    [
      ['agent_thought_chunk', 'deep', 'm2'],
      ['agent_message_chunk', 'ok', 'm2'],
    ],
  );
  assert.equal((t2.message(whole(undefined, [{ type: 'text', text: 'no id' }]))[0] as any).messageId, undefined);
  // a sub-agent's whole message is told too, unless its deltas already were
  assert.deepEqual(t2.message(whole('sub1', [{ type: 'text', text: 'x' }], 'p')), []);
  const subWhole = t2.message(
    whole(
      'sub2',
      [
        { type: 'thinking', thinking: 'plan' },
        { type: 'text', text: 'done' },
      ],
      'p',
    ),
  ) as any[];
  assert.deepEqual(
    subWhole.map((u) => [u.sessionUpdate, u.content.text, u._meta.claudeCode.parentToolUseId]),
    [
      ['agent_thought_chunk', 'plan', 'p'],
      ['agent_message_chunk', 'done', 'p'],
    ],
  );
  assert.deepEqual(
    t2
      .message(
        whole(
          'm3',
          [
            { type: 'text', text: 'sub' },
            { type: 'thinking', thinking: 'sub' },
          ],
          'p',
        ),
      )
      .map((u: any) => [u.sessionUpdate, u.messageId, u._meta.claudeCode.parentToolUseId]),
    [
      ['agent_message_chunk', 'm3', 'p'],
      ['agent_thought_chunk', 'm3', 'p'],
    ],
  );
  assert.deepEqual(t2.message({ type: 'assistant', message: { content: 'not blocks' } }), []);
  assert.deepEqual(t2.message({ type: 'system', subtype: 'init' }), []);
  assert.deepEqual(t2.message(null), []);
  assert.deepEqual(t2.message('x'), []);
});

test('B: a result ends the turn: its failure, its tokens and the context the last message used', () => {
  const none = createClaudeAcp();
  assert.deepEqual(none.summary(), { failure: null, signal: null, usage: undefined, context: null });
  const ok = createClaudeAcp();
  ok.message({
    type: 'assistant',
    message: {
      id: 'a',
      content: [],
      usage: { input_tokens: 5, output_tokens: 1, cache_read_input_tokens: 4, cache_creation_input_tokens: 2 },
    },
  });
  ok.message({ type: 'assistant', parent_tool_use_id: 'p', message: { id: 'b', content: [], usage: { input_tokens: 999 } } });
  ok.message({
    type: 'result',
    subtype: 'success',
    is_error: false,
    usage: { input_tokens: 7, output_tokens: 3 },
    modelUsage: { a: { contextWindow: 200 }, b: { contextWindow: 1000 }, c: {}, d: null },
  });
  assert.deepEqual(ok.summary(), {
    failure: null,
    signal: null,
    usage: { inputTokens: 7, outputTokens: 3, totalTokens: 10, cachedReadTokens: 0, cachedWriteTokens: 0, model: 'a' },
    context: { used: 12, size: 1000 },
  });
  // no window known: no context figure
  const unknown = createClaudeAcp();
  unknown.message({ type: 'assistant', message: { content: [], usage: { input_tokens: 5 } } });
  unknown.message({ type: 'result', subtype: 'success', modelUsage: {} });
  assert.equal(unknown.summary().context, null);
  const failure = (m: any) => {
    const t = createClaudeAcp();
    t.message({ type: 'result', ...m });
    return t.summary().failure;
  };
  assert.equal(failure({ is_error: true, result: 'Credit balance is too low' }), 'Credit balance is too low');
  assert.equal(failure({ subtype: 'error_max_turns', errors: ['too many', 7, 'turns'] }), 'too many\nturns');
  assert.equal(failure({ subtype: 'error_during_execution', errors: [] }), 'error_during_execution');
  assert.equal(failure({ is_error: true }), 'The turn failed.');
  assert.equal(failure({ subtype: 'success', is_error: false, result: 'fine' }), null);
});

test('B: usage figures are counted in ACP’s names and a record that is not usage is none', () => {
  assert.deepEqual(acpUsage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 }), {
    inputTokens: 1,
    outputTokens: 2,
    totalTokens: 10,
    cachedReadTokens: 3,
    cachedWriteTokens: 4,
  });
  assert.equal(acpUsage({ input_tokens: -1, output_tokens: Number.NaN, cache_read_input_tokens: '5' })?.totalTokens, 0);
  assert.equal(acpUsage(null), undefined);
  assert.equal(acpUsage([1]), undefined);
});

test('#4003: the CLI’s compact boundary is told once as a compaction update', () => {
  const t = createClaudeAcp();
  assert.deepEqual(t.message({ type: 'system', subtype: 'compact_boundary', session_id: 's1', compact_metadata: { trigger: 'auto' } }), [
    { sessionUpdate: 'compaction', id: 's1', trigger: 'auto' },
  ]);
  assert.deepEqual(t.message({ type: 'system', subtype: 'compact_boundary' }), [{ sessionUpdate: 'compaction', id: null, trigger: null }]);
  assert.deepEqual(t.message({ type: 'system', subtype: 'init' }), []);
});
