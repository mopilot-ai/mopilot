// Chat actions: goals, rename, archive, delete, fork, side chats, review, tasks and shell commands. @store-slice: tests' store stub replaces it whole (tests/support/stubs.ts).

import type { AppState } from './state';
import { parkChatPane, chatTabsFor } from './chatPanes';
import { retireChatFromView } from './splitView';
import { createSideChat } from './sideChat';
import { canReuseHostSideChat, openHostSideChat } from './hostSideChat';
import { forkWithWorkspace } from './forkWorkspace';
import { dispatchComposerFocus, dispatchComposerSelection } from '../lib/composerEvents';
import { selectionAttachment } from '../lib/annotations';
import { claudeReviewMessage, claudeReviewPrompt, reviewArgs, type ReviewAsk } from '../lib/claudeReview';
import { editBlocked } from '../harness/claudeTranslate';
import { codexApi } from '../harness/adapters/codexApi';
import type { Semantic } from '../harness/adapter';
import { refusalText, runSemantic } from './session/runSemantic';
import { handlerFor } from '../harness/adapters/semantics';
import { native } from '../lib/native';
import { chatFolderHere } from '../lib/hostChats';
import { archiveWithFamily } from './familyArchive';
import { noteIgnored, errorText } from '../lib/ignored';
import { revertRequest, reviewRequest } from '../lib/codexRequests';
import { goalNotice } from '../lib/notify';
import { goalStatusLabel } from '../lib/codexGoals';
import { worktreeRootOf, type ChatGoal } from './types';
import { ownerOf } from '../harness/ownership';
import { inCurrentSegment, isAcpThread, type HarnessId } from '../harness/types';
import { HARNESS_TRAITS, nativeFamily, type HarnessFamily } from '../harness/family';
import { turnFromServer } from '../../shared/codexTurns.mjs';
import { backgroundTerminals, type BackgroundTerminal } from '../harness/codexTranslate';
import { sessionOf, setSession } from './session/useSession';
import type { ReviewTarget } from '../protocol/v2/ReviewTarget';
import type { ReviewStartResponse } from '../protocol/v2/ReviewStartResponse';
import type { ThreadBackgroundTerminalsTerminateResponse } from '../protocol/v2/ThreadBackgroundTerminalsTerminateResponse';
import { notify, threadTitle, get, toast, set, upsertThread, setDraft, patchRuntime } from './core';
import { chatTurnIndex } from './turnPages';
import { chatFamily, nativeOf, blockedReason, harnessBlocked, newChatHarness } from './chats';
import { loadThreads } from './connection';
import { archivedCodexThreads } from './archivedCodex';
import { mutateArchive } from './archiveOwnership';
import { MESSAGE_GONE } from './liveAction';
import { acceptChatDeletion } from './deletionReceipts';
import { toastHostRefusal, deletionNote } from './hostRefusalToast';
import { deletionVisibility } from './deletionVisibility';
import { inheritCodexPin } from './accounts';
import { held, withLease, showThread } from './threads';
import { restoreTurnFiles } from './rewindFiles';
import { rewindTurns } from './pendingTurns';
import { noteWorktreeCopy, retireWorktree, runEnvironmentScript, startThread, currentCwdForNewChat } from './projects';
import { sendMessage, sendOrDraft } from './send';
import { navigate, openPaneTab, closeOwnedPaneTabs } from './panes';
import { runtime } from './runtime';

/* ------------------------------------------------------------------ */
/* Codex goals                                                         */
/* ------------------------------------------------------------------ */
/**
 * The chat's goal, kept in main's SessionState. Every window reports what it saw; only the window
 * whose report changed it there tells the user. Resolves true in that window.
 */
export async function setGoalState(chatId: string, goal: ChatGoal | null): Promise<boolean> {
  const notice = goalNotice(sessionOf(chatId).goal, goal);
  const changed = await setSession(chatId, { goal });
  if (changed && notice) notify('goal', chatId, { title: threadTitle(get().threads[chatId]), body: notice.body, status: notice.status });
  return changed;
}

