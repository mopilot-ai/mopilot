// Sessions a turn started back to back, joined into one block of its work so they draw as one stack (thread/SessionStack.tsx).
import { toolCard } from './stepModel';
import type { ShownBlock } from './pollRuns';
import type { SessionToolCall } from '../../../lib/sessionToolCall';

/** One card of a stack: the session its call started, and the call's item id. */
export type StackRow = { id: string; call: Extract<SessionToolCall, { kind: 'started' }> };
/** Two or more session cards with nothing between them, in the order they started. */
export type SessionsBlock = { kind: 'sessions'; rows: StackRow[] };
/** A turn's work as TurnView draws it: shown blocks, with each run of session cards joined. */
export type TurnBlock = ShownBlock | SessionsBlock;

/** The stack row a block is, when it is a started session's card. */
function sessionRow(b: TurnBlock): StackRow | null {
  if (b.kind !== 'block') return null;
  const card = toolCard(b.item);
  return card?.kind === 'session' ? { id: b.item.id, call: card.call } : null;
}

/** The blocks with each run of adjacent session cards joined; a lone card stays a block of its own. */
export function joinSessionCards(blocks: ShownBlock[]): TurnBlock[] {
  const out: TurnBlock[] = [];
  for (const b of blocks) {
    const row = sessionRow(b);
    const last = out[out.length - 1];
    const before = row && last ? sessionRow(last) : null;
    if (row && last?.kind === 'sessions') last.rows.push(row);
    else if (row && before) out[out.length - 1] = { kind: 'sessions', rows: [before, row] };
    else out.push(b);
  }
  return out;
}
