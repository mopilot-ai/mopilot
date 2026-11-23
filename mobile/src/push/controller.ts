// The phone's push controller: permission, token registration, mailbox drains and tap routing, driven by the runtime's snapshots.
import type { MobileRuntime } from '../contracts';
import { locateTarget, type Target } from './route';
import type { PushPayload } from './payload';
import type { TokenStatus } from './registration';
import type { PermissionStep } from './permission';
import { createWake } from './wake';
import { LOCK_SCREENS } from './channels';
import { DEFAULT_PREFS, isClock, type PushPrefs } from './prefs';
import type { LiveActivityController } from './liveActivityController';
import { chatRef } from './chatRef';
import { ConnectionCancelled } from '../reconnect';

export type PushUi = {
  step: PermissionStep;
  target: Target | null;
  busy: boolean;
  prefs: PushPrefs;
  notice: string | null;
  /** Whether this phone's push token reached the relay; null while notifications are off or not allowed. */
  token: TokenStatus | null;
  /** Why the last switch was put back (it could not be saved); null once a later change is saved. */
  prefsError: string | null;
};
export type PrefsPatch = {
  enabled?: boolean;
  sound?: boolean;
  lockScreen?: PushPrefs['lockScreen'];
  quiet?: { on?: boolean; from?: string; to?: string };
  liveActivity?: boolean;
  titles?: boolean;
  skipOpenChat?: boolean;
};

interface Deps {
  runtime: MobileRuntime;
  permission: {
    step(): Promise<PermissionStep>;
    accept(): Promise<'granted' | 'denied'>;
    dismiss(): Promise<void>;
  };
  registration: {
    enable(): Promise<void>;
    disable(): Promise<void>;
    sync(): Promise<void>;
    forget(): Promise<void>;
    onStatus?(listener: (status: TokenStatus | null) => void): () => void;
  };
  prefs: { read(): Promise<PushPrefs>; write(prefs: PushPrefs): Promise<void> };
  titleKeys: {
    prune(live: string[]): Promise<void>;
    save(pairId: string, key: Uint8Array): Promise<void>;
  };
  /** Show a local notification that proves this phone can display one (the fixed "needs you" title, no chat). */
  showTest?(): Promise<void>;
  /** Subscribe to taps on a notification (also the one that launched the app). */
  taps(listener: (payload: PushPayload, reply?: string) => void): () => void;
  /** Subscribe to pushes that arrive while the app is on screen. */
  pushes(listener: (payload: PushPayload) => void): () => void;
  /** Subscribe to the app returning to the foreground. */
  foreground(listener: () => void): () => void;
  /**
   * The phone's Live Activity. Its own saved switch (in the app's defaults, gone with an uninstall) is the authority for being on; `prefs.liveActivity` mirrors it for the page's summary.
   * The titles choice on this phone is also the activity's: it follows `prefs.titles`.
   */
  liveActivity?: LiveActivityController;
  /** Work that must finish while the session still authenticates, run with the token removal (the Live Activity's end and its relay token); a failure is not the sign-out's. */
  beforeSignOut?(): Promise<unknown>;
  /** How long sign-out waits for the relay to drop this phone's token. */
  unregisterMs?: number;
  /** How long a registration step (device token, relay) may take before the next switch's effects go ahead. */
  effectMs?: number;
  /** The clock, and how long a failed background drain waits before another one is tried. */
  now?: () => number;
  drainBackoffMs?: number;
}

