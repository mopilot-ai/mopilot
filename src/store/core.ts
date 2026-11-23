// The zustand store itself, toasts, system notifications, prefs, drafts and the thread/turn patch helpers. @store-slice: tests' store stub replaces it whole (tests/support/stubs.ts).

import { deletionVisibility } from './deletionVisibility';
import type { AppState } from './state';
import { create } from 'zustand';
import { toggleMessageBookmark } from '../lib/navigationBookmarks';
import { native } from '../lib/native';
import { errorText, ignoring } from '../lib/ignored';
import { prefixUnits } from '../../shared/textPrefix.mjs';
import { recordValue } from '../../shared/recordProperties.mjs';
import { parseDelegation, stripInjectedContext } from '../lib/format';
import type { NotifyKind, NotifyOptions } from '../lib/notify';
import { codexAgentTurnsChanged } from './codexAgents';
import { setStreamBatch } from '../lib/streamNotifications';
import { touched } from '../lib/chatActivity';
import { NO_SPLIT, visibleChats } from './split';
import {
  DEFAULT_PREFS,
  type Attachment,
  type Prefs,
  type Thread,
  type ThreadItem,
  type ThreadRuntime,
  type Toast,
  type TurnState,
} from './types';

const emptyRuntime = (): ThreadRuntime => ({
  loaded: false,
  loading: false,
  turns: [],
  olderCursor: null,
  activeTurnId: null,
  tokenUsage: null,
  error: null,
  retry: null,
  held: null,
  continueHere: false,
});

export const useStore = create<AppState>(() => ({
  conn: 'connecting',
  connError: null,
  codexHome: null,
  userAgent: null,
  systemUsername: null,
  home: '',
  account: null,
  requiresAuth: false,
  rateLimits: null,
  loginPending: null,
  accounts: { active: null, autoSwitch: true, pool: 'spread', relay: false, login: null, accounts: [] },
  models: [],
  modelsLoaded: false,
  config: null,
  configError: null,
  threads: {},
  threadOrder: [],
  threadsCursor: null,
  archived: [],
  runtime: {},
  pending: [],
  savedProjects: [],
  newChatCloudEnv: null,
  newChatTemporary: false,
  handoffCarry: {},
  cloudTasks: [],
  configWarnings: [],
  newChatProjectId: null,
  projects: [],
  collapsedProjects: {},
  revealedChats: {},
  route: { name: 'home' },
  split: NO_SPLIT,
  back: [],
  forward: [],
  sidebarOpen: true,
  summaryOpen: true,
  shellFit: { sidebar: true, summary: true },
  shellForced: {},
  bottomPanelOpen: false,
  diffPanel: { open: false },
  reviewMarks: {},
  reviewTargets: {},
  paneTabs: [],
  paneActive: '',
  chatPanes: {},
  paneFull: false,
  paneWidth: 0,
  searchOpen: false,
  searchMode: 'all',
  activityView: false,
  focused: true,
  fullscreen: false,
  drafts: {},
  newChatCwd: null,
  newChatHost: null,
  newChatWorktree: null,
  newChatWorktreeHintOff: null,
  newChatHarnessPick: null,
  newChatHarnessRevision: 0,
  newChatBranch: null,
  newChatWorkspace: null,
  toasts: [],
  prefs: DEFAULT_PREFS,
  unread: {},
  pinned: {},
  dark: true,
  codexBin: null,
  codexBinInUse: null,
  worktreeOf: {},
  chatProject: {},
  claude: { status: { state: 'detecting', bin: null, version: null, plan: null, usage: null }, models: [] },
  claudeArchived: {},
  basicHarnesses: [],
  basicListed: false,
  basicSignIns: {},
  flagsRev: 0,
  claudeAccounts: { active: 'default', autoSwitch: true, login: null, accounts: [] },
  claudeUsage: {},
  claudeCatalogs: {},
  claudeChats: {},
  chatNotes: {},
  navigationBookmarks: {},
  chatForkOf: {},
  chatInitialTitles: {},
  momoChats: {},
  momoModels: {},
  authoredInputs: {},
  segments: {},
  elsewhere: {},
  codexRestart: null,
  codexQuit: null,
  migrationIssue: null,
  chatConfig: {},
  codexCompat: null,
  agentTabs: {},
  claudeSite: { signedIn: null, seq: 0 },
}));

