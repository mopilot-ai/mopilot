// The chat line a browser hand-off leaves (kind 'handoff'): "Finish signing in on your Mac" while the user's turn on a site is open, marked
// done with how it ended. A chat note (meta.notes), so the window, the Chrome side panel and a phone's history show it on every harness with
// no window open; paired phones following the chat live get the same item at once by its id (chromePanelPhones.cjs). A hold the app
// forgot (it restarted) is marked done at startup, so no phone keeps asking for a sign-in nobody waits for.
const { isMomoMeta } = require('../../../shared/momoChat.mjs');

/** Listeners for each item as it changes: (chatId, item) => void (the paired phones' feed). */
const listeners = new Set();

/** @typedef {{ site: string, reason: string, credential?: boolean, since: number }} Hold */

/** What the line says: open, then how it ended. */
function textOf(/** @type {string} */ site, /** @type {boolean} */ credential, /** @type {string | null} */ how) {
  if (!how) return credential ? `Finish signing in to ${site} on your Mac` : `Your turn on ${site} on your Mac`;
  return how === 'done' ? `Done on ${site}` : `Hand-off on ${site} ended`;
}

/** The transcript item a note is (shared/chatNotes.mjs puts it back among the turns the same way). */
const itemOf = (/** @type {any} */ n) => ({
  type: 'statusNote',
  id: n.id,
  kind: 'handoff',
  text: n.text,
  site: n.site,
  reason: n.reason,
  done: n.done,
});

/**
 * Writes (or rewrites, by its id) a hand-off's line in the chat and tells the listeners. False when the chat is not one the store has.
 * @param {{ record(id: string): any, patchMeta(id: string, patch: object): boolean } | null | undefined} chats
 * @param {string} chatId
 * @param {string} id the hold's own id (a tab's hand-off, or the chat's Chrome sign-in)
 * @param {Hold} hold
 * @param {string | null} [how] how it ended; null while it is open
 */
function noteHandoff(chats, chatId, id, hold, how = null, now = Date.now()) {
  if (!chats) return false;
  const record = chats.record(chatId);
  if (!record) return false;
  const notes = record.meta?.notes ?? [];
  const at = notes.findIndex((/** @type {any} */ n) => n.id === id);
  const note = {
    id,
    kind: 'handoff',
    text: textOf(hold.site, !!hold.credential, how),
    site: hold.site,
    reason: hold.reason,
    done: !!how,
    ...(how ? { how } : {}),
    // no turn id: it follows the chat's latest turn (the one that handed over)
    turnId: null,
    turn: Number.MAX_SAFE_INTEGER,
    at: at >= 0 ? notes[at].at : now,
  };
  if (at < 0 && how) return false;
  const next = at >= 0 ? notes.map((/** @type {any} */ n, /** @type {number} */ i) => (i === at ? note : n)) : [...notes, note];
  // patchMeta-changes: a note is added or replaced, so the notes always change
  if (!chats.patchMeta(chatId, { notes: next })) return false;
  for (const fn of listeners) fn(chatId, itemOf(note));
  return true;
}

/** Marks every open hand-off line of every chat done (the app started: no hold from before survives it); returns how many. */
function settleStale(
  /** @type {{ records: Map<string, any>, record(id: string): any, patchMeta(id: string, patch: object): boolean } | null | undefined} */ chats,
) {
  let n = 0;
  for (const [chatId, record] of chats?.records ?? []) {
    // MoMo's chats never hand a browser over to the user
    if (isMomoMeta(record?.meta)) continue;
    for (const note of record?.meta?.notes ?? []) {
      if (note.kind !== 'handoff' || note.done) continue;
      if (noteHandoff(chats, chatId, note.id, { site: note.site, reason: note.reason, since: note.at }, 'gone')) n++;
    }
  }
  return n;
}

/** Subscribes to every hand-off line as it changes; returns the unsubscribe. */
function onHandoffItem(/** @type {(chatId: string, item: any) => void} */ fn) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

module.exports = { noteHandoff, settleStale, onHandoffItem, itemOf, textOf };