/** Latest native goal read per chat; pushed state and a segment switch always win over an old reply. */
const goalReads = new Map<string, object>();
export async function loadGoal(chatId: string) {
  const context = { goal: sessionOf(chatId).goal, native: nativeOf(chatId), harness: chatFamily(chatId) };
  goalReads.set(chatId, context);
  try {
    const r = await codexApi.threadGoal(chatId);
    if (
      goalReads.get(chatId) !== context ||
      sessionOf(chatId).goal !== context.goal ||
      nativeOf(chatId) !== context.native ||
      chatFamily(chatId) !== context.harness
    )
      return;
    await setGoalState(chatId, r.goal ?? null);
  } catch (error) {
    // the goal stays as last known; thread/goal/updated reports any change
    noteIgnored("read a Codex chat's goal", error);
  } finally {
    if (goalReads.get(chatId) === context) goalReads.delete(chatId);
  }
}

/** Run a semantic on a chat; when the chat can't do it, say why (the Why from main, in the copy table's words). */
async function viaSemantic(chatId: string, semantic: Semantic, args = '') {
  const r = await runSemantic(chatId, semantic, args);
  if (r.ok === true) return r.value;
  toast(refusalText(r, semantic), 'error');
  return undefined;
}

/** Pause the goal and stop the running turn: a paused goal can still be finished by the turn already running. */
export async function pauseGoal(chatId: string) {
  await viaSemantic(chatId, 'goal', 'pause');
}

export async function resumeGoal(chatId: string) {
  await viaSemantic(chatId, 'goal', 'resume');
}

export async function clearGoal(chatId: string, human = false) {
  await viaSemantic(chatId, 'goal', human ? 'clear human' : 'clear');
}

/** Claude's goal at the round limit: allow 10 more rounds. */
export async function extendGoal(chatId: string) {
  await viaSemantic(chatId, 'goal', 'extend');
}

/** Codex's soft token budget on the goal; null removes it. */
export async function setGoalBudget(chatId: string, tokens: number | null) {
  await viaSemantic(chatId, 'goal', `budget ${tokens ?? 'none'}`);
}

/** "/goal edit <objective>": change the objective of a Codex goal. */
export async function editGoal(chatId: string, objective: string) {
  return (await viaSemantic(chatId, 'goal', `edit ${objective}`)) === true;
}

/** Bare "/goal": say what the chat's goal is. */
export async function showGoal(chatId: string | null) {
  if (chatId) await loadGoal(chatId);
  const goal = chatId ? sessionOf(chatId).goal : null;
  toast(
    goal ? `Goal (${goalStatusLabel(goal.status).toLowerCase()}): ${goal.objective}` : 'No goal set. Use /goal <objective> to set one.',
  );
}

export async function renameThread(threadId: string, name: string) {
  if (isAcpThread(threadId)) {
    // the name is kept here either way; a machine that did not take it is said, and the chat shows the name this Mac keeps
    const refused = await runtime().acpRename(threadId, name);
    if (refused) await toastHostRefusal(refused.error, refused.hostId);
  } else if (get().segments[threadId]?.length) {
    // a switched chat is listed under its first native session, the chat's own id: its name changes there,
    // on that harness (the current segment's harness knows no session by that id)
    const rename = await handlerFor(ownerOf(threadId), 'rename');
    await rename?.({ chatId: threadId, args: name });
  } else {
    const r = await runSemantic(threadId, 'rename', name);
    // a harness that refused keeps the chat's name: the title shows what it has
    if (r.ok !== true) return void toast(refusalText(r, 'rename'), 'error');
  }
  set((s) => ({ threads: { ...s.threads, [threadId]: { ...s.threads[threadId], name } } }));
}

