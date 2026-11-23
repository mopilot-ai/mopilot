// Durable session journal fault/restart boundaries: keep committed history, never persist token deltas or reuse a sequence, fail closed on committed corruption.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createSessionJournal } from '../host/src/sessionJournal.mjs';
import { createChatLog } from '../host/src/chatLog.mjs';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-session-journal-'));
const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const folder = (dir: string, chatId = 'c') => path.join(dir, 'sessions', hash(chatId));
const line = (v: unknown) => {
  const s = JSON.stringify(v);
  return `${hash(s)} ${s}\n`;
};
function add(journal: ReturnType<typeof createSessionJournal>, text: string, chatId = 'c') {
  const before = journal.read(chatId);
  const seq = journal.next(chatId);
  journal.durable(chatId, { seq, rev: before.rev + 1, item: { text } });
  return seq;
}

test('a cold parent over the context-read budget leaves its saved journal unread', () => {
  const dataDir = tmp();
  add(createSessionJournal({ dataDir }), 'on disk');
  const reads: string[] = [];
  const readFileSync = (file: string, encoding: 'utf8') => {
    if (['checkpoint', 'events'].includes(path.basename(file))) reads.push(file);
    return fs.readFileSync(file, encoding);
  };
  const cold = createSessionJournal({ dataDir, io: { ...fs, readFileSync } as typeof fs });
  assert.deepEqual(cold.recentItems('c', 1, 1), { items: [], total: 0, omittedForSize: true });
  assert.deepEqual(reads, []);
  assert.deepEqual(cold.recentItems('missing', 1), { items: [], total: 0 });
  const saved = cold.recentItems('c', 1);
  assert.equal(saved.total, 1);
  assert.deepEqual(cold.recentItems('c', 1, 1), saved, 'a warm journal only copies the requested tail');
});

test('one journal separates chat ids, reserves sequences, rotates without losing history and removes without resurrection', () => {
  const dir = tmp();
  const j = createSessionJournal({ dataDir: dir, rotateBytes: 1, reserve: 2 });
  const seq = add(j, 'one');
  const generation = j.read('c').generation;
  j.next('c'); // ephemeral: its contents never enter the journal
  j.state('c', { title: 'A', goal: null });
  j.state('c', { title: 'B' });
  add(j, 'two');
  for (const id of ['../escape', 'claude:x', 'codex-id', 'acp:kimi:x']) add(j, id, id);
  const reopened = createSessionJournal({ dataDir: dir });
  assert.equal(reopened.read('c').generation, generation);
  assert.deepEqual(
    reopened.read('c').frames.map((f: any) => f.item.text),
    ['one', 'two'],
  );
  assert.deepEqual(reopened.read('c').state, { title: 'B', goal: null });
  assert.ok(reopened.next('c') > seq + 1);
  const copy = reopened.read('c');
  copy.frames.length = 0;
  assert.equal(reopened.read('c').rev, 2);
  assert.equal(reopened.read('claude:x').frames[0].item.text, 'claude:x');
  reopened.remove('c');
  assert.throws(() => reopened.read('c'), { code: 'session_journal_deleted' });
  assert.throws(() => createSessionJournal({ dataDir: dir }).next('c'), { code: 'session_journal_deleted' });
  assert.equal(
    fs.readdirSync(path.join(dir, 'sessions')).some((s) => s.includes('.removed.')),
    false,
  );
});

test('a torn final append is reported and removed, while complete committed corruption is never treated as an empty chat', () => {
  const dir = tmp();
  const j = createSessionJournal({ dataDir: dir });
  add(j, 'kept');
  const file = path.join(folder(dir), 'events');
  const good = fs.readFileSync(file);
  fs.appendFileSync(file, 'half a record 🦊');
  const reports: string[] = [];
  const recovered = createSessionJournal({ dataDir: dir, report: (m) => reports.push(m) });
  assert.equal(recovered.read('c').rev, 1);
  assert.equal(reports.length, 1);
  assert.deepEqual(fs.readFileSync(file), good);
  add(recovered, 'after repair');
  fs.appendFileSync(file, `broken committed middle line\n${line({ n: 999, kind: 'state', patch: {} })}`);
  assert.throws(
    () => createSessionJournal({ dataDir: dir }).read('c'),
    (e: any) => e.code === 'session_journal_unreadable',
  );
});

