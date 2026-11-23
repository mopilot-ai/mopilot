// electron/session/editedPaths.cjs: the files a chat edited, from each harness's own edit items on the controller's live
// events (Codex fileChange, Claude Code's edit tools, ACP edit tool calls), counted once they completed, only for the
// chats wanted, and taken once per turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { EditedPaths, MAX_PATHS, MAX_PENDING } = require('../electron/session/editedPaths.cjs');

function collector(wanted = new Set(['kid'])) {
  return new EditedPaths({
    wanted: (id: string) => wanted.has(id),
    chatOf: (key: string) => (key === 'claude-key' || key === 'acp-key' ? 'kid' : key),
    // a sub-agent's thread belongs to its parent's chat
    requestChat: (thread: string) => (thread === 'th-kid' || thread === 'th-sub' ? 'kid' : thread),
  });
}

const fileChange = (thread: string, status: string, changes: any) => ({
  method: 'item/completed',
  params: { threadId: thread, item: { type: 'fileChange', id: 'i', status, changes } },
});

test('Codex: an applied fileChange counts each path and where a move put it, a sub-agent’s for its chat', () => {
  const c = collector();
  c.event('codex', fileChange('th-kid', 'completed', [{ path: '/repo/a.ts', kind: { type: 'update', move_path: '/repo/b.ts' } }, null]));
  c.event('codex', fileChange('th-sub', 'completed', [{ path: '/repo/c.ts', kind: { type: 'add' } }]));
  // declined, failed, still running, another item, another event, a chat not wanted, no thread, no changes
  c.event('codex', fileChange('th-kid', 'declined', [{ path: '/repo/x.ts' }]));
  c.event('codex', fileChange('th-kid', 'failed', [{ path: '/repo/x.ts' }]));
  c.event('codex', fileChange('th-kid', 'inProgress', [{ path: '/repo/x.ts' }]));
  c.event('codex', { method: 'item/completed', params: { threadId: 'th-kid', item: { type: 'agentMessage' } } });
  c.event('codex', { method: 'item/started', params: { threadId: 'th-kid', item: { type: 'fileChange', status: 'completed' } } });
  c.event('codex', fileChange('th-other', 'completed', [{ path: '/repo/x.ts' }]));
  c.event('codex', fileChange('', 'completed', [{ path: '/repo/x.ts' }]));
  c.event('codex', fileChange('th-kid', 'completed', 'not a list'));
  c.event('codex', null);
  assert.deepEqual(c.take('kid'), ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts']);
  assert.deepEqual(c.take('kid'), [], 'a take starts the next turn empty');
  assert.deepEqual(c.take('th-other'), []);
});

const claude = (type: string, content: any, extra: any = {}) => ({
  kind: 'message',
  key: 'claude-key',
  msg: { type, message: { content }, ...extra },
});

test('Claude Code: an edit tool’s path counts once its result is not an error; a sub-agent’s count too', () => {
  const c = collector();
  c.event(
    'claude',
    claude('assistant', [
      { type: 'text', text: 'editing' },
      { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/repo/a.ts' } },
      { type: 'tool_use', id: 'e2', name: 'Write', input: { path: '/repo/b.ts' } },
      { type: 'tool_use', id: 'e3', name: 'NotebookEdit', input: { notebook_path: '/repo/n.ipynb' } },
      { type: 'tool_use', id: 'e4', name: 'MultiEdit', input: { file_path: '/repo/m.ts' } },
      { type: 'tool_use', id: 'e5', name: 'Edit', input: { file_path: '/repo/denied.ts' } },
      { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/repo/read.ts' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/repo/no-id.ts' } },
      { type: 'tool_use', id: 'e6', name: 'Write' },
    ]),
  );
  assert.deepEqual(c.take('kid'), [], 'nothing counts before its result');
  c.event(
    'claude',
    claude('user', [
      { type: 'tool_result', tool_use_id: 'e1' },
      { type: 'tool_result', tool_use_id: 'e2', is_error: false },
      { type: 'tool_result', tool_use_id: 'e3' },
      { type: 'tool_result', tool_use_id: 'e5', is_error: true },
      { type: 'tool_result', tool_use_id: 'r1' },
      { type: 'tool_result', tool_use_id: 'e6' },
      { type: 'text', text: 'x' },
    ]),
  );
  // a sub-agent's result for its own edit, in a message with a parent_tool_use_id
  c.event('claude', claude('user', [{ type: 'tool_result', tool_use_id: 'e4' }], { parent_tool_use_id: 'task1' }));
  assert.deepEqual(c.take('kid'), ['/repo/a.ts', '/repo/b.ts', '/repo/n.ipynb', '/repo/m.ts']);
  // a result counts once; other events, other chats and a string content are not edits
  c.event('claude', claude('user', [{ type: 'tool_result', tool_use_id: 'e1' }]));
  c.event('claude', { kind: 'message', key: 'claude-key', msg: { type: 'assistant', message: { content: 'text' } } });
  c.event('claude', { kind: 'tasks', key: 'claude-key' });
  c.event('claude', {
    kind: 'message',
    key: 'other',
    msg: { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'z', name: 'Edit', input: { file_path: '/x' } }] } },
  });
  c.event('claude', {
    kind: 'message',
    key: 'other',
    msg: { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'z' }] } },
  });
  assert.deepEqual(c.take('kid'), []);
  assert.deepEqual(c.take('other'), []);
});

