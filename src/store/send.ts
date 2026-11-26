// Sending messages and the turn and goal events main reports for them. @store-slice: tests' store stub replaces it whole (tests/support/stubs.ts).

import { acceptSendReceipt, usedReceipt, type SendReceipt } from '../../shared/sendReceipt.mjs';
import { userInput } from '../../shared/userInput.mjs';
import type { UserInput } from '../protocol/v2/UserInput';
import { codexApi } from '../harness/adapters/codexApi';
import { chatProxy } from '../harness/adapters/proxy';
import { native, type CodexItem } from '../lib/native';
import { errorText, ignoring, noteIgnored } from '../lib/ignored';
import { withQueued } from '../lib/queued';
import { dispatchComposerText } from '../lib/composerEvents';
import type { Attachment, ThreadItem, StatusNoteItem } from './types';
import { importSource } from '../lib/codexImportSource';
import { flushSessionPatches, sessionOf, setSession } from './session/useSession';
import { rememberSideChatBlock } from './hostSideChat';
import { turnBusy } from './session/sessionState';
import { isRunningTask } from '../lib/tasks';
import { get, set, toast, patchRuntime, newTurn, patchTurn, setDraft, touchChat } from './core';
import { modelChangeNote, setLastModel, nativeOf, chatKind } from './chats';
import type { HarnessKind } from '../harness/adapter';
import { turnsAboveAfterSwitch } from './turnPages';
import { modelLabel } from '../lib/format';
import { codexChatSelection } from '../harness/codexSettings';
import { effectiveModel } from '../../shared/modelChoice.mjs';
import { shouldHold, hold, onLease, setElsewhere } from './threads';
import { unhideFolder, setChatConfig } from './projects';
import { setGoalState } from './actions';
import { flushStreamNotifications, onNotification, onServerRequest } from './notifications';
import { addPendingTurn } from './pendingTurns';
import { interrupt, stopOnStart, stopSeenTurns } from './stop';
import { settleEarlyTurn, showEarlyTurn } from './earlyTurn';
import { rememberSentImages } from '../lib/sentImages';
import { nameAtSend } from './nameAtSend';
import { runtime } from './runtime';
import { createChatThread, createHostChatThread, startNewChat, type NewChat } from './chatCreation';
export { createChatThread, createHostChatThread, startNewChat, type NewChat };
import { onMachineNow } from '../lib/hostChats';
import { cloudSidebarAccount } from '../lib/cloudSidebarAccount';
import { environmentRepository } from '../../shared/sidebarRepository.mjs';
import { TEXT_METHODS } from '../../shared/streamDelta.mjs';

/** A typed message and its attachments as the input the turn shows (shared/userInput.mjs, as main shows and sends them). */
export const buildInput = (text: string, attachments: Attachment[]) => userInput(text, attachments) as UserInput[];

export interface SendOptions {
  hostPermission?: import('../../shared/host/permissions.mjs').HostPermissionPick;
  hostSelection?: import('../../shared/host/models.mjs').HostModelPick;
  audioTransfer?: string;
  /** Transient Retry admission: the proxy puts this beside the input, never in persisted queue options. */
  retryAtRevision?: number;
  chromeHandoff?: import('../../shared/chromeHandoff.mjs').HandoffPrecondition;
  plan?: boolean;
  /** The plan button's displayed item; main verifies it against the latest native transcript before granting authority. */
  acceptedPlan?: { itemId: string; text: string };
  goal?: string;
  /** per-turn overrides (scheduled tasks) */
  model?: string;
  effort?: string;
  /** hidden <sage-handoff> block sent before the text (mid-chat switch) */
  prefix?: string;
  /** status note heading the turn (switch divider) */
  note?: { kind: string; text: string; handoff?: string };
  /** the user typed it (Claude: sent with origin human); unset for text Sage writes itself */
  human?: boolean;
  /** Override the follow-up preference: true steers where supported; false explicitly queues. */
  steer?: boolean;
}

