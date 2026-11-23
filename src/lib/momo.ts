// Whether MoMo exists for this account, as main's closed-alpha gate says (electron/momo/access.cjs): false until main answers, so nothing of MoMo renders for an account that wasn't invited.
import { useEffect, useSyncExternalStore } from 'react';
import { native } from './native';
import { ignoring } from './ignored';
import { createLatestLoader } from './latestLoader';

export type MomoAccess = { allowed: boolean; known: boolean };

let access: MomoAccess = { allowed: false, known: false };
const listeners = new Set<() => void>();
let started = false;

function start() {
  if (started) return;
  started = true;
  const publish = (next: boolean) => {
    if (access.known && next === access.allowed) return;
    access = { allowed: next, known: true };
    for (const l of listeners) l();
  };
  // a window whose bridge has no MoMo (a preload from before it) never shows it
  const momo = native.momo as typeof native.momo | undefined;
  if (!momo) return;
  // a change pushed by main supersedes the first read if that read is still in flight
  const loader = createLatestLoader(() => momo.access(), publish, ignoring('read whether MoMo is available'));
  momo.onAccess((next) => loader.push(next === true));
  void loader.load();
}

/** Main's answer and whether it has given one yet; the first call starts following it. */
export function useMomoAccess(): MomoAccess {
  useEffect(start, []);
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => access,
  );
}

/** Whether MoMo is allowed right now, for code outside React (false until main has answered). */
export function momoAllowedNow(): boolean {
  start();
  return access.allowed;
}

/** Whether MoMo exists now (false until main has answered). */
export function useMomoAllowed(): boolean {
  return useMomoAccess().allowed;
}
