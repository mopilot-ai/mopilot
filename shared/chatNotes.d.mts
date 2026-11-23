/** A saved note as withChatNotes reads it (src/lib/chatMeta.ts ChatNote). */
export interface PlacedNote {
  id: string;
  kind: string;
  text: string;
  answers?: unknown;
  refused?: unknown;
  nudge?: unknown;
  turnId: string | null;
  turn: number;
  at: number;
  /** a hook run from before its turn began: first among the turn's items */
  lead?: boolean;
}
export type NotedTurn = { id: string; items: { id: string }[]; startedAt?: number | null };
export function turnIdentity(id: string): string;
export function sameTurn(a: string, b: string): boolean;
/** Whether placing the notes needs the whole history (one with no turn id goes by its saved index). */
export function notesNeedWholeHistory(notes: readonly { turnId?: string | null }[] | undefined | null): boolean;
export function withChatNotes<T extends NotedTurn>(turns: T[], notes: readonly PlacedNote[] | undefined | null): T[];
