// Server requests (approvals) and the shared reducer for Codex-shaped notifications. @store-slice: tests' store stub replaces it whole (tests/support/stubs.ts).

import { isInvalidStreamNotification } from '../../shared/streamDelta.mjs';
import { limitNoteHome } from '../../shared/limitNotices.mjs';
import { retryAfterModelProgress } from '../lib/modelRetry';
import { isChatOutput } from '../lib/chatActivity';
import { contextReportOwner, contextUsageKey } from './contextUsage';
import { respondToCodex } from '../harness/adapters/codex';
import { errorText, ignoring } from '../lib/ignored';
import { sessionOf } from './session/useSession';
import { EMPTY_SESSION } from './session/sessionState';
import type { PendingRequest, ThreadItem, TurnState } from './types';
import { answerTaken } from './answerRetired';
import { turnFromServer } from '../../shared/codexTurns.mjs';
import { codexHookItem } from '../../shared/hookRuns.mjs';
import { requestsOf, type SessionApproval } from '../harness/approvalRequests';
import type { HarnessFamily } from '../harness/family';
import type { ServerNotification } from '../protocol/ServerNotification';
import type { GetAccountRateLimitsResponse } from '../protocol/v2/GetAccountRateLimitsResponse';
import { set, get, patchRuntime, upsertThread, patchTurn, patchItem, patchStreamedItem, toast, touchChat } from './core';
import { restartedTurn, settleOtherTurns } from './pendingTurns';
import { suggestOtherHarness, chatFamily, noteReportedWindow } from './chats';
import { reportFinishedTurn } from './turnUsage';
import { loadThreads, refreshAccount, refreshRateLimits } from './connection';
import { syncCodexProjects } from './projects';
import { setGoalState } from './actions';
import { answersNote } from './answersNote';
import type { AskedQuestion, QuestionResult } from '../lib/answeredQuestions';
import { visibleChats } from './split';
import { steeredMessages } from './turnPlan';
import { onArtifactPublished } from './artifactPanes';
import { outputCompletion } from './outputCompletion';
import { runtime } from './runtime';
import { createStreamNotifications } from '../lib/streamNotifications';

/* ------------------------------------------------------------------ */
/* server -> client requests (approvals, user input)                   */
/* ------------------------------------------------------------------ */
/**
 * An approval or user-input card. Main answers every other server request, once
 * (electron/capabilities/contract/serverRequests.cjs), and declines the ones from its hidden helper threads.
 */
export function onServerRequest(threadId: string | null, _req: { id: number | string; method: string; params: unknown }) {
  // the card itself comes from main's SessionState (syncPending), the same in every window
}

/** The approval cards are main's SessionState `approvals`; the list in `pending` follows them for every chat this window has a copy of. */
let lastApprovals: Record<string, unknown> = {};
export function syncPending(st: { sessions: Record<string, { approvals: SessionApproval[] }> }) {
  const changed = Object.keys(st.sessions).filter((id) => st.sessions[id].approvals !== lastApprovals[id]);
  lastApprovals = Object.fromEntries(Object.entries(st.sessions).map(([id, s]) => [id, s.approvals]));
  if (!changed.length) return;
  const now = Date.now();
  set((s) => {
    const rest = s.pending.filter((p) => !p.threadId || !changed.includes(p.threadId));
    const next = changed.flatMap((id) =>
      requestsOf(
        id,
        st.sessions[id].approvals,
        s.threads[id]?.cwd ?? null,
        s.pending.filter((p) => p.threadId === id),
        now,
      ),
    );
    return rest.length === s.pending.length && !next.length ? {} : { pending: [...rest, ...next] };
  });
}

/** Where a card's answer goes: the harness that raised it, read from the card itself (never a guess from a bare id). */
function sendAnswer(req: PendingRequest, result: unknown): Promise<boolean> {
  if (String(req.id).startsWith('cperm-')) return runtime().resolveClaudeRequest(req, result);
  if (req.method === 'acp/permission') return runtime().resolveAcpRequest(req, result);
  return respondToCodex(req.id, result);
}

