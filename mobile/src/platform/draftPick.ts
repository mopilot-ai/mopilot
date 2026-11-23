// The draft-open pick (momo/draftPick.ts) bound to the keychain; expo-secure-store loads on first use, so a screen that never needs it never touches it.
import { keychain } from '../bounded';
import { createDraftPick } from '../momo/draftPick';

const KEY = 'momo-draft-open';

export const draftPick = createDraftPick({
  read: async () => keychain((await import('expo-secure-store')).getItemAsync(KEY)),
  write: async (value) => {
    const store = await import('expo-secure-store');
    await keychain(value === null ? store.deleteItemAsync(KEY) : store.setItemAsync(KEY, value));
  },
});
