// Fakes for the tests of the mirror of chats on a machine (electron/host/remoteChats.cjs): a Host that answers a subscribe and fires its events, a transcript store and the world around them.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
export const { createRemoteChats } = require('../../../electron/host/remoteChats.cjs');

export const CHAT = 'acp:kimi:c1';
export const tick = () => new Promise((r) => setImmediate(r));

export const ev = (event: object) => ({ t: 'event', family: 'acp', event });
export const start = (turnId = 't1', cwd = '/srv/work') => ev({ kind: 'turnStart', turnId, user: { id: 'u1', content: [] }, cwd });
export const text = (t: string, turnId = 't1', extra: object = {}) =>
  ev({ kind: 'update', turnId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t }, ...extra } });
export const end = (turnId = 't1') => ev({ kind: 'turnEnd', turnId, stopReason: 'end_turn', usage: { in: 1 } });

export class FakeItems {
  records: any[] = [];
  flushed: string[] = [];
  append(_id: string, ...records: any[]) {
    this.records.push(...records);
  }
  async flush(id: string) {
    this.flushed.push(id);
  }
  file(id: string) {
    return `${id}.items.jsonl`;
  }
  async size() {
    return this.records.length;
  }
  async readAsync() {
    return [...this.records];
  }
}

export function fakeHost(opts: { state?: string } = {}) {
  const fns = {
    patch: new Set<any>(),
    frame: new Set<any>(),
    resync: new Set<any>(),
    inflight: new Set<any>(),
    state: new Set<any>(),
    closed: new Set<any>(),
  };
  const asked: any[] = [];
  const host: any = {
    st: opts.state ?? 'online',
    asked,
    reply: { snapshot: { rev: 0, items: [] }, patches: null, generation: 'g1', inflight: [] } as any,
    answer: async () => ({ answered: true }),
    state: () => host.st,
    connect: async () => undefined,
    onState: (fn: any) => (fns.state.add(fn), () => fns.state.delete(fn)),
    subscribe: async (chatId: string, from?: number, gen?: string) => (asked.push([chatId, from, gen]), host.reply),
    events: {
      onPatch: (fn: any) => (fns.patch.add(fn), () => fns.patch.delete(fn)),
      onFrame: (fn: any) => (fns.frame.add(fn), () => fns.frame.delete(fn)),
      onResync: (fn: any) => (fns.resync.add(fn), () => fns.resync.delete(fn)),
      onInflight: (fn: any) => (fns.inflight.add(fn), () => fns.inflight.delete(fn)),
      onClosed: (fn: any) => (fns.closed.add(fn), () => fns.closed.delete(fn)),
    },
    fire: {
      patch: (chatId: string, rev: number, item: any, promotes?: string) =>
        fns.patch.forEach((f) => f({ chatId, rev, patch: { item, ...(promotes ? { promotes } : {}) } })),
      delta: (chatId: string, key: string, delta: any) => fns.frame.forEach((f) => f({ chatId, frame: { t: 'delta', key, delta } })),
      frame: (chatId: string, frame: any) => fns.frame.forEach((f) => f({ chatId, frame })),
      resync: (chatId: string, snapshot: any, generation = 'g1') => fns.resync.forEach((f) => f({ chatId, snapshot, generation })),
      inflight: (chatId: string, inflight: any) => fns.inflight.forEach((f) => f({ chatId, inflight })),
      closed: (chatId: string, reason: string) => fns.closed.forEach((f) => f({ chatId, reason })),
      state: (s: string) => ((host.st = s), fns.state.forEach((f) => f(s))),
    },
    listeners: () => Object.values(fns).reduce((n, s) => n + s.size, 0),
  };
  return host;
}

export function world(
  host: any = fakeHost(),
  items = new FakeItems(),
  sent?: {
    take: (chatId: string) => string | undefined;
    seen: (chatId: string, text: string | undefined, key?: string) => void;
    attached?: (chatId: string, key?: string) => any[] | undefined;
    settleSteered?: (chatId: string) => void;
  },
) {
  const emitted: any[] = [];
  const reported: any[] = [];
  let owner: { hostId: string; folder: string | null } = { hostId: 'm1', folder: '/srv/work' };
  const hosts: Record<string, any> = { m1: host };
  const chats = createRemoteChats({
    items,
    hostFor: (id: string) => hosts[id] ?? null,
    ownerOf: () => owner,
    emit: (e: object) => emitted.push(e),
    ...(sent ? { sent } : {}),
    now: () => 1000,
    report: (e: Error) => reported.push(e),
  });
  return { chats, host, items, emitted, reported, hosts, setOwner: (o: typeof owner) => (owner = o) };
}
