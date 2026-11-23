// Whether this account has Mobile Remote and Host: every signed-in account does since they left the closed alpha. The account service is still asked at sign-in and each time the app comes back, but only so the hook keeps one shape; enforcement is on the Mac (its kill switches), and an answer that can't be had blocks nothing.
import { useEffect, useState } from 'react';
import type { MobileRuntime } from './contracts';
import { onForeground } from './platform/lifecycle';

export type PhoneInvite = 'loading' | 'invited' | 'uninvited' | 'unknown';

export function usePhoneInvite(runtime: MobileRuntime, userId: string | undefined) {
  const [invite, setInvite] = useState<PhoneInvite>('loading');
  // whether Add a computer offers Host's tab: for every signed-in account
  const [host, setHost] = useState(false);
  useEffect(() => {
    // Host's tab is every signed-in account's, whatever the service answers (or fails to)
    setHost(!!userId);
    if (!userId) return setInvite('loading');
    let live = true;
    const read = () =>
      void Promise.resolve()
        .then(() => runtime.features())
        .then(
          (features) => {
            if (!live) return;
            if (features) {
              // open to every signed-in account: the list no longer decides (a Mac of before the opening still enforces its invite)
              setInvite('invited');
            } else setInvite((was) => (was === 'loading' ? 'unknown' : was));
          },
          () => {
            if (live) setInvite((was) => (was === 'loading' ? 'unknown' : was));
          },
        );
    read();
    const off = onForeground(read);
    return () => {
      live = false;
      off();
    };
  }, [runtime, userId]);
  return { invite, host };
}
