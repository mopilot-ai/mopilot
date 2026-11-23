// The build's setting for chats on machines read from the bundle's own environment, for a build whose Expo config did not carry it (#4619).
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mock, test } from 'node:test';
import './support/phone/register.ts';

const require = createRequire(new URL('../mobile/package.json', import.meta.url));
mock.module(require.resolve('expo-secure-store'), {
  namedExports: { getItemAsync: async () => null, setItemAsync: async () => undefined, deleteItemAsync: async () => undefined },
});
const constants: { expoConfig?: { extra?: object } } = { expoConfig: { extra: {} } };
mock.module(require.resolve('expo-constants'), { defaultExport: constants });

test('a build made with EXPO_PUBLIC_MOPILOT_HOST_CHAT=1 has chats on machines on, whatever its Expo config says', async () => {
  const bindingPath = '../mobile/src/platform/hostChatFlag.ts';
  process.env.EXPO_PUBLIC_MOPILOT_HOST_CHAT = '1';
  try {
    const { hostChatFlag } = await import(`${bindingPath}?with`);
    assert.equal(hostChatFlag.on(), true);
    assert.equal(hostChatFlag.why(), 'build');
  } finally {
    delete process.env.EXPO_PUBLIC_MOPILOT_HOST_CHAT;
  }
  const { hostChatFlag: plain } = await import(`${bindingPath}?without`);
  assert.equal(plain.on(), false, 'and a build without either is off until a Mac says so');
  // a build whose manifest has no config at all
  constants.expoConfig = undefined;
  const { hostChatFlag: bare } = await import(`${bindingPath}?bare`);
  assert.equal(bare.on(), false);
  constants.expoConfig = { extra: undefined };
  const { hostChatFlag: noExtra } = await import(`${bindingPath}?noextra`);
  assert.equal(noExtra.on(), false);
});
