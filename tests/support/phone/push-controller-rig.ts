// Fake runtime, registration and handlers shared by the push controller tests.
import { DEFAULT_PREFS } from '../../../mobile/src/push/prefs';
import { createPushController } from '../../../mobile/src/push/controller';
import { ConnectionCancelled } from '../../../mobile/src/reconnect';

export const defer = <T = void>(): any => {
  let resolve!: (v: T) => void, reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => ((resolve = res), (reject = rej)));
  return { promise, resolve, reject };
};
export const tick = () => new Promise((r) => setImmediate(r));

export function controllerRig(
  over: {
    user?: any;
    phase?: string;
    pairs?: string[];
    step?: any;
    noStatus?: boolean;
    showTest?: () => Promise<void>;
    liveActivity?: any;
    registration?: any;
  } = {},
) {
  const log: string[] = [];
  const listeners = new Set<() => void>();
  const state: any = {
    user: over.user === undefined ? { id: 'u' } : over.user,
    phase: over.phase ?? 'offline',
    pairs: (over.pairs ?? ['p_a']).map((pairId) => ({ pairId, macId: 'm' })),
    selectedPair: null,
  };
  const statusListeners = new Set<(status: any) => void>();
  const chats: Record<string, string[]> = { p_a: ['c1'], p_b: ['c7'] };
  /** The requests the runtime was asked, as `method:offset+limit`. */
  const calls: string[] = [];
  const handlers: any = {};
  const gates: Record<string, Promise<void> | undefined> = {};
  const connectFail = { on: false };
  /** Connections a newer one replaces: each throws what the runtime throws, and when `online` the replacing connection has finished by then. */
  const cancels = { left: 0, online: true };
  const clock = { t: 1_000_000 };
  const reply: { use: boolean; value: unknown } = { use: false, value: undefined };
  let step = over.step ?? 'granted';
  const runtime: any = {
    snapshot: () => state,
    subscribe: (fn: () => void) => (listeners.add(fn), () => listeners.delete(fn)),
    onEvent: (fn: any) => ((handlers.event = fn), () => log.push('off:event')),
    connect: async (pair: string) => {
      log.push(`connect:${pair}`);
      await gates[pair];
      if (cancels.left > 0) {
        cancels.left--;
        if (cancels.online) Object.assign(state, { selectedPair: pair, phase: 'online' });
        throw new ConnectionCancelled();
      }
      if (connectFail.on) throw new Error('Computer is offline');
      state.selectedPair = pair;
      state.phase = 'online';
    },
    request: async (m: string, params?: { limit?: number; offset?: number }) => {
      if (reply.use) return calls.push(`${m}:${params?.offset ?? 0}+${params?.limit ?? 0}`), reply.value;
      const all = [...(chats[state.selectedPair] ?? []).map((id) => ({ id })), { id: 5 }];
      // the Mac's pages: `limit` rows from `offset`, and whether more follow
      const from = params?.offset ?? 0;
      const limit = params?.limit ?? all.length;
      calls.push(`${m}:${from}+${limit}`);
      return { chats: all.slice(from, from + limit), more: from + limit < all.length };
    },
    signOut: async () => void log.push('signOut'),
  };
  const gate = {
    accept: 'granted' as 'granted' | 'denied',
    disable: null as Promise<void> | null,
    saveFails: false,
    forget: null as Promise<void> | null,
    disableFails: false,
    dismiss: null as Promise<void> | null,
    dismissFails: false,
  };
  const prefsBox: { value: any; readFails: boolean; readGate: Promise<void> | null; writeFails: boolean; writeError: unknown } = {
    value: DEFAULT_PREFS,
    readFails: false,
    readGate: null,
    writeFails: false,
    writeError: new Error('keychain full'),
  };
  const ctl = createPushController({
    runtime,
    prefs: {
      read: async () => {
        await prefsBox.readGate;
        if (prefsBox.readFails) throw new Error('keychain locked');
        return prefsBox.value;
      },
      write: async (p: any) => {
        if (prefsBox.writeFails) throw prefsBox.writeError;
        log.push(`prefs:${JSON.stringify(p)}`);
        prefsBox.value = p;
      },
    },
    permission: {
      step: async () => step,
      accept: async () => gate.accept,
      dismiss: async () => {
        log.push('dismiss');
        await gate.dismiss;
        if (gate.dismissFails) throw new Error('keychain locked');
      },
    },
    registration: over.registration ?? {
      enable: async () => void log.push('enable'),
      disable: async (): Promise<void> => {
        log.push('disable');
        await gate.disable;
        if (gate.disableFails) throw new Error('offline');
      },
      sync: async () => void log.push('sync'),
      ...(over.noStatus ? {} : { onStatus: (l: any) => (statusListeners.add(l), () => statusListeners.delete(l)) }),
      forget: async () => {
        log.push('forget');
        await gate.forget;
      },
    },
    titleKeys: {
      prune: async (live: string[]) => void log.push(`prune:${live}`),
      save: async (pair: string, key: Uint8Array) => {
        log.push(`save:${pair}:${key.length}:${key[0]}:${key[31]}`);
        if (gate.saveFails) throw new Error('keychain locked');
      },
    },
    ...(over.showTest ? { showTest: over.showTest } : {}),
    ...(over.liveActivity ? { liveActivity: over.liveActivity } : {}),
    taps: (l) => ((handlers.tap = l), () => log.push('off:tap')),
    pushes: (l) => ((handlers.push = l), () => log.push('off:push')),
    foreground: (l) => ((handlers.fg = l), () => log.push('off:fg')),
    unregisterMs: 20,
    now: () => clock.t,
  });
  const emit = () => listeners.forEach((fn) => fn());
  const setStatus = (status: any) => statusListeners.forEach((l) => l(status));
  return {
    ctl,
    log,
    chats,
    calls,
    state,
    handlers,
    emit,
    setStatus,
    statusListeners,
    gate,
    gates,
    reply,
    prefsBox,
    connectFail,
    cancels,
    clock,
    setStep: (s: any) => (step = s),
  };
}
