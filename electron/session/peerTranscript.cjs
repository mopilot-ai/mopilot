// Peer transcripts: a chat's turns across its segments, paged by cursor for the read tool and trimmed to the recent end for references.

const crypto = require('node:crypto');
const { toRendererSegment } = require('../platform/chats.cjs');
const { sliceSegments } = require('../../shared/handoff.mjs');
const { prefixUnits, suffixUnits } = require('../../shared/textPrefix.mjs');
const { assistantReplies } = require('../../shared/assistantReplies.mjs');
const { PanelHistoryMedia } = require('./panelHistoryMedia.cjs');
const { peerCallImage } = require('./callImage.cjs');
const { peerUserImage } = require('./userImage.cjs');
const { createHistoryImageCache } = require('./historyImageCache.cjs');
const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};

/** The shortest string read as an image's bytes rather than text: a small icon stays as it is. */
const MEDIA_MIN = 4096;
const DATA_URL = /^data:([\w.+-]+\/[\w.+-]+)(?:;[\w=.+-]+)*;base64,([\s\S]*)$/;
const BASE64 = /^[A-Za-z0-9+/\r\n]+={0,2}$/;

/**
 * A turn with the bytes of its images left out: a screenshot the user sent (a data: URL, wherever it is), a tool's image
 * result (bare base64 in a `data` field: an MCP image, an API source), as each harness keeps them. A reader budgets
 * turns by their size, so one image would turn the whole turn into a JSON excerpt of base64; what the image was stays
 * (its type and size). Text is never taken for an image: bare base64 counts only in a `data` field.
 * @param {unknown} v
 * @param {string} [key] the field `v` is in
 * @returns {any}
 */
function withoutInlineMedia(v, key = '') {
  if (typeof v === 'string') {
    if (v.length < MEDIA_MIN) return v;
    const url = DATA_URL.exec(v);
    if (url) return `[${url[1]}, ${Math.round(url[2].length / 1024)} KB, not included]`;
    return key === 'data' && BASE64.test(v) ? `[${Math.round(v.length / 1024)} KB, not included]` : v;
  }
  if (Array.isArray(v)) return v.map((x) => withoutInlineMedia(x));
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withoutInlineMedia(x, k)]));
  return v;
}

/** Read complete bounded native histories before applying shared segment offsets.
 * readTurns belongs to the current native adapter and must report truncated history explicitly.
 * @param record the chat's record
 * @param {{ cursor?: string | null, limitBytes?: number, signal?: AbortSignal } | undefined} opts
 * @param readTurns (segment, signal, { assistantOnly }) => Promise<{ turns, truncated }>
 */
async function readPeerTranscript(record, { cursor = null, limitBytes = 32768, signal } = {}, readTurns) {
  const { segments, turns, omitted } = await collectPeerTranscript(record, readTurns, signal);
  const version = crypto
    .createHash('sha256')
    .update(JSON.stringify([segments, turns]))
    .digest('hex')
    .slice(0, 24);
  let offset = 0;
  if (cursor !== null) {
    let parsed;
    try {
      parsed = JSON.parse(cursor);
    } catch {
      fail('invalid_cursor');
    }
    if (!parsed || !Number.isSafeInteger(parsed.offset) || parsed.offset < 0 || parsed.offset > turns.length) fail('invalid_cursor');
    if (parsed.version !== version) fail('transcript_changed');
    offset = parsed.offset;
  }
  const budget = Math.min(32768, Math.max(256, Number.isFinite(limitBytes) ? limitBytes : 32768));
  const records = [];
  let bytes = 2;
  let clipped = false;
  for (const turn of turns.slice(offset)) {
    let item = { turn };
    const size = Buffer.byteLength(JSON.stringify(item)) + 1;
    if (bytes + size > budget) {
      if (records.length) break;
      const raw = JSON.stringify(turn);
      item = { turn: { id: turn.id ?? null, excerpt: '', truncated: true } };
      // Reserve array delimiters and record metadata before budgeting escaped excerpt text.
      if (Buffer.byteLength(JSON.stringify(item)) + 3 > budget) {
        item.turn.id = null;
        item.turn.idOmitted = true;
      }
      const available = budget - 3 - Buffer.byteLength(JSON.stringify(item));
      item.turn.excerpt = prefixUnits(raw, Math.floor(available / 6));
      clipped = true;
    }
    records.push(item);
    bytes += Buffer.byteLength(JSON.stringify(item)) + 1;
  }
  const next = offset + records.length;
  return {
    records,
    nextCursor: next < turns.length ? JSON.stringify({ version, offset: next }) : null,
    truncated: omitted || clipped || next < turns.length,
    earlierContentOmitted: omitted,
    limitBytes: budget,
  };
}

async function collectPeerTranscript(record, readTurns, signal, scoped = false, assistantOnly = false, open = false) {
  if (!record) fail('chat_unavailable');
  const segments = record.segments.map(toRendererSegment);
  const history = new Map();
  let omitted = false;
  const media = scoped ? new PanelHistoryMedia() : null;
  for (let i = 0; i < segments.length; i++) {
    if (signal?.aborted) fail('aborted');
    const seg = segments[i];
    if (history.has(seg.nativeId)) continue;
    // only the chat's last segment can be the turn main runs now
    const page = await readTurns(record.segments[i], signal, {
      assistantOnly,
      ...(open && i === segments.length - 1 ? { open: true } : {}),
    });
    if (signal?.aborted) fail('aborted');
    if (!Array.isArray(page?.turns)) fail('invalid_transcript');
    for (const turn of page.turns) {
      if (!turn || typeof turn !== 'object' || Array.isArray(turn)) fail('invalid_transcript');
      media?.keep(seg.nativeId, turn);
    }
    if (page.truncated) omitted = true;
    history.set(
      seg.nativeId,
      page.turns.map((turn) => ({ ...withoutInlineMedia(turn), ...(scoped ? { sourceSession: seg.nativeId } : {}) })),
    );
  }
  if (omitted && segments.length > 1) fail('switched_history_too_large');
  const turns = sliceSegments(segments, history).flat();
  media?.apply(turns);
  return { segments, turns, omitted };
}

