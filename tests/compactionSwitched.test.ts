// Issue 1366: a chat that switched harness holds and releases steers by its current segment's compaction only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, tick, codex, selectSegment } from './support/controller/fixture';

const steer = (id: string) => ({ id, text: `input ${id}`, opts: { human: true }, followUp: 'steer' });
const claudeStatus = (session: string, phase: 'active' | 'complete') => ({
  key: `claude:${session}`,
  kind: 'message',
  msg: {
    type: 'system',
    subtype: 'status',
    status: phase === 'active' ? 'compacting' : null,
    ...(phase === 'complete' ? { compact_result: 'success' } : {}),
    session_id: session,
  },
});
const codexItem = (thread: string, turnId: string, phase: 'active' | 'complete') =>
  codex(phase === 'active' ? 'item/started' : 'item/completed', {
    threadId: thread,
    turnId,
    item: { type: 'contextCompaction', id: 'c-1' },
  });

test('a Codex chat that switched to Claude holds by Claude compaction and ignores its old Codex thread', async () => {
  const { c, chats, execs, s } = setup({ auto: false });
  const chat = 'codex-first';
  selectSegment(c, chats, chat, [
    ['codex', chat],
    ['claude', 's2'],
  ]);
  c.send(chat, { text: 'first', opts: { human: true } }, 1);
  assert.equal(execs[0].kind, 'claude-turn');
  execs[0].done({ started: true, turnId: 'turn-1' });
  await tick();
  // the previous segment's adapter reporting compaction holds nothing
  c.onCodexMessage(codexItem(chat, 'turn-1', 'active'));
  assert.equal(s(chat).compaction, null);
  c.onClaudeEvent(claudeStatus('s2', 'active'));
  assert.equal(s(chat).compaction, 'active');
  assert.equal(c.send(chat, steer('held'), 2).action, 'queued');
  assert.equal(s(chat).queue[0].waitingFor, 'compaction');
  assert.equal(execs.length, 1);
  // a stale completion from the old segment releases nothing
  c.onCodexMessage(codexItem(chat, 'turn-1', 'complete'));
  await tick();
  assert.equal(execs.length, 1);
  assert.equal(s(chat).queue.length, 1);
  c.onClaudeEvent(claudeStatus('s2', 'complete'));
  await tick();
  assert.equal(execs.length, 2);
  assert.equal(execs[1].kind, 'claude-steer');
  assert.equal(execs[1].item.id, 'held');
  execs[1].done({ started: true });
  await tick();
  assert.equal(s(chat).queue.length, 0);
  // a second completion does not send it again
  c.onClaudeEvent(claudeStatus('s2', 'complete'));
  await tick();
  assert.equal(execs.length, 2);
});

test('a Claude chat that switched to Codex holds by Codex compaction and ignores its old Claude session', async () => {
  const { c, chats, execs, s } = setup({ auto: false });
  const chat = 'claude:c1';
  selectSegment(c, chats, chat, [
    ['claude', 'c1'],
    ['codex', 'th2'],
  ]);
  c.send(chat, { text: 'first', opts: { human: true } }, 1);
  assert.equal(execs[0].kind, 'turn');
  execs[0].done({ started: true, turnId: 'turn-2' });
  await tick();
  c.onClaudeEvent(claudeStatus('c1', 'active'));
  assert.equal(s(chat).compaction, null);
  c.onCodexMessage(codexItem('th2', 'turn-2', 'active'));
  assert.equal(s(chat).compaction, 'active');
  assert.equal(c.send(chat, steer('held'), 2).action, 'queued');
  assert.equal(s(chat).queue[0].waitingFor, 'compaction');
  c.onClaudeEvent(claudeStatus('c1', 'complete'));
  await tick();
  assert.equal(execs.length, 1);
  c.onCodexMessage(codexItem('th2', 'turn-2', 'complete'));
  await tick();
  assert.equal(execs.length, 2);
  assert.equal(execs[1].kind, 'steer');
  assert.equal(execs[1].chatId, chat);
  assert.equal(execs[1].item.id, 'held');
  execs[1].done({ started: true });
  await tick();
  assert.equal(s(chat).queue.length, 0);
});
