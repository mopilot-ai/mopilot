// Sessions a turn started back to back, as one stack in the turn on any harness: each its live card (SessionCard.tsx),
// joined with hairlines. Past SHOWN + 1 the rest fold behind a line that counts them by state; a card that needs the
// user or went wrong is never folded away.
import { useState } from 'react';
import { TaskProposalCard } from './TaskProposalCard';
import { useSessionStates } from './sessionStates';
import { ATTENTION, STATE_WORD, type SessionCardState } from './SessionCard';
import { ChevronDown } from '../ui/icons';
import type { StackRow } from './items/sessionRuns';

/** Cards shown before the fold, once two or more past them could fold (a fold never hides just one). */
export const SHOWN = 3;

/** The fold's line: how many it holds, then how many of each state the window knows ("2 more · 1 done, 1 queued"). */
export function foldLine(states: (SessionCardState | undefined)[]): string {
  const counts = new Map<SessionCardState, number>();
  for (const s of states) if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  const known = [...counts].map(([s, n]) => `${n} ${STATE_WORD[s].toLowerCase()}`);
  return `${states.length} more${known.length ? ` · ${known.join(', ')}` : ''}`;
}

export function SessionStack({ rows, threadId, readOnly = false }: { rows: StackRow[]; threadId?: string; readOnly?: boolean }) {
  const [open, setOpen] = useState(false);
  // each card's state as it reports it: what the fold counts, and which folded cards need the user
  const [states, onState] = useSessionStates();
  // what the fold would hold: the cards past SHOWN that neither need the user nor went wrong, and never just one
  const rest = rows.slice(SHOWN).filter((r) => !ATTENTION.has(states[r.call.chatId]));
  const fold = !open && rest.length > 1;
  const folded = fold ? rest : [];
  return (
    <div className="session-stack">
      {rows.map(({ id, call }, i) => (
        <TaskProposalCard
          // by its tool call: one chat can be named by two calls (an accepted offer and its brief fill)
          key={id}
          call={call}
          threadId={threadId}
          readOnly={readOnly}
          folded={fold && i >= SHOWN}
          onState={onState}
        />
      ))}
      {folded.length > 0 && (
        <button type="button" className="session-stack-more" aria-expanded={false} onClick={() => setOpen(true)}>
          <span>{foldLine(folded.map((r) => states[r.call.chatId]))}</span>
          <ChevronDown size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
