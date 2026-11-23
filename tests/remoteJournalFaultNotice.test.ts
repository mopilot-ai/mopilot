// Storage notices remain visible without a current live turn and cannot mutate a retired chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { createRemoteJournalFaults } = require('../electron/host/remoteJournalFaults.cjs');

test('typed storage failure clears live text and patches only a still-followed known session', () => {
  const patched: any[] = [];
  const emitted: any[] = [];
  const store = { has: () => true, patch: (...p: any[]) => patched.push(p) };
  const f = { chatId: 'c', gone: false, shown: new Map([['k', 'live']]) };
  const notices = createRemoteJournalFaults({ emit: (e: any) => emitted.push(e), state: () => store });
  notices.show(f, undefined);
  notices.show(f, 'unsubscribed');
  assert.equal(patched.length, 0);
  notices.show(f, 'session_journal_unreadable');
  assert.equal(patched[0][0], 'c');
  assert.match(patched[0][1].error, /This machine/);
  assert.equal(f.shown.size, 0);
  notices.observe(f, { kind: 'turnStart', turnId: 't' });
  notices.observe(f, { kind: 'turnEnd', turnId: 't' });
  notices.show(f, 'session_journal_full');
  assert.equal(emitted.length, 0);
  f.gone = true;
  notices.show(f, 'session_journal_full');
  assert.equal(patched.length, 2);
  const absent = createRemoteJournalFaults({ emit: () => {}, state: () => null });
  absent.show({ ...f, gone: false }, 'session_journal_full');
});
