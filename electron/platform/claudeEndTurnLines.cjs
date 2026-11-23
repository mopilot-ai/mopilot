// The lines of a Claude Code transcript that ended their turn on a tool result (the MCP end-turn flag: the wrap-up box).
// The SDK's getSessionMessages drops the line's `mcpMeta`, where the CLI keeps the flag, so the window could not tell
// such a turn was over and read the next prompt into it. Read from the file itself, past what was read before.
const fs = require('node:fs');
const { CLAUDE_END_TURN, endsClaudeTurn } = require('../../shared/claudeEndTurn.mjs');

const fsp = fs.promises;
/** How many transcripts' scans are kept. */
const SCANS_MAX = 200;
/** How much of a transcript one read takes. */
const CHUNK = 4 * 1024 * 1024;

/**
 * Each transcript's scan: how far it was read (to the end of its last whole line) and the uuids found up to there.
 * A transcript only grows, so the next read goes on from there; a shorter file (rewritten) is read again from the start.
 * @type {Map<string, { offset: number, uuids: Set<string> }>}
 */
const scans = new Map();

/** The reporter when a caller gives none: a read failure is already answered by an empty result, so there is nothing more to do. */
function ignoreQuietly() {
  return undefined;
}

/**
 * The uuids of the lines of `file` that ended their turn on a tool result; none when the file can't be read.
 * @param {string} file
 * @returns {Promise<Set<string>>}
 */
async function endTurnLines(file, /** @type {(what: string, error: unknown) => void} */ noteIgnored = ignoreQuietly) {
  let scan = scans.get(file);
  try {
    const { size } = await fsp.stat(file);
    if (!scan || size < scan.offset) scan = { offset: 0, uuids: new Set() };
    if (size > scan.offset) scan = { offset: await scanFrom(file, scan.offset, size, scan.uuids, noteIgnored), uuids: scan.uuids };
  } catch (error) {
    noteIgnored("scan a Claude Code transcript's end-turn lines", error);
    return scan?.uuids ?? new Set();
  }
  scans.delete(file);
  if (scans.size >= SCANS_MAX) scans.delete(scans.keys().next().value);
  scans.set(file, scan);
  return scan.uuids;
}

/**
 * Reads `file` from `offset` up to `size` a chunk at a time (a transcript can hold large images), adds the uuids of the
 * flagged lines to `uuids`, and returns where its last whole line ends: a line the CLI is still writing, or one the
 * file was cut short in, is read next time from its start.
 * @param {string} file @param {number} offset @param {number} size @param {Set<string>} uuids
 */
async function scanFrom(file, offset, size, uuids, noteIgnored) {
  const flag = Buffer.from(`"${CLAUDE_END_TURN}"`);
  const handle = await fsp.open(file, 'r');
  try {
    let at = offset;
    /** the start of a line the chunk before ended inside */
    let carry = Buffer.alloc(0);
    while (at < size) {
      const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - at));
      const { bytesRead } = await handle.read(buf, 0, buf.length, at);
      if (!bytesRead) break;
      at += bytesRead;
      const data = Buffer.concat([carry, buf.subarray(0, bytesRead)]);
      const end = data.lastIndexOf(0x0a) + 1;
      for (let from = 0; from < end; ) {
        const next = data.indexOf(0x0a, from) + 1;
        const line = data.subarray(from, next);
        from = next;
        if (line.includes(flag)) noteEndTurn(line.toString('utf8'), uuids, noteIgnored);
      }
      carry = data.subarray(end);
    }
    return at - carry.length;
  } finally {
    await handle.close().catch((error) => noteIgnored("close a Claude Code transcript's end-turn scan", error));
  }
}

/** Adds the uuid of `line` when it is a tool result that ended its turn. @param {string} line @param {Set<string>} uuids */
function noteEndTurn(line, uuids, noteIgnored) {
  try {
    const d = JSON.parse(line);
    if (endsClaudeTurn(d) && typeof d.uuid === 'string') uuids.add(d.uuid);
  } catch (error) {
    noteIgnored('read a line of a Claude Code transcript that names the end-turn flag', error);
  }
}

/** The uuids of the end-turn lines among lines already parsed (the end of a transcript). @param {any[]} entries */
const endTurnUuidsOf = (entries) => new Set(entries.filter((d) => endsClaudeTurn(d) && typeof d.uuid === 'string').map((d) => d.uuid));

/**
 * The SDK's messages with the end-turn flag put back on the lines that had it, where the translator reads it
 * (shared/claudeEndTurn.mjs).
 * @param {any[]} messages
 * @param {Set<string>} uuids
 */
function withEndTurns(messages, uuids) {
  if (!uuids.size) return messages;
  return messages.map((m) => (uuids.has(m?.uuid) ? { ...m, mcpMeta: { _meta: { [CLAUDE_END_TURN]: true } } } : m));
}

module.exports = { endTurnLines, endTurnUuidsOf, withEndTurns, SCANS_MAX, CHUNK };
