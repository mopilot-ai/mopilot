// A Codex chat's details and turns for opening it: the turns are left unread when the chat is shown and unchanged since they were last read.
import { noteIgnored } from '../lib/ignored';
import { TURN_PAGE } from './turnPages';

/** The two Codex reads this needs (the caller owns the harness import). */
type ChatReads<R, P> = {
  threadRead(id: string): Promise<R>;
  threadTurns(id: string, opts: { limit: number; itemsView: 'full' }): Promise<P>;
};

/** The `updatedAt` a chat's details had when its turns were last read (not the one a lease or list refresh stored since). */
const turnsReadAt = new Map<string, number>();

/** Records the details a turns read went with. */
export function noteTurnsRead(id: string, updatedAt: number | undefined) {
  if (updatedAt === undefined) turnsReadAt.delete(id);
  else turnsReadAt.set(id, updatedAt);
}

/**
 * The chat's details and first page of turns. With `shown` (turns are on screen and trusted), the details are read first and,
 * when they say an idle chat was last written as at the last turns read, nothing is on disk that the screen lacks: null.
 */
export async function readCodexChat<R extends { thread?: { updatedAt: number; status: { type: string } } | null }, P>(
  api: ChatReads<R, P>,
  id: string,
  shown: boolean,
) {
  // unread: the turns still load, with the thread's details as last known
  const readThread = () => api.threadRead(id).catch((error) => (noteIgnored("read a Codex chat's details", error), null));
  const readTurns = () => api.threadTurns(id, { limit: TURN_PAGE, itemsView: 'full' });
  const known = shown ? turnsReadAt.get(id) : undefined;
  if (known === undefined) {
    const [read, page] = await Promise.all([readThread(), readTurns()]);
    return { read, page };
  }
  const read = await readThread();
  if (read?.thread && read.thread.updatedAt === known && read.thread.status.type === 'idle') return null;
  return { read, page: await readTurns() };
}
