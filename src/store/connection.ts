// The Codex connection, and loading accounts, models, config, threads and archives. @store-slice: tests' store stub replaces it whole (tests/support/stubs.ts).

import { deletionVisibility } from './deletionVisibility';
import { createConfigLoader } from './config';
import { codexIsIdle } from '../harness/adapters/codex';
import { codexApi } from '../harness/adapters/codexApi';
import { archivedCodexThreads } from './archivedCodex';
import { beginArchiveRead, beginThreadVisibilityRead } from './archiveOwnership';
import { refreshCodexUsage } from '../harness/refreshCodexUsage';
import { native, type CodexEvent } from '../lib/native';
import { errorText, ignoring, noteIgnored } from '../lib/ignored';
import type { Thread } from './types';
import { HARNESS_IDS, HARNESS_LABEL, isAcpThread, isCodexThread, type HarnessId } from '../harness/types';
import type { HarnessKind } from '../harness/adapter';
import { harnessLabelOf } from '../harness/registry';
import { codexQuitText, codexSwitchedText } from '../harness/codexQuit';
import { userError } from '../../shared/userError.mjs';
import { identityKey } from '../../shared/identityKey.mjs';
import { HARNESS_TRAITS } from '../harness/family';
import type { GetAccountRateLimitsResponse } from '../protocol/v2/GetAccountRateLimitsResponse';
import { get, set, toast, patchRuntime } from './core';
import { chatFamily, nativeOf, setDefaultHarness } from './chats';
import { showThread } from './threads';
import { codexDown, reloadFromCodex } from './codexDisk';
import { onScreenNow } from './notifications';
import { syncCodexProjects } from './projects';
import { loadCloudTasks, syncImports } from './send';
import { refreshAccountsUsage } from './accounts';
import { visibleChats } from './split';
import { momoOwned } from '../lib/momoChats';
import { runtime } from './runtime';
import { launchMark } from '../lib/launchMarks';
import { confirmList, settleList } from './sidebarSnapshot';

/** Start Codex now if it was left for first use. */
export function ensureCodex() {
  if (get().conn === 'idle') return connect();
}
/** Listing a harness is its first use: Codex starts if it was left idle; Claude Code is detected at launch. */
const ENSURE: Record<HarnessId, () => Promise<void> | undefined> = {
  codex: ensureCodex,
  claude: () => undefined,
};
export const ensureHarness = (h: HarnessId) => ENSURE[h]();
/**
 * The user picks what new chats start on. Picking a first-tier harness left for first use is its first use: it starts,
 * so the default resolves to it rather than to the other harness while it sits idle.
 */
export function chooseDefaultHarness(kind: HarnessKind) {
  setDefaultHarness(kind);
  const first = HARNESS_IDS.find((h) => h === kind);
  if (first) void ensureHarness(first);
}
codexIsIdle(() => get().conn === 'idle');

let accountRead = 0;
let limitsOwner = 0;
let limitsRead = 0;
let lastPublishedLimitsRead = 0;

export function onCodexStatus(e: CodexEvent) {
  switch (e.kind) {
    case 'exit':
    case 'error': {
      ++accountRead;
      ++limitsOwner;
      const connError = e.kind === 'exit' ? `Codex app-server exited (${e.code ?? e.signal}).\n${e.stderr}` : e.error;
      // a copy that quit as it started is named until one connects
      const quit = e.copy ? { codexQuit: { copy: e.copy, pinned: !!e.pinned } } : {};
      // main brings a crashed Codex back by itself: the app stays as it is meanwhile
      return set(e.restarting ? { connError, ...quit } : { conn: 'error', connError, ...quit });
    }
    case 'switched':
      // main moved to the next installed copy, and starts it now
      set({ codexBinInUse: e.to.path, codexQuit: null });
      return toast(codexSwitchedText(e.from, e.to));
    case 'restarting':
      return set({ codexRestart: { attempt: e.attempt, inMs: e.inMs } });
    case 'started':
      // something started Codex while this window left it idle
      return void ensureCodex();
    case 'ready':
      // main brought Codex back: load what it knows again
      set({ codexRestart: null, codexQuit: null });
      return void connect(true);
    case 'gaveUp':
      return set({
        conn: 'error',
        codexRestart: 'gaveUp',
        ...(e.copy ? { codexQuit: { copy: e.copy, pinned: !!e.pinned } } : {}),
      });
  }
}

