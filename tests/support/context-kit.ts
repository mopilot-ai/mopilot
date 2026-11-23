// Stand-ins for the context displays' tests (the ring, the summary card, the context panel): main's context bridge with its answers and pushes recorded, the chat's session and capabilities, account windows and actions.
import { mock } from 'node:test';
import { emptySnapshot } from '../../shared/contextSnapshot.mjs';
import type { ContextSnapshot } from '../../shared/contextSnapshot.mjs';
import type { fakeStore } from './shell-panels-kit.ts';
import { installNativeStub } from './ports/native.ts';
import { stubStore, stubSlice } from './stubs.ts';

export type Ask = ['get' | 'refresh', string, ...unknown[]];

/** Mock every module the context displays reach beyond the store; call before importing them. */
export function mockContextModules(store: ReturnType<typeof fakeStore>, { mockAccountView = true } = {}) {
  const ctx = {
    asks: [] as Ask[],
    ignored: [] as unknown[][],
    compacted: [] as string[],
    opened: [] as string[],
    /** what main answers an ask with */
    answer: (async () => null) as (...a: Ask) => Promise<ContextSnapshot | null>,
    push: null as null | ((e: { chatId: string; snapshot: ContextSnapshot }) => void),
    turn: 'idle',
    queue: [] as any[],
    compaction: null as string | null,
    activeTurn: null as import('../../shared/model/session').SessionState['activeTurn'],
    windows: [] as unknown[],
    blocked: null as string | null,
    /** the chat's compact capability as main resolves it, or null while it is not loaded */
    compactCap: null as string | null,
    /** what a compact request waits on before it settles */
    compactWait: Promise.resolve() as Promise<void>,
    compactReceipt: { action: 'started', id: 'compact' } as unknown,
  };
  Object.assign(store.exports, {
    blockedReason: () => ctx.blocked,
    chatFamily: (id: string) => {
      const h = store.get().segments?.[id]?.at(-1)?.harness ?? 'codex';
      return h.startsWith('acp:') ? 'acp' : h;
    },
  });
  stubStore(store.exports);
  installNativeStub({
    context: {
      get: (owner: string) => (ctx.asks.push(['get', owner]), ctx.answer('get', owner)),
      refresh: (owner: string, detail: string) => (ctx.asks.push(['refresh', owner, detail]), ctx.answer('refresh', owner, detail)),
      onSnapshot: (fn: (e: { chatId: string; snapshot: ContextSnapshot }) => void) => {
        ctx.push = fn;
        return () => {};
      },
    },
  });
  mock.module('../../src/lib/ignored.ts', {
    namedExports: {
      noteIgnored: (...args: unknown[]) => ctx.ignored.push(args),
      errorText: String,
      ignoring: (what: string) => (e: unknown) => ctx.ignored.push([what, e]),
    },
  });
  mock.module('../../src/store/session/useSession.ts', {
    namedExports: {
      flushSessionPatches: () => {},
      useSession: () => ({ turn: ctx.turn, queue: ctx.queue, compaction: ctx.compaction, activeTurn: ctx.activeTurn }),
      useSessionField: (_id: string, pick: any) =>
        pick({ turn: ctx.turn, queue: ctx.queue, compaction: ctx.compaction, activeTurn: ctx.activeTurn }),
    },
  });
  mock.module('../../src/store/session/useCaps.ts', {
    namedExports: {
      useChatCaps: () =>
        ctx.compactCap === null ? { loaded: false, caps: {} } : { loaded: true, caps: { compact: { state: ctx.compactCap } } },
    },
  });
  if (mockAccountView) {
    mock.module('../../src/session/harness/chatAccountView.ts', { namedExports: { useChatAccountView: () => ({ windows: ctx.windows }) } });
  }
  stubSlice('src/store/actions.ts', {
    compactThread: async (id: string) => {
      ctx.compacted.push(id);
      await ctx.compactWait;
      return ctx.compactReceipt;
    },
  });
  mock.module('../../src/session/open.ts', { namedExports: { openFile: (p: string) => void ctx.opened.push(p) } });
  return ctx;
}

/** A snapshot for an owner, with what the test names. */
export const snapshotOf = (owner: string, o: Partial<ContextSnapshot> = {}): ContextSnapshot => ({
  ...emptySnapshot(owner, 1000),
  ...o,
});

/** The owner key of a chat on a segment ([chat, harness, native id]). */
export const ownerOf = (chatId: string, harness: string, nativeId: string) => JSON.stringify([chatId, harness, nativeId]);