export function createPushController(d: Deps) {
  let ui: PushUi = {
    step: 'unknown',
    target: null,
    busy: false,
    prefs: DEFAULT_PREFS,
    notice: null,
    token: null,
    prefsError: null,
  };
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<PushUi>) => {
    ui = { ...ui, ...patch };
    for (const fn of listeners) fn();
  };
  let lastPair: string | null = null;
  let tapSerial = 0;
  let offs: Array<() => void> = [];
  const wake = createWake(() => drain());
  const signedIn = () => !!d.runtime.snapshot().user;
  const livePairs = () => d.runtime.snapshot().pairs.map((p) => p.pairId);
  let enabledUser: string | null = null;
  let prefsReady = false;
  /** The saved prefs were read (not replaced by defaults after a failed read): only then does the mirror write them. */
  let prefsRead = false;
  let failedAt: number | null = null;
  const now = d.now ?? Date.now;
  let prefsChain: Promise<unknown> = Promise.resolve();
  /** The handle of the chat that is open on screen, as a push names it; null when no chat is open. */
  let openRef: string | null = null;
  /** Register for the signed-in account once per account; a different account first forgets the previous one's token. */
  async function ensureEnabled() {
    const user = d.runtime.snapshot().user?.id ?? null;
    if (!prefsReady || !user || user === enabledUser || !ui.prefs.enabled) return;
    const previous = enabledUser;
    if (previous) {
      await d.registration.forget();
      // the previous account's computers are not this account's: their title keys go (the Mac resends the new ones)
      // (against the pairs it has now: the new account's computers may already have handed over their keys)
      await d.titleKeys.prune(livePairs()).catch(() => undefined);
      // a sign-out or another account change during the wait owns the state now
      if (enabledUser !== previous || d.runtime.snapshot().user?.id !== user) return;
    }
    enabledUser = user;
    await d.registration.enable().catch(() => undefined);
  }

  /** A switch is shown the moment it is touched; only the saves are serialized, and what a change sets in motion (registration, keys, the activity) runs on its own bounded chain, so a hung step never holds a switch back. */
  function setPrefsOf(patch: PrefsPatch, fromActivity = false) {
    const old = ui.prefs;
    const prefs = merge(old, patch);
    publish({ prefs });
    // only the save is in the chain: the effects it returns run after it, outside it
    const saved = prefsChain.then(() => persist(patch, old, prefs, fromActivity));
    prefsChain = saved.then(
      () => undefined,
      () => undefined,
    );
    return saved.then((effects) => effects?.());
  }

  /** The reason a save failed, when it has words of its own. */
  const reason = (error: unknown) => (error instanceof Error && error.message ? ` ${error.message}` : '');

  /** Runs a step that may hang (device token, relay, keychain): it stops being waited for after `effectMs`. */
  const bounded = (task: () => Promise<unknown>) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, d.effectMs ?? 10_000);
      void Promise.resolve()
        .then(task)
        .catch(() => undefined)
        .then(() => (clearTimeout(timer), resolve()));
    });
  /** What a saved change sets in motion, one at a time and in order; a step that hangs is let go after a bound. */
  function effect(task: () => Promise<unknown>) {
    const run = effectChain.then(() => bounded(task));
    effectChain = run;
    return run;
  }
  let effectChain: Promise<unknown> = Promise.resolve();

  /** `prefs.liveActivity` shows what the activity's own switch says; nothing is written before both the saved prefs and the activity's switch are read. */
  function mirrorActivity() {
    const activity = d.liveActivity?.ui();
    if (!prefsRead || !activity?.loaded || ui.prefs.liveActivity === activity.prefs.enabled) return;
    void setPrefsOf({ liveActivity: activity.prefs.enabled }, true);
  }

  function merge(old: PushPrefs, patch: PrefsPatch): PushPrefs {
    const quiet = {
      on: patch.quiet?.on ?? old.quiet.on,
      from: isClock(patch.quiet?.from) ? patch.quiet.from : old.quiet.from,
      to: isClock(patch.quiet?.to) ? patch.quiet.to : old.quiet.to,
    };
    return {
      enabled: patch.enabled ?? old.enabled,
      sound: patch.sound ?? old.sound,
      lockScreen: LOCK_SCREENS.find((l) => l === patch.lockScreen) ?? old.lockScreen,
      quiet,
      liveActivity: patch.liveActivity ?? old.liveActivity,
      titles: patch.titles ?? old.titles,
      skipOpenChat: patch.skipOpenChat ?? old.skipOpenChat,
    };
  }

  /** Saves what is shown (the latest, so quick changes save the last one) and then runs the change's effects. @param fromActivity the change mirrors the activity's own switch: it is saved and shown, never sent back to it */
  async function persist(
    patch: PrefsPatch,
    old: PushPrefs,
    prefs: PushPrefs,
    fromActivity: boolean,
  ): Promise<(() => Promise<void>) | undefined> {
    try {
      await d.prefs.write(ui.prefs);
    } catch (error) {
      // not saved: only the fields this change touched go back, and the person is told
      const back = { ...ui.prefs };
      for (const key of Object.keys(prefs) as Array<keyof PushPrefs>)
        if (JSON.stringify(prefs[key]) !== JSON.stringify(old[key]) && JSON.stringify(back[key]) === JSON.stringify(prefs[key]))
          (back as Record<string, unknown>)[key] = old[key];
      publish({
        prefs: back,
        prefsError: `Could not save this setting. It was put back.${reason(error)}`,
      });
      return;
    }
    if (ui.prefsError) publish({ prefsError: null });
    // a saved change reaches the activity: titles follow the choice, and a liveActivity change asked for here (not the mirror's own) turns it on or off
    if (!fromActivity && patch.liveActivity !== undefined && d.liveActivity && patch.liveActivity !== d.liveActivity.ui().prefs.enabled)
      void d.liveActivity.setEnabled(patch.liveActivity);
    if (prefs.titles !== old.titles) void d.liveActivity?.setTitles(prefs.titles);
    // titles off: the keys go, so the iOS extension and the Android handler both fall back to the fixed title (the Mac hands the key over again when this phone next talks to it, at most every few minutes)
    const dropKeys = old.titles && !prefs.titles;
    const toggled = prefs.enabled !== old.enabled;
    if (!dropKeys && !toggled) return undefined;
    return async () => {
      if (dropKeys) await effect(() => d.titleKeys.prune([]));
      if (!toggled) return;
      if (!prefs.enabled) {
        enabledUser = null;
        await effect(() => d.registration.disable());
      } else if (ui.step === 'granted') await effect(ensureEnabled);
    };
  }

  async function refreshStep() {
    const step = await d.permission.step();
    publish({ step });
    if (step === 'granted') await ensureEnabled();
  }
  /** Reconnect the last used (or only) computer so its mailbox drains; a connected phone already receives live. */
  async function drain() {
    const s = d.runtime.snapshot();
    // only a phone that is idle and offline (or failed earlier): a connect would cancel a pairing, a cleanup or the user's own connect
    if (!s.user || (s.phase !== 'offline' && s.phase !== 'error') || s.pendingPair || s.pairCleanup) return;
    if (failedAt !== null && now() - failedAt < (d.drainBackoffMs ?? 30_000)) return;
    const pair = (lastPair && s.pairs.some((p) => p.pairId === lastPair) ? lastPair : null) ?? s.pairs[0]?.pairId;
    if (!pair) return;
    try {
      await d.runtime.connect(pair);
      failedAt = null;
    } catch (error) {
      // a computer that is offline would otherwise be retried, and the app left in its error state, by every push of a storm
      failedAt = now();
      throw error;
    }
  }
  /** The pages of the chat list read for a tap, newest first, and the most it will read (10 pages of 50): a push for an older chat must still find it. */
  const TAP_PAGE = 50;
  const TAP_PAGES = 10;
  /** Opens the computer for a tap. A connection that the app's own reconnect (the app just came back to the front) replaced is not a failure: the tap looks again, and goes on once that one is online. */
  async function reach(pairId: string, serial: number, retries = 2): Promise<void> {
    const s = d.runtime.snapshot();
    if (s.phase === 'online' && s.selectedPair === pairId) return;
    try {
      await d.runtime.connect(pairId);
    } catch (error) {
      if (!(error instanceof ConnectionCancelled) || retries === 0 || serial !== tapSerial) throw error;
      await reach(pairId, serial, retries - 1);
    }
  }
  async function chatIds(pairId: string, serial: number, found: (ids: string[]) => boolean) {
    await reach(pairId, serial);
    if (serial !== tapSerial) return [];
    const ids: string[] = [];
    for (let page = 0; page < TAP_PAGES; page++) {
      const result = (await d.runtime.request('chats.recent', { limit: TAP_PAGE, offset: page * TAP_PAGE })) as {
        chats?: Array<{ id?: unknown }>;
        more?: unknown;
      } | null;
      const read = (result?.chats ?? []).flatMap((c) => (typeof c.id === 'string' && !ids.includes(c.id) ? [c.id] : []));
      ids.push(...read);
      // the handle matched, the Mac has no more (or an older Mac that ignores the offset sent the same page again), or a newer tap took over: no further page is read
      if (found(ids) || result?.more !== true || !read.length || serial !== tapSerial) break;
    }
    return ids;
  }
  /** The ids of MoMo's open channels, read from the Mac the tap is for (none when it lists no channels or has them off). */
  async function channelIds(pairId: string, serial: number) {
    await reach(pairId, serial);
    if (serial !== tapSerial) return [];
    const list = (await d.runtime.request('momo.channels.list', {})) as { enabled?: unknown; channels?: Array<{ id?: unknown }> } | null;
    if (list?.enabled !== true) return [];
    return (list.channels ?? []).flatMap((c) => (typeof c.id === 'string' ? [c.id] : []));
  }
  /** Resolves once the runtime has left `loading`, whatever it found. */
  const loaded = () =>
    new Promise<void>((resolve) => {
      const off = d.runtime.subscribe(() => {
        if (d.runtime.snapshot().phase === 'loading') return;
        off();
        resolve();
      });
    });
  async function open(payload: PushPayload, reply?: string) {
    const serial = ++tapSerial;
    // the tap that launched the app is replayed before the runtime has read its account: it waits for that, not for a user that is not there yet
    if (d.runtime.snapshot().phase === 'loading') await loaded();
    if (serial !== tapSerial) return;
    const s = d.runtime.snapshot();
    if (!s.user) return;
    const target = await locateTarget(payload, {
      pairs: s.pairs.map((p) => p.pairId),
      chatIds: (pairId, found) => chatIds(pairId, serial, found),
      channelIds: (pairId) => channelIds(pairId, serial),
      current: () => serial === tapSerial && signedIn(),
    });
    // a typed reply becomes a draft in the chat it names; it is never sent from here
    if (serial !== tapSerial) return;
    // the computer may have been unpaired while its chats were being read
    if (target && !livePairs().includes(target.pairId)) return;
    if (!target) {
      // typed text must not vanish without a word
      if (reply)
        publish({
          notice: 'Could not find that chat, so your reply was not kept.',
        });
      return;
    }
    const pending = ui.target;
    // a second reply for the chat of a still-pending one goes after it
    const same = pending?.chatId !== undefined && pending.chatId === target.chatId && pending.pairId === target.pairId;
    const draft = [same ? pending.draft : undefined, reply && target.chatId ? reply : undefined].filter(Boolean).join('\n');
    publish({ notice: null, target: draft ? { ...target, draft } : target });
  }
  /** The Mac hands over a pair's title key as a sealed `push.titleKey` event on the channel; it is stored for the extension and the data-message task. */
  function onEvent(message: unknown) {
    const event = message as {
      kind?: string;
      ev?: string;
      patch?: { key?: unknown };
    };
    const key = event.patch?.key;
    const pair = d.runtime.snapshot().selectedPair;
    if (event.kind !== 'event' || event.ev !== 'push.titleKey' || !pair || typeof key !== 'string' || !/^[0-9a-f]{64}$/.test(key)) return;
    const bytes = Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(key.slice(i * 2, i * 2 + 2), 16));
    // the saved choice is not read yet: the key waits for it
    if (!prefsReady) early.push([pair, bytes]);
    // titles are the person's choice on this phone: a key sent while they are off is not kept. The same key opens MoMo's opt-in push body (A6), so that body also needs this switch
    else if (ui.prefs.titles) keep(pair, bytes);
  }
  const keep = (pair: string, bytes: Uint8Array) => void d.titleKeys.save(pair, bytes).catch(() => undefined);
  /** Title keys that arrived before the saved titles choice was read. */
  let early: Array<[string, Uint8Array]> = [];
  let known = new Set<string>();
  let pruned = false;
  let wasOnline = false;
  const onSnapshot = () => {
    const s = d.runtime.snapshot();
    if (s.selectedPair) lastPair = s.selectedPair;
    const live = new Set(s.pairs.map((p) => p.pairId));
    // pairs are loaded before the account is shown, so the first signed-in snapshot also drops the keys of pairs removed while the app was closed
    const first = !pruned && !!s.user && s.phase !== 'loading';
    if (first) pruned = true;
    if (first || [...known].some((id) => !live.has(id))) void d.titleKeys.prune([...live]).catch(() => undefined);
    const hadComputers = known.size > 0;
    known = live;
    // the relay drops a phone's push token with its last computer, so the token remembered as registered may be gone: a computer coming back registers it from scratch
    if (s.user && live.size > 0 && !hadComputers && !first && s.phase !== 'loading' && ui.step === 'granted')
      void d.registration
        .forget()
        .then(() => d.registration.sync())
        .catch(() => undefined);
    // a tap on a computer that has since been unpaired must not wait for it forever
    if (ui.target && !live.has(ui.target.pairId)) publish({ target: null });
    if (!s.user && enabledUser) {
      // the session ended without push.signOut (expired, revoked): the relay may have dropped the token
      enabledUser = null;
      void d.registration.forget().catch(() => undefined);
    }
    if (ui.step === 'granted') void ensureEnabled();
    const online = s.phase === 'online';
    if (online && !wasOnline && ui.step === 'granted') void d.registration.sync().catch(() => undefined);
    wasOnline = online;
  };
  return {
    ui: () => ui,
    subscribe(fn: () => void) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    start() {
      this.stop();
      pruned = false;
      offs = [
        d.runtime.subscribe(onSnapshot),
        d.runtime.onEvent(onEvent),
        d.taps((p, reply) => void open(p, reply).catch(() => undefined)),
        d.pushes(() => void wake.wake()),
        d.foreground(() => {
          void wake.wake();
          void refreshStep().catch(() => undefined);
        }),
        ...(d.registration.onStatus ? [d.registration.onStatus((token) => publish({ token }))] : []),
      ];
      onSnapshot();
      if (d.liveActivity) offs.push(d.liveActivity.subscribe(mirrorActivity));
      return d.prefs.read().then(
        (prefs) => {
          prefsReady = true;
          prefsRead = true;
          publish({ prefs });
          // the activity follows the titles choice from the start, and the mirror follows the activity (a reinstall brings the keychain's copy back, not the activity's)
          void d.liveActivity?.setTitles(prefs.titles);
          mirrorActivity();
          // keys left from before titles were a choice on this phone go too: the extension would open them whatever the switch says
          if (prefs.titles) for (const [pair, bytes] of early) keep(pair, bytes);
          else void d.titleKeys.prune([]).catch(() => undefined);
          early = [];
          return refreshStep();
        },
        () => {
          prefsReady = true;
          early = [];
          return refreshStep();
        },
      );
    },
    stop() {
      for (const off of offs) off();
      offs = [];
    },
    /** The explanation screen's "Turn on": the OS prompt, then register on a yes. */
    async accept() {
      publish({ busy: true });
      try {
        const result = await d.permission.accept();
        publish({ step: result === 'granted' ? 'granted' : 'blocked' });
        if (result === 'granted') await ensureEnabled();
      } finally {
        publish({ busy: false });
      }
    },
    async later() {
      // hidden first: the keychain write can be slow, or fail, and the card must not wait for it (the flow keeps this run's choice either way)
      publish({ step: 'later' });
      await d.permission.dismiss().catch(() => undefined);
    },
    /** Apply a settings change: invalid clock times are ignored; turning notifications off removes the token, on registers it again. */
    setPrefs: setPrefsOf,
    /** The phone's Live Activity controller, when this build has one. */
    liveActivity: d.liveActivity,
    /** The chat now on screen (null: none), so its own notifications can be skipped while the person is reading it. */
    setOpenChat(pairId: string | null, chatId: string | null) {
      openRef = pairId && chatId ? chatRef(pairId, chatId) : null;
    },
    /** Whether a notification that arrives while the app is on screen is drawn: not the open chat's (when skipped), not the offline notice the app already shows. */
    present(payload: PushPayload) {
      if (!ui.prefs.enabled || payload.kind === 'machineOffline') return false;
      return !(ui.prefs.skipOpenChat && openRef !== null && payload.ref === openRef);
    },
    /** The Notifications page's test button: true when the phone handed a notification to the system. */
    async sendTest() {
      if (!d.showTest) return false;
      try {
        await d.showTest();
        return true;
      } catch {
        return false;
      }
    },
    consumeTarget() {
      publish({ target: null, notice: null });
    },
    /** Drop this phone's token while the session can still authenticate, then sign out; a slow relay does not block sign-out. */
    async signOut() {
      tapSerial++;
      publish({ target: null });
      let timer: unknown;
      await Promise.race([
        Promise.all([d.registration.disable().catch(() => undefined), d.beforeSignOut?.().catch(() => undefined)]),
        new Promise<void>((resolve) => (timer = setTimeout(resolve, d.unregisterMs ?? 4000))),
      ]);
      clearTimeout(timer as never);
      enabledUser = null;
      // forgotten even when the relay did not confirm the removal: no later sync of this session can retry it, and a remembered
      // token would stop the next sign-in from registering (the relay's register moves the token off any other device, #3098)
      await d.registration.forget().catch(() => undefined);
      await d.runtime.signOut();
      // signed out: no connection can hand over a new key, so every key goes (the Mac resends after the next sign-in)
      await d.titleKeys.prune([]).catch(() => undefined);
    },
  };
}
export type PushController = ReturnType<typeof createPushController>;
