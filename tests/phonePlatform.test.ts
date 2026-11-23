// Expo vault adapter holds the exclusive transaction around key and encrypted row access; the native crypto and foreground
// adapters. The private account's sign-in calls are in tests/phoneAccount.private.test.ts.
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
const lifecycleModulePath = '../mobile/src/platform/lifecycle.ts';
const cryptoModulePath = '../mobile/src/platform/crypto.ts';
const vaultModulePath = '../mobile/src/platform/vault.ts';
import { createRequire } from 'node:module';
import { checkSecureKey, checkSecureValue } from './support/phone/secure-store-rules.ts';
const require = createRequire(new URL('../mobile/package.json', import.meta.url));
let value: string | null = null,
  key: string | null = null,
  inside = false;
// where each keychain read happened (inside the exclusive transaction or not), and a read that fails once on request
const keychainReads: boolean[] = [];
let failNextRead = false;
// a keychain that never answers (a fresh iOS 27.0 simulator, #3644): the next read or write waits forever
let hangNext = false;
const never = () => new Promise<never>(() => undefined);
mock.module(require.resolve('expo-secure-store'), {
  namedExports: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 3,
    getItemAsync: async (name: string) => {
      checkSecureKey(name);
      keychainReads.push(inside);
      if (hangNext) {
        hangNext = false;
        return never();
      }
      if (failNextRead) {
        failNextRead = false;
        throw new Error('keychain unavailable');
      }
      return key;
    },
    setItemAsync: async (name: string, next: string, options: any) => {
      checkSecureKey(name);
      checkSecureValue(next);
      assert.equal(inside, true);
      assert.equal(options.keychainAccessible, 3);
      if (hangNext) {
        hangNext = false;
        return never();
      }
      key = next;
    },
  },
});
mock.module(require.resolve('expo-sqlite'), {
  namedExports: {
    openDatabaseAsync: async () => ({
      execAsync: async () => {
        if (inside) throw new Error('database is locked');
      },
      withExclusiveTransactionAsync: async (fn: any) => {
        if (inside) throw new Error('database is locked');
        inside = true;
        try {
          await fn({
            runAsync: async (sql: string, next: string) => {
              if (sql.startsWith('UPDATE')) value = next;
            },
            getFirstAsync: async () => ({ value }),
          });
        } finally {
          inside = false;
        }
      },
    }),
  },
});
const { openVaultStorage } = await import(vaultModulePath);
test('the keychain is read once, before the transaction opens, however many transactions follow', async () => {
  key = 'existing';
  keychainReads.length = 0;
  const storage = await openVaultStorage();
  for (let i = 0; i < 3; i++)
    await storage.transaction(async (row) => {
      assert.equal(await storage.key.get(), 'existing', 'the vault still gets the key inside the lock');
      await row.read();
    });
  assert.deepEqual(keychainReads, [false], 'one read, outside every transaction');
  key = null;
});

test('a missing key is asked for again inside the lock, where it is made, and kept after that', async () => {
  key = null;
  value = null;
  keychainReads.length = 0;
  const storage = await openVaultStorage();
  await storage.transaction(async () => {
    assert.equal(await storage.key.get(), null, 'asked for inside the lock before it is made');
    await storage.key.set('made');
  });
  await storage.transaction(async () => assert.equal(await storage.key.get(), 'made'));
  await storage.transaction(async () => assert.equal(await storage.key.get(), 'made'));
  assert.deepEqual(
    keychainReads,
    [false, true],
    'the read before the first transaction, the one inside the lock that makes the key, and none after',
  );
  key = null;
  value = null;
});

test('a keychain read that fails is not kept: the next transaction asks again', async () => {
  key = 'existing';
  keychainReads.length = 0;
  const storage = await openVaultStorage();
  failNextRead = true;
  await assert.rejects(() => storage.transaction(async () => undefined), /keychain unavailable/);
  await storage.transaction(async () => assert.equal(await storage.key.get(), 'existing'));
  assert.deepEqual(keychainReads, [false, false]);
  key = null;
});

