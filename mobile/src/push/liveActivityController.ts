// The phone's Live Activity controller: starts the activity when the switch is on and a chat runs or waits, hands its push-to-update token to the relay, ends it when the switch goes off, and keeps sealed titles off the lock screen unless the person turned them on.
export type LiveActivityPrefs = { enabled: boolean; titles: boolean };
/** Off, and chat titles off, until the person turns them on: nothing is started and no iOS permission is asked before that. */
export const DEFAULT_LIVE_ACTIVITY_PREFS: LiveActivityPrefs = Object.freeze({
  enabled: false,
  titles: false,
});

/** Anything unreadable reads as off, so a bad store never starts an activity. */
export function parseLiveActivityPrefs(raw: string | null): LiveActivityPrefs {
  let value: { enabled?: unknown; titles?: unknown } | null = null;
  try {
    value = raw ? JSON.parse(raw) : null;
  } catch {
    value = null;
  }
  return { enabled: value?.enabled === true, titles: value?.titles === true };
}

export type ActivityRowWire = {
  kind: string;
  since: number;
  ref: string;
  st?: string;
};
/** The content state, as the module and the widget decode it (unix seconds). */
export type ActivityStateWire = {
  needs: number;
  running: number;
  kind: string;
  since: number;
  rows: ActivityRowWire[];
};

export interface LiveActivityNative {
  /** Whether iOS lets this app run Live Activities (asks nothing). */
  isEnabled(): Promise<boolean>;
  /** Starts the activity, or adopts the running one without changing it; false when iOS refused. */
  start(state: ActivityStateWire): Promise<boolean>;
  update(state: ActivityStateWire): Promise<void>;
  /** Removes the sealed title of every row of the running activity. */
  stripTitles(): Promise<void>;
  end(): Promise<void>;
  token(): Promise<string | null>;
  /** Writes "Chat titles on lock screen" to the App Group the widget reads; false when the App Group is not available. */
  setTitlesSwitch(on: boolean): Promise<boolean>;
  /** The saved switch, kept where an uninstall removes it (the keychain would bring a reinstalled app back with the switch on). */
  loadPrefs(): Promise<string | null>;
  savePrefs(raw: string): Promise<void>;
  onToken(listener: (token: string) => void): () => void;
  /** The activity is gone: `dismissed` when the person removed it while it ran, otherwise it ended (by the relay, the app or a timeout). */
  onEnded(listener: (dismissed: boolean) => void): () => void;
}

/** `blocked`: the switch is on but iOS has Live Activities off for the app. `unsupported`: no module in this build (Android, the web preview). */
export type LiveActivityStatus = 'off' | 'on' | 'blocked' | 'unsupported';
/** `loaded`: the saved switch has been read (before that `prefs` are the defaults). */
export type LiveActivityUi = {
  prefs: LiveActivityPrefs;
  status: LiveActivityStatus;
  failed: boolean;
  loaded: boolean;
};
export type ActivityCounts = { needs: number; running: number };

interface Deps {
  native: LiveActivityNative | null;
  relay: {
    register(token: string): Promise<void>;
    unregister(): Promise<void>;
  };
  store: {
    read(): Promise<LiveActivityPrefs>;
    write(prefs: LiveActivityPrefs): Promise<void>;
  };
  /** The chats waiting for the person and running now; null while that is not known (no computer connected). */
  counts(): Promise<ActivityCounts | null>;
  signedIn(): boolean;
  /** Subscribe to the app returning to the foreground, and to the account changing; both reconcile. */
  foreground(listener: () => void): () => void;
  account(listener: () => void): () => void;
  now?: () => number;
  /** How long one task may take before the next one goes ahead; a call that never answers cannot keep the switch from turning off. */
  taskMs?: number;
}

