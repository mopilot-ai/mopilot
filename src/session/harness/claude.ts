// Claude renderer live-session following, turn events and semantic actions; public service exports remain here.
import { native, type ClaudeEvent, type ClaudeSessionOpts } from '../../lib/native';
import { basename } from '../../lib/paths';
import { errorText, ignoring, noteIgnored, userError } from '../../lib/ignored';
import type { PendingRequest, Thread, ThreadItem, TurnState } from '../../store/types';
import type { ClaudeMeta } from '../../harness/requestParams';
import {
  useStore,
  get as getState,
  newTurn,
  patchRuntime,
  set as setState,
  threadTitle,
  toast,
  touchChat,
  upsertThread,
  setDraft,
  notify,
} from '../../store/core';
import { chatOf, modelChangeNote, nativeOf, suggestOtherHarness, chatFamily, accountNote } from '../../store/chats';
import { provisionalTitle } from '../../../shared/title.mjs';
import { buildInput } from '../../store/send';
import { selectionAttachment } from '../../lib/annotations';
import { openPaneTab } from '../../store/panes';
import { setElsewhere } from '../../store/threads';
import { unhideFolder, rememberChatProject, setChatConfig } from '../../store/projects';
import type { ChatGoal } from '../../store/types';
import { chatProxy } from '../../harness/adapters/proxy';
import { addPendingTurn } from '../../store/pendingTurns';
import { claudeAnswer, promptUuidOf, type ApprovalResult, type ClaudeAnswer } from '../../harness/claudeTranslate';
import { FAST_BLOCKED_TEXT, isClaudeAuthError, claudeSessionId, claudeThreadId } from '../../harness/types';
import { flushHeld, showMainItems } from './claude/items';
import type { TaskStopper } from '../../store/backgroundTasks';
export { parseUsageText } from '../../harness/claudeUsage';
export { refreshClaudeUsage } from './claude/usage';
export { setRemoteControl } from './claude/remoteControl';
export {
  refreshClaudeAccounts,
  switchClaudeAccount,
  useClaudeLoginTerm,
  endClaudeLoginTerm,
  addClaudeAccount,
  cancelClaudeLogin,
  reloginClaudeAccount,
  removeClaudeAccount,
  setClaudeAutoSwitch,
  pinClaudeChat,
  claudeChatAccount,
  recheckClaude,
  detectClaude,
  type LoginTerm,
} from './claude/accounts';
export {
  loadClaudeThreads,
  searchClaudeThreads,
  rememberClaudeThread,
  loadArchivedClaudeInfo,
  archivedCodexMissing,
  archivedClaudeThreads,
} from './claude/threads';
export { useClaudeCommands, useCommandProvider, useClaudeSkills } from './claude/catalog';
import { detectClaude, claudeChatAccount, markClaudeLoginLapsed, onAccountsEvent, setAccounts } from './claude/accounts';
import { inheritClaudeChat } from './claude/accounts';
import { claudeLiveUsage } from '../../../shared/claudeRateLimit.mjs';
import { noteLiveUsage } from './claude/usage';
import { catalogKey } from './claude/catalog';
import { sessionThread } from './claude/threads';
import { createClaudeFollowing, pollPresence } from './claude/following';
import { openLatestClaudeTurns, readClaudeTurns } from './claude/history';
import { createOwnSettingsSync } from '../../harness/claude/ownSettings';
import { ownInputsChanged } from '../../harness/claude/own';
import { startPresencePolling } from '../../harness/claude/presencePolling';
import { keepNewChatSelection, loadSessionSettings } from '../../harness/claude/chatSettings';
/** The window store as a chat's own settings read and write it (claude/chatSettings.ts). */
const chatStore = { getState, patchRuntime, setChatConfig };

/** Sessions Sage created this run, not yet written to disk (first send must not `resume`). */
const fresh = new Set<string>();

