// The phone's side of host.phoneChat (#4603): what the Mac told, the build's default and a developer override decide whether machine chats go through the machine.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock, test } from 'node:test';
import './support/phone/register.ts';

const flagPath = '../mobile/src/remote/hostChatFlag';
const { buildDefaultOf, createHostChatFlag, TOLD, OVERRIDE } = await import(flagPath);

function store(initial: Record<string, string> = {}, failing = false) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    read: async (k: string) => {
      if (failing) throw new Error('keychain');
      return data.get(k) ?? null;
    },
    write: async (k: string, v: string | null) => {
      if (failing) throw new Error('keychain');
      if (v === null) data.delete(k);
      else data.set(k, v);
    },
  };
}

test('off until something turns it on: the Mac told it, the build says so, or the developer override', async () => {
  const off = createHostChatFlag(store(), undefined);
  await off.load();
  assert.equal(off.on(), false);
  off.told(true);
  assert.equal(off.on(), true, 'the Mac told it');
  off.told(false);
  assert.equal(off.on(), false, 'the Mac took it back');
  const built = createHostChatFlag(store(), true);
  await built.load();
  assert.equal(built.on(), true, 'a build made for the device check');
  built.told(false);
  assert.equal(built.on(), true, 'it does not depend on the Mac');
  assert.equal(createHostChatFlag(store(), 'yes').on(), false, 'only true turns it on');
});

test('what the Mac told is kept for the time it is away; an override wins and clears', async () => {
  const s = store();
  const first = createHostChatFlag(s, undefined);
  first.told(true);
  first.told(true);
  await Promise.resolve();
  assert.equal(s.data.get(TOLD), '{"":true}');
  const next = createHostChatFlag(s, undefined);
  assert.equal(next.on(), false, 'not read yet');
  await next.load();
  assert.equal(next.on(), true, 'the Mac is away, and it still knows');
  await next.setOverride(false);
  assert.equal(s.data.get(OVERRIDE), 'off');
  assert.equal(next.on(), false);
  const again = createHostChatFlag(s, undefined);
  await again.load();
  assert.equal(again.on(), false, 'the override is kept');
  await again.setOverride(true);
  assert.equal(s.data.get(OVERRIDE), 'on');
  assert.equal(again.on(), true);
  await again.setOverride(null);
  assert.equal(s.data.has(OVERRIDE), false);
  assert.equal(again.on(), true, 'back to what the Mac told');
  const saved = createHostChatFlag(store({ [TOLD]: '{"m":false}', [OVERRIDE]: 'maybe' }), true);
  await saved.load();
  assert.equal(saved.on(), true, 'an unknown override is none; the build default stands');
  const on = createHostChatFlag(store({ [TOLD]: '{"m":false}', [OVERRIDE]: 'on' }), undefined);
  await on.load();
  assert.equal(on.on(), true, 'a saved override on wins over what the Mac told');
});

test('each Mac is remembered on its own, an older read does not undo a newer answer, and a screen that follows the flag hears it change', async () => {
  const s = store({ [TOLD]: JSON.stringify({ a: true, b: 7, c: false }) });
  const flag = createHostChatFlag(s, undefined);
  let heard = 0;
  const stop = flag.subscribe(() => void heard++);
  // an answer that comes before the saved values are read is the newer one
  flag.told(false, 'a');
  assert.equal(heard, 1);
  await flag.load();
  assert.equal(flag.on(), false, 'the saved "on" of Mac a is older than its answer now');
  assert.equal(heard, 2, 'the late read is heard');
  flag.told(true, 'b');
  assert.equal(flag.on(), true);
  flag.told(false, 'c');
  assert.equal(flag.on(), true, 'another Mac saying no does not take back what Mac b said');
  flag.told(false, 'b');
  assert.equal(flag.on(), false);
  assert.deepEqual(JSON.parse(s.data.get(TOLD)!), { a: false, b: false, c: false });
  await flag.setOverride(true);
  assert.equal(heard, 6, 'the override is heard too');
  stop();
  flag.told(true, 'a');
  assert.equal(heard, 6, 'a stopped listener hears nothing');
  // a saved value that is not a record of answers is none
  for (const saved of ['not json', '"x"', '[1]']) {
    const odd = createHostChatFlag(store({ [TOLD]: saved }), undefined);
    await odd.load();
    assert.equal(odd.on(), false);
  }
});

test('a keychain that fails leaves the build default', async () => {
  const bad = createHostChatFlag(store({}, true), true);
  await bad.load();
  assert.equal(bad.on(), true);
  bad.told(true);
  await Promise.resolve();
  const none = createHostChatFlag(store({}, true), undefined);
  await none.load();
  assert.equal(none.on(), false);
});

// The production binding: the Mac's answer and the override live in the keychain, the default in the build's Expo config.
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
mock.module(require.resolve('expo-constants'), { defaultExport: { expoConfig: { extra: { hostChat: true } } } });

test('the production flag keeps what the Mac told and the override in the keychain, and defaults to the build config', async () => {
  const bindingPath = '../mobile/src/platform/hostChatFlag.ts';
  const { hostChatFlag } = await import(bindingPath);
  secure.set('hostChat', 'off');
  await hostChatFlag.load();
  assert.equal(hostChatFlag.on(), false, 'the keychain is read at launch: a saved override wins');
  secure.delete('hostChat');
  await hostChatFlag.load();
  assert.equal(hostChatFlag.on(), true, 'a build made with it on');
  await hostChatFlag.setOverride(false);
  assert.equal(secure.get(OVERRIDE), 'off');
  assert.equal(hostChatFlag.on(), false);
  await hostChatFlag.setOverride(null);
  assert.equal(secure.has(OVERRIDE), false);
  hostChatFlag.told(true);
  await Promise.resolve();
  assert.equal(secure.get(TOLD), '{"":true}');
});

test('why says where the switch comes from: a saved override, the build, a Mac that said so, or nothing', async () => {
  const off = createHostChatFlag(store(), undefined);
  assert.equal(off.why(), 'off');
  off.told(false, 'm');
  assert.equal(off.why(), 'off');
  off.told(true, 'm');
  assert.equal(off.why(), 'mac');
  assert.equal(createHostChatFlag(store(), true).why(), 'build');
  const saved = createHostChatFlag(store(), true);
  await saved.setOverride(false);
  assert.equal(saved.why(), 'saved');
});

test('the build says chats on machines are on from its Expo config or from the bundle’s own environment, and from nothing else', () => {
  assert.equal(buildDefaultOf({ extra: { hostChat: true } }, undefined), true);
  assert.equal(buildDefaultOf(undefined, '1'), true);
  assert.equal(buildDefaultOf({ extra: {} }, '1'), true);
  for (const config of [undefined, {}, { extra: undefined }, { extra: {} }, { extra: { hostChat: 'yes' } }])
    assert.equal(buildDefaultOf(config, undefined), false);
  assert.equal(buildDefaultOf({ extra: { hostChat: true } }, '0'), true);
  assert.equal(buildDefaultOf({}, '0'), false);
});
