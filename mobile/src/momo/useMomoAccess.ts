// Whether the connected computer lets this account use MoMo: asked while online, kept for the account when the computer goes away, nothing for an uninvited account.
import { useMemo, useRef } from 'react';
import type { MobileRuntime } from '../contracts';
import { createMomoApi } from './api';
import { useLoad } from './useLoad';

export function useMomoAccess(runtime: MobileRuntime, wired: boolean, online: boolean): boolean {
  const api = useMemo(() => createMomoApi(runtime), [runtime]);
  const access = useLoad(runtime, async () => {
    // not asked where MoMo is not wired or the computer is away
    if (!wired || !online) throw new Error('MoMo is not asked now.');
    return api.allowed();
  }, [api, wired, online]);
  // a read starts over when the computer changes (it drops, then returns), so the answer is kept here for the account it was given to
  const known = useRef<{ user: string | undefined; allowed: boolean } | null>(null);
  const user = runtime.snapshot().user?.id;
  if (access.data !== null) known.current = { user, allowed: access.data === true };
  return wired && user !== undefined && known.current?.user === user && known.current.allowed;
}
