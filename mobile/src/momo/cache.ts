// Memory cached encrypted at rest: sealed with a device-only key, bound to the account and computer it came from.
import { fromHex, toHex } from '../../../shared/remote/envelope.mjs';
import type { Fact, Docs } from './contract';

export type CacheStore = { read(): Promise<string | null>; write(value: string): Promise<void>; clear(): Promise<void> };
export type CacheCrypto = {
  key(): Promise<Uint8Array>;
  randomBytes(n: number): Uint8Array;
  seal(key: Uint8Array, nonce: Uint8Array, plain: Uint8Array, aad: string): Uint8Array;
  open(key: Uint8Array, nonce: Uint8Array, box: Uint8Array, aad: string): Uint8Array | null;
};
export type MemoryCopy = { facts: Fact[]; docs: Docs | null };

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function createMomoCache({ store, crypto }: { store: CacheStore; crypto: CacheCrypto }) {
  const aad = (scope: string) => `momo-memory:${scope}`;
  return {
    async save(scope: string, copy: MemoryCopy): Promise<void> {
      const key = await crypto.key();
      const nonce = crypto.randomBytes(24);
      const box = crypto.seal(key, nonce, encoder.encode(JSON.stringify(copy)), aad(scope));
      await store.write(JSON.stringify({ nonce: toHex(nonce), box: toHex(box) }));
    },
    /** The copy saved for this account and computer, or null when there is none, it is another's, or it cannot be opened. */
    async load(scope: string): Promise<MemoryCopy | null> {
      const raw = await store.read();
      if (raw === null) return null;
      try {
        const saved = JSON.parse(raw) as { nonce: string; box: string };
        const plain = crypto.open(await crypto.key(), fromHex(saved.nonce), fromHex(saved.box), aad(scope));
        if (!plain) return null;
        const copy = JSON.parse(decoder.decode(plain)) as MemoryCopy;
        return Array.isArray(copy.facts) ? copy : null;
      } catch {
        return null;
      }
    },
    /** Forget the copy: signed out, the computer unpaired, or MoMo no longer allowed. */
    clear: () => store.clear(),
  };
}
export type MomoCache = ReturnType<typeof createMomoCache>;
