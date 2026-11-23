// What the app holds of a chat that runs on a machine (electron/host/remoteChats.cjs mirror, rev) for a handoff, and the families it has no sink for: the finished items as the Host keeps them, from the stream and from the transcript, whether they reach back to the first, and a family it cannot show said once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { CHAT, FakeItems, end, ev, fakeHost, start, text, world } from './support/host/remoteChatsKit.ts';

const require = createRequire(import.meta.url);
const { mirrorFor } = require('../electron/host/wiring.cjs');

test('the finished items come from the stream as the Host keeps them, with the reply of a turn in one item, and the revision is the last applied', async () => {
  const w = world();
  assert.equal(w.chats.mirror(CHAT), null);
  assert.equal(w.chats.rev(CHAT), 0);
  w.host.reply = {
    snapshot: { rev: 4, items: [start('t1'), text('he'), text('llo', 't1', { messageId: 'm2' }), end('t1')] },
    patches: null,
    generation: 'g1',
    inflight: [],
  };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.deepEqual(w.chats.mirror(CHAT), {
    items: [
      { t: 'user', turnId: 't1', text: '' },
      { t: 'assistant', turnId: 't1', text: 'hello', stopReason: 'end_turn', error: null },
    ],
    complete: true,
  });
  assert.equal(w.chats.rev(CHAT), 4);
  // a copy: what a caller does with it is not the chat's
  w.chats.mirror(CHAT)!.items.length = 0;
  assert.equal(w.chats.mirror(CHAT)!.items.length, 2);
  // a turn that failed says why, one that ended with no reply still has its item
  w.host.fire.patch(CHAT, 5, ev({ kind: 'turnEnd', turnId: 't2', stopReason: null, error: { message: 'boom' } }));
  w.host.fire.patch(CHAT, 6, ev({ kind: 'turnEnd', turnId: 't3', stopReason: 'cancelled', error: 'plain' }));
  await w.chats.settled(CHAT);
  assert.deepEqual(w.chats.mirror(CHAT)!.items.slice(2), [
    { t: 'assistant', turnId: 't2', text: '', stopReason: null, error: 'boom' },
    { t: 'assistant', turnId: 't3', text: '', stopReason: 'cancelled', error: 'plain' },
  ]);
});

test('after a restart the items are rebuilt from the transcript, and the chat is not held until it was read', async () => {
  const items = new FakeItems();
  const user = { id: 'u1', content: [{ type: 'text', text: 'fix it' }, { type: 'image' }] };
  items.records = [
    { t: 'session', harness: 'kimi' },
    { t: 'user', turnId: 't1', user, hostRev: 1, hostGen: 'g1' },
    {
      t: 'update',
      turnId: 't1',
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } },
      hostRev: 2,
      hostGen: 'g1',
    },
    { t: 'update', turnId: 't1', update: { sessionUpdate: 'tool_call' }, hostRev: 3, hostGen: 'g1' },
    { t: 'end', turnId: 't1', stopReason: 'end_turn', hostRev: 4, hostGen: 'g1' },
  ];
  const w = world(fakeHost(), items);
  w.host.reply = { snapshot: { rev: 4 }, patches: [], generation: 'g1', inflight: [] };
  w.chats.follow(CHAT);
  assert.equal(w.chats.mirror(CHAT), null);
  await w.chats.settled(CHAT);
  assert.deepEqual(w.chats.mirror(CHAT)!.items, [
    // (the picture that came with it is counted, not carried)
    { t: 'user', turnId: 't1', text: 'fix it', attachments: [{ type: 'image' }] },
    { t: 'assistant', turnId: 't1', text: 'done', stopReason: 'end_turn', error: null },
  ]);
  assert.equal(w.chats.rev(CHAT), 4);
});

test('a snapshot that starts after the Host’s first record in a new numbering means the items do not reach back to the first', async () => {
  const w = world();
  w.host.reply = { snapshot: { rev: 2005, items: [start('t9'), end('t9')] }, patches: null, generation: 'g1', inflight: [] };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.equal(w.chats.mirror(CHAT)!.complete, false);
});

test('events of a family this app has no sink for are not shown, written or taken for events of another, and are said once per chat', async () => {
  const w = world();
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  const other = (family: string, event: object) => ({ t: 'event', family, event });
  w.host.fire.patch(CHAT, 1, other('gemini', { kind: 'turnStart', turnId: 't1', user: { id: 'u' } }));
  w.host.fire.patch(CHAT, 2, other('gemini', { kind: 'turnEnd', turnId: 't1' }));
  w.host.fire.patch(CHAT, 3, other('mystery', { kind: 'turnStart', turnId: 't2', user: { id: 'u' } }));
  w.host.fire.patch(CHAT, 4, other(7 as any, { kind: 'turnStart' }));
  await w.chats.settled(CHAT);
  assert.deepEqual(w.emitted, []);
  assert.equal(w.items.records.filter((r) => r.hostRev !== undefined).length, 0);
  assert.deepEqual(
    w.reported.map((e) => e.message),
    [
      'A chat on m1 sends gemini events, which this app cannot show yet.',
      'A chat on m1 sends mystery events, which this app cannot show yet.',
    ],
  );
  // the revision still counts, so they are not asked for again
  assert.equal(w.chats.rev(CHAT), 4);
});

test('the continue service reads the mirror and the revision from the followed chats, and has none for a chat that is not followed or while Host is off', () => {
  const service = { mirror: (id: string) => ({ items: [id], complete: true }), rev: () => 7 };
  const on = mirrorFor({ remoteChats: () => service });
  assert.deepEqual(on.mirror('c'), { items: ['c'], complete: true });
  assert.equal(on.mirrorRev('c'), 7);
  for (const live of [{}, { remoteChats: () => null }]) {
    const off = mirrorFor(live);
    assert.equal(off.mirror('c'), null);
    assert.equal(off.mirrorRev('c'), 0);
  }
});

test('a legacy clipped snapshot never claims complete history even when every revision is present', async () => {
  const w = world();
  w.host.reply = { snapshot: { rev: 2, items: [start('t1'), end('t1')], paged: true }, patches: null, generation: 'g1', inflight: [] };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.equal(w.chats.mirror(CHAT)!.complete, false);
});
