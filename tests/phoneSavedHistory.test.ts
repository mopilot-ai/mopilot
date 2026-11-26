// The saved chat history on the phone (#5379): the sealed pages store is opened only by a build that keeps them, with its own table and its own device-only key; Settings > Privacy says so and clears it; the disk caches bind the clearing to the account in use and drop another account's rows.
import assert from 'node:assert/strict';
import { afterEach, mock, test } from 'node:test';
import { createRequire } from 'node:module';
import { act, createElement, createRoot, flush, click } from './support/phone/component-kit';
import { checkSecureKey, checkSecureValue } from './support/phone/secure-store-rules.ts';
const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const table = new Map<string, { value: string; at: number }>();
const statements: string[] = [];
const names: string[] = [];
let clock = Date.now();
let key: string | null = null;
let pagesKey: string | null = null;
const deleted: string[] = [];
let pagesWillOpen = true;
// what the Keychain does for the pages key: answers, refuses (a locked phone) or never answers
let keychain: 'ok' | 'locked' | 'hung' = 'ok';
// the marks in the cache folder, by name; the install mark is there unless a test says this is a first launch
const markers = new Set<string>(['mopilot-saved-history.marker']);
mock.module(require.resolve('expo-secure-store'), {
  namedExports: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 3,
    getItemAsync: async (name: string) => {
      checkSecureKey(name);
      names.push(name);
      if (name === 'mobile-remote-chat-pages-key') {
        if (keychain === 'locked') throw new Error('The Keychain is not available while the phone is locked');
        if (keychain === 'hung') return new Promise<string | null>(() => undefined);
        return pagesKey;
      }
      return key;
    },
    deleteItemAsync: async (name: string) => {
      checkSecureKey(name);
      if (keychain === 'locked') throw new Error('The Keychain is not available while the phone is locked');
      if (keychain === 'hung') return new Promise<void>(() => undefined);
      deleted.push(name);
      if (name === 'mobile-remote-chat-pages-key') pagesKey = null;
    },
    setItemAsync: async (name: string, value: string, options: any) => {
      checkSecureKey(name);
      checkSecureValue(value);
      assert.equal(options.keychainAccessible, 3, 'this device only');
      if (name === 'mobile-remote-chat-pages-key') pagesKey = value;
      else key = value;
    },
  },
});
mock.module(require.resolve('expo-file-system'), {
  namedExports: {
    Paths: { cache: 'cache' },
    File: class {
      name: string;
      constructor(_dir: string, name: string) {
        this.name = name;
      }
      get exists() {
        return markers.has(this.name);
      }
      create() {
        markers.add(this.name);
      }
      delete() {
        markers.delete(this.name);
      }
    },
  },
});
mock.module(require.resolve('expo-sqlite'), {
  namedExports: {
    openDatabaseAsync: async () => ({
      execAsync: async (sql: string) => {
        if (!pagesWillOpen && sql.includes('chat_pages')) throw new Error('database is locked');
        statements.push(sql);
      },
      getFirstAsync: async (_sql: string, k: string) => (table.has(k) ? { value: table.get(k)!.value } : null),
      getAllAsync: async () => [...table.entries()].sort((a, b) => a[1].at - b[1].at).map(([k]) => ({ key: k })),
      runAsync: async (sql: string, k?: string | number, value?: string) => {
        if (sql.startsWith('INSERT')) {
          table.set(String(k), { value: value!, at: ++clock });
        } else if (sql.includes('WHERE at <')) {
          for (const [name, row] of [...table]) if (row.at < Number(k)) table.delete(name);
        } else if (k !== undefined) {
          table.delete(String(k));
        } else {
          table.clear();
        }
      },
    }),
  },
});
const cryptoModulePath = '../mobile/src/platform/crypto.ts';
mock.module(new URL(cryptoModulePath, import.meta.url).href, {
  namedExports: {
    phonePrimitives: () => ({
      randomBytes: (n: number) => new Uint8Array(n).fill(9),
      aeadSeal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array) => plain,
      aeadOpen: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array) => box,
    }),
  },
});
// through variables, so the desktop typecheck does not follow into React Native's global types
const storePath = '../mobile/src/platform/chatStore.ts';
const flagPath = '../mobile/src/remote/pageCacheFlag.ts';
const savedPath = '../mobile/src/remote/savedHistory.ts';
const diskPath = '../mobile/src/remote/useDiskCaches.ts';
const pagesPath = '../mobile/src/screens/SettingsPages.tsx';
const { openChatCache, openPageCache } = await import(storePath);
const { pageCacheOn } = await import(flagPath);
const { bindSavedHistory, savedHistoryClear } = await import(savedPath);
const { useDiskCaches } = await import(diskPath);
const { PrivacyPage } = await import(pagesPath);