export const archiveThread = (threadId: string) => {
  unarchiving.delete(threadId);
  return mutateArchive(threadId, () => archiveWithFamily(threadId, runArchive));
};
async function runArchive(threadId: string) {
  if (deletionVisibility.has(threadId)) throw new Error('Chat was deleted');
  const archivedThread = get().threads[threadId];
  // a chat on a machine has no worktree here: its folder is none of this Mac's (read now, before anything changes)
  const cwd = await chatFolderHere(threadId, archivedThread?.cwd ?? '');
  // Sage meta is the archive for every harness; Codex's own archive is kept in step, best effort
  runtime().rememberClaudeThread(get().threads[threadId]);
  set((s) => ({ claudeArchived: { ...s.claudeArchived, [threadId]: Date.now() } }));
  // Sage meta above is the archive; a harness that keeps one of its own is only kept in step
  await ARCHIVE_IN_HARNESS[nativeFamily(threadId)]?.(threadId).catch((error) => noteIgnored('archive the chat in its harness too', error));
  forgetDesktopAccess(threadId);
  set((s) => {
    const { [threadId]: _t, ...threads } = s.threads;
    return { threads, threadOrder: s.threadOrder.filter((x) => x !== threadId) };
  });
  // no pane keeps showing it: a split pane closes, the primary pane goes home
  retireChatFromView(threadId);
  // Undo can restore immediately without opening Settings or waiting for an archive-list refresh.
  if (archivedThread) set((s) => ({ archived: [archivedThread, ...s.archived.filter((t) => t.id !== threadId)] }));
  // best effort: a failing cleanup script reports itself, and Undo must still run
  const cleanup = retireWorktree(cwd, { archive: true }).catch((error) => noteIgnored("retire an archived chat's worktree", error));
  toast(`Archived “${threadTitle(archivedThread)}”`, 'info', {
    action: {
      label: 'Undo',
      run: () => {
        // a branch the archive deleted comes back with the chat's worktree (platform/deletedBranch.cjs)
        cleanup.then(() => unarchiveThread(threadId)).catch((e) => toast(`Couldn't restore chat: ${errorText(e)}`, 'error'));
      },
    },
  });
}

/**
 * An unarchived chat that ran in a managed worktree auto-delete removed: recreate it from its kept
 * branch (and run the project's setup script again), so the chat doesn't reopen on a missing folder.
 */
async function restoreWorktree(threadId: string, cwd: string | undefined) {
  if (!cwd) return;
  const { prefs, home, worktreeOf } = get();
  // a request that failed is reported like a restore that failed
  const r = await native.git
    .worktreeRestore(cwd, worktreeRootOf(prefs, home), worktreeOf[threadId] ?? null, prefs.branchPrefix)
    .catch((e) => ({ ok: false as const, error: errorText(e) }));
  if (!r.ok) {
    if (r.error && r.error !== 'Not a MoPilot worktree') toast(`Couldn't restore this chat's worktree: ${r.error}`, 'error');
    return;
  }
  if (!r.restored) return;
  noteWorktreeCopy(r.copy);
  await runEnvironmentScript('setup', r.repo ?? worktreeOf[threadId] ?? cwd, r.worktree!);
  toast(`Restored worktree on ${r.branch}`);
}

/** Unarchives in flight, by chat: a second click joins the first instead of racing it. */
const unarchiving = new Map<string, Promise<void>>();

/** Restore an archived chat; rejects (with the chat still archived) when Codex keeps it archived. */
export function unarchiveThread(threadId: string): Promise<void> {
  const running = unarchiving.get(threadId);
  if (running !== undefined) return running;
  const p = mutateArchive(threadId, () => runUnarchive(threadId)).finally(() => {
    if (unarchiving.get(threadId) === p) unarchiving.delete(threadId);
  });
  unarchiving.set(threadId, p);
  return p;
}

/** A harness whose own archive is kept in step with Sage's (Codex's thread/archive); the others have only Sage's. */
const ARCHIVE_IN_HARNESS: Record<HarnessFamily, ((id: string) => Promise<unknown>) | null> = {
  codex: (id) => codexApi.threadArchive(id),
  claude: null,
  acp: null,
};

/** Unarchiving, per harness: Sage's archive alone, then the harness's chat list again, or Codex's own archive too. */
const UNARCHIVE: Record<HarnessFamily, (id: string, cwd: string | undefined) => Promise<void>> = {
  codex: unarchiveCodex,
  claude: (id, cwd) => unarchiveInSage(id, cwd, runtime().loadClaudeThreads),
  acp: (id, cwd) => unarchiveInSage(id, cwd, runtime().loadAcpThreads),
};

async function runUnarchive(threadId: string) {
  if (deletionVisibility.has(threadId)) throw new Error('Chat was deleted');
  const original = get().archived.find((t) => t.id === threadId);
  await UNARCHIVE[nativeFamily(threadId)](threadId, original?.cwd);
}

async function unarchiveInSage(threadId: string, cwd: string | undefined, reload: () => Promise<unknown> | unknown) {
  await restoreWorktree(threadId, cwd);
  if (deletionVisibility.has(threadId)) return;
  set((s) => {
    const { [threadId]: _a, ...claudeArchived } = s.claudeArchived;
    return { claudeArchived, archived: s.archived.filter((t) => t.id !== threadId) };
  });
  await reload();
}

