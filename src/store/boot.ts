// Boot, and persisting this window's state and its chat changes to main. @store-slice: tests' store stub replaces it whole (tests/support/stubs.ts).

import { restoreRepositoryDraft } from './repositoryDraft';
import { restoreRemoteSidePanes } from './remoteSidePanes';
import { acceptChatDeletion } from './deletionReceipts';
import { deletionVisibility } from './deletionVisibility';
import type { AppState } from './state';
import { agentFromHash, threadFromHash } from '../lib/deepLink';
import { markWindowReady } from '../lib/windowReady';
import { launchMark } from '../lib/launchMarks';
import { confirmList, expectLists, seedThreads, settleList, startSnapshotWriter } from './sidebarSnapshot';
import { isAcpThread } from '../harness/types';
import { codexThreadOf } from '../harness/family';
import { native } from '../lib/native';
import { errorText, ignoring, noteIgnored } from '../lib/ignored';
import { applyChat, applyPrefsDelta, chatChanges, mapsFromSnapshot, prefsDelta, type ChatMaps } from '../lib/chatMeta';
import { loadPrefs, defaultsPatch, rememberedNewChatHost, type Prefs } from './types';
import { defaultHarnessPatch } from '../../shared/defaultHarness.mjs';
import { sideChatUuid } from '../../shared/host/sideChats.mjs';
import { codexWantedAtLaunch } from '../harness/launch';
import { noteChat } from '../harness/ownership';
import { withoutExtraUsage } from '../harness/claudeUsage';
import { followArchive } from './remoteArchive';
import { startPrewarm } from './prewarm';
import { followHarnessUpdates } from '../harness/harnessUpdates';
import { wireAgentSurfaces } from './agentWiring';
import { ensureSession, startSessions, useSessions } from './session/useSession';
import { beginStoreBatch, endStoreBatch, get, useStore, set, toast } from './core';
import { followStreamFlush } from '../lib/streamFlush';
import { migrationNotice, openSettings, startingHarness } from './chats';
import { onCodexStatus, onCrashed, connect } from './connection';
import { held, showThread } from './threads';
import { dropGoneHostPick, loadProjects, fromLocal, syncCodexProjects } from './projects';
import { onCodexItem } from './send';
import { openAgentPage, startAgentTabs } from './panes';
import { startClaudeSignIn } from './claudeSignIn';
import { syncPending } from './notifications';
import { eachNewlyCrashed } from './crashedSessions';
import { followTurnDiffs } from './turnDiffs';
import { onAccountsEvent } from './accounts';
import { onComputerChanged } from './stoppedByYou';
import { onWatchRecordDone } from './watchRecord';
import './unsentReport';
import { startWindowLayout } from './windowLayout';
import { focusedChat, primaryChat, visibleChats } from './split';
import { runtime } from './runtime';

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */
let persistTimer: ReturnType<typeof setTimeout> | undefined;
/** This window's own ui-state keys. Prefs and per-chat state are main's: see below. */
export let quickChatSurface = false;
function persist() {
  if (quickChatSurface) return;
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    const s = get();
    native.state
      .write({
        projects: s.projects,
        collapsedProjects: s.collapsedProjects,
        sidebarOpen: s.sidebarOpen,
        summaryOpen: s.summaryOpen,
        newChatCwd: s.newChatCwd,
        newChatProjectId: s.newChatProjectId,
        newChatCloudEnv: s.newChatRepositoryGroup ? null : s.newChatCloudEnv,
        newChatRepositoryGroup: s.newChatRepositoryGroup,
        codexBin: s.codexBin,
        claudeUsage: s.claudeUsage,
        // last known Claude plan, usage and models, shown until detection finishes
        claudeCache: {
          status: {
            ...s.claude.status,
            state: 'detecting',
            candidates: undefined,
            error: null,
          },
          models: s.claude.models,
        },
        // layout and caches only: the next change writes them again
      })
      .catch(ignoring("save this window's layout"));
  }, 250);
}
/** A change main didn't save: the window shows it, but it would be gone after a restart, so say so. */
const saveFailed = (what: string) => (error: unknown) => {
  const text = `Couldn't save ${what}: ${errorText(error)}`;
  // one toast for the failure, not one per chat a change touched
  if (!get().toasts.some((t) => t.text === text)) toast(text, 'error');
};
/** Set once boot has loaded what main keeps; changes before that are the load itself. */
let chatsLoaded = false;
/** Applying another window's change: don't send it back. */
let remote = false;
function applyRemote(fn: () => void) {
  remote = true;
  try {
    fn();
  } finally {
    remote = false;
  }
}
const chatMaps = (s: AppState): ChatMaps => ({
  pinned: s.pinned,
  unread: s.unread,
  worktreeOf: s.worktreeOf,
  chatProject: s.chatProject,
  claudeArchived: s.claudeArchived,
  claudeChats: s.claudeChats,
  chatNotes: s.chatNotes,
  chatConfig: s.chatConfig,
  navigationBookmarks: s.navigationBookmarks,
  chatForkOf: s.chatForkOf,
  chatInitialTitles: s.chatInitialTitles,
  chatRewoundAt: s.chatRewoundAt,
  momoChats: s.momoChats,
  momoModels: s.momoModels,
  authoredInputs: s.authoredInputs,
  segments: s.segments,
});
useStore.subscribe((s, prev) => {
  if (
    s.projects !== prev.projects ||
    s.collapsedProjects !== prev.collapsedProjects ||
    s.sidebarOpen !== prev.sidebarOpen ||
    s.summaryOpen !== prev.summaryOpen ||
    s.newChatCwd !== prev.newChatCwd ||
    s.newChatProjectId !== prev.newChatProjectId ||
    s.newChatCloudEnv !== prev.newChatCloudEnv ||
    s.newChatRepositoryGroup !== prev.newChatRepositoryGroup ||
    s.codexBin !== prev.codexBin ||
    s.claudeUsage !== prev.claudeUsage ||
    s.claude.models !== prev.claude.models ||
    s.claude.status.usage !== prev.claude.status.usage ||
    s.claude.status.plan !== prev.claude.status.plan
  )
    persist();
  // only a change to what the panes show can change the view (a streamed delta can't)
  if (
    s.route !== prev.route ||
    s.split !== prev.split ||
    s.paneTabs !== prev.paneTabs ||
    s.paneActive !== prev.paneActive ||
    s.diffPanel !== prev.diffPanel
  )
    reportViewing(s);
  if (!chatsLoaded || remote) return;
  // prefs and per-chat state go to main as deltas, merged there per key
  if (s.prefs !== prev.prefs) {
    const d = prefsDelta(prev.prefs, s.prefs);
    if (!d.empty) native.prefs.patch(d.set, d.unset).catch(saveFailed('the setting'));
  }
  const a = chatMaps(prev);
  const b = chatMaps(s);
  if (MAP_FIELDS.some((k) => a[k] !== b[k])) {
    const { meta, segments } = chatChanges(a, b);
    for (const [id, segs] of Object.entries(segments))
      if (!deletionVisibility.has(id)) native.chats.setSegments(id, segs).catch(saveFailed("the chat's harness history"));
    for (const [id, patch] of Object.entries(meta))
      if (!deletionVisibility.has(id)) native.chats.patchMeta(id, patch).catch(saveFailed('the change to the chat'));
  }
});
const MAP_FIELDS = [
  'pinned',
  'unread',
  'worktreeOf',
  'chatProject',
  'claudeArchived',
  'claudeChats',
  'chatNotes',
  'chatConfig',
  'navigationBookmarks',
  'chatForkOf',
  'segments',
] as const;

