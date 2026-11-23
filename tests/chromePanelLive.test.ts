// Chrome's side panel following a chat live (capabilities/browser/chromePanelLive.cjs): each harness's events read as reply text or a change, the watch that sends them, a chat's turns as rows, and the controller's tap that feeds it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  liveOf,
  PanelWatch,
  rowsOf,
  stepOf,
  WATCH_MS,
  CHANGED_MS,
  MAX_ROWS,
  MAX_TOTAL,
  MAX_COMMAND,
} = require('../electron/capabilities/browser/chromePanelLive.cjs');

const chatOf = (key: string) => `chat-of-${key}`;

test('each harness’s reply text streams, and what moves its turn on is a change to read', () => {
  // Codex: app-server notifications by thread
  assert.deepEqual(liveOf('codex', { method: 'item/agentMessage/delta', params: { threadId: 't1', delta: 'Hel' } }, chatOf), {
    chatId: 'chat-of-t1',
    text: 'Hel',
  });
  for (const method of ['item/started', 'item/completed', 'turn/started', 'turn/completed'])
    assert.deepEqual(liveOf('codex', { method, params: { threadId: 't1' } }, chatOf), { chatId: 'chat-of-t1', changed: true }, method);
  assert.equal(liveOf('codex', { method: 'thread/tokenUsage/updated', params: { threadId: 't1' } }, chatOf), null);
  assert.equal(liveOf('codex', { method: 'item/agentMessage/delta', params: { delta: 'x' } }, chatOf), null, 'no thread');
  assert.equal(liveOf('codex', { method: 'item/agentMessage/delta', params: { threadId: 't1', delta: 5 } }, chatOf)?.text, undefined);
  assert.equal(liveOf('codex', {}, chatOf), null);
  // Claude Code: the CLI's stream events by session
  const claude = (msg: any) => liveOf('claude', { key: 'claude:s', kind: 'message', msg }, chatOf);
  assert.deepEqual(claude({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hi' } } }), {
    chatId: 'chat-of-claude:s',
    text: 'Hi',
  });
  assert.equal(
    claude({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'input_json_delta', partial_json: '{' } } }),
    null,
  );
  assert.equal(claude({ type: 'stream_event', event: { type: 'message_start' } }), null);
  assert.equal(claude({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 1 } } }), null);
  // a sub-agent's own messages are not the chat's reply
  assert.equal(
    claude({
      type: 'stream_event',
      parent_tool_use_id: 'x',
      event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } },
    }),
    null,
  );
  for (const type of ['assistant', 'user', 'result'])
    assert.deepEqual(claude({ type }), { chatId: 'chat-of-claude:s', changed: true }, type);
  assert.equal(claude({ type: 'system' }), null);
  assert.equal(liveOf('claude', { key: 'claude:s', kind: 'transcript' }, chatOf), null);
  // ACP: session updates, and the turn's start and end
  const acp = (e: any) => liveOf('acp', { key: 'acp:gemini:x', ...e }, chatOf);
  assert.deepEqual(acp({ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Yo' } } }), {
    chatId: 'chat-of-acp:gemini:x',
    text: 'Yo',
  });
  assert.equal(acp({ kind: 'update', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'image' } } }), null);
  assert.equal(acp({ kind: 'update', update: { sessionUpdate: 'agent_message_chunk' } }), null);
  for (const sessionUpdate of ['tool_call', 'tool_call_update'])
    assert.deepEqual(acp({ kind: 'update', update: { sessionUpdate } }), { chatId: 'chat-of-acp:gemini:x', changed: true });
  assert.equal(acp({ kind: 'update', update: { sessionUpdate: 'plan' } }), null);
  assert.equal(acp({ kind: 'update' }), null);
  for (const kind of ['turnStart', 'turnEnd']) assert.deepEqual(acp({ kind }), { chatId: 'chat-of-acp:gemini:x', changed: true });
  assert.equal(acp({ kind: 'state' }), null);
});

