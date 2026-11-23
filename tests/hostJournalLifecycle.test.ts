// Real protocol deletion and durable tombstones must fence late events, restart recovery and stale clients without deleting healthy chats.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionJournal } from '../host/src/sessionJournal.mjs';
import { helloParams } from '../shared/host/schema.mjs';
import { journalWorld } from './support/host/journalFaultKit';
const tmp = (t: any) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-lifecycle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

for (const id of ['acp:kimi:deleted', 'claude:deleted', 'codex-deleted'])
  test(`${id}: deletion survives restart and rejects late events, stale reconnects and same-key sends`, async (t) => {
    const dir = tmp(t);
    const s = journalWorld(dir);
    s.journal.start();
    const c = await s.open(id);
    const second = await s.open(id);
    s.host.emit('event', { kind: 'turnStart', key: id, turnId: 'native' });
    const p = { chatId: id, epoch: 1, key: 'delete-once' };
    assert.equal((await c.conn.call('chat.remove', p)).result.removed, true);
    assert.equal((await c.conn.call('chat.remove', p)).result.removed, true);
    assert.equal(s.stopped.filter((x) => x === id).length, 1);
    assert.equal(c.frames.at(-1).reason, 'session_journal_deleted');
    assert.equal(second.frames.at(-1).reason, 'session_journal_deleted');
    s.host.emit('event', { kind: 'turnStart', key: id, turnId: 'late' });
    s.host.emit('event', { kind: 'state', chatId: id, patch: { title: 'late' } });
    assert.deepEqual(s.journal.start(), []);
    const fresh = journalWorld(dir);
    const conn = fresh.protocol.connection(() => {});
    await conn.call('host.hello', helloParams());
    for (const method of ['chat.subscribe', 'chat.send'])
      await assert.rejects(conn.call(method, { ...p, text: 'late' }), { code: 'session_journal_deleted' });
    // Simulate a crash between the tombstone commit and clearing the old running marker.
    fresh.journal.begin('old-marker', id);
    fresh.protocol.interrupted([['old-marker', id]]);
    assert.deepEqual(fresh.journal.start(), []);
    await fresh.open('acp:kimi:healthy');
  });

test('an older app is refused deletion before touching a journal, while its ordinary chats still work', async (t) => {
  const s = journalWorld(tmp(t));
  const conn = s.protocol.connection(() => {});
  const hello = helloParams();
  await conn.call('host.hello', { ...hello, features: hello.features.filter((f) => f !== 'journalLifecycle') });
  await assert.rejects(conn.call('chat.remove', { chatId: 'acp:kimi:c', epoch: 1, key: 'delete-key' }), { code: 'feature_missing' });
  await conn.call('chat.send', { chatId: 'acp:kimi:c', epoch: 1, key: 'send-key', text: 'still works' });
});

for (const operation of ['renameSync', 'rmSync', 'fsyncSync'])
  test(`deletion interrupted at ${operation} is retryable without resurrecting history`, (t) => {
    const dir = tmp(t);
    const j = createSessionJournal({ dataDir: dir });
    const seq = j.next('c');
    j.durable('c', { seq, rev: 1, item: { text: 'secret' } });
    const failure = t.mock.method(fs, operation as any, () => {
      throw new Error('injected delete failure');
    });
    assert.throws(() => j.remove('c'));
    failure.mock.restore();
    // A tombstone may already exist even when its fsync failed. Retry must sync it and finish deletion.
    j.remove('c');
    j.remove('c');
    assert.throws(() => createSessionJournal({ dataDir: dir }).read('c'), { code: 'session_journal_deleted' });
  });

test('deletion does not parse a corrupt chat, and a failing agent stop cannot invalidate its durable removal', async (t) => {
  const dir = tmp(t);
  const s = journalWorld(dir);
  const c = await s.open('claude:bad');
  s.host.cancel = () => {
    throw new Error('agent gone');
  };
  const result = await c.conn.call('chat.remove', { chatId: 'claude:bad', epoch: 1, key: 'remove-key' });
  assert.equal(result.result.removed, true);
  assert.ok(s.report.length);
  const j = createSessionJournal({ dataDir: dir });
  j.check('other');
  const folder = fs.readdirSync(path.join(dir, 'sessions')).find((x) => /^[a-f0-9]{64}$/.test(x))!;
  fs.writeFileSync(path.join(dir, 'sessions', folder, 'checkpoint'), 'corrupt');
  assert.doesNotThrow(() => createSessionJournal({ dataDir: dir }).remove('other'));
});

