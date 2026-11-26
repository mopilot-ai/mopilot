// The React side of MoMo's phone store: one hook per part of its state, so a change to one part (an intent in flight, a message held) draws only what shows it.
import { createContext, useContext, useEffect, useSyncExternalStore } from 'react';
import { intentKey, type MomoStore } from '../../momoPhone/store';
import type { Intent } from '../../momoPhone/types';

/** Reads the home once the screen opens. */
export function useLoaded(store: MomoStore): void {
  useEffect(() => {
    if (!store.get().view) void store.load();
  }, [store]);
}

export const useView = (store: MomoStore) => useSyncExternalStore(store.subscribe, () => store.get().view);
export const useFailure = (store: MomoStore) => useSyncExternalStore(store.subscribe, () => store.get().failure);
export const useCached = (store: MomoStore) => useSyncExternalStore(store.subscribe, () => store.get().cached);
export const useLost = (store: MomoStore) => useSyncExternalStore(store.subscribe, () => store.get().lost);
export const useLoading = (store: MomoStore) => useSyncExternalStore(store.subscribe, () => store.get().loading);
export const useBusyCount = (store: MomoStore) => useSyncExternalStore(store.subscribe, () => store.get().busy.size);
export const useTurns = (store: MomoStore) => useSyncExternalStore(store.subscribe, () => store.get().turns);

/** The store the screens below read their in-flight intents from. */
export const MomoStoreContext = createContext<MomoStore | null>(null);

/** Whether this intent is already in flight: the button that sends it is off until the home has answered, so a second tap sends nothing. */
export function useBusy(intent: Intent): boolean {
  const store = useContext(MomoStoreContext) as MomoStore;
  const key = intentKey(intent);
  return useSyncExternalStore(store.subscribe, () => store.get().busy.has(key));
}
