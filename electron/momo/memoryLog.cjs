// The change log of MoMo's facts (#2139 P3, electron/momo/memory.cjs): one encrypted entry per change (changes.jsonl beside facts.jsonl, the newest MAX_CHANGES kept), naming who made it (the user, a MoMo chat or the background pass) and each fact's before and after, so the Memory tab can show what changed and the store can undo it; and the rules a background pass's changes must keep (never a fact the user wrote, at most a fifth of the facts changed at once, a replaced fact kept as past instead of deleted). Pure: the store reads, seals and writes the files.
const { MemoryError, isFact, isSource, sameText, factText, confidenceOf, sourceOf } = require('./memoryFacts.cjs');

const CHANGES_FILE = 'changes.jsonl';
/** The most changes kept; older ones go, and can no longer be undone. */
const MAX_CHANGES = 200;

/**
 * @typedef {import('./memoryFacts.cjs').Fact} Fact
 * @typedef {import('./memoryFacts.cjs').FactSource | 'pass'} ChangeBy the user, a MoMo chat, or the background pass
 * @typedef {{ before: Fact | null, after: Fact | null }} ChangeItem one fact as it was and as it became (null: absent)
 * @typedef {{ id: string, at: number, by: ChangeBy, op: 'save' | 'update' | 'forget' | 'pass' | 'undo', items: ChangeItem[],
 *   undone?: number, reason?: string }} Change
 */

const OPS = new Set(['save', 'update', 'forget', 'pass', 'undo']);
const maybeFact = (/** @type {unknown} */ f) => f === null || isFact(f);

/** @param {unknown} v @returns {v is Change} */
function isChange(v) {
  const c = /** @type {any} */ (v);
  return (
    !!c &&
    typeof c === 'object' &&
    typeof c.id === 'string' &&
    !!c.id &&
    Number.isFinite(c.at) &&
    (c.by === 'pass' || isSource(c.by)) &&
    OPS.has(c.op) &&
    Array.isArray(c.items) &&
    c.items.every((/** @type {any} */ i) => !!i && typeof i === 'object' && maybeFact(i.before) && maybeFact(i.after)) &&
    (c.undone === undefined || Number.isFinite(c.undone)) &&
    (c.reason === undefined || typeof c.reason === 'string')
  );
}

/** Two facts are the same state when they serialize alike (field order aside); null only matches null. */
function sameFact(/** @type {Fact | null} */ a, /** @type {Fact | null} */ b) {
  if (a === null || b === null) return a === b;
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
  return keys.every((k) => JSON.stringify(/** @type {any} */ (a)[k]) === JSON.stringify(/** @type {any} */ (b)[k]));
}

/** The items whose before and after differ: a change that changed nothing is not logged. */
const changed = (/** @type {ChangeItem[]} */ items) => items.filter((i) => !sameFact(i.before, i.after));

/** `entries` with `entry` added, the oldest dropped past MAX_CHANGES. */
const appended = (/** @type {Change[]} */ entries, /** @type {Change} */ entry) => [...entries, entry].slice(-MAX_CHANGES);

/** The most facts one background pass may add. */
const MAX_PASS_ADDS = 20;

/**
 * @typedef {{ fact: Fact } | { raw: string }} Line a fact, or a line the store could not read (kept as it was)
 * @typedef {{ op: 'add', text: unknown, confidence?: unknown } | { op: 'update', id: string, text?: unknown, confidence?: unknown }
 *   | { op: 'supersede', id: string, text: unknown, confidence?: unknown } | { op: 'noop' }} PassOp
 * @typedef {{ op: string, reason: string, id?: string }} Skipped
 */

/** Whether `f` is in use at `now`: not expired, not replaced. */
const current = (/** @type {Fact} */ f, /** @type {number} */ now) =>
  (f.expiresAt === undefined || f.expiresAt > now) && f.invalidAt === undefined;

/**
 * A background pass's changes applied to `lines` (a copy is returned): each op in order, a fact MoMo inferred from the
 * chat `source`. An op is skipped, with its reason, when it would touch a fact the user wrote or one no longer in use,
 * repeat a fact already kept, add past MAX_PASS_ADDS, or change more existing facts than a fifth of those in use (at
 * least one). A superseded fact stays, marked invalidAt and supersededBy, so what was true before is still known.
 * @param {Line[]} lines
 * @param {PassOp[]} ops
 * @param {{ source: unknown, isMomoChat: (chatId: string) => boolean, now: number, newId: () => string }} o
 * @returns {{ lines: Line[], items: ChangeItem[], skipped: Skipped[] }}
 */