/** Reference attachments retain the recent end, with the same segment and omission rules. */
async function readPeerReference(record, readTurns, assistantOnly = false) {
  const history = await collectPeerTranscript(record, readTurns, undefined, false, assistantOnly);
  // Status inference needs actual completed replies, never a JSON excerpt of a tool-heavy turn.
  if (assistantOnly)
    return {
      turns: assistantReplies(history.turns),
      earlierContentOmitted: history.omitted,
    };
  const turns = [];
  const budget = 32768;
  let bytes = 2;
  let clipped = false;
  for (const turn of [...history.turns].reverse()) {
    const size = Buffer.byteLength(JSON.stringify(turn)) + 1;
    if (bytes + size > budget) {
      clipped = true;
      if (!turns.length) {
        const text = '[Native turn excerpt; earlier content omitted]\n' + suffixUnits(JSON.stringify(turn), Math.floor((budget - 500) / 6));
        turns.push({
          id: prefixUnits(String(turn.id ?? ''), 256),
          status: turn.status,
          items: [{ id: 'reference-excerpt', type: 'agentMessage', text, phase: 'commentary' }],
          itemTimes: {},
        });
      }
      break;
    }
    turns.unshift(turn);
    bytes += size;
  }
  return { turns, earlierContentOmitted: history.omitted || turns.length !== history.turns.length || clipped };
}

/**
 * A chat's whole history as turns, for a reader that keeps only a short form of each item itself (Chrome's side panel,
 * electron/capabilities/browser/chromePanelLive.cjs rowsOf): no byte budget, so a tool-heavy turn never hides the turns
 * before it. The same segment and omission rules as a reference. `open`: main runs the chat's turn now, so a harness whose
 * saved history cannot say so (Claude Code's transcript) leaves that last turn, and the calls it has no result for, running.
 */
async function readPeerTurns(record, readTurns, { open = false } = {}) {
  const history = await collectPeerTranscript(record, readTurns, undefined, true, false, open);
  return { turns: history.turns, earlierContentOmitted: history.omitted };
}

/**
 * The recent end of a chat's history as turns, for a reader that wants only its last rows (a phone opening a chat; Chrome's side
 * panel clips to its own recent end too): `enough(turns)` says whether the turns in hand hold them, and the native reader goes no
 * further back than that, so the cost does not grow with the chat. `earlierContentOmitted` says earlier turns were left unread. A chat
 * with more than one segment (it switched harness) keeps the slicing between its segments, which needs each whole: it is read whole.
 * @param {any} record
 * @param {any} nativeReader the native reader, with its `recent` read
 * @param {{ open?: boolean, enough?: (turns: any[]) => boolean }} [o]
 */
async function readPeerRecentTurns(record, nativeReader, { open = false, enough } = {}) {
  if (!record || record.segments.length !== 1 || typeof nativeReader.recent !== 'function' || typeof enough !== 'function')
    return readPeerTurns(record, nativeReader, { open });
  const history = await collectPeerTranscript(
    record,
    (seg, signal, o) => nativeReader.recent(seg, signal, { open: o.open, enough }),
    undefined,
    true,
    false,
    open,
  );
  return { turns: history.turns, earlierContentOmitted: history.omitted };
}

/**
 * What a chat's saved history is now, for a reader that keeps what it made from it: every segment's own stamp with the segment it names, so
 * a switch of harness changes it too. Null when the chat has no record or a segment's family cannot say (nothing made from it is kept).
 * @param {any} record @param {any} nativeReader
 * @returns {Promise<string | null>}
 */
async function peerStamp(record, nativeReader) {
  if (!record || typeof nativeReader.stamp !== 'function') return null;
  const parts = await Promise.all(record.segments.map((/** @type {any} */ seg) => nativeReader.stamp(seg)));
  return parts.length && parts.every(Boolean)
    ? JSON.stringify(record.segments.map((/** @type {any} */ seg, /** @type {number} */ i) => [seg.kind, seg.nativeId, parts[i]]))
    : null;
}

/**
 * readPeerTurns by chat id: the chat's record (ChatsStore) and a native reader, both looked up at each read (as main wires the peer runtime).
 * `callImage(chatId, callId)`: one screenshot or zoom call's own picture, which the turns leave out (./callImage.cjs); `userImage(chatId, itemId, index)`:
 * one picture the user attached to a message (./userImage.cjs).
 */
const peerHistoryReader = (chats, nativeReader, pictures = createHistoryImageCache()) =>
  Object.assign((chatId, options) => readPeerTurns(chats.records.get(chatId), nativeReader(), options), {
    callImage: peerCallImage(chats, nativeReader, pictures),
    userImage: peerUserImage(chats, nativeReader, pictures),
    recent: (chatId, options) => readPeerRecentTurns(chats.records.get(chatId), nativeReader(), options),
    stamp: (chatId) => peerStamp(chats.records.get(chatId), nativeReader()),
  });

module.exports = {
  readPeerTranscript,
  readPeerReference,
  readPeerTurns,
  readPeerRecentTurns,
  peerHistoryReader,
  collectPeerTranscript,
  withoutInlineMedia,
};
