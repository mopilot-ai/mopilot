// MoMo's index of its past chats (electron/momo/historyIndex.cjs, #2999 P1): chunks added once per chat and turn, found by part of a question in any script (Chinese by character pairs), a routine run's chunk below the user's own, the asking chat left out, a deleted chat taken out; saved sealed (never plain text), kept in memory only without encryption, turned off (and never written over) when the saved file can't be opened, and emptied by Reset.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe } from './support/computerHistory.ts';

const require = createRequire(import.meta.url);
const { HistoryIndex, matchOf, MAX_SIDE } = require('../electron/momo/historyIndex.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momo-history-')), 'history');
const chunk = (o: Record<string, unknown> = {}) => ({
  chatId: 'c1',
  turnId: 't1',
  at: 1000,
  harness: 'claude',
  kind: 'main',
  user: '',
  assistant: '',
  ...o,
});

test('a question finds the turn that shares part of it, in Chinese, English and mixed text', () => {
  const ix = new HistoryIndex({ dir: tmp(), safeStorage: fakeSafe() });
  assert.equal(ix.available(), true);
  assert.equal(
    ix.add([
      chunk({ turnId: 't1', user: '我下个月要去东京出差两周', assistant: '好的，记住了' }),
      chunk({ turnId: 't2', user: 'Book the dentist for Friday', assistant: 'Done', at: 2000 }),
      chunk({ turnId: 't3', user: '房东说月底前要续约', assistant: '要我提醒你吗？', at: 3000 }),
    ]),
    3,
  );
  assert.deepEqual(
    ix.search('东京那次出差安排好了吗').map((c: any) => c.turnId),
    ['t1'],
  );
  assert.deepEqual(
    ix.search('when is the DENTIST').map((c: any) => c.turnId),
    ['t2'],
  );
  assert.deepEqual(
    ix.search('续约 lease').map((c: any) => c.turnId),
    ['t3'],
  );
  const [hit] = ix.search('东京');
  assert.deepEqual(hit, {
    chatId: 'c1',
    turnId: 't1',
    at: 1000,
    harness: 'claude',
    kind: 'main',
    user: '我下个月要去东京出差两周',
    assistant: '好的，记住了',
  });
  assert.deepEqual(ix.search('nothing like this'), []);
  assert.deepEqual(ix.search('   '), [], 'a query with no words finds nothing');
  assert.deepEqual(ix.search(undefined), []);
  assert.equal(ix.count(), 3);
});

test('a chat and turn is added once; empty and nameless chunks are skipped; an unknown kind is a main chat; sides are clipped', () => {
  const ix = new HistoryIndex({ dir: tmp(), safeStorage: fakeSafe() });
  assert.equal(ix.add([chunk({ user: 'tea in Kyoto' })]), 1);
  assert.equal(ix.add([chunk({ user: 'tea in Kyoto, again' })]), 0, 'the same chat and turn stays as it was');
  assert.equal(
    ix.add([
      chunk({ turnId: 't2', user: '  ', assistant: '' }),
      chunk({ chatId: '', turnId: 't3', user: 'x' }),
      chunk({ turnId: '', user: 'x' }),
      chunk({ turnId: 't4', user: 7 as any, assistant: 'only an answer', kind: 'odd', harness: undefined, at: Number.NaN }),
      chunk({ turnId: 't5', user: 'k'.repeat(MAX_SIDE + 50) }),
    ]),
    2,
  );
  assert.deepEqual([...ix.indexedTurns('c1')].sort(), ['t1', 't4', 't5']);
  const t4 = ix.search('answer')[0];
  assert.deepEqual([t4.kind, t4.harness, t4.at, t4.user], ['main', '', 0, '']);
  assert.equal(ix.search('k'.repeat(10))[0]?.user ?? '', '', 'a clipped side is still kept');
  assert.equal(ix.add([]), 0);
});

test('a routine run ranks below the user’s own chat, newer first among equals; the asking chat is left out; limits are bounded', () => {
  const ix = new HistoryIndex({ dir: tmp(), safeStorage: fakeSafe() });
  ix.add([
    chunk({ chatId: 'r', turnId: 'a', kind: 'routine', user: 'briefing: dentist Friday', at: 9000 }),
    chunk({ chatId: 'm', turnId: 'b', kind: 'main', user: 'briefing: dentist Friday', at: 1000 }),
    chunk({ chatId: 'p', turnId: 'c', kind: 'previous', user: 'briefing: dentist Friday', at: 5000 }),
  ]);
  assert.deepEqual(
    ix.search('dentist').map((c: any) => c.chatId),
    ['p', 'm', 'r'],
  );
  assert.deepEqual(
    ix.search('dentist', { excludeChat: 'p' }).map((c: any) => c.chatId),
    ['m', 'r'],
  );
  assert.equal(ix.search('dentist', { limit: 1 }).length, 1);
  assert.equal(ix.search('dentist', { limit: 0 }).length, 1, 'at least one');
  assert.equal(ix.search('dentist', { limit: Number.NaN }).length, 3, 'the default');
});

