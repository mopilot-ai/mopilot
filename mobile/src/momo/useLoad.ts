// A read owned by the connected computer: the latest read wins, and one that settles after the account, computer or view changed is dropped.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { MobileRuntime } from '../contracts';
import { messageOf, ownerKey } from './api';

/** Runs a MoMo request; a failure makes the tab ask the computer again whether MoMo is still allowed. */
export type Guard = <T>(work: () => Promise<T>) => Promise<T>;
export type Loaded<T> = { data: T | null; error: string | null; loading: boolean; reload: () => void };

export function useLoad<T>(runtime: MobileRuntime, load: () => Promise<T>, deps: unknown[]): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({
    data: null,
    error: null,
    loading: true,
  });
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  const owner = useRef(ownerKey(runtime));
  const loader = useRef(load);
  loader.current = load;
  useEffect(() => {
    void tick; // a reload reads again
    const read = ++latest.current;
    const key = ownerKey(runtime);
    const current = () => read === latest.current && key === ownerKey(runtime);
    // what was read for another account or computer is not kept while this read runs
    const changed = owner.current !== key;
    owner.current = key;
    setState((old) => ({ data: changed ? null : old.data, error: null, loading: true }));
    loader.current().then(
      (data) => {
        if (current()) setState({ data, error: null, loading: false });
      },
      (e: unknown) => {
        if (current()) setState((old) => ({ ...old, error: messageOf(e), loading: false }));
      },
    );
    return () => {
      ++latest.current;
    };
    // deps is the caller's list of what this read depends on
  }, [runtime, tick, ...deps]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  return { ...state, reload };
}
