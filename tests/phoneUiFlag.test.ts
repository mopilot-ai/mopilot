// The phone UI flag: one value per launch, a valid saved override beats the build default, anything unreadable falls back.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const flagPath = '../mobile/src/ui/flag';
const { createPhoneUiFlag, resolvePhoneUi } = await import(flagPath);

const memoryStore = (initial: string | null = null) => {
  let value = initial;
  return { read: async () => value, write: async (next: string | null) => void (value = next), peek: () => value };
};

test('a valid override wins over the build default, in both directions', () => {
  assert.equal(resolvePhoneUi('v2', 'classic'), 'v2');
  assert.equal(resolvePhoneUi('classic', 'v2'), 'classic');
});

test('a missing or unknown override falls back to the build default; an unknown default is classic', () => {
  assert.equal(resolvePhoneUi(null, 'v2'), 'v2');
  assert.equal(resolvePhoneUi(undefined, 'v2'), 'v2');
  assert.equal(resolvePhoneUi('v3', 'v2'), 'v2');
  assert.equal(resolvePhoneUi(null, undefined), 'classic');
  assert.equal(resolvePhoneUi(null, 'beta'), 'classic');
});

test('load reads the saved override once and get returns it', async () => {
  const flag = createPhoneUiFlag(memoryStore('v2'), 'classic');
  await flag.load();
  assert.equal(flag.get(), 'v2');
});

test('the value never changes after the first get, even if the override is saved or load finishes later', async () => {
  const store = memoryStore(null);
  const flag = createPhoneUiFlag(store, 'classic');
  assert.equal(flag.get(), 'classic');
  await flag.setOverride('v2');
  assert.equal(store.peek(), 'v2');
  await flag.load();
  assert.equal(flag.get(), 'classic');
  assert.equal(await flag.override(), 'v2');
});

test('a saved override applies on the next launch', async () => {
  const store = memoryStore(null);
  const first = createPhoneUiFlag(store, 'classic');
  await first.setOverride('v2');
  const second = createPhoneUiFlag(store, 'classic');
  await second.load();
  assert.equal(second.get(), 'v2');
  await second.setOverride(null);
  assert.equal(await second.override(), null);
});

test('a store that cannot be read leaves the build default, and the saved value reads as none', async () => {
  const broken = { read: async () => Promise.reject(new Error('keychain locked')), write: async () => undefined };
  const flag = createPhoneUiFlag(broken, 'v2');
  await flag.load();
  assert.equal(flag.get(), 'v2');
  assert.equal(await flag.override(), null);
});

test('a store build ignores a saved override and clears it, has no way to set one, and lives on the build default', async () => {
  const kept = memoryStore('v2');
  const flag = createPhoneUiFlag(kept, 'classic', false);
  await flag.load();
  assert.equal(flag.get(), 'classic', 'a v2 a development build saved earlier does not take effect');
  assert.equal(kept.peek(), null, 'and is cleared, so it cannot come back');
  assert.equal(await flag.override(), null);
  await flag.setOverride('v2');
  assert.equal(kept.peek(), null, 'nothing can set one');
  // a keychain that refuses the clear leaves the default all the same
  const refusing = createPhoneUiFlag({ read: async () => 'v2', write: async () => Promise.reject(new Error('locked')) }, 'classic', false);
  await refusing.load();
  assert.equal(refusing.get(), 'classic');
});

test('a development flag keeps what it saved (the default of the factory is a development build)', async () => {
  const kept = memoryStore();
  const flag = createPhoneUiFlag(kept, 'classic');
  await flag.setOverride('v2');
  assert.equal(kept.peek(), 'v2');
  assert.equal(await flag.override(), 'v2');
});

test('a saved value that is not a flag value reads as no override', async () => {
  const flag = createPhoneUiFlag(memoryStore('nonsense'), 'classic');
  assert.equal(await flag.override(), null);
});

// The production binding: the override lives in the keychain, the default in the build's Expo config.
import { createRequire } from 'node:module';
import { mock } from 'node:test';
import './support/phone/register.ts';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const secure = new Map<string, string>();
mock.module(require.resolve('expo-secure-store'), {
  namedExports: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 5,
    getItemAsync: async (k: string) => secure.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => void secure.set(k, v),
    deleteItemAsync: async (k: string) => void secure.delete(k),
  },
});
mock.module(require.resolve('expo-constants'), { defaultExport: { expoConfig: { extra: { phoneUi: 'v2', development: true } } } });

test('the development flag keeps the override in the keychain, defaults to the build config, and fixes its value at the first read', async () => {
  const bindingPath = '../mobile/src/platform/phoneUi.ts';
  const { phoneUiFlag, phoneUi, phoneUiControl } = await import(bindingPath);
  assert.equal(phoneUiControl, phoneUiFlag, 'a development build has the switch');
  assert.equal(phoneUi(), 'v2');
  await phoneUiFlag.setOverride('classic');
  assert.equal(secure.get('phoneUi'), 'classic');
  assert.equal(await phoneUiFlag.override(), 'classic');
  assert.equal(phoneUi(), 'v2');
  await phoneUiFlag.setOverride(null);
  assert.equal(secure.has('phoneUi'), false);
});
