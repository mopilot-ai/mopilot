// The phone's copy of MoMo's home (notes and messages not yet confirmed) for the screens below: opened only when they need it (or when something was kept before, to forget what belongs to an account or computer that is gone), and forgotten with its account or computer.
import { createContext, type ReactNode, useEffect, useMemo } from 'react';
import type { MobileRuntime } from '../../contracts';
import { guardHomeCache, type HomeCache, type HomeScope } from '../../momoPhone/homeCache';
import { type Admit, openStamps } from '../../momoPhone/stamps';

export type HomeCacheAccess = {
  /** The copy, opened on the first ask; null when it cannot be opened. */
  get(): Promise<HomeCache | null>;
  /** Notes that a copy now exists on this phone. */
  mark(): Promise<void>;
  /** What this account refuses from an old home: the newest lease seen, kept sealed, read once. */
  stamps(user: string): Promise<Admit>;
  /** Forgets what is kept for one account and computer, if anything was ever kept. */
  forgetScope(at: HomeScope): Promise<void>;
};

export const HomeCacheContext = createContext<HomeCacheAccess | null>(null);

export function MomoHomeCacheProvider({
  runtime,
  open,
  wasUsed,
  mark,
  children,
}: {
  runtime: MobileRuntime;
  open: () => Promise<HomeCache>;
  wasUsed: () => Promise<boolean>;
  mark: () => Promise<void>;
  children: ReactNode;
}) {
  const access = useMemo(() => {
    let opened: Promise<HomeCache | null> | null = null;
    let stop: (() => void) | null = null;
    let closed = false;
    const get = () => {
      opened ??= open().then(
        (cache) => {
          // watching starts with the copy: from here a sign-out or an unpaired computer forgets what belongs to it
          if (!closed) stop = guardHomeCache(runtime, cache);
          return cache;
        },
        () => null,
      );
      return opened;
    };
    const admits = new Map<string, Promise<Admit>>();
    const stamps = (user: string) => {
      let admit = admits.get(user);
      if (!admit) {
        admit = get().then((cache) => openStamps(cache, user, mark));
        admits.set(user, admit);
      }
      return admit;
    };
    const forgetScope = async (at: HomeScope) => {
      if (await wasUsed().catch(() => false)) await (await get())?.forget((s) => s.user === at.user && s.pair === at.pair);
    };
    return {
      get,
      mark,
      stamps,
      forgetScope,
      // used by the effect below
      check: async () => ((await wasUsed().catch(() => false)) ? void (await get()) : undefined),
      close: () => {
        closed = true;
        stop?.();
      },
    };
  }, [runtime, open, wasUsed, mark]);
  // a launch finds a copy from before and forgets what belongs to an account or computer that is gone
  useEffect(() => {
    void access.check();
    return access.close;
  }, [access]);
  return <HomeCacheContext.Provider value={access}>{children}</HomeCacheContext.Provider>;
}
