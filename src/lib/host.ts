// Whether Host exists for this account, as main's gate says (electron/host/access.cjs: any signed-in account while host.enabled is on): false until main answers, so nothing of Host renders signed out.
import { useEffect, useSyncExternalStore } from 'react';
import { native } from './native';
import { ignoring } from './ignored';
import { createLatestLoader } from './latestLoader';

let allowed = false;
/** main has answered (or its read failed) once: until then `allowed` is false for lack of an answer, not because Host is off */
let answered = false;
const listeners = new Set<() => void>();
let started = false;

function start() {
  if (started) return;
  const publish = (next: boolean) => {
    if (next === allowed && answered) return;
    answered = true;
    allowed = next;
    for (const l of listeners) l();
  };
  // a window whose bridge is not installed yet, or has no Host (a preload from before it), shows nothing and asks again on the next mount
  let host: typeof native.host | undefined;
  try {
    host = native.host;
  } catch {
    return;
  }
  if (!host) return;
  started = true;
  // a change pushed by main supersedes the first read if that read is still in flight
  const loader = createLatestLoader(
    () => host.access(),
    publish,
    // a failed read is an answer of "no Host" too: nothing waits on it for ever
    (e) => (ignoring('read whether Host is available')(e), publish(false)),
  );
  host.onAccess((next) => loader.push(next === true));
  void loader.load();
}

/** Whether Host exists now (false until main has answered); the first call starts following main. */
export function useHostAccess(): boolean {
  useEffect(start, []);
  return useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => allowed,
  );
}

/** Whether Host exists now, for code outside a component: false until main has answered, so a caller without Host access reads false on the same tick. */
export const hostAllowedNow = (): boolean => allowed;

/** Whether main has said yet if Host exists (or this window has no Host bridge to ask). Before that, `useHostAccess` is false for lack of an answer: a caller that must not guess waits on this. */
export function useHostAnswered(): boolean {
  useEffect(start, []);
  const done = useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => answered,
  );
  return done || !hasBridge();
}

const hasBridge = (): boolean => {
  try {
    return !!native.host;
  } catch {
    return false;
  }
};