/** "Keep imports in sync": re-import new items from sources the user already imported. */
export async function syncImports() {
  const { prefs } = get();
  if (!prefs.importSync || !prefs.importedSources?.length) return;
  try {
    const r = await codexApi.externalConfigDetect(get().projects.map((p) => p.path));
    const items = (r.items ?? []).filter((it) => prefs.importedSources.includes(importSource(it).id));
    if (items.length) await codexApi.externalConfigImport(items);
  } catch (error) {
    // a background re-import: the next connect tries again, and Settings shows its own import errors
    noteIgnored('re-import from the sources kept in sync', error);
  }
}

let cloudRead = 0;

export async function loadCloudTasks() {
  const account = cloudSidebarAccount(get());
  const read = ++cloudRead;
  const current = () => read === cloudRead && account === cloudSidebarAccount(get());
  try {
    const r = await native.cloud.list();
    if (!current() || r.error || !Array.isArray(r.tasks)) return;
    const tasks = r.tasks.filter((task) => task && typeof task.id === 'string' && task.id);
    const previous = get().cloudSidebar;
    const shown = get().cloudTasks;
    if (previous?.account !== account || JSON.stringify(shown) !== JSON.stringify(tasks)) {
      set({ cloudTasks: tasks, cloudSidebar: previous?.account === account ? previous : { account, environments: [] } });
    }
    if (get().account?.type !== 'chatgpt' && !tasks.some((task) => typeof task.environment_id === 'string')) return;
    const catalog = await native.cloud.envs();
    const known = get().cloudSidebar;
    if (!current() || catalog.error || !Array.isArray(catalog.envs) || !known) return;
    if (JSON.stringify(known.environments) === JSON.stringify(catalog.envs)) return;
    const origins = new Map(known.environments.map((env) => [env.id, environmentRepository(env)]));
    const reconfigured = new Set(
      catalog.envs.filter((env) => origins.get(env.id) && origins.get(env.id) !== environmentRepository(env)).map((env) => env.id),
    );
    const unplacedTasks = new Set(known.unplacedTasks);
    for (const task of shown) if (task.environment_id && reconfigured.has(task.environment_id)) unplacedTasks.add(task.id);
    const loaded = tasks.flatMap((task) => (unplacedTasks.has(task.id) ? [task.id] : []));
    set({ cloudSidebar: { account, environments: catalog.envs, unplacedTasks: loaded } });
  } catch (error) {
    if (current()) noteIgnored('list the cloud tasks or environments', error);
  }
}

/** Who hears of a message main took, with the harness it runs on (src/session/newChatStart.ts remembers it for new chats). */
const sentListeners = new Set<(chatId: string, kind: HarnessKind) => void>();
export function onMessageSent(listener: (chatId: string, kind: HarnessKind) => void): () => void {
  sentListeners.add(listener);
  return () => void sentListeners.delete(listener);
}

/**
 * Sends, queues or holds the message. Resolves false when main didn't take it (the user was told), so a
 * caller holding the text can keep it.
 */