test('unsupported/corrupt checkpoints and missing checkpoints with existing events are explicit errors', () => {
  for (const bad of ['partial', line(null), line({ version: 2 }), `${line({})}${line({})}`, `${'a'.repeat(64)} {bad json}\n`, line([])]) {
    const dir = tmp();
    add(createSessionJournal({ dataDir: dir }), 'old');
    fs.writeFileSync(path.join(folder(dir), 'checkpoint'), bad);
    assert.throws(() => createSessionJournal({ dataDir: dir }).read('c'));
  }
  const dir = tmp();
  add(createSessionJournal({ dataDir: dir }), 'old');
  fs.unlinkSync(path.join(folder(dir), 'checkpoint'));
  assert.throws(() => createSessionJournal({ dataDir: dir }).read('c'), /checkpoint is missing/);
});

test('invalid committed records, revision gaps and wrong sequence owners are refused', () => {
  for (const row of [
    null,
    {},
    { n: -1 },
    { n: 3, kind: 'reserve', to: 999 },
    { n: 1, kind: 'unknown' },
    { n: 1, kind: 'reserve', to: -1 },
    { n: 1, kind: 'state', patch: [] },
    { n: 1, kind: 'durable', frame: { seq: 1, rev: 1, item: {} } },
  ]) {
    const dir = tmp();
    const j = createSessionJournal({ dataDir: dir });
    j.check('c');
    fs.writeFileSync(path.join(folder(dir), 'events'), line(row));
    assert.throws(() => createSessionJournal({ dataDir: dir }).read('c'));
  }
});

test('capacity and full-disk failures publish nothing and poison the writer instead of losing acknowledged history', () => {
  const dir = tmp();
  const j = createSessionJournal({ dataDir: dir, maxBytes: 1500 });
  add(j, 'kept');
  const next = j.next('c');
  assert.throws(
    () => j.durable('c', { seq: next, rev: 2, item: { text: 'x'.repeat(1600) } }),
    (e: any) => e.code === 'session_journal_full',
  );
  assert.equal(j.read('c').rev, 1, 'capacity failure must not block reads');
  assert.equal(j.read('c').storageError!.code, 'session_journal_full');
  assert.equal(createSessionJournal({ dataDir: dir }).read('c').rev, 1);
  let fail = false;
  const io = {
    ...fs,
    writeFileSync: (...args: any[]) => {
      if (fail) throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
      return (fs.writeFileSync as any)(...args);
    },
  } as typeof fs;
  const log = createSessionJournal({ dataDir: tmp(), io });
  add(log, 'kept');
  const allocated = log.next('c');
  fail = true;
  assert.throws(
    () => log.durable('c', { seq: allocated, rev: 2, item: {} }),
    (e: any) => e.code === 'session_journal_write_failed',
  );
  assert.equal(log.read('c').rev, 1);
  fail = false;
  add(log, 'retry after disk repair');
  assert.equal(log.read('c').rev, 2);
});

test('every write/rename/fsync boundary during rotation preserves prior history after reopen', () => {
  const ops = ['writeFileSync', 'fsyncSync', 'renameSync'] as const;
  for (const op of ops)
    for (const after of [false, true])
      for (let failAt = 1; failAt <= 8; failAt++) {
        const dir = tmp();
        let armed = false;
        let calls = 0;
        const io = {
          ...fs,
          [op]: (...args: any[]) => {
            const hit = armed && ++calls === failAt;
            if (hit && !after) throw new Error('simulated process stop');
            const result = (fs[op] as any)(...args);
            if (hit && after) throw new Error('simulated process stop');
            return result;
          },
        } as typeof fs;
        const j = createSessionJournal({ dataDir: dir, io, rotateBytes: 1, reserve: 1 });
        add(j, 'kept');
        armed = true;
        try {
          add(j, 'new');
        } catch {
          /* process ends before or after a filesystem boundary */
        }
        const s = createSessionJournal({ dataDir: dir }).read('c');
        assert.equal(s.frames[0].item.text, 'kept');
        assert.ok(s.rev === 1 || s.rev === 2);
        if (s.rev === 2) assert.equal(s.frames[1].item.text, 'new');
      }
});

