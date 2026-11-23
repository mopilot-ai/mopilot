// Claude Code transcripts as main and the turns worker read them, in the Rust core (core/crates/translate/src/claude): messages
// go across as lines, a read is held there by id, and what is asked of it is cut on a core thread. Below the harness, which
// reads with it, because the worker that opens a read lives here.
const { core, requiredCore } = require('./core.cjs');
const { noteIgnored } = require('../ignored.cjs');

/** How many records a read writes out at a time, about a millisecond's worth of the thread doing it. */
const RECORDS_AT_A_TIME = 2048;

/**
 * Messages as the lines the core's reads take, a batch at a time with `step` around each, the thread giving way between them.
 * @param {Record<string, unknown>} header @param {any[]} messages @param {(run: () => any) => any} step
 */
async function linesOf(header, messages, step) {
  const parts = [Buffer.from(JSON.stringify(header))];
  for (let at = 0; at < messages.length; at += RECORDS_AT_A_TIME) {
    await new Promise(setImmediate);
    const batch = messages.slice(at, at + RECORDS_AT_A_TIME);
    parts.push(step(() => Buffer.from(`\n${batch.map((message) => JSON.stringify(message)).join('\n')}`)));
  }
  return step(() => Buffer.concat(parts));
}

/**
 * A read of `messages`, what `getSessionMessages` gave and what its reader dropped put back, on a core thread: its id, for
 * `historyPage`, and a release to make when no one will ask again.
 * @param {any[]} messages @param {string} threadId @param {string} cwd
 * @param {{ key: string, step?: (run: () => any) => any, ignored?: (what: string, error: unknown) => void }} o
 * @returns {Promise<number>}
 */
async function openHistory(messages, threadId, cwd, { key, step = (run) => run(), ignored = noteIgnored }) {
  const payload = await linesOf({ threadId, cwd, auto: key, now: Date.now(), sourceIds: true }, messages, step);
  const { id, unread } = JSON.parse(String(await requiredCore(core()).dispatch('translate.claudeRead', payload)));
  // without the lines' text
  if (unread) ignored("read a Claude Code chat's transcript", `${unread} unreadable line${unread === 1 ? '' : 's'} skipped`);
  return id;
}

/**
 * A page as the core gives it: a byte for whether there are older turns, a line of its turn ids, then its JSON, which goes to
 * the window unread.
 * @param {Buffer} reply
 */
function pageOf(reply) {
  const end = reply.indexOf(10);
  return { page: reply.subarray(end + 1), ids: JSON.parse(String(reply.subarray(1, end))), older: reply[0] === 49 };
}

/**
 * @typedef {{ liveTail?: boolean, closedTail?: boolean, open?: boolean, limit?: number, before?: string | null, live?: string | null }} Asked
 *   limit: how many turns at most, 0 for all of them; live: the turn the session is running here, which a turn left open takes
 *   the id of
 */

/**
 * A page of a read held by id, cut on a core thread, since one long turn is a page as long as itself; this thread has only that
 * reply's copy to make.
 * @param {number} id @param {Asked} [asked]
 * @returns {Promise<ReturnType<typeof pageOf>>}
 */
const historyPage = async (id, asked = {}) =>
  pageOf(await requiredCore(core()).dispatch('translate.claudeSettle', Buffer.from(JSON.stringify({ ...asked, id, now: Date.now() }))));

/** @param {number} id */
const releaseHistory = (id) => void requiredCore(core()).dispatchSync('translate.claudeRelease', Buffer.from(String(id)));

/** How much JSON main parses at a time when it reads a whole chat for itself: a few milliseconds of its thread. */
const WALK_BYTES = 512 * 1024;

/**
 * Every turn of a read held by id, for main's own readers (a harness switch, a peer's history): a little at a time, each parsed
 * in a step of its own and even a single long turn cut between items, so that a long chat never holds this thread for its
 * whole size. The turns are the read's: a reader that wants what the session said since asks again.
 * @param {number} id @param {{ open?: boolean }} [o]
 * @returns {Promise<any[]>}
 */
async function allTurns(id, { open = false } = {}) {
  /** @type {any[]} */
  const turns = [];
  /** @type {[number, number] | null} */
  let at = [0, 0];
  while (at) {
    const payload = JSON.stringify({ id, open, turn: at[0], item: at[1], bytes: WALK_BYTES });
    const reply = await requiredCore(core()).dispatch('translate.claudeWalk', Buffer.from(payload));
    const { continues, turns: more, rest } = JSON.parse(String(reply));
    if (continues) turns.at(-1).items.push(...more.shift().items);
    turns.push(...more);
    at = rest;
    if (at) await new Promise(setImmediate);
  }
  return turns;
}

/**
 * A stored sub-agent transcript as agent page items, on a core thread, and the model its messages name; a settled run's open
 * tools were cut off.
 * @param {any[]} messages @param {string} threadId @param {string} cwd @param {boolean} settled
 * @returns {Promise<Buffer>} JSON `{ items, model, unread }`, which goes to the window unread
 */
async function agentItems(messages, threadId, cwd, settled) {
  const payload = await linesOf({ threadId, cwd, settled, now: Date.now() }, messages, (run) => run());
  return requiredCore(core()).dispatch('translate.claudeAgentItems', payload);
}

module.exports = { openHistory, historyPage, releaseHistory, allTurns, agentItems, pageOf };