export function createLiveActivity(d: Deps) {
  const now = d.now ?? Date.now;
  let prefs: LiveActivityPrefs = DEFAULT_LIVE_ACTIVITY_PREFS;
  let ui: LiveActivityUi = {
    prefs,
    status: d.native ? 'off' : 'unsupported',
    failed: false,
    loaded: false,
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<LiveActivityUi>) => {
    ui = { ...ui, prefs, ...patch };
    for (const fn of listeners) fn();
  };
  /** Whether this process believes an activity is running, and the token the relay holds for it. */
  let active = false;
  let registered: string | null = null;
  /** The relay may hold a token of ours: set when one is sent (even if the answer was lost) and at launch with the switch on; cleared when the relay confirms removing it. */
  let relayMayHold = false;
  /** Resolves when the saved switch has been read: a change before that would be written over it, so it waits. */
  let loaded!: () => void;
  const ready = new Promise<void>((resolve) => (loaded = resolve));
  /** The person dismissed the activity: it stays gone until nothing runs or waits, then a new one may start. */
  let dismissed = false;
  let chain: Promise<unknown> = Promise.resolve();
  let offs: Array<() => void> = [];
  let started = false;

  /** One task at a time; each reads the wanted state when it runs, so the last change wins. A failure is shown, never thrown. */
  function enqueue(task: () => Promise<void>) {
    const bounded = () =>
      new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('timed out')), d.taskMs ?? 15_000);
        task().then(
          () => (clearTimeout(timer), resolve()),
          (e) => (clearTimeout(timer), reject(e)),
        );
      });
    const run = chain.then(bounded).then(
      () => publish({ failed: false }),
      () => publish({ failed: true }),
    );
    chain = run;
    return run;
  }

  /** The switch the widget reads: titles only count while the activity is on. */
  const applyTitles = async () => {
    if (d.native && !(await d.native.setTitlesSwitch(prefs.enabled && prefs.titles))) throw new Error('The App Group is not available');
  };

  /** Removes the relay's token when it may hold one; a failure leaves it marked, so the next reconcile tries again. */
  /** Takes the wanted switch at once (the page shows it now) and saves it in order; a switch that could not be saved goes back and is shown as failed. */
  let writes: Promise<unknown> = Promise.resolve();
  async function save(next: LiveActivityPrefs) {
    const before = prefs;
    prefs = next;
    publish({});
    const write = writes.then(() => d.store.write(next));
    writes = write.catch(() => undefined);
    try {
      await write;
    } catch {
      // only a change nobody has superseded goes back
      if (prefs === next) prefs = before;
      publish({ failed: true });
      return false;
    }
    return true;
  }

  async function dropRelayToken() {
    if (!relayMayHold) return;
    await d.relay.unregister();
    registered = null;
    relayMayHold = false;
  }

  /** Ends the activity here and, unless `keepRelay`, the relay's token too. Both run: the first's failure does not skip the second. */
  async function tearDown(keepRelay = false) {
    if (!d.native) return;
    const results = await Promise.allSettled([d.native.end().then(() => void (active = false)), keepRelay ? undefined : dropRelayToken()]);
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
    if (failure) throw failure.reason;
  }

  async function registerToken(token: string) {
    // a token that arrives after the switch went off, the account left or its activity ended is not the relay's to hold
    if (!prefs.enabled || !d.signedIn() || !active || token === registered) return;
    relayMayHold = true;
    await d.relay.register(token);
    registered = token;
  }

  async function reconcile() {
    if (!d.native) return publish({ status: 'unsupported' });
    if (!prefs.enabled || !d.signedIn()) {
      await tearDown();
      return publish({ status: 'off' });
    }
    if (!(await d.native.isEnabled())) {
      await tearDown();
      return publish({ status: 'blocked' });
    }
    const counts = await d.counts();
    if (counts) {
      const busy = counts.needs + counts.running > 0;
      if (!busy) {
        dismissed = false;
        // nothing runs or waits: the relay ends it with a Finished frame; this ends what is left if the relay did not
        if (active) await tearDown(true);
      } else if (!dismissed && !active) {
        const ok = await d.native.start({
          needs: counts.needs,
          running: counts.running,
          kind: counts.needs > 0 ? 'needs' : 'running',
          since: Math.floor(now() / 1000),
          rows: [],
        });
        active = ok;
        if (!ok) return publish({ status: 'blocked' });
      }
    }
    // the token may have arrived before the listener, or the relay may have been unreachable when it did
    const token = active ? await d.native.token() : null;
    if (token) await registerToken(token);
    publish({ status: 'on' });
  }

  return {
    ui: () => ui,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Loads the saved switch, then follows the app: foreground, account changes, the activity's token and its end. */
    async start() {
      if (started) return;
      started = true;
      try {
        // a store that never answers reads as off after a bound, so the switch is not dead
        let timer: ReturnType<typeof setTimeout> | undefined;
        prefs = await Promise.race([
          d.store.read(),
          new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('unreadable')), d.taskMs ?? 15_000))),
        ]).finally(() => clearTimeout(timer));
      } finally {
        // an unreadable store reads as off, and the changes that waited for it go ahead
        loaded();
      }
      relayMayHold = prefs.enabled;
      publish({ loaded: true });
      await applyTitles().catch(() => undefined);
      if (d.native) {
        offs = [
          d.native.onToken((token) => void enqueue(() => registerToken(token))),
          d.native.onEnded(
            (byPerson) =>
              void enqueue(async () => {
                active = false;
                // only the person removing a running activity keeps it gone; one the relay or a timeout ended may start again with the next run
                dismissed = byPerson;
                await dropRelayToken();
              }),
          ),
        ];
      }
      offs.push(
        d.foreground(() => void enqueue(reconcile)),
        d.account(() => void enqueue(reconcile)),
      );
      await enqueue(reconcile);
    },
    stop() {
      for (const off of offs) off();
      offs = [];
      started = false;
    },
    /** The "Live Activity" switch. Turning it on is the first moment iOS may ask for permission; turning it off ends the activity and removes the relay's token. */
    async setEnabled(on: boolean) {
      if (!ui.loaded) await ready;
      const next = { ...prefs, enabled: on };
      // a switch that could not be saved is not applied (and said so), rather than left on in memory only
      if (!(await save(next))) return;
      dismissed = false;
      await enqueue(async () => {
        await applyTitles();
        await reconcile();
      });
    },
    /** "Chat titles on lock screen". Off removes a title already pushed to a running activity, after the widget has stopped reading keys. */
    async setTitles(on: boolean) {
      if (!ui.loaded) await ready;
      if (!(await save({ ...prefs, titles: on }))) return;
      await enqueue(async () => {
        await applyTitles();
        if (!on) await d.native?.stripTitles();
      });
    },
    /** Sign-out or a removed account: the activity ends, the relay's token goes, and the widget reads no titles. */
    forget: () =>
      enqueue(async () => {
        // an explicit sign-out leaves the switch off: the next account turns it on itself
        if (prefs.enabled) await save({ ...prefs, enabled: false });
        // the widget stops reading titles first, whatever else fails; then the activity and the relay's token go
        await d.native?.setTitlesSwitch(false).catch(() => undefined);
        publish({ status: d.native ? 'off' : 'unsupported' });
        await tearDown();
      }),
    /** Re-reads the chats and brings the activity in line (the caller knows chats changed). */
    refresh: () => enqueue(reconcile),
  };
}

export type LiveActivityController = ReturnType<typeof createLiveActivity>;
