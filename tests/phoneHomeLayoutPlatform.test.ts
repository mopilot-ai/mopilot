// The Chats home layout choice is kept in the keychain under its own key: By project until the person chooses, and a keychain that cannot be read is By project too.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import './support/phone/register.ts';
import { checkSecureKey, checkSecureValue } from './support/phone/secure-store-rules.ts';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
const secure = new Map<string, string>();
let unreadable = false;
mock.module(require.resolve('expo-secure-store'), {
  namedExports: {
    getItemAsync: async (k: string) => {
      checkSecureKey(k);
      if (unreadable) throw new Error('keychain locked');
      return secure.get(k) ?? null;
    },
    setItemAsync: async (k: string, v: string) => (checkSecureKey(k), checkSecureValue(v), void secure.set(k, v)),
  },
});
const layoutPath = '../mobile/src/platform/homeLayout.ts';
const { createProductionHomeLayout } = await import(layoutPath);

test('the saved layout is read from and written to the keychain, By project when none was chosen or it cannot be read', async () => {
  const control = createProductionHomeLayout();
  assert.equal(await control.read(), 'project', 'nothing chosen yet');
  await control.set('state');
  assert.equal(secure.get('homeLayout'), 'state');
  assert.equal(await control.read(), 'state');
  unreadable = true;
  assert.equal(await control.read(), 'project', 'a keychain that cannot be read never hides the projects');
});