export async function sendMessage(
  threadId: string | null,
  text: string,
  attachments: Attachment[] = [],
  opts: SendOptions = {},
  handoffReceipt?: (receipt: SendReceipt) => void,
): Promise<boolean | void> {
  const s = get();
  rememberSentImages(attachments);
  if (opts.goal && !threadId && s.newChatTemporary) return toast("Temporary chats can't have goals", 'error'), false;
  let id = threadId;
  let unname = (): void => undefined;
  if (!id) {
    id = await createChatThread(text.split('\n')[0]);
    // createChatThread said why the chat didn't start
    if (!id) return false;
    unname = nameAtSend(id, text);
    // cannot reject: a write main didn't confirm reads main's copy again and resolves false
    if (opts.plan) void setSession(id, { plan: true });
  }
  // a chat started "with summary" sends the handoff block with its first message
  const carry = get().handoffCarry[id];
  if (carry) {
    set((st) => ({ handoffCarry: Object.fromEntries(Object.entries(st.handoffCarry).filter(([k]) => k !== id)) }));
    // a prefix of the send's own comes after it, so neither is lost
    opts = { ...opts, prefix: opts.prefix ? `${carry.text}\n\n${opts.prefix}` : carry.text };
  }
  const hostPermission = get().chatConfig[id]?.hostPermission;
  if (hostPermission && onMachineNow(id)) opts = { ...opts, hostPermission };
  const hostSelection = get().chatConfig[id]?.hostSelection;
  if (hostSelection && onMachineNow(id)) opts = { ...opts, hostSelection };
  // another app has the chat: keep the message until it lets go, or the user says to send it here
  const ss = sessionOf(id);
  if (!ss.pendingSwitch && !turnBusy(ss) && !get().runtime[id]?.activeTurnId && shouldHold(id)) {
    // Conditional Retry cannot become delayed input or merge repeatedly into a writer-locked chat's held message.
    if (opts.retryAtRevision !== undefined) {
      toast('This chat is open in another app. Your message was not sent again.', 'info');
      return false;
    }
    return hold(id, text, attachments, opts);
  }
  // main's ChatController starts it, or queues it (with all its options) while a turn runs
  const chatId = id;
  // A send that carries a switch waits in main for the switch (history, Git, the new session) before any harness
  // shows the message: show it now, as a normal send does, and let the harness's turnStarting adopt it (#1663).
  // A chat on a machine shows its message at once too: the machine's turn start can be seconds away (it uploads the pictures and starts the agent first).
  const idle = !turnBusy(ss) && !get().runtime[id]?.activeTurnId;
  // (while the app has not read which chats are on machines, it may be one: the message shows at once rather than after the machine's reply)
  const onMachine = onMachineNow(id);
  const early = idle && (ss.pendingSwitch || onMachine) ? crypto.randomUUID() : null;
  // the harness this message runs on, read before main takes the switch it carries
  const kind = ss.pendingSwitch?.harness ?? chatKind(chatId);
  if (early) showEarlyTurn(chatId, early, buildInput(text, attachments));
  return chatProxy
    .send(
      chatId,
      text,
      attachments,
      opts,
      opts.steer === undefined ? s.prefs.followUp : opts.steer ? 'steer' : 'queue',
      ...((early ? [early] : []) as [string?]),
    )
    .then((receipt) => {
      const error = acceptSendReceipt(receipt);
      if (opts.chromeHandoff) handoffReceipt?.(receipt);
      // started: the harness adopts the message; kept in the queue with a reason: it shows as failed; else the queue shows it
      // (a Stop that took the start over, 'turn_changed', is no failure to explain: the queue shows the message)
      // a message a machine keeps (away, refused) is in the queue with its own words: the copy goes
      if (early && receipt.action !== 'started') settleEarlyTurn(chatId, early, onMachine || error === 'turn_changed' ? null : error);
      // the early copy shows the reason as a failed turn, with what to do
      // a Host's refusal is said by the queue row (with its fix), so it is not said again in a toast
      if (error && (!early || onMachine) && (receipt as { waitingFor?: string }).waitingFor !== 'hostRefused')
        toast(`Couldn't send: ${error}${error.includes('kept in the queue') ? '' : ' Your message is kept in the queue.'}`, 'error');
      if (usedReceipt(receipt)) for (const listener of sentListeners) listener(chatId, kind);
      return true;
    })
    .catch((e) => {
      // not sent: the text goes back to the caller, so the message is not shown here too
      if (early) settleEarlyTurn(chatId, early, null);
      unname();
      // not sent: the summary waits with the message the user sends again, rather than being lost with this try
      if (carry && !get().handoffCarry[chatId]) set((st) => ({ handoffCarry: { ...st.handoffCarry, [chatId]: carry } }));
      toast(`Couldn't send: ${errorText(e)}`, 'error');
      return false;
    });
}

