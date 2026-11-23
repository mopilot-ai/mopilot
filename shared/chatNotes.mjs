// Where a chat's saved notes (an account switch, answered questions, a refused app, a MoMo nudge) go back among its turns: the window (src/lib/chatMeta.ts) and Chrome's side panel (electron/app/chromePanel.cjs) place them the same way.

/** Whether two turn ids name one turn: a live turn is ct-<uuid>, the same turn read back from the transcript h-<uuid>. */
export const turnIdentity = (id) => /^(?:ct|h|pending)-(.+)$/.exec(id)?.[1] ?? id;
export function sameTurn(a, b) {
  return turnIdentity(a) === turnIdentity(b);
}

/**
 * The turn a note goes back after: its own turn when shown. A note whose turn is not shown (compacted away, or on an
 * older page not read yet) goes after the latest shown turn that began before it was written, and nowhere (-1) when
 * every shown turn began after it (#1949): the saved index counts turns the chat no longer shows. Turns with no start
 * times, and a note with no turn id (the chat's latest turn), keep the saved index; a note without one goes nowhere.
 */
function noteTurn(turns, n) {
  const own = n.turnId ? turns.findIndex((t) => sameTurn(t.id, n.turnId)) : -1;
  if (own >= 0) return own;
  if (n.turnId && turns.some((t) => typeof t.startedAt === 'number'))
    return turns.findLastIndex((t) => typeof t.startedAt === 'number' && t.startedAt * 1000 <= n.at);
  return Number.isInteger(n.turn) ? Math.min(n.turn, turns.length - 1) : -1;
}

/**
 * Whether placing these notes needs the whole history: one with no turn id goes by the saved index of a turn (the count of turns
 * before it in the whole chat), which means nothing to a read of only the end of the history.
 * @param {{ turnId?: string | null }[] | undefined} notes
 */
export const notesNeedWholeHistory = (notes) => !!notes?.some((n) => !n.turnId);

/** A loaded chat's turns with its saved notes put back after the turns they followed, as statusNote items. */
export function withChatNotes(turns, notes) {
  if (!notes?.length || !turns.length) return turns;
  const out = turns.slice();
  for (const n of notes) {
    if (out.some((t) => t.items.some((it) => it.id === n.id))) continue;
    const i = noteTurn(out, n);
    if (i < 0) continue;
    // a hook run's line reads as it did live (shared/hookRuns.mjs), first in its turn when it ran before the turn did
    const note =
      n.kind === 'hook'
        ? { type: 'hookPrompt', id: n.id, fragments: [{ text: n.text }] }
        : {
            type: 'statusNote',
            id: n.id,
            kind: n.kind,
            text: n.text,
            ...(n.answers ? { answers: n.answers } : {}),
            ...(n.refused ? { refused: n.refused } : {}),
            ...(n.nudge ? { nudge: n.nudge } : {}),
            ...(n.draft ? { draft: n.draft } : {}),
            ...(n.send ? { send: n.send } : {}),
            ...(n.suggestion ? { suggestion: n.suggestion } : {}),
            // a browser hand-off (electron/capabilities/browser/handoffNotes.cjs): where, why, and whether it is over
            ...(n.kind === 'handoff' ? { site: n.site, reason: n.reason, done: !!n.done } : {}),
          };
    out[i] = { ...out[i], items: n.lead && n.turnId ? [note, ...out[i].items] : [...out[i].items, note] };
  }
  return out;
}