/**
 * The user's answer to a card. Only a card this window still shows is answered, through the harness that raised it;
 * main takes it only while it still holds the card, and a retired one (answered in another window, withdrawn, its
 * harness restarted) says so instead of counting as delivered.
 */
export function resolveRequest(id: number | string, result: unknown) {
  const req = get().pending.find((p) => p.id === id);
  // gone already (a second click, main dropped it): nothing goes to any harness
  if (!req) return void answerTaken(false, toast);
  set((s) => ({ pending: s.pending.filter((p) => p.id !== id) }));
  const sent = sendAnswer(req, result).then((taken) => answerTaken(taken, toast));
  sent.then(
    // an answer that reached the agent is activity in its chat, on every harness, as in Claude Code
    (taken) => taken && req.threadId && touchChat(req.threadId),
    (error) => {
      // the card comes back, to answer again, only while main still has the approval: a handler can fail after
      // main took the answer, and a card for an approval main dropped could never be answered
      const open = req.threadId && sessionOf(req.threadId).approvals.some((a) => a.id === id);
      if (open) set((s) => (s.pending.some((p) => p.id === id) ? {} : { pending: [...s.pending, req] }));
      toast(`Couldn't send your answer: ${errorText(error)}`, 'error');
    },
  );
  // a question card's answers, once delivered, stay in the transcript as its answered-questions card (Codex's
  // request_user_input and Claude Code's AskUserQuestion alike); one that failed comes back to be answered again
  if (req.method === 'item/tool/requestUserInput' && req.threadId) {
    const chatId = req.threadId;
    const questions = (req.params as { questions?: AskedQuestion[] }).questions ?? [];
    sent.then((taken) => taken && answersNote(chatId, questions, result as QuestionResult), ignoring('keep the answered questions'));
  }
}

/* ------------------------------------------------------------------ */
/* notifications                                                       */
/* ------------------------------------------------------------------ */
/** Every chat this window shows: each of its panes' chats and the side chats in its side pane. */
export function onScreenNow(): Set<string> {
  const s = get();
  return new Set<string>([...visibleChats(s), ...s.paneTabs.map((t) => t.threadId ?? '')]);
}
/** An app-server notification's params, by method. */
type NotificationParams<M extends ServerNotification['method']> = Extract<ServerNotification, { method: M }>['params'];

/** Applies a notification at once; Claude and ACP translators batch their own deltas before this (lib/streamNotifications.ts). */
export function applyNotification(method: string, p: unknown, trackActivity = true) {
  applyNow(method, p, trackActivity);
}
/** What Codex shows: text, reasoning and output deltas once per frame, every other notification in order at once. */
const codexDisplay = createStreamNotifications(applyNow);
/** Delivers the Codex deltas held for the next frame now (before anything that replaces or reads a chat's turns). */
export const flushStreamNotifications = codexDisplay.flush;
/** A Codex notification, with its display deltas joined per frame. */
export function onNotification(method: string, params: unknown) {
  codexDisplay.emit(method, params as Record<string, unknown>);
}

/**
 * A notification under its chat's id: main maps a later segment's thread to the chat that owns it
 * and keeps its hidden helper threads' events to itself; Claude's translator reports the same way.
 */
