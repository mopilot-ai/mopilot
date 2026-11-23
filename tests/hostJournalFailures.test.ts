// Journal errors must isolate recovery, stop faulty streams, and refuse dispatch before a native agent starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRunJournal } from '../host/src/runJournal.mjs';
import { journalWorld as setup } from './support/host/journalFaultKit';
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-journal-fault-'));
const hash = (id: string) => crypto.createHash('sha256').update(id).digest('hex');

const breakLog = (dataDir: string, chatId: string) => {
  const log = path.join(dataDir, 'sessions', hash(chatId), 'events');
  fs.renameSync(log, `${log}.saved`);
  fs.mkdirSync(log); // deterministic EISDIR on append, without relying on uid permissions
  return log;
};

test('one corrupt chat cannot prevent healthy recovery, and uncommitted recovery markers survive the next boot', async () => {
  const dataDir = dir();
  const a = setup(dataDir);
  a.journal.start();
  for (const id of ['acp:kimi:bad', 'acp:kimi:good']) {
    await a.open(id);
    a.host.emit('event', { kind: 'turnStart', key: id, turnId: `${id}-turn` });
  }
  fs.writeFileSync(path.join(dataDir, 'sessions', hash('acp:kimi:bad'), 'checkpoint'), 'broken checkpoint');
  const b = setup(dataDir);
  const left = b.journal.start();
  assert.equal(b.protocol.interrupted(left), 1, 'only the healthy recovery committed');
  const healthy = (await b.open('acp:kimi:good')).frames[0].frame.snapshot;
  assert.ok(healthy.items.some((i: any) => i.event?.kind === 'turnEnd'));
  assert.deepEqual(createRunJournal({ dataDir }).start(), [['acp:kimi:bad-turn', 'acp:kimi:bad']]);
  assert.ok(b.report.length > 0);
});

test('a live append failure closes only that chat with a typed reason, stops the agent and retains recovery', async () => {
  const dataDir = dir();
  const s = setup(dataDir);
  s.journal.start();
  const c = await s.open('acp:kimi:bad');
  const healthy = await s.open('acp:kimi:other');
  s.host.emit('event', { kind: 'turnStart', key: 'acp:kimi:bad', turnId: 't' });
  breakLog(dataDir, 'acp:kimi:bad');
  assert.doesNotThrow(() => s.host.emit('event', { kind: 'turnEnd', turnId: 't', stopReason: 'end_turn' }));
  assert.equal(c.frames.at(-1).event, 'closed');
  assert.equal(c.frames.at(-1).reason, 'session_journal_write_failed');
  assert.ok(s.stopped.includes('acp:kimi:bad'));
  const fresh = (await s.open('acp:kimi:bad')).frames[0].frame;
  assert.equal(fresh.snapshot.storageError.code, 'session_journal_write_failed');
  assert.ok(healthy.frames.every((m) => m.event !== 'closed'));
  assert.deepEqual(createRunJournal({ dataDir }).start(), [['t', 'acp:kimi:bad']]);
});

test('journal preflight rejects before runtime.send and the same request can retry after the filesystem is repaired', async () => {
  const dataDir = dir();
  let sends = 0;
  const s = setup(dataDir, async () => {
    sends++;
    return { turnId: 't' };
  });
  const id = 'acp:kimi:chat';
  const c = await s.open(id);
  const p = { chatId: id, epoch: 1, key: 'retry-journal-key', text: 'do once' };
  // Create the journal first, then make its log path unwritable before dispatch.
  s.host.emit('event', { kind: 'threadName', key: id, name: 'title' });
  const log = breakLog(dataDir, id);
  await assert.rejects(c.conn.call('chat.send', p), (e: any) => e.code === 'session_storage_unavailable' && !e.message.includes(dataDir));
  assert.equal(sends, 0);
  fs.rmdirSync(log);
  fs.renameSync(`${log}.saved`, log);
  await c.conn.call('chat.send', p);
  assert.equal(sends, 1);
});

test('a save failure after native dispatch settles the request once, rather than recording a replayable failure while the agent runs', async () => {
  const dataDir = dir();
  const id = 'acp:kimi:once';
  let sends = 0;
  const s = setup(dataDir, async () => {
    sends++;
    breakLog(dataDir, id);
    return { turnId: 't' };
  });
  const c = await s.open(id);
  const p = { chatId: id, epoch: 1, key: 'postdispatch-key', text: 'run once' };
  const first = await c.conn.call('chat.send', p);
  assert.equal(first.result.journalError, 'session_journal_write_failed');
  assert.equal((await c.conn.call('chat.send', p)).result.journalError, first.result.journalError);
  assert.equal(sends, 1);
  assert.ok(s.stopped.includes(id));
});

test('an absent optional chunk text does not break the guarded listener or its terminal summary', async () => {
  const s = setup(dir());
  const c = await s.open('acp:kimi:empty');
  s.host.emit('event', { kind: 'turnStart', key: 'acp:kimi:empty', turnId: 'empty' });
  s.host.emit('event', { kind: 'update', turnId: 'empty', update: { sessionUpdate: 'agent_message_chunk', content: {} } });
  s.host.emit('event', { kind: 'turnEnd', turnId: 'empty', stopReason: 'end_turn' });
  assert.equal(c.frames.at(-1).frame.item.text, '');
  assert.deepEqual(s.stopped, []);
});
