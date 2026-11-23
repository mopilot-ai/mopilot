// Records the timers, sockets, watchers and other handles that code under a source root opens and leaves alive, by who created them, not by how many the process holds (#5223).
import { createHook } from 'node:async_hooks';

/** Kinds of async resource that are bookkeeping, not something left running. */
const BOOKKEEPING = new Set(['PROMISE', 'TickObject', 'Microtask']);

/**
 * Watches resources created from now until `stop()`. A resource counts only when its creation stack runs through a file under
 * one of `roots`: node's runner, reporter and stdio open resources of their own in the same process, and a count of everything
 * pending (process.getActiveResourcesInfo) blamed one of them on the code under test on a slow Linux runner.
 */
export function watchResources(roots: string[]) {
  const live = new Map<number, { type: string; stack: string; mine: boolean }>();
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 60;
  const hook = createHook({
    init(id, type) {
      if (BOOKKEEPING.has(type)) return;
      const stack = new Error().stack as string;
      live.set(id, { type, stack, mine: roots.some((root) => stack.includes(root)) });
    },
  }).enable();
  return {
    /** The types and creating frames of what the code under `roots` left alive, and of what others did meanwhile. */
    stop() {
      hook.disable();
      Error.stackTraceLimit = limit;
      const all = [...live.values()];
      const frames = (r: { type: string; stack: string }) =>
        `${r.type} at ${
          r.stack
            .split('\n')
            .slice(1)
            .map((l) => l.trim().replace(/^at /, ''))
            .find((l) => roots.some((root) => l.includes(root))) ?? 'node or the test runner'
        }`;
      return { opened: all.filter((r) => r.mine).map(frames), ambient: all.filter((r) => !r.mine).map(frames) };
    },
  };
}
