// A machine, its Host and the chat index over them for tests (electron/host/chatIndex.cjs): the Host answers watch and pages from `pages`, tests push events to the connection that opened, hold or fail calls, and change what the registry says.
import { afterEach } from 'node:test';
import { createRequire } from 'node:module';
import { waitFor } from '../waitFor.ts';

const require = createRequire(import.meta.url);
const { createChatIndex } = require('../../../electron/host/chatIndex.cjs');

/** Every index a test made, ended with the test: a wait or request left running would start a real timer after the fake clock is gone. */
const made: { dispose: () => void }[] = [];
afterEach(() => made.splice(0).forEach((i) => i.dispose()));

export const row = (n: number, o: object = {}) => ({
  chatId: `c${n}`,
  title: `chat ${n}`,
  harness: 'claude',
  createdAt: n,
  updatedAt: n,
  epoch: 1,
  rev: 1,
  state: 'idle',
  ...o,
});
export const event = (seq: number, chat: any, kind = 'changed', extra: object = {}) => ({
  event: 'chats',
  op: 'upsert',
  kind,
  seq,
  generation: 'g1',
  chatId: chat.chatId,
  chat,
  ...extra,
});

export type WorldOptions = {
  pages?: any[][];
  online?: boolean;
  off?: boolean;
  at?: number;
  generation?: string;
  incomplete?: boolean;
  failOpen?: boolean;
  /** Answers a call in place of the Host's normal answer; undefined falls through to it. */
  call?: (method: string, params: any, n: number) => unknown;
  /** The features the Host answers hello with (default: the chat list, its paging and events). */
  features?: string[];
  maxRows?: number;
  pageSize?: number;
  notify?: (id: string, kind: string, row: any) => void;
  onChange?: () => void;
};

export function world(o: WorldOptions = {}) {
  const calls: string[] = [];
  const opened: string[] = [];
  const sessions: { onEvent: (e: any) => void; closed: number }[] = [];
  const changes: number[] = [];
  const notified: any[] = [];
  const reported: unknown[] = [];
  const machine = { present: true, online: o.online ?? true, off: o.off, pin: 'k1' };
  const pages = o.pages ?? [[]];
  let gate: Promise<void> | null = null;
  let n = 0;
  const index = createChatIndex({
    machines: () =>
      machine.present
        ? [{ id: 'm', online: machine.online, off: machine.off, pin: machine.pin, record: { id: 'm', pin: machine.pin } }]
        : [],
    open: async (record: any, onEvent: any) => {
      opened.push(`${record.id}:${record.pin}`);
      if (o.failOpen) throw new Error('no route');
      const s = { onEvent, closed: 0, hello: false };
      sessions.push(s);
      return {
        close: () => void s.closed++,
        call: async (method: string, params: any) => {
          // a real Host serves the versioned methods only after hello (host/src/versionedMethods.mjs)
          if (method !== 'host.hello' && !s.hello) throw Object.assign(new Error('Say host.hello first.'), { code: 'hello_required' });
          if (method === 'host.hello') s.hello = true;
          calls.push(method === 'host.chats' ? `${method}:${params?.cursor ?? ''}` : method);
          const custom = o.call?.(method, params, n++);
          if (custom !== undefined) return custom;
          if (method === 'host.hello')
            return {
              protocol: { minor: 1, floor: 1 },
              features: o.features ?? ['chatList', 'chatPaging', 'chatEvents'],
              capabilities: {},
              moved: [],
            };
          if (method === 'host.chats.watch') return { watching: true, at: 0, generation: o.generation ?? 'g1' };
          if (gate) await gate;
          const at = Number(String(params?.cursor ?? '0').replace('p', ''));
          return {
            chats: pages[at] ?? [],
            next: at + 1 < pages.length ? `p${at + 1}` : undefined,
            at: o.at ?? 0,
            generation: o.generation ?? 'g1',
            ...(o.incomplete ? { incomplete: true } : {}),
          };
        },
      };
    },
    notify: (id: string, kind: string, r: any) => {
      notified.push([id, kind, r.chatId]);
      o.notify?.(id, kind, r);
    },
    onChange: () => {
      changes.push(1);
      o.onChange?.();
    },
    report: (e: unknown) => reported.push(e),
    pageSize: o.pageSize ?? 2,
    ...(o.maxRows ? { maxRows: o.maxRows } : {}),
  });
  made.push(index);
  const state = () => index.snapshot()[0]?.state;
  return {
    index,
    machine,
    calls,
    opened,
    sessions,
    notified,
    changes,
    reported,
    state,
    rows: () => index.snapshot()[0]?.rows.map((r: any) => r.chatId) ?? [],
    /** Resolves once the machine's index is in `want` (its answer to the first sync or a later retry). */
    until: (want: string, what = `the index to be ${want}`) => waitFor(() => state() === want, what),
    push: (e: any, which = sessions.length - 1) => sessions[which].onEvent(e),
    hold: () => {
      let release!: () => void;
      gate = new Promise((r) => (release = r));
      return () => {
        gate = null;
        release();
      };
    },
  };
}
