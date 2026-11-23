// Bounded read-only history cursors pin the chat epoch, journal generation and committed revision without replaying effects.
export const HISTORY_FEATURE = 'historyPages';
export const HISTORY_METHODS = ['chat.history'];
export const HISTORY_CHARS = 128 * 1024;
export function historyParsers({ scoped, bad }) {
  return {
    'chat.history': (p) => {
      if (typeof p.generation !== 'string' || !/^[\w.:-]{1,128}$/.test(p.generation))
        throw bad('That history cursor has no journal generation.');
      for (const key of ['rev', 'index', 'offset'])
        if (!Number.isSafeInteger(p[key]) || p[key] < 0) throw bad('That history cursor is invalid.');
      return { ...scoped(p), generation: p.generation, rev: p.rev, index: p.index, offset: p.offset };
    },
  };
}
