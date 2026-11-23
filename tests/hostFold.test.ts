// The fold of a Host's stream (shared/host/fold.mjs), one code for the Mac and the phone: for a recorded stream of each harness, the
// records and finished items the shared fold makes are the ones the Mac's mirror (electron/host/remoteChats.cjs) writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { world } from './support/host/remoteChatsKit.ts';
import {
  createFold,
  eventOf,
  otherFamily,
  closedCards,
  recordOf,
  RECORDED,
  FAMILIES,
  wellFormed,
  foldSummary,
} from '../shared/host/fold.mjs';

const fam = (family: string, event: object) => ({ t: 'event', family, event });
const said = (turnId: string, text: string) => ({ t: 'user', turnId, text });
const user = (turnId: string, text: string) => ({
  id: `u-${turnId}`,
  clientId: turnId,
  content: [{ type: 'text', text, text_elements: [] }],
});
const chunk = (family: string, turnId: string, text: string) =>
  fam(family, {
    kind: 'update',
    turnId,
    update: { sessionUpdate: 'agent_message_chunk', messageId: 'm1', content: { type: 'text', text } },
  });
const tool = (family: string, turnId: string, status: string) =>
  fam(family, {
    kind: 'update',
    turnId,
    update: { sessionUpdate: 'tool_call', toolCallId: 'call-1', title: 'ls', kind: 'execute', status },
  });

