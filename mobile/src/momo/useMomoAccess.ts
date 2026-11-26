// Whether the connected computer lets this account use MoMo: asked while online, kept for the account when the computer goes away, nothing for an uninvited account.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { MobileRuntime } from '../contracts';
import { createMomoApi } from './api';
import { useLoad } from './useLoad';

export function useMomoAccess(runtime: MobileRuntime, wired: boolean, online: boolean): boolean {
  const api = useMemo(() => createMomoApi(runtime), [runtime]);
  // the computer says its hello changed (MoMo allowed or taken away, its home offered): the answer is read again at once, not at the next connect
  const [changed, setChanged] = useState(0);
  useEffect(
    () =>
      runtime.onEvent?.((event) => {
        const { ev, area } = event as { ev?: string; area?: string };
        // MoMo's settings changed, or its home did: not every chat or channel change
        if (ev === 'momo.home.changed' || (ev === 'momo.changed' && area === 'prefs')) setChanged((n) => n + 1);
      }),
    [runtime],
  );
  const access = useLoad(runtime, async () => {
    // not asked where MoMo is not wired or the computer is away
    if (!wired || !online) throw new Error('MoMo is not asked now.');
    return api.allowed();
  }, [api, wired, online, changed]);
  // a read starts over when the computer changes (it drops, then returns), so the answer is kept here for the account it was given to
  const known = useRef<{ user: string | undefined; allowed: boolean } | null>(null);
  const user = runtime.snapshot().user?.id;
  if (access.data !== null) known.current = { user, allowed: access.data === true };
  return wired && user !== undefined && known.current?.user === user && known.current.allowed;
}