const writeState = useStore.setState;
const readState = useStore.getState;
// While a batch runs, writes land on `draft`, which `getState` returns, and subscribers hear of one commit when it ends.
let draft: AppState | null = null;
let batchDepth = 0;
// The runtime map a batch cloned for its first patch: later patches of the same batch fill it in place (see patchRuntime).
let ownedRuntime: AppState['runtime'] | null = null;
useStore.getState = () => draft ?? readState();
useStore.setState = ((partial, replace) => {
  if (!draft) {
    writeState((state) => deletionVisibility.filter(typeof partial === 'function' ? partial(state) : partial), replace as false);
    return;
  }
  const cur = draft;
  const next = deletionVisibility.filter(typeof partial === 'function' ? partial(cur) : partial);
  if (!Object.is(next, cur)) draft = (replace ? next : Object.assign({}, cur, next)) as AppState;
}) as typeof useStore.setState;
/**
 * Runs `run` with its store writes held back: reads inside see them at once, every subscriber hears one commit when `run`
 * ends (also when it throws, so what was applied is never lost). Many chats' deltas then cost one pass of selectors.
 */
export function batchStoreWrites(run: () => void) {
  beginStoreBatch();
  try {
    run();
  } finally {
    endStoreBatch();
  }
}
/** The two halves of batchStoreWrites, for a batch whose start and end arrive as separate events (lib/streamFlush.ts). */
export function beginStoreBatch() {
  if (batchDepth++ === 0) draft = readState();
}
export function endStoreBatch() {
  if (batchDepth === 0) return;
  if (--batchDepth === 0) {
    const done = draft as AppState;
    draft = null;
    ownedRuntime = null;
    if (done !== readState()) writeState(done, true);
  }
}
setStreamBatch(batchStoreWrites);
export const set = useStore.setState;
export const get = useStore.getState;

/* ------------------------------------------------------------------ */
/* toasts                                                              */
/* ------------------------------------------------------------------ */
let toastId = 1;
export function toast(text: string, kind: Toast['kind'] = 'info', opts: { action?: Toast['action']; duration?: number } = {}) {
  const id = toastId++;
  set((s) => ({ toasts: [...s.toasts, { id, text, kind, action: opts.action }] }));
  setTimeout(() => dismissToast(id), opts.duration ?? (opts.action ? 8000 : 3200));
}
/**
 * A rejection handler for something the user asked for: `rename().catch(toastFailure("Couldn't rename the project"))`
 * shows "Couldn't rename the project: <why>" instead of letting the click do nothing.
 */
