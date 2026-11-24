// Shared fakes for the renderer harness modules (src/harness/**): an in-memory store with the same
// segment rules as src/store/store.ts, a recording `native` bridge, and React hooks that run as plain
// functions. Import this before importing a harness module; tests set `fx.native.*`, `fx.store.*`
// (overrides of any store export) and `fx.state`, and read what was called from `fx.calls`.
import { mock } from 'node:test';
import { currentFamily } from '../../src/harness/family.ts';
import { touched } from '../../src/lib/chatActivity.ts';
import { installNativeStub } from './ports/native.ts';
import { storeSliceStubs, stubSlice } from './stubs.ts';
export { tick } from './async-scenarios.ts';

const src = (rel: string) => new URL(`../../src/${rel}`, import.meta.url).href;

export const fx = {
  state: {} as any,
  calls: [] as [string, any[]][],
  /** overrides for store exports, by name */
  store: {} as Record<string, any>,
  native: {} as any,
  sessions: {} as Record<string, any>,
  mopilot: { signedIn: false, balanceMicros: null as number | null, modelCaps: null as any },
  caps: { loaded: false, caps: { speed: { state: 'native' } }, provider: null } as any,
  tracked: [] as any[],
  /** cleanups returned by effects and unsubscribes returned by useSyncExternalStore */
  cleanups: [] as (() => void)[],
  /** times a useSyncExternalStore listener was told the store changed */
  notified: 0,
  listeners: new Set<(s: any, prev: any) => void>(),
  /** listeners on the window's session copies (useSessions.subscribe); tell them with sessionsChanged() */
  sessionListeners: new Set<() => void>(),
};

/** Tell useSessions subscribers that fx.sessions changed. */
export const sessionsChanged = () => [...fx.sessionListeners].forEach((l) => l());

export const called = (name: string) => fx.calls.filter((c) => c[0] === name).map((c) => c[1]);

export function baseState(extra: Record<string, any> = {}): any {
  return {
    prefs: {
      claudeBin: null,
      claudeSelection: { model: null, effort: null, fast: false },
      model: null,
      effort: null,
      serviceTier: null,
      permission: 'default',
      limitAsk: {},
      shareUsageData: false,
      visibleEfforts: null,
    },
    home: '/home/me',
    route: { name: 'home' },
    paneTabs: [],
    focused: true,
    claude: { status: { state: 'ready', bin: '/bin/claude', version: '1', plan: null, usage: null }, models: [] },
    claudeUsage: {},
    claudeAccounts: { active: 'default', accounts: [] },
    claudeChats: {},
    claudeArchived: {},
    claudeCatalogs: {},
    threads: {},
    threadOrder: [],
    runtime: {},
    segments: {},
    elsewhere: {},
    pending: [],
    worktreeOf: {},
    chatProject: {},
    savedProjects: [],
    handoffCarry: {},
    basicHarnesses: [],
    accounts: { active: null, accounts: [], chatAccounts: {}, relay: false },
    models: [],
    chatConfig: {},
    config: null,
    newChatTemporary: false,
    ...extra,
  };
}

export function reset(extra: Record<string, any> = {}) {
  fx.state = baseState(extra);
  fx.calls.length = 0;
  for (const k of Object.keys(fx.store)) delete fx.store[k];
  for (const k of Object.keys(fx.native)) delete fx.native[k];
  for (const k of Object.keys(fx.sessions)) delete fx.sessions[k];
  fx.sessionListeners.clear();
  fx.mopilot = { signedIn: false, balanceMicros: null, modelCaps: null };
  fx.caps = { loaded: false, caps: { speed: { state: 'native' } }, provider: null };
  fx.tracked.length = 0;
  fx.cleanups.length = 0;
  fx.notified = 0;
}

const setState = (patch: any) => {
  const prev = fx.state;
  fx.state = { ...prev, ...(typeof patch === 'function' ? patch(prev) : patch) };
  fx.listeners.forEach((l) => l(fx.state, prev));
};

const blankRuntime = () => ({ turns: [], activeTurnId: null, loaded: false, loading: false, error: null, settings: null });

const builtins: Record<string, any> = {
  inheritCodexPin: async () => {},
  flushStreamNotifications: () => {},
  getState: () => fx.state,
  setState,
  patchRuntime: (id: string, fn: (r: any) => any) => {
    const cur = fx.state.runtime[id] ?? blankRuntime();
    setState((s: any) => ({ runtime: { ...s.runtime, [id]: { ...cur, ...fn(cur) } } }));
  },
  chatOf: (nid: string) => Object.entries<any[]>(fx.state.segments).find(([, list]) => list.some((x) => x.nativeId === nid))?.[0] ?? nid,
  nativeOf: (id: string) => fx.state.segments[id]?.at(-1)?.nativeId ?? id,
  chatFamily: (id: string) => currentFamily(fx.state.segments[id], id),
  // a basic harness's chat ('acp:kimi:1') names its kind, as harnessKindOf does
  usageHarnessOf: (id: string) =>
    currentFamily(fx.state.segments[id], id) === 'acp' ? id.split(':').slice(0, 2).join(':') : currentFamily(fx.state.segments[id], id),
  chatHarnessLabel: (id: string) => ({ codex: 'Codex', claude: 'Claude Code', acp: 'Kimi Code' })[currentFamily(fx.state.segments[id], id)],
  newChatFamily: () => fx.state.newChatFamily ?? fx.state.newChatHarness ?? 'codex',
  newTurn: (id: string) => ({ id, status: 'inProgress', items: [], startedAt: 0, completedAt: null, error: null }),
  buildInput: (text: string, attachments: any[] = []) => [{ type: 'text', text, text_elements: [] }, ...attachments],
  provisionalTitle: (text: string) => text.slice(0, 20),
  threadTitle: (t: any) => t?.name || t?.preview || 'New chat',
  selectionAttachment: (text: string) => ({ type: 'selection', text }),
  newChatHarness: () => fx.state.newChatHarness ?? 'codex',
  // a new chat's id, as its family spells one
  startNewChat: async (family: string, o: any) => `${family === 'acp' ? `acp:${o.basic}` : family}:new-${fx.calls.length}`,
  modelChangeNote: () => null,
  // promise-returning store exports answer a promise, as the real ones do
  setGoalState: async () => false,
  sendHeld: async () => {},
  touchChat: (id: string, started?: { text: string }) => setState((s: any) => touched(s, id, Date.now() / 1000, started)),
};

