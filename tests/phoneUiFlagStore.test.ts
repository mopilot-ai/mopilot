// The production binding of the Phone UI flag in a store build (no `development` in the Expo config, no `__DEV__`): a Classic/New choice an earlier development build saved in the keychain is ignored and cleared, and Settings is given no switch.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock, test } from 'node:test';
import './support/phone/register.ts';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const secure = new Map<string, string>([['phoneUi', 'v2']]);
mock.module(require.resolve('expo-secure-store'), {
  namedExports: {
    getItemAsync: async (k: string) => secure.get(k) ?? null,
    setItemAsync: async (k: string, v: string) => void secure.set(k, v),
    deleteItemAsync: async (k: string) => void secure.delete(k),
  },
});
mock.module(require.resolve('expo-constants'), { defaultExport: { expoConfig: { extra: {} } } });

test('a store build ignores a v2 left in the keychain by a development build, clears it, and has no switch', async () => {
  const bindingPath = '../mobile/src/platform/phoneUi.ts';
  const { phoneUiFlag, phoneUi, phoneUiControl } = await import(bindingPath);
  assert.equal(phoneUiControl, undefined, 'Settings is given no control');
  await phoneUiFlag.load();
  assert.equal(phoneUi(), 'classic', 'the launch draws the classic UI');
  assert.equal(secure.has('phoneUi'), false, 'and the saved v2 is gone');
  await phoneUiFlag.setOverride('v2');
  assert.equal(secure.has('phoneUi'), false, 'nothing can save one');
});
