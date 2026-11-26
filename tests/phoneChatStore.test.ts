// The sealed chat rows live in a SQLite table (ciphertext only) with their key in the device-only keychain; the oldest are evicted.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createRequire } from 'node:module';
import { checkSecureKey, checkSecureValue } from './support/phone/secure-store-rules.ts';
const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const table = new Map<string, { value: string; at: number }>();
const statements: string[] = [];
let clock = 0;
let key: string | null = null;
// the marks in the cache folder, by name; the install mark is there unless a test says this is a first launch
const markers = new Set<string>(['mopilot-saved-history.marker']);
mock.module(require.resolve('expo-secure-store'), {
  namedExports: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 3,
    getItemAsync: async (name: string) => (checkSecureKey(name), assert.match(name, /^mobile-remote-chat-(rows|list|pictures)-key$/), key),
    deleteItemAsync: async (name: string) => void checkSecureKey(name),
    setItemAsync: async (name: string, value: string, options: any) => {
      checkSecureKey(name);
      checkSecureValue(value);
      assert.equal(options.keychainAccessible, 3);
      key = value;
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
      execAsync: async (sql: string) => void statements.push(sql),
      getFirstAsync: async (_sql: string, k: string) => (table.has(k) ? { value: table.get(k)!.value } : null),
      getAllAsync: async () => [...table.entries()].sort((a, b) => a[1].at - b[1].at).map(([k]) => ({ key: k })),
      runAsync: async (sql: string, k?: string, value?: string) => {
        if (sql.startsWith('INSERT')) table.set(k!, { value: value!, at: ++clock });
        else if (k !== undefined) table.delete(k);
        else table.clear();
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
const storeModulePath = '../mobile/src/platform/chatStore.ts';
const cachePath = '../mobile/src/presentation/threadCache.ts';
const { openChatCache, openListCache, openPictureCache } = await import(storeModulePath);
const { CACHE_CHATS } = await import(cachePath);

test('rows are saved, read back, removed and cleared through the table, with the key made once in the keychain', async () => {
  const cache = await openChatCache();
  assert.match(statements[0], /chat_rows/);
  assert.deepEqual(await cache.load('a'), []);
  await cache.save('a', [{ key: 'k', role: 'user', text: 'hello' }]);
  assert.equal(key, '09'.repeat(32));
  assert.deepEqual(await (await openChatCache()).load('a'), [{ key: 'k', role: 'user', text: 'hello' }]);
  await cache.remove('a');
  assert.deepEqual(await cache.load('a'), []);
  await cache.save('b', [{ key: 'k', role: 'user', text: 'x' }]);
  await cache.clear();
  assert.equal(table.size, 0);
});

test('the oldest chats are evicted past the bound', async () => {
  const cache = await openChatCache();
  for (let i = 0; i < CACHE_CHATS + 2; i++) await cache.save(`c${i}`, [{ key: 'k', role: 'user', text: String(i) }]);
  assert.equal(table.size, CACHE_CHATS);
  assert.ok(!table.has('c0') && !table.has('c1') && table.has(`c${CACHE_CHATS + 1}`));
});

test('the last chat list is kept in its own table with its own key, read back, pruned and cleared', async () => {
  table.clear();
  key = null;
  const cache = await openListCache();
  assert.match(statements.at(-1)!, /chat_lists/);
  assert.deepEqual(await cache.load('k'), []);
  await cache.save('k', [{ id: '1', title: 'Fix login' }]);
  assert.deepEqual(await (await openListCache()).load('k'), [{ id: '1', title: 'Fix login' }]);
  await cache.prune(() => false);
  assert.equal(table.size, 0);
  await cache.save('k', [{ id: '1' }]);
  await cache.save('j', [{ id: '2' }]);
  await cache.prune((k: string) => k === 'j');
  assert.deepEqual([...table.keys()], ['j']);
  await cache.clear();
  assert.equal(table.size, 0);
});

test('the thumbnails of attached pictures are kept in their own table with their own key, read back, pruned and cleared', async () => {
  table.clear();
  key = null;
  const cache = await openPictureCache();
  assert.match(statements.at(-1)!, /chat_pictures/);
  const uri = 'data:image/jpeg;base64,QUJDRA==';
  assert.equal(await cache.load('k'), null);
  await cache.save('k', uri);
  assert.equal(await (await openPictureCache()).load('k'), uri);
  await cache.save('j', uri);
  await cache.prune((k: string) => k === 'j');
  assert.deepEqual([...table.keys()], ['j']);
  await cache.clear();
  assert.equal(table.size, 0);
});