/** The chats this window's panes show and the focused one, told to main so it notifies for a chat nobody is looking at. */
let viewedKey: string | undefined;
function reportViewing(s: AppState) {
  const view = windowView(s);
  const key = JSON.stringify(view);
  if (key === viewedKey) return;
  viewedKey = key;
  // only steers which chats notify; the next view change reports again
  native.app.viewing(view).catch((error) => noteIgnored('tell main which chats this window shows', error));
}

/** What main hears of this window's view; with no chat in the primary pane, a side chat in front counts as shown there. */
export function windowView(s: AppState): {
  visible: string[];
  primary: string | null;
  focused: string | null;
} {
  const active = s.diffPanel.open ? s.paneTabs.find((t) => t.id === s.paneActive) : null;
  const side = !primaryChat(s) && active?.kind === 'chat' ? (active.threadId ?? null) : null;
  const visible = visibleChats(s);
  if (side && !visible.includes(side)) visible.unshift(side);
  const ownedSide = active?.kind === 'chat' && !active.readOnly && active.sourceChatId === focusedChat(s) && active.threadId;
  if (ownedSide && sideChatUuid(ownedSide) && !visible.includes(ownedSide)) visible.push(ownedSide);
  return {
    visible,
    primary: primaryChat(s) ?? side,
    focused: focusedChat(s) ?? side,
  };
}

