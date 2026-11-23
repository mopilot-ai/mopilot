// What one turn of a chat changed in its folder on a Host (#5255), for the Changes pane's Last Turn: the feature both ends declare, the method and its parser. An older Host has none: the app says to update it.

/** Declared by a Host that serves `host.gitTurnDiff`; an end without it is never sent one. */
export const GIT_TURN_DIFF_FEATURE = 'gitTurnDiff';
export const GIT_TURN_DIFF_METHOD = 'host.gitTurnDiff';
/** The longest turn id the Host looks up. */
export const MAX_TURN_ID = 200;

/** @param {(v: unknown, what: string) => string} pathOf schema.mjs's absolute-path check @param {(m: string) => Error} bad */
export const gitTurnDiffParsers = (pathOf, bad) => ({
  [GIT_TURN_DIFF_METHOD]: (/** @type {any} */ p) => {
    if (typeof p.turnId !== 'string' || !p.turnId || p.turnId.length > MAX_TURN_ID || p.turnId.includes('\0'))
      throw bad('That is not a turn.');
    return { path: pathOf(p.path, 'a folder'), turnId: p.turnId };
  },
});
