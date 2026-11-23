// A linked session's working time and the files its turns edited outside its declared paths (writeScope.cjs): main
// stamps each turn it dispatches to the session, and settles the time and those files into the session's record when
// the turn ends, finished, stopped, failed or lost.
const { outsideOf } = require('./writeScope.cjs');
const { inert } = require('../../../shared/sideSessions.mjs');

/** Out-of-scope files kept on a record across its turns, the newest first. */
const OUTSIDE_KEPT = 50;
/** Out-of-scope files one note names; the rest are counted. */
const OUTSIDE_NAMED = 10;

/**
 * A turn is about to start in a chat (ChatController beforeDispatch): a linked session's works from now. A stamp a
 * turn left without ending (its start never went out) is replaced.
 * @param {any} orch the Orchestrator
 * @param {{ chatId: string, kind: string }} delivery
 */
function turnBegan(orch, { chatId, kind }) {
  if (orch.unavailable || kind !== 'turn' || !orch.journal.child(chatId)) return;
  const at = orch.o.now();
  orch.journal.change((d) => {
    const c = d.children[chatId];
    c.worked = { ms: c.worked?.ms ?? 0, turns: c.worked?.turns ?? 0, since: at };
  });
}

/**
 * The child's turn ended: its time joins the record's, and the files it edited outside its declared paths join the
 * record's list. Changes the child's record `c` in a journal draft; returns what the turn's note to its parent adds.
 * @param {any} orch the Orchestrator (o.now, o.controller.editedPaths)
 * @param {string} childId
 * @param {any} c
 * @returns {string}
 */
function settleTurn(orch, childId, c) {
  if (c.worked?.since != null)
    c.worked = { ms: c.worked.ms + Math.max(0, orch.o.now() - c.worked.since), turns: c.worked.turns + 1, since: null };
  const edited = orch.o.controller.editedPaths?.take(childId) ?? [];
  if (!c.paths?.length || !edited.length) return '';
  const outside = outsideOf(edited, c.cwd, c.paths);
  if (!outside.length) return '';
  // the newest first, so a full list still shows what the latest turns did
  c.outside = [...new Set([...outside, ...(c.outside ?? [])])].slice(0, OUTSIDE_KEPT);
  const named = outside.slice(0, OUTSIDE_NAMED).map(inert).join(', ');
  const more = outside.length > OUTSIDE_NAMED ? ` and ${outside.length - OUTSIDE_NAMED} more` : '';
  return ` Edited outside its declared paths (${c.paths.map(inert).join(', ')}): ${named}${more}. Check those files before you rely on them.`;
}

module.exports = { turnBegan, settleTurn, OUTSIDE_KEPT, OUTSIDE_NAMED };
