// The Chats home layout choice bound to SecureStore.
import * as SecureStore from 'expo-secure-store';
import { keychain } from '../bounded';
import { createHomeLayout } from '../homeLayout';

const KEY = 'homeLayout';
export const createProductionHomeLayout = () =>
  createHomeLayout({
    store: { read: () => keychain(SecureStore.getItemAsync(KEY)), write: (value) => keychain(SecureStore.setItemAsync(KEY, value)) },
  });
