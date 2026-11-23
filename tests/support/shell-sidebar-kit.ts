// Sidebar test kit: an in-memory store, inert native bridge and lightweight Popover/Menu stand-ins,
// installed with mock.module before the real Sidebar module is imported.
import { mock } from 'node:test';
import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
import { window } from './dom.ts';
import { createElement as h, act, createContext, useContext, useEffect, useReducer, useState, useCallback, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { installNativeStub } from './ports/native.ts';
import { installedNative } from '../../src/lib/native.ts';
import { stubStore } from './stubs.ts';

// mock.module tags a mocked URL with ?node-test-mock=N, hiding .tsx from tests/support/register.ts; strip
// the tag so a mocked .tsx still loads (its source is replaced). Must run before the first mock.module.
registerHooks({
  load(url, context, next) {
    const u = new URL(url);
    if (u.protocol === 'file:' && u.pathname.endsWith('.tsx') && u.searchParams.has('node-test-mock'))
      return next(url.split('?')[0], context);
    return next(url, context);
  },
});

export const calls: any[][] = [];
const listeners = new Set<() => void>();
let state: any;

export function baseState(over: Record<string, any> = {}) {
  return {
    threads: {},
    threadOrder: [],
    savedProjects: [],
    worktreeOf: {},
    segments: {},
    home: '/home',
    route: { name: 'home' },
    collapsedProjects: {},
    revealedChats: {},
    pinned: {},
    activityView: false,
    newChatProjectId: undefined,
    newChatCwd: null,
    pending: [],
    unread: {},
    runtime: {},
    agentTabs: {},
    elsewhere: {},
    cloudTasks: [],
    ...over,
    prefs: { chatOrder: {}, ...(over.prefs ?? {}) },
  };
}
export const getState = () => state;
export function setFixture(next: any) {
  state = next;
  listeners.forEach((l) => l());
}
/** Replace the store state inside act, as a store update from elsewhere in the app. */
export const update = (next: any) => act(async () => setFixture(next));
const merge = (patch: any) => setFixture({ ...state, ...(typeof patch === 'function' ? patch(state) : patch) });
setFixture(baseState());

/** Behaviour switches the store and native stand-ins read. */
export const fx = {
  createProject: 'p-new' as string | null,
  openFolder: null as string | null,
  exists: true,
  popup: null as string | null,
  renameError: null as any,
  /** false: setPrefs is recorded but not applied, as when persistence lags behind. */
  applyPrefs: true,
  archiveError: null as any,
  popupItems: [] as any[],
  /** what an `answers` call throws, by its recorded name */
  fail: {} as Record<string, unknown>,
  /** linked sessions main reports (native.orchestration.snapshot), and how to tell the windows of a change */
  orchestration: undefined as any,
  /** Claude desktop's side-session links main reports (native.claude.desktopLineage), by session id */
  desktopLineage: {} as Record<string, { parentId: string; createdAt: number }>,
  orchestrationChanged: (_view: any) => {},
  canonicalPaths: null as null | ((paths: string[]) => Promise<Record<string, string>>),
  repositories: {} as Record<string, string>,
  folderAvailability: null as null | ((paths: string[]) => Promise<Record<string, boolean | null>>),
};

function useStore(selector: (s: any) => any) {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => {
    listeners.add(force);
    return () => void listeners.delete(force);
  }, []);
  return selector(state);
}

/**
 * Where the new chat goes, from the state as store/projects.ts newChatGoal decides it (its own test: homeTarget.test.ts): a
 * machine's folder, a folder outside any project, the picked project, else the newest chat's project, else the first saved.
 */
function goal(s: any): any {
  if (s.newChatProjectId == null && s.newChatCwd == null && s.newChatHost) return { kind: 'machine', pick: s.newChatHost };
  if (s.newChatCwd && s.newChatProjectId == null) return { kind: 'folder', path: s.newChatCwd };
  if (s.newChatProjectId === 'none') return null;
  const projects: any[] = s.savedProjects ?? [];
  const newest = (s.threadOrder ?? []).map((id: string) => projects.find((p) => p.id === s.threads?.[id]?.projectId)).find(Boolean);
  const project = projects.find((p) => p.id === s.newChatProjectId) ?? newest ?? projects[0];
  return project ? { kind: 'project', project } : null;
}
const record =
  (name: string) =>
  (...args: any[]) =>
    void calls.push([name, ...args]);