const rows = [{ id: 'r1', role: 'user', text: 'hello' }];
const flag = process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE;
afterEach(() => {
  process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE = flag;
  if (flag === undefined) delete process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE;
  pagesWillOpen = true;
  bindSavedHistory(null);
  table.clear();
  names.length = 0;
  deleted.length = 0;
  statements.length = 0;
  key = null;
  pagesKey = null;
  keychain = 'ok';
  markers.clear();
  markers.add('mopilot-saved-history.marker');
});

test('the page cache is off unless the build says 1', () => {
  delete process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE;
  assert.equal(pageCacheOn(), false);
  process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE = '0';
  assert.equal(pageCacheOn(), false);
  process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE = '1';
  assert.equal(pageCacheOn(), true);
});

/** Lets what a launch starts beside the rows cache finish. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

test('a build without the flag opens the rows only, and drops what an earlier build with it left, once: the table, the key and a mark', async () => {
  delete process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE;
  pagesKey = 'ab'.repeat(32);
  const cache = await openChatCache();
  assert.equal(cache.pages, undefined);
  await settle();
  assert.ok(
    statements.every((s) => !s.includes('CREATE TABLE IF NOT EXISTS chat_pages')),
    'nothing of it is made',
  );
  assert.ok(statements.includes('DROP TABLE IF EXISTS chat_pages'), 'the table an earlier build made goes');
  assert.deepEqual(deleted, ['mobile-remote-chat-pages-key']);
  assert.equal(pagesKey, null, 'and so does its key: what was sealed under it cannot be read again');
  assert.equal(markers.has('mopilot-saved-history.dropped'), true, 'marked: it is done once, not at every launch');
  deleted.length = 0;
  statements.length = 0;
  await openChatCache();
  await settle();
  assert.deepEqual(deleted, [], 'the next launch touches neither the database nor the Keychain for it');
  assert.equal(statements.filter((sql) => sql.includes('chat_pages')).length, 0);
});

test('a build without the flag does not wait for the Keychain: the rows cache is ready while the key is still being deleted, and a locked phone only means it is tried again', async () => {
  delete process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE;
  keychain = 'hung';
  const cache = await Promise.race([openChatCache(), new Promise((resolve) => setTimeout(() => resolve('waited for the Keychain'), 500))]);
  assert.notEqual(cache, 'waited for the Keychain', 'the rows cache did not wait for it');
  await (cache as any).save('k', [{ key: 'a', role: 'user', text: 'x' }]);
  assert.equal(table.size, 1, 'and works');
  assert.equal(markers.has('mopilot-saved-history.dropped'), false, 'not marked while it is not done');
  // a locked phone: the Keychain refuses; the rows cache is unaffected, nothing is marked, and the next launch tries again
  keychain = 'locked';
  const locked = await openChatCache();
  await settle();
  await locked.save('k2', [{ key: 'a', role: 'user', text: 'x' }]);
  assert.equal(markers.has('mopilot-saved-history.dropped'), false);
  keychain = 'ok';
  pagesKey = 'ab'.repeat(32);
  await openChatCache();
  await settle();
  assert.equal(pagesKey, null, 'tried again when the phone is unlocked');
  assert.equal(markers.has('mopilot-saved-history.dropped'), true);
});

test('a build with the flag keeps the pages in their own table under their own device-only key, and one clear reaches the rows and the pages', async () => {
  process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE = '1';
  const cache = await openChatCache();
  assert.ok(cache.pages);
  assert.equal(await cache.pages!.load('k'), null);
  assert.ok(statements.some((s) => s.includes('chat_pages')));
  assert.equal(cache.pages!.generation('k'), '0:0', 'once it is open, the open cache says');
  await cache.pages!.save('k', { rows, more: true });
  assert.ok(names.includes('mobile-remote-chat-pages-key'), 'its own key');
  assert.deepEqual((await (await openPageCache()).load('k'))!.rows, rows, 'read back by another opening');
  await cache.save('k2', [{ key: 'a', role: 'user', text: 'x' }]);
  assert.equal(table.size, 2);
  await cache.pages!.remove('k');
  await cache.pages!.save('k', { rows, more: true });
  await cache.pages!.prune((k) => k === 'k');
  assert.equal(table.size, 1, 'a prune reaches the table (this mock has one table for every store)');
  await cache.clear();
  assert.equal(table.size, 0, 'the rows and the pages go together');
  assert.ok(deleted.includes('mobile-remote-chat-pages-key'), 'a clear deletes the key too');
  assert.equal(pagesKey, null);
});

test('what is in the file: the key column names the account, computer and chat and nothing else, and the sealed value holds no text', async () => {
  process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE = '1';
  const cache = await openChatCache();
  const chat = JSON.stringify(['u', 'p', 'c']);
  await cache.pages!.save(chat, { rows: [{ id: 'r1', role: 'user', text: 'a private message' }], more: true });
  assert.deepEqual([...table.keys()], [chat], 'the key column is the account, computer and chat ids');
  const stored = JSON.parse(table.get(chat)!.value) as Record<string, string>;
  assert.deepEqual(Object.keys(stored).sort(), ['box', 'nonce'], 'the value is the nonce and the sealed box');
  assert.equal(typeof table.get(chat)!.at, 'number', 'and the time it was written');
});

test('the first launch since an install forgets a key the Keychain kept and a copy a backup brought; a launch after it keeps both', async () => {
  process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE = '1';
  pagesKey = 'cd'.repeat(32);
  table.set('old-chat', { value: '{}', at: Date.now() });
  markers.clear();
  await (await openChatCache()).pages!.load('x');
  assert.equal(markers.has('mopilot-saved-history.marker'), true, 'marked');
  assert.deepEqual(deleted, ['mobile-remote-chat-pages-key']);
  assert.equal(pagesKey, null, 'the key of the old install is gone');
  assert.equal(table.size, 0, 'and so is what was sealed under it');
  const cache = await openPageCache();
  await cache.save('chat', { rows, more: true });
  deleted.length = 0;
  await openPageCache();
  assert.deepEqual(deleted, [], 'a later launch deletes nothing');
  assert.equal(table.size, 1);
});

test('a copy whose key is gone is cleared at once, not written over as if it were empty; an old copy is swept', async () => {
  process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE = '1';
  const cache = await openPageCache();
  await cache.save('keep', { rows, more: true });
  table.set('stale', { value: '{}', at: 1 });
  await openPageCache();
  assert.equal(table.has('stale'), false, 'not opened for as long as a copy is kept: gone');
  assert.equal(table.has('keep'), true);
  pagesKey = null;
  await openPageCache();
  assert.equal(table.size, 0, 'the key is gone from the Keychain: nothing sealed under it is kept');
});

test('a pages store that will not open leaves the rows alone, and reads, writes and deletes nothing of its own', async () => {
  process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE = '1';
  pagesWillOpen = false;
  const cache = await openChatCache();
  await cache.save('k', [{ key: 'a', role: 'user', text: 'x' }]);
  assert.equal(table.size, 1);
  assert.equal(await cache.pages!.load('k'), null);
  assert.equal(await cache.pages!.save('k', { rows, more: true }), false);
  assert.equal(cache.pages!.generation('k'), '0:0');
  await cache.pages!.discard('k');
  await cache.pages!.remove('k');
  await cache.pages!.prune(() => false);
  await cache.clear();
  assert.equal(table.size, 0, 'the rows cache is cleared as it always was');
});

test('with the flag on the rows cache is ready before the page cache has finished its checks: a Keychain that never answers holds up the pages only', async () => {
  process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE = '1';
  keychain = 'hung';
  markers.clear();
  const cache = await Promise.race([openChatCache(), new Promise((resolve) => setTimeout(() => resolve('waited for the Keychain'), 500))]);
  assert.notEqual(cache, 'waited for the Keychain', 'the first paint does not wait for the pages');
  const paged = cache as any;
  await paged.save('k', [{ key: 'a', role: 'user', text: 'x' }]);
  assert.equal(table.size, 1);
  assert.equal(paged.pages.generation('k'), '0:0', 'before it is open nothing has been removed');
  const read = await Promise.race([paged.pages.load('k'), new Promise((resolve) => setTimeout(() => resolve('pending'), 60))]);
  assert.equal(read, 'pending', 'the pages answer when the Keychain does');
});

test('a locked phone (a push opens the app from the lock screen) leaves the saved pages as they are: no pages for the session, nothing deleted, nothing marked', async () => {
  process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE = '1';
  const unlocked = await openChatCache();
  await unlocked.pages!.save('k', { rows, more: true });
  assert.equal(table.size, 1);
  keychain = 'locked';
  for (const fresh of [false, true]) {
    markers.clear();
    if (!fresh) markers.add('mopilot-saved-history.marker');
    const cache = await openChatCache();
    assert.equal(await cache.pages!.load('k'), null, 'no pages while it is locked');
    assert.equal(await cache.pages!.save('k', { rows, more: false }), false);
    assert.equal(table.size, 1, 'nothing of it was deleted');
    assert.deepEqual(deleted, []);
    assert.equal(markers.has('mopilot-saved-history.marker'), !fresh, 'a first launch is not marked until it has been done');
  }
  keychain = 'ok';
  markers.add('mopilot-saved-history.marker');
  const back = await openChatCache();
  assert.notEqual(await back.pages!.load('k'), null, 'unlocked again: the copy is read');
});

test('a build with the flag on again forgets that an earlier build without it dropped the pages, so that a later one drops them again', async () => {
  markers.add('mopilot-saved-history.dropped');
  process.env.EXPO_PUBLIC_MOPILOT_PAGE_CACHE = '1';
  const cache = await openChatCache();
  await cache.pages!.load('k');
  assert.equal(markers.has('mopilot-saved-history.dropped'), false);
});

const mounted: any[] = [];
afterEach(async () => {
  for (const root of mounted.splice(0)) await act(async () => root.unmount());
});
async function draw(el: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  await act(async () => root.render(el));
  await flush();
  return host;
}

test('Settings > Privacy offers to clear the saved history only where the build keeps it, says what is kept, and says when it is done', async () => {
  const plain = await draw(createElement(PrivacyPage, { back: () => undefined }));
  assert.doesNotMatch(plain.textContent!, /Clear saved chat history|encrypted copy/);
  let cleared = 0;
  bindSavedHistory(async () => void cleared++);
  const host = await draw(createElement(PrivacyPage, { back: () => undefined }));
  assert.match(host.textContent!, /encrypted copy of your recent chats/);
  assert.match(host.textContent!, /included in a backup of this phone/);
  assert.match(host.textContent!, /cannot be read without a key that stays in this phone's Keychain and never leaves it/);
  assert.match(
    host.textContent!,
    /ids of the chats and when they\s+were saved are not encrypted|ids of the chats and when they were saved are not encrypted/,
  );
  assert.match(host.textContent!, /Clearing removes the copy on this phone\. Your chats stay on your Mac\./);
  await click('Clear saved chat history');
  assert.equal(cleared, 1);
  assert.match(host.textContent!, /Saved chat history cleared/);
  await click('Saved chat history cleared');
  assert.equal(cleared, 1, 'once done the button is disabled');
});

test('a clear that fails leaves the button as it was', async () => {
  bindSavedHistory(async () => {
    throw new Error('disk full');
  });
  const host = await draw(createElement(PrivacyPage, { back: () => undefined }));
  await click('Clear saved chat history');
  assert.match(host.textContent!, /Clear saved chat history/);
  assert.doesNotMatch(host.textContent!, /cleared/);
});

test("the disk caches bind the clearing to the account in use, drop another account's rows, and unbind on sign-out", async () => {
  const pruned: string[][] = [];
  let cleared = 0;
  const rowCache: any = {
    clear: async () => void cleared++,
    prune: async (keep: (k: string) => boolean) =>
      void pruned.push(['a', 'b'].filter((account) => keep(JSON.stringify([account, 'p', 'c'])))),
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  mounted.push(root);
  const Probe = (props: any) => (useDiskCaches(props), null);
  const show = (props: any) => act(async () => root.render(createElement(Probe, props)));
  const base = { pictureCache: null, chats: null, whole: false, pair: 'p' };
  await show({ ...base, rowCache, account: undefined });
  assert.ok(savedHistoryClear(), 'bound before an account is known: Settings can still clear');
  assert.deepEqual(pruned, [], 'nobody to keep rows for yet');
  await show({ ...base, rowCache, account: 'a' });
  assert.deepEqual(pruned.at(-1), ['a'], "another account's rows go");
  await savedHistoryClear()!();
  assert.equal(cleared, 1);
  await show({ ...base, rowCache: null, account: undefined });
  assert.equal(savedHistoryClear(), null, 'signed out: nothing to clear');
});