test('the watch sends a watched chat’s text at once and one change per burst; others, and a lapsed watch, send nothing', () => {
  let now = 1000;
  const timers: any[] = [];
  const pushed: any[] = [];
  const w = new PanelWatch({
    chatOf: (k: string) => k,
    push: (e: any) => pushed.push(e),
    now: () => now,
    timers: {
      setTimeout: (f: Function, ms: number) => (timers.push({ f, ms }), timers.length),
    },
  });
  const delta = (threadId: string, d: string) => w.event('codex', { method: 'item/agentMessage/delta', params: { threadId, delta: d } });
  const done = (threadId: string) => w.event('codex', { method: 'item/completed', params: { threadId } });
  delta('a', 'x');
  done('a');
  w.event('codex', { method: 'nothing', params: { threadId: 'a' } });
  assert.equal(pushed.length, 0, 'not watched');
  w.watch('a');
  delta('a', 'Hel');
  delta('a', '');
  delta('a', 'lo');
  done('a');
  done('a');
  assert.deepEqual(pushed, [
    { kind: 'delta', chatId: 'a', text: 'Hel' },
    { kind: 'delta', chatId: 'a', text: 'lo' },
  ]);
  assert.equal(timers.length, 1, 'one read for the burst');
  assert.equal(timers[0].ms, CHANGED_MS);
  timers[0].f();
  assert.deepEqual(pushed.at(-1), { kind: 'changed', chatId: 'a' });
  done('a');
  assert.equal(timers.length, 2, 'a later change is its own read');
  // the panel stopped reading the chat (closed without saying so): its watch lapses
  now += WATCH_MS + 1;
  delta('a', 'late');
  delta('a', 'later');
  assert.equal(pushed.filter((e) => e.text === 'late' || e.text === 'later').length, 0);
  // a lapsed watch goes when another starts
  w.watch('c');
  assert.deepEqual([...w.watched.keys()], ['c']);
  // one still watched stays
  w.watch('d');
  assert.deepEqual([...w.watched.keys()], ['c', 'd']);
  // the default clock and timers
  const plain = new PanelWatch({ chatOf: (k: string) => k, push: () => undefined });
  plain.watch('b');
  assert.ok(plain.watched.get('b') > Date.now());
});

test('a chat’s turns as rows: what the user said, the replies, and each step in one line', () => {
  const turns = [
    {
      items: [
        {
          type: 'userMessage',
          content: [
            { type: 'text', text: 'Find flights' },
            { type: 'image', url: 'x' },
            { type: 'text', text: 'to Tokyo' },
          ],
        },
        { type: 'reasoning', text: 'thinking' },
        { type: 'commandExecution', command: 'ls' },
        { type: 'webSearch', query: 'flights' },
        { type: 'agentMessage', text: 'Here are three.' },
        { type: 'agentMessage', text: '   ' },
        null,
        'x',
      ],
    },
    { items: [{ type: 'userMessage', content: [] }, { type: 'userMessage' }, { type: 'agentMessage', text: 7 }] },
    null,
    { items: 'nope' },
  ];
  assert.deepEqual(rowsOf(turns).rows, [
    { role: 'user', text: 'Find flights\nto Tokyo', images: 1 },
    { role: 'step', text: 'Ran ls', detail: 'Input (preview)\n"ls"' },
    { role: 'step', text: 'Searched for flights' },
    { role: 'assistant', text: 'Here are three.' },
  ]);
  assert.deepEqual(rowsOf(null), { rows: [], clipped: false });
  const long = rowsOf([{ items: [{ type: 'agentMessage', text: 'a'.repeat(30_000) }] }]).rows[0].text;
  assert.equal(long.length, 20_001);
  assert.ok(long.endsWith('…'));
  const many = rowsOf([{ items: Array.from({ length: MAX_ROWS + 5 }, (_, i) => ({ type: 'agentMessage', text: `r${i}` })) }]);
  assert.equal(many.rows.length, MAX_ROWS);
  assert.equal(many.rows[0].text, 'r5', 'the recent end');
  assert.equal(many.clipped, true);
  const steps: [any, string | null][] = [
    [{ type: 'commandExecution' }, 'Ran a command'],
    [{ type: 'commandExecution', command: '  ' }, 'Ran a command'],
    [{ type: 'fileChange' }, 'Edited files'],
    [{ type: 'webSearch' }, 'Searched the web'],
    [{ type: 'mcpToolCall', tool: 'navigate' }, 'Opened a page'],
    [{ type: 'dynamicToolCall' }, 'Used a tool'],
    [{ type: 'collabAgentToolCall' }, 'Ran a sub-agent'],
    [{ type: 'plan' }, 'Updated the plan'],
    [{ type: 'image' }, null],
  ];
  for (const [item, line] of steps) assert.equal(stepOf(item), line, item.type);
});

