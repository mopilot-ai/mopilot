// A fake Codex app-server's threads as the real one keeps them (#2276): in memory only until a turn/start records the
// first user message. Before then thread/turns/list answers "not materialized yet", thread/memoryMode/set "no rollout
// found", and an unloaded thread is gone ("thread not loaded"). Handlers for fixture.ts setup().
import type { Handler } from './fixture.ts';

type Kept = { loaded: boolean; recorded: boolean; memory: string };

export const MEMORY_OFF = 'thread/memoryMode/set';

/** `memory(threadId, n)` runs first on each thread/memoryMode/set (the nth): throw from it to refuse that one. */
export function codexThreads(o: { memory?: (threadId: string, n: number) => void } = {}) {
  const threads = new Map<string, Kept>();
  let n = 0;
  const handlers: Record<string, Handler> = {
    'thread/start': () => {
      const id = `th-${++n}`;
      threads.set(id, { loaded: true, recorded: false, memory: 'enabled' });
      return { thread: { id, cwd: '/momo', name: null, preview: '', ephemeral: false } };
    },
    'thread/turns/list': (p) => {
      const t = threads.get(p.threadId);
      if (!t) throw new Error(`no rollout found for thread id ${p.threadId}`);
      if (!t.recorded)
        throw new Error(`thread ${p.threadId} is not materialized yet; thread/turns/list is unavailable before first user message`);
      return { data: [], nextCursor: null, backwardsCursor: null };
    },
    [MEMORY_OFF]: (p, count) => {
      o.memory?.(p.threadId, count);
      const t = threads.get(p.threadId);
      if (!t?.recorded) throw new Error(`no rollout found for thread id ${p.threadId}`);
      t.memory = p.mode;
      return {};
    },
    'thread/unsubscribe': (p) => {
      const t = threads.get(p.threadId);
      // nothing of it on disk: unloading it is the end of it
      if (t && !t.recorded) threads.delete(p.threadId);
      else if (t) t.loaded = false;
      return {};
    },
    'turn/start': (p) => {
      const t = threads.get(p.threadId);
      if (!t?.loaded) throw new Error(`thread not loaded: ${p.threadId}`);
      t.recorded = true;
      return { turn: { id: `turn-${p.threadId}` } };
    },
  };
  return { threads, handlers };
}
