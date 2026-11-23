// The cards a chat shows for sessions it started or proposed through MoPilot's tools, on any harness: a started
// session as its live card (in the turn, at its call), and the turn's proposals after its reply (SuggestionCard.tsx).
import { SessionCard, type SessionCardState } from './SessionCard';
import type { SessionToolCall } from '../../lib/sessionToolCall';

export { TurnSuggestions } from './SuggestionCard';

const FALLBACK: Record<string, string> = {
  harness_differs: 'fresh with an excerpt: its harness differs from this chat’s',
  harness_cannot_fork: 'fresh with an excerpt: its harness cannot fork a chat',
  fork_needs_same_folder: 'fresh with an excerpt: forking needs the same folder',
};

/** Where a started session runs and with what context, for its card before it has anything else to say. */
export function startedFallback(call: Extract<SessionToolCall, { kind: 'started' }>): string {
  const where = call.worktree ? 'in its own worktree' : 'in this folder';
  const how = call.fallback ? (FALLBACK[call.fallback] ?? 'fresh') : call.context === 'fork' ? 'with this conversation' : 'from a brief';
  return `${call.name} · ${where}, ${how}`;
}

/** A session the chat started, at its call in the turn. */
export function TaskProposalCard({
  call,
  threadId,
  readOnly = false,
  folded,
  onState,
}: {
  call: Extract<SessionToolCall, { kind: 'started' }>;
  threadId?: string;
  readOnly?: boolean;
  /** in a stack (SessionStack.tsx): behind its fold, and how the stack hears each state */
  folded?: boolean;
  onState?: (chatId: string, state: SessionCardState) => void;
}) {
  return (
    <SessionCard
      chatId={call.chatId}
      parentId={threadId}
      readOnly={readOnly}
      title={call.title}
      fallback={startedFallback(call)}
      notStarted={call.error}
      folded={folded}
      onState={onState}
    />
  );
}
