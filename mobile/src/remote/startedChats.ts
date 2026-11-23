// The chats the phone started on a machine: known while the app runs, and kept in the sealed vault between runs, since the Mac does not list them.
import { appChatId } from '../../../shared/host/chatIds.mjs';

/** A chat the phone started on a machine: where it runs, what it was first asked and when. */
export type StartedChat = {
  chatId: string;
  machineId: string;
  title: string;
  at: number /** the agent it was started on, by the name the wire moves a chat with */;
  harness?: string;
};

/** How many of a machine's chats the phone keeps between runs: the newest. */
export const KEPT_CHATS = 100;

/** Whether what was kept for a machine reads as a chat the phone started there. */
const keptChat = (c: unknown, machineId: string): c is StartedChat => {
  const v = c as Partial<StartedChat> | null;
  return (
    !!v &&
    typeof v.chatId === 'string' &&
    v.machineId === machineId &&
    typeof v.title === 'string' &&
    typeof v.at === 'number' &&
    (v.harness === undefined || typeof v.harness === 'string')
  );
};

/** The most chats the phone asks a Host for, and the most it answers (`host.chats`): an answer this long may be cut, with older chats beyond it. */
export const HOST_LIST_BOUND = 200;

/** How long the phone waits before it asks a Host again for titles the Host had not found yet, and how many times at most (a few seconds in all, never a loop). */
export const TITLE_RETRY_MS = 2000;
export const TITLE_RETRIES = 5;

/** How many chats of a Host's answer still had no title when it was given (it finds the newest few a call); 0 when it says nothing. @param {unknown} answer */
export const titlesPending = (answer: unknown): number => {
  const n = (answer as { titles?: { pending?: unknown } } | null)?.titles?.pending;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : 0;
};

/** A row of the Host's own list of its chats (`host.chats`). */
export type HostChatRow = { chatId: string; title: string; harness: string; updatedAt: number };

/** The rows of a Host's answer that read as chats (anything else is left out); null when the answer is not a list. @param {unknown} answer */
export const hostRows = (answer: unknown): HostChatRow[] | null => {
  const list = (answer as { chats?: unknown } | null)?.chats;
  if (!Array.isArray(list)) return null;
  return list.filter(
    (r): r is HostChatRow =>
      !!r && typeof r.chatId === 'string' && typeof r.title === 'string' && typeof r.harness === 'string' && Number.isFinite(r.updatedAt),
  );
};

export type StartedStore = {
  load: () => Promise<Record<string, unknown>>;
  save: (machineId: string, chats: StartedChat[]) => Promise<unknown>;
};

export function createStartedChats(o: { store?: StartedStore }) {
  const chats = new Map<string, StartedChat>();
  const on = (machineId: string) => [...chats.values()].filter((c) => c.machineId === machineId).sort((a, b) => b.at - a.at);
  /** Whether what was kept has been read back; nothing is written over it before that. */
  let restored = false;
  /** Machines a chat was started on before that: written once what was kept is read. */
  const early = new Set<string>();
  let saving: Promise<unknown> = Promise.resolve();
  /** Writes a machine's chats to the vault, once the Host took one: one write after another, the last state wins; a write that fails leaves the chat known until the app closes. */
  const keep = (machineId: string) => {
    const { store } = o;
    if (!store) return;
    if (!restored) return void early.add(machineId);
    const newest = on(machineId).slice(0, KEPT_CHATS);
    saving = saving.then(() => store.save(machineId, newest)).catch(() => undefined);
  };
  return {
    get: (chatId: string) => chats.get(chatId),
    set: (chatId: string, chat: StartedChat) => void chats.set(chatId, chat),
    /** The chats the phone started on a machine, newest first. */
    on,
    keep,
    /**
     * The Host's own list of a machine's chats: it is what the machine holds, so it replaces what the phone knew of that machine (a chat the Host
     * no longer lists is gone, unless the answer is as long as the Host answers at most), except the chats being started now or started after the list was asked for, which the Host may not have saved yet.
     * A Host row with no title keeps the title the phone made from the chat's first message.
     */
    adopt(machineId: string, rows: HostChatRow[], since: number, starting: Set<string>, full: boolean) {
      const listed = new Set<string>();
      for (const r of rows) {
        const chatId = appChatId(r.chatId);
        listed.add(chatId);
        const known = chats.get(chatId);
        chats.set(chatId, { chatId, machineId, title: r.title || known?.title || '', at: r.updatedAt, harness: r.harness });
      }
      // a full answer may be cut at its bound, so a chat it does not name may only be older than the chats it does: nothing is dropped then
      if (!full)
        for (const c of on(machineId)) if (!listed.has(c.chatId) && c.at < since && !starting.has(c.chatId)) chats.delete(c.chatId);
      keep(machineId);
    },
    /** Direct access to a machine was given up: its chats are not this phone's any more (the vault dropped them with the machine). */
    forget(machineId: string) {
      for (const c of on(machineId)) chats.delete(c.chatId);
      early.delete(machineId);
    },
    /**
     * Puts back the chats kept before the app closed, for the machines the phone is still enrolled with; whatever cannot be read starts the list
     * empty, a chat known now wins over a kept one, and what was started before this read, or cut to the newest, is written back.
     */
    async restore(machineIds: string[]) {
      let saved: Record<string, unknown> = {};
      try {
        saved = (await o.store?.load()) ?? {};
      } catch {
        // a vault that cannot say starts the list empty
      }
      restored = true;
      for (const machineId of machineIds) {
        const list = saved[machineId];
        for (const c of Array.isArray(list) ? list : []) if (keptChat(c, machineId) && !chats.has(c.chatId)) chats.set(c.chatId, c);
        if (early.delete(machineId) || (Array.isArray(list) && list.length > KEPT_CHATS)) keep(machineId);
      }
    },
  };
}
