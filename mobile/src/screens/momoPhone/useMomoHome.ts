// The hooks that open MoMo's home screens: whether this account may see them on the computer it is connected to (asked again for every computer and whenever the home changes), and the store they read, made for one account and computer and dropped with them.
import { useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { MobileRuntime } from '../../contracts';
import { useLoad } from '../../momo/useLoad';
import { listsVoice, momoHomeAllowed } from '../../momoPhone/gate';
import { createMomoStore, type MomoStore } from '../../momoPhone/store';
import { say } from '../../momoPhone/say';
import { onForeground } from '../../platform/lifecycle';
import { CHANGED_EVENT, createRuntimeTransport, type Channel } from '../../momoPhone/transport';
import { usePhoneHome } from './usePhoneHome';
import type { HomeScope } from '../../momoPhone/homeCache';
import type { Persist } from '../../momoPhone/store';
import { HomeCacheContext, type HomeCacheAccess } from './HomeCacheProvider';

/** What each account and computer last said, so reopening MoMo shows the screen it showed while the question is asked again. */
/** How long the computer has to answer whether MoMo's home is here. */
export const HELLO_WAIT_MS = 15000;

const lastAnswer = new Map<string, { allowed: boolean; voice: boolean }>();

/** Forgets what the computers said (a fresh start for a test; the answers are per account and computer, so nothing leaks between people). */
export const forgetMomoHomeAnswers = () => lastAnswer.clear();

/** Whether the connected computer lets this account see MoMo's home screens; `settled` is false until it has said (or failed to), so nothing is drawn on a guess. */
export function useMomoHomeAccess(
  runtime: MobileRuntime,
  online: boolean,
): {
  allowed: boolean;
  voice: boolean;
  settled: boolean;
  scope: string;
  denied: boolean;
  failed: string | null;
  retry: () => void;
  /** What the Mac itself said of this account just now (not what was remembered): null while it has not said. */
  answered: boolean | null;
  /** The Mac was asked and did not answer, or the phone is away from it. */
  silent: boolean;
  /** The Mac said in so many words that MoMo is not allowed for this account (`capabilities.momo: false`): a revoke. A hello that merely lacks a capability is not one. */
  revoked: boolean;
} {
  const snap = runtime.snapshot();
  // the answer belongs to one account on one computer
  const scope = JSON.stringify([snap.user?.id, snap.selectedPair]);
  const [changed, setChanged] = useState(0);
  // a home that moved or changed may no longer be the one this computer serves
  const lastHome = useRef<unknown>(undefined);
  useEffect(
    () =>
      runtime.onEvent((event) => {
        if (event.ev !== CHANGED_EVENT) return;
        // a push that says the same home is not asked about again; one that says another, or nothing, is
        const home = (event as { view?: { home?: { homeMachineId?: unknown } } }).view?.home?.homeMachineId;
        if (home !== undefined && home === lastHome.current) return;
        lastHome.current = home;
        setChanged((n) => n + 1);
      }),
    [runtime],
  );
  /** The last failure came back from a Mac that answered (an application error with its code): the Mac is there, so it is not silent. */
  const replied = useRef(false);
  const access = useLoad(runtime, async () => {
    replied.current = false;
    if (!online) throw new Error('away');
    // a computer that does not answer says so after a while, with Try again, instead of a skeleton for ever
    let timer: ReturnType<typeof setTimeout> | undefined;
    const silence = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(say('computerDidNotAnswer'))), HELLO_WAIT_MS);
    });
    try {
      // a failure that comes back from the Mac with its own code is the Mac answering (an application error), not silence
      const asked = runtime.request('machine.hello', {}).catch((error: unknown) => {
        replied.current = typeof Object(error).code === 'string';
        throw error;
      });
      const hello = await Promise.race([asked, silence]);
      const caps = (hello as { capabilities?: { momo?: unknown; momoAccount?: unknown } } | null)?.capabilities;
      // a Mac signed in as another account speaks for that account: what it says of MoMo teaches nothing about this one
      const foreign =
        typeof caps?.momoAccount === 'string' && !!runtime.snapshot().user && caps.momoAccount !== runtime.snapshot().user?.id;
      return { allowed: momoHomeAllowed(hello), voice: listsVoice(hello), revoked: caps?.momo === false, foreign };
    } finally {
      clearTimeout(timer);
    }
  }, [online, scope, changed]);
  const known = useRef<{ scope: string; allowed: boolean; voice: boolean } | null>(null);
  if (access.data !== null) {
    known.current = { scope, allowed: access.data.allowed, voice: access.data.voice };
    lastAnswer.set(scope, { allowed: access.data.allowed, voice: access.data.voice });
  }
  // the answer this account got from this computer last time is what shows while it is asked again
  const last = lastAnswer.get(scope);
  const mine = known.current?.scope === scope ? known.current : last ? { scope, ...last } : null;
  // a computer that cannot be asked is not a "no": the classic screens show an away phone, and an online one that does not answer is told
  const unanswered = !mine && online && access.error !== null;
  return {
    allowed: !!snap.user && !!mine?.allowed,
    voice: !!mine?.voice,
    settled: !!mine || (access.error !== null && !online),
    scope,
    // only the computer's own "this is not a MoMo home" lets what was kept for it go
    denied: access.data !== null && !access.data.allowed,
    failed: unanswered ? access.error : null,
    retry: access.reload,
    answered: online && access.error === null && access.data !== null && !access.data.foreign ? access.data.allowed : null,
    silent: !online || (access.error !== null && !replied.current),
    revoked: online && access.error === null && access.data?.revoked === true && !access.data.foreign,
  };
}

