// What the phone-composed home keeps sealed: its own SQLite row and its own device-only key, apart from the home copy's and MoMo's memory copy; ids that cannot be guessed; and the memory opened on it comes back after a reopen.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock, test } from 'node:test';
import { checkSecureKey, checkSecureValue } from './support/phone/secure-store-rules.ts';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const rows = new Map<string, string>();
let key: string | null = null;
const keyNames: string[] = [];
const writes: string[] = [];
mock.module(require.resolve('expo-secure-store'), {
  namedExports: {
    WHEN_UNLOCKED_THIS_DEVICE_ONLY: 3,
    getItemAsync: async (name: string) => (checkSecureKey(name), keyNames.push(name), key),
    setItemAsync: async (name: string, value: string, options: { keychainAccessible: number }) => {
      checkSecureKey(name);
      checkSecureValue(value);
      assert.equal(options.keychainAccessible, 3);
      key = value;
    },
  },
});
mock.module(require.resolve('expo-sqlite'), {
  namedExports: {
    openDatabaseAsync: async (name: string) => ({
      execAsync: async (sql: string) => void writes.push(`${name}: ${sql}`),
      getFirstAsync: async (_sql: string, user: string) => (rows.has(user) ? { value: rows.get(user) } : null),
      runAsync: async (sql: string, ...args: string[]) => {
        if (sql.startsWith('DELETE')) return void (args.length ? rows.delete(args[0]) : rows.clear());
        rows.set(args[0], args[1]);
      },
    }),
  },
});
let draws = 0;
mock.module(require.resolve('expo-crypto'), { namedExports: { getRandomBytes: (n: number) => new Uint8Array(n).fill(++draws) } });
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
const storePath = '../mobile/src/platform/momoPhoneHome.ts';
const memoryPath = '../mobile/src/momoPhone/phoneHome/memory';
const { openPhoneHomeSealed, forgetPhoneHome } = await import(storePath);
const leavePath = '../mobile/src/accountLeave';
const { leaveAccount, phoneHomeRows } = await import(leavePath);
const { openPhoneHomeMemory } = await import(memoryPath);

test('the memory is sealed in its own database with its own key, and comes back after a reopen', async () => {
  const first = await openPhoneHomeSealed('u1');
  assert.match(writes[0], /mobile-remote-momo-phone-home\.db: CREATE TABLE IF NOT EXISTS momo_phone_home/);
  const a = await openPhoneHomeMemory({ ...first, user: 'u1' });
  a.seen.write(7);
  a.invited.set(true);
  await a.settled();
  assert.ok(keyNames.every((n) => n === 'mobile-remote-momo-phone-home-key'));
  assert.equal(key, '09'.repeat(32));
  const b = await openPhoneHomeMemory({ ...(await openPhoneHomeSealed('u1')), user: 'u1' });
  assert.deepEqual([b.seen.read(), b.invited.read()], [7, true]);
  await b.forget();
  assert.equal(rows.size, 0);
});

test('the ids it makes are the device’s random ones, one different from the next', async () => {
  const { newId } = await openPhoneHomeSealed('u1');
  const [x, y] = [newId(), newId()];
  assert.notEqual(x, y);
  assert.match(x, /^[0-9a-f-]{16,}$/i);
});

const memoryOf = async (user: string) => openPhoneHomeMemory({ ...(await openPhoneHomeSealed(user)), user });

test('each account has its own row: A, then B, then A again finds A’s held messages, and B never wrote over them', async () => {
  const a = await memoryOf('A');
  a.outbox.write([{ turnId: 'turn-0001-a', chatId: '', text: 'for A', createdAt: 1, delivery: 'not-sent' }]);
  await a.settled();
  const b = await memoryOf('B');
  assert.deepEqual(b.outbox.read(), [], 'B starts with nothing of A’s');
  b.outbox.write([{ turnId: 'turn-0001-b', chatId: '', text: 'for B', createdAt: 2, delivery: 'not-sent' }]);
  await b.settled();
  assert.deepEqual(
    (await memoryOf('A')).outbox.read().map((e: any) => e.text),
    ['for A'],
  );
  assert.deepEqual(
    (await memoryOf('B')).outbox.read().map((e: any) => e.text),
    ['for B'],
  );
});

test('leaving the account takes every row away, and the account that signs in next starts with nothing', async () => {
  const a = await memoryOf('A');
  a.seen.write(5);
  await a.settled();
  const steps: string[] = [];
  await leaveAccount({
    runtime: { signOut: async () => void steps.push('signOut') },
    phoneHome: { clear: async () => (steps.push('phoneHome'), forgetPhoneHome()) },
  });
  assert.deepEqual(steps, ['signOut', 'phoneHome']);
  assert.equal(rows.size, 0);
  assert.deepEqual([(await memoryOf('A')).seen.read(), (await memoryOf('B')).seen.read()], [0, 0]);
  // a leave on a phone that never composed its own home has nothing to clear
  await leaveAccount({ runtime: { signOut: async () => undefined } });
});

test('the rows leaving the account clears are the device’s own: every account’s', async () => {
  const a = await memoryOf('A');
  a.seen.write(2);
  await a.settled();
  const b = await memoryOf('B');
  b.seen.write(3);
  await b.settled();
  assert.equal(rows.size, 2);
  await phoneHomeRows.clear();
  assert.equal(rows.size, 0);
});

test('a write still in flight when the account is left does not bring its row back', async () => {
  const a = await memoryOf('A');
  a.seen.write(4);
  // sign-out lands while the write is on its way
  await forgetPhoneHome();
  await a.settled();
  assert.equal(rows.size, 0);
  // a container opened after sign-out writes again
  const b = await memoryOf('B');
  b.seen.write(1);
  await b.settled();
  assert.equal(rows.size, 1);
});
