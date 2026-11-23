// A chat on a Host as the phone's Thread draws it (#2709, X4): the transcript records of shared/host/fold.mjs become the saved rows of the finished turns, and the items and feed events of the turn still running. The Mac gets the same rows from harness translators that need its Rust core, so the phone has its own, pure and free of Node.
import { isCompaction, isToolUpdate, mergeToolUpdate, slimToolUpdate, stepOf } from './hostToolSteps.mjs';

/** Turns kept: older ones are the Host's history, paged in on demand. */
const KEPT_TURNS = 200;

/** The phone's step kinds (mobile/src/presentation/toolRuns.ts) for the ACP tool kinds. */
const KIND = { execute: 'run', read: 'read', search: 'search', edit: 'edit', fetch: 'web' };

/** @param {any} content */
const textOf = (content) =>
  (Array.isArray(content) ? content : [])
    .filter((b) => b?.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n');

/** The words of an error a turn ended with. @param {any} error */
const errorText = (error) => String(error?.message ?? error);

/**
 * @typedef {{ kind: 'text', id: string, text: string } | { kind: 'step', call: any }} Part
 * @typedef {{ turnId: string, user: { text: string, clientId?: string } | null, parts: Part[], ended: null | { status: string, error: string | null }, note?: string }} Turn
 */

/** One chat's turns, in order. */
export function createThreadRows() {
  /** @type {Turn[]} */
  const turns = [];

  /** The turn a record belongs to, started when the agent began it unasked. @param {string} turnId @param {any[]} events */
  function turnOf(turnId, events) {
    let turn = turns.findLast((t) => t.turnId === turnId);
    if (!turn) {
      turn = { turnId, user: null, parts: [], ended: null };
      turns.push(turn);
      if (turns.length > KEPT_TURNS) turns.shift();
      events.push({ ev: 'turn.state', status: 'inProgress', turnId, started: true });
    }
    return turn;
  }

  /** The finished turns' rows. @param {Turn} turn */
  function rowsOf(turn) {
    /** @type {any[]} */
    const rows = [];
    // the divider of a switch that settled in this turn comes first, as the Mac's rows put it ("Moved from Claude Code to Codex …")
    if (turn.note) rows.push({ role: 'note', text: turn.note, id: `n-${turn.turnId}` });
    if (turn.user) {
      rows.push({
        role: 'user',
        text: turn.user.text,
        id: `u-${turn.turnId}`,
        ...(turn.user.clientId ? { clientId: turn.user.clientId } : {}),
      });
    }
    for (const part of turn.parts) {
      if (part.kind === 'text') {
        if (part.text.trim()) rows.push({ role: 'assistant', text: part.text, id: part.id });
        continue;
      }
      const step = stepOf(part.call);
      if (!step) continue;
      // a call still running when its turn ended did not finish: the Mac's translators close it as failed
      const failed = part.call.status === 'failed' || (part.call.status !== 'completed' && turn.ended !== null);
      rows.push({
        role: 'step',
        text: String(part.call.title ?? '') || 'Activity',
        kind: KIND[/** @type {keyof typeof KIND} */ (part.call.kind)] ?? 'other',
        ms: null,
        id: part.call.toolCallId,
        ...(failed ? { state: 'failed' } : {}),
      });
    }
    if (turn.ended?.error)
      rows.push({ role: 'step', text: turn.ended.error, kind: 'other', ms: null, state: 'failed', id: `e-${turn.turnId}` });
    return rows;
  }

  /** The running turn's items (the thread items the phone's live view reads). @param {Turn} turn */
  function itemsOf(turn) {
    /** @type {any[]} */
    const items = [];
    if (turn.user) items.push(userItem(turn, turn.user));
    for (const part of turn.parts) {
      if (part.kind === 'text') items.push({ id: part.id, type: 'agentMessage', text: part.text });
      else {
        const step = stepOf(part.call);
        if (step) items.push({ id: part.call.toolCallId, ...step });
      }
    }
    return items;
  }

  /** @param {Turn} turn @param {{ text: string, clientId?: string }} user */
  const userItem = (turn, user) => ({
    id: `u-${turn.turnId}`,
    type: 'userMessage',
    ...(user.clientId ? { clientId: user.clientId } : {}),
    content: [{ type: 'text', text: user.text }],
  });

  return {
    /**
     * Applies one transcript record (shared/host/fold.mjs `recordOf`).
     * @param {any} rec @returns {any[]} the feed events the phone's Thread applies, without their sequence numbers
     */
    push(rec) {
      /** @type {any[]} */
      const events = [];
      if (typeof rec?.turnId !== 'string') return events;
      if (rec.t === 'switch') {
        // shown with the turn's saved rows; the running turn's items have no row for it
        turnOf(rec.turnId, events).note = String(rec.text);
        return events;
      }
      if (rec.t === 'user') {
        const turn = turnOf(rec.turnId, events);
        turn.user = { text: textOf(rec.user?.content), ...(typeof rec.user?.clientId === 'string' ? { clientId: rec.user.clientId } : {}) };
        events.push({ ev: 'items.append', items: [userItem(turn, turn.user)] });
        return events;
      }
      if (rec.t === 'end') {
        const turn = turnOf(rec.turnId, events);
        const status = rec.stopReason === 'cancelled' ? 'interrupted' : rec.error ? 'failed' : 'completed';
        turn.ended = { status, error: rec.error ? errorText(rec.error) : null };
        // the phone reads the saved rows again once the turn is over
        events.push({ ev: 'turn.state', status, turnId: rec.turnId, live: false });
        return events;
      }
      if (rec.t !== 'update' || isCompaction(rec.update)) return events;
      const turn = turnOf(rec.turnId, events);
      const update = rec.update;
      if (
        update?.sessionUpdate === 'agent_message_chunk' &&
        typeof update.content?.text === 'string' &&
        !update._meta?.claudeCode?.parentToolUseId
      ) {
        const last = turn.parts.at(-1);
        if (last?.kind === 'text') {
          last.text += update.content.text;
          events.push({ ev: 'items.delta', itemId: last.id, field: 'text', text: update.content.text });
        } else {
          const part = { kind: /** @type {const} */ ('text'), id: `a-${turn.turnId}-${turn.parts.length}`, text: update.content.text };
          turn.parts.push(part);
          events.push({ ev: 'items.append', items: [{ id: part.id, type: 'agentMessage', text: part.text }] });
        }
      } else if (isToolUpdate(update)) {
        const held = turn.parts.find((p) => p.kind === 'step' && p.call.toolCallId === update.toolCallId);
        if (held && held.kind === 'step') held.call = mergeToolUpdate(held.call, update);
        else turn.parts.push({ kind: 'step', call: slimToolUpdate(update) });
        const call = /** @type {any} */ (held ?? turn.parts.at(-1)).call;
        const step = stepOf(call);
        if (step) events.push({ ev: 'items.replace', items: [{ id: call.toolCallId, ...step }] });
      }
      return events;
    },
    /** What `chat.follow` answers with, besides the Host's own numbers: finished turns as rows, the running one as items. */
    snapshot() {
      const last = turns.at(-1);
      const live = last && !last.ended ? last : null;
      const finished = live ? turns.slice(0, -1) : turns;
      return {
        history: finished.flatMap(rowsOf),
        items: live ? itemsOf(live) : [],
        itemsShape: 'items',
        liveTurn: live ? { id: live.turnId, status: 'inProgress' } : undefined,
        turn: live ? 'running' : 'completed',
      };
    },
    /** All the turns held, finished or not, as saved rows (what a re-read answers once a turn is over). */
    rows: () => turns.flatMap(rowsOf),
    /** Forgets everything (the Host's numbering changed). */
    reset() {
      turns.length = 0;
    },
  };
}