test('a deleted chat is taken out; a chat it never had changes nothing', () => {
  const ix = new HistoryIndex({ dir: tmp(), safeStorage: fakeSafe(), saveMs: 60_000 });
  ix.add([chunk({ chatId: 'a', user: 'Kyoto' }), chunk({ chatId: 'b', user: 'Kyoto' })]);
  ix.flush();
  ix.removeChat('nope');
  assert.equal(ix.dirty, false, 'nothing to save');
  ix.removeChat('a');
  assert.deepEqual(
    ix.search('Kyoto').map((c: any) => c.chatId),
    ['b'],
  );
  assert.equal(ix.dirty, true);
  ix.flush();
});

test('saved sealed and read back by the next run; the file never holds the plain text; the folder is owner-only', async () => {
  const dir = tmp();
  const ix = new HistoryIndex({ dir, safeStorage: fakeSafe(), saveMs: 5 });
  ix.add([chunk({ user: 'secret plan: Kyoto in May' })]);
  await new Promise((r) => setTimeout(r, 40));
  const bytes = fs.readFileSync(path.join(dir, 'index.sqlite.enc'));
  assert.equal(bytes.includes(Buffer.from('Kyoto')), false);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  const again = new HistoryIndex({ dir, safeStorage: fakeSafe() });
  assert.deepEqual(
    again.search('Kyoto').map((c: any) => c.user),
    ['secret plan: Kyoto in May'],
  );
  ix.flush();
  assert.equal(ix.dirty, false, 'a flush with nothing new writes nothing');
});

test('without encryption the index works for this run and nothing is written', () => {
  const dir = tmp();
  const ix = new HistoryIndex({ dir, safeStorage: fakeSafe(false), saveMs: 60_000 });
  ix.add([chunk({ user: 'Kyoto' })]);
  ix.flush();
  assert.equal(ix.search('Kyoto').length, 1);
  assert.equal(fs.existsSync(dir), false);
});

test('a saved index another key sealed is not opened and never written over; a failed save is noted', () => {
  clearIgnored();
  const dir = tmp();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'index.sqlite.enc'), 'not sealed');
  const ix = new HistoryIndex({ dir, safeStorage: fakeSafe() });
  assert.equal(ix.available(), false);
  assert.equal(ix.add([chunk({ user: 'Kyoto' })]), 0);
  assert.deepEqual(ix.search('Kyoto'), []);
  assert.deepEqual([...ix.indexedTurns('c1')], []);
  assert.equal(ix.count(), 0);
  ix.removeChat('c1');
  ix.flush();
  assert.equal(fs.readFileSync(path.join(dir, 'index.sqlite.enc'), 'utf8'), 'not sealed');
  assert.ok(recentIgnored().some((e: any) => /open MoMo's index/.test(JSON.stringify(e))));

  // a save that fails (the OS key refuses to seal its data key) is noted, and the change is kept to save again
  const refusing = {
    ...fakeSafe(),
    encryptString: () => {
      throw new Error('keychain refused');
    },
  };
  const ix2 = new HistoryIndex({ dir: tmp(), safeStorage: refusing, saveMs: 60_000 });
  ix2.add([chunk({ user: 'Kyoto' })]);
  ix2.flush();
  assert.equal(ix2.dirty, true);
  assert.ok(recentIgnored().some((e: any) => /save MoMo's index/.test(JSON.stringify(e))));
});

test('Reset empties the index and deletes its folder; the next change makes it again', () => {
  const dir = tmp();
  const ix = new HistoryIndex({ dir, safeStorage: fakeSafe(), saveMs: 60_000 });
  ix.add([chunk({ user: 'Kyoto' })]);
  ix.flush();
  ix.add([chunk({ turnId: 't2', user: 'Osaka' })]);
  ix.reset();
  assert.equal(fs.existsSync(dir), false);
  assert.deepEqual(ix.search('Kyoto'), []);
  ix.add([chunk({ turnId: 't3', user: 'Nara' })]);
  ix.flush();
  assert.equal(new HistoryIndex({ dir, safeStorage: fakeSafe() }).search('Nara').length, 1);
  // a reset before anything was opened
  const fresh = new HistoryIndex({ dir: tmp(), safeStorage: fakeSafe() });
  fresh.reset();
  assert.equal(fresh.count(), 0);
});

test('the match is each distinct word quoted, any of them', () => {
  assert.equal(matchOf('东京 tea'), '"东京" OR "tea"');
  assert.equal(matchOf(''), '');
  assert.equal(matchOf(null), '');
  assert.equal(matchOf('tea tea'), '"tea"');
});
