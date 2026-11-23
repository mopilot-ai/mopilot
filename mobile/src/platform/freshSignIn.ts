// Whether the next sign-in must not reuse the browser's account session: set when the phone signs out, so the sign-in sheet asks which account instead of carrying on as the one that just left (#5314); a sign-in clears it. Best effort: a keychain that fails is a plain sign-in.
import * as SecureStore from 'expo-secure-store';
import { keychain } from '../bounded';

const KEY = 'signedOutHere';

/** This phone signed out since it last signed in. */
export async function wasSignedOut(): Promise<boolean> {
  try {
    return (await keychain(SecureStore.getItemAsync(KEY))) === '1';
  } catch {
    return false;
  }
}

/** Remember (or forget) that this phone signed out. */
export async function setSignedOut(on: boolean): Promise<void> {
  try {
    await keychain(on ? SecureStore.setItemAsync(KEY, '1') : SecureStore.deleteItemAsync(KEY));
  } catch {
    // the next sign-in then shares the browser's session, as before
  }
}
