// The haptic feedback choice bound to SecureStore.
import * as SecureStore from 'expo-secure-store';
import { keychain } from '../bounded';
import { createHaptics } from '../haptics';

const KEY = 'haptics';
export const createProductionHaptics = () =>
  createHaptics({
    read: () => keychain(SecureStore.getItemAsync(KEY)),
    write: (value) => keychain(SecureStore.setItemAsync(KEY, value)),
  });