/* ------------------------------------------------------------------ */
/* boot                                                                */
/* ------------------------------------------------------------------ */
/** This window's ui-state keys as persist() writes them; prefs is what older builds kept here. */
type SavedUiState = Partial<
  Pick<
    AppState,
    | 'projects'
    | 'collapsedProjects'
    | 'sidebarOpen'
    | 'summaryOpen'
    | 'newChatCwd'
    | 'newChatProjectId'
    | 'newChatCloudEnv'
    | 'newChatRepositoryGroup'
    | 'codexBin'
    | 'claudeUsage'
  >
> & {
  prefs?: Partial<Prefs>;
  claudeCache?: AppState['claude'];
  /** the sidebar's chats as the last run knew them (store/sidebarSnapshot.ts) */
  sidebarSnapshot?: unknown;
};
/** The saved projects, asked for at once; null when main cannot list them (the list is asked for again once boot is done). */
async function readProjects() {
  try {
    return await native.projects.list();
  } catch (error) {
    noteIgnored('list the projects at startup', error);
    return null;
  }
}
/** The Claude Code chats are files on disk: listed now, not after the CLI's status check and model probe (detection lists again). */
async function listClaudeChats() {
  try {
    await runtime().loadClaudeThreads();
  } catch (error) {
    noteIgnored('list the Claude Code chats at startup', error);
  }
}
/** Basic-tier chats are read by main's list: the saved ones are checked against it here, as the other harnesses' are by their loaders. */
async function confirmAcpRows() {
  try {
    const rows = await native.acp.list();
    confirmList({ listed: rows.map((c) => c.id), owns: isAcpThread, complete: true });
  } catch (error) {
    noteIgnored('check the saved basic-tier chats against their list', error);
  }
}
export async function boot(options: { quickChat?: boolean } = {}) {
  quickChatSurface = !!options.quickChat;
  launchMark('boot:start', undefined, true);
  // asked at once, so the projects are in the store with the saved chats at the first frame
  const projectsRead = readProjects();
  // Subscribe before any await. A later snapshot only adds terminals, never clears a receipt already observed.
  native.chats.onDeleted((receipt) => applyRemote(() => acceptChatDeletion(receipt)));
  for (const receipt of await native.chats.deletions()) applyRemote(() => acceptChatDeletion(receipt));
  const pendingPrefs: Parameters<Parameters<typeof native.prefs.onChanged>[0]>[0][] = [];
  let prefsLive = false;
  const offPrefs = native.prefs.onChanged((delta) => {
    if (prefsLive) applyRemote(() => set((st) => ({ prefs: applyPrefsDelta(st.prefs, delta) })));
    else pendingPrefs.push(delta);
  });
  const stopPrefsRead = (error: unknown): never => {
    offPrefs();
    throw error;
  };
  pendingPrefs.length = 0;
  const saved = ((await native.state.read().catch(stopPrefsRead)) || {}) as SavedUiState;
  const awaitedAudioDrafts = await native.speech.drafts().catch((error) => {
    toast(`Could not restore audio drafts: ${errorText(error)}`, 'error');
    return {};
  });
  // Subscribe at the snapshot boundary; buffer live changes until the initial maps have been installed.
  let chatPhase: 'buffering' | 'live' | 'stopped' = 'buffering';
  const pendingChats: (() => void)[] = [];
  const hearChat = (apply: () => void) => {
    if (chatPhase === 'stopped') return;
    if (chatPhase === 'live') apply();
    else pendingChats.push(apply);
  };
  const offChanges = native.chats.onChanged(({ id, chat }) =>
    hearChat(() => applyRemote(() => (noteChat(id, chat), followArchive(id, chat), set((st) => applyChat(chatMaps(st), id, chat))))),
  );
  const offReset = native.chats.onReset((next) =>
    hearChat(() => applyRemote(() => (Object.entries(next.chats).forEach(([id, c]) => noteChat(id, c)), set(mapsFromSnapshot(next))))),
  );
  const stopChatRead = (error: unknown): never => {
    chatPhase = 'stopped';
    pendingChats.length = 0;
    offChanges();
    offReset();
    return stopPrefsRead(error);
  };
  // A bridge's synchronous catch-up predates this request, whose snapshot already contains it.
  pendingChats.length = 0;
  const snap = await native.chats.snapshot().catch(stopChatRead);
  for (const [id, c] of Object.entries(snap.chats)) noteChat(id, c);
  const chats = mapsFromSnapshot(snap);
  // the chats the last run listed: drawn at once, checked against each list as it answers (a chat archived or deleted since stays out)
  const seed = seedThreads(saved.sidebarSnapshot, (id) => deletionVisibility.has(id) || !!chats.claudeArchived[id]);
  const projectList = await projectsRead;
  const info = await native.app.info().catch(stopChatRead);
  const defaults = defaultsPatch(saved.prefs, {
    home: info.home,
    codexHome: info.codexHome,
  });
  // this window starts with them either way, and the next boot writes them again
  if (defaults) native.prefs.patch(defaults, []).catch(ignoring('save the default settings'));
  // main moved the old default-harness prefs before this window opened; when it couldn't, they move here
  const moved = defaultHarnessPatch(saved.prefs);
  if (moved) native.prefs.patch(moved.set, moved.unset).catch(ignoring('move the default harness to its one setting'));
  const prefs = pendingPrefs.reduce(applyPrefsDelta, loadPrefs({ ...saved.prefs, ...defaults, ...moved?.set })) as Prefs;
  const projectId = saved.newChatProjectId ?? null;
  const cwd = saved.newChatCwd ?? null;
  const repository = quickChatSurface ? undefined : restoreRepositoryDraft(saved.newChatRepositoryGroup);
  const host =
    !quickChatSurface && !repository && !saved.newChatCloudEnv && !cwd && (projectId === null || projectId === 'none')
      ? rememberedNewChatHost(prefs)
      : null;
  set({
    home: info.home,
    drafts: { ...awaitedAudioDrafts, ...get().drafts },
    systemUsername: info.username ?? null,
    dark: info.dark,
    projects: saved.projects ?? [],
    collapsedProjects: saved.collapsedProjects ?? {},
    prefs,
    sidebarOpen: saved.sidebarOpen ?? true,
    summaryOpen: saved.summaryOpen ?? true,
    newChatCwd: quickChatSurface ? null : cwd,
    newChatProjectId: quickChatSurface ? 'none' : host ? null : projectId,
    newChatHost: host,
    newChatCloudEnv: quickChatSurface || repository ? null : (saved.newChatCloudEnv ?? null),
    newChatRepositoryGroup: repository,
    ...chats,
    ...seed,
    ...(projectList ? { savedProjects: projectList.projects.map(fromLocal) } : {}),
    codexBin: saved.codexBin ?? null,
    claudeUsage: Object.fromEntries(Object.entries(saved.claudeUsage ?? {}).map(([id, u]) => [id, withoutExtraUsage(u)])),
    ...(saved.claudeCache?.status
      ? {
          claude: {
            ...saved.claudeCache,
            status: {
              ...saved.claudeCache.status,
              usage: withoutExtraUsage(saved.claudeCache.status.usage),
            },
          },
        }
      : {}),
  });
  pendingPrefs.length = 0;
  prefsLive = true;
  native.host.onMachineRemoved((id) => applyRemote(() => dropGoneHostPick([id])));
  chatPhase = 'live';
  for (const apply of pendingChats.splice(0)) apply();
  chatsLoaded = true;
  if (!quickChatSurface) {
    expectLists(['claude', 'codex']);
    startSnapshotWriter();
    void confirmAcpRows();
  }
  launchMark('boot:stored', undefined, true);
  // prefs older builds used and this one dropped
  const retired = Object.keys(saved.prefs ?? {}).filter((k) => !(k in get().prefs));
  // the next boot drops them again
  if (retired.length) native.prefs.patch({}, retired).catch(ignoring('drop retired settings'));
  if (snap.newer.length)
    toast('Some chats were saved by a newer version of MoPilot and open read-only', 'error', {
      action: { label: 'Check for updates', run: openSettings('about') },
    });
  native.chats
    .migration()
    .then(migrationNotice)
    // the notice is informational: the chats open either way
    .catch(ignoring("read the chats' migration status"));
  // the window keeps the system theme until the next change sets it
  native.app.setTheme(get().prefs.theme).catch(ignoring('apply the theme at startup'));
  native.app.onThemeChanged((dark) => set({ dark }));
  native.win.onFocus((focused) => set({ focused }));
  native.win.onFullscreen((fullscreen) => set({ fullscreen }));
  native.win
    .isFocused()
    .then((focused) => set({ focused }))
    // focus events keep it current from here on
    .catch(ignoring('read whether the window is focused'));
  startAgentTabs();
  startClaudeSignIn();
  // main's window tools (open_session_in, close_split) arrange this window's split view
  startWindowLayout();

  // Projects come from projects.json, with or without Codex.
  loadProjects().catch(ignoring('list the projects at startup'));
  native.projects.onChanged((snap) => set({ savedProjects: snap.projects.map(fromLocal) }));
  // each chat's live state and send queue are main's (electron/session); this window runs the
  // controller's window steps (a Claude message, a switch's handoff)
  startSessions();
  // what a Claude Code or ACP turn changed, from main's snapshots of its folder
  followTurnDiffs();
  useSessions.subscribe(syncPending);
  // cards that came in before this window opened
  native.session.withApprovals().then(
    (ids) => {
      for (const id of ids) ensureSession(id);
    },
    // opening a chat loads its session, cards included
    ignoring('list the chats with approval cards at startup'),
  );
  if (!quickChatSurface) native.session.ready();
  // reads main answers only for a window it knows (linked sessions, peer messages) go from here on; Quick Chat is known
  // to main without session:ready
  markWindowReady();
  // Claude Code doesn't depend on the Codex connection, nor do the basic harnesses.
  runtime().startClaude();
  // the chats are files on disk: listed now, not after the CLI's status check and model probe have answered (detection lists again)
  void listClaudeChats();
  runtime().startAcp();
  // a new chat's harness starts while its composer is open (#1664); Quick Chat starts its chats on send
  if (!quickChatSurface) startPrewarm();
  // harness installs run in main; a window looks for the harness again when one ends
  runtime().followHarnessRuns();
  followHarnessUpdates();
  wireAgentSurfaces();
  // the Codex adapter in main handles the app-server's notifications and requests once, for every window
  native.codex.onItem(onCodexItem);
  native.codex.leases().then(
    (ids) => ids.forEach((id) => held.add(id)),
    // lease events keep `held` current from here on
    ignoring('list the Codex chats this app holds at startup'),
  );
  native.accounts.onEvent(onAccountsEvent);
  native.codex.onStatus(onCodexStatus);
  // a person's Esc on the desktop stopped a chat: its turn reads "You stopped after Ns"
  native.computer.onChanged(onComputerChanged);
  // a Record a skill recording ended: its block goes to the composer of the chat that started it
  native.computer.onRecordDone(onWatchRecordDone);
  // the events of one stream:batch from main land as one commit, not one per event (the preload brackets them)
  followStreamFlush(window, beginStoreBatch, endStoreBatch);
  // a remote switch changed: selectors that read it (codexUsable, claudeUsable) run again
  native.flags.onChanged(() => set((s) => ({ flagsRev: s.flagsRev + 1 })));
  // a harness that quits mid-turn: main marks the chat crashed; this window ends its turn and cards
  useSessions.subscribe((st, prev) => {
    eachNewlyCrashed(st.sessions, prev.sessions, onCrashed);
  });
  // a window opened for one chat (any harness) starts on it
  const hashThread = quickChatSurface ? null : threadFromHash(location.hash);
  const needsCodex = hashThread && codexThreadOf(get().segments[hashThread], hashThread);
  if (hashThread) {
    set({ route: { name: 'thread', id: hashThread } });
    if (!needsCodex) showThread(hashThread);
  }
  if (!quickChatSurface) await restoreRemoteSidePanes();
  // ...and one opened on a sub-agent shows its page at full width
  const hashAgent = hashThread ? agentFromHash(location.hash) : null;
  if (hashThread && hashAgent) {
    openAgentPage(hashThread, hashAgent.key, hashAgent.title);
    set({ paneFull: true });
  }
  // Codex starts now only for someone who relies on it; otherwise on first use
  // unknown: Codex waits for first use, as for someone who hasn't used it
  const used = await native.codex.used().catch((error) => (noteIgnored('read whether Codex was used before', error), false));
  if (codexWantedAtLaunch(startingHarness(), used)) await connect();
  else {
    set({ conn: 'idle' });
    // Codex is not started: no list to wait for
    settleList('codex');
    syncCodexProjects().catch(ignoring("import Codex's projects without Codex running"));
  }
  // A connected Codex opens the visible chats. Otherwise, let the transcript reader handle the fallback.
  if (hashThread && needsCodex && get().conn !== 'ready' && visibleChats(get()).includes(hashThread)) showThread(hashThread);
  launchMark('boot:done', undefined, true);
  native.win.rendererReady();
}
