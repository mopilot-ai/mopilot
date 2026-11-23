// Older messages of a chat, a page at a time: the request for the page before the oldest row the phone has, and what a thread already holds.
import { type Owned, bad, list, rec, str } from './client';
import type { Data, Thread } from '../presentation/thread';

/** Rows asked for at a time. */
export const PAGE = 40;

/** The id of the oldest row a thread holds, which is where the page before it starts; null when its rows carry none. */
export function oldestId(thread: Thread): string | null {
  const first = (thread.shape === 'rows' ? thread.items : thread.history)[0];
  return str(first?.id);
}

/** One page of rows before `before`, newest last, and whether the chat goes back further. */
/** `omitted`: the computer's history holds nothing earlier, but the chat once did. */
export async function readEarlier(
  request: Owned,
  chatId: string,
  before: string,
): Promise<{ rows: Data[]; more: boolean; omitted: boolean }> {
  const page = rec(await request('chat.read', { chatId, before, limit: PAGE }));
  if (!page || !Array.isArray(page.rows) || typeof page.more !== 'boolean') return bad('earlier messages');
  const rows = list(page.rows)
    .map(rec)
    .filter((r): r is Data => !!r && typeof r.role === 'string' && typeof r.text === 'string');
  return { rows, more: page.more, omitted: page.omitted === true };
}
