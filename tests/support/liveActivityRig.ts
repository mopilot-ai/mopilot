// The rig of the phone's Live Activity controller tests: a fake native module, relay and store that log what they are asked, and the events the controller subscribes to.
import {
  createLiveActivity,
  DEFAULT_LIVE_ACTIVITY_PREFS,
  type ActivityCounts,
  type LiveActivityNative,
  type LiveActivityPrefs,
} from '../../mobile/src/push/liveActivityController.ts';

export function rig(
  o: {
    prefs?: LiveActivityPrefs;
    counts?: ActivityCounts | null;
    allowed?: boolean;
    native?: boolean;
    slowRead?: boolean;
    taskMs?: number;
    hangCounts?: boolean;
  } = {},
) {
  const log: string[] = [];
  let counts: ActivityCounts | null = o.counts === undefined ? { needs: 1, running: 2 } : o.counts;
  let allowed = o.allowed ?? true;
  let signedIn = true;
  let token: string | null = null;
  let saved: LiveActivityPrefs = o.prefs ?? DEFAULT_LIVE_ACTIVITY_PREFS;
  let startResult = true;
  let titlesOk = true;
  const failing = {
    register: false,
    unregister: false,
    counts: false,
    read: false,
    write: false,
  };
  const handlers = {
    token: new Set<(t: string) => void>(),
    ended: new Set<(byPerson: boolean) => void>(),
    foreground: new Set<() => void>(),
    account: new Set<() => void>(),
  };
  let inFlight = 0;
  let maxInFlight = 0;
  const track = async <T>(name: string, fn: () => T): Promise<T> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    log.push(name);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return fn();
  };
  const native: LiveActivityNative = {
    isEnabled: () => track('isEnabled', () => allowed),
    start: (state) => track(`start:${state.needs}/${state.running}/${state.kind}/${state.since}/${state.rows.length}`, () => startResult),
    update: () => track('update', () => undefined),
    stripTitles: () => track('stripTitles', () => undefined),
    end: () => track('end', () => undefined),
    token: () => track('token', () => token),
    setTitlesSwitch: (on) => track(`titles:${on}`, () => titlesOk),
    loadPrefs: () => track('loadPrefs', () => null),
    savePrefs: () => track('savePrefs', () => undefined),
    onToken: (l) => (handlers.token.add(l), () => void handlers.token.delete(l)),
    onEnded: (l) => (handlers.ended.add(l), () => void handlers.ended.delete(l)),
  };
  const activity = createLiveActivity({
    native: o.native === false ? null : native,
    relay: {
      register: async (t) => {
        log.push(`relay.register:${t}`);
        if (failing.register) throw new Error('relay down');
      },
      unregister: async () => {
        log.push('relay.unregister');
        if (failing.unregister) throw new Error('relay down');
      },
    },
    store: {
      read: async () => {
        if (o.slowRead) await new Promise((r) => setTimeout(r, 20));
        if (failing.read) throw new Error('defaults unreadable');
        return saved;
      },
      write: async (p) => {
        if (failing.write) throw new Error('defaults full');
        saved = p;
        log.push(`store:${p.enabled}/${p.titles}`);
      },
    },
    counts: async () => {
      if (o.hangCounts && !failing.counts) await new Promise(() => undefined);
      if (failing.counts) throw new Error('chats unreadable');
      return counts;
    },
    signedIn: () => signedIn,
    foreground: (l) => (handlers.foreground.add(l), () => void handlers.foreground.delete(l)),
    account: (l) => (handlers.account.add(l), () => void handlers.account.delete(l)),
    now: () => 1_900_000_000_000,
    taskMs: o.taskMs,
  });
  return {
    activity,
    log,
    handlers,
    failing,
    saved: () => saved,
    maxInFlight: () => maxInFlight,
    set: {
      counts: (c: ActivityCounts | null) => (counts = c),
      allowed: (v: boolean) => (allowed = v),
      signedIn: (v: boolean) => (signedIn = v),
      token: (t: string | null) => (token = t),
      startResult: (v: boolean) => (startResult = v),
      titlesOk: (v: boolean) => (titlesOk = v),
    },
    emit: {
      token: (t: string) => handlers.token.forEach((l) => l(t)),
      ended: (byPerson = true) => handlers.ended.forEach((l) => l(byPerson)),
      foreground: () => handlers.foreground.forEach((l) => l()),
      account: () => handlers.account.forEach((l) => l()),
    },
    settle: async () => {
      for (let i = 0; i < 8; i++) await new Promise((r) => setTimeout(r, 4));
    },
    only: (prefix: string) => log.filter((l) => l.startsWith(prefix)),
  };
}
