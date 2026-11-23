// Codex's read-state wire contract projected onto the current stable MoPilot chat's durable unread metadata.
const { isJsonRecord } = require('../../shared/jsonRecord.mjs');
const { noteIgnored } = require('../ignored.cjs');

/**
 * The server's first unread position, not a guessed boolean field. Revisions are opaque UUID/initial
 * tokens used for equality by thread/readState/update, never sortable counters. This inbound path
 * follows live notification order; it neither acknowledges a revision nor replays history snapshots.
 */
function readStateUnread(p) {
  if (!isJsonRecord(p) || typeof p.threadId !== 'string' || !isJsonRecord(p.readState) || typeof p.readState.revision !== 'string')
    return null;
  const position = p.readState.firstUnread;
  if (position === null) return false;
  if (!isJsonRecord(position)) return null;
  if (position.type === 'threadStart') return true;
  return position.type === 'turn' && typeof position.turnId === 'string' ? true : null;
}

/**
 * @param {{ chatOf: (key: string) => string, isCurrentSource: (chatId: string, source: { kind: string, key: string }) => boolean,
 *   chats: { records: Map<string, unknown>, patchMeta: (chatId: string, meta: { unread: boolean }) => void },
 *   codex: { running?: Set<string> | Map<string, unknown> },
 *   state: { running: (chatId: string) => boolean, snapshot: (chatId: string) => { runningElsewhere?: boolean } } }} c
 *   the chat controller (session/controller.cjs ChatController)
 */
function followCodexReadState(c, p) {
  const unread = readStateUnread(p);
  if (unread === null) return;
  const chatId = c.chatOf(p.threadId);
  if (!c.chats.records.has(chatId) || !c.isCurrentSource(chatId, { kind: 'codex', key: p.threadId })) return;
  // A focused window does not prove its newest streamed output was seen. Never replay this clear
  // on turn completion: output arriving after it may itself need the user's attention.
  if (!unread && (c.codex.running?.has(p.threadId) || c.state.running(chatId) || c.state.snapshot(chatId).runningElsewhere)) return;
  try {
    c.chats.patchMeta(chatId, { unread });
  } catch (error) {
    noteIgnored('save the Codex thread read state', error);
  }
}

module.exports = { readStateUnread, followCodexReadState };
