// Whether a MoMo chat has outside content in the model's context (mail, calendar text, a web page, anything the owner did not write): from the first such tool result it stays tainted, through later owner messages, until a compaction or a new session provably drops that content; an unknown result source counts as outside (after openclaw turn-taint.ts, MIT, and rakazo's own-state allow-list, Apache-2.0, see NOTICE; unlike openclaw an owner message does not clear it, because the content is still in context).

export type ResultSource = 'owner_state' | 'outside' | 'unknown';
export type TurnEvent =
  | { role: 'owner' }
  | { role: 'result'; source: ResultSource }
  | { role: 'assistant'; tainted?: true }
  /** The context was compacted or a new session began, and the outside content is gone from it. */
  | { role: 'reset' };

/** Only MoMo's own state (its notes, its task list) is trusted; everything else, including a source nobody classified, can carry planted text. */
export const taintsTurn = (source: ResultSource): boolean => source !== 'owner_state';

/** Tainted when any tainting event came after the last reset. */
export function isTurnTainted(events: readonly TurnEvent[]): boolean {
  const reset = events.findLastIndex((e) => e.role === 'reset');
  return events
    .slice(reset + 1)
    .some((e) => (e.role === 'result' && taintsTurn(e.source)) || (e.role === 'assistant' && e.tainted === true));
}

/** A small recorder the Host calls as a chat runs; `tainted()` is what the gate asks. */
export function createTurnTaint() {
  const events: TurnEvent[] = [];
  return {
    ownerMessage: () => void events.push({ role: 'owner' }),
    toolResult: (source: ResultSource) => void events.push({ role: 'result', source }),
    /** Only when the context provably no longer holds the outside content. */
    reset: () => void events.push({ role: 'reset' }),
    tainted: () => isTurnTainted(events),
  };
}