for (const boundary of ['images', 'native-readiness'])
  test(`deletion while waiting for ${boundary} prevents dispatch after the await`, async (t) => {
    let entered: any, release: any;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let nativeSends = 0;
    const id = 'claude:overlap';
    const images = {
      project: (user: any) => user,
      forgetChat: async () => undefined,
      attachments: async () => {
        entered();
        await held;
        return [{ path: '/private/image.png' }];
      },
    };
    const s = journalWorld(
      tmp(t),
      async (p) => {
        if (boundary === 'native-readiness') {
          entered();
          await held;
        }
        p.check?.();
        nativeSends++;
        return { turnId: 'should-not-start' };
      },
      { images, identity: 'paired' },
    );
    const c = await s.open(id);
    const sending = c.conn.call('chat.send', {
      chatId: id,
      epoch: 1,
      key: 'retired-send',
      text: 'late',
      ...(boundary === 'images' ? { images: ['a'.repeat(64)] } : {}),
    });
    const refused = assert.rejects(sending, { code: 'session_journal_deleted' });
    await started;
    await c.conn.call('chat.remove', { chatId: id, epoch: 1, key: 'delete-during-send' });
    release();
    await refused;
    assert.equal(nativeSends, 0);
  });

test('failure to clear a run marker after tombstone commit cannot prevent stopping the deleted agent', async (t) => {
  const s = journalWorld(tmp(t));
  s.journal.start();
  const c = await s.open('claude:marker');
  s.host.emit('event', { kind: 'turnStart', key: 'claude:marker', turnId: 'running' });
  const fault = t.mock.method(s.journal, 'end', () => {
    throw new Error('read only marker');
  });
  assert.equal((await c.conn.call('chat.remove', { chatId: 'claude:marker', epoch: 1, key: 'delete-marker' })).result.removed, true);
  assert.ok(s.stopped.includes('claude:marker'));
  fault.mock.restore();
  s.protocol.interrupted(s.journal.start());
  assert.deepEqual(s.journal.start(), []);
});

test('an offline app deletion outbox uses the production chat relay and negotiated remove method after reconnect', async (t) => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const { createDeletionOutbox } = require('../electron/host/deletionOutbox.cjs');
  const { chatCalls } = require('../electron/host/remoteChatCalls.cjs');
  const dir = tmp(t);
  const s = journalWorld(dir);
  const c = await s.open('claude:roundtrip');
  let online = false;
  const host = chatCalls({
    needs: () => {},
    request: (m: string, p: any) => c.conn.call(m, p),
    epochOf: () => 99,
    mintKey: () => 'unused-key',
    speaks: () => true,
  });
  const q = createDeletionOutbox({
    dir: path.join(dir, 'app-deletions'),
    identity: () => 'paired',
    hostFor: () => host,
    rowOf: () => ({ status: online ? 'online' : 'offline' }),
  });
  q.enqueue({ hostId: 'machine', chatId: 'claude:roundtrip', epoch: 1 });
  await q.flush();
  assert.equal(q.pending().length, 1);
  online = true;
  await q.flush();
  assert.deepEqual(q.pending(), []);
  assert.throws(() => createSessionJournal({ dataDir: dir }).read('claude:roundtrip'), { code: 'session_journal_deleted' });
});

test("deletion is fenced by the chat epoch and cannot delete a newer owner's journal", async (t) => {
  const s = journalWorld(tmp(t));
  const c = await s.open('claude:epoch');
  await c.conn.call('chat.subscribe', { chatId: 'claude:epoch', epoch: 3 });
  await assert.rejects(c.conn.call('chat.remove', { chatId: 'claude:epoch', epoch: 1, key: 'old-delete-key' }), { code: 'stale_epoch' });
  await c.conn.call('chat.subscribe', { chatId: 'claude:epoch', epoch: 3 });
});