/** `sid`: the session id of a CLI main prewarmed for this chat (#1664), which already runs under it. */
export function startClaudeThread(opts: { cwd: string; projectId?: string | null; ephemeral?: boolean; sid?: string | null }): string {
  unhideFolder(opts.cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, '')); // a chat started in a folder removed from Projects brings it back
  const sid = opts.sid ?? crypto.randomUUID();
  const id = claudeThreadId(sid);
  fresh.add(id);
  // cannot reject: a registration that failed is recorded and answers false, and the first send reports its own failure
  void chatProxy.newClaudeSession(id, { cwd: opts.cwd, ephemeral: !!opts.ephemeral });
  const now = Math.floor(Date.now() / 1000);
  const t = {
    ...sessionThread({ sessionId: sid, summary: '', lastModified: Date.now(), cwd: opts.cwd }),
    projectId: opts.projectId ?? null,
    createdAt: now,
    updatedAt: now,
  } as Thread;
  // a temporary chat: unpersisted (persistSession false), out of the sidebar, on the account it starts on (D-9)
  if (opts.ephemeral) setState((s) => ({ threads: { ...s.threads, [id]: { ...t, ephemeral: true } } }));
  else upsertThread(t, true);
  rememberChatProject(id, opts.projectId, opts.ephemeral);
  if (!opts.ephemeral) keepNewChatSelection(chatStore, id);
  patchRuntime(id, () => ({ loaded: true, loading: false }));
  return id;
}

/** Main made a Claude chat: it shows like one started here; a durable fork (`history`) is read from disk on opening. */
function onChatStarted(e: Extract<ClaudeEvent, { kind: 'chatStarted' }>) {
  const id = e.chatId;
  unhideFolder(e.cwd.replace(/\/\.claude\/worktrees\/[^/]+.*$/, ''));
  if (!e.history) fresh.add(id);
  const now = Math.floor(Date.now() / 1000);
  upsertThread(
    {
      ...sessionThread({ sessionId: claudeSessionId(id), summary: '', lastModified: Date.now(), cwd: e.cwd }),
      createdAt: now,
      updatedAt: now,
    } as Thread,
    true,
  );
  if (e.worktreeOf) setState((st) => ({ worktreeOf: { ...st.worktreeOf, [id]: e.worktreeOf! } }));
  if (!e.history) patchRuntime(id, () => ({ loaded: true, loading: false }));
}

/** "Ask in side chat" for a Claude chat: a temporary fork in the right-hand pane, kept out of the sidebar. */
export function openClaudeSideChat(chatId: string, nativeId: string, selection?: string, replaceTabId?: string) {
  const sid = crypto.randomUUID();
  const id = claudeThreadId(sid);
  fresh.add(id);
  const src = getState().threads[chatId];
  inheritClaudeChat(chatId, id);
  // their first message forks this session, unpersisted, like Codex's ephemeral forks
  // cannot reject: a registration that failed is recorded and answers false, and the first send reports its own failure
  void chatProxy.newClaudeSession(id, { cwd: src?.cwd ?? null, ephemeral: true, forkFrom: claudeSessionId(nativeId) });
  const t = {
    ...sessionThread({ sessionId: sid, summary: '', lastModified: Date.now(), cwd: src?.cwd }),
    projectId: src?.projectId ?? null,
    ephemeral: true,
  } as Thread;
  setState((s) => ({ threads: { ...s.threads, [id]: t } }));
  if (selection) setDraft(id, { text: '', attachments: [selectionAttachment(selection)] });
  patchRuntime(id, () => ({ loaded: true, loading: false, turns: [] }));
  openPaneTab('chat', { threadId: id, sourceChatId: chatId }, replaceTabId);
  return id;
}

/** A session main created for a chat that switched to Claude Code: it has no transcript until its first message. */
export function markNewClaudeSession(nativeId: string) {
  fresh.add(nativeId);
}

/** A Claude session's whole history as turns, reported under the chat that owns it; `open`: main runs its turn, which stays open (#1838). */
export async function loadClaudeTurns(nativeId: string, chatId: string, cwd: string, open = false): Promise<TurnState[]> {
  if (fresh.has(nativeId)) return [];
  return (await readClaudeTurns(chatId, nativeId, cwd, { open })).turns;
}

export async function openClaudeThread(id: string) {
  if (fresh.has(id)) return patchRuntime(id, () => ({ loaded: true, loading: false }));
  return openLatestClaudeTurns(id, () => {
    follow(id);
    // both are optional details: the chat shows without them, and the next turn reads them again
    loadSessionSettings(chatStore, id, id, (nid) => live.has(nid)).catch(ignoring("show a Claude Code chat's model and effort"));
    refreshCheckpoints(id).catch(ignoring("show a Claude Code chat's file checkpoints"));
  });
}

/* ------------------------------------------------------------------ */
/* following a session another app is running                         */
/* ------------------------------------------------------------------ */
const { followed, follow, onScreen, syncFollowed, refreshFollowed, localWrite } = createClaudeFollowing({ fresh });