/**
 * sendMessage for a message the user asked for without typing it in a composer (a review, a note on a denied
 * approval, a voice chat's context): when main doesn't take it (sendMessage said why), it waits in the chat's
 * composer to send again, after anything typed there already. Resolves like sendMessage.
 */
export async function sendOrDraft(chatId: string, text: string, opts: SendOptions = {}): Promise<boolean | void> {
  const sent = await sendMessage(chatId, text, [], opts);
  if (sent === false) giveBackToComposer(chatId, text);
  return sent;
}

/**
 * Text (and attachments) for the user to send: the chat's composer when it is on screen, else its saved draft, in both
 * cases after anything already there, never over it. Text that didn't go out comes back this way; `null` is the new
 * chat's box (the Chrome extension's Try it).
 */
export function giveBackToComposer(chatId: string | null, text: string, attachments: Attachment[] = [], prepend = false) {
  if (dispatchComposerText(window, chatId, text, attachments, prepend)) return;
  const key = chatId ?? 'home';
  const draft = get().drafts[key];
  if (prepend) return setDraft(key, { ...draft, ...withQueued(draft?.text ?? '', draft?.attachments ?? [], { text, attachments }) });
  const before = draft?.text ? `${draft.text}${draft.text.endsWith('\n') ? '' : '\n'}` : '';
  setDraft(key, { ...draft, text: before + text, attachments: [...(draft?.attachments ?? []), ...attachments] });
}

/* ------------------------------------------------------------------ */
/* Codex turns, as the adapter in main runs them                       */
/* ------------------------------------------------------------------ */
/** The message shows at once, in a turn of its own until Codex names it. */
function onTurnStarting(e: Extract<CodexItem, { kind: 'turnStarting' }>) {
  const { chatId, clientId, text, attachments } = e;
  const opts = e.opts as SendOptions;
  const optimistic: ThreadItem = {
    type: 'userMessage',
    id: `local-${clientId}`,
    clientId,
    content: buildInput(text, attachments),
  } as ThreadItem;
  const { prefs } = get();
  // this chat's own pick wins over the new-chat default (same order as Claude's send), so a model change shows in the chat
  const model = effectiveModel(
    opts.model ?? codexChatSelection(prefs, get().chatConfig[chatId]).model,
    get().models.find((m) => m.isDefault)?.model,
    get().config?.model,
  );
  // the picker's name for it ("GPT-6.1 Sol"), never the raw id
  const named = get().models.find((m) => m.model === model)?.displayName ?? model;
  const label = named ? modelLabel(named) : '';
  const note = opts.note ?? modelChangeNote(chatId, model, label, !!e.mine);
  patchRuntime(chatId, (r) => ({
    turns: addPendingTurn(
      r.turns,
      {
        ...newTurn(`pending-${clientId}`),
        planMode: !!opts.plan,
        items: note
          ? [{ type: 'statusNote', id: `note-${clientId}`, ...note } satisfies StatusNoteItem as unknown as ThreadItem, optimistic]
          : [optimistic],
      },
      e.itemId,
    ),
    activeTurnId: `pending-${clientId}`,
    error: null,
  }));
}

function onTurnStarted(e: Extract<CodexItem, { kind: 'turnStarted' }>) {
  const { chatId, turnId, text } = e;
  const tempTurnId = `pending-${e.clientId}`;
  patchRuntime(chatId, (rt) => {
    const optimistic = rt.turns.find((x) => x.id === tempTurnId)?.items.find((i) => i.type === 'userMessage');
    let turns = rt.turns;
    if (turns.some((x) => x.id === turnId)) {
      // notification beat us; drop optimistic turn but keep user message if missing
      const real = turns.find((x) => x.id === turnId)!;
      const hasUser = real.items.some((i) => i.type === 'userMessage');
      turns = turns
        .filter((x) => x.id !== tempTurnId)
        .map((x) => (x.id === turnId && !hasUser && optimistic ? { ...x, items: [optimistic, ...x.items] } : x));
    } else {
      turns = turns.map((x) => (x.id === tempTurnId ? { ...x, id: turnId } : x));
    }
    return { turns, activeTurnId: rt.activeTurnId === tempTurnId ? turnId : rt.activeTurnId };
  });
  touchChat(chatId, { text });
}

