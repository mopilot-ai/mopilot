// The MoPilot account as the renderer sees it (no tokens, ever): who's signed in and the credit balance.
import { useEffect, useSyncExternalStore } from 'react';
import { native, type MoPilotStatus } from './native';
import { ignoring } from './ignored';
import { createLatestLoader } from './latestLoader';

let status: MoPilotStatus = { signedIn: false, signingIn: false, user: null, balanceMicros: null, shareUsageData: null, modelCaps: null };
const listeners = new Set<() => void>();
let started = false;

function start() {
  if (started) return;
  started = true;
  const publish = (s: MoPilotStatus) => {
    status = s;
    listeners.forEach((l) => l());
  };
  // This window-owned reader outlives individual subscribers. Events retire an older initial snapshot.
  const loader = createLatestLoader(() => native.mopilot.status(), publish, ignoring('read the MoPilot account status'));
  native.mopilot.onEvent(loader.push);
  void loader.load().catch(ignoring('read the MoPilot account status'));
  // Balances change as credits are spent elsewhere; refresh when the window comes back.
  window.addEventListener('focus', () => {
    // the balance shown stays as last read; the next focus asks again
    if (status.signedIn) native.mopilot.refresh().catch(ignoring('refresh the MoPilot credit balance'));
  });
}

export function useMoPilot() {
  useEffect(start, []);
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => status,
  );
}

export const getMoPilot = () => status;

export { formatCredits } from './credits';
