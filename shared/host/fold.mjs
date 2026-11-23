// The fold of a Host's stream into a chat's records (#2709, X4), one code for the Mac and the phone: which stream items are events a chat shows, which events leave a transcript record, which cards a batch of records has already closed, and the finished items a handoff is made from. Moved from electron/host/remoteChats.cjs and remoteSummary.cjs without a change of behaviour.
import { createStartPairs } from './turnStartPairs.mjs';
import { shownInterruption, toldEnd } from './interrupted.mjs';
import { scopeHostPictures } from './images.mjs';
import { isCompaction, isToolUpdate, mergeToolUpdate, slimToolUpdate } from './hostToolSteps.mjs';

/** Events that leave a record in a chat's transcript; the others (a permission card, a quit harness) are only shown. */
export const RECORDED = new Set(['turnStart', 'update', 'turnEnd']);

const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The families of agent whose events this app shows: all send the ACP-shaped turn events (a Codex or Claude Code turn start names no user message: see turnStartPairs.cjs). Any other is refused, once. */
export const FAMILIES = new Set(['acp', 'codex', 'claude']);

/** Whether an event has what its record and the windows read from it: a chat's transcript with a record missing these cannot be replayed. @param {any} e */
export const wellFormed = (e) =>
  typeof e.kind === 'string' &&
  (e.kind !== 'update' || isObject(e.update)) &&
  (e.kind !== 'turnStart' || (typeof e.turnId === 'string' && (e.user === undefined || isObject(e.user)))) &&
  ((e.kind !== 'permission' && e.kind !== 'permissionCancelled') || typeof e.requestId === 'string');

/** The ACP event a stream item carries, or null for any other item (the Host's summary items, another family's, a malformed one). @param {any} item */
export const eventOf = (item) =>
  item?.t === 'event' && FAMILIES.has(item.family) && isObject(item.event) && wellFormed(item.event) ? item.event : null;

/** The family of a stream event item this app has no sink for (null for an item of the ACP sink, or one that is no event). @param {any} item */
export const otherFamily = (item) =>
  item?.t === 'event' && isObject(item.event) && typeof item.family === 'string' && !FAMILIES.has(item.family) ? item.family : null;

/**
 * The revisions of permission cards that a batch of records closes itself (answered, or their turn ended): replayed after a restart they must not be drawn again.
 * @param {{ rev: number, item: any }[]} entries oldest first
 */
export function closedCards(entries) {
  const answered = new Set();
  const ended = new Set();
  const skip = new Set();
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = eventOf(entries[i].item);
    if (e?.kind === 'permissionCancelled') answered.add(e.requestId);
    else if (e?.kind === 'turnEnd') ended.add(e.turnId);
    else if (e?.kind === 'permission' && (answered.has(e.requestId) || ended.has(e.turnId))) skip.add(entries[i].rev);
    else if (e?.kind === 'question' && (answered.has(e.question?.id) || ended.has(e.turnId))) skip.add(entries[i].rev);
  }
  return skip;
}

/** The record a settled switch's journal item leaves: the divider's words, bounded, and the turn it belongs to. @param {any} item @param {number} at */
export const switchRecord = (item, at) => ({
  t: 'switch',
  turnId: item.turnId,
  text: String(item.text).slice(0, 300),
  at,
  ...(typeof item.to === 'string' && item.to ? { to: item.to.slice(0, 200) } : {}),
});

/** The transcript record an event of a recorded kind leaves (RECORDED). @param {any} ev @param {number} at */
export function recordOf(ev, at) {
  if (ev.kind === 'turnStart') return { t: 'user', turnId: ev.turnId, user: ev.user, at };
  if (ev.kind === 'update') return { t: 'update', turnId: ev.turnId, update: ev.update, at };
  // the usage the agent counted is the Host's ledger's; the rest says how the turn ended
  const { kind: _kind, key: _key, usage: _usage, cwd: _cwd, ...ended } = ev;
  return { t: 'end', ...ended, at };
}

/** The text of a message's content blocks. @param {any} content */
const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');