test('a long history keeps every turn it can: rows by count and size, never one tool-heavy turn hiding the rest', () => {
  // many turns, each with a long command and edits: all of them show, the earlier ones not cut for their raw size
  const turn = (i: number) => ({
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: `q${i}` }] },
      { type: 'commandExecution', command: `python3 -c "${'x'.repeat(5_000)}"` },
      { type: 'fileChange', changes: [{ path: '/a/bookings.md', kind: { type: 'update' }, diff: 'y'.repeat(20_000) }] },
      { type: 'agentMessage', text: `a${i}` },
    ],
  });
  const all = rowsOf(Array.from({ length: 40 }, (_, i) => turn(i)));
  assert.equal(all.clipped, false);
  assert.equal(all.rows.length, 160);
  assert.deepEqual(
    all.rows.slice(0, 4).map((r: any) => r.text),
    ['q0', `Ran python3 -c "${'x'.repeat(MAX_COMMAND - 12)}…`, 'Edited bookings.md', 'a0'],
  );
  // past the size budget: the recent end, and what was left out is said
  const big = 'b'.repeat(19_000);
  const sized = rowsOf([{ items: Array.from({ length: 30 }, (_, i) => ({ type: 'agentMessage', text: `${i}${big}` })) }]);
  assert.equal(sized.clipped, true);
  assert.equal(sized.rows.length, Math.floor(MAX_TOTAL / (big.length + 2)));
  assert.ok(sized.rows.at(-1).text.startsWith('29'));
});

test('a step reads in one short line: a command by its description or its first line, an edit by its files', () => {
  const lines: [any, string][] = [
    // the model's own description of a command, as the app's activity line says it
    [{ type: 'commandExecution', command: 'grep -n x a', description: '  Find the note  ' }, 'Find the note'],
    [{ type: 'commandExecution', command: 'ls', description: ' ' }, 'Ran ls'],
    // Codex's shell wrapper left out; a command of several lines by its first, marked as cut
    [{ type: 'commandExecution', command: '/bin/zsh -lc "cd /tmp && ls"' }, 'Ran cd /tmp && ls'],
    [{ type: 'commandExecution', command: 'cd /tmp\npython3 run.py' }, 'Ran cd /tmp …'],
    [{ type: 'commandExecution', command: 'a'.repeat(MAX_COMMAND + 1) }, `Ran ${'a'.repeat(MAX_COMMAND)}…`],
    [{ type: 'commandExecution', command: 'a'.repeat(MAX_COMMAND) }, `Ran ${'a'.repeat(MAX_COMMAND)}`],
    // an edit names its files (once each, Windows paths too), then how many more
    [{ type: 'fileChange', changes: [{ path: '/a/b.md', kind: { type: 'update' } }, { path: '/a/b.md' }] }, 'Edited b.md'],
    [
      { type: 'fileChange', changes: [{ path: 'C:\\x\\map.html', kind: { type: 'update' } }, { path: '/a/b.md' }] },
      'Edited map.html, b.md',
    ],
    [
      { type: 'fileChange', changes: ['/a/1.md', '/a/2.md', '/a/3.md', '/a/4.md'].map((path) => ({ path, kind: { type: 'update' } })) },
      'Edited 1.md, 2.md and 2 more',
    ],
    [{ type: 'fileChange', changes: [{ path: '/a/new.md', kind: { type: 'add' } }] }, 'Created new.md'],
    [{ type: 'fileChange', changes: [{ path: 7 }, null, { path: '/' }] }, 'Edited files'],
    [{ type: 'fileChange', changes: 'nope' }, 'Edited files'],
    [{ type: 'fileChange', changes: [null] }, 'Edited files'],
    [{ type: 'fileChange', changes: [{ path: 'plain.md', kind: { type: 'add' } }, null] }, 'Edited plain.md'],
  ];
  for (const [item, line] of lines) assert.equal(stepOf(item), line, JSON.stringify(item));
});