function applyPass(lines, ops, { source, isMomoChat, now, newId }) {
  const from = sourceOf(source, isMomoChat);
  if (from === 'user') throw new MemoryError('A background pass reads a MoMo chat, never the user');
  const out = [...lines];
  /** @type {ChangeItem[]} */
  const items = [];
  /** @type {Skipped[]} */
  const skipped = [];
  const inUse = () => out.flatMap((l) => ('fact' in l && current(l.fact, now) ? [l.fact] : []));
  const budget = Math.max(1, Math.floor(inUse().length / 5));
  let edits = 0;
  let adds = 0;
  const kept = (/** @type {string} */ text, /** @type {string} */ except) =>
    inUse().some((f) => f.id !== except && sameText(f.text) === sameText(text));
  const make = (/** @type {string} */ text, /** @type {unknown} */ confidence) =>
    /** @type {Fact} */ ({ id: newId(), text, source: from, createdAt: now, confidence: confidenceOf(confidence), origin: 'extracted' });
  for (const op of Array.isArray(ops) ? ops : []) {
    const kind = String(/** @type {any} */ (op)?.op);
    if (kind === 'noop') continue;
    if (kind === 'add') {
      const text = factText(/** @type {any} */ (op).text);
      if (kept(text, '')) skipped.push({ op: kind, reason: 'duplicate' });
      else if (adds >= MAX_PASS_ADDS) skipped.push({ op: kind, reason: 'too many adds' });
      else {
        const fact = make(text, /** @type {any} */ (op).confidence);
        out.push({ fact });
        items.push({ before: null, after: fact });
        adds++;
      }
      continue;
    }
    if (kind !== 'update' && kind !== 'supersede') {
      skipped.push({ op: kind, reason: 'unknown op' });
      continue;
    }
    const id = String(/** @type {any} */ (op).id);
    const at = out.findIndex((l) => 'fact' in l && l.fact.id === id);
    const was = at < 0 ? null : /** @type {{ fact: Fact }} */ (out[at]).fact;
    const text = /** @type {any} */ (op).text === undefined && kind === 'update' ? undefined : factText(/** @type {any} */ (op).text);
    const reason = !was
      ? 'no such fact'
      : was.source === 'user'
        ? 'written by the user'
        : !current(was, now)
          ? 'not in use'
          : text !== undefined && kept(text, id)
            ? 'duplicate'
            : edits >= budget
              ? 'over the change limit'
              : '';
    if (reason) {
      skipped.push({ op: kind, id, reason });
      continue;
    }
    const old = /** @type {Fact} */ (was);
    edits++;
    if (kind === 'update') {
      const conf = /** @type {any} */ (op).confidence;
      /** @type {Fact} */
      const fact = { ...old, ...(text !== undefined ? { text } : {}), ...(conf !== undefined ? { confidence: confidenceOf(conf) } : {}) };
      out[at] = { fact };
      items.push({ before: old, after: fact });
      continue;
    }
    const next = make(/** @type {string} */ (text), /** @type {any} */ (op).confidence);
    const past = { ...old, invalidAt: now, supersededBy: next.id };
    out[at] = { fact: past };
    out.push({ fact: next });
    items.push({ before: old, after: past }, { before: null, after: next });
  }
  return { lines: out, items, skipped };
}

/**
 * `entry` undone on `lines` (a copy is returned): every fact it touched put back as it was before. Refused (a
 * MemoryError, code 'changed') when any of those facts changed since, so an undo never overwrites a later change; and
 * when the entry was undone already or is an undo itself.
 * @param {Line[]} lines
 * @param {Change} entry
 * @returns {{ lines: Line[], items: ChangeItem[] }}
 */
function undoChange(lines, entry) {
  if (entry.undone !== undefined) throw new MemoryError('That change was undone already', 'changed');
  if (entry.op === 'undo') throw new MemoryError('An undo cannot be undone; make the change again', 'changed');
  const out = [...lines];
  const find = (/** @type {string} */ id) => out.findIndex((l) => 'fact' in l && l.fact.id === id);
  // newest item first, so a fact touched twice in one entry goes back to its first state
  const items = [...entry.items].reverse();
  for (const item of items) {
    const id = /** @type {Fact} */ (item.after ?? item.before).id;
    const at = find(id);
    const now = at < 0 ? null : /** @type {{ fact: Fact }} */ (out[at]).fact;
    if (!sameFact(now, item.after)) throw new MemoryError('That fact changed since; undo the later change first', 'changed');
    if (item.before === null) out.splice(at, 1);
    else if (at < 0) out.push({ fact: item.before });
    else out[at] = { fact: item.before };
  }
  return { lines: out, items: items.map((i) => ({ before: i.after, after: i.before })) };
}

module.exports = { CHANGES_FILE, MAX_CHANGES, MAX_PASS_ADDS, isChange, sameFact, changed, appended, current, applyPass, undoChange };
