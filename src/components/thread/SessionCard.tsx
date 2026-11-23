// A session a chat started (or handed its task to), as a live card in that chat, on any harness: its title, what it is
// doing now or how it ended, and its state, kept current from main's linked sessions and the chat stores, as Claude
// Desktop's started-session card is. The whole card opens the session.
import { useEffect } from 'react';
import { useStore } from '../../store/core';
import { chatOf } from '../../store/chats';
import { chatAgentTabs } from '../../lib/agentTabs';
import { outsideLine } from './SessionUsage';
import { openChatFrom } from '../../session/openChat';
import { useOrchestration, waitingCaption } from '../../lib/sideSessions';
import { useChatRowState, useChatTurn } from '../../session/useChatRowState';
import type { ChatRowState } from '../../session/chatRowState';
import type { OrchestrationView, SideSessionEnding } from '../../../shared/orchestration';
import { Archive, ChevronRight, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from '../ui/icons';
import { SessionWork } from './SessionWork';
import { ShimmerSpan } from '../ui/ShimmerBand';

/** What the card says a session is doing (Claude Desktop's status words). */
export type SessionCardState =
  | 'starting'
  | 'queued'
  | 'waiting'
  | 'held'
  | 'working'
  | 'needsInput'
  | 'done'
  | 'failed'
  | 'idle'
  | 'notStarted'
  | 'archived';

export const STATE_WORD: Record<SessionCardState, string> = {
  starting: 'Starting…',
  queued: 'Queued',
  waiting: 'Waiting',
  held: 'Held',
  working: 'Working',
  needsInput: 'Needs input',
  done: 'Done',
  failed: 'Failed',
  idle: 'Idle',
  notStarted: 'Couldn’t start',
  archived: 'Archived',
};

/**
 * The card's state from what the window knows: a start that failed, a chat the window has not listed yet (starting),
 * one waiting behind its receiving session, else its row state (the sidebar dot's). An archived chat reads as such.
 */
export function sessionCardState(o: {
  row: ChatRowState | null;
  queued: boolean;
  archived: boolean;
  notStarted: boolean;
  waiting?: 'waiting' | 'held' | null;
  awaitingBrief?: boolean;
  /** how its last turn ended, as main recorded it: a chat the window doesn't list but that ran still says how */
  report?: SideSessionEnding | null;
  /** its ended turn left the user something to answer: a wrap-up question box, or a browser sign-in hand-off */
  asks?: boolean;
}): SessionCardState {
  if (o.notStarted) return 'notStarted';
  if (o.archived) return 'archived';
  if (o.awaitingBrief) return 'starting';
  if (o.waiting) return o.waiting;
  if (o.queued) return 'queued';
  if (o.asks && o.row !== 'working' && o.row !== 'elsewhereRunning') return 'needsInput';
  switch (o.row) {
    case null:
      return !o.report ? 'starting' : o.report === 'finished' ? 'done' : o.report === 'stopped' ? 'idle' : 'failed';
    case 'approval':
    case 'input':
      return 'needsInput';
    case 'error':
    case 'failed':
      return 'failed';
    case 'working':
    case 'elsewhereRunning':
      return 'working';
    case 'done':
      return 'done';
    default:
      return 'idle';
  }
}

/** The line under the title: what it is doing now while it works, else how its last turn ended, else `fallback`. */
export function sessionCaption(view: OrchestrationView, chatId: string, state: SessionCardState, fallback: string): string {
  if (view.children[chatId]?.awaitingBrief) return 'Writing the brief…';
  // the question it is waiting on, when its turn ended with one
  const ask = view.wrapUps?.[chatId]?.ask;
  if (state === 'needsInput' && ask) return ask;
  if (state === 'waiting' || state === 'held') return waitingCaption(view, chatId) ?? fallback;
  // a list from before the user's last message is not what it is doing now
  const plan = view.plans[chatId];
  const step = plan?.stale ? undefined : plan?.items.find((i) => i.status === 'in_progress')?.content;
  if ((state === 'working' || state === 'needsInput') && step) return step;
  const report = view.children[chatId]?.lastReport?.report?.split('\n')[0]?.trim();
  if (state === 'failed' && report) return report;
  // once it ends, the first line of how it ended: what a glance at the card should say
  if (state === 'done' || state === 'idle' || state === 'archived') return report ?? '';
  if (state === 'queued') return 'Queued for this session';
  return fallback;
}

/**
 * The one state blocked on the user right now (an approval, a question, a wrap-up question box, a sign-in hand-off):
 * what "needs you" counts and opens (SessionsCount.tsx, TaskSessions.tsx). Failed, held and couldn't-start sessions
 * went wrong but ask nothing; they are ATTENTION, never "needs you".
 */
export const NEEDS_USER: ReadonlySet<SessionCardState> = new Set(['needsInput']);

/** States that went wrong: counted apart from "needs you", and with it never folded away (SessionStack.tsx). */
export const WENT_WRONG: ReadonlySet<SessionCardState> = new Set(['failed', 'held', 'notStarted']);

/** States a stack never folds away and whose card the tab keeps out of Finished: needs you, or went wrong. */
export const ATTENTION: ReadonlySet<SessionCardState> = new Set([...NEEDS_USER, ...WENT_WRONG]);

/** The word that leads the caption, in its tone, for a state that needs the user; held's caption already says "Held:". */
const LEAD_WORD: Partial<Record<SessionCardState, 'warn' | 'danger'>> = { needsInput: 'warn', failed: 'danger' };

/** The dot at the card's end, one per state: moving, waiting its turn, needs you, went wrong, finished, settled. */
export const STATE_DOT: Record<SessionCardState, 'working' | 'queued' | 'needs' | 'failed' | 'done' | 'idle' | null> = {
  starting: 'working',
  working: 'working',
  queued: 'queued',
  waiting: 'queued',
  needsInput: 'needs',
  held: 'failed',
  failed: 'failed',
  notStarted: 'failed',
  done: 'done',
  idle: 'idle',
  archived: null,
};

/** A session's card state, live: what its card, a stack's fold, the tab's groups and the status line's count all read. */
export function useSessionCardState(chatId: string, notStarted = false): SessionCardState {
  const view = useOrchestration();
  const linked = view.children[chatId];
  const row = useChatRowState(chatId, linked);
  // the chat's own archive mark (every harness's, loaded with the chat list); the Settings archive list is loaded only
  // when that page opens, so after a restart it would call every archived session live
  const archived = useStore((s) => s.claudeArchived[chatId] != null);
  // a browser sign-in hand-off waiting on the user in one of its tabs
  const handoff = useStore((s) => !!chatAgentTabs(s.agentTabs, chatId, chatOf)?.tabs.some((t) => t.signin));
  return sessionCardState({
    row: row?.state ?? null,
    queued: view.queue.includes(chatId),
    archived,
    notStarted,
    awaitingBrief: linked?.awaitingBrief,
    waiting: view.waiting?.[chatId] ? (view.waiting[chatId].held ? 'held' : 'waiting') : null,
    report: linked?.lastReport?.how,
    asks: !!view.wrapUps?.[chatId]?.ask || handoff,
  });
}

/** One session's live state, told to a list that counts it (SessionsCount.tsx, PrInbox.tsx); it draws nothing. */
export function SessionStateProbe({ chatId, onState }: { chatId: string; onState: (chatId: string, state: SessionCardState) => void }) {
  const state = useSessionCardState(chatId);
  useEffect(() => onState(chatId, state), [onState, chatId, state]);
  return null;
}

function StateMark({ state }: { state: SessionCardState }) {
  const dot = STATE_DOT[state];
  if (dot) return <span className="session-card-dot" data-dot={dot} aria-hidden="true" />;
  return <Archive size={14} strokeWidth={1.8} aria-hidden="true" />;
}

export function SessionCard({
  chatId,
  title,
  fallback,
  notStarted = null,
  parentId,
  readOnly = false,
  folded = false,
  onState,
}: {
  chatId: string;
  title: string;
  /** what the card says before the session has anything to show (where it runs and with what context) */
  fallback: string;
  /** why its brief didn't reach it, when the start failed */
  notStarted?: string | null;
  /** The conversation showing the card; copied history never gets the original parent's worktree actions. */
  parentId?: string;
  readOnly?: boolean;
  /** in a stack's fold (SessionStack.tsx): drawn only while it needs the user */
  folded?: boolean;
  /** told each state the card takes, so a stack can count what its fold holds */
  onState?: (chatId: string, state: SessionCardState) => void;
}) {
  const view = useOrchestration();
  const linked = view.children[chatId];
  const parentTurn = useChatTurn(linked?.parentId);
  const foreign = !!linked && !!parentId && linked.parentId !== parentId;
  const state = useSessionCardState(chatId, !!notStarted);
  useEffect(() => onState?.(chatId, state), [onState, chatId, state]);
  const caption = notStarted ?? sessionCaption(view, chatId, state, fallback);
  const lead = LEAD_WORD[state];
  const name = linked?.title || title;
  const moving = state === 'starting' || state === 'working';
  const outside = outsideLine(linked?.outside);
  const pr = linked?.facts?.pr;
  const PrIcon =
    pr?.state === 'MERGED'
      ? GitMerge
      : pr?.state === 'CLOSED'
        ? GitPullRequestClosed
        : pr?.state === 'DRAFT'
          ? GitPullRequestDraft
          : GitPullRequest;
  if (folded && !ATTENTION.has(state)) return null;
  if (notStarted)
    return (
      <div className="session-not-started" role="status">
        <span>Session not started</span>
        <span className="session-not-started-title">{name}</span>
        <span className="session-not-started-reason">{notStarted}</span>
      </div>
    );
  const card = (
    <button
      type="button"
      className="session-card"
      data-state={state}
      aria-label={`Open session ${name} (${STATE_WORD[state]})`}
      // Stay in this window; ⌥-click opens a split (src/session/openChat.ts).
      onClick={(e) => openChatFrom(e, chatId, { newWindow: false })}
    >
      <span className="session-card-text">
        <ShimmerSpan className="session-card-title" on={moving}>
          {name}
        </ShimmerSpan>
        {(caption || lead) && (
          <span className="session-card-caption">
            {lead && <span className={`session-card-word ${lead}`}>{STATE_WORD[state]}</span>}
            {lead && caption ? ' · ' : ''}
            {caption}
          </span>
        )}
        {outside && (
          <span className="session-card-outside" title={`Declared paths: ${(linked?.paths ?? []).join(', ')}`}>
            {outside}
          </span>
        )}
      </span>
      <span className="session-card-end">
        {pr && (
          <span className="session-card-pr" data-state={pr.state.toLowerCase()} aria-label={`PR #${pr.number}: ${pr.state.toLowerCase()}`}>
            <PrIcon size={14} />
            <span>{pr.state.toLowerCase()}</span>
          </span>
        )}
        <StateMark state={state} />
        <ChevronRight size={14} strokeWidth={1.8} aria-hidden="true" />
      </span>
    </button>
  );
  // what it did in its own worktree goes under the card, with its own buttons apart from the card's open
  if (!linked?.facts && !foreign) return card;
  return (
    <div className="session-card-group">
      {foreign && (
        <button
          type="button"
          className="side-session-more"
          onClick={(event) => openChatFrom(event, linked!.parentId, { newWindow: false })}
        >
          Open original session
        </button>
      )}
      {card}
      {linked?.facts && (
        <SessionWork
          chatId={chatId}
          linked={linked}
          parentTurn={parentTurn}
          readOnly={readOnly || parentId !== linked.parentId}
          settled={state === 'done' || state === 'idle' || state === 'failed'}
        />
      )}
    </div>
  );
}