test('a browser or desktop tool call reads as what it did, not "Used computer"', () => {
  const call = (tool: string, args?: any) => stepOf({ type: 'mcpToolCall', tool, ...(args ? { arguments: args } : {}) });
  assert.deepEqual(
    ['left_click', 'double_click', 'screenshot', 'type', 'key', 'scroll', 'wait', 'zoom', 'nope'].map((action) =>
      call('computer', { action }),
    ),
    ['Clicked', 'Clicked', 'Took a screenshot', 'Typed text', 'Pressed keys', 'Scrolled', 'Waited', 'Zoomed in', 'Used the browser'],
  );
  assert.equal(call('computer'), 'Used the browser');
  // the desktop tools say it in their name, with or without app_
  assert.deepEqual(
    [call('app_click'), call('screenshot'), call('app_drag'), call('left_click')],
    ['Clicked', 'Took a screenshot', 'Dragged', 'Clicked'],
  );
  // Claude in Chrome's names end in _mcp
  assert.deepEqual(
    [call('tabs_context_mcp'), call('tabs_create_mcp'), call('get_page_text'), call('find')],
    ['Checked the open tabs', 'Opened a new tab', 'Read the page', 'Searched the page'],
  );
  assert.deepEqual(
    [
      call('navigate', { url: 'https://www.travel.americanexpress.com/en-us/x' }),
      call('navigate', { url: 'back' }),
      call('navigate', { url: 'nope' }),
      call('navigate'),
    ],
    ['Opened www.travel.americanexpress.com', 'Went back', 'Opened a page', 'Opened a page'],
  );
  // every harness's name for the same tool: an MCP prefix, a namespace, Codex's surface prefix, the legacy sage_
  assert.deepEqual(
    [
      call('chrome_navigate', { url: 'https://a.example/x' }),
      call('mcp__mopilot_chrome__computer', { action: 'screenshot' }),
      call('desktop_app_click'),
      call('sage.desktop_type'),
      call('sage_browser_find'),
      call('browser_script'),
      call('browser_batch'),
      call('mcp__x__weird'),
    ],
    [
      'Opened a.example',
      'Took a screenshot',
      'Clicked',
      'Typed text',
      'Searched the page',
      'Ran a script on the page',
      'Took several steps',
      'Used mcp__x__weird',
    ],
  );
  // a tool of anything else keeps its name; arguments that aren't an object are none
  assert.deepEqual(
    [call('constructor'), call('foo', 'x'), stepOf({ type: 'dynamicToolCall', tool: 3 })],
    ['Used constructor', 'Used foo', 'Used a tool'],
  );
});

test('a message sent from the side panel shows without its tab line, the tab apart; the chat’s account moves show as notes', () => {
  const user = (text: string) => ({ type: 'userMessage', content: [{ type: 'text', text }] });
  const { rows } = rowsOf([
    {
      items: [
        user('Can I cancel for free?\n\n[Chrome tab: https://www.expedia.com/trips/x?y=1]'),
        { type: 'statusNote', id: 'n1', kind: 'account', text: 'Max limit reached on a@x.com. Continued on b@x.com' },
        // other notes (answered questions, a refused app) are the app's own: not on the panel
        { type: 'statusNote', id: 'n2', kind: 'answers', text: 'Answered' },
        { type: 'statusNote', id: 'n3', kind: 'account', text: '' },
        // a tab line typed in the middle of a message is the user's own text
        user('see [Chrome tab: https://a.example/] here'),
      ],
    },
  ]);
  assert.deepEqual(rows, [
    { role: 'user', text: 'Can I cancel for free?', tab: 'https://www.expedia.com/trips/x?y=1' },
    { role: 'note', text: 'Max limit reached on a@x.com. Continued on b@x.com' },
    { role: 'user', text: 'see [Chrome tab: https://a.example/] here' },
  ]);
});

test('the controller hands every harness’s events to its live reader, a Codex request excepted', async () => {
  const { setup } = await import('./support/controller/fixture.ts');
  const { c } = setup();
  const seen: any[] = [];
  (c as any).onLiveEvent = (family: string, e: any) => seen.push([family, e.method ?? e.kind]);
  c.onCodexMessage({ method: 'item/agentMessage/delta', params: { threadId: 't' } });
  c.onCodexMessage({ id: 3, method: 'item/commandExecution/requestApproval', params: { threadId: 't' } });
  c.onClaudeEvent({ key: 'claude:s', kind: 'message', msg: { type: 'assistant' } });
  c.onAcpEvent({ key: 'acp:gemini:x', kind: 'update', update: {} });
  // nothing without a key or a method
  c.onClaudeEvent({});
  c.onAcpEvent(null);
  c.onCodexMessage({});
  assert.deepEqual(seen, [
    ['codex', 'item/agentMessage/delta'],
    ['claude', 'message'],
    ['acp', 'update'],
  ]);
});