/**
 * The chat's harness quit mid-turn (A23): its turn ends showing why, its approval cards go away, and
 * what was queued stays queued until the user sends it.
 */
export function onCrashed(chatId: string, why: string | null) {
  set((s) => ({
    pending: s.pending.filter((p) => p.threadId !== chatId),
    // nothing will say the thread went idle: it went with the harness
    threads: s.threads[chatId]
      ? {
          ...s.threads,
          [chatId]: { ...s.threads[chatId], status: { type: 'idle' } },
        }
      : s.threads,
  }));
  const rt = get().runtime[chatId];
  const turn = rt?.turns.find((t) => t.id === rt.activeTurnId) ?? (rt?.turns.at(-1)?.status === 'inProgress' ? rt.turns.at(-1) : undefined);
  // no turn to mark: the chat refused one (a remote switch turned its harness off), so say why; but not again when the
  // message that was refused already shows this reason as a failed turn (the send's answer got there first)
  if (!rt || !turn) {
    const last = rt?.turns.at(-1);
    if (why && last?.id.startsWith('pending-') && last.status === 'failed' && last.error?.message === why) return;
    if (why) {
      patchRuntime(chatId, () => ({ error: why, errorFromRead: false }));
      toast(why, 'error');
    }
    return;
  }
  patchRuntime(chatId, (r) => ({
    turns: r.turns.map((t) =>
      t.id === turn.id
        ? {
            ...t,
            status: t.status === 'inProgress' ? 'failed' : t.status,
            error: { message: why ?? 'The harness quit while working' },
          }
        : t,
    ),
    activeTurnId: null,
    retry: null,
  }));
}

/** The restart under way: a second click (another Retry, the banner) joins it rather than reading a Codex still down. */
let restarting: Promise<void> | null = null;

/**
 * Before a chat with a Codex part is read again (its Retry): a Codex that is down is restarted now, since every read of
 * it fails at once until then. It rejects with why, in short, when Codex still isn't connected.
 */
export async function restartCodexIfDown() {
  if (!restarting && !codexDown()) return;
  await restartCodex();
  // its exit code and stderr stay in connError, for Settings, bug reports and the chat's Copy crash output; a copy that
  // quit as it started is named
  if (get().conn === 'ready') return;
  const quit = get().codexQuit;
  throw new Error(quit ? codexQuitText(quit) : userError(get().connError, { who: HARNESS_LABEL.codex }));
}

/**
 * Start Codex's app-server again and connect to it: the chat's Retry, the banner's Restart Codex, Codex's Retry. A start
 * that fails leaves the connection's status saying why (conn 'error'); only a restart main refused rejects.
 */
export function restartCodex(): Promise<void> {
  restarting ??= (async () => {
    set({ codexRestart: null });
    await native.codex.restart();
    await connect();
  })().finally(() => (restarting = null));
  return restarting;
}

/** `quiet`: Codex came back after a crash, so the app stays on screen while it reloads. */
export async function connect(quiet = false) {
  set(quiet ? { connError: null } : { conn: 'connecting', connError: null });
  try {
    const { bin } = await native.codex.start();
    set({ codexBinInUse: bin });
    // main initializes the app-server once per process (and gives up on one that never answers)
    const init = await native.codex.connect();
    // Point the app-server at the active account before anything reads it.
    set({
      accounts: await native.accounts.apply().catch(() => native.accounts.list()),
    });
    set({
      conn: 'ready',
      codexHome: init.codexHome,
      userAgent: init.userAgent,
      codexQuit: null,
    });
    native.codex.negotiated().then(
      (n) => set({ codexCompat: n }),
      () => {
        /* compatibility stays unknown, which blocks nothing */
      },
    );
  } catch (e) {
    // keep the app-server's own error (spawn failure, exit) when it already reported one
    set({ conn: 'error', connError: get().connError ?? errorText(e) });
    settleList('codex');
    return;
  }
  // Models and unpooled quota need the account in use. Managed quota reads use their own logins.
  const account = readAccount();
  const quota = get().accounts.accounts.length ? refreshRateLimits() : account.then(refreshRateLimits);
  void account.then(loadCloudTasks);
  const threads = loadThreads().finally(() => {
    // Once chat metadata is available, read the visible histories while the other startup reads are still running.
    for (const id of visibleChats(get())) showThread(id);
    reloadFromCodex(onScreenNow(), showThread);
  });
  await Promise.allSettled([account.then(loadModels), loadConfig(), threads, quota]);
  // in the background: the list is already shown from projects.json
  syncCodexProjects().catch(ignoring("import Codex's projects after connecting"));
  syncImports().catch(ignoring('re-import the sources kept in sync after connecting'));
}