/* ------------------------------------------------------------------ */
/* turns                                                               */
/* ------------------------------------------------------------------ */
/** Settings the live CLI session was started with, so changes can be applied in place. */
const live = new Map<string, { model: string | null; effort: string | null; permission: string; fast: boolean; account: string }>();

/**
 * The message is shown at once, in a turn of its own until Claude names it. Main's ClaudeAdapter
 * (electron/harness/claude/adapter.cjs) decided what the turn runs with and sends it; this window only
 * shows it. Only the window the message came from gets this, like a Codex turn's turnStarting.
 */
function onTurnStarting(e: Extract<ClaudeEvent, { kind: 'turnStarting' }>) {
  const { chatId: threadId, clientId } = e;
  localWrite(threadId);
  const s = getState();
  const modelId = e.model;
  const modelLabel = s.claude.models.find((m) => m.id === modelId)?.label ?? modelId ?? '';
  const note = e.opts.note ?? modelChangeNote(threadId, modelId, modelLabel);
  const content = buildInput(e.text, e.attachments);
  const head: ThreadItem[] = note ? [{ type: 'statusNote', id: `note-${clientId}`, ...note } as unknown as ThreadItem] : [];
  const items = [...head, { type: 'userMessage', id: `local-${clientId}`, clientId, content } as ThreadItem];
  patchRuntime(threadId, (r) => ({
    turns: addPendingTurn(r.turns, { ...newTurn(`pending-${clientId}`), items }, e.itemId),
    activeTurnId: `pending-${clientId}`,
    error: null,
  }));
  // main keeps the login the turn started on (adapterSettings served) and every window hears it: none echoes it back (#2538)
}

function onTurnStarted(e: Extract<ClaudeEvent, { kind: 'turnStarted' }>) {
  const { chatId: threadId, key: nid } = e;
  live.set(nid, e.want);
  fresh.delete(nid);
  // another app has it open that the presence check hadn't caught yet: this message already went, so say what that means once
  if (e.elsewhere.length && !getState().elsewhere[threadId]) {
    setElsewhere(threadId, { app: e.elsewhere[0], running: false, hard: false });
    patchRuntime(threadId, () => ({ continueHere: true }));
  }
  const t = getState().threads[threadId];
  touchChat(threadId, { text: e.text });
  // main writes the title; until it arrives the chat is named after its first words
  if (!t?.name && !t?.ephemeral && nid === threadId) {
    const provisional = provisionalTitle(e.text);
    setState((st) =>
      st.threads[threadId] ? { threads: { ...st.threads, [threadId]: { ...st.threads[threadId], name: provisional } } } : {},
    );
  }
}

/** A steer that never reached Claude: it leaves the turn, and main sends it as the next turn. */
function onSteerFailed(e: Extract<ClaudeEvent, { kind: 'steerFailed' }>) {
  const opened = `ct-${e.clientId}`;
  patchRuntime(e.chatId, (r) => ({
    turns: r.turns.flatMap((t) =>
      t.id === opened ? [] : t.items.some((i) => i.id === e.clientId) ? [{ ...t, items: t.items.filter((i) => i.id !== e.clientId) }] : [t],
    ),
  }));
}

/** Stop one background task; the turn and the other tasks keep going (perTaskStopAffordance). False when it couldn't. */
export async function claudeStopTask(threadId: string, taskId: string, key = nativeOf(threadId)): Promise<boolean> {
  try {
    // main answers null when the chat has no running session: nothing was stopped
    if ((await native.claude.control(key, 'stopTask', taskId)) === null) {
      toast("This chat's Claude session isn't running, so the task can't be stopped from here", 'error');
      return false;
    }
    return true;
  } catch (e) {
    toast(`Couldn't stop the task: ${errorText(e)}`, 'error');
    return false;
  }
}

/** Send what runs in the foreground (a command, an agent) to the background; says so when nothing was running there. */
export async function claudeMoveToBackground(threadId: string): Promise<boolean> {
  try {
    const moved = await native.claude.control(nativeOf(threadId), 'backgroundTasks');
    if (!moved) toast('Nothing is running in the foreground');
    return !!moved;
  } catch (e) {
    toast(`Couldn't move it to the background: ${errorText(e)}`, 'error');
    return false;
  }
}

/** How the tasks pane stops a Claude chat's task (src/store/backgroundTasks.ts). */
export const stopClaudeTask: TaskStopper = (chatId, task) => claudeStopTask(chatId, task.id, task.source?.key);

/**
 * Stop every background task of a Claude chat; main stops each one best effort, so only the requests can fail.
 * `keys`: the sessions running the tasks. A task keeps the session that started it, so after a switch to another
 * harness the chat's earlier Claude session still runs its tasks; with none given, the chat's current session.
 */
