// Types for quota notice ownership and history reconciliation on every harness.
export function limitNoteHome<T>(
  turns: readonly { id: string; items: readonly unknown[] }[],
  turnId: string,
  item: T,
): { turnId: string; item: T };
export function coalesceLimitNotes<T extends { id: string; items: readonly unknown[] }>(turns: T[]): T[];
