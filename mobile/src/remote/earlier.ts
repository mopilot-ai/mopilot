// Older messages of a chat, a page at a time: the request for the page before the oldest row the phone has, and what a thread already holds.
import { type Owned, bad, list, rec, str } from './client';
import { type Data, type Thread, row } from '../presentation/thread';
import type { KeyedRow } from '../presentation/toolRuns';

/** Rows asked for at a time when the reader is at the top, and when a page is fetched ahead of them (the computer caps a page at 100). */
export const PAGE = 40;
export const AHEAD_PAGE = 80;

/** The id of the oldest row a thread holds, which is where the page before it starts; null when its rows carry none. */
export function oldestId(thread: Thread): string | null {
  const first = (thread.shape === 'rows' ? thread.items : thread.history)[0];
  return str(first?.id);
}

/** The identity a row is known by in the list, which a row keeps whether it sits in the snapshot or in a page above it (so moving between them re-mounts nothing and the list's held row stays under the reader's eye). */
export const rowIdentity = (r: Data): string | null => str(r.phoneId) ?? str(r.id);
/** The list key of a row above the snapshot: its identity as the snapshot keys it (`keyedRows`); null for a row that names none. */
export const earlierKey = (r: Data): string | null => {
  const id = rowIdentity(r);
  return id ? JSON.stringify(['item', id]) : null;
};
let unnamed = 0;

const drawn = new WeakMap<Data, KeyedRow>();
/** An older row as the list draws it, worked out once for each row: a page landing above does not work out the rows below it again (a row is the same object while it is held). */
export const earlierRow = (r: Data): KeyedRow => {
  let item = drawn.get(r);
  if (!item) {
    // a row that names no identity gets a key of its own, the same for as long as the row is held (two such rows never share one)
    item = { ...row(r, 'rows'), key: earlierKey(r) ?? `earlier:unnamed-${++unnamed}` };
    drawn.set(r, item);
  }
  return item;
};

/**
 * After the chat was read again: of the rows the phone held (paged-back rows, then the old snapshot's), the ones that come before the
 * new snapshot's first row, which stay above it, so a read again that covers fewer rows than were on screen (the computer caps one at 200
 * blocks) does not throw away the rows the reader paged to. Null when the new snapshot does not start at a row that was held (the history
 * changed under it, or it reaches further back than the paged rows): nothing above it can be trusted.
 */
export function keptAbove(held: readonly Data[], next: Thread): Data[] | null {
  if (next.shape !== 'rows') return null;
  const first = str(next.items[0]?.id);
  if (!first) return null;
  const at = held.findIndex((r) => str(r.id) === first);
  // what is kept must start at a row that can be named, which is where the page before it is asked from
  return at > 0 && str(held[0]?.id) ? held.slice(0, at) : null;
}

/** The rows of a page the phone does not hold yet: a row names itself by its id, and one that is held already (a page asked again, or a read again that moved it) is not added twice. */
export function newRows(page: readonly Data[], held: ReadonlySet<string>): Data[] {
  return page.filter((r) => {
    const id = str(r.id);
    return !id || !held.has(id);
  });
}

/** One page of rows before `before`, newest last, and whether the chat goes back further. */
/** `omitted`: the computer's history holds nothing earlier, but the chat once did. */
export async function readEarlier(
  request: Owned,
  chatId: string,
  before: string,
  limit = PAGE,
): Promise<{ rows: Data[]; more: boolean; omitted: boolean }> {
  const page = rec(await request('chat.read', { chatId, before, limit }));
  if (!page || !Array.isArray(page.rows) || typeof page.more !== 'boolean') return bad('earlier messages');
  const rows = list(page.rows)
    .map(rec)
    .filter((r): r is Data => !!r && typeof r.role === 'string' && typeof r.text === 'string');
  return { rows, more: page.more, omitted: page.omitted === true };
}