export async function claudeStopAllTasks(threadId: string, keys: string[] = []) {
  const sessions = keys.length ? keys : [nativeOf(threadId)];
  try {
    // main answers null for a session that isn't running: nothing was stopped there
    const answers = await Promise.all(sessions.map((key) => native.claude.control(key, 'stopAllTasks')));
    if (answers.every((a) => a === null))
      toast("This chat's Claude session isn't running, so its tasks can't be stopped from here", 'error');
  } catch (e) {
    toast(`Couldn't stop the tasks: ${errorText(e)}`, 'error');
  }
}

/** Ultracode on or off for this chat's session; later effort changes keep it (electron/harness/claude/index.cjs). */
export async function setClaudeUltracode(threadId: string, on: boolean) {
  try {
    await native.claude.control(nativeOf(threadId), 'applyFlagSettings', { ultracode: on });
  } catch (e) {
    toast(`Couldn't change ultracode: ${errorText(e)}`, 'error');
  }
}

/** Stop: main pauses an active goal first, then interrupts; only main's `turnId` when given (else 'retired'). */
export async function claudeStop(threadId: string, turnId?: string) {
  try {
    return await chatProxy.stopClaude(threadId, turnId);
  } catch (e) {
    toast(`Couldn't stop: ${errorText(e)}`, 'error');
  }
}

/* ------------------------------------------------------------------ */
/* goals                                                               */
/* ------------------------------------------------------------------ */
// Claude Code runs "/goal" itself. Main's ClaudeAdapter keeps the goal bar's snapshot from the
// messages the CLI sends and holds a paused goal's condition, since the CLI has no pause of its own
// (shared/claudeGoals.mjs); the buttons only say what the user pressed.
const goalAction = chatProxy.claudeGoal;

/** Pause (or Stop, or the round limit): stop the loop, then clear the CLI's goal; Sage keeps the condition for Resume. */
export const claudePauseGoal = (chatId: string) => goalAction(chatId, 'pause');
/** Resume sends the condition again; "Goal set" from the CLI then restarts the round count. */
export const claudeResumeGoal = (chatId: string) => goalAction(chatId, 'resume');
/** "10 more rounds" on a goal paused at the round limit: resume it with a fresh limit of that many. */
export const claudeExtendGoal = (chatId: string) => goalAction(chatId, 'extend');
/** Clear: stop a running loop, clear the CLI's goal if it still has one, and forget the condition. */
export const claudeClearGoal = (chatId: string, human = false) => goalAction(chatId, 'clear', human);

export async function claudeRename(threadId: string, name: string) {
  await native.claude.rename(claudeSessionId(threadId), name);
}

/* ------------------------------------------------------------------ */
/* edit (rewind) and fork                                              */
/* ------------------------------------------------------------------ */
/** Which of the chat's messages can be rewound, from its transcript's file checkpoints. */
export async function refreshCheckpoints(chatId: string) {
  const nid = nativeOf(chatId);
  if (getState().threads[chatId]?.ephemeral || fresh.has(nid)) return;
  // unread: the checkpoints shown stay as they were, and the next turn reads them again
  const checkpoints = await native.claude
    .checkpoints(claudeSessionId(nid))
    .catch((error) => (noteIgnored("read a Claude Code chat's file checkpoints", error), null));
  if (checkpoints) patchRuntime(chatId, () => ({ checkpoints }));
}

/**
 * Edit-and-resend (D-68): list the files the rewind would restore, ask, restore them, and put the
 * message back in the composer; the next message goes on from just before it.
 */
export async function claudeEditMessage(chatId: string, turnId: string): Promise<boolean> {
  const uuid = promptUuidOf(turnId);
  if (!uuid) return false;
  const nid = nativeOf(chatId);
  const s = getState();
  const opts: ClaudeSessionOpts = {
    bin: s.prefs.claudeBin,
    sessionId: claudeSessionId(nid),
    resume: true,
    cwd: s.threads[chatId]?.cwd || s.home,
    account: claudeChatAccount(chatId),
    permission: s.prefs.permission,
  };
  try {
    const dry = await native.claude.rewind(nid, opts, uuid, true);
    if (!dry.canRewind) return toast(dry.error ?? "This message can't be rewound", 'error'), false;
    const files = dry.filesChanged ?? [];
    if (
      files.length &&
      !confirm(`Edit this message? These files go back to how they were before it:\n\n${files.map((f) => basename(f)).join('\n')}`)
    )
      return false;
    const r = await native.claude.rewind(nid, opts, uuid, false);
    if (!r.canRewind) return toast(r.error ?? "This message can't be rewound", 'error'), false;
  } catch (e) {
    return toast(`Couldn't edit: ${errorText(e)}`, 'error'), false;
  }
  // the process was replaced; the next one starts on the chat's current settings
  live.delete(nid);
  patchRuntime(chatId, (rt) => {
    const idx = rt.turns.findIndex((x) => x.id === turnId);
    return idx < 0 ? {} : { turns: rt.turns.slice(0, idx) };
  });
  return true;
}