/** A store export: records the call, then runs the test's override or the built-in. */
const storeFn =
  (name: string) =>
  (...args: any[]) => {
    fx.calls.push([name, args]);
    const f = fx.store[name] ?? builtins[name];
    return f ? f(...args) : undefined;
  };

const STORE_NAMES = (
  'getState setState patchRuntime chatOf nativeOf chatFamily usageHarnessOf chatHarnessLabel startNewChat newChatFamily newTurn buildInput provisionalTitle threadTitle selectionAttachment newChatHarness modelChangeNote ' +
  'applyNotification flushStreamNotifications suggestOtherHarness toast toastFailure upsertThread touchChat setDraft openPaneTab accountNote setElsewhere otherAppDone sendHeld unhideFolder rememberChatProject notify navigate replaceChatInView ' +
  'addAccount login pinCodexChat inheritCodexPin removeAccount setChatConfig setPrefs switchAccount setCodexMode copyChatConfig loadGoal revertThread setGoalState withLease ' +
  'openSettings openMachines ensureResumed turnFromServer sendFeedback blockedReason clearGoal editGoal pauseGoal resumeGoal sendMessage setGoalBudget showGoal editClaudeMessage loadOlderTurns'
).split(' ');

const useStore: any = (sel: (s: any) => any) => sel(fx.state);
useStore.subscribe = (l: (s: any, prev: any) => void) => {
  fx.listeners.add(l);
  return () => fx.listeners.delete(l);
};
useStore.getState = () => fx.state;

const STORE = {
  ...Object.fromEntries(STORE_NAMES.map((n) => [n, storeFn(n)])),
  useStore,
  ELSEWHERE_LABEL: { codex: 'Codex', claude: 'Claude Code', other: 'another app' },
};
// the harness runtime imports each name from the slice that owns it: the same stand-ins on every slice the names
// belong to (a test that needs a slice real imports its own copy: tests/approvalLifetime.test.ts)
const SLICES = storeSliceStubs(STORE);
for (const rel of Object.keys(SLICES)) stubSlice(`src/${rel}`, SLICES[rel]);

/** Areas every window's bridge has, for a test that sets only the calls it uses: flags as the build ships them (off). */
const defaults: Record<string, any> = {
  flags: { isEnabled: () => false, onChanged: () => () => {} },
};
/**
 * `native.<area>.<method>`: whatever the test put in fx.native, looked up at call time, over `defaults`; an ACP or
 * Claude area set without onItems (main's translated items, which these tests do not send) subscribes to nothing.
 */
const native = new Proxy(
  {},
  {
    get: (_t, area: string) => {
      const set = fx.native[area] ?? defaults[area];
      return (area === 'acp' || area === 'claude') && set && !set.onItems ? { onItems: () => () => {}, ...set } : set;
    },
  },
);
installNativeStub(native);

mock.module('react', {
  namedExports: {
    useMemo: (f: () => any) => f(),
    useRef: (current: any) => ({ current }),
    useEffect: (f: () => any) => {
      const c = f();
      if (typeof c === 'function') fx.cleanups.push(c);
    },
    useSyncExternalStore: (sub: (cb: () => void) => () => void, get: () => any) => {
      fx.cleanups.push(sub(() => void fx.notified++));
      return get();
    },
  },
});

mock.module(src('store/session/useSession.ts'), {
  namedExports: {
    flushSessionPatches: () => void fx.calls.push(['flushSessionPatches', []]),
    sessionOf: (id: string | null) => fx.sessions[id ?? ''] ?? { goal: null, pendingSwitch: null },
    useSession: (id: string | null) => fx.sessions[id ?? ''] ?? { goal: null, pendingSwitch: null },
    useSessionField: (id: any, pick: any) =>
      pick((((id: string | null) => fx.sessions[id ?? ''] ?? { goal: null, pendingSwitch: null }) as (id: any) => any)(id)),
    useSessions: {
      getState: () => ({ sessions: fx.sessions }),
      subscribe: (l: () => void) => (fx.sessionListeners.add(l), () => fx.sessionListeners.delete(l)),
    },
    ensureSession: (id: string) => fx.calls.push(['ensureSession', [id]]),
  },
});
mock.module(src('store/session/useCaps.ts'), {
  namedExports: { useChatCaps: (...args: any[]) => (fx.calls.push(['useChatCaps', args]), fx.caps) },
});
mock.module(src('lib/mopilot.ts'), { namedExports: { getMoPilot: () => fx.mopilot, useMoPilot: () => fx.mopilot } });
mock.module(src('lib/telemetry.ts'), {
  namedExports: {
    track: (...args: any[]) => fx.tracked.push(args),
    sendRating: (props: any) => fx.tracked.push(['reply_rated', props]),
    shareTurn: (...args: any[]) => fx.calls.push(['shareTurn', args]),
    countTurn: (...args: any[]) => fx.calls.push(['countTurn', args]),
  },
});

/** Change the fake store's state the way the store does, telling its subscribers. */
export const storeSet = (patch: any) => builtins.setState(patch);
