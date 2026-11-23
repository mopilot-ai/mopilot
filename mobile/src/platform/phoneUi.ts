// The phone UI flag bound to the keychain (the developer override) and the build's Expo config (the default); `phoneUi()` is the one value for this launch.
import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import { keychain } from '../bounded';
import { createPhoneUiFlag, type PhoneUi } from '../ui/flag';

const KEY = 'phoneUi';

/** A development build: React Native's `__DEV__`, or the config of a development profile. A store build is neither, and has no switch for the UI. */
const extra = Constants.expoConfig?.extra as { phoneUi?: string; development?: unknown } | undefined;
const development = (globalThis as { __DEV__?: unknown }).__DEV__ === true || extra?.development === true;

export const phoneUiFlag = createPhoneUiFlag(
  {
    read: () => keychain(SecureStore.getItemAsync(KEY)),
    write: (value) => keychain(value === null ? SecureStore.deleteItemAsync(KEY) : SecureStore.setItemAsync(KEY, value)),
  },
  extra?.phoneUi,
  development,
);

/** What Settings draws the switch from: only a development build has one. */
export const phoneUiControl = development ? phoneUiFlag : undefined;

/** The value for this launch: fixed at the first read. */
export const phoneUi = (): PhoneUi => phoneUiFlag.get();