function onTurnFailed(e: Extract<CodexItem, { kind: 'turnFailed' }>) {
  const tempTurnId = `pending-${e.clientId}`;
  stopOnStart.delete(nativeOf(e.chatId));
  stopSeenTurns.delete(nativeOf(e.chatId));
  patchRuntime(e.chatId, (rt) => ({
    turns: rt.turns.map((x) => (x.id === tempTurnId ? { ...x, status: 'failed', error: { message: e.error } } : x)),
    activeTurnId: rt.activeTurnId === tempTurnId ? null : rt.activeTurnId,
  }));
}

/**
 * Main's answer to a steer: the message joins its turn. The app-server's own copy of it (the
 * userMessage item with this clientId) can arrive first, even with the turn's completion, since main
 * passes its notifications on before it handles the answer; then that copy is the message, and a
 * second one after the reply would hide the reply as the turn's answer.
 */
function onSteered(e: Extract<CodexItem, { kind: 'steered' }>) {
  patchTurn(e.chatId, e.turnId, (t) => {
    if (t.status !== 'inProgress' || t.items.some((i) => i.type === 'userMessage' && i.clientId === e.clientId)) return {};
    return {
      items: [
        ...t.items,
        {
          type: 'userMessage',
          id: `local-steer-${e.clientId}`,
          clientId: e.clientId,
          content: buildInput(e.text, e.attachments),
        } as ThreadItem,
      ],
    };
  });
}

/** A goal's command shows as the user's message; thread/goal/set writes none. */
function onGoalStarting(e: Extract<CodexItem, { kind: 'goalStarting' }>) {
  const { chatId, clientId } = e;
  const bubble: ThreadItem = {
    type: 'userMessage',
    id: `local-${clientId}`,
    clientId,
    content: buildInput(`/goal ${e.objective}`, []),
  } as ThreadItem;
  const running = get().runtime[chatId]?.activeTurnId;
  if (running) patchTurn(chatId, running, (t) => ({ items: [...t.items, bubble] }));
  else
    patchRuntime(chatId, (r) => ({
      turns: [...r.turns, { ...newTurn(`pending-${clientId}`), items: [bubble] }],
      activeTurnId: `pending-${clientId}`,
      error: null,
    }));
}
function onGoalFailed(e: Extract<CodexItem, { kind: 'goalFailed' }>) {
  const tempTurnId = `pending-${e.clientId}`;
  const id = `local-${e.clientId}`;
  patchRuntime(e.chatId, (r) => ({
    turns: r.turns
      .filter((t) => t.id !== tempTurnId)
      .map((t) => (t.items.some((i) => i.id === id) ? { ...t, items: t.items.filter((i) => i.id !== id) } : t)),
    activeTurnId: r.activeTurnId === tempTurnId ? null : r.activeTurnId,
  }));
}

/** main settled a harness switch: the chat now runs on the target's model, with none of the previous harness's per-chat settings */
function onSwitched(e: Extract<CodexItem, { kind: 'switched' }>) {
  if (e.fresh) runtime().markNewClaudeSession(e.key);
  patchRuntime(e.chatId, (r) => ({ settings: { model: e.model, effort: null }, ...turnsAboveAfterSwitch(r, e.start) }));
  setLastModel(e.chatId, e.model);
}

