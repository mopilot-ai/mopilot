// The turns still running when the Host is told to stop end as interrupted by the Host's stop, before its children are ended (Remote Run #5162): each chat then says why its turn ended ("The machine restarted during this turn…", the Host's own cause) in place of the harness's "quit while working", and host.log names the chats, as the recovery after a hard kill does.

/**
 * @param {object} o
 * @param {{ pending: () => [turnId: string, chatId: string][] }} o.journal the run journal (./runJournal.mjs)
 * @param {{ interrupted: (left: [turnId: string, chatId: string][]) => number | void }} o.protocol ends each turn for its chat's clients (./protocol.mjs)
 * @param {(line: string) => void} o.report where the Host writes what it did
 * @returns {number} how many turns were ended
 */
export function endTurnsAtStop({ journal, protocol, report }) {
  const left = journal.pending();
  if (left.length === 0) return 0;
  protocol.interrupted(left);
  const chats = [...new Set(left.map(([, chatId]) => chatId))];
  report(`Ended ${left.length} running turn(s) at stop, as interrupted by the stop (chats: ${chats.join(', ')}).`);
  return left.length;
}