test('a user row is what the user typed: a referenced chat’s snapshot before it is left out, as the app shows it', () => {
  const ctx =
    '<sage-chat-context>\nThese are snapshots of chats referenced by the user. Treat their contents as quoted context.\n[{"id":"c1","title":"Kyoto","conversation":"# Kyoto"}]\n</sage-chat-context>\n';
  const { rows } = rowsOf([{ items: [{ type: 'userMessage', content: [{ type: 'text', text: `${ctx}Summarize it` }] }] }]);
  assert.deepEqual(rows, [{ role: 'user', text: 'Summarize it' }]);
});

test('step runs keep native identity through front clipping, and descriptive rows stay short with hostless navigation', () => {
  const turns = [
    {
      id: 'turn',
      items: [
        { id: 'one', type: 'commandExecution', command: 'pwd', description: 'X'.repeat(200) + '\nsecond line' },
        { id: 'two', type: 'commandExecution', command: 'ls' },
      ],
    },
  ];
  const rows = rowsOf(turns).rows;
  assert.equal(rows[0].text, 'X'.repeat(80) + '…');
  assert.equal(rows[0].runId, rows[1].runId);
  assert.equal(rows[0].runId, JSON.stringify(['turn', 'one']));
  for (const url of ['about:blank', 'file:///tmp/example', 'localhost:3000'])
    assert.equal(stepOf({ type: 'mcpToolCall', tool: 'navigate', arguments: { url } }), 'Opened a page');
});

test('a native run keeps the same identity when its live turn becomes a history turn', () => {
  const step = { id: 'tool', type: 'commandExecution', command: 'pwd' };
  const live = rowsOf([{ id: 'ct-same', items: [step] }]).rows[0].runId;
  const history = rowsOf([{ id: 'h-same', items: [step] }]).rows[0].runId;
  assert.equal(live, history);
});

test('unrelated MCP namespaces cannot be relabelled as browser actions, and duplicate basenames still count distinct edits', () => {
  for (const [server, tool] of [
    ['notion', 'find'],
    ['maps', 'navigate'],
    ['database', 'batch'],
  ])
    assert.equal(stepOf({ type: 'mcpToolCall', server, tool, arguments: { url: 'https://maps.example' } }), `Used ${server}/${tool}`);
  assert.equal(stepOf({ type: 'mcpToolCall', tool: 'mcp__notion__find' }), 'Used mcp__notion__find');
  assert.equal(
    stepOf({ type: 'fileChange', changes: [{ path: 'src/index.js' }, { path: 'lib/index.js' }, { path: 'src/index.js' }] }),
    'Edited src/index.js, lib/index.js',
  );
});

test('tab metadata is bounded and shares the panel history character budget with message text', () => {
  const text = 'x'.repeat(20_000);
  const url = 'https://example.org/' + 'a'.repeat(5000);
  const turns = Array.from({ length: 20 }, () => ({
    items: [{ type: 'userMessage', content: [{ type: 'text', text: text + '\n\n[Chrome tab: ' + url + ']' }] }],
  }));
  const result = rowsOf(turns);
  assert.equal(result.clipped, true);
  assert.ok(result.rows.every((r: any) => r.tab.length === 2048));
  const total = result.rows.reduce((n: number, r: any) => n + r.text.length + r.tab.length, 0);
  assert.ok(total <= MAX_TOTAL);
  assert.ok(total + 20_000 + 2048 > MAX_TOTAL);
});

test('one folded run of 250 browser steps cannot evict earlier user and assistant messages from the row budget', () => {
  const result = rowsOf([
    {
      id: 'turn',
      items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'Earlier question' }] },
        { type: 'agentMessage', text: 'Earlier answer' },
        ...Array.from({ length: 250 }, (_, i) => ({ id: 'tool-' + i, type: 'mcpToolCall', tool: 'read_page' })),
        { type: 'agentMessage', text: 'Final answer' },
      ],
    },
  ]);
  assert.equal(result.clipped, false);
  assert.equal(result.rows.length, 253);
  assert.equal(result.rows[0].text, 'Earlier question');
  assert.equal(result.rows[1].text, 'Earlier answer');
  assert.equal(result.rows.at(-1).text, 'Final answer');
});

