// MoMo's home copy keeps a sealed row in SQLite and its own key in the device-only keychain, apart from MoMo's memory copy.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock, test } from 'node:test';
import { checkSecureKey, checkSecureValue } from './support/phone/secure-store-rules.ts';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
let row: string | null = null;
let key: string | null = null;
const marks = new Map<string, string>();
const keyNames: string[] = [];
const writes: string[] = [];
mock.module(require.resolve('expo-secure-store'), {
  namedExports: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 3,
    getItemAsync: async (name: string) => (
      checkSecureKey(name), keyNames.push(name), name.endsWith('-used') ? (marks.get(name) ?? null) : key
    ),
    setItemAsync: async (name: string, value: string, options: { keychainAccessible: number }) => {
      checkSecureKey(name);
      checkSecureValue(value);
      assert.equal(options.keychainAccessible, 3);
      if (name.endsWith('-used')) marks.set(name, value);
      else key = value;
    },
  },
});
mock.module(require.resolve('expo-sqlite'), {
  namedExports: {
    openDatabaseAsync: async (name: string) => ({
      execAsync: async (sql: string) => void writes.push(`${name}: ${sql}`),
      getFirstAsync: async () => ({ value: row }),
      runAsync: async (sql: string, value?: string) => {
        row = sql.startsWith('DELETE') ? null : (value ?? null);
      },
    }),
  },
});
mock.module(new URL('../mobile/src/platform/crypto.ts', import.meta.url).href, {
  namedExports: {
    phonePrimitives: () => ({
      randomBytes: (n: number) => new Uint8Array(n).fill(9),
      aeadSeal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array) => plain,
      aeadOpen: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array) => box,
    }),
  },
});
// the phone sources load by variable path so the node typecheck does not pull the phone's React types in
const storeModulePath = '../mobile/src/platform/momoHomeStore.ts';
const { openMomoHomeCache, momoHomeWasUsed, markMomoHomeUsed } = await import(storeModulePath);

test('the copy is sealed in its own database with its own key, comes back after a reopen, and is cleared', async () => {
  const cache = await openMomoHomeCache();
  assert.match(writes[0], /mobile-remote-momo-home\.db: CREATE TABLE IF NOT EXISTS momo_home/);
  const at = { user: 'u', pair: 'p' };
  assert.deepEqual(await cache.load(at), { status: 'none' });
  await cache.save(at, { notes: [], turns: [{ id: 't1', text: 'hi', at: 1, delivery: 'queued' }] });
  assert.ok(keyNames.every((n) => n === 'mobile-remote-momo-home-key'));
  assert.equal(key, '09'.repeat(32));
  const reopened = await openMomoHomeCache();
  assert.deepEqual(await reopened.scopes(), [at]);
  const back = await reopened.load(at);
  assert.equal(back.status === 'ok' && back.copy.turns[0].id, 't1');
  await reopened.clear();
  assert.equal(row, null);
  assert.deepEqual(await reopened.load(at), { status: 'none' });
});

test('a phone where MoMo’s home was never used opens no database and says so with one keychain read', async () => {
  writes.length = 0;
  assert.equal(await momoHomeWasUsed(), false);
  assert.deepEqual(writes, []);
  await markMomoHomeUsed();
  assert.equal(await momoHomeWasUsed(), true);
  assert.equal(marks.get('mobile-remote-momo-home-used'), '1');
});
