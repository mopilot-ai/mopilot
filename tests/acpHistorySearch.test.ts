// Searching and listing basic-tier chats without blocking main (electron/harness/acp/history.cjs, ItemsLog's
// asynchronous reads, electron/platform/searchScans.cjs): the scan is bounded in files and time, a box's newer search replaces
// its older one, and a transcript gone meanwhile is skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { listChats, searchChats } = require('../electron/harness/acp/history.cjs');
const { searchCaller, searchScans, SEARCH_FILES, SEARCH_MS } = require('../electron/platform/searchScans.cjs');
const { ItemsLog } = require('../electron/platform/chats.cjs');
const { AcpHost } = require('../electron/harness/acp.cjs');
const { recentIgnored, clearIgnored } = require('../electron/ignored.cjs');

const parseKey = (key: string) => (key.startsWith('acp:') ? { harness: key.split(':')[1], id: key } : null);
const session = (cwd = '/w') => JSON.stringify({ t: 'session', cwd, sessionId: 'n', at: 1 }) + '\n';
const user = (text: string) => JSON.stringify({ t: 'user', user: { content: [{ type: 'text', text }] } }) + '\n';

/** An ItemsLog stand-in over texts by id, newest first; `readText` may be replaced. */
function fakeItems(texts: Record<string, string>) {
  const log = new ItemsLog(os.tmpdir());
  const reads: string[] = [];
  const items: any = {
    listAsync: async () => Object.keys(texts).map((id, i) => ({ id, mtime: 1000 - i })),
    readText: async (id: string) => (reads.push(id), texts[id]),
    // what the crate does with a transcript's text, which core/crates/transcript tests
    scan: async (id: string, { needle }: { needle?: string }) => {
      const text = await items.readText(id);
      return { records: log.parse(text), torn: 0, found: Boolean(needle) && text.toLowerCase().includes(needle as string) };
    },
  };
  return { items, reads };
}

test('search reads at most SEARCH_FILES transcripts, newest first, and skips other files', async () => {
  const texts: Record<string, string> = { 'not-acp': session() };
  for (let i = 0; i <= SEARCH_FILES; i++) texts[`acp:kimi:${i}`] = session() + user(i === SEARCH_FILES ? 'needle' : 'hay');
  const { items, reads } = fakeItems(texts);
  assert.deepEqual(await searchChats(items, parseKey, 'needle'), [], 'the one past the bound is not read');
  assert.equal(reads.length, SEARCH_FILES);
  assert.equal(reads.includes('not-acp'), false);
  assert.equal((await searchChats(items, parseKey, 'HAY', 2)).length, 2, 'stops at the limit');
});

test('search starts no read once SEARCH_MS has passed', async (t) => {
  const { items, reads } = fakeItems({ 'acp:kimi:a': session() + user('needle'), 'acp:kimi:b': session() + user('needle') });
  let now = 0;
  t.mock.method(Date, 'now', () => now);
  items.readText = async (id: string) => {
    reads.push(id);
    now += SEARCH_MS;
    return session() + user('needle');
  };
  assert.deepEqual(
    (await searchChats(items, parseKey, 'needle')).map((c: any) => c.id),
    ['acp:kimi:a'],
  );
  assert.deepEqual(reads, ['acp:kimi:a']);
});

test('temporary machine side chats never take a slot in saved chat lists or search', async () => {
  const side = `acp:kimi:side-chat-${crypto.randomUUID()}`;
  const kept = 'acp:kimi:kept';
  const records = session() + user('needle');
  const { items, reads } = fakeItems({ [side]: records, [kept]: records });
  items.readKindsAsync = async (id: string) => new ItemsLog(os.tmpdir()).parse(await items.readText(id));
  const listed = await listChats(items, parseKey);
  const hits = await searchChats(items, parseKey, 'needle', 1);
  assert.deepEqual(
    listed.map((c: any) => c.id),
    [kept],
  );
  assert.deepEqual(
    hits.map((c: any) => c.id),
    [kept],
  );
  assert.deepEqual(reads, [kept, kept]);
});

test('a transcript gone since it was listed, or one without a session, matches nothing', async () => {
  const { items } = fakeItems({ 'acp:kimi:gone': '', 'acp:kimi:nosession': user('needle'), 'acp:kimi:ok': session() + user('needle') });
  const read = items.readText;
  items.readText = async (id: string) => {
    if (id === 'acp:kimi:gone') throw Object.assign(new Error('ENOENT: gone'), { code: 'ENOENT' });
    return read(id);
  };
  assert.deepEqual(
    (await searchChats(items, parseKey, 'needle')).map((c: any) => c.id),
    ['acp:kimi:ok'],
  );
  clearIgnored();
  items.readText = async () => {
    throw Object.assign(new Error('EACCES: denied'), { code: 'EACCES' });
  };
  assert.deepEqual(await searchChats(items, parseKey, 'needle'), []);
  assert.deepEqual(
    recentIgnored().map((e: any) => e.message),
    ['EACCES: denied'],
    'an unreadable transcript is recorded',
  );
});