const acp = (update: any) => ({ kind: 'update', key: 'acp-key', update });

test('ACP: an edit tool call’s locations, input path and diffs count once an update says it completed', () => {
  const c = collector();
  c.event(
    'acp',
    acp({ sessionUpdate: 'tool_call', toolCallId: 't1', kind: 'edit', status: 'pending', locations: [{ path: '/repo/a.ts' }, {}] }),
  );
  c.event(
    'acp',
    acp({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'in_progress', rawInput: { filePath: '/repo/a2.ts' } }),
  );
  c.event('acp', acp({ sessionUpdate: 'tool_call_update', toolCallId: 't1', status: 'completed' }));
  // a call that says it completed at once, with a diff block and no kind
  c.event(
    'acp',
    acp({
      sessionUpdate: 'tool_call',
      toolCallId: 't2',
      status: 'completed',
      content: [{ type: 'diff', path: '/repo/d.ts', oldText: 'a', newText: 'b' }],
    }),
  );
  c.event(
    'acp',
    acp({
      sessionUpdate: 'tool_call',
      toolCallId: 't3',
      kind: 'edit',
      status: 'completed',
      rawInput: { file_path: '/repo/e.ts', path: '/repo/e2.ts' },
    }),
  );
  // a failed edit, a read, a call with no id, a plain message, another event, another chat
  c.event('acp', acp({ sessionUpdate: 'tool_call', toolCallId: 't4', kind: 'edit', locations: [{ path: '/repo/fail.ts' }] }));
  c.event('acp', acp({ sessionUpdate: 'tool_call_update', toolCallId: 't4', status: 'failed' }));
  c.event(
    'acp',
    acp({ sessionUpdate: 'tool_call', toolCallId: 't5', kind: 'read', status: 'completed', locations: [{ path: '/repo/r.ts' }] }),
  );
  c.event('acp', acp({ sessionUpdate: 'tool_call_update', toolCallId: 't6', status: 'completed' }));
  c.event('acp', acp({ sessionUpdate: 'tool_call', kind: 'edit', status: 'completed', locations: [{ path: '/repo/x.ts' }] }));
  c.event('acp', acp({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'hi' } }));
  c.event('acp', { kind: 'turnEnd', key: 'acp-key' });
  c.event('acp', {
    kind: 'update',
    key: 'elsewhere',
    update: { sessionUpdate: 'tool_call', toolCallId: 'o', kind: 'edit', status: 'completed', locations: [{ path: '/x' }] },
  });
  c.event('other-family', acp({}));
  // a delete and a move change files too
  c.event(
    'acp',
    acp({ sessionUpdate: 'tool_call', toolCallId: 't7', kind: 'delete', status: 'completed', locations: [{ path: '/repo/gone.ts' }] }),
  );
  c.event(
    'acp',
    acp({
      sessionUpdate: 'tool_call',
      toolCallId: 't8',
      kind: 'move',
      status: 'completed',
      locations: [{ path: '/repo/from.ts' }, { path: '/repo/to.ts' }],
    }),
  );
  assert.deepEqual(c.take('kid'), [
    '/repo/a.ts',
    '/repo/a2.ts',
    '/repo/d.ts',
    '/repo/e.ts',
    '/repo/e2.ts',
    '/repo/gone.ts',
    '/repo/from.ts',
    '/repo/to.ts',
  ]);
  assert.deepEqual(c.take('elsewhere'), []);
});

test('a call still running at a turn’s end counts in the next take; what one chat keeps and waits on is bounded', () => {
  const c = collector();
  c.event('acp', acp({ sessionUpdate: 'tool_call', toolCallId: 'slow', kind: 'edit', locations: [{ path: '/repo/slow.ts' }] }));
  assert.deepEqual(c.take('kid'), []);
  c.event('acp', acp({ sessionUpdate: 'tool_call_update', toolCallId: 'slow', status: 'completed' }));
  assert.deepEqual(c.take('kid'), ['/repo/slow.ts']);
  const many = Array.from({ length: MAX_PATHS + 5 }, (_, i) => ({ path: `/repo/f${i}.ts` }));
  c.event('codex', fileChange('th-kid', 'completed', many));
  assert.equal(c.take('kid').length, MAX_PATHS);
  for (let i = 0; i <= MAX_PENDING; i++)
    c.event('claude', claude('assistant', [{ type: 'tool_use', id: `p${i}`, name: 'Edit', input: { file_path: `/repo/p${i}.ts` } }]));
  assert.equal(c.pending.get('kid').size, MAX_PENDING);
  // the oldest waiting call was let go
  c.event(
    'claude',
    claude('user', [
      { type: 'tool_result', tool_use_id: 'p0' },
      { type: 'tool_result', tool_use_id: `p${MAX_PENDING}` },
    ]),
  );
  assert.deepEqual(c.take('kid'), [`/repo/p${MAX_PENDING}.ts`]);
});
