// The host-chat flag bound to the keychain (what the Mac told, a developer override) and the build's Expo config (the default).
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { keychain } from '../bounded';
import { buildDefaultOf, createHostChatFlag } from '../remote/hostChatFlag';

export const hostChatFlag = createHostChatFlag(
  {
    read: (key) => keychain(SecureStore.getItemAsync(key)),
    write: (key, value) => keychain(value === null ? SecureStore.deleteItemAsync(key) : SecureStore.setItemAsync(key, value)),
  },
  buildDefaultOf(Constants.expoConfig, process.env.EXPO_PUBLIC_MOPILOT_HOST_CHAT),
);
