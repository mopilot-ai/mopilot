// Failed cancellation and failed recovery acknowledgement cannot escape into harness callbacks or drop unfinished recovery entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createJournalFaults } from '../host/src/journalFaults.mjs';
import { createRunJournal } from '../host/src/runJournal.mjs';
import { assistantItem } from '../host/src/chatLog.mjs';
import { createSessionJournal } from '../host/src/sessionJournal.mjs';

test('cancellation failures are reported once and an unowned event cannot throw into its emitter', async () => {
  for (const cancel of [
    () => {
      throw new Error('sync failure');
    },
    () => Promise.reject(new Error('async failure')),
  ]) {
    const closed: any[] = [];
    const reported: string[] = [];
    const faults = createJournalFaults({
      hub: { close: (...args: any[]) => closed.push(args) } as any,
      cancel,
      report: (m) => reported.push(m),
    });
    faults.fail('c', { code: 'unrelated' });
    faults.fail('c', null);
    await Promise.resolve();
    assert.ok(reported.some((m) => m.includes('could not be stopped')));
    assert.ok(closed.every(([, code]) => code === 'session_journal_write_failed'));
    const host = new EventEmitter();
    faults.listen(
      host,
      () => null,
      () => {
        throw new Error('bad record');
      },
      () => {},
    );
    assert.doesNotThrow(() => host.emit('event', {}));
    assert.ok(reported.some((m) => m.includes('unowned')));
  }
});

test('failed recovery-marker removal is retryable and keeps the turn marked', (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-marker-fail-'));
  const journal = createRunJournal({ dataDir, report: () => {} });
  journal.begin('before-lock', 'c'); // no disk access before start
  journal.start();
  journal.begin('t', 'c');
  const real = fs.renameSync;
  const mocked = t.mock.method(fs, 'renameSync', () => {
    throw new Error('full disk');
  });
  assert.throws(() => journal.end('t'), /full disk/);
  mocked.mock.restore();
  assert.ok(
    createRunJournal({ dataDir })
      .start()
      .some(([id]) => id === 't'),
  );
  journal.end('t');
  journal.end('not-running');
  assert.equal(typeof real, 'function');
});

test('reply summary keeps null/missing stop and both native string and object error shapes', () => {
  assert.deepEqual(assistantItem({ text: 'reply' }, { turnId: 't', error: 'raw' }), {
    t: 'assistant',
    turnId: 't',
    text: 'reply',
    stopReason: null,
    error: 'raw',
  });
  assert.equal(assistantItem({ text: '' }, { error: { message: 'structured' } }).error, 'structured');
});

test('a failed writer can still read while disk remains broken, and removing an unwritten chat is harmless', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'journal-still-broken-'));
  const journal = createSessionJournal({ dataDir, report: () => {} });
  journal.remove('unwritten');
  journal.check('c');
  journal.durable('c', { seq: journal.next('c'), rev: 1, item: { text: 'kept' } });
  const leaf = fs.readdirSync(path.join(dataDir, 'sessions'))[0];
  const file = path.join(dataDir, 'sessions', leaf, 'events');
  fs.renameSync(file, `${file}.saved`);
  fs.mkdirSync(file);
  assert.throws(() => journal.state('c', { title: 'failed' }));
  assert.throws(() => journal.check('c'));
  assert.equal(journal.read('c').rev, 1);
});
