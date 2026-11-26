// The "By machine" sidebar tests' machine: one registry row ("Build box"), the Mac's index of its chats, the chats this Mac started there (OWN), and `native.hostChats.open` as main does it (the chat's record reaches the window).
import { act } from 'react';
import { native } from '../../src/lib/native.ts';
import { fakeNative } from './ports/native.ts';
import { getState, thread, update } from './shell-sidebar-kit.ts';

export const row = (n: number, state = 'idle') => ({
  chatId: `claude:c${n}`,
  title: `Machine chat ${n}`,
  harness: 'claude',
  createdAt: n,
  updatedAt: n * 1000,
  epoch: 1,
  rev: 1,
  state,
  folder: `/srv/app${n}`,
});
export const OWN = 'acp:host-claude:own';
export const offlineBox = { machines: [{ id: 'ssh:box', name: 'Build box', note: '', status: 'offline' }], resolved: true };

export function rig(
  t: { after: (fn: () => void) => void },
  o: { rows?: any[]; state?: string; status?: string; ownersPending?: boolean } = {},
) {
  const machines = [{ id: 'ssh:box', name: 'Build box', note: '', status: o.status ?? 'online' }];
  const index: any[] = [
    { machineId: 'ssh:box', state: o.state ?? 'ready', truncated: false, rows: o.rows ?? [1, 2, 3, 4, 5, 6, 7].map((n) => row(n)) },
  ];
  const out = {
    pushMachines: (_rows: unknown) => {},
    pushIndex: (_rows: unknown) => {},
    opened: [] as unknown[][],
    released: [] as unknown[][],
    /** the next read of which chats run where fails */
    failOwners: false,
  };
  const previous = [native.host, native.hostChats];
  const fake = fakeNative({
    host: {
      access: async () => true,
      onAccess: () => () => undefined,
      machines: async () => ({ machines, resolved: true }),
      onMachines: (cb: typeof out.pushMachines) => {
        out.pushMachines = cb;
        return () => undefined;
      },
      remoteChats: () =>
        o.ownersPending
          ? new Promise<never>(() => undefined)
          : out.failOwners
            ? Promise.reject(new Error('the read failed'))
            : Promise.resolve([{ chatId: OWN, hostId: 'ssh:box' }]),
    },
    hostChats: {
      list: async () => index,
      release: async (machineId: string, chatId: string) => {
        out.released.push([machineId, chatId]);
        return { released: true };
      },
      onChanged: (cb: typeof out.pushIndex) => {
        out.pushIndex = cb;
        return () => undefined;
      },
      open: async (machineId: string, chatId: string) => {
        out.opened.push([machineId, chatId]);
        const listed = index[0].rows.find((r: { chatId: string }) => r.chatId === chatId);
        const id = `acp:host-${chatId}`;
        // main announces the chat: its record reaches this window, in the folder the machine said
        await update({
          ...getState(),
          threads: { ...getState().threads, [id]: thread(id, { cwd: listed?.folder }) },
          threadOrder: [id, ...getState().threadOrder],
        });
        return { chatId: id };
      },
    },
  });
  native.host = fake.host;
  native.hostChats = fake.hostChats;
  t.after(() => {
    native.host = previous[0] as any;
    native.hostChats = previous[1] as any;
  });
  return out;
}

export const group = (view: { $: (s: string) => HTMLElement }, id: string) => view.$(`[data-machine-group="${id}"]`);
export const titles = (g: Element) => [...g.querySelectorAll('.thread-row .side-row-label')].map((e) => e.textContent);
export { act };