test('deleting during a synchronous native permission answer cannot write its later echo into a retired journal', async (t) => {
  let c: any, removing: Promise<any> | undefined;
  const id = 'claude:answer-delete';
  const s = journalWorld(tmp(t), undefined, {
    permit: () => {
      removing = c.conn.call('chat.remove', { chatId: id, epoch: 1, key: 'delete-after-answer' });
      return true;
    },
  });
  c = await s.open(id);
  s.host.emit('event', { kind: 'turnStart', key: id, turnId: 'active-answer' });
  await c.conn.call('chat.answer', { chatId: id, epoch: 1, key: 'permission-answer', requestId: 'card' });
  await removing;
  assert.ok(s.stopped.includes(id));
});

for (const nativeId of ['claude:3f2b6f58-4a1e-4e0b-9b7c-1d2e3f4a5b6c', '3f2b6f58-4a1e-4e0b-9b7c-1d2e3f4a5b6c', 'acp:kimi:native-delete'])
  test(`${nativeId}: app deletion retires the actual native journal through the translated remote Host`, async (t) => {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const { chatCalls } = require('../electron/host/remoteChatCalls.cjs');
    const { withAppChatIds } = require('../electron/host/chatIds.cjs');
    const { createDeletionOutbox } = require('../electron/host/deletionOutbox.cjs');
    const { appChatId } = await import('../shared/host/chatIds.mjs');
    const dir = tmp(t);
    const s = journalWorld(dir);
    const c = await s.open(nativeId);
    const wire = chatCalls({
      needs: () => {},
      request: (m: string, p: any) => c.conn.call(m, p),
      epochOf: () => 99,
      mintKey: () => 'unused-key',
      speaks: () => true,
    });
    const host = withAppChatIds(wire, () => true);
    const q = createDeletionOutbox({
      dir: path.join(dir, 'app-deletions'),
      identity: () => 'paired',
      hostFor: () => host,
      rowOf: () => ({ status: 'online' }),
    });
    q.enqueue({ hostId: 'machine', chatId: appChatId(nativeId), epoch: 1 });
    await q.flush();
    assert.equal(q.pending().length, 0);
    assert.throws(() => createSessionJournal({ dataDir: dir }).read(nativeId), { code: 'session_journal_deleted' });
  });

test('a partial deletion retries the same wire key after disk repair rather than replaying a permanent failure', async (t) => {
  const s = journalWorld(tmp(t));
  const c = await s.open('claude:retry-delete');
  s.host.emit('event', { kind: 'turnStart', key: 'claude:retry-delete', turnId: 'native-delete' });
  const rename = fs.renameSync;
  const fault = t.mock.method(fs, 'renameSync', (...args: any[]) => {
    if (String(args[0]).includes('/sessions/')) throw new Error('disk failure while retiring directory');
    return (rename as any)(...args);
  });
  const request = { chatId: 'claude:retry-delete', epoch: 1, key: 'retry-delete-key' };
  await assert.rejects(c.conn.call('chat.remove', request), { code: 'session_journal_delete_failed' });
  fault.mock.restore();
  assert.equal((await c.conn.call('chat.remove', request)).result.removed, true);
});

test('a native session being prepared when deletion commits rechecks the tombstone before starting its first model turn', async (t) => {
  let entered: any, release: any;
  const starting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let sends = 0;
  const s = journalWorld(
    tmp(t),
    async () => {
      sends++;
      return { turnId: 'never' };
    },
    {
      prepare: async (p) => {
        entered();
        await held;
        p.check();
      },
    },
  );
  const c = await s.open('claude:00000000-0000-4000-8000-000000000511');
  const send = c.conn.call('chat.start', {
    chatId: 'claude:00000000-0000-4000-8000-000000000511',
    epoch: 1,
    key: 'start-before-delete',
    harness: 'claude',
    text: 'first turn',
  });
  const refused = assert.rejects(send, { code: 'session_journal_deleted' });
  await starting;
  await c.conn.call('chat.remove', { chatId: 'claude:00000000-0000-4000-8000-000000000511', epoch: 1, key: 'delete-before-first-turn' });
  release();
  await refused;
  assert.equal(sends, 0);
});