const codexAccountKey = (account: ReturnType<typeof get>['account']) =>
  account?.type === 'chatgpt' ? identityKey(account.type, account.email ?? null, account.planType ?? null) : (account?.type ?? null);

/** Read the Codex account and retire any quota reading that described the previous login. */
async function readAccount(): Promise<'same' | 'changed' | null> {
  const request = ++accountRead;
  try {
    const r = await codexApi.accountRead();
    if (request !== accountRead) return null;
    const previous = get();
    const changed = codexAccountKey(previous.account) !== codexAccountKey(r.account);
    if (changed) ++limitsOwner;
    // With saved accounts, an expired sign-in is handled by the re-verify banner, not the Login page.
    set({
      account: r.account,
      requiresAuth: r.requiresOpenaiAuth && !r.account && !previous.accounts.accounts.length,
      ...(changed ? { rateLimits: null } : {}),
    });
    return changed ? 'changed' : 'same';
  } catch (error) {
    // the account stays as last read; account/updated asks again
    noteIgnored('read the Codex account', error);
    return null;
  }
}
export async function refreshAccount() {
  // another account (a switch, a sign-in, a plan change) may be offered other models
  const result = await readAccount();
  if (result) {
    void refreshModels();
    void loadCloudTasks();
  }
  if (result === 'changed' && get().conn === 'ready') void refreshRateLimits();
}
export async function refreshRateLimits() {
  const owner = limitsOwner;
  const request = ++limitsRead;
  const active = get().accounts.active;
  return refreshCodexUsage({
    readRateLimits: () => codexApi.accountRateLimits(),
    setRateLimits: (rateLimits) => {
      if (owner !== limitsOwner || request <= lastPublishedLimitsRead || active !== get().accounts.active) return;
      lastPublishedLimitsRead = request;
      set({ rateLimits: rateLimits as GetAccountRateLimitsResponse });
    },
    hasManagedAccounts: () => get().accounts.accounts.length > 0,
    refreshAccounts: () => refreshAccountsUsage(),
  });
}

/** A model list read this recently is not asked for again when a list opens; one for another account always is. */
export const MODELS_FRESH_MS = 60_000;
/** Who the model list is for: the account in use decides which models Codex offers (its sign-in kind, its plan). */
const modelsAccount = () => JSON.stringify([get().accounts.active, get().account]);
/** The last model/list asked for: the account it was for, when it last answered (0: not since it failed), the read under way. */
let modelsRead: { account: string; at: number; pending: Promise<void> | null } | null = null;
/** Each read's number: only the newest one's answer is kept, so a read for an account switched away from never lands. */
let modelsSeq = 0;

/** Read Codex's model list now. It never rejects: a failed read keeps the list as last loaded. */
export function loadModels(): Promise<void> {
  const seq = ++modelsSeq;
  const account = modelsAccount();
  const settle = (at: number) => (modelsRead = { account, at, pending: null });
  // asked on the next tick, so even a call that throws at once settles after this read is recorded as under way
  const pending = Promise.resolve()
    .then(() => codexApi.modelList())
    .then(
      (r) => {
        if (seq !== modelsSeq) return;
        set({ models: r.data, modelsLoaded: true });
        settle(Date.now());
      },
      (error: unknown) => {
        // the list stays as last loaded; the next list opened asks again
        noteIgnored("list Codex's models", error);
        if (seq !== modelsSeq) return;
        // an empty list is now really empty, not still loading
        set({ modelsLoaded: true });
        settle(0);
      },
    );
  modelsRead = { account, at: 0, pending };
  return pending;
}

