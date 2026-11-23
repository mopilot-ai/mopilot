// A Host chat's tool steps in a handoff (#4003): the tool calls a Host's stream records, and the ones the app's mirror kept, are listed as steps in the record the next agent reads, so a handoff from a lost Host is more than the words. A: steps from events and from the mirror; B: what is left out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { continueHandoff, turnsFromHostItems } from '../shared/host/continueHandoff.mjs';
import { OUTPUT_KEEP, isCompaction, isToolUpdate, mergeToolUpdate, slimToolUpdate, stepOf } from '../shared/host/hostToolSteps.mjs';
import { CHAT, end, ev, start, text, world } from './support/host/remoteChatsKit.ts';

const call = (id: string, extra: object = {}) => ({ sessionUpdate: 'tool_call', toolCallId: id, status: 'in_progress', ...extra });
const done = (id: string, extra: object = {}) => ({ sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', ...extra });
const upd = (turnId: string, update: object) => ev({ kind: 'update', turnId, update });
const user = (turnId: string, t: string) => ({ t: 'user', turnId, text: t });
const reply = (turnId: string, t: string) => ({ t: 'assistant', turnId, text: t, stopReason: 'end_turn', error: null });
const record = (items: any[]) =>
  continueHandoff({ turns: turnsFromHostItems(items), fromLabel: 'Claude Code', cwd: '/srv/app', partial: false }).text;

test('A: a command, an edit, a read, a search, a fetch, an MCP tool and a sub-agent are steps of their turn, once each, in the order told', () => {
  const items = [
    user('t1', 'fix it'),
    upd('t1', call('c1', { title: 'npm test', kind: 'execute', rawInput: { command: 'npm test' } })),
    upd('t1', call('c2', { title: 'Edit /srv/app/a.ts', kind: 'edit', locations: [{ path: '/srv/app/a.ts' }] })),
    upd('t1', call('c3', { title: 'Read /srv/app/b.ts', kind: 'read' })),
    upd('t1', call('c4', { title: 'grep foo', kind: 'search' })),
    upd('t1', call('c5', { title: 'https://x.test', kind: 'fetch' })),
    upd('t1', call('c6', { title: 'mcp__srv__lookup', kind: 'other', _meta: { claudeCode: { toolName: 'mcp__srv__lookup' } } })),
    upd('t1', call('c7', { title: 'dig', kind: 'think' })),
    upd('t1', done('c1', { rawOutput: { exitCode: 1, output: 'one\ntwo\nFAIL' } })),
    upd('t1', done('c2')),
    upd('t1', done('c6')),
    reply('t1', 'done'),
  ];
  const turns = turnsFromHostItems(items) as any[];
  assert.deepEqual(
    turns[0].items.map((i: any) => i.type),
    [
      'userMessage',
      'commandExecution',
      'fileChange',
      'commandExecution',
      'commandExecution',
      'webSearch',
      'mcpToolCall',
      'collabAgentToolCall',
      'agentMessage',
    ],
  );
  assert.equal(turns[0].items[1].exitCode, 1);
  const handoff = record(items);
  for (const line of [
    'Ran `npm test`',
    '→ exit 1',
    'Edited /srv/app/a.ts',
    'Read /srv/app/b.ts',
    'Searched for grep foo',
    'Web: https://x.test',
    'Tool srv · lookup',
    'Sub-agent: dig',
  ])
    assert.ok(handoff.includes(line), line);
});

test('B: a call the handoff does not list, a call heard first at its end, a call whose first update said nothing, and a tool update with no turn are handled', () => {
  const items = [
    upd('t1', call('p1', { title: 'a plan', kind: 'other' })),
    upd('t1', done('late', { title: 'ls', kind: 'execute', rawInput: { command: 'ls' }, rawOutput: { output: 'x' } })),
    upd('t1', done('p1', { kind: 'execute', title: 'later known', rawInput: { command: 'pwd' } })),
    upd('t1', { sessionUpdate: 'plan', entries: [] }),
    ev({ kind: 'update', update: call('noturn', { kind: 'execute' }) }),
    { t: 'event', event: { kind: 'turnEnd', turnId: 't1' } },
    reply('t1', 'ok'),
  ];
  const turns = turnsFromHostItems(items) as any[];
  assert.deepEqual(
    turns[0].items.map((i: any) => i.type),
    ['commandExecution', 'commandExecution', 'agentMessage'],
  );
  assert.deepEqual(
    turns[0].items.map((i: any) => i.command ?? ''),
    ['ls', 'pwd', ''],
  );
  assert.equal(stepOf({ kind: 'other', title: 'x' }), null);
  assert.equal(isToolUpdate({ sessionUpdate: 'plan' }), false);
  assert.equal(isToolUpdate(null), false);
});

test('B: a mirror keeps a line per call: long output keeps its end, the rest of a call’s fields are cut', () => {
  const slim = slimToolUpdate(
    call('c', {
      title: 'x'.repeat(500),
      kind: 'execute',
      rawInput: { command: 'y'.repeat(900), secret: 'token' },
      rawOutput: { exitCode: 0, output: `${'a'.repeat(OUTPUT_KEEP)}END` },
      locations: Array.from({ length: 30 }, (_, i) => ({ path: `/p${i}` })),
    }),
  );
  assert.equal(slim.title!.length, 300);
  assert.equal(slim.rawInput!.command.length, 500);
  assert.equal('secret' in slim.rawInput!, false);
  assert.equal(slim.rawOutput!.output.length, OUTPUT_KEEP);
  assert.ok(slim.rawOutput!.output.endsWith('END'));
  assert.equal(slim.locations!.length, 20);
  assert.deepEqual(slimToolUpdate(done('c')), { sessionUpdate: 'tool_call_update', toolCallId: 'c', status: 'completed' });
  assert.equal(mergeToolUpdate({ title: 'a', status: 'in_progress' }, done('c')).title, 'a');
});

test('A: the app’s mirror of a chat on a machine holds the tool steps, so a handoff from a lost machine lists them', async () => {
  const w = world();
  const tool = (turnId: string, update: object) => ({ t: 'event', family: 'claude', event: { kind: 'update', turnId, update } });
  w.host.reply = {
    snapshot: {
      rev: 6,
      items: [
        start('t1'),
        tool('t1', call('c1', { title: 'ls', kind: 'execute', rawInput: { command: 'ls' } })),
        tool('t1', done('c1', { rawOutput: { exitCode: 0, output: 'a.txt' } })),
        text('here it is', 't1', { messageId: 'm1' }),
        tool('t1', call('c9', { title: 'Edit /srv/work/x.ts', kind: 'edit', locations: [{ path: '/srv/work/x.ts' }] })),
        end('t1'),
      ],
    },
    patches: null,
    generation: 'g1',
    inflight: [],
  };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  const mirror = w.chats.mirror(CHAT)!;
  assert.deepEqual(
    mirror.items.map((i: any) => i.t),
    ['user', 'event', 'assistant', 'event'],
  );
  const handoff = record(mirror.items);
  assert.ok(handoff.includes('Ran `ls`'));
  assert.ok(handoff.includes('Edited /srv/work/x.ts'));
});

test('B: failed and untitled calls, a command with no input, an edit with no path, and a call that stops being a step are all handled', () => {
  assert.equal((stepOf({ kind: 'execute', title: 'x', status: 'failed' }) as any).status, 'failed');
  assert.equal((stepOf({ kind: 'execute', status: 'completed' }) as any).command, '');
  assert.equal((stepOf({ kind: 'execute', title: 'make', rawInput: {} }) as any).command, 'make');
  assert.deepEqual((stepOf({ kind: 'edit', title: 'Edit a file' }) as any).changes, [{ path: 'Edit a file', kind: { type: 'update' } }]);
  assert.equal((stepOf({ kind: 'read' }) as any).commandActions[0].path, '');
  assert.deepEqual(slimToolUpdate({ sessionUpdate: 'tool_call_update', toolCallId: 'c' }), {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c',
  });
  // a call that was a step and is told as a kind the handoff does not list leaves the record
  const items = [
    upd('t1', call('c1', { title: 'ls', kind: 'execute', rawInput: { command: 'ls' } })),
    upd('t1', done('c1', { kind: 'other' })),
    reply('t1', 'ok'),
  ];
  assert.deepEqual(
    (turnsFromHostItems(items) as any[])[0].items.map((i: any) => i.type),
    ['agentMessage'],
  );
});

test('#4003: a compaction and the pictures that came with a message are in the record: the compaction as a step, the pictures as a count', async () => {
  const items = [user('t1', 'go'), upd('t1', { sessionUpdate: 'compaction', id: 'c1', trigger: 'auto' }), reply('t1', 'ok')];
  assert.deepEqual(
    (turnsFromHostItems(items) as any[])[0].items.map((i: any) => i.type),
    ['userMessage', 'contextCompaction', 'agentMessage'],
  );
  assert.ok(record(items).includes('(context compacted)'));
  assert.equal(isCompaction({ sessionUpdate: 'compaction' }), true);
  assert.equal(isCompaction(null), false);
  // the mirror keeps both
  const w = world();
  const rec = (event: object) => ({ t: 'event', family: 'claude', event });
  w.host.reply = {
    snapshot: {
      rev: 4,
      items: [
        ev({
          kind: 'turnStart',
          turnId: 't1',
          user: { id: 'u', content: [{ type: 'text', text: 'look at this' }, { type: 'image' }, { type: 'image' }] },
        }),
        rec({ kind: 'update', turnId: 't1', update: { sessionUpdate: 'compaction', id: 'c1' } }),
        text('done', 't1', { messageId: 'm1' }),
        end('t1'),
      ],
    },
    patches: null,
    generation: 'g1',
    inflight: [],
  };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  const mirror = w.chats.mirror(CHAT)!;
  assert.deepEqual((mirror.items[0] as any).attachments, [{ type: 'image' }, { type: 'image' }]);
  const handoff = record(mirror.items);
  assert.ok(handoff.includes('2 attached files, not carried over'));
  assert.ok(handoff.includes('(context compacted)'));
});