/**
 * Folds one transcript record into the finished items of the chat as the Host keeps them (`{ t: 'user' | 'assistant', turnId, text, ... }`): what a handoff to another machine is made from; a tool call is an event item of its own, as the Host's log has it.
 * @param {any[]} summary @param {any} rec
 */
export function foldSummary(summary, rec) {
  const reply = (/** @type {string} */ turnId) => {
    let item = summary.findLast((x) => x.t === 'assistant' && x.turnId === turnId);
    if (!item) summary.push((item = { t: 'assistant', turnId, text: '', stopReason: null, error: null }));
    return item;
  };
  if (rec.t === 'user') {
    // pictures are not carried: the record says how many came with the message
    const images = (Array.isArray(rec.user?.content) ? rec.user.content : []).filter((/** @type {any} */ b) => b?.type === 'image');
    summary.push({
      t: 'user',
      turnId: rec.turnId,
      text: textOf(rec.user?.content),
      ...(images.length ? { attachments: images.map(() => ({ type: 'image' })) } : {}),
    });
  } else if (rec.t === 'update' && isCompaction(rec.update))
    summary.push({ t: 'event', family: 'acp', event: { kind: 'update', turnId: rec.turnId, update: { sessionUpdate: 'compaction' } } });
  else if (
    rec.t === 'update' &&
    rec.update?.sessionUpdate === 'agent_message_chunk' &&
    typeof rec.update.content?.text === 'string' &&
    !rec.update._meta?.claudeCode?.parentToolUseId
  )
    reply(rec.turnId).text += rec.update.content.text;
  else if (rec.t === 'update' && isToolUpdate(rec.update)) {
    // a tool call is one step: its updates merge into the item the call has already (a line per call, not a transcript)
    const id = rec.update.toolCallId;
    const held = summary.findLast((x) => x.t === 'event' && x.event.turnId === rec.turnId && x.event.update.toolCallId === id);
    if (held) held.event.update = mergeToolUpdate(held.event.update, rec.update);
    else summary.push({ t: 'event', family: 'acp', event: { kind: 'update', turnId: rec.turnId, update: slimToolUpdate(rec.update) } });
  } else if (rec.t === 'end') {
    const item = reply(rec.turnId);
    item.stopReason = rec.stopReason ?? null;
    item.error = rec.error ? String(rec.error.message ?? rec.error) : null;
  }
}

/**
 * A chat's stream as a client folds it, one item at a time: the events the chat shows, the transcript records they leave, and the finished
 * items so far. The Mac keeps its own interleaving (live text, cards, the ACP bus) around the same pieces; the phone has no other.
 * @param {{ hostId: string, now?: () => number }} o `hostId`: the key a picture's id is made the chat's own by
 */
export function createFold({ hostId, now = Date.now }) {
  const pairs = createStartPairs();
  /** @type {any[]} */
  const summary = [];
  return {
    summary,
    /**
     * @param {any} item one stream item of the Host
     * @returns {{ events: any[], records: any[], refused: string | null }} `refused`: a family this client has no sink for
     */
    push(item) {
      // a chat's settled switch (#4809) is a typed item of its journal: its divider's words are a record, no event
      if (item?.t === 'switch')
        return {
          events: [],
          records: typeof item.turnId === 'string' && typeof item.text === 'string' && item.text ? [switchRecord(item, now())] : [],
          refused: null,
        };
      const refused = otherFamily(item);
      if (refused) return { events: [], records: [], refused };
      /** @type {any[]} */
      const events = [];
      /** @type {any[]} */
      const records = [];
      // a turn start that names no user message waits for the Host's item that says what was asked (turnStartPairs.mjs)
      for (const ev of pairs.take(item.user ? { ...item, user: scopeHostPictures(item.user, hostId) } : item, eventOf(item))) {
        // the Host's own paths mean nothing here
        const { cwd: _cwd, ...told } = ev;
        const raw = toldEnd(shownInterruption(told));
        const event = raw.user ? { ...raw, user: scopeHostPictures(raw.user, hostId) } : raw;
        const record = RECORDED.has(event.kind) ? recordOf(event, now()) : null;
        if (record) {
          records.push(record);
          foldSummary(summary, record);
        }
        events.push(event);
      }
      return { events, records, refused: null };
    },
  };
}
