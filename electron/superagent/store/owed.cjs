// Superagent owed events: an event stays owed to a ticket until a worker run confirms it holds it.
// Pattern: langchain-ai/open-swe openswe/webhooks/event_matches.py.

/**
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ now: () => number }} o
 */
function createOwed(db, { now }) {
  const insert = db.prepare('INSERT OR IGNORE INTO owed (ticket_id, event_id, owed_at) VALUES (?, ?, ?)');
  const confirmStmt = db.prepare('UPDATE owed SET confirmed_at = ? WHERE ticket_id = ? AND event_id = ? AND confirmed_at IS NULL');
  const list = db.prepare('SELECT event_id FROM owed WHERE ticket_id = ? AND confirmed_at IS NULL ORDER BY event_id');

  /** Records that the ticket is owed the event; owing it twice is one debt. @returns {boolean} whether it is new */
  const owe = (ticketId, eventId) => insert.run(ticketId, eventId, now()).changes === 1;
  /** The event ids still owed to the ticket, oldest first. */
  const owedTo = (ticketId) => list.all(ticketId).map((r) => r.event_id);
  /** A worker run confirmed it holds these events; returns how many were still owed. */
  const confirm = (ticketId, eventIds) => eventIds.reduce((n, id) => n + confirmStmt.run(now(), ticketId, id).changes, 0);

  return { owe, owedTo, confirm };
}

module.exports = { createOwed };
