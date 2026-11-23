// A device-only sealing key (Keychain/Keystore, never leaves the phone) and the AEAD calls that use it, shared by the phone's encrypted caches.
import * as SecureStore from 'expo-secure-store';
import { keychain } from '../bounded';
import { phonePrimitives } from './crypto';
import { fromHex, toHex } from '../../../shared/remote/envelope.mjs';

const utf8 = (text: string) => new TextEncoder().encode(text);

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
    randomBytes: prim.randomBytes,
    seal: (key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: string) => prim.aeadSeal(key, nonce, plain, utf8(aad)),
    open: (key: Uint8Array, nonce: Uint8Array, box: Uint8Array, aad: string) => prim.aeadOpen(key, nonce, box, utf8(aad)),
  };
}
