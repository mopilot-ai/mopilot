// Read-only startup and uncertain terminal writes must preserve progress without duplicating a finished turn on the next boot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRunJournal } from '../host/src/runJournal.mjs';
import { createChatLog } from '../host/src/chatLog.mjs';
import { journalWorld } from './support/host/journalFaultKit';
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-journal-retry-'));

test('a running.json write failure on startup reports but keeps pending markers available for healthy recovery', (t) => {
  const dataDir = dir();
  fs.writeFileSync(path.join(dataDir, 'running.json'), JSON.stringify({ t1: 'chat' }));
  const reports: string[] = [];
  const j = createRunJournal({ dataDir, report: (m) => reports.push(m) });
  const fault = t.mock.method(fs, 'renameSync', () => {
    throw Object.assign(new Error('read-only'), { code: 'EACCES' });
  });
  let left: any;
  assert.doesNotThrow(() => {
    left = j.start();
  });
  assert.deepEqual(left, [['t1', 'chat']]);
  assert.ok(reports.length);
  fault.mock.restore();
  j.end('t1');
  assert.deepEqual(createRunJournal({ dataDir }).start(), []);
});

test('a row written before fsync failed is adopted once, not written again on resend', (t) => {
  const log = createChatLog({ dataDir: dir(), epoch: () => 1 });
  log.check('c');
  const user = { t: 'user', turnId: 't1', text: 'hello', messageKey: 'same-user-key' };
  const fault = t.mock.method(fs, 'fsyncSync', () => {
    throw new Error('fsync failure after write');
  });
  assert.throws(() => log.finish('c', user));
  fault.mock.restore();
  log.finish('c', user);
  const frames: any[] = [];
  log.hub.subscribe('c', { send: (f) => (frames.push(f), true), close: () => {} });
  assert.equal(frames[0].snapshot.items.filter((i: any) => i.t === 'user').length, 1);
});

for (const chatId of ['acp:kimi:retry', 'claude:retry', 'codex-retry']) {
  test(`${chatId}: summary failure after terminal commit is recovered once without changing the native end reason`, async (t) => {
    const dataDir = dir();
    const s = journalWorld(dataDir);
    s.journal.start();
    await s.open(chatId);
    s.host.emit('event', { kind: 'turnStart', key: chatId, turnId: 't' });
    const original = fs.writeFileSync;
    const failSummary = t.mock.method(fs, 'writeFileSync', (...args: any[]) => {
      if (String(args[1]).includes('"t":"assistant"')) throw new Error('summary write failed');
      return (original as any)(...args);
    });
    s.host.emit('event', { kind: 'turnEnd', turnId: 't', stopReason: 'end_turn' });
    failSummary.mock.restore();
    const restarted = journalWorld(dataDir);
    restarted.protocol.interrupted(restarted.journal.start());
    const before = (await restarted.open(chatId)).frames[0].frame.snapshot;
    const again = journalWorld(dataDir);
    again.protocol.interrupted([['t', chatId]]); // retry a recovery whose acknowledgement was lost
    const after = (await again.open(chatId)).frames[0].frame.snapshot;
    assert.deepEqual(after, before);
    const ends = after.items.filter((i: any) => i.event?.kind === 'turnEnd');
    const replies = after.items.filter((i: any) => i.t === 'assistant');
    assert.equal(ends.length, 1);
    assert.equal(ends[0].event.stopReason, 'end_turn');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].error, null);
  });
}

test('a retired turn can still commit its late terminal and clear the recovery marker after disk repair', async (t) => {
  const dataDir = dir();
  const s = journalWorld(dataDir);
  s.journal.start();
  await s.open('claude:late');
  s.host.emit('event', { kind: 'turnStart', key: 'claude:late', turnId: 'late' });
  const original = fs.writeFileSync;
  const fault = t.mock.method(fs, 'writeFileSync', (...args: any[]) => {
    if (String(args[1]).includes('"kind":"state"')) throw new Error('state write failed');
    return (original as any)(...args);
  });
  s.host.emit('event', { kind: 'state', chatId: 'claude:late', turnId: 'late', patch: { goal: { objective: 'fail' } } });
  fault.mock.restore();
  assert.ok(s.stopped.includes('claude:late'), 'the test must retire the running turn');
  s.host.emit('event', {
    kind: 'update',
    turnId: 'late',
    update: { sessionUpdate: 'agent_message_chunk', content: { text: 'retired output' } },
  });
  s.host.emit('event', { kind: 'turnEnd', turnId: 'late', stopReason: 'cancelled' });
  assert.deepEqual(createRunJournal({ dataDir }).start(), []);
});

