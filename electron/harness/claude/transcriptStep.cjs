// Reading Claude Code transcripts (~/.claude/projects/<dir>/<session>.jsonl) to tell whether a live
// CLI process is still in step with the file: every app that writes a session appends after the
// newest message it knows (parentUuid), so the file can show that someone else wrote.
const { fs } = require('../../platform/ports/fs.cjs');
const { parseJsonRecord, isJsonRecord } = require('../../../shared/jsonRecord.mjs');

/**
 * The transcript's last messages (user and assistant, main chain), oldest first; [] without a
 * transcript. With `links`, other records that carry a uuid (system notes, attachments) come along,
 * so parentUuid chains can be followed through them.
 */
function tail(file, want = 1, links = false) {
  if (!file) return [];
  let fd;
  let found = [];
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    // read backwards a growing window until enough whole message lines turn up (lines with images run long)
    for (let len = Math.min(size, 256 * 1024), done = false; !done; len = Math.min(size, len * 4)) {
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString('utf8').split('\n');
      const out = [];
      // the first line may be cut off unless the window reaches the start of the file
      for (let i = lines.length - 1; i >= (len === size ? 0 : 1) && out.length < want; i--) {
        const parsed = parseJsonRecord(lines[i]);
        if (!parsed.ok) continue;
        const r = parsed.record;
        if ((links || r.type === 'user' || r.type === 'assistant') && r.uuid && !r.isSidechain) out.unshift(r);
      }
      found = out;
      done = out.length >= want || len === size;
    }
  } catch {
    found = [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return found;
}

/**
 * The uuid of the transcript's newest message. Each app that writes the session appends after the
 * tip it knows, so a tip that moved without this process writing means another app did.
 */
const tipOf = (file) => tail(file)[0]?.uuid ?? null;

/** Text the CLI writes as a user line itself: the interrupt marker, a goal's unmet check, a command's output. */
const CLI_TEXT = /^(\[Request interrupted|Stop hook feedback:|<local-command-std(out|err)>)/;
/**
 * A user line the CLI writes itself (tool results, meta lines, a compaction's summary, the texts above), not a prompt
 * someone typed.
 */
function cliUserLine(r) {
  if (r.isMeta === true || r.isCompactSummary === true) return true;
  const c = r.message?.content;
  if (!Array.isArray(c)) return typeof c === 'string' && CLI_TEXT.test(c);
  return (
    c.length > 0 &&
    c.every(
      (b) => isJsonRecord(b) && (b.type === 'tool_result' || (b.type === 'text' && typeof b.text === 'string' && CLI_TEXT.test(b.text))),
    )
  );
}

/**
 * The tip a CLI process can claim after a turn, given the assistant messages it streamed and the
 * prompts it sent (`seen`). Walking back from the newest message, everything up to one of those
 * must be its own doing; a prompt or answer it never saw means another app wrote while it ran, and
 * the process is already behind (false). Null without messages.
 */
function ownTipOf(file, seen) {
  const rows = tail(file, 400, true);
  const msgs = rows.filter((r) => r.type === 'user' || r.type === 'assistant');
  if (!msgs.length) return null;
  const byId = new Map(rows.map((r) => [r.uuid, r]));
  // Valid JSON can still carry a cyclic parent chain; this synchronous reader must always finish.
  const walked = new Set();
  // a compaction's boundary starts a new chain; the conversation it compacted goes on from its logical parent
  const before = (r) => byId.get(r.parentUuid) ?? (r.subtype === 'compact_boundary' ? byId.get(r.logicalParentUuid) : undefined);
  for (let r = msgs[msgs.length - 1]; r; r = before(r)) {
    if (walked.has(r.uuid)) return false;
    walked.add(r.uuid);
    if (seen.has(r.uuid)) return msgs[msgs.length - 1].uuid;
    if (r.type === 'assistant' || (r.type === 'user' && !cliUserLine(r))) return false;
  }
  return false;
}

module.exports = { tail, tipOf, ownTipOf, cliUserLine };
