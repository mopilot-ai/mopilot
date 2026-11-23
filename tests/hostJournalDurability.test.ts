// Durability barriers and append complexity are observable contracts, not incidental filesystem calls.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSessionJournal } from '../host/src/sessionJournal.mjs';
import { createStreamHub } from '../host/src/stream.mjs';
import { createChatLog } from '../host/src/chatLog.mjs';
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-journal-barrier-'));

test('checkpoint file fsync precedes rename, directory fsync follows rename, and event fsync precedes every publication', () => {
  const trace: string[] = [];
  const fds = new Map<number, string>();
  const io = {
    ...fs,
    openSync: (...args: any[]) => {
      const fd = (fs.openSync as any)(...args);
      fds.set(fd, path.basename(String(args[0])));
      return fd;
    },
    fsyncSync: (fd: number) => {
      trace.push(`sync:${fds.get(fd)}`);
      return fs.fsyncSync(fd);
    },
    writeFileSync: (...args: any[]) => {
      trace.push(`write:${fds.get(args[0])}`);
      return (fs.writeFileSync as any)(...args);
    },
    renameSync: (from: fs.PathLike, to: fs.PathLike) => {
      trace.push(`rename:${path.basename(String(to))}`);
      fs.renameSync(from, to);
    },
  } as typeof fs;
  const storage = createSessionJournal({ dataDir: temp(), io });
  const snapshot = () => {
    const s = storage.read('c');
    return { rev: s.rev, items: s.frames.map((f: any) => f.item) };
  };
  const hub = createStreamHub({ storage, snapshot, epoch: () => 1 });
  hub.subscribe('c', {
    send: (frame: any) => {
      if (frame.t === 'durable') {
        assert.equal(trace.at(-1), 'sync:events', 'a published durable must have its actual file fsynced immediately before publication');
        trace.push('publish');
      }
      return true;
    },
    close: () => {},
  });
  hub.durable('c', { rev: 1, item: { text: 'first' } });
  const rename = trace.indexOf('rename:checkpoint');
  assert.ok(rename > trace.indexOf('sync:checkpoint.next'));
  assert.ok(trace.slice(rename + 1).some((s) => s.startsWith('sync:') && s !== 'sync:events'));
  trace.length = 0;
  hub.durable('c', { rev: 2, item: { text: 'second' } });
  assert.deepEqual(trace, ['write:events', 'sync:events', 'publish'], 'normal append must not fsync a directory or checkpoint');
});

test('ordinary finish does not serialize or clone the whole historical projection', () => {
  const log = createChatLog({ dataDir: temp(), epoch: () => 1 });
  for (let i = 0; i < 30; i++) log.finish('c', { text: `old ${i}` });
  const stringify = JSON.stringify;
  const clone = structuredClone;
  let serializedHistories = 0;
  let clonedHistories = 0;
  try {
    JSON.stringify = ((v: any, ...args: any[]) => {
      if (Array.isArray(v?.frames) && v.frames.length > 20) serializedHistories++;
      return (stringify as any)(v, ...args);
    }) as typeof JSON.stringify;
    globalThis.structuredClone = ((v: any, ...args: any[]) => {
      if (Array.isArray(v?.frames) && v.frames.length > 20) clonedHistories++;
      return (clone as any)(v, ...args);
    }) as typeof structuredClone;
    log.finish('c', { text: 'new' });
    assert.equal(serializedHistories, 0);
    assert.equal(clonedHistories, 0);
  } finally {
    JSON.stringify = stringify;
    globalThis.structuredClone = clone;
  }
});

test('zeroed final row is repaired, read-only subscription creates no files, and full storage can still be removed', () => {
  const dir = temp();
  const j = createSessionJournal({ dataDir: dir, maxBytes: 1500 });
  j.read('c');
  assert.deepEqual(fs.readdirSync(dir), []);
  j.check('c');
  j.durable('c', { seq: j.next('c'), rev: 1, item: { text: 'kept' } });
  const folder = fs.readdirSync(path.join(dir, 'sessions'))[0];
  const file = path.join(dir, 'sessions', folder, 'events');
  fs.appendFileSync(file, `${'\0'.repeat(40)}\n`);
  const notes: string[] = [];
  const reopened = createSessionJournal({ dataDir: dir, maxBytes: 1500, report: (m) => notes.push(m) });
  assert.equal(reopened.read('c').rev, 1);
  assert.equal(notes.length, 1);
  assert.throws(() => reopened.durable('c', { seq: reopened.next('c'), rev: 2, item: { text: 'x'.repeat(2000) } }));
  assert.equal(reopened.read('c').rev, 1);
  reopened.remove('c');
  // a removed chat stays removed: its journal reads as deleted, not as a new empty chat
  assert.throws(
    () => reopened.read('c'),
    (e: any) => e.code === 'session_journal_deleted',
  );
});

test('an invalid durable is refused before writing and cannot corrupt the previously readable journal', () => {
  const dataDir = temp();
  const j = createSessionJournal({ dataDir });
  j.check('c');
  j.durable('c', { seq: j.next('c'), rev: 1, item: { text: 'kept' } });
  assert.throws(() => j.durable('c', { seq: j.next('c'), rev: 1, item: { text: 'bad revision' } }));
  assert.equal(createSessionJournal({ dataDir }).read('c').rev, 1);
});
