// The language choice is kept in the keychain as System, English or Simplified Chinese, and shown from the phone's own language.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import './support/phone/register.ts';
import { checkSecureKey, checkSecureValue } from './support/phone/secure-store-rules.ts';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const secure = new Map<string, string>();
mock.module(require.resolve('expo-secure-store'), {
  namedExports: {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 5,
    getItemAsync: async (k: string) => (checkSecureKey(k), secure.get(k) ?? null),
    setItemAsync: async (k: string, v: string) => (checkSecureKey(k), checkSecureValue(v), void secure.set(k, v)),
  },
});
const languagePath = '../mobile/src/platform/language.ts';
const i18nPath = '../mobile/src/ui/i18n';
const { createProductionLanguage } = await import(languagePath);
const i18n = await import(i18nPath);

test('the saved language is read from the keychain and shown; System follows the phone', async () => {
  secure.set('language', 'zh-Hans');
  const control = createProductionLanguage();
  assert.equal(await control.read(), 'zh-Hans');
  assert.equal(i18n.t('chats.title'), '聊天');
  await control.set('en');
  assert.equal(secure.get('language'), 'en');
  assert.equal(i18n.t('chats.title'), 'Chats');
  // System: the phone's own language tag decides (this machine's is not Chinese or is: either is one of the two languages)
  await control.set('system');
  assert.equal(secure.get('language'), 'system');
  assert.ok(['en', 'zh-Hans'].includes(i18n.currentLocale()));
});
