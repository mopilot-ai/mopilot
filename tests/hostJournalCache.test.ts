// Bounded stream projections evict only inactive reconstructible chats while live subscriptions and ephemeral work retain their identity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionJournal } from '../host/src/sessionJournal.mjs';
import { createStreamHub } from '../host/src/stream.mjs';

test('cache pressure preserves active subscriptions and ephemeral keys, and cold reopening preserves generation/cursor', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let hub: ReturnType<typeof createStreamHub>;
  const storage = createSessionJournal({ dataDir: dir, maxCachedChats: 2, active: (id) => hub.active(id) });
  hub = createStreamHub({ storage, maxCachedChats: 2, snapshot: (id) => ({ rev: storage.head(id).rev }), epoch: () => 1 });
  hub.state('a', { title: 'a' });
  hub.state('b', { title: 'b' });
  const before = storage.read('b');
  const a = hub.subscribe('a', { send: () => true, close: () => {} });
  hub.state('c', { title: 'c' }); // evicts b, not active a
  const frames: any[] = [];
  const b = hub.subscribe('b', { send: (frame) => (frames.push(frame), true), close: () => {} });
  assert.equal(frames[0].generation, before.generation);
  assert.ok(frames[0].seq >= before.seq);
  assert.throws(() => hub.state('d', {}), { code: 'session_journal_busy' });
  b.unsubscribe();
  hub.state('d', {});
  hub.delta('d', 'pending', { text: 'live' });
  assert.equal(hub.active('d'), true);
  assert.throws(() => hub.state('e', {}), { code: 'session_journal_busy' });
  hub.retract('d', 'pending');
  a.unsubscribe();
  hub.state('e', {});
  assert.equal(hub.active('missing'), false);
  hub.remove('missing');
  assert.equal(storage.evictable('missing'), true);
});

test('a failed but readable cached projection stays pinned until its uncertain disk state can be reconciled', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-cache-failure-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let failed = false;
  const io = {
    ...fs,
    writeFileSync: (...args: any[]) => {
      if (failed) throw new Error('disk full');
      return (fs.writeFileSync as any)(...args);
    },
  } as typeof fs;
  const j = createSessionJournal({ dataDir: dir, maxCachedChats: 1, io });
  j.check('a');
  failed = true;
  assert.throws(() => j.state('a', { title: 'failed' }));
  assert.equal(j.evictable('a'), false);
  assert.throws(() => j.read('b'), { code: 'session_journal_busy' });
  failed = false;
  j.check('a');
  assert.equal(j.evictable('a'), true);
});

test('the production chat log bounds both history and stream caches and reloads a cold generation safely', async (t) => {
  const { createChatLog } = await import('../host/src/chatLog.mjs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-production-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = createChatLog({ dataDir: dir, epoch: () => 1 });
  let original = '';
  for (let i = 0; i < 130; i++) {
    log.finish(`c${i}`, { t: 'user', messageKey: 'input', text: 'kept' });
    if (i === 0)
      log.hub
        .subscribe('c0', {
          send: (frame: any) => {
            original = frame.generation;
            return true;
          },
          close: () => {},
        })
        .unsubscribe();
  }
  const frames: any[] = [];
  log.hub.subscribe('c0', { send: (frame) => (frames.push(frame), true), close: () => {} }).unsubscribe();
  assert.equal(frames[0].generation, original);
  assert.equal(frames[0].snapshot.items[0].text, 'kept');
});
