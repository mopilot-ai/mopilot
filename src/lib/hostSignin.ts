// Signing in to an agent on a remote machine, as main reports it (electron/host/machineSignin.cjs): the latest view of each sign-in, one subscription shared by every window part that shows them, followed only while Host exists for the account.
import { useEffect, useSyncExternalStore } from 'react';
import { native } from './native';
import type { HostSigninView } from './native/host';
import { useHostAccess } from './host';
import { RUNNING_STATES, wantsCode as wantsCodeWords } from '../../shared/host/signinWords.mjs';
import { ignoring } from './ignored';

export type { HostSigninView };

const STATES = new Set<string>(['starting', 'waiting', 'signed-in', 'failed', 'cancelled', 'expired', 'unreachable']);
/** A sign-in that is still going: the button turns into Cancel and the code (if any) shows. */
export const RUNNING = new Set<HostSigninView['state']>(RUNNING_STATES as HostSigninView['state'][]);

const NONE: ReadonlyMap<string, HostSigninView> = new Map();

let views = NONE;
let refs = 0;
let stop: (() => void) | null = null;
let generation = 0;
let initialReadSettled = false;
const listeners = new Set<() => void>();
const subscribe = (cb: () => void) => (listeners.add(cb), () => void listeners.delete(cb));

/** The key of one sign-in: a machine and the agent on it. */
export const signinKey = (hostId: string, harness: string) => `${hostId}\n${harness}`;

const publish = (next: ReadonlyMap<string, HostSigninView>) => {
  views = next;
  for (const l of listeners) l();
};

/** What main sent as a sign-in view, or null when it is not one (nothing half-read is drawn). */
export function parseSigninView(v: unknown): HostSigninView | null {
  const o = v as Partial<HostSigninView> | null;
  if (!o || typeof o.hostId !== 'string' || !o.hostId || typeof o.harness !== 'string' || !o.harness) return null;
  if (typeof o.state !== 'string' || !STATES.has(o.state)) return null;
  const codes = Array.isArray(o.codes) ? o.codes.filter((c): c is string => typeof c === 'string') : [];
  return {
    hostId: o.hostId,
    harness: o.harness,
    state: o.state,
    codes,
    link: o.link === true,
    url: typeof o.url === 'string' && /^https:\/\//.test(o.url) ? o.url : null,
    error: typeof o.error === 'string' ? o.error : null,
    reason: o.reason === 'no_page' || o.reason === 'host_update' ? o.reason : null,
    ...(typeof o.attemptId === 'string' ? { attemptId: o.attemptId } : {}),
    ...(Array.isArray(o.recoveryKeys) ? { recoveryKeys: o.recoveryKeys.filter((key): key is string => typeof key === 'string') } : {}),
  };
}

const remember = (view: HostSigninView | null) => {
  if (view) publish(new Map(views).set(signinKey(view.hostId, view.harness), view));
};

function acquire() {
  if (refs++ === 0) {
    const mine = ++generation;
    const received = new Set<string>();
    stop = native.host.onSignin((next) => {
      const view = parseSigninView(next);
      if (view) received.add(signinKey(view.hostId, view.harness));
      remember(view);
    });
    void native.host
      .signinViews()
      .then((snapshot) => {
        if (generation !== mine || !Array.isArray(snapshot)) return;
        for (const raw of snapshot) {
          const view = parseSigninView(raw);
          if (view && !received.has(signinKey(view.hostId, view.harness))) remember(view);
        }
      })
      .catch(ignoring('read remote sign-ins'))
      .finally(() => {
        if (generation !== mine) return;
        initialReadSettled = true;
        publish(views);
      });
  }
  return () => {
    if (--refs === 0) {
      generation++;
      stop?.();
      stop = null;
      initialReadSettled = false;
      publish(NONE);
    }
  };
}

/** Start signing in to `harness` on the machine (a second start joins the one under way); rejects with the reason when main refuses. */
export async function startSignin(hostId: string, harness: string, recoveryKey?: string): Promise<void> {
  const key = signinKey(hostId, harness);
  const before = views.get(key);
  const mine = generation;
  const answer = await (recoveryKey === undefined ? native.host.signin(hostId, harness) : native.host.signin(hostId, harness, recoveryKey));
  // A live update (including cancellation) or a replacement subscription owns the newer state.
  if (generation === mine && views.get(key) === before) remember(parseSigninView(answer));
}

/** Send the code the sign-in's page asked for; false when the sign-in is no longer under way. */
export function sendSigninCode(hostId: string, harness: string, text: string): Promise<boolean> {
  return native.host.signinInput(hostId, harness, text);
}

/** Whether the sign-in waits on a code typed back: a page was opened and the machine relayed no code of its own. */
export const wantsCode = (view: HostSigninView | undefined): boolean => wantsCodeWords(view);

/** Stop the sign-in; the Host's answer arrives through the same subscription. */
export async function cancelSignin(hostId: string, harness: string): Promise<void> {
  await native.host.cancelSignin(hostId, harness);
}

/** How each sign-in stands, by `signinKey`; empty while Host is not available. The first call to need them starts following main. */
export function useHostSignins(): ReadonlyMap<string, HostSigninView> {
  const allowed = useHostAccess();
  useEffect(() => (allowed ? acquire() : undefined), [allowed]);
  const current = useSyncExternalStore(subscribe, () => views);
  return allowed ? current : NONE;
}

/** Alongside useHostSignins, distinguish the initial read in flight from a machine with no attempt. */
export const useHostSigninReadSettled = () => useSyncExternalStore(subscribe, () => initialReadSettled);
