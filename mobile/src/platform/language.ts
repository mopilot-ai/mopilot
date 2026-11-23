// The language choice bound to SecureStore and the phone's preferred languages.
import * as SecureStore from 'expo-secure-store';
import { keychain } from '../bounded';
import { createLanguage } from '../ui/i18n';

const KEY = 'language';
/** The phone's preferred languages, best first, as BCP 47 tags. */
const deviceTags = () => [Intl.DateTimeFormat().resolvedOptions().locale];
export const createProductionLanguage = () =>
  createLanguage({
    store: { read: () => keychain(SecureStore.getItemAsync(KEY)), write: (value) => keychain(SecureStore.setItemAsync(KEY, value)) },
    deviceTags,
  });
