// A fake Host, registry and queue around electron/host/remoteSend.cjs, shared by the remote send tests.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from '../ports/clock.ts';
const require = createRequire(import.meta.url);
const { createOutbox } = require('../../../electron/host/outbox.cjs');
const { createRemoteSend } = require('../../../electron/host/remoteSend.cjs');
const { queueItem } = require('../../../electron/session/queueItem.cjs');

export const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const code = (message: string, c: string) => Object.assign(new Error(message), { code: c });
/** What the connection throws when the Host answered with an error (the app marks it, electron/host/remote.cjs); a machine that is not reachable is the app's own error. */
const answered = (e: any) => (['host_unreachable', 'request_retired'].includes(e?.code) ? e : Object.assign(e, { fromHost: true }));

export function world(t: any, o: { dir?: string; hostId?: string; epoch?: number } = {}) {
  const clock = installFakeClock(t, 1_000_000);
  const dir = o.dir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'remote-send-'));
  if (!o.dir) t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reports: Error[] = [];
  const queues = new Map<string, any[]>();
  const patches: any[] = [];
  /** The permission mode each chat is shown in here. */
  const modes = new Map<string, string>();
  const selections = new Map<string, any>();
  const permissions = new Map<string, any>();
  const kinds = new Map<string, string>();
  const permits: { chatId: string; value: string }[] = [];
  /** The agent a chat's held switch sends as, per chat. */
  const switches = new Map<string, { harness: string }>();
  const state = {
    get: (chatId: string) => ({ queue: queues.get(chatId) ?? [], permission: modes.get(chatId), pendingSwitch: switches.get(chatId) }),
    patch: (chatId: string, p: { queue: any[] }) => (queues.set(chatId, p.queue), patches.push([chatId, p.queue])),
  };
  const owners = new Map<string, { hostId: string; ownerHostId?: string; epoch: number; folder?: string | null }>();
  const ownerOf = (chatId: string) => owners.get(chatId) ?? { hostId: 'local', epoch: 0 };
  const remote = (chatId: string, hostId = o.hostId ?? 'box', epoch = o.epoch ?? 1, folder?: string | null) =>
    owners.set(chatId, { hostId, epoch, ...(folder === undefined ? {} : { folder }) });
  const sent: { chatId: string; item: any; key: string }[] = [];
  const started: { chatId: string; item: any; key: string }[] = [];
  const listeners = new Set<(s: string) => void>();
  const host = {
    up: true,
    failWith: null as any,
    /** What a `chat.send` / `chat.start` answers with (the Host's receipt); nothing by default. */
    receipt: undefined as any,
    stops: [] as any[],
    connects: 0,
    state: () => (host.up ? 'online' : 'offline'),
    onState: (fn: (s: string) => void) => (listeners.add(fn), () => listeners.delete(fn)),
    connect: async () => void host.connects++,
    send: async (chatId: string, item: any, opts: any) => {
      if (host.failWith) throw answered(host.failWith);
      sent.push({ chatId, item, key: opts.key });
      return host.receipt;
    },
    start: async (chatId: string, item: any, opts: any) => {
      if (host.failWith) throw answered(host.failWith);
      started.push({ chatId, item, key: opts.key });
      return host.receipt;
    },
    permitFailWith: null as any,
    permit: async (p: { chatId: string; value: string }) => {
      if (host.permitFailWith) throw host.permitFailWith;
      permits.push(p);
    },
    stop: async (chatId: string, turnId: unknown, opts: any) => void host.stops.push([chatId, opts.key]),
  };
  /** The registry's row for the machine: its status, and the agents its Host reported with what it said of each. */
  const row: { status: string; hostKey?: string; harnesses?: { id: string; planMode?: boolean }[] } = { status: 'online' };
  const rowListeners = new Set<() => void>();
  const pauses: string[] = [];
  const local: { sent: any[]; receipt: any; throws: any } = { sent: [], receipt: { action: 'started' }, throws: null };
  const config = {
    hostFor: (_: string) => host as any,
    subscribed: undefined as undefined | ((chatId: string) => Promise<void>),
    wake: undefined as undefined | ((hostId: string) => unknown),
    canSend: (_chatId: string) => true,
    checkFolder: undefined as undefined | ((hostId: string, folder: string) => Promise<unknown>),
  };
  const outboxDir = path.join(dir, 'host-outbox');
  const outboxes: any[] = [];
  const make = () =>
    createRemoteSend({
      outbox: outboxes[outboxes.push(createOutbox({ dir: outboxDir, report: (e: Error) => reports.push(e) })) - 1],
      ownerOf,
      hostFor: (id: string) => config.hostFor(id),
      rowOf: () => row,
      onRowChange: (fn: () => void) => (rowListeners.add(fn), () => rowListeners.delete(fn)),
      subscribed: (chatId: string) => config.subscribed?.(chatId),
      canSend: (chatId: string) => config.canSend(chatId),
      wake: (hostId: string) => config.wake?.(hostId),
      checkFolder: (hostId: string, folder: string) =>
        config.checkFolder ? config.checkFolder(hostId, folder) : Promise.reject(new Error('no folder checker')),
      state: () => state,
      tray: queueItem,
      selectionOf: (id: string) => selections.get(id),
      permissionOf: (id: string) => permissions.get(id),
      kindOf: (id: string) => kinds.get(id),
      paused: (chatId: string) => pauses.push(chatId),
      localSend: async (chatId: string, item: any) => {
        if (local.throws) throw local.throws;
        local.sent.push([chatId, item]);
        return local.receipt;
      },
      report: (e: Error) => reports.push(e),
    });
  const service = make();
  t.after(() => service.dispose());
  /** The host comes back: the registry row and the connection both say online. */
  const comeBack = () => {
    host.up = true;
    row.status = 'online';
    for (const fn of [...listeners]) fn('online');
    return new Promise((r) => setImmediate(r));
  };
  /** Only the connection comes up (the tunnel answers before the registry's next heartbeat). */
  const connectionUp = () => {
    host.up = true;
    for (const fn of [...listeners]) fn('online');
    return new Promise((r) => setImmediate(r));
  };
  /** Only the registry row turns online (a heartbeat); the connection's state is left as it is. */
  const rowUp = () => {
    row.status = 'online';
    for (const fn of [...rowListeners]) fn();
    return new Promise((r) => setImmediate(r));
  };
  const goAway = () => ((host.up = false), (row.status = 'offline'));
  return {
    clock,
    dir,
    reports,
    queues,
    patches,
    owners,
    remote,
    sent,
    started,
    modes,
    selections,
    permissions,
    kinds,
    switches,
    permits,
    host,
    row,
    pauses,
    config,
    make,
    outboxes,
    local,
    service,
    comeBack,
    connectionUp,
    rowUp,
    rowListeners,
    listeners,
    goAway,
    outboxDir,
  };
}
export const msg = (text: string, id?: string) => ({ text, attachments: [], opts: {}, ...(id ? { id } : {}) });