test('recovery interrupted summary failure remains one interruption across repeated boots', (t) => {
  const dataDir = dir();
  const s = journalWorld(dataDir);
  s.journal.start();
  s.journal.begin('unfinished', 'acp:kimi:recover');
  const original = fs.writeFileSync;
  const fault = t.mock.method(fs, 'writeFileSync', (...args: any[]) => {
    if (String(args[1]).includes('"t":"assistant"')) throw new Error('summary full');
    return (original as any)(...args);
  });
  s.protocol.interrupted([['unfinished', 'acp:kimi:recover']]);
  fault.mock.restore();
  const again = journalWorld(dataDir);
  again.protocol.interrupted(again.journal.start());
  const last = journalWorld(dataDir);
  last.protocol.interrupted([['unfinished', 'acp:kimi:recover']]);
  return last.open('acp:kimi:recover').then(({ frames }) => {
    const items = frames[0].frame.snapshot.items;
    assert.equal(items.filter((i: any) => i.event?.kind === 'turnEnd').length, 1);
    assert.equal(items.filter((i: any) => i.t === 'assistant').length, 1);
    assert.deepEqual(createRunJournal({ dataDir }).start(), []);
  });
});

test('a journal echo failure after chat.answer stops its stream but replays the same answer without another native permit', async (t) => {
  const dataDir = dir();
  let permits = 0;
  const s = journalWorld(dataDir, undefined, { permit: () => (++permits, true) });
  const c = await s.open('claude:answer');
  const original = fs.writeFileSync;
  const fault = t.mock.method(fs, 'writeFileSync', (...args: any[]) => {
    if (String(args[1]).includes('"kind":"permissionCancelled"')) throw new Error('answer echo full');
    return (original as any)(...args);
  });
  const p = { chatId: 'claude:answer', epoch: 1, key: 'answer-repeat-key', requestId: 'q1', optionId: 'allow' };
  const first = await c.conn.call('chat.answer', p);
  fault.mock.restore();
  assert.deepEqual(first.result, { answered: true, journalError: 'session_journal_write_failed' });
  assert.deepEqual((await c.conn.call('chat.answer', p)).result, first.result);
  assert.equal(permits, 1);
  assert.ok(s.stopped.includes('claude:answer'));
});

test('preflight preserves the full-journal cause and accounts for the pending user message before dispatch', () => {
  const dataDir = dir();
  const log = createChatLog({ dataDir, epoch: () => 1 });
  assert.throws(
    () => log.check('full', 'x'.repeat(64 * 1024 * 1024)),
    (e: any) => e.code === 'session_journal_full' && !e.message.includes('permissions'),
  );
  const files = fs.readdirSync(dataDir);
  assert.equal(files.length, 0, 'capacity refusal must precede journal and agent creation');
});

test('permission preflight failure stops the waiting agent and closes its stream instead of leaving its card pending', async (t) => {
  let permits = 0;
  const s = journalWorld(dir(), undefined, { permit: () => (++permits, true) });
  s.journal.start();
  const c = await s.open('claude:waiting');
  s.host.emit('event', { kind: 'turnStart', key: 'claude:waiting', turnId: 'waiting' });
  const original = fs.writeFileSync;
  const fault = t.mock.method(fs, 'writeFileSync', (...args: any[]) => {
    if (String(args[1]).includes('"kind":"reserve"')) throw new Error('disk full');
    return (original as any)(...args);
  });
  await assert.rejects(
    c.conn.call('chat.answer', {
      chatId: 'claude:waiting',
      epoch: 1,
      key: 'waiting-answer-key',
      requestId: 'permission',
      optionId: 'allow',
    }),
    { code: 'session_storage_unavailable' },
  );
  fault.mock.restore();
  assert.equal(permits, 0);
  assert.ok(s.stopped.includes('claude:waiting'));
  assert.equal(c.frames.at(-1).event, 'closed');
  assert.equal(c.frames.at(-1).reason, 'session_journal_write_failed');
});
