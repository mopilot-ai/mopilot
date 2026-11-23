// The MoMo memory store keeps a sealed row in SQLite and its key in the device-only keychain.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { createRequire } from 'node:module';
import { checkSecureKey, checkSecureValue } from './support/phone/secure-store-rules.ts';
const require = createRequire(new URL('../mobile/package.json', import.meta.url));
let row: string | null = null;
let key: string | null = null;
const writes: string[] = [];
let keyWrites = 0;
let failKeyWrite = false;
let hangKeyRead = false;
mock.module(require.resolve('expo-secure-store'), {
  namedExports: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 3,
    getItemAsync: (name: string) => (checkSecureKey(name), hangKeyRead ? new Promise<never>(() => undefined) : Promise.resolve(key)),
    setItemAsync: async (name: string, value: string, options: any) => {
      checkSecureKey(name);
      checkSecureValue(value);
      assert.equal(options.keychainAccessible, 3);
      await new Promise((resolve) => setImmediate(resolve));
      if (failKeyWrite) throw new Error('keychain locked');
      keyWrites++;
      key = value;
    },
  },
});
mock.module(require.resolve('expo-sqlite'), {
  namedExports: {
    openDatabaseAsync: async () => ({
      execAsync: async (sql: string) => void writes.push(sql),
      getFirstAsync: async () => ({ value: row }),
      runAsync: async (sql: string, value?: string) => {
        if (sql.startsWith('DELETE')) row = null;
        else row = value ?? null;
      },
    }),
  },
});
const storeModulePath = '../mobile/src/platform/momoStore.ts';
const cryptoModulePath = '../mobile/src/platform/crypto.ts';
mock.module(new URL(cryptoModulePath, import.meta.url).href, {
  namedExports: {
    phonePrimitives: () => ({
      randomBytes: (n: number) => new Uint8Array(n).fill(9),
      aeadSeal: (_k: Uint8Array, _n: Uint8Array, plain: Uint8Array, aad: Uint8Array) => {
        assert.ok(aad instanceof Uint8Array);
        return plain;
      },
      aeadOpen: (_k: Uint8Array, _n: Uint8Array, box: Uint8Array, aad: Uint8Array) => {
        assert.ok(aad instanceof Uint8Array);
        return box;
      },
    }),
  },
});
const { openMomoCache } = await import(storeModulePath);

test('the key is made once, kept in the keychain, and the row survives a reopen', async () => {
  const cache = await openMomoCache();
  assert.match(writes[0], /momo_memory/);
  assert.equal(await cache.load('s'), null);
  await cache.save('s', { facts: [{ id: '1', text: 't' }], docs: null });
  assert.equal(key, '09'.repeat(32));
  const reopened = await openMomoCache();
  assert.deepEqual(await reopened.load('s'), { facts: [{ id: '1', text: 't' }], docs: null });
  await reopened.clear();
  assert.equal(row, null);
  assert.equal(await reopened.load('s'), null);
});

test('a load and a save starting together share one new key, and a failed key is tried again', async () => {
  key = null;
  row = null;
  keyWrites = 0;
  failKeyWrite = true;
  const cache = await openMomoCache();
  await assert.rejects(cache.save('s', { facts: [], docs: null }), /keychain locked/);
  failKeyWrite = false;
  await Promise.all([cache.save('s', { facts: [], docs: null }), cache.load('s')]);
  assert.equal(keyWrites, 1);
  assert.deepEqual(await cache.load('s'), { facts: [], docs: null });
});

test('a keychain that never answers fails the MoMo key after a bounded wait, and the next load asks again (#3644)', async () => {
  const { KEYCHAIN_WAIT_MS } = await import('../mobile/src/bounded.ts');
  key = 'ab'.repeat(32);
  row = null;
  const cache = await openMomoCache();
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    hangKeyRead = true;
    const stuck = assert.rejects(cache.save('s', { facts: [], docs: null }), /secure storage did not answer/);
    for (let i = 0; i < 3; i++) await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(KEYCHAIN_WAIT_MS);
    await stuck;
  } finally {
    mock.timers.reset();
    hangKeyRead = false;
  }
  await cache.save('s', { facts: [], docs: null });
  assert.deepEqual(await cache.load('s'), { facts: [], docs: null });
});