export function onCodexItem(e: CodexItem) {
  // anything but a streamed delta lands after the text held before it, then the session patches main sent before it
  // (a crash, #2847): both wait for the frame otherwise
  if (e.kind !== 'notification' || !TEXT_METHODS.has(e.method)) {
    flushStreamNotifications();
    flushSessionPatches();
  }
  switch (e.kind) {
    case 'notification': {
      onNotification(e.method, e.params);
      const nid = (e.params as { threadId?: string }).threadId ?? '';
      const chat = stopOnStart.get(nid);
      // a turn that ended unseen takes its Stop with it, so the chat's next turn is not stopped
      if (!chat || (e.method !== 'turn/started' && e.method !== 'turn/completed')) return;
      // a turn the window knew when the Stop was queued (the previous, stopped one) can complete late: that is not the end of the
      // turn the Stop is for, and dropping the Stop here would leave the new turn running (#3896)
      if (e.method === 'turn/completed' && stopSeenTurns.get(nid)?.has((e.params as { turn: { id: string } }).turn.id)) return;
      stopSeenTurns.delete(nid);
      stopOnStart.delete(nid);
      if (e.method === 'turn/started') interrupt(chat).catch((err) => toast(`Couldn't stop: ${errorText(err)}`, 'error'));
      return;
    }
    case 'request':
      return onServerRequest(e.chatId, e.request);
    case 'lease':
      return onLease(e);
    case 'turnStarting':
      return onTurnStarting(e);
    case 'turnStarted':
      return onTurnStarted(e);
    case 'turnFailed':
      return onTurnFailed(e);
    case 'steered':
      return onSteered(e);
    case 'goalStarting':
      return onGoalStarting(e);
    case 'goalFailed':
      return onGoalFailed(e);
    case 'goal':
      return void setGoalState(e.chatId, e.goal ?? null).catch(ignoring("record a Codex chat's goal"));
    case 'locked':
      // another Codex client holds the chat: keep the message until it lets go
      setElsewhere(e.chatId, { app: 'codex', running: !!get().elsewhere[e.chatId]?.running, hard: true });
      return hold(e.chatId, e.item.text, e.item.attachments, e.item.opts as SendOptions);
    case 'leaseLocked':
      setElsewhere(e.chatId, { app: 'codex', running: !!get().elsewhere[e.chatId]?.running, hard: true });
      return toast('This chat is open in another Codex app. Close it there to change it here.', 'error');
    case 'chatStarted':
      return onRunChatStarted(e);
    case 'threadName':
      return set((st) =>
        st.threads[e.chatId] ? { threads: { ...st.threads, [e.chatId]: { ...st.threads[e.chatId], name: e.name } } } : {},
      );
    case 'toast':
      return toast(e.text, e.level);
    case 'switched':
      return onSwitched(e);
    case 'negotiated':
      return set({ codexCompat: e.negotiated });
  }
}

/** A scheduled run made a Codex chat in main: its own defaults, and the folder it came from when it runs in a worktree. */
function onRunChatStarted(e: Extract<CodexItem, { kind: 'chatStarted' }>) {
  unhideFolder(e.cwd);
  setChatConfig(e.chatId, e.config);
  if (e.worktreeOf) set((st) => ({ worktreeOf: { ...st.worktreeOf, [e.chatId]: e.worktreeOf! } }));
  patchRuntime(e.chatId, () => ({ loaded: true, loading: false }));
}

export function removeQueued(threadId: string, qid: string) {
  rememberSideChatBlock(threadId);
  return chatProxy.removeQueued(threadId, qid);
}
export function sendQueuedNow(threadId: string, qid: string) {
  return chatProxy.sendNow(threadId, qid);
}

/** Background tasks the chat's harness runs (only Claude reports them for now). */
export const stopAllTasks = (threadId: string) =>
  runtime().claudeStopAllTasks(threadId, [
    // each running task's own session (the chat's current one for a task that names none)
    ...new Set(
      sessionOf(threadId)
        .tasks.filter(isRunningTask)
        .map((t) => t.source?.key ?? nativeOf(threadId)),
    ),
  ]);
/** The multi-agent switch where it is a session setting (Claude's ultracode). */
export const setUltracode = (threadId: string, on: boolean) => runtime().setClaudeUltracode(threadId, on);

export { interrupt };