function applyNow(method: string, params: unknown, trackActivity = true) {
  if (isInvalidStreamNotification(method, params)) return;
  // the fields most notifications share; each case below reads its own method's params
  const head = params as { threadId: string; turnId?: string; item?: { type?: string } };
  // A retry is over as soon as model output resumes, rather than at turn completion.
  const runtime = get().runtime[head.threadId];
  if (
    trackActivity &&
    isChatOutput(method, head.item?.type) &&
    head.turnId &&
    head.turnId === currentTurnId(head.threadId, runtime?.activeTurnId)
  )
    touchChat(head.threadId);
  if (runtime?.retry) {
    const retry = retryAfterModelProgress(runtime, method, head);
    if (retry !== runtime.retry) patchRuntime(head.threadId, () => ({ retry }));
  }
  switch (method) {
    case 'thread/started': {
      const p = params as NotificationParams<'thread/started'>;
      // ephemeral threads (side chats, helpers) stay out of the sidebar, as in the official app
      if (p.thread && !p.thread.ephemeral) upsertThread(p.thread, true);
      break;
    }
    case 'thread/status/changed': {
      const p = params as NotificationParams<'thread/status/changed'>;
      set((s) =>
        s.threads[p.threadId] ? { threads: { ...s.threads, [p.threadId]: { ...s.threads[p.threadId], status: p.status } } } : {},
      );
      break;
    }
    case 'thread/name/updated': {
      // `name`: what some senders use instead of threadName
      const p = params as NotificationParams<'thread/name/updated'> & { name?: string };
      set((s) =>
        s.threads[p.threadId]
          ? { threads: { ...s.threads, [p.threadId]: { ...s.threads[p.threadId], name: (p.threadName ?? p.name) as string | null } } }
          : {},
      );
      break;
    }
    case 'thread/archived':
    case 'thread/deleted': {
      const p = params as NotificationParams<'thread/archived' | 'thread/deleted'>;
      set((s) => ({ threadOrder: s.threadOrder.filter((x) => x !== p.threadId) }));
      break;
    }
    case 'thread/unarchived':
      loadThreads().catch(ignoring('list the Codex chats after one was unarchived'));
      break;
    case 'project/changed':
      syncCodexProjects().catch(ignoring("import Codex's projects after they changed"));
      break;
    case 'thread/project/updated': {
      const p = params as NotificationParams<'thread/project/updated'>;
      set((st) =>
        st.threads[p.threadId]
          ? { threads: { ...st.threads, [p.threadId]: { ...st.threads[p.threadId], projectId: p.projectId ?? null } } }
          : {},
      );
      break;
    }
    case 'thread/tokenUsage/updated': {
      const p = params as NotificationParams<'thread/tokenUsage/updated'> & { tokenUsageSource?: unknown };
      const owner = contextReportOwner(p.threadId, p.tokenUsageSource);
      if (owner && owner !== contextUsageKey(get().segments[p.threadId], p.threadId)) break;
      patchRuntime(p.threadId, () => ({
        tokenUsage: p.tokenUsage,
        tokenUsageOwner: owner,
      }));
      noteReportedWindow(p.threadId, p.tokenUsage?.modelContextWindow);
      break;
    }
    case 'thread/goal/updated': {
      const p = params as NotificationParams<'thread/goal/updated'>;
      setGoalState(p.threadId, p.goal).catch(ignoring("record a Codex chat's goal"));
      break;
    }
    case 'thread/goal/cleared': {
      const p = params as NotificationParams<'thread/goal/cleared'>;
      setGoalState(p.threadId, null).catch(ignoring("record that a Codex chat's goal was cleared"));
      break;
    }
    case 'turn/started': {
      const p = params as NotificationParams<'turn/started'>;
      const turn = p.turn;
      patchRuntime(p.threadId, (r) => {
        // the turn's token count starts from the chat's total now; a repeated start of the same turn keeps its own
        const turnStartTokens = r.activeTurnId === turn.id ? (r.turnStartTokens ?? null) : (r.tokenUsage?.total.totalTokens ?? null);
        const pendingIdx = r.turns.findIndex((t) => t.id.startsWith('pending-') && t.status === 'inProgress');
        // one turn runs at a time: whatever else is still marked running never got its end (settleOtherTurns)
        if (r.turns.some((t) => t.id === turn.id))
          return { turns: restartedTurn(r.turns, turn.id), activeTurnId: turn.id, retry: null, turnStartTokens };
        if (pendingIdx >= 0) {
          const turns = [...r.turns];
          turns[pendingIdx] = { ...turns[pendingIdx], id: turn.id };
          return { turns: settleOtherTurns(turns, turn.id), activeTurnId: turn.id, retry: null, turnStartTokens };
        }
        const turns = settleOtherTurns([...r.turns, { ...turnFromServer(turn), items: [] }], turn.id);
        return { turns, activeTurnId: turn.id, retry: null, turnStartTokens };
      });
      // any turn is activity, also one the user didn't send here (a goal's next round, another app's); Claude's and
      // the basic harnesses' translators report their turns here too
      touchChat(p.threadId);
      break;
    }
    case 'turn/completed': {
      const p = params as NotificationParams<'turn/completed'>;
      const turn = p.turn;
      patchRuntime(p.threadId, (r) => {
        const turns = r.turns.map((t) =>
          t.id === turn.id
            ? {
                ...t,
                status: turn.status,
                error: turn.error,
                completedAt: turn.completedAt ?? Date.now() / 1000,
                durationMs: turn.durationMs ?? (t.startedAt ? Date.now() - t.startedAt * 1000 : null),
                items: turn.items?.length && turn.itemsView === 'full' ? mergeItems(t.items, turn.items) : t.items,
              }
            : t,
        );
        return { turns, activeTurnId: r.activeTurnId === turn.id ? null : r.activeTurnId, retry: null };
      });
      onTurnFinished(p.threadId, turn);
      // the turn's last output (or its stop) is activity, as Claude Code's is, on every harness
      touchChat(p.threadId);
      // The account pool may move the chat to another Codex account and continue; suggest the other
      // harness only if nothing picked the chat back up.
      if (['usageLimitExceeded', 'rateLimitExceeded'].includes(turn.error?.codexErrorInfo as string)) {
        const tid = p.threadId;
        setTimeout(() => {
          const current = get().runtime[tid];
          // a rate-limit pause names no end of quota: the toast only, main does not switch for it
          if (!current?.activeTurnId && current?.turns.at(-1)?.id === turn.id)
            suggestOtherHarness(tid, 'codex', true, turn.error?.codexErrorInfo === 'rateLimitExceeded');
        }, 2500);
      }
      break;
    }
    case 'item/started': {
      const p = params as NotificationParams<'item/started'>;
      const { item, threadId, turnId } = p;
      patchTurn(threadId, turnId, (t) => {
        const times = { ...t.itemTimes, [item.id]: { start: p.startedAtMs ?? Date.now() } };
        if (item.type === 'userMessage') {
          // replace optimistic copy
          const idx = t.items.findIndex(
            (i) => i.type === 'userMessage' && i.id.startsWith('local-') && (!item.clientId || i.clientId === item.clientId),
          );
          if (idx >= 0) {
            const items = [...t.items];
            items[idx] = item;
            return { items, itemTimes: times };
          }
        }
        if (t.items.some((i) => i.id === item.id)) return { itemTimes: times };
        return { items: [...t.items, item], itemTimes: times };
      });
      break;
    }
    case 'hook/completed': {
      // Meaningful hook feedback is visible; raw exit summaries stay internal (shared/hookRuns.mjs). Main notes it too (hookNotes.cjs).
      const p = params as NotificationParams<'hook/completed'>;
      const item = codexHookItem(p.run);
      if (item && p.turnId) applyNow('item/completed', { threadId: p.threadId, turnId: p.turnId, item });
      break;
    }
    case 'item/completed': {
      const p = params as NotificationParams<'item/completed'>;
      const { threadId } = p;
      const { item, turnId } = limitNoteHome(get().runtime[threadId]?.turns ?? [], p.turnId, p.item);
      const afterOutput = outputCompletion(threadId, turnId, { item });
      patchTurn(threadId, turnId, (t) => {
        const times = { ...t.itemTimes, [item.id]: { start: t.itemTimes[item.id]?.start ?? Date.now(), end: Date.now() } };
        if (item.type === 'userMessage') {
          const idx = t.items.findIndex(
            (i) =>
              i.type === 'userMessage' &&
              (i.id === item.id || (i.id.startsWith('local-') && (!item.clientId || i.clientId === item.clientId))),
          );
          if (idx >= 0) {
            const items = [...t.items];
            items[idx] = item;
            return { items, itemTimes: times };
          }
        }
        const exists = t.items.some((i) => i.id === item.id);
        return {
          items: exists ? t.items.map((i) => (i.id === item.id ? item : i)) : [...t.items, item],
          itemTimes: times,
        };
      });
      onArtifactPublished(threadId, item);
      afterOutput();
      break;
    }
    case 'item/updated': {
      // a running item's new state (Claude's Agent card as its sub-agent works); not its end
      const { item, threadId, turnId } = params as { item: ThreadItem; threadId: string; turnId: string };
      patchTurn(threadId, turnId, (t) =>
        t.items.some((i) => i.id === item.id)
          ? { items: t.items.map((i) => (i.id === item.id ? item : i)) }
          : { items: [...t.items, item] },
      );
      break;
    }
    // each delta is one store commit: the item it extends is added in the same update (patchStreamedItem)
    case 'item/agentMessage/delta': {
      const p = params as NotificationParams<'item/agentMessage/delta'>;
      patchStreamedItem(p.threadId, p.turnId, p.itemId, AGENT_MESSAGE, (it) => ({ ...it, text: (it.text ?? '') + p.delta }));
      break;
    }
    case 'item/plan/delta': {
      const p = params as NotificationParams<'item/plan/delta'>;
      patchStreamedItem(p.threadId, p.turnId, p.itemId, { type: 'plan', text: '' }, (it) => ({ ...it, text: (it.text ?? '') + p.delta }));
      break;
    }
    case 'item/reasoning/summaryPartAdded': {
      const p = params as NotificationParams<'item/reasoning/summaryPartAdded'>;
      patchStreamedItem(p.threadId, p.turnId, p.itemId, reasoning(), (it) => ({ ...it, summary: padded(it.summary, p.summaryIndex) }));
      break;
    }
    case 'item/reasoning/summaryTextDelta': {
      const p = params as NotificationParams<'item/reasoning/summaryTextDelta'>;
      patchStreamedItem(p.threadId, p.turnId, p.itemId, reasoning(), (it) => {
        const summary = padded(it.summary, p.summaryIndex);
        summary[p.summaryIndex] += p.delta;
        return { ...it, summary };
      });
      break;
    }
    case 'item/reasoning/textDelta': {
      const p = params as NotificationParams<'item/reasoning/textDelta'>;
      patchStreamedItem(p.threadId, p.turnId, p.itemId, reasoning(), (it) => {
        const idx = p.contentIndex ?? 0;
        const content = padded(it.content, idx);
        content[idx] += p.delta;
        return { ...it, content };
      });
      break;
    }
    case 'item/commandExecution/outputDelta': {
      const p = params as NotificationParams<'item/commandExecution/outputDelta'>;
      patchStreamedItem(p.threadId, p.turnId, p.itemId, null, (it) => ({
        ...it,
        aggregatedOutput: (it.aggregatedOutput ?? '') + p.delta,
      }));
      break;
    }
    case 'item/fileChange/patchUpdated': {
      const p = params as NotificationParams<'item/fileChange/patchUpdated'>;
      if (p.changes) patchItem(p.threadId, p.turnId, p.itemId, (it) => ({ ...it, changes: p.changes }));
      break;
    }
    case 'item/mcpToolCall/progress': {
      const p = params as NotificationParams<'item/mcpToolCall/progress'>;
      patchItem(p.threadId, p.turnId, p.itemId, (it) => ({ ...it, progress: p.message }));
      break;
    }
    case 'turn/plan/updated': {
      const p = params as NotificationParams<'turn/plan/updated'>;
      // how many messages were steered into the turn: one more after it makes this the plan from before it
      patchTurn(p.threadId, p.turnId, (t) => ({ plan: { explanation: p.explanation, steps: p.plan, steered: steeredMessages(t) } }));
      break;
    }
    case 'turn/diff/updated': {
      const p = params as NotificationParams<'turn/diff/updated'>;
      const afterOutput = outputCompletion(p.threadId, p.turnId, { diff: p.diff });
      patchTurn(p.threadId, p.turnId, () => ({ diff: p.diff }));
      afterOutput();
      break;
    }
    case 'error': {
      const p = params as NotificationParams<'error'>;
      if (p.willRetry) {
        patchRuntime(p.threadId, () => ({ retry: p.error?.message ?? 'Reconnecting…' }));
      } else {
        patchRuntime(p.threadId, () => ({ retry: null }));
        patchTurn(p.threadId, p.turnId, () => ({ error: p.error }));
      }
      break;
    }
    case 'serverRequest/resolved':
      break;
    case 'account/updated':
      refreshAccount().catch(ignoring('read the Codex account after it changed'));
      break;
    case 'configWarning':
    case 'deprecationNotice': {
      const p = params as { summary: unknown; details?: unknown };
      const w = { summary: p.summary as string, details: (p.details as string | null) ?? null };
      set((st) => (st.configWarnings.some((x) => x.summary === w.summary) ? st : { configWarnings: [...st.configWarnings, w] }));
      break;
    }
    case 'account/rateLimits/updated': {
      const p = params as NotificationParams<'account/rateLimits/updated'>;
      set((s) => ({ rateLimits: { ...(s.rateLimits ?? {}), rateLimits: p.rateLimits } as GetAccountRateLimitsResponse }));
      break;
    }
    case 'account/login/completed': {
      const p = params as NotificationParams<'account/login/completed'>;
      // only the sign-in waited on ends here: one cancelled since (or replaced by a newer one) ends quietly
      const pending = get().loginPending;
      const current = !!pending && (!p.loginId || !pending.loginId || p.loginId === pending.loginId);
      if (current) set({ loginPending: null });
      if (p.success) {
        refreshAccount().catch(ignoring('read the Codex account after signing in'));
        toast('Signed in');
      } else if (current) toast(p.error ?? 'Sign in failed', 'error');
      break;
    }
    case 'thread/compacted':
      toast('Context compacted');
      break;
    case 'model/rerouted': {
      const p = params as NotificationParams<'model/rerouted'>;
      toast(`Model rerouted to ${p.toModel ?? 'another model'}`);
      break;
    }
    case 'skills/changed':
      window.dispatchEvent(new CustomEvent('skills-changed'));
      break;
    case 'warning': {
      // older app-servers send a summary
      const p = params as (NotificationParams<'warning'> & { summary?: string }) | null | undefined;
      if (p?.summary || p?.message) console.warn(method, p.summary ?? p.message);
      break;
    }
  }
}

