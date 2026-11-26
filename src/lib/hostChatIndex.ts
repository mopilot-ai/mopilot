// Every machine's chats as this Mac's index holds them (electron/host/chatIndex.cjs): one read and one subscription shared by every part of the window that shows them, followed only while Host exists and something draws them.
import { useEffect, useSyncExternalStore } from 'react';
import './native/hostChats';
import type { HostChatIndex } from './native/hostChats';
import { native } from './native';
import { ignoring } from './ignored';
import { createLatestLoader } from './latestLoader';
import { useHostAccess } from './host';

const STATES = new Set(['loading', 'ready', 'partial', 'failed', 'stale', 'unsupported']);
const KINDS = new Set(['idle', 'running', 'attention']);
/** One machine's entry per id, in the order main sent them; empty before the first answer. */
export type HostChatIndexes = ReadonlyMap<string, HostChatIndex>;

/** The chats this window has open or selected: told to main with each read of the list, so a binding a window shows is never let go of. */
let openChats: () => readonly string[] = () => [];
const EMPTY: HostChatIndexes = new Map();
let byMachine: HostChatIndexes = EMPTY;
let answered = false;
let refs = 0;
let stop: (() => void) | null = null;
const listeners = new Set<() => void>();
let snapshot: { indexes: HostChatIndexes; answered: boolean } = { indexes: EMPTY, answered: false };

/** What main sent as the index, or null when it is not one (an entry without its fields is never drawn as a machine's list). */
export function parseChatIndex(v: unknown): HostChatIndex[] | null {
  if (!Array.isArray(v)) return null;
  const out: HostChatIndex[] = [];
  for (const e of v as Partial<HostChatIndex>[]) {
    if (!e || typeof e.machineId !== 'string' || !e.machineId || !STATES.has(e.state as string) || !Array.isArray(e.rows)) return null;
    const rows = e.rows.filter(
      (r) =>
        r && typeof r.chatId === 'string' && r.chatId && typeof r.title === 'string' && Number.isFinite(r.updatedAt) && KINDS.has(r.state),
    );
    out.push({ machineId: e.machineId, state: e.state as HostChatIndex['state'], truncated: e.truncated === true, rows });
  }
  return out;
}

/** Whether two entries of a machine say the same to a person: what is drawn of a row is its title, state and time, and `rev` moves with each of them. */
const sameEntry = (a: HostChatIndex, b: HostChatIndex) =>
  a.state === b.state &&
  a.truncated === b.truncated &&
  a.rows.length === b.rows.length &&
  a.rows.every(
    (r, i) =>
      r.chatId === b.rows[i].chatId && r.rev === b.rows[i].rev && r.state === b.rows[i].state && r.updatedAt === b.rows[i].updatedAt,
  );

const publish = (next: HostChatIndex[], reply: boolean) => {
  // main sends the whole index on every change (coalesced): what did not change keeps its entry, and nothing that shows the same is drawn again
  const kept = next.map((e) => {
    const before = byMachine.get(e.machineId);
    return before && sameEntry(before, e) ? before : e;
  });
  if (reply === answered && kept.length === byMachine.size && kept.every((e) => byMachine.get(e.machineId) === e)) return;
  next = kept;
  byMachine = new Map(next.map((e) => [e.machineId, e]));
  answered = reply;
  snapshot = { indexes: byMachine, answered };
  for (const l of listeners) l();
};

function follow() {
  const h = native.hostChats;
  const loader = createLatestLoader(
    async () => parseChatIndex(await h.list([...openChats()])),
    (next) => next && publish(next, true),
    ignoring("read the machines' chats"),
  );
  const off = h.onChanged((next) => {
    const parsed = parseChatIndex(next);
    if (parsed) loader.push(parsed);
  });
  void loader.load();
  stop = () => {
    loader.stop();
    off();
    publish([], false);
  };
}

function acquire() {
  if (refs++ === 0) follow();
  return () => {
    if (--refs === 0) {
      stop?.();
      stop = null;
    }
  };
}

/** The chats of every machine, and whether main has answered once; empty while Host is not available. The first call to need them starts following main. */
export function useHostChatIndex(open?: () => readonly string[]): { indexes: HostChatIndexes; answered: boolean } {
  if (open) openChats = open;
  const allowed = useHostAccess();
  useEffect(() => (allowed ? acquire() : undefined), [allowed]);
  const current = useSyncExternalStore(
    (cb) => (listeners.add(cb), () => void listeners.delete(cb)),
    () => snapshot,
  );
  return allowed ? current : { indexes: EMPTY, answered: false };
}