test("a search box's newer search replaces its older scan; another box's goes on", async () => {
  const { items } = fakeItems({ 'acp:kimi:a': session() + user('needle'), 'acp:kimi:b': session() + user('needle') });
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const read = items.readText;
  let first = true;
  items.readText = async (id: string) => {
    if (first) {
      first = false;
      await held;
    }
    return read(id);
  };
  const host = new AcpHost({ items, quirks: () => null, resolveBin: () => null });
  const older = host.search('needle', 30, '1:palette');
  const other = host.search('needle', 30, '2:palette');
  const newer = host.search('needle', 30, '1:palette');
  release();
  assert.deepEqual(await older, [], 'replaced before its next read');
  assert.equal((await other).length, 2);
  assert.equal((await newer).length, 2);
  // done: the next search for the box starts afresh
  assert.equal((await host.search('needle', 30, '1:palette')).length, 2);
});

test('searchScans: each caller keeps only its newest scan; searchCaller names the window and the box', async () => {
  const run = searchScans();
  const seen: boolean[] = [];
  let go!: () => void;
  const wait = new Promise<void>((r) => (go = r));
  const a = run('x', async (replaced: () => boolean) => {
    await wait;
    seen.push(replaced());
    return 'a';
  });
  const b = run('x', async (replaced: () => boolean) => (seen.push(replaced()), 'b'));
  go();
  assert.deepEqual(await Promise.all([a, b]), ['a', 'b']);
  assert.deepEqual(seen, [false, true], 'b ran first, unreplaced; a saw it was replaced');
  await assert.rejects(
    run('y', async () => {
      throw new Error('scan failed');
    }),
    /scan failed/,
  );
  assert.equal(await run('y', async (replaced: () => boolean) => replaced()), false, 'a failed scan lets go of its caller');
  assert.equal(searchCaller({ sender: { id: 3 } }, 'mentions'), '3:mentions');
  assert.equal(searchCaller(null, undefined), ':');
});

test('ItemsLog: asynchronous list as its synchronous form, and read; history and list read without blocking', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'acp-history-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const log = new ItemsLog(path.join(d, 'none'));
  assert.deepEqual(await log.listAsync(), [], 'no folder yet');
  const items = new ItemsLog(d);
  const recordsA = [
    { t: 'session', cwd: '/a', at: 1 },
    { t: 'user', user: { content: [{ type: 'text', text: 'hi' }] } },
  ];
  items.append('acp:kimi:a', ...recordsA);
  fs.utimesSync(items.file('acp:kimi:a'), 5, 5);
  items.append('acp:kimi:b', { t: 'session', cwd: '/b' });
  fs.utimesSync(items.file('acp:kimi:b'), 9, 9);
  fs.writeFileSync(path.join(d, 'other.txt'), '');
  fs.writeFileSync(path.join(d, '%E0%A4%A.items.jsonl'), '');
  assert.deepEqual(await items.listAsync(), items.list());
  assert.deepEqual(
    (await items.listAsync()).map((e: any) => e.id),
    ['acp:kimi:b', 'acp:kimi:a'],
  );
  // one removed between the listing and its time: listed at time 0
  const stat = fs.promises.stat;
  t.mock.method(fs.promises, 'stat', async (f: string) => {
    if (f === items.file('acp:kimi:b')) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return stat(f);
  });
  assert.deepEqual(await items.listAsync(), [
    { id: 'acp:kimi:a', mtime: 5000 },
    { id: 'acp:kimi:b', mtime: 0 },
  ]);
  t.mock.restoreAll();
  assert.deepEqual(await items.readAsync('acp:kimi:a'), recordsA);
  assert.deepEqual(await items.readAsync('acp:kimi:none'), [], 'no transcript yet');
  // no synchronous form: no main-process caller can block on a whole transcript
  assert.deepEqual([typeof (items as any).read, typeof (items as any).text], ['undefined', 'undefined']);
  const host = new AcpHost({ items, quirks: () => null, resolveBin: () => null });
  assert.deepEqual(await host.history('acp:kimi:a'), recordsA);
  assert.deepEqual(
    (await listChats(items, parseKey)).map((c: any) => [c.id, c.cwd, c.preview]),
    [
      ['acp:kimi:b', '/b', ''],
      ['acp:kimi:a', '/a', 'hi'],
    ],
  );
});