test('a 5000-step run keeps only its recent 2000 details while retaining earlier messages and stable run identity', () => {
  const result = rowsOf([
    {
      id: 'long-turn',
      items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'Earlier question' }] },
        { type: 'agentMessage', text: 'Earlier answer' },
        ...Array.from({ length: 5000 }, (_, i) => ({
          id: 'tool-' + i,
          type: 'mcpToolCall',
          tool: 'computer',
          arguments: { action: 'left_click' },
        })),
        { type: 'agentMessage', text: 'Final answer' },
      ],
    },
  ]);
  assert.equal(result.clipped, true);
  assert.equal(result.rows.length, 2003);
  assert.deepEqual(
    result.rows.slice(0, 2).map((r: any) => r.text),
    ['Earlier question', 'Earlier answer'],
  );
  assert.equal(result.rows.at(-1).text, 'Final answer');
  const steps = result.rows.filter((r: any) => r.role === 'step');
  assert.equal(steps.length, 2000);
  assert.ok(steps.every((r: any) => r.runId === JSON.stringify(['long-turn', 'tool-0'])));
});

test('canonical generated titles refresh the panel on every adapter without treating title text as a reply', () => {
  for (const family of ['codex', 'claude', 'acp']) {
    assert.deepEqual(
      liveOf(family, { kind: 'threadName', chatId: 'chat', name: 'Booking refund' }, () => 'wrong'),
      { chatId: 'chat', changed: true },
    );
  }
  assert.deepEqual(
    liveOf('codex', { method: 'thread/name/updated', params: { threadId: 'native', name: 'Renamed' } }, (id: string) => `chat:${id}`),
    { chatId: 'chat:native', changed: true },
  );
});

test('a reply streamed after a step or a finished message starts its own paragraph in the panel, on every harness (#3663)', () => {
  const pushed: any[] = [];
  const w = new PanelWatch({ chatOf: (k: string) => k, push: (e: any) => pushed.push(e), timers: { setTimeout: () => 0 } as any });
  const texts = () => pushed.filter((e) => e.kind === 'delta').map((e) => e.text);
  // Codex: a reply, a command item, the next reply
  w.watch('t');
  w.event('codex', { method: 'item/agentMessage/delta', params: { threadId: 't', delta: 'One.' } });
  w.event('codex', { method: 'item/started', params: { threadId: 't' } });
  w.event('codex', { method: 'item/completed', params: { threadId: 't' } });
  w.event('codex', { method: 'item/agentMessage/delta', params: { threadId: 't', delta: 'Two' } });
  w.event('codex', { method: 'item/agentMessage/delta', params: { threadId: 't', delta: '.' } });
  assert.deepEqual(texts(), ['One.', '\n\nTwo', '.'], 'one break per change, before the next text only');
  // Claude Code: the finished assistant message moves the turn on, then the next message streams
  pushed.length = 0;
  w.watch('k');
  const delta = (text: string) =>
    w.event('claude', {
      kind: 'message',
      key: 'k',
      msg: { type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text } } },
    });
  delta('First.');
  w.event('claude', { kind: 'message', key: 'k', msg: { type: 'assistant' } });
  delta('Second.');
  assert.deepEqual(texts(), ['First.', '\n\nSecond.']);
  // ACP: a tool call between two chunks
  pushed.length = 0;
  w.watch('a');
  const chunk = (text: string) =>
    w.event('acp', { kind: 'update', key: 'a', update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } } });
  chunk('Look.');
  w.event('acp', { kind: 'update', key: 'a', update: { sessionUpdate: 'tool_call' } });
  chunk('Found it.');
  assert.deepEqual(texts(), ['Look.', '\n\nFound it.']);
  // a change in a chat no panel watches leaves no break behind for later
  pushed.length = 0;
  w.event('codex', { method: 'item/started', params: { threadId: 'z' } });
  w.watch('z');
  w.event('codex', { method: 'item/agentMessage/delta', params: { threadId: 'z', delta: 'Hi' } });
  assert.deepEqual(texts(), ['Hi']);
});