/** A native call or store action that answers later: it fails with fx.fail[name] when that is set. */
const answers =
  (name: string, value?: unknown) =>
  async (...args: any[]) => {
    calls.push([name, ...args]);
    if (fx.fail[name] !== undefined) throw fx.fail[name];
    return value;
  };
stubStore({
  useStore,
  getState,
  chatOf: (id: string) => id,
  navigate: (route: any) => {
    calls.push(['navigate', route]);
    merge({ route });
  },
  openInSplit: (id: string) => calls.push(['openInSplit', id]),
  threadTitle: (t: any) => t.name || t.preview || 'New chat',
  archiveThread: async (id: string) => {
    calls.push(['archive', id]);
    if (fx.archiveError !== null) throw fx.archiveError;
  },
  renameThread: async (id: string, name: string) => {
    calls.push(['renameThread', id, name]);
    if (fx.renameError !== null) throw fx.renameError;
  },
  forkThread: answers('fork'),
  deleteThread: answers('delete'),
  currentCwdForNewChat: () => null,
  projectForThread: (t: any, projects: any[]) => projects.find((p) => p.id === t.projectId) ?? null,
  newChatProject: (s: any = state) => (goal(s)?.kind === 'project' ? goal(s).project : null),
  newChatHostPick: (s: any = state) => (goal(s)?.kind === 'machine' ? goal(s).pick : null),
  newChatGoal: (s: any = state) => goal(s),
  setNewChatHostFolder: record('setNewChatHostFolder'),
  deleteProject: answers('deleteProject'),
  renameProject: answers('renameProject'),
  moveProject: async (...args: any[]) => void calls.push(['moveProject', ...args]),
  createProject: async (path: string) => {
    calls.push(['createProject', path]);
    return fx.createProject;
  },
  setState: (patch: any) => {
    calls.push(['setState', typeof patch === 'function' ? patch(state) : patch]);
    merge(patch);
  },
  setPrefs: (patch: any) => {
    calls.push(['setPrefs', patch]);
    if (fx.applyPrefs) merge({ prefs: { ...state.prefs, ...patch } });
  },
  toast: record('toast'),
  toastFailure: (what: string) => (e: any) => calls.push(['toast', `${what}: ${e?.message ?? e}`, 'error']),
  segmentNatives: (segs: Record<string, { nativeId: string }[]>) =>
    new Set(Object.entries(segs).flatMap(([chat, list]) => list.map((s) => s.nativeId).filter((n) => n !== chat))),
  nativeOf: (id: string) => id,
  ELSEWHERE_LABEL: { 'claude-desktop': 'Claude desktop', sage: 'another window' },
  clearNewChatProject: record('clearNewChatProject'),
  pickNewChatHarness: (kind: string) => merge({ newChatHarnessPick: kind }),
  openPaneTab: record('openPaneTab'),
});

// a test's sessions name only what it needs: each gets the session's empty lists and idle turn, once per sessions object
const NO_SESSIONS = {};
const fullSessions = new WeakMap<object, Record<string, any>>();
const withTasks = (all: Record<string, any>) => {
  let full = fullSessions.get(all);
  if (!full)
    fullSessions.set(
      all,
      (full = Object.fromEntries(
        Object.entries(all).map(([id, v]) => [id, { rev: 0, turn: 'idle', approvals: [], questions: [], tasks: [], ...v }]),
      )),
    );
  return full;
};
mock.module('../../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: (id: string) => useStore((s) => ({ rev: 0, turn: 'idle', approvals: [], questions: [], tasks: [], ...s.sessions?.[id] })),
    useSessionField: (id: any, pick: any) =>
      pick(
        (
          ((id: string) => useStore((s) => ({ rev: 0, turn: 'idle', approvals: [], questions: [], tasks: [], ...s.sessions?.[id] }))) as (
            id: any,
          ) => any
        )(id),
      ),
    useSessionLoaded: () => true,
    refreshSession: async () => {},
    useSessions: (select: any) => useStore((s) => select({ sessions: withTasks(s.sessions ?? NO_SESSIONS) })),
    ensureSession: (id: string) => calls.push(['ensureSession', id]),
  },
});
mock.module('../../src/session/voice.ts', {
  namedExports: { useVoice: (selector: any) => useStore((s) => selector(s.voice ?? { threadId: null, phase: 'idle' })) },
});