export function toastFailure(what: string): (error: unknown) => void {
  return (error) => toast(`${what}: ${errorText(error)}`, 'error');
}
export function dismissToast(id: number) {
  set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

/** Every system notification goes through here; Settings → Notifications is applied in the main process. */
export function notify(kind: NotifyKind, chatId: string, opts: NotifyOptions) {
  const s = get();
  const active = s.diffPanel.open ? s.paneTabs.find((t) => t.id === s.paneActive) : null;
  // a chat any pane of this window shows counts as looked at, not only the focused one
  const viewing = visibleChats(s).includes(chatId) || (active?.kind === 'chat' && active.threadId === chatId);
  native.app
    .notify(kind, chatId, { chatTitle: threadTitle(s.threads[chatId]), ...opts, viewing: viewing && s.focused })
    // a notification is a heads-up: the chat shows the same state
    .catch(ignoring(`show a ${kind} notification`));
}

export function setPrefs(p: Partial<Prefs>) {
  set((s) => ({ prefs: { ...s.prefs, ...p } }));
  // the app's colors follow the pref already; this sets the native theme (title bar, menus)
  if (p.theme) native.app.setTheme(p.theme).catch(ignoring('apply the theme to the window chrome'));
}

export function toggleNavigationBookmark(chatId: string, messageId: string) {
  set((s) => ({ navigationBookmarks: toggleMessageBookmark(s.navigationBookmarks, chatId, messageId) }));
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */
export function patchRuntime(threadId: string, fn: (r: ThreadRuntime) => Partial<ThreadRuntime>) {
  set((s) => {
    const r = s.runtime[threadId] ?? emptyRuntime();
    const next = { ...r, ...fn(r) };
    // a batch clones the map once, then fills it in place: only its own clone, not yet published, is ever changed
    if (draft && s.runtime === ownedRuntime) {
      s.runtime[threadId] = next;
      return { runtime: s.runtime };
    }
    const runtime = { ...s.runtime, [threadId]: next };
    if (draft) ownedRuntime = runtime;
    return { runtime };
  });
  // a sub-agent's child thread streams into its agent page
  codexAgentTurnsChanged(threadId, get().runtime[threadId].turns);
}

export function patchTurn(threadId: string, turnId: string, fn: (t: TurnState) => Partial<TurnState>) {
  patchRuntime(threadId, (r) => {
    // a delta almost always extends the latest turn: look from the end, and copy the list once, replacing one slot
    let at = r.turns.length - 1;
    while (at >= 0 && r.turns[at].id !== turnId) at--;
    const turns = r.turns.slice();
    if (at >= 0) turns[at] = { ...turns[at], ...fn(turns[at]) };
    else {
      const t = newTurn(turnId);
      turns.push({ ...t, ...fn(t) });
    }
    return { turns };
  });
}

/** An item a streamed delta extends: whichever of these fields its type has. */
type StreamedItem = {
  id: string;
  text?: string;
  summary?: string[];
  content?: string[];
  aggregatedOutput?: string | null;
  [key: string]: unknown;
};
export function patchItem(threadId: string, turnId: string, itemId: string, fn: (it: StreamedItem) => StreamedItem) {
  patchTurn(threadId, turnId, (t) => {
    // the streaming item is the last one in nearly every case: look from the end, replace one slot
    let at = t.items.length - 1;
    while (at >= 0 && t.items[at].id !== itemId) at--;
    if (at < 0) return { items: t.items };
    const items = t.items.slice();
    items[at] = fn(items[at] as StreamedItem) as ThreadItem;
    return { items };
  });
}

/**
 * A streamed delta as one store commit: the item is added from `base` when the turn lacks it (null: a delta for an
 * item that is not there changes nothing), then extended by `fn`.
 */
export function patchStreamedItem(
  threadId: string,
  turnId: string,
  itemId: string,
  base: { type: string; [key: string]: unknown } | null,
  fn: (it: StreamedItem) => StreamedItem,
) {
  patchTurn(threadId, turnId, (t) => {
    // the streaming item is the last one in nearly every case: look from the end, replace one slot
    const patch = (items: ThreadItem[]) => {
      let at = items.length - 1;
      while (at >= 0 && items[at].id !== itemId) at--;
      if (at < 0) return items;
      const next = items.slice();
      next[at] = fn(items[at] as StreamedItem) as ThreadItem;
      return next;
    };
    if (!base || t.items.some((i) => i.id === itemId)) return { items: patch(t.items) };
    return {
      items: patch([...t.items, { ...base, id: itemId } as ThreadItem]),
      itemTimes: { ...t.itemTimes, [itemId]: { start: Date.now() } },
    };
  });
}

export function newTurn(id: string): TurnState {
  return {
    id,
    status: 'inProgress',
    items: [],
    startedAt: Date.now() / 1000,
    completedAt: null,
    durationMs: null,
    error: null,
    itemTimes: {},
  };
}

export function upsertThread(t: Thread, bump = false) {
  set((s) => {
    const prev = s.threads[t.id];
    const merged = prev ? { ...prev, ...t, turns: [] } : { ...t, turns: [] };
    const order = s.threadOrder.includes(t.id)
      ? bump
        ? [t.id, ...s.threadOrder.filter((x) => x !== t.id)]
        : s.threadOrder
      : [t.id, ...s.threadOrder];
    return { threads: { ...s.threads, [t.id]: merged }, threadOrder: order };
  });
}

/** Activity in a chat now: it moves up the sidebar (lib/chatActivity.ts). */
export function touchChat(chatId: string, started?: { text: string }) {
  set((s) => touched(s, chatId, Date.now() / 1000, started));
}

export function threadTitle(t: Thread | undefined | null, initialTitles = get().chatInitialTitles) {
  if (!t) return 'New chat';
  if (t.name) return t.name;
  const initial = recordValue(initialTitles, t.id);
  if (initial) return initial;
  const preview = stripInjectedContext(t.preview || '');
  const d = preview ? parseDelegation(preview) : null;
  return (d ? d.input && firstLine(d.input) : firstLine(preview)) || 'New chat';
}
/** The first non-blank line, at most 120 units and never ending in half of an emoji (the title goes into @-mentions). */
function firstLine(s: string) {
  return prefixUnits(
    (s || '')
      .split('\n')
      .find((l) => l.trim())
      ?.trim() ?? '',
    120,
  );
}

/* ------------------------------------------------------------------ */
/* drafts                                                              */
/* ------------------------------------------------------------------ */
export function setDraft(key: string, d: { text: string; attachments: Attachment[]; goal?: boolean }) {
  const previous = get().drafts[key];
  set((s) => ({ drafts: { ...s.drafts, [key]: d } }));
  if (d.attachments.some((a) => a.kind === 'audio') || previous?.attachments.some((a) => a.kind === 'audio'))
    native.speech.draft(key, d).catch((e) => toast(`Could not save audio draft: ${errorText(e)}`, 'error'));
}
