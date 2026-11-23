// The Usage page's reads and its one write: usage, the Mac's account list and its agents' names read together on open and on Refresh, each answer owned by its read, and auto-switch changed with the old value put back when the Mac refuses.
import { useCallback, useEffect, useRef, useState } from 'react';
import { explain, Unavailable, type Owned } from '../../remote/client';
import { loadAccounts, setAutoSwitch, type AccountList } from '../../remote/accounts';
import { loadHarnessStates } from '../../remote/harnessStates';
import { loadUsage, type UsageAccount } from '../../remote/usage';
import { text } from './settingsAdapters';

export type UsageData = {
  usage: UsageAccount[] | null;
  accounts: AccountList | null;
  labels: ReadonlyMap<string, string>;
  /** the usage read's own failure; the account list and names are extras, whose failure only leaves them out */
  error: string | null;
  /** the Mac has no usage method */
  oldMac: boolean;
  busy: boolean;
  /** an auto-switch change the Mac refused, in words */
  switchError: string | null;
};
const NONE: UsageData = { usage: null, accounts: null, labels: new Map(), error: null, oldMac: false, busy: true, switchError: null };

export function useUsagePage(request: Owned, online: boolean) {
  const [data, setData] = useState<UsageData>(NONE);
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const [nonce, setNonce] = useState(0);
  const seq = useRef(0);
  useEffect(() => {
    if (!online) return;
    let live = true;
    const mine = ++seq.current;
    setData((d) => ({ ...d, busy: true, error: null }));
    void Promise.allSettled([loadUsage(request, nonce > 0), loadAccounts(request), loadHarnessStates(request)]).then(([u, a, h]) => {
      if (!live || seq.current !== mine) return;
      setData((d) => ({
        ...d,
        usage: u.status === 'fulfilled' ? u.value : null,
        error: u.status === 'rejected' ? explain(u.reason) : null,
        oldMac: u.status === 'rejected' && u.reason instanceof Unavailable,
        accounts: a.status === 'fulfilled' ? a.value : null,
        labels: new Map(h.status === 'fulfilled' ? (h.value ?? []).map((r) => [r.id, r.label] as const) : []),
        busy: false,
      }));
      setPending({});
    });
    return () => {
      live = false;
    };
  }, [request, online, nonce]);
  const refresh = useCallback(() => setNonce((n) => n + 1), []);
  const toggle = useCallback(
    (harness: string, on: boolean) => {
      if (pending[harness]) return;
      const set = (value: boolean) =>
        setData((d) =>
          d.accounts
            ? {
                ...d,
                accounts: {
                  ...d.accounts,
                  harnesses: d.accounts.harnesses.map((h) => (h.harness === harness ? { ...h, autoSwitch: value } : h)),
                },
              }
            : d,
        );
      // a switch only moves from the value it shows, so the one to put back is the other
      const was = !on;
      setPending((p) => ({ ...p, [harness]: true }));
      set(on);
      setData((d) => ({ ...d, switchError: null }));
      setAutoSwitch(request, harness, on)
        .then((now) => set(now))
        .catch((error) => {
          set(was);
          setData((d) => ({ ...d, switchError: explain(error) || text('autoSwitch.failed') }));
        })
        .finally(() => setPending((p) => ({ ...p, [harness]: false })));
    },
    [pending, request],
  );
  return { data, refresh, toggle, pending };
}
