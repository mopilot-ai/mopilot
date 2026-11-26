// The sidebar's "By machine" groups: this Mac, then each machine, with the chats that run there (this Mac's own chat records plus what the machine's Host lists that this Mac has no record of), newest first, and the one line a machine's state asks for.
import type { Thread } from '../../store/types';
import type { HostMachineRow } from '../../lib/hostMachines';
import type { HostChatIndex, HostChatRow } from '../../lib/native/hostChats';
import { appChatId } from '../../../shared/host/chatIds.mjs';
import { activityAt } from '../../lib/chatActivity';

/** The key of this Mac's group; a machine's is `machine:<id>`. */
export const MAC_GROUP = 'machine:this-mac';

/** A chat of the group: one this Mac has a record of (drawn as any chat row), or one only the machine's Host lists. */
export type MachineGroupRow =
  /** `at`: the chat's last activity in ms, the one clock a chat of this Mac's (seconds) and a Host's row (ms) are sorted by */
  | { kind: 'thread'; key: string; thread: Thread; at: number }
  /** `key` is `machineId:chatId`: the same chat id on two machines is two rows. `live`: the machine answers now (a row of an offline machine or a stale list is the last it said). */
  | { kind: 'remote'; key: string; row: HostChatRow; machineId: string; at: number; live: boolean };

export type MachineGroupData = {
  key: string;
  /** '' for this Mac */
  id: string;
  name: string;
  /** the provider's record when the machine is a cloud machine */
  cloud?: HostMachineRow['cloud'];
  /** the status dot: green while connected, grey otherwise; none for this Mac */
  dot: 'on' | 'off' | null;
  rows: MachineGroupRow[];
  /** the one line under the heading when the list is not the plain truth: still loading, or what is wrong with it */
  note: string | null;
  /** a list that has not answered yet and has nothing to show */
  loading: boolean;
  /** the machine holds more chats than the Mac's index keeps (2,000 a machine): the older ones are not listed */
  truncated: boolean;
  /** the group says "No chats": nothing to list, and nothing wrong with the list that the note would say */
  empty: boolean;
};

/** The one line each state of a machine's list asks for; `ready` asks for none. */
export const STATE_NOTES = {
  loading: 'Loading…',
  partial: 'Some chats may be missing',
  failed: "Couldn't load its chats",
  stale: 'Offline · showing its last chats',
  unsupported: 'Update its Host to list chats',
} as const;

/** Most chats of a machine a group draws (its newest): a machine with thousands of chats never makes thousands of rows. This Mac's own chats are all drawn, and so is any chat that runs or waits for a person. */
export const GROUP_ROW_CAP = 200;

/** The line under a list that leaves older chats out. */
export const TRUNCATED_NOTE = "Older chats aren't listed";

/** Where a chat of this Mac's own records runs: a machine's id, or '' for this Mac. */
export type OwnerOf = (chatId: string) => string;

/**
 * @param o.roots the chats of the sidebar's top level, in list order (a chat a listed chat started nests under it)
 * @param o.threads this Mac's chat records
 * @param o.ownerOf where each of those chats runs
 * @param o.hidden chats this Mac archived or removed: the machine still lists them, the sidebar does not
 * @param o.indexed what the Host of each machine lists, when the Mac's index has an answer
 * @param o.machines the registry's rows, in order
 * @param o.macName the name of this Mac's group
 */
export function machineGroups(o: {
  roots: readonly string[];
  threads: Readonly<Record<string, Thread>>;
  ownerOf: OwnerOf;
  hidden: (appId: string) => boolean;
  machines: readonly HostMachineRow[];
  indexed: ReadonlyMap<string, HostChatIndex>;
  /** whether it is known which chats run where: until then no chat is drawn (one drawn under This Mac would jump to its machine) and every group says it is loading */
  ownersKnown: boolean;
  /** whether the Mac's index has answered at all: before it has, a machine with no chats of this Mac's own is loading, not empty */
  answered: boolean;
  macName: string;
}): MachineGroupData[] {
  const groups = new Map<string, MachineGroupData>();
  const group = (id: string, name: string, cloud: MachineGroupData['cloud'], dot: MachineGroupData['dot']): MachineGroupData => {
    const g: MachineGroupData = {
      key: id ? `machine:${id}` : MAC_GROUP,
      id,
      name,
      cloud,
      dot,
      rows: [],
      note: null,
      loading: false,
      empty: false,
      truncated: false,
    };
    groups.set(id, g);
    return g;
  };
  group('', o.macName, undefined, null);
  for (const m of o.machines) group(m.id, m.name, m.cloud, m.status === 'offline' ? 'off' : 'on');
  if (!o.ownersKnown) {
    for (const g of groups.values()) Object.assign(g, { note: STATE_NOTES.loading, loading: true });
    return [...groups.values()];
  }

  const listed = new Set<string>();
  /** machines whose list says what is wrong instead of "No chats" */
  const failing = new Map<string, boolean>();
  for (const id of o.roots) {
    const thread = o.threads[id];
    if (!thread) continue;
    listed.add(id);
    const where = o.ownerOf(id);
    // a machine this Mac no longer lists still holds its chats: they stay together under its id
    const g = groups.get(where) ?? group(where, where, undefined, 'off');
    g.rows.push({ kind: 'thread', key: id, thread, at: activityAt(thread) * 1000 });
  }

  for (const m of o.machines) {
    const g = groups.get(m.id)!;
    const index = o.indexed.get(m.id);
    for (const row of index?.rows ?? []) {
      const id = appChatId(row.chatId);
      // a chat this Mac has a record of is drawn from it (it nests under its parent, shows its own state); one it archived stays away
      if (o.threads[id] || listed.has(id) || o.hidden(id)) continue;
      g.rows.push({
        kind: 'remote',
        key: `${m.id}:${row.chatId}`,
        row,
        machineId: m.id,
        at: row.updatedAt,
        live: m.status !== 'offline' && index?.state !== 'stale',
      });
    }
    // an offline machine's rows are the last it listed, whatever state its index was left in
    const state = !index ? (o.answered ? null : 'loading') : m.status === 'offline' && index.state === 'ready' ? 'stale' : index.state;
    if (state && state !== 'ready') g.note = STATE_NOTES[state];
    g.loading = state === 'loading' && g.rows.length === 0;
    g.truncated = index?.truncated === true;
    failing.set(m.id, state === 'failed' || state === 'unsupported');
  }

  const out = [...groups.values()];
  for (const g of out) {
    g.rows.sort((a, b) => b.at - a.at);
    let remote = 0;
    // a chat that runs or waits for a person is never cut, however old: it is the one a person must find
    const kept = g.rows.filter((r) => r.kind === 'thread' || r.row.state !== 'idle' || ++remote <= GROUP_ROW_CAP);
    if (kept.length < g.rows.length) Object.assign(g, { rows: kept, truncated: true });
    g.empty = g.rows.length === 0 && !g.loading && !failing.get(g.id);
  }
  return out;
}