test('a keychain that never answers fails the transaction after a bounded wait, and the next transaction asks again (#3644)', async () => {
  const { KEYCHAIN_WAIT_MS } = await import('../mobile/src/bounded.ts');
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    key = 'existing';
    keychainReads.length = 0;
    const storage = await openVaultStorage();
    hangNext = true;
    const stuck = assert.rejects(() => storage.transaction(async () => undefined), /secure storage did not answer/);
    await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(KEYCHAIN_WAIT_MS - 1);
    let settled = false;
    void stuck.then(() => (settled = true));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false, 'not before the bound');
    mock.timers.tick(1);
    await stuck;
    await storage.transaction(async () => assert.equal(await storage.key.get(), 'existing', 'Retry reads the key again'));
    assert.deepEqual(keychainReads, [false, false]);
    // a write that never answers, inside the lock, fails the same way and releases the lock
    key = null;
    value = null;
    const fresh = await openVaultStorage();
    const making = assert.rejects(
      () =>
        fresh.transaction(async () => {
          hangNext = false;
          assert.equal(await fresh.key.get(), null);
          hangNext = true;
          await fresh.key.set('made');
        }),
      /secure storage did not answer/,
    );
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
    mock.timers.tick(KEYCHAIN_WAIT_MS);
    await making;
    await fresh.transaction(async () => {
      await fresh.key.set('made');
      assert.equal(await fresh.key.get(), 'made');
    });
  } finally {
    mock.timers.reset();
    hangNext = false;
    key = null;
    value = null;
  }
});

test('locks before accessing key and writes encrypted row', async () => {
  const storage = await openVaultStorage();
  await storage.transaction(async (row) => {
    assert.equal(await row.read(), null);
    assert.equal(await storage.key.get(), null);
    await storage.key.set('key');
    await row.write('cipher');
  });
  await storage.transaction(async (row) => {
    assert.equal(await row.read(), 'cipher');
    assert.equal(await storage.key.get(), 'key');
  });
});

mock.module(require.resolve('react-native-libsodium'), { defaultExport: { marker: 'sodium' } });
mock.module('../shared/remote/phonePrimitives.mjs', {
  namedExports: { createPhonePrimitives: (sodium: any, noble: any) => ({ sodium, noble }) },
});
test('native cryptography adapter supplies the shared primitive boundary', async () => {
  const { phonePrimitives } = await import(cryptoModulePath);
  const result: any = phonePrimitives();
  assert.equal(result.sodium.marker, 'sodium');
  assert.equal(typeof result.noble.x25519.getPublicKey, 'function');
  assert.equal(typeof result.noble.sha256, 'function');
  assert.equal(typeof result.noble.hmac, 'function');
});

let appStateListener: ((state: string) => void) | null = null,
  removed = false;
mock.module(require.resolve('react-native'), {
  namedExports: {
    AppState: {
      addEventListener: (_event: string, fn: any) => {
        appStateListener = fn;
        return {
          remove: () => {
            removed = true;
          },
        };
      },
    },
  },
});
test('foreground adapter reacts only to active and removes the listener', async () => {
  const { onForeground } = await import(lifecycleModulePath);
  const { catchingUp, startCatchUp } = await import('../mobile/src/catchUp.ts');
  startCatchUp(0);
  let calls = 0;
  const off = onForeground(() => {
    calls++;
  });
  appStateListener?.('background');
  assert.equal(catchingUp(), false);
  appStateListener?.('active');
  assert.equal(calls, 1);
  assert.equal(catchingUp(), true, 'the catch-up starts when the app is back in front');
  startCatchUp(0);
  off();
  assert.equal(removed, true);
});

test('vault transactions and initialization serialize across handles and recover after failure', async () => {
  const first = await openVaultStorage(),
    second = await openVaultStorage();
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const active = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const order: string[] = [];
  const running = first.transaction(async () => {
    order.push('first');
    entered();
    await gate;
    throw new Error('write failed');
  });
  const rejected = assert.rejects(running, /write failed/);
  await active;
  const following = second.transaction(async () => {
    order.push('second');
    return 'ok';
  });
  const opening = openVaultStorage();
  await Promise.resolve();
  assert.deepEqual(order, ['first']);
  release();
  await rejected;
  assert.equal(await following, 'ok');
  await opening;
  assert.deepEqual(order, ['first', 'second']);
});
