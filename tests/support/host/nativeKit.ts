// Shared pieces of the native-session Host tests (#5576): a Host's chat methods over a journal of given chats with a native index the test feeds, a principal of a kind, and a native session.
import chatsMethods from '../../../host/src/methods/chats.mjs';
import { createChatIndex } from '../../../host/src/chatIndex.mjs';

export const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const who = (kind: string | null, fingerprint = 'fp') => ({ principal: () => (kind ? { kind, fingerprint } : null) });
export const session = (n: number, over: Record<string, unknown> = {}) => ({
  family: 'claude' as const,
  id: UUID(n),
  title: `session ${n}`,
  folder: '/work/app',
  createdAt: n,
  updatedAt: n * 10,
  ...over,
});

/** A Host's chat methods with a journal of the given chats and a native index the test feeds. */
export function host(chats: { chatId: string; updatedAt: number }[] = [], option: object | null = {}, load?: () => Promise<any[]>) {
  let native: any;
  const log: any = {
    chats: load ?? (async () => chats.map((c) => ({ title: '', createdAt: 1, ...c }))),
    fillTitle: () => ({ status: 'deferred' }),
  };
  log.index = createChatIndex({ load: () => log.chats(), epoch: () => 3 });
  const made: any = chatsMethods({
    dataDir: '/data',
    log,
    epochs: { current: () => 3 },
    nativeSessions: option ? { ...option, attach: (i: any) => ((native = i), (option as any)?.consumer) } : undefined,
  } as any);
  return {
    made,
    log,
    get native() {
      return native;
    },
  };
}
export const list = (h: any, p: object, kind: string | null) =>
  h.made.handlers['host.chats']({ limit: 50, ...p }, 'x', who(kind), undefined, new Set());
