// A device-only sealing key (Keychain/Keystore, never leaves the phone) and the AEAD calls that use it, shared by the phone's encrypted caches.
import * as SecureStore from 'expo-secure-store';
import { keychain } from '../bounded';
import { phonePrimitives } from './crypto';
import { fromHex, toHex } from '../../../shared/remote/envelope.mjs';

const utf8 = (text: string) => new TextEncoder().encode(text);

/** Whether the Keychain holds this key (it does not make one). */
export const hasSealedKey = async (keyName: string) => !!(await keychain(SecureStore.getItemAsync(keyName)));
/** Deletes the key from the Keychain: what was sealed under it can no longer be read by anyone. */
export const forgetSealedKey = (keyName: string) => keychain(SecureStore.deleteItemAsync(keyName));

export function sealedCrypto(keyName: string) {
  const prim = phonePrimitives();
  let keyed: Promise<Uint8Array> | null = null;
  return {
    // one key per run: a load and a save starting together must not each make their own
    key: () => {
      keyed ??= (async () => {
        const saved = await keychain(SecureStore.getItemAsync(keyName));
        if (saved) return fromHex(saved);
        const fresh = prim.randomBytes(32);
        await keychain(
          SecureStore.setItemAsync(keyName, toHex(fresh), {
            keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
          }),
        );
        return fresh;
      })().catch((error) => {
        keyed = null;
        throw error;
      });
      return keyed;
    },
    // the key is deleted and the next one made when it is needed: a copy sealed under the old one is gone with it
    forget: async () => {
      keyed = null;
      await forgetSealedKey(keyName);
    },
    randomBytes: prim.randomBytes,
    seal: (key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: string) => prim.aeadSeal(key, nonce, plain, utf8(aad)),
    open: (key: Uint8Array, nonce: Uint8Array, box: Uint8Array, aad: string) => prim.aeadOpen(key, nonce, box, utf8(aad)),
  };
}
