// A Host storage failure reaches the existing failed-turn/session projection without exposing machine-local paths.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CHAT, start, world, fakeHost } from './support/host/remoteChatsKit.ts';

test('a typed Host stream close visibly fails only its active turn, rather than leaving partial text running', async () => {
  const host = fakeHost();
  let closed: any;
  host.events.onClosed = (fn: any) => {
    closed = fn;
    return () => {};
  };
  const w = world(host);
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  host.fire.patch(CHAT, 1, start('t1'));
  await w.chats.settled(CHAT);
  closed({ chatId: CHAT, reason: 'overflow' });
  closed({ chatId: 'other', reason: 'session_journal_write_failed' });
  await w.chats.settled(CHAT);
  assert.ok(!w.emitted.some((e) => e.kind === 'turnEnd'));
  closed({ chatId: CHAT, reason: 'session_journal_write_failed' });
  await w.chats.settled(CHAT);
  const ended = w.emitted.find((e) => e.kind === 'turnEnd');
  assert.equal(ended.turnId, 't1');
  assert.equal(ended.stopReason, 'error');
  assert.match(ended.error, /disk space and permissions/);
  assert.equal(ended.errorCode, 'session_journal_write_failed');
  closed({ chatId: CHAT, reason: 'session_journal_write_failed' });
  await w.chats.settled(CHAT);
  assert.equal(w.emitted.filter((e) => e.kind === 'turnEnd').length, 1);
  w.chats.dispose();
});

test('a recovered storage notice and a failed subscribe are surfaced without leaving an old live turn running', async () => {
  const w = world();
  w.host.reply = {
    snapshot: { rev: 1, items: [start('t-recovery')], storageError: { code: 'session_journal_full' } },
    generation: 'g1',
    inflight: [],
  };
  w.chats.follow(CHAT);
  await w.chats.settled(CHAT);
  assert.ok(w.emitted.some((e) => e.kind === 'turnEnd' && e.turnId === 't-recovery' && e.errorCode === 'session_journal_full'));
  w.chats.dispose();
  for (const failure of [Object.assign(new Error('Storage unavailable'), { code: 'session_journal_unreadable' }), null]) {
    const host = fakeHost();
    host.subscribe = async () => {
      throw failure;
    };
    const other = world(host);
    other.chats.follow(CHAT);
    await other.chats.settled(CHAT);
    assert.deepEqual(other.reported, [failure]);
    other.chats.dispose();
  }
});