/** Fork the chat; from a turn, the fork ends with that turn (forkSession upToMessageId, D-62). */
export async function claudeFork(threadId: string, turnId?: string): Promise<string> {
  const r = await native.claude.fork(claudeSessionId(threadId), turnId ? promptUuidOf(turnId) : null);
  const id = claudeThreadId(r.sessionId);
  const src = getState().threads[threadId];
  const projectId = src?.projectId ?? getState().chatProject[threadId] ?? null;
  upsertThread(
    {
      ...sessionThread({ sessionId: r.sessionId, summary: '', lastModified: Date.now(), cwd: src?.cwd }),
      name: src ? `${threadTitle(src)} (fork)` : null,
      projectId,
    } as Thread,
    true,
  );
  rememberChatProject(id, projectId);
  inheritClaudeChat(chatOf(threadId), id);
  return id;
}

/* ------------------------------------------------------------------ */
/* events from the main process                                        */
/* ------------------------------------------------------------------ */
/** Approval UI result (Codex decision shapes) → Agent SDK PermissionResult. */
export function resolveClaudeRequest(req: PendingRequest, result: unknown) {
  // what the answer needs rides in the card's params: main's SessionState holds the request (approvalRequests.ts)
  const p: ({ _claude?: ClaudeMeta } & Record<string, unknown>) | undefined = req.params;
  const meta = p?._claude;
  const input = meta?.input ?? {};
  let out: ClaudeAnswer;
  out = claudeAnswer(req.method, input, result as ApprovalResult | null | undefined, meta?.suggestions);
  // rejects when the answer did not reach main; resolveRequest says so and puts the card back
  return native.claude.permission(String(req.id), out);
}

