// The rows of a read again that the pages paged back above it already show, left out so each message is drawn once and under the key it had; and how many saved rows a thread holds.
import type { Thread } from './thread';

/** The ids of the rows a screen holds above its snapshot. */
export const heldIds = (rows: readonly { id?: unknown }[]): ReadonlySet<string> =>
  new Set(rows.filter((r) => r.id != null && r.id !== '').map((r) => String(r.id)));

/**
 * A chat read again while the reader is away from its end keeps the pages they paged back through (the rows above are where they are reading); the new
 * snapshot reaches back over those rows too, so the ones it repeats are dropped from it and the held ones stay, under their own keys, in their own place.
 */
export function withoutHeld<T extends { id?: unknown }>(rows: T[], held: ReadonlySet<string>): T[] {
  return held.size === 0 ? rows : rows.filter((r) => r.id == null || !held.has(String(r.id)));
}

/** How many saved rows a thread holds: its live items are not rows of the chat's record, and a read again asks for the record's rows, not for those plus what is streaming. */
export const savedCount = (thread: Thread) => (thread.shape === 'rows' ? thread.items : thread.history).length;