test('terminal promotion and recovery retain durable-only history while both clients see ordered live frames', () => {
  const dir = tmp();
  const { hub, finish } = createChatLog({ dataDir: dir, epoch: () => 3 });
  const clients: any[][] = [[], []];
  for (const seen of clients) hub.subscribe('c', { send: (f) => (seen.push(f), true), close: () => undefined });
  hub.delta('c', 'text', 'discard unfinished');
  finish('c', { text: 'complete' }, 'text');
  hub.delta('c', 'another', 'not recovered');
  hub.state('c', { title: 'saved' });
  assert.deepEqual(clients[0], clients[1]);
  assert.ok(clients[0].every((f, i, rows) => i === 0 || f.seq > rows[i - 1].seq));
  const recovered = createChatLog({ dataDir: dir, epoch: () => 4 });
  const frames: any[] = [];
  recovered.hub.subscribe('c', { send: (f) => (frames.push(f), true), close: () => undefined });
  assert.deepEqual(frames[0].snapshot.items, [{ text: 'complete' }]);
  assert.deepEqual(frames[0].inFlightEphemeral, []);
  assert.deepEqual(frames[0].chatState, { title: 'saved' });
  assert.equal(frames[0].epoch, 4);
  recovered.finish('c', { text: 'next' });
  assert.ok(frames[1].seq > clients[0].at(-1).seq);
});

test('filesystem read failures and valid-checksum malformed JSON fail closed; invalid checkpoint frames are not history', () => {
  const dir = tmp();
  const j = createSessionJournal({ dataDir: dir });
  add(j, 'old');
  const file = path.join(folder(dir), 'checkpoint');
  const good = fs.readFileSync(file, 'utf8');
  const checkpoint = JSON.parse(good.slice(65));
  fs.writeFileSync(file, `${hash('{broken')} {broken\n`);
  assert.throws(() => createSessionJournal({ dataDir: dir }).read('c'), /not JSON/);
  fs.writeFileSync(file, line({ ...checkpoint, frames: [null] }));
  assert.throws(() => createSessionJournal({ dataDir: dir }).read('c'), /invalid durable history/);
  const io = {
    ...fs,
    readFileSync: () => {
      throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
    },
  } as unknown as typeof fs;
  assert.throws(
    () => createSessionJournal({ dataDir: dir, io, report: () => {} }).read('c'),
    (e: any) => e.code === 'session_journal_unreadable' && !e.message.includes(dir),
  );
});

test('Windows journal writes fsync files without attempting unsupported directory fsync', () => {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  const dir = tmp();
  const opened: string[] = [];
  const io = {
    ...fs,
    openSync: (...args: any[]) => {
      opened.push(args[1]);
      return (fs.openSync as any)(...args);
    },
  } as typeof fs;
  try {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const j = createSessionJournal({ dataDir: dir, io });
    add(j, 'kept');
    assert.equal(createSessionJournal({ dataDir: dir, io }).read('c').rev, 1);
    assert.ok(!opened.includes('r'), 'Windows must not open directories for fsync');
  } finally {
    Object.defineProperty(process, 'platform', original);
  }
});

test('reentrant subscriptions see the committed promotion and latest state before live publication', () => {
  const log = createChatLog({ dataDir: tmp(), epoch: () => 1 });
  const hellos: any[] = [];
  log.hub.delta('c', 'k', 'live');
  log.hub.subscribe('c', {
    send(frame: any) {
      if (frame.t === 'durable' || frame.t === 'state')
        log.hub.subscribe('c', { send: (f) => (hellos.push(f), true), close: () => undefined });
      return true;
    },
    close: () => undefined,
  });
  log.finish('c', { text: 'complete' }, 'k');
  log.hub.state('c', { title: 'new' });
  const snapshots = hellos.filter((f) => f.t === 'hello');
  assert.deepEqual(snapshots[0].inFlightEphemeral, []);
  assert.equal(snapshots[0].snapshot.rev, 1);
  assert.deepEqual(snapshots[1].chatState, { title: 'new' });
});
