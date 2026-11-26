// The home the phone composes itself, for a phone whose Mac does not answer: once an account was allowed by a Mac (kept sealed), and the phone holds a Host of its own, the shared home runs on the phone's own Host sessions and the screens read it through the same channel the Mac gives. The moment a Mac answers, this is let go and the Mac's home is read again.
import { useEffect, useMemo, useState } from 'react';
import type { MobileRuntime } from '../../contracts';
import type { CacheCrypto, CacheStore } from '../../momo/cache';
import { CHANGED_EVENT, type Channel } from '../../momoPhone/transport';
import { createPhoneHome } from '../../momoPhone/phoneHome/compose';
import { openPhoneHomeMemory } from '../../momoPhone/phoneHome/memory';
import { phoneHomeNow } from '../../momoPhone/phoneHome/source';

type Sealed = { store: CacheStore; crypto: CacheCrypto; newId: () => string };
/** How long the Mac must be silent, without a break, before the phone reads its own home: a connection that flaps does not make a home appear and go. */
export const SILENT_MS = 25_000;

/** True once `on` has held without a break for `ms`, and false the moment it stops. */
function useHeld(on: boolean, ms: number) {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!on) {
      setHeld(false);
      return;
    }
    const timer = setTimeout(() => setHeld(true), ms);
    return () => clearTimeout(timer);
  }, [on, ms]);
  return held;
}

/** The sealed container for the phone's own home, opened when first needed. */
const openSealed = async (user: string): Promise<Sealed> => (await import('../../platform/momoPhoneHome')).openPhoneHomeSealed(user);

/**
 * @param mac.answered what the Mac said of this account (true or false), or null while it has not said
 * @param mac.silent the Mac was asked and gave no answer, or the phone is away from it
 * @param open how the sealed container is opened (the device's by default)
 * @param silentMs how long the Mac must be silent before the phone's own home is read
 * @returns the channel to read when the phone's own home is the one, else null; `scope` names it for the store
 */
export function usePhoneHome(
  runtime: MobileRuntime,
  mac: { answered: boolean | null; revoked: boolean; silent: boolean },
  open: (user: string) => Promise<Sealed> = openSealed,
  silentMs: number = SILENT_MS,
): { channel: Channel | null; scope: string } {
  const user = runtime.snapshot().user?.id ?? null;
  const direct = runtime.direct ?? null;
  const [kept, setKept] = useState<{ memory: Awaited<ReturnType<typeof openPhoneHomeMemory>>; newId: () => string } | null>(null);
  const memory = kept?.memory ?? null;
  const [, setTick] = useState(0);
  // the Hosts the phone holds an enrollment with come and go
  useEffect(() => direct?.subscribe(() => setTick((n) => n + 1)), [direct]);
  useEffect(() => {
    if (!user) return;
    let live = true;
    open(user)
      .then(async (sealed) => ({
        memory: await openPhoneHomeMemory({ store: sealed.store, crypto: sealed.crypto, user }),
        newId: sealed.newId,
      }))
      .then((opened) => live && setKept(opened))
      .catch(() => undefined);
    return () => {
      live = false;
      setKept(null);
    };
  }, [user, open]);
  // what a Mac said of this account is what the phone goes by when none answers
  useEffect(() => {
    if (memory && mac.answered === true) memory.invited.set(true);
    // only a Mac that says so in so many words takes the hint away, and nothing else with it: a hello that lacks a capability (a flag not loaded yet, a second Mac that does not host MoMo) is no revoke, and what is held stays held until sign-out
    if (memory && mac.revoked) memory.invited.set(false);
  }, [memory, mac.answered, mac.revoked]);
  // while a Mac answers, where it says MoMo lives and the newest lease it has seen are kept here, so the phone never starts below them and knows MoMo has a home
  useEffect(() => {
    if (!memory || mac.answered !== true) return;
    type Seen = {
      keptOlder?: unknown;
      home?: {
        homeMachineId?: unknown;
        leaseEpoch?: unknown;
        machineName?: unknown;
        machines?: { machineId?: unknown; isHome?: unknown }[];
      };
    };
    const learn = (answer: unknown) => {
      const view = (answer as { view?: Seen } | null)?.view;
      if (!view) return;
      // the older MoMos the owner chose to keep, as the Mac says them: only what it says is learned (a card that is merely not shown, a machine that is asleep, a change that
      // carries no list: nothing). Asking again is the safe side.
      const kept = Array.isArray(view.keptOlder) ? view.keptOlder.filter((k): k is string => typeof k === 'string') : [];
      const known = memory.kept.read();
      if (kept.some((k) => !known.includes(k))) memory.kept.write([...new Set([...known, ...kept])]);
      const h = view.home;
      // `homeMachineId` is the home's own id (the Host it lives on); the machine itself is the row the view marks as the home
      const machineId = h?.machines?.find((m) => m.isHome === true)?.machineId;
      if (
        typeof h?.homeMachineId === 'string' &&
        h.homeMachineId &&
        typeof h.leaseEpoch === 'number' &&
        Number.isSafeInteger(h.leaseEpoch) &&
        h.leaseEpoch > 0
      )
        memory.learn({
          machineId: typeof machineId === 'string' ? machineId : null,
          homeId: h.homeMachineId,
          name: typeof h.machineName === 'string' ? h.machineName : '',
          leaseEpoch: h.leaseEpoch,
        });
    };
    runtime.request('momo.home.view', {}).then(learn, () => undefined);
    return runtime.onEvent((event) => {
      if (event.ev === CHANGED_EVENT) learn(event);
    });
  }, [memory, mac.answered, runtime]);
  const silentHeld = useHeld(mac.silent, silentMs);
  const hosts = direct ? direct.phones.records().length : 0;
  const active = phoneHomeNow({ macAllowed: mac.answered, macSilent: silentHeld, invited: memory?.invited.read() ?? false, hosts });
  const home = useMemo(() => {
    if (!active || !kept || !direct || !user) return null;
    return createPhoneHome({
      sessions: direct.phones,
      // the composition is made again when the account changes, so this is the account it was made for
      account: () => user,
      onChange: (fn) => direct.subscribe(fn),
      memory: kept.memory,
      newId: kept.newId,
      // a grant that is refused, or a step a Host did not take: seen in the device log, never a stalled screen
      report: (error) => console.warn('momo-home', error),
    });
  }, [active, kept, direct, user]);
  // the composition is made inert and started only here, and every one that was started is stopped
  useEffect(() => {
    home?.start();
    return () => home?.dispose();
  }, [home]);
  return { channel: home?.channel ?? null, scope: JSON.stringify([user, 'phone-home']) };
}