/** The recorded streams: each harness's own shape of one turn with a tool call. */
const STREAMS: Record<string, { chatId: string; items: any[] }> = {
  acp: {
    chatId: 'acp:kimi:c1',
    items: [
      fam('acp', { kind: 'turnStart', turnId: 't1', user: user('t1', 'list files') }),
      tool('acp', 't1', 'in_progress'),
      tool('acp', 't1', 'completed'),
      chunk('acp', 't1', 'two files'),
      fam('acp', { kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn', usage: { in: 1 } }),
    ],
  },
  codex: {
    chatId: 'acp:host-codex:u1',
    items: [
      fam('codex', { kind: 'turnStart', turnId: 't1' }),
      said('t1', 'list files'),
      tool('codex', 't1', 'completed'),
      chunk('codex', 't1', 'two files'),
      fam('codex', { kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' }),
    ],
  },
  claude: {
    chatId: 'acp:host-claude:u2',
    items: [
      said('t1', 'list files'),
      fam('claude', { kind: 'turnStart', turnId: 't1' }),
      chunk('claude', 't1', 'two '),
      chunk('claude', 't1', 'files'),
      fam('claude', { kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' }),
    ],
  },
};

for (const [name, { chatId, items }] of Object.entries(STREAMS)) {
  test(`${name}: the shared fold makes the records and finished items the Mac’s mirror writes`, async () => {
    const w = world();
    w.chats.follow(chatId);
    await w.chats.settled(chatId);
    items.forEach((item, i) => w.host.fire.patch(chatId, i + 1, item));
    await w.chats.settled(chatId);
    const mac = w.items.records
      .filter((r: any) => r.hostRev !== undefined)
      .map(({ hostRev: _r, hostGen: _g, at: _a, ...rest }: any) => rest);
    const fold = createFold({ hostId: 'host', now: () => 0 });
    const records = items.flatMap((item) => fold.push(item).records).map(({ at: _a, ...rest }: any) => rest);
    assert.ok(records.length >= 3);
    assert.deepEqual(records, mac);
    assert.deepEqual(fold.summary, w.chats.mirror(chatId)!.items);
  });
}

test('a family this client cannot show is refused and leaves nothing', () => {
  const fold = createFold({ hostId: 'h' });
  assert.deepEqual(fold.push(fam('gemini2', { kind: 'turnStart', turnId: 't' })), { events: [], records: [], refused: 'gemini2' });
  assert.deepEqual(fold.push({ t: 'summary' }), { events: [], records: [], refused: null });
  assert.deepEqual(fold.summary, []);
});

test('a turn the machine’s restart cut off is shown as failed, and a picture’s id is the chat’s own', () => {
  const fold = createFold({ hostId: 'h1' });
  const out = fold.push(
    fam('acp', { kind: 'turnStart', turnId: 't1', user: { id: 'u', content: [{ type: 'image', imageId: 'a'.repeat(64) }] }, cwd: '/srv' }),
  );
  assert.equal(out.events.length, 1);
  assert.equal('cwd' in out.events[0], false, 'the Host’s own path is dropped');
  assert.notEqual(out.events[0].user.content[0].imageId, 'a'.repeat(64));
  const ended = fold.push(fam('acp', { kind: 'turnEnd', turnId: 't1', stopReason: 'cancelled', interrupted: { tools: ['ls'] } }));
  assert.equal(ended.records[0].t, 'end');
});

test('a user item is paired by its key, its client id or its user’s client id; a compaction and a sub-agent’s text are told apart', () => {
  for (const extra of [{ key: 'k1' }, { clientId: 'c1' }, { user: { clientId: 'c2' } }, {}]) {
    const fold = createFold({ hostId: 'h' });
    fold.push({ t: 'user', turnId: 't', text: 'go', ...extra });
    const out = fold.push(fam('claude', { kind: 'turnStart', turnId: 't' }));
    assert.equal(out.records[0].user.content[0].text, 'go');
  }
  const summary: any[] = [];
  foldSummary(summary, {
    t: 'update',
    turnId: 't',
    update: { sessionUpdate: 'agent_message_chunk', content: { text: 'x' }, _meta: { claudeCode: { parentToolUseId: 'p' } } },
  });
  foldSummary(summary, { t: 'update', turnId: 't', update: { sessionUpdate: 'compaction' } });
  assert.deepEqual(
    summary.map((x) => x.t),
    ['event'],
    'a sub-agent’s text is not the reply; a compaction is its own step',
  );
  const fold = createFold({ hostId: 'h' });
  const shown = fold.push(fam('acp', { kind: 'permission', requestId: 'r', turnId: 't' }));
  assert.deepEqual([shown.events.length, shown.records.length], [1, 0], 'a card is shown and leaves no record');
});

test('the pieces: what is an event, what leaves a record, which cards a batch has already closed', () => {
  assert.deepEqual([...FAMILIES].sort(), ['acp', 'claude', 'codex']);
  assert.deepEqual([...RECORDED].sort(), ['turnEnd', 'turnStart', 'update']);
  assert.equal(wellFormed({ kind: 'update' }), false);
  assert.equal(eventOf({ t: 'event', family: 'acp', event: { kind: 'turnStart' } }), null, 'a turn start with no id is not well formed');
  assert.equal(eventOf({ t: 'summary' }), null);
  assert.equal(otherFamily({ t: 'event', family: 'x', event: { kind: 'turnEnd', turnId: 't' } }), 'x');
  assert.equal(otherFamily({ t: 'event', family: 'acp', event: {} }), null);
  assert.deepEqual(recordOf({ kind: 'turnStart', turnId: 't', user: { id: 'u' } }, 5), {
    t: 'user',
    turnId: 't',
    user: { id: 'u' },
    at: 5,
  });
  assert.deepEqual(recordOf({ kind: 'update', turnId: 't', update: { x: 1 } }, 5), { t: 'update', turnId: 't', update: { x: 1 }, at: 5 });
  const entries = [
    { rev: 1, item: fam('acp', { kind: 'permission', requestId: 'r1', turnId: 't1' }) },
    { rev: 2, item: fam('acp', { kind: 'permissionCancelled', requestId: 'r1', turnId: 't1' }) },
    { rev: 3, item: fam('acp', { kind: 'permission', requestId: 'r2', turnId: 't2' }) },
    { rev: 4, item: fam('acp', { kind: 'question', turnId: 't3', question: { id: 'q1' } }) },
    { rev: 5, item: fam('acp', { kind: 'turnEnd', turnId: 't3' }) },
    { rev: 6, item: fam('acp', { kind: 'permission', requestId: 'r3', turnId: 't9' }) },
  ];
  assert.deepEqual([...closedCards(entries)].sort(), [1, 4]);
  const summary: any[] = [];
  foldSummary(summary, { t: 'user', turnId: 't', user: { content: [{ type: 'text', text: 'hi' }, { type: 'image' }] } });
  foldSummary(summary, { t: 'update', turnId: 't', update: { sessionUpdate: 'agent_message_chunk', content: { text: 'yo' } } });
  foldSummary(summary, { t: 'end', turnId: 't', stopReason: 'end_turn', error: { message: 'boom' } });
  assert.deepEqual(summary, [
    { t: 'user', turnId: 't', text: 'hi', attachments: [{ type: 'image' }] },
    { t: 'assistant', turnId: 't', text: 'yo', stopReason: 'end_turn', error: 'boom' },
  ]);
});