function onEvent(e: ClaudeEvent) {
  // streamed text and held session patches land before an approval, an interrupt, a result or a session change; the event is never held
  if (e.kind !== 'message' || e.msg.type !== 'stream_event') flushHeld();
  // from main's adapter, not about one session
  if (e.kind === 'toast') return toast(e.text, e.level);
  // main moved the chat to another login and wrote it and the note (WP3-7); the login arrives with main's chats:changed,
  // never as this window's own change, so an echo can't undo a newer move (#2538)
  if (e.kind === 'accountSwitched') {
    accountNote(chatOf(e.key), e.note.text, e.note.id);
    return;
  }
  // nothing to move to on its own: offer the other harness (pay-per-use and other providers ask first, harness/billing.ts)
  if (e.kind === 'limitUnresolved') {
    if (e.reason === 'limit') suggestOtherHarness(chatOf(e.key), 'claude', false); // the translator owns the reset-time note
    return;
  }
  if (e.kind === 'goalNotice')
    return notify('goal', e.chatId, {
      title: threadTitle(getState().threads[e.chatId]),
      body: e.body,
      status: e.status as ChatGoal['status'],
    });
  // e.key is the native session; state updates go to the chat that owns it
  const nid = e.key;
  const threadId = chatOf(nid);
  switch (e.kind) {
    case 'message': {
      const m = e.msg;
      if (
        nid === nativeOf(threadId) &&
        !('parent_tool_use_id' in m && m.parent_tool_use_id) &&
        (m.type === 'assistant' || m.type === 'stream_event' || m.type === 'user' || m.type === 'result')
      )
        localWrite(threadId);
      const account = e.account ?? live.get(nid)?.account ?? claudeChatAccount(threadId);
      if (m.type === 'rate_limit_event') {
        if (e.login !== false) noteLiveUsage(account, claudeLiveUsage(m.rate_limit_info, Date.now()), e.serverAccount);
        return;
      }
      if (m.type === 'system' && m.subtype === 'init') {
        // Only a session that asked for fast mode reports a meaningful reason.
        if (live.get(nid)?.fast) {
          const r = m.fast_mode_disabled_reason ?? null;
          const blocked =
            r && FAST_BLOCKED_TEXT[r] ? r : m.fast_mode_state === 'on' ? null : (getState().claude.status.fastBlocked ?? null);
          if (blocked !== (getState().claude.status.fastBlocked ?? null))
            setState((s) => ({ claude: { ...s.claude, status: { ...s.claude.status, fastBlocked: blocked } } }));
        }
        setState((s) =>
          s.threads[threadId]
            ? { threads: { ...s.threads, [threadId]: { ...s.threads[threadId], status: { type: 'active', activeFlags: [] } } } }
            : {},
        );
      }
      if (m.type === 'result') {
        setState((s) =>
          s.threads[threadId] ? { threads: { ...s.threads, [threadId]: { ...s.threads[threadId], status: { type: 'idle' } } } } : {},
        );
        // the prompt that just ran has its file checkpoint now
        if (nid === nativeOf(threadId)) setTimeout(() => refreshCheckpoints(threadId), 300);
        // a chat Sage started has a transcript now: follow it like any other, for writes from other apps
        if (nid === threadId && onScreen().has(threadId) && !getState().threads[threadId]?.ephemeral) follow(threadId);
      }
      if (
        e.login !== false &&
        m.type === 'assistant' &&
        (m.error === 'authentication_failed' || (m.error && isClaudeAuthError(JSON.stringify(m.message?.content))))
      )
        // like a limit, main moves the chat to another login of the same billing type (electron/harness/claude/adapter.cjs)
        markClaudeLoginLapsed(account);
      return;
    }
    case 'elicitation':
    case 'permission':
      // the card is main's (SessionState approvals), and so is the notification
      return;
    case 'transcript':
      if (followed.has(threadId)) refreshFollowed(threadId).catch(ignoring('re-read a Claude Code transcript another app wrote'));
      return;
    case 'permissionCancelled':
      return;
    case 'chatStarted':
      return onChatStarted(e);
    case 'turnStarting':
      return onTurnStarting(e);
    case 'turnStarted':
      return onTurnStarted(e);
    case 'steerFailed':
      return onSteerFailed(e);
    case 'threadName':
      // the title main wrote replaces the provisional one, unless the chat was renamed meanwhile
      setState((st) =>
        st.threads[e.chatId] && (!st.threads[e.chatId].name || st.threads[e.chatId].name === e.provisional)
          ? { threads: { ...st.threads, [e.chatId]: { ...st.threads[e.chatId], name: e.name } } }
          : {},
      );
      return;
    case 'closed':
    case 'error': {
      live.delete(nid);
      setState((s) => ({
        // Approval routing follows main's SessionState; this source may be an older segment.
        threads: s.threads[threadId] ? { ...s.threads, [threadId]: { ...s.threads[threadId], status: { type: 'idle' } } } : s.threads,
      }));
      if (e.kind === 'error') toast(`Claude Code: ${userError(e.error, { who: 'It' })}`, 'error');
      return;
    }
  }
}

/**
 * Each chat's own picks, sent to main as they change (claude/own.ts); chatFamily is read late: the store imports this.
 */
const syncOwn = createOwnSettingsSync({ familyOf: (id) => chatFamily(id), send: (id, own) => chatProxy.claudeOwn(id, own) });

let started = false;
export function startClaude() {
  if (started) return;
  started = true;
  native.claude.onEvent(onEvent);
  showMainItems();
  native.claude.onAccountsEvent(onAccountsEvent);
  native.claude.onCatalog((e) => setState((s) => ({ claudeCatalogs: { ...s.claudeCatalogs, [catalogKey(e.account, e.cwd)]: e.catalog } })));
  // through the shared writer: the startup detection read the default login, so a login in use detects again
  native.claude.accounts().then(setAccounts, () => {
    /* detection refreshes the accounts, and main sends any change through onAccountsEvent */
  });
  // pollPresence records a failed scan itself; this is only applying what it found
  startPresencePolling(
    () => void pollPresence().catch(ignoring('mark the Claude Code chats other apps have open')),
    () => getState().focused,
  );
  // follow only what's on screen
  useStore.subscribe((s, prev) => {
    if (s.route !== prev.route || s.split !== prev.split || s.paneTabs !== prev.paneTabs) syncFollowed();
    if (ownInputsChanged(s, prev)) syncOwn(s, prev);
  });
  // a failed detection shows on the harness status (detectClaude); only its follow-up steps can fail here
  detectClaude().catch(ignoring('detect Claude Code at startup'));
}
