// The appearance choice bound to SecureStore and React Native's colour scheme.
import { Appearance } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { keychain } from '../bounded';
import { createAppearance } from '../appearance';

const KEY = 'appearance';
export const createProductionAppearance = () =>
  createAppearance({
    store: { read: () => keychain(SecureStore.getItemAsync(KEY)), write: (value) => keychain(SecureStore.setItemAsync(KEY, value)) },
    apply: (scheme) => Appearance.setColorScheme(scheme ?? 'auto'),
  });