/**
 * Read Codex's model list again when it may be out of date. Codex says nothing when a model is released (no
 * notification), so a list that opens and an account read that changed the account ask: a read under way for the same
 * account is joined, one answered within MODELS_FRESH_MS is kept, and a Codex not connected is left to connect().
 */
export function refreshModels(): Promise<void> | undefined {
  if (get().conn !== 'ready') return;
  const read = modelsRead;
  if (read?.account === modelsAccount()) {
    if (read.pending !== null) return read.pending;
    // a clock set back reads as stale, not fresh for good
    const age = Date.now() - read.at;
    if (age >= 0 && age < MODELS_FRESH_MS) return;
  }
  return loadModels();
}
/**
 * A harness's model list opening asks for it again. Claude Code's list is the one its CLI build reports: detection reads
 * it again after an update, a Re-check or an account switch (detectClaude), so opening the list asks nothing.
 */
const REFRESH_MODELS: Record<HarnessId, () => Promise<void> | undefined> = {
  codex: refreshModels,
  claude: () => undefined,
};
export const refreshHarnessModels = (h: HarnessId) => REFRESH_MODELS[h]();
export const loadConfig = createConfigLoader(() => codexApi.configRead(), set);

export async function loadThreads(more = false) {
  const visible = beginThreadVisibilityRead();
  if (!more) launchMark('chats:codex:start', undefined, true);
  try {
    const r = await codexApi.threadList({
      limit: 100,
      cursor: more ? get().threadsCursor : null,
      sortKey: 'updated_at',
    });
    if (!more) launchMark('chats:codex', r.data.length, true);
    // a first page that is not the whole history cannot tell a chat is gone
    confirmList({
      listed: (r.data as Thread[]).map((t) => t.id),
      owns: isCodexThread,
      complete: !more && !r.nextCursor,
    });
    set((s) => {
      const threads = { ...s.threads };
      const order = more ? [...s.threadOrder] : [];
      for (const t of r.data as Thread[]) {
        if (!visible.allows(t.id)) continue;
        // archived in Sage meta: it stays out of the sidebar even when Codex still lists it
        if (s.claudeArchived[t.id]) {
          runtime().rememberClaudeThread(t);
          continue;
        }
        threads[t.id] = { ...threads[t.id], ...t, turns: [] };
        if (!order.includes(t.id)) order.push(t.id);
      }
      // keep any locally-known threads not returned (e.g. just created)
      if (!more) for (const id of s.threadOrder) if (!order.includes(id) && threads[id]) order.unshift(id);
      return { threads, threadOrder: order, threadsCursor: r.nextCursor };
    });
    if (!more) await readUnlistedSwitchedChats();
  } catch (e) {
    // the first page shows as an empty list with the connection's own status; a next page asked for says why
    if (more) toast(`Couldn't load more chats: ${errorText(e)}`, 'error');
    else console.error(e);
  } finally {
    visible.finish();
    if (!more) settleList('codex');
  }
}

/**
 * Switched chats forked here (chat meta forkOf) whose first part is a Codex thread Codex does not list. A fork's Codex
 * rollout holds no message of its own, and thread/list leaves such threads out; a switched chat's fork whose first part
 * is Codex never gets one (its messages go to its last part), so it is read here to stay in the sidebar (#1941).
 */
async function readUnlistedSwitchedChats() {
  const s = get();
  const missing = Object.keys(s.chatForkOf).filter(
    (id) => (s.segments[id]?.length ?? 0) > 1 && !id.startsWith('claude:') && !isAcpThread(id) && !s.threads[id] && !s.claudeArchived[id],
  );
  const read = await Promise.all(
    missing.map((id) =>
      codexApi.threadRead(id).then(
        (r) => r.thread as Thread,
        (error) => (noteIgnored('read a switched chat Codex does not list', error), null),
      ),
    ),
  );
  // archived or deleted while it was read: it stays out
  const found = read.filter((t): t is Thread => !!t && !get().claudeArchived[t.id] && deletionVisibility.visible([t]).length > 0);
  if (found.length)
    set((st) => ({
      threads: {
        ...st.threads,
        ...Object.fromEntries(found.map((t) => [t.id, { ...st.threads[t.id], ...t, turns: [] }])),
      },
      threadOrder: [...found.map((t) => t.id).filter((id) => !st.threadOrder.includes(id)), ...st.threadOrder],
    }));
}