installNativeStub({
  // a platform the test installed before loading this kit (Windows' Control hints) stays
  platform: installedNative()?.platform,
  flags: { isEnabled: () => false, onChanged: () => () => {} },
  app: { installed: async () => ({ finder: true }), icon: async () => null },
  git: { sidebarRepository: async (path: string) => fx.repositories[path] ?? null },
  projects: {
    canonicalPaths: async (paths: string[]) => fx.canonicalPaths?.(paths) ?? Object.fromEntries(paths.map((p) => [p, p])),
    folderAvailability: async (paths: string[]) => {
      calls.push(['folderAvailability', paths]);
      return fx.folderAvailability?.(paths) ?? Object.fromEntries(paths.map((p) => [p, fx.exists]));
    },
  },
  dialog: { openFolder: async () => fx.openFolder },
  fs: { exists: async (p: string) => (calls.push(['exists', p]), fx.exists) },
  shell: { openPath: answers('openPath', ''), reveal: answers('reveal') },
  clipboard: { write: answers('clipboard') },
  menu: {
    popup: async (items: any[]) => {
      fx.popupItems = items;
      return fx.popup;
    },
  },
  win: { mini: answers('mini'), open: answers('winOpen') },
  claude: { desktopLineage: async () => fx.desktopLineage },
  orchestration: {
    child: answers('orchestrationChild', { detached: true }),
    snapshot: async () => fx.orchestration,
    onChanged: (cb: (view: any) => void) => {
      fx.orchestrationChanged = cb;
      return () => {};
    },
  },
});

mock.module('../../src/harness/types.ts', {
  namedExports: {
    cliSessionId: (id: string) => `cli-${id}`,
    claudeThreadId: (id: string) => `claude-${id}`,
    hasThreadPullRequest: (id: string) => id.startsWith('pr-'),
  },
});
mock.module('../../src/harness/registry.ts', {
  namedExports: {
    resumeCommandFor: (id: string) => (id.startsWith('claude-') ? `claude --resume ${id}` : null),
  },
});

mock.module('../../src/session/pullRequestReader.ts', {
  namedExports: { readPullRequest: Object.assign(async () => null, { known: () => undefined }) },
});

const MenuClose = createContext<() => void>(() => {});
const span = (props: Record<string, any>, children?: ReactNode) => h('span', props, children);
mock.module('../../src/components/ui/Popover.tsx', {
  namedExports: {
    useAnchor() {
      const [anchor, setAnchor] = useState<HTMLElement | null>(null);
      const [open, setOpen] = useState(false);
      const toggle = useCallback(() => setOpen((o) => !o), []);
      const close = useCallback(() => setOpen(false), []);
      return { ref: setAnchor, anchor, open, setOpen, toggle, close };
    },
    Menu: ({ open, onClose, children }: any) =>
      open
        ? h(
            MenuClose.Provider,
            { value: onClose },
            h('div', { 'data-menu': true }, children, h('button', { 'data-close': true, onClick: onClose })),
          )
        : null,
    Popover: ({ open, onClose, children }: any) =>
      open ? h('div', { 'data-popover': true }, children, h('button', { 'data-close': true, onClick: onClose })) : null,
    MenuItem({ onSelect, checked, danger, disabled, hint, title, children }: any) {
      const close = useContext(MenuClose);
      const select = () => {
        onSelect();
        close();
      };
      return h(
        'button',
        {
          'data-item': true,
          'data-checked': checked === undefined ? undefined : String(checked),
          'data-danger': danger ? 'true' : undefined,
          disabled,
          title,
          onClick: select,
        },
        children,
        hint ? span({ className: 'menu-hint' }, hint) : null,
      );
    },
    SubMenu: ({ label, children }: any) => h('div', { 'data-submenu': label }, children),
    MenuSeparator: () => h('hr'),
    MenuLabel: ({ children }: any) => span({}, children),
    Tooltip: ({ label, children }: any) => span({ 'data-tooltip': label }, children),
  },
});
mock.module('../../src/components/ui/Presence.tsx', {
  namedExports: {
    Collapse: ({ open, children }: any) => (open ? h('div', { className: 'collapse open' }, children) : null),
    usePresence: () => ({ mounted: true, leaving: false }),
  },
});
mock.module('../../src/components/harnessPicker/HarnessPicker.tsx', {
  namedExports: { ThreadHarnessBadge: ({ threadId }: any) => span({ 'data-harness': threadId }) },
});
mock.module('../../src/components/sidebar/ThreadPullRequestBadge.tsx', {
  namedExports: { ThreadPullRequestBadge: ({ threadId, cwd }: any) => span({ 'data-pr': threadId, 'data-pr-cwd': cwd }) },
});
mock.module('../../src/components/thread/GoalBar.tsx', { namedExports: { GoalMark: () => null } });
mock.module('../../src/components/sidebar/MigrationBanner.tsx', { namedExports: { MigrationBanner: () => null } });
mock.module('../../src/components/sidebar/MoreChats.tsx', { namedExports: { MoreChats: () => span({ 'data-more-chats': true }) } });
// the account footer has its own test (tests/sidebarFooterUI.test.ts); here it only has to be there
mock.module('../../src/components/sidebar/SidebarFooter.tsx', {
  namedExports: { SidebarFooter: () => span({ 'data-sidebar-footer': true }) },
});

