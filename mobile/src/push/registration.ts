// Keep the relay's push token for this phone equal to what the OS currently hands out, serialized so the last desired state wins.
export type PushPlatform = 'apns' | 'fcm';

export interface PushRelayPort {
  register(platform: PushPlatform, token: string): Promise<void>;
  unregister(): Promise<void>;
}
/** What a person is told of this phone's token: handed to the relay, not handed out yet, or not obtainable in this build. */
export type TokenStatus = 'registered' | 'waiting' | 'unavailable';

export interface TokenSource {
  platform: PushPlatform;
  /** The current device token, or null while the OS has none (permission off, simulator, no Google services). */
  get(): Promise<string | null>;
  /** Why the last `get` could not ask the OS for a token (a missing module or entitlement in this build), or null when it could. */
  readonly failure?: string | null;
  /** Calls back when the OS announces a token (a rotation, and also the echo of every `get`), with it when it has it; returns the unsubscribe. */
  onRefresh(listener: (token?: string | null) => void): () => void;
}
export interface RegisteredStore {
  read(): Promise<string | null>;
  write(token: string | null): Promise<void>;
}

/**
 * `enable` and `disable` change what is wanted; every change and every `sync` runs one reconcile at a time. A reconcile reads the wanted
 * state when it runs, so a disable that lands during a register is followed by an unregister rather than lost. A failed relay call
 * rejects that call and keeps the old registered value, so the next `sync` (foreground, relay up, token refresh) retries it.
 */
export function createPushRegistration(o: { relay: PushRelayPort; tokens: TokenSource; store: RegisteredStore }) {
  let wanted = false;
  let registered: string | null | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  let stopRefresh: (() => void) | null = null;
  let epoch = 0;
  let status: TokenStatus | null = null;
  const watchers = new Set<(status: TokenStatus | null) => void>();
  const setStatus = (next: TokenStatus | null) => {
    if (next === status) return;
    status = next;
    for (const watcher of watchers) watcher(next);
  };

  /** The last token the OS gave or announced. */
  let seen: string | null = null;
  async function reconcile() {
    const mine = epoch;
    if (registered === undefined) registered = await o.store.read();
    if (wanted) {
      const token = await o.tokens.get();
      seen = token;
      if (!wanted) return;
      if (!token) return setStatus(o.tokens.failure ? 'unavailable' : 'waiting');
      if (token === registered) return setStatus('registered');
      try {
        await o.relay.register(o.tokens.platform, token);
      } catch (error) {
        // a first refusal leaves the token not yet registered; a later one keeps the token the relay already has
        if (status === null && wanted) setStatus('waiting');
        throw error;
      }
      if (mine !== epoch) return;
      registered = token;
      // a disable that landed during the call is followed by the unregister: nothing is registered then
      if (wanted) setStatus('registered');
      await o.store.write(token);
      // a forget that ran during the write must have the last word in the store
      if (mine !== epoch) await o.store.write(null);
    } else if (registered !== null) {
      await o.relay.unregister();
      if (mine !== epoch) return;
      registered = null;
      await o.store.write(null);
    }
  }
  function sync(): Promise<void> {
    const next = chain.then(reconcile);
    chain = next.catch(() => undefined);
    return next;
  }
  return {
    sync,
    /** Start registering the token now and on every rotation. */
    enable() {
      wanted = true;
      // asking the OS for the token makes it announce the token again, which asked again: only a token not seen yet starts a reconcile
      stopRefresh ??= o.tokens.onRefresh((token) => {
        if (token && (token === seen || token === registered)) return;
        void sync().catch(() => undefined);
      });
      return sync();
    },
    /** Forget the remembered token without calling the relay, so the next account registers from scratch. Outlives any operation in flight. */
    async forget() {
      epoch++;
      registered = null;
      setStatus(null);
      await o.store.write(null);
    },
    /** The token's status while registration is wanted (null while it is not); `listener` hears each change, and the returned function stops it. */
    onStatus(listener: (status: TokenStatus | null) => void) {
      watchers.add(listener);
      return () => watchers.delete(listener);
    },
    /** Stop following rotations and remove this phone's token from the relay. */
    disable() {
      wanted = false;
      setStatus(null);
      stopRefresh?.();
      stopRefresh = null;
      return sync();
    },
  };
}