/**
 * Chats that match from each place a chat lives (the search palette merges them): Codex thread/list
 * and thread/search, Claude transcripts, and basic-tier titles and Sage transcripts (`scope`: the search box
 * asking, whose next search replaces its Claude and Sage transcript scans). One source
 * failing (Codex not connected, no thread/search on an older app-server) leaves the others.
 */
export async function searchThreads(term: string, scope?: string): Promise<{ codex: Thread[]; claude: Thread[]; sage: Thread[] }> {
  const ok = <T>(r: PromiseSettledResult<T[]>) => (r.status === 'fulfilled' ? r.value : []);
  const [list, text, claude, sage] = await Promise.allSettled([
    codexApi.threadList({ searchTerm: term, limit: 30, sortKey: 'updated_at' }).then((r) => r.data as Thread[]),
    codexApi.threadSearch(term, 30).then((r) => (r.data as { thread: Thread }[]).map((x) => x.thread)),
    runtime().searchClaudeThreads(term, scope),
    runtime().searchAcpThreads(term, scope),
  ]);
  const seen = new Set<string>();
  const codex = [...ok(list), ...ok(text)].filter((t) => !seen.has(t.id) && !!seen.add(t.id));
  return {
    codex: deletionVisibility.visible(codex),
    claude: deletionVisibility.visible(ok(claude)),
    sage: deletionVisibility.visible(ok(sage)),
  };
}

/** Send feedback on a Codex chat (or the app) to OpenAI. */
export function sendFeedback(threadId: string | null, classification: string, reason: string | null, includeLogs: boolean) {
  // a chat on another harness has no Codex thread to attach
  const codexThread = threadId && HARNESS_TRAITS[chatFamily(threadId)].feedbackUpload ? nativeOf(threadId) : null;
  return codexApi.feedbackUpload({
    classification,
    reason,
    threadId: codexThread,
    includeLogs,
  });
}

/** A harness whose archived chats could not be listed: Settings → Archived chats shows it with Retry, not a shorter list. */
export interface ArchivedFailure {
  /** the harness (or harnesses) whose list is missing, as the user knows them */
  source: string;
  error: string;
}

/**
 * Settings → Archived chats: every harness's archived chats, newest first. Never rejects: it resolves with the harnesses
 * whose list could not be read, so the page can say so instead of passing a partial list off as the archive.
 */
export async function loadArchived(): Promise<ArchivedFailure[]> {
  const current = beginArchiveRead();
  // archived Claude chats the session list did not return are read from their own files (D-38);
  // one that can't be read is left out and recorded there, and the rest of the list still loads
  await runtime()
    .loadArchivedClaudeInfo()
    .catch((error) => noteIgnored('read the archived Claude Code chats', error));
  const failures: ArchivedFailure[] = [];
  const failed =
    (source: string) =>
    (error: unknown): Thread[] => (failures.push({ source, error: errorText(error) }), []);
  // Codex left for first use starts when it holds an archived chat this window can't show without it (listing a
  // harness is its first use); with none, it stays idle
  if (get().conn === 'idle' && runtime().archivedCodexMissing()) await ensureCodex();
  const codex = get().conn === 'idle' ? [] : await archivedCodexThreads().catch(failed('Codex'));
  // basic-tier chats archived in an earlier run are only in main's list
  const acpIds = Object.keys(get().claudeArchived).filter(isAcpThread);
  const acp = acpIds.length
    ? await runtime()
        .archivedAcpThreads()
        .catch(failed([...new Set(acpIds.map(harnessLabelOf))].join(', ')))
    : [];
  if (!current()) return [];
  // the copy Sage keeps (a Claude chat's own file, the last known Thread with its project) wins over Codex's and main's
  const byId = new Map<string, Thread>();
  // MoMo's chats are in no list, the archive included (lib/momoChats.ts)
  const { momoChats, segments } = get();
  for (const t of [...codex, ...acp, ...runtime().archivedClaudeThreads()]) if (!momoOwned(momoChats, segments, t.id)) byId.set(t.id, t);
  set({
    archived: [...byId.values()].sort((a, b) => b.updatedAt - a.updatedAt),
  });
  return failures;
}
