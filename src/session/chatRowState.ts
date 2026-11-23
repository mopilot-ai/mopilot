// What a sidebar chat row's status says on every harness (waiting, failed, working, unread, a linked session's done or
// failed report), shared by the row's dot (sidebar/ThreadIndicators.tsx) and the hidden nested sessions' summary.
import type { SideSessionChild } from '../../shared/orchestration';
import type { Elsewhere, PendingRequest, Thread, ThreadRuntime } from '../store/types';
import { EMPTY_SESSION, type BackgroundTask, type SessionState } from '../store/session/sessionState';
import { runningTaskCount } from '../store/backgroundTasks';
import { toRequest } from '../harness/approvalRequests';
import { chatRunning } from './chatRunning';

/**
 * One status per row, first match wins: the user is needed (an approval, or input), the chat failed, a turn or a
 * background task runs (Claude Desktop keeps a session running while it has background work), it runs in another app,
 * a linked session's last report says it failed, an unread result, a linked session finished, it can open in another
 * app, else nothing.
 */
export type ChatRowState =
  | 'approval'
  | 'input'
  | 'error'
  | 'working'
  | 'elsewhereRunning'
  | 'failed'
  | 'unread'
  | 'done'
  | 'elsewhere'
  | 'idle';

/** The part of a chat's runtime the row state reads, as booleans: a streamed delta replaces `turns` but changes none of them. */
export type RowRuntime = { activeTurnId: boolean; error: boolean; failed: boolean };

// one shared object per combination, so a list of them compares equal element by element (useShallow) while nothing changes
const ROW_RUNTIMES = Array.from(
  { length: 8 },
  (_, bits): RowRuntime => ({ activeTurnId: !!(bits & 1), error: !!(bits & 2), failed: !!(bits & 4) }),
);

export function rowRuntime(runtime: ThreadRuntime | undefined): RowRuntime | undefined {
  if (!runtime) return undefined;
  return ROW_RUNTIMES[+!!runtime.activeTurnId + 2 * +!!runtime.error + 4 * +(runtime.turns?.at(-1)?.status === 'failed')];
}

export type ChatRowInputs = {
  thread: Pick<Thread, 'id' | 'cwd' | 'status'>;
  session: SessionState;
  runtime: ThreadRuntime | RowRuntime | undefined;
  /** the store's pending requests, read until main has the chat's session */
  requests: PendingRequest[];
  /** the tasks a renderer-side adapter reports for the chat (Codex, ACP); main's are on the session */
  adapterTasks: BackgroundTask[];
  elsewhere: Elsewhere | undefined;
  unread: boolean;
  /** the chat's record as a session another chat started, if it is one */
  linked?: SideSessionChild | undefined;
  /** this chat's ended turn left a wrap-up question or browser sign-in hand-off */
  asks?: boolean;
};

const ASKS = new Set(['item/tool/requestUserInput', 'mcpServer/elicitation/request']);

/** The row's own outstanding request cards; native wait flags supply one only before exact cards are known. */
function rowAttention({ thread, session, requests, runtime, elsewhere, asks }: ChatRowInputs) {
  const flags = !session.rev && thread.status?.type === 'active' ? thread.status.activeFlags : undefined;
  const pending = session.rev
    ? session.approvals.map((a) => toRequest(thread.id, a, thread.cwd, 0) ?? a)
    : requests.filter((p) => p.threadId === thread.id);
  const questions = session.questions.filter((q) => q.status === 'pending').length;
  const endedAsk = !!asks && !chatRunning(thread, session, runtime) && !elsewhere?.running && !session.runningElsewhere;
  const input = pending.some((p) => ASKS.has(p.method)) || questions > 0 || !!flags?.includes('waitingOnUserInput') || endedAsk;
  const approval =
    pending.some((p) => !ASKS.has(p.method)) ||
    !!session.chromeApproval ||
    !!flags?.includes('waitingOnApproval') ||
    (session.turn === 'awaitingUser' && !input);
  return {
    state: approval ? ('approval' as const) : input ? ('input' as const) : null,
    count: Math.max(pending.length + questions + Number(!!session.chromeApproval) + Number(endedAsk), Number(approval || input)),
  };
}

function rowState(
  { thread, session, runtime: given, adapterTasks, elsewhere, unread, linked }: ChatRowInputs,
  attention: ReturnType<typeof rowAttention>['state'],
): ChatRowState {
  // Once main has a session, its current approvals supersede native list snapshots.
  const runtime = given && 'turns' in given ? rowRuntime(given) : given;
  if (attention) return attention;
  const running = chatRunning(thread, session, runtime);
  const error = session.rev
    ? session.turn === 'crashed'
    : !running && (thread.status?.type === 'systemError' || runtime?.error || runtime?.failed);
  if (error) return 'error';
  if (running || runningTaskCount(thread.id, session, adapterTasks) > 0) return 'working';
  if (elsewhere?.running || session.runningElsewhere) return 'elsewhereRunning';
  const how = linked?.lastReport?.how;
  if (how === 'failed' || how === 'lost') return 'failed';
  if (unread) return 'unread';
  if (how === 'finished') return 'done';
  return elsewhere ? 'elsewhere' : 'idle';
}

export function chatRowState(inputs: ChatRowInputs): ChatRowState {
  return rowState(inputs, rowAttention(inputs).state);
}

/** What a hidden nested session counts as in its parent's summary: each counts once, as its most pressing state. */
export type NestedTally = 'input' | 'failed' | 'unread' | 'working' | null;

export function nestedTally(state: ChatRowState): NestedTally {
  switch (state) {
    case 'approval':
    case 'input':
      return 'input';
    case 'error':
    case 'failed':
      return 'failed';
    case 'unread':
      return 'unread';
    case 'working':
    case 'elsewhereRunning':
      return 'working';
    default:
      return null;
  }
}

/** A row's state and whether independent background work runs, for a chat whose session this window may not have yet. */
export function chatRowStatus({ session, ...inputs }: Omit<ChatRowInputs, 'session'> & { session: SessionState | undefined }) {
  const known = session ?? EMPTY_SESSION;
  const own = { ...inputs, session: known };
  const attention = rowAttention(own);
  return {
    state: rowState(own, attention.state),
    attentionCount: attention.count,
    // Attention and activity coexist: an approval or a failed turn does not stop independent background work.
    backgroundRunning: runningTaskCount(inputs.thread.id, known, inputs.adapterTasks) > 0,
  };
}