function currentTurnId(chatId: string, displayed: string | null | undefined) {
  const session = sessionOf(chatId);
  return session === EMPTY_SESSION ? displayed : session.activeTurn?.id;
}

const AGENT_MESSAGE = { type: 'agentMessage', text: '', phase: null, memoryCitation: null, delivery: null };
/** A new reasoning item, with parts of its own. */
const reasoning = () => ({ type: 'reasoning', summary: [], content: [] });
/** A copy of a reasoning item's parts, long enough to hold `index`. */
function padded(parts: string[] | undefined, index: number) {
  const out = [...(parts ?? [])];
  while (out.length <= index) out.push('');
  return out;
}

function mergeItems(local: ThreadItem[], server: ThreadItem[]) {
  const byId = new Map(server.map((i) => [i.id, i]));
  const out = local.map((i) => byId.get(i.id) ?? i);
  for (const i of server) if (!out.some((o) => o.id === i.id)) out.push(i);
  return out;
}

/** What a finished turn refreshes: Codex's usage limits come from its app-server; Claude Code and a basic harness report their own. */
const AFTER_TURN: Record<HarnessFamily, (() => Promise<unknown>) | null> = { codex: refreshRateLimits, claude: null, acp: null };

function onTurnFinished(threadId: string, turn: { id: string; status?: TurnState['status'] }) {
  const s = get();
  reportFinishedTurn(threadId, turn);
  const active = s.diffPanel.open ? s.paneTabs.find((t) => t.id === s.paneActive) : null;
  const viewing = visibleChats(s).includes(threadId) || (active?.kind === 'chat' && active.threadId === threadId);
  if (!viewing) set((st) => ({ unread: { ...st.unread, [threadId]: true } }));
  // queued follow-ups are main's: the ChatController sends the next one when the turn ends
  AFTER_TURN[chatFamily(threadId)]?.().catch(ignoring('refresh the usage limits after a turn'));
}
