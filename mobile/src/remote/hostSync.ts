// Reading a Host's own list of its chats and making it the phone's list for that machine, and asking again, a few times, for titles the Host had not found yet.
import { HOST_LIST_BOUND, hostRows, TITLE_RETRIES, TITLE_RETRY_MS, titlesPending, type createStartedChats } from './startedChats';

export function createHostSync(o: {
  /** The machine's open session to its Host (it throws when none can be opened). */
  // biome-ignore lint/suspicious/noExplicitAny: the session is shared/remote/phoneHost.mjs's, typed by its own JSDoc
  session: (machineId: string) => Promise<any>;
  enrolled: (machineId: string) => boolean;
  started: ReturnType<typeof createStartedChats>;
  /** The chats being started now, which the Host may not have saved yet. */
  starting: () => Set<string>;
  clock: () => number;
  changed: () => void;
  /** Runs `fn` after `ms` and says how to cancel it. */
  later?: (fn: () => void, ms: number) => () => void;
}) {
  const later =
    o.later ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms);
      return () => clearTimeout(timer);
    });
  /** The timers that ask a machine again for its titles, one each at most. */
  const retrying = new Map<string, () => void>();
  /** Ends the asking again for a machine (a newer read, or the machine's removal). */
  const cancel = (machineId: string) => {
    retrying.get(machineId)?.();
    retrying.delete(machineId);
  };
  const retry = (machineId: string, attempt: number, pending: number) => {
    cancel(machineId);
    if (pending <= 0 || attempt >= TITLE_RETRIES) return;
    retrying.set(
      machineId,
      later(() => {
        retrying.delete(machineId);
        if (o.enrolled(machineId)) void sync(machineId, attempt + 1);
      }, TITLE_RETRY_MS),
    );
  };
  /**
   * Reads the Host's own list and makes it the phone's list for that machine (the Host holds the truth: after a reinstall, with the Mac off, or for a
   * chat another client started). A Host that cannot list, or does not answer, leaves what the phone knew as it was. Says whether the Host answered.
   */
  const sync = async (machineId: string, attempt = 0): Promise<boolean> => {
    const since = o.clock();
    try {
      const session = await o.session(machineId);
      if (!session.supportsChatList()) return false;
      const answer = await session.chats({ limit: HOST_LIST_BOUND });
      const rows = hostRows(answer);
      if (!rows) return false;
      o.started.adopt(machineId, rows, since, o.starting(), rows.length >= HOST_LIST_BOUND);
      retry(machineId, attempt, titlesPending(answer));
      o.changed();
      return true;
    } catch {
      return false;
    }
  };
  return { sync, cancel };
}
