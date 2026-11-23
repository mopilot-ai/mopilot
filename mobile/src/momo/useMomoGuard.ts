// MoMo's guard: a failed request may mean the invite was withdrawn, so the Mac is asked again, and if it says so the saved memory is dropped and MoMo is left.
import { useCallback, useRef } from 'react';
import type { MobileRuntime } from '../contracts';
import { type MomoApi, ownerKey } from './api';
import type { MomoCache } from './cache';
import type { Guard } from './useLoad';

export function useMomoGuard(runtime: MobileRuntime, api: MomoApi, cache: Promise<MomoCache | null> | undefined, back: () => void) {
  const backRef = useRef(back);
  backRef.current = back;
  const recheckAllowed = useCallback(() => {
    const key = ownerKey(runtime);
    api.allowed().then(
      async (ok) => {
        if (ok || key !== ownerKey(runtime)) return;
        await (await cache)?.clear().catch(() => undefined);
        backRef.current();
      },
      () => undefined,
    );
  }, [api, runtime, cache]);
  const guard: Guard = useCallback(
    async (work) => {
      try {
        return await work();
      } catch (e) {
        recheckAllowed();
        throw e;
      }
    },
    [recheckAllowed],
  );
  return { guard, recheckAllowed };
}
