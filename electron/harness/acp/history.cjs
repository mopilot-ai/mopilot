// Listing and searching basic-tier chats from the transcripts MoPilot keeps for them (threads/<id>.items.jsonl).
const { clock } = require('../../platform/ports/clock.cjs');
const { contentBlocks } = require('../../../shared/contentBlocks.mjs');
const { noteIgnored } = require('../../ignored.cjs');
const { SEARCH_FILES, SEARCH_MS } = require('../../platform/searchScans.cjs');
const { sideChatUuid } = require('../../../shared/host/sideChats.mjs');

/** The records a list entry reads (chatOf); the streamed updates, nearly every line of a long transcript, are not parsed for it. */
const LIST_RECORDS = ['session', 'user', 'title'];

/**
 * A chat's list entry from its transcript records: id, harness, cwd, first prompt, times; null without a session.
 * @param {string} id
 * @param {number} mtime
 * @param {any[]} recs
 * @param {{ harness: string }} k
 */
function chatOf(id, mtime, recs, k) {
  const first = recs.find((r) => r.t === 'session');
  if (!first) return null;
  const user = recs.find((r) => r.t === 'user');
  const preview = contentBlocks(user?.user?.content)
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join(' ');
  const name = recs.filter((r) => r.t === 'title').pop()?.name ?? null;
  // the agent's own id for the chat's latest session (its CLI resumes by it; a load or a new session adds one)
  const sessionId = recs.findLast((r) => r.t === 'session').sessionId ?? null;
  return { id, harness: k.harness, cwd: first.cwd, preview, name, sessionId, createdAt: first.at ?? mtime, updatedAt: mtime };
}

/**
 * Chats with a transcript: id, harness, cwd, first prompt, times. Each transcript is read without blocking the
 * main process, one at a time.
 * @param items ItemsLog (electron/platform/chats.cjs)
 * @param {(key: string) => { harness: string, id: string } | null} parseKey
 */
async function listChats(items, parseKey) {
  const out = [];
  for (const { id, mtime } of await items.listAsync()) {
    const k = parseKey(id);
    if (!k || sideChatUuid(id)) continue;
    const c = chatOf(id, mtime, await items.readKindsAsync(id, LIST_RECORDS), k);
    if (c) out.push(c);
  }
  return out;
}

/**
 * Chats whose title or transcript holds `term`, newest first (listChats entries). Like Claude Code's search, it reads
 * at most SEARCH_FILES transcripts and starts none after SEARCH_MS, each without blocking the main process, and a
 * search `replaced()` by its box's next one stops and finds nothing.
 * @param items ItemsLog
 * @param {(key: string) => { harness: string, id: string } | null} parseKey
 * @param {() => boolean} [replaced]
 */
async function searchChats(items, parseKey, term, limit = 30, replaced = () => false) {
  const q = String(term ?? '')
    .trim()
    .toLowerCase();
  if (!q) return [];
  const needle = JSON.stringify(q).slice(1, -1);
  const out = [];
  const deadline = clock.now() + SEARCH_MS;
  let scanned = 0;
  for (const { id, mtime } of await items.listAsync()) {
    if (out.length >= limit || scanned >= SEARCH_FILES || clock.now() >= deadline) break;
    const k = parseKey(id);
    if (!k || sideChatUuid(id)) continue;
    if (replaced()) return [];
    scanned++;
    let read;
    try {
      // with the records not written yet
      read = await items.scan(id, { kinds: LIST_RECORDS, needle });
    } catch (error) {
      // gone since it was listed, or unreadable: nothing to match
      noteIgnored('read an ACP transcript to search it', error, ['ENOENT']);
      continue;
    }
    const c = chatOf(id, mtime, read.records, k);
    if (c && (`${c.name ?? ''}\n${c.preview}`.toLowerCase().includes(q) || read.found)) out.push(c);
  }
  return out;
}

module.exports = { listChats, searchChats };