async function unarchiveCodex(threadId: string, cwd: string | undefined) {
  const r = await codexApi.threadUnarchive(threadId).then(
    (value) => ({ ok: true as const, thread: value?.thread }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  // Codex's archive is only kept in step, so it may never have had this chat: refused, its archived list says which
  if (deletionVisibility.has(threadId)) return;
  if (!r.ok && (await stillArchivedInCodex(threadId))) throw r.error;
  if (!r.ok) noteIgnored('unarchive the chat in Codex too', r.error);
  // the worktree comes back only with the chat, so the chat doesn't reopen on a missing folder
  if (deletionVisibility.has(threadId)) return;
  await restoreWorktree(threadId, cwd);
  if (deletionVisibility.has(threadId)) return;
  set((s) => {
    const { [threadId]: _a, ...claudeArchived } = s.claudeArchived;
    return { claudeArchived, archived: s.archived.filter((t) => t.id !== threadId) };
  });
  // Restoring visibility does not bump activity; use the harness's recorded timestamps.
  if (r.ok && r.thread) return void upsertThread(r.thread);
  await loadThreads();
}

/** Codex lists the chat as archived, or can't say (then it is treated as still archived, so nothing is lost). */
async function stillArchivedInCodex(threadId: string) {
  return archivedCodexThreads().then(
    (threads) => threads.some((t) => t.id === threadId),
    (error: unknown) => (noteIgnored('list the chats Codex has archived', error), true),
  );
}

/** Desktop control grants, takeover consent and any held desktop belong to the chat: archiving or deleting it drops them (every harness). */
function forgetDesktopAccess(threadId: string) {
  // best effort: the chat is going away either way
  native.computer?.forget?.(threadId)?.catch((error) => noteIgnored("forget a chat's desktop control grants", error));
}

export const deleteThread = (threadId: string) => {
  unarchiving.delete(threadId);
  return mutateArchive(threadId, () => runDelete(threadId));
};
async function runDelete(threadId: string) {
  // an archived chat ran its cleanup when it was archived; a chat on a machine has no worktree here (read before the delete drops its machine)
  const cwd = await chatFolderHere(threadId, get().threads[threadId]?.cwd ?? '');
  forgetDesktopAccess(threadId);
  closeOwnedPaneTabs(threadId);
  const said = deletionNote(threadId);
  const receipt = await native.chats.delete(threadId);
  acceptChatDeletion(receipt);
  if (cwd)
    // best effort: the chat is deleted; a failing cleanup script reports itself
    retireWorktree(cwd).catch((error) => noteIgnored("retire a deleted chat's worktree", error));
  await said(receipt);
}

/** Why a message can't be edited: it ran on an earlier harness (D-40), or its harness has no checkpoint for it. */
export function editBlockedFor(s: AppState, chatId: string, turnId: string): string | null {
  const idx = s.runtime[chatId]?.turns.findIndex((t) => t.id === turnId) ?? -1;
  if (!inCurrentSegment(s.segments[chatId], idx < 0 ? idx : chatTurnIndex(s.runtime[chatId], idx)))
    return 'Ran on an earlier harness · Fork from here instead';
  return HARNESS_TRAITS[chatFamily(chatId)].editNeedsCheckpoint ? editBlocked(turnId, s.runtime[chatId]?.checkpoints) : null;
}
export const editClaudeMessage = (chatId: string, turnId: string) => runtime().claudeEditMessage(chatId, turnId);

/** Whether the chat still shows `turnId` as a turn its harness named: the only point a fork from a message starts at. */
const forkPointHere = (chatId: string, turnId: string) =>
  !turnId.startsWith('pending-') && !!get().runtime[chatId]?.turns.some((t) => t.id === turnId);

/**
 * Fork a chat, through `turnId` when given ("Fork chat from here", D-62). A goal comes along without
 * carrying on by itself: the fork's next message owns it.
 */
export async function forkThread(chatId: string, turnId?: string) {
  // a message's button forks from its turn, read at the click: one no longer here (rewound, or not started yet) is
  // refused, never taken as a fork of the whole chat while the button said "from here"
  if (turnId !== undefined && !forkPointHere(chatId, turnId)) return void toast(MESSAGE_GONE);
  // a chat that switched harness forks every segment, so the fork is the whole conversation (#1941)
  return forkWithWorkspace(chatId, () =>
    (get().segments[chatId]?.length ?? 0) > 1
      ? runtime().forkSwitchedChat(chatId, turnId, renameThread)
      : (viaSemantic(chatId, 'fork', turnId ?? '') as Promise<string | undefined>),
  );
}

/** Open a temporary side chat alongside the parent chat. */
const forkSideChat = createSideChat({
  nativeOf,
  familyOf: nativeFamily,
  openHostSideChat,
  canReuse: canReuseHostSideChat,
  openClaudeSideChat: (...args) => runtime().openClaudeSideChat(...args),
  fork: (params, hold) => native.codex.fork(params, hold),
  inheritAccount: inheritCodexPin,
  addThread: (thread) => set((s) => ({ threads: { ...s.threads, [thread.id]: thread } })),
  setDraft,
  selectionAttachment,
  hold: (id) => held.add(id),
  markLoaded: (id) => patchRuntime(id, () => ({ loaded: true, loading: false, turns: [] })),
  getPaneTabs: (chatId) => chatTabsFor(get(), chatId),
  getWindowTabs: () => get().paneTabs,
  getPaneActive: () => get().paneActive,
  getDraft: (id) => get().drafts[id],
  addSelection: (id, text) => dispatchComposerSelection(window, id, text),
  focusPane: (tabId, threadId, chatId) => {
    const s = get();
    const tab = chatTabsFor(s, chatId).find((t) => t.id === tabId)!;
    const parked = parkChatPane(s, tab);
    if (parked) return set(parked);
    set((s) => ({ paneActive: tabId, diffPanel: { ...s.diffPanel, open: true }, paneFull: false }));
    requestAnimationFrame(() => dispatchComposerFocus(window, threadId));
  },
  openPane: (id, chatId, replaceTabId) => openPaneTab('chat', { threadId: id, sourceChatId: chatId }, replaceTabId),
  toast,
});

export const openSideChat = (...args: Parameters<typeof forkSideChat>) => forkWithWorkspace(args[0], () => forkSideChat(...args));

/* ------------------------------------------------------------------ */
/* background terminals and sub-agents (WP5-7)                         */
/* ------------------------------------------------------------------ */
/** Commands a chat left running in the background, where its harness lists them (Claude Code's are session tasks). */
export async function listBackgroundTerminals(chatId: string): Promise<BackgroundTerminal[]> {
  if (!HARNESS_TRAITS[chatFamily(chatId)].backgroundTerminals || blockedReason(chatId, 'tasks')) return [];
  // unread: none listed this time; the summary panel asks again on its next refresh
  return backgroundTerminals(
    await codexApi.backgroundTerminals(chatId).catch((error) => (noteIgnored("list a Codex chat's background terminals", error), null)),
  );
}

/** Stop one of them (by the app-server's process id: osPid can be null). */
export async function terminateBackgroundTerminal(chatId: string, processId: string): Promise<boolean | 'retired'> {
  try {
    const r = await withLease<ThreadBackgroundTerminalsTerminateResponse>(chatId, 'thread/backgroundTerminals/terminate', { processId });
    // the process had ended already: nothing to stop (liveAction says so)
    return r?.terminated === false ? 'retired' : !!r?.terminated;
  } catch (e) {
    toast(`Couldn't stop it: ${errorText(e)}`, 'error');
    return false;
  }
}

/** Sub-agents' threads open read-only: the parent's turn runs them, not this window. */
export const subThreads = new Set<string>();

/** Open a sub-agent's thread beside the chat, read-only. */
export function openSubThread(threadId: string, title?: string) {
  subThreads.add(threadId);
  const s = get();
  const tab = s.paneTabs.find((t) => t.kind === 'chat' && t.threadId === threadId);
  if (tab) return set({ paneActive: tab.id, diffPanel: { ...s.diffPanel, open: true } });
  openPaneTab('chat', { threadId, readOnly: true, title: title ?? 'Sub-agent' });
  showThread(threadId);
}

/** Compact the chat's context; a basic harness does it through the command it lists, or says why it can't (its caps). */
export async function compactThread(threadId: string, args = '') {
  return (await viaSemantic(threadId, 'compact', args)) ?? false;
}

/** Drop a turn and every later one from a Codex chat, so its message can be edited and sent again. */
export async function revertThread(chatId: string, beforeTurnId: string): Promise<boolean> {
  const nid = nativeOf(chatId);
  // the folder's files go back first, asked; then the conversation
  const files = await restoreTurnFiles(chatId, nid, beforeTurnId);
  if (!files.go) return false;
  const { method, params } = revertRequest(nid, beforeTurnId);
  const r = await withLease(chatId, method, params);
  if (r === undefined) {
    // the conversation stayed: so do its files
    await files.restored?.undo();
    return false;
  }
  const { restored } = files;
  if (restored)
    toast(`Restored ${restored.count === 1 ? '1 file' : `${restored.count} files`}`, 'info', {
      action: { label: 'Undo', run: () => void restored.undo() },
    });
  else if (files.note) toast(files.note, 'info');
  // the response's thread has no turns; trim the ones already on screen
  if (nativeOf(chatId) !== nid) return false;
  patchRuntime(chatId, (rt) => rewindTurns(rt.turns, beforeTurnId));
  return true;
}

/** A new chat in a folder on a first-tier harness. */
const START_IN: Record<HarnessId, (o: { cwd: string; projectId?: string | null }) => string | Promise<string>> = {
  codex: (o) => startThread(o),
  claude: (o) => runtime().startClaudeThread(o),
};
/** A new chat in a folder on the harness new chats start on: Codex, or Claude Code when Codex can't run. */
export async function startDefaultChat(cwd: string, projectId?: string | null): Promise<string> {
  return START_IN[newChatHarness()]({ cwd, projectId });
}

/** A review in an existing chat, per harness. Resolves the chat's id, or false when the harness didn't take it. */
const REVIEW_IN: Record<HarnessFamily, (id: string, target: ReviewAsk) => Promise<string | false>> = {
  codex: codexReview,
  // typed /review <args> is the CLI's own /code-review with those args; the menu targets are plain-words asks.
  // false: main didn't take it, and the composer that ran it keeps what was typed
  claude: async (id, target) => ((await sendMessage(id, claudeReviewMessage(target))) === false ? false : id),
  // a basic harness reviews through the /review it lists; one that lists none says why (its caps)
  acp: async (id, target) => {
    const r = await runSemantic(id, 'review', reviewArgs(target));
    if (r.ok === true) return id;
    toast(refusalText(r, 'review'), 'error');
    return false;
  },
};
/** A review in a new chat, on the harness new chats start on. */
const REVIEW_NEW: Record<HarnessId, (target: ReviewAsk) => Promise<string | false>> = {
  codex: async (target) => {
    const id = await startThread({ cwd: currentCwdForNewChat() });
    navigate({ name: 'thread', id });
    return codexReview(id, target);
  },
  // Codex can't run: the review is a Claude Code chat
  claude: async (target) => {
    const id = runtime().startClaudeThread({ cwd: currentCwdForNewChat() });
    navigate({ name: 'thread', id });
    // the page that asked is gone: one main didn't take waits in the new chat's composer
    await sendOrDraft(id, claudeReviewPrompt(target));
    return id;
  },
};

/** Start a review in the chat, or a new one. Resolves the chat's id, or false when main refused the review ask for `threadId`. */
export async function startReview(threadId: string | null, target: ReviewAsk) {
  if (threadId) {
    // what it reviews, for its findings' Changes scope and for running it again
    set((s) => ({ reviewTargets: { ...s.reviewTargets, [threadId]: target } }));
    return REVIEW_IN[chatFamily(threadId)](threadId, target);
  }
  // a review in a new chat runs on the first tier (a basic harness lists its /review only once its session is up),
  // so what that harness has turned off is checked there
  const h = newChatHarness();
  const off = harnessBlocked(h, 'review');
  if (off) return toast(off, 'error'), false;
  return REVIEW_NEW[h](target);
}

async function codexReview(id: string, target: ReviewAsk): Promise<string> {
  const { method, params } = reviewRequest(nativeOf(id), target as ReviewTarget);
  const r = await withLease<ReviewStartResponse>(id, method, params);
  if (!r) return id;
  if (r.turn) patchRuntime(id, (rt) => ({ turns: [...rt.turns, turnFromServer(r.turn)], activeTurnId: r.turn.id }));
  return id;
}