export const Sidebar = await import('../../src/components/sidebar/Sidebar.tsx');

export function reset(over: Record<string, any> = {}) {
  calls.length = 0;
  Object.assign(fx, {
    createProject: 'p-new',
    openFolder: null,
    exists: true,
    popup: null,
    renameError: null,
    archiveError: null,
    popupItems: [],
    applyPrefs: true,
    fail: {},
    orchestration: undefined,
    desktopLineage: {},
    canonicalPaths: null,
    folderAvailability: null,
    repositories: {},
  });
  setFixture(baseState(over));
}

export async function render(el: any) {
  const host = document.createElement('div');
  document.body.append(host);
  const root: Root = createRoot(host as any);
  await act(async () => root.render(el));
  return {
    host,
    root,
    $: (sel: string) => host.querySelector(sel) as HTMLElement,
    $$: (sel: string) => [...host.querySelectorAll(sel)] as HTMLElement[],
    async unmount() {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

export const flush = () =>
  act(async () => {
    await new Promise((r) => setImmediate(r));
  });
export const click = (el: Element) =>
  act(async () => {
    (el as HTMLElement).click();
  });
export const fire = (el: Element, ev: Event) =>
  act(async () => {
    el.dispatchEvent(ev);
  });
export const key = (el: Element, k: string, init: Record<string, any> = {}) =>
  fire(el, new window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }) as any);
export const mouse = (el: Element, type: string, init: Record<string, any> = {}) =>
  fire(el, new window.MouseEvent(type, { bubbles: true, cancelable: true, ...init }) as any);
export const pointer = (el: Element, type: string, init: Record<string, any> = {}) =>
  fire(el, new window.PointerEvent(type, { bubbles: true, cancelable: true, ...init }) as any);
export const blur = (el: Element) => fire(el, new window.FocusEvent('focusout', { bubbles: true }) as any);
export const focus = (el: Element) => fire(el, new window.FocusEvent('focusin', { bubbles: true }) as any);

/** A drag event carrying a fake DataTransfer; returns it so a test can read what was set. */
export async function drag(el: Element, type: string, { types = [] as string[], data = {} as Record<string, string>, clientY = 0 } = {}) {
  const dt = {
    types,
    effectAllowed: '',
    dropEffect: '',
    setData(k: string, v: string) {
      data[k] = v;
    },
    getData: (k: string) => data[k] ?? '',
  };
  const ev = new window.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dt });
  Object.defineProperty(ev, 'clientY', { value: clientY });
  await fire(el, ev as any);
  return { dt, data, defaultPrevented: ev.defaultPrevented };
}

export const thread = (id: string, over: Record<string, any> = {}) => ({ id, name: `Chat ${id}`, cwd: '/work/a', updatedAt: 10, ...over });
export const project = (id: string, path = `/work/${id}`, name = id) => ({ id, name, roots: [{ path }] });

/* -- helpers the sidebar tests share ---------------------------------------- */
export const { useProjectGroups, ThreadRow, ThreadMenu } = Sidebar;
export const named = (name: string) => calls.filter((c) => c[0] === name).map((c) => c.slice(1));
export const prefsCalls = () => named('setPrefs').map(([p]) => p);
export const mountSidebar = () =>
  render(h(Sidebar.Sidebar, { width: 280, onWidthChange: (w: number) => void calls.push(['width', w]) as any } as any));
export const byText = (root: ParentNode, sel: string, text: string) => {
  const el = [...root.querySelectorAll(sel)].find((e) => e.textContent!.trim() === text);
  assert.ok(el, `no ${sel} with text ${text}`);
  return el as HTMLElement;
};
export const label = (g: { id: string | null; path: string }) => g.id ?? g.path;

export async function probe() {
  let result: any;
  function Probe() {
    result = useProjectGroups();
    return null;
  }
  const view = await render(h(Probe));
  return { get: () => result, view };
}