/** The phone's copy for one account and computer, opened when first needed. A copy that cannot be opened cannot be read or written: what may be kept there is told as lost, and no message is sent that could not be kept. */
function persistFor(access: HomeCacheAccess, at: HomeScope): Persist {
  return {
    load: async () => {
      const cache = await access.get();
      return cache ? cache.load(at) : { status: 'unreadable' };
    },
    save: async (copy) => {
      const cache = await access.get();
      if (!cache) throw new Error(say('couldNotKeep'));
      await cache.save(at, copy);
      await access.mark().catch(() => undefined);
    },
  };
}

/** What is kept only while this account and computer are still the current ones: a write that comes after a sign-out or a switch must not bring back what was forgotten. */
function scoped(persist: Persist, current: () => string, scope: string): Persist {
  return {
    load: persist.load,
    save: (copy) => (current() === scope ? persist.save(copy) : Promise.reject(new Error(say('openedElsewhere')))),
  };
}

/** Connecting Google runs on this phone with its own browser; the steps reach the home's Host through the computer's `momo.home.google`. Loaded when first used, so MoMo's screens do not load the sign-in. */
export async function googleOnThisPhone(
  intent: 'connect' | 'reconnect' | 'grant-send',
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>,
) {
  const [{ runGoogleOnPhone }, { phonePrimitives }, WebBrowser] = await Promise.all([
    import('../../momo/googleSignIn'),
    import('../../platform/crypto'),
    import('expo-web-browser'),
  ]);
  return runGoogleOnPhone({
    intent,
    call: (_method, params) => request('momo.home.google', params as Record<string, unknown>),
    primitives: phonePrimitives(),
    openAuthSession: async (url, redirectUri) => {
      const done = await WebBrowser.openAuthSessionAsync(url, redirectUri);
      return done.type === 'success' ? { type: 'success', url: done.url } : { type: 'cancel' };
    },
  });
}

/** The store over the computer's channel: one per account and computer, and it is stopped and emptied when either changes or the screen goes. A store whose account or computer is no longer the current one asks the computer nothing. */
export function useMomoHomeStore(runtime: MobileRuntime, scope: string, enabled: boolean, via: Channel | null = null): MomoStore | null {
  const access = useContext(HomeCacheContext);
  const store = useMemo(() => {
    if (!enabled) return null;
    const { user, selectedPair } = runtime.snapshot();
    // the phone's own home keeps its messages where the Mac's do (the same row), so a message typed while no Mac answers goes when one does
    const at = user && (selectedPair || via) ? { user: user.id, pair: selectedPair ?? 'phone-home' } : null;
    const current = via ? () => scope : () => JSON.stringify([runtime.snapshot().user?.id, runtime.snapshot().selectedPair]);
    const request = (method: string, params: Record<string, unknown>) =>
      via
        ? via.request(method, params)
        : current() === scope
          ? runtime.request(method, params)
          : Promise.reject(new Error(say('openedElsewhere')));
    return createMomoStore(
      createRuntimeTransport({
        request,
        onEvent: (listener) => (via ? via.onEvent(listener) : runtime.onEvent((event) => listener(event as { ev?: string }))),
      }),
      // the notes and the messages still to go are kept on this phone for this account and computer
      {
        persist: access && at ? scoped(persistFor(access, at), current, scope) : undefined,
        stamps: access && at ? () => access.stamps(at.user) : undefined,
        google: (intent) => googleOnThisPhone(intent, request),
      },
    );
  }, [runtime, enabled, scope, access, via]);
  useEffect(() => () => store?.dispose(), [store]);
  return store;
}

/** MoMo's home screens for the app: `store` only when they may be shown. */
export function useMomoHome(
  runtime: MobileRuntime,
  online: boolean,
  phoneOpen?: Parameters<typeof usePhoneHome>[2],
  phoneSilentMs?: number,
) {
  const access = useMomoHomeAccess(runtime, online);
  // no Mac answers: the phone's own home, on its own Hosts, takes the Mac's place until one does
  const phone = usePhoneHome(
    runtime,
    { answered: access.answered, revoked: access.revoked, silent: access.silent },
    phoneOpen,
    phoneSilentMs,
  );
  const own = phone.channel !== null;
  const store = useMomoHomeStore(runtime, own ? phone.scope : access.scope, own || access.allowed, phone.channel);
  const copy = useContext(HomeCacheContext);
  // a change the home told while the phone could not hear (the connection was away, the app was behind) is found by reading again when it is back
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) void store?.refresh();
    wasOnline.current = online;
  }, [online, store]);
  useEffect(() => (store ? onForeground(() => void store.refresh()) : undefined), [store]);
  // a computer that said it is not a MoMo home keeps nothing here: what was kept for it (it was one before) is forgotten; one that did not answer keeps its copy
  useEffect(() => {
    const [user, pair] = JSON.parse(access.scope) as [string | undefined, string | undefined];
    if (access.denied && user && pair) void copy?.forgetScope({ user, pair });
  }, [access.denied, access.scope, copy]);
  if (own) return { settled: true, voice: false, store, failed: null, retry: access.retry };
  return { settled: access.settled, voice: access.voice, store: access.allowed ? store : null, failed: access.failed, retry: access.retry };
}
