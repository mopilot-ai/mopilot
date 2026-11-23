// How a note changes: the model proposes add, update and retire ops, and code checks each one (its quote is in the cited source or in the owner's words after folding, nothing secret-looking, no order planted by outside text, Confirmed lines kept), applies the valid ones, lists the rejected ones with a reason, and writes one undo entry and one journal entry (after n8n-io/nod memory-ops.ts and trust-basis.ts, Apache-2.0, see NOTICE; unlike nod one rejected op does not fail the rest).
import { MIN_QUOTE, clip, foldQuote, isRealDate, looksLikeInstruction, looksSecret, sameText, textMatchesQuote } from './text.ts';
import {
  LIMITS,
  type ArchivedLine,
  type Line,
  type Note,
  type NoteKind,
  type NotesTree,
  type Origin,
  type RetireReason,
  archiveLine,
  cloneTree,
  findLine,
  findNote,
  isConfirmed,
  lineCount,
  mergeSources,
  type SourceKind,
} from './notes.ts';

export type Trigger = 'chat' | 'change' | 'nightly';
export type RejectReason = 'invalid' | 'source' | 'quote' | 'secret' | 'instruction' | 'missing' | 'protected' | 'full';

/** A piece of text an op may cite: an owner chat message, a mail or a calendar event. */
export interface SourceText {
  id: string;
  kind: SourceKind;
  at: string;
  /** The mail thread or calendar series. A mail may only update or retire lines that came from the same thread. */
  threadId?: string;
  text: string;
  /** Written by the owner (a chat message of theirs). Mail, events and web text are never owner words. */
  owner: boolean;
}

export type Op =
  | { type: 'add'; noteId?: string; title?: string; kind?: NoteKind; text: string; sourceId: string; quote: string; expires?: string }
  | { type: 'update'; noteId: string; lineId: string; text: string; sourceId: string; quote: string }
  | {
      type: 'retire';
      noteId: string;
      lineId: string;
      reason: Extract<RetireReason, 'obsolete' | 'contradicted' | 'replaced'>;
      sourceId: string;
      quote: string;
    };

export interface OpsContext {
  sources: readonly SourceText[];
  /** The chat holds outside content (see turnTaint.ts): nothing it proposes becomes Confirmed and no Confirmed line changes. */
  tainted: boolean;
  trigger: Trigger;
  /** True for a pass the owner did not start in chat (the idle pass, the nightly one): its lines are `inferred`, and it never changes a Confirmed line. */
  background?: boolean;
  now: string;
  newId: () => string;
}

export interface Rejected {
  index: number;
  reason: RejectReason;
  type?: string;
}

export interface AppliedOp {
  type: 'add' | 'update' | 'retire' | 'merge';
  noteId: string;
  lineId: string;
  earlierText?: string;
}

export type UndoChange =
  | { kind: 'added'; noteId: string; createdNote: boolean; after: Line; noteUpdated: string }
  | { kind: 'edited'; noteId: string; before: Line; after: Line; noteUpdated: string }
  | { kind: 'retired'; noteId: string; lineId: string; archivedAt: string; index: number; noteUpdated: string };

export interface UndoEntry {
  id: string;
  at: string;
  trigger: Trigger | 'tidy';
  changes: UndoChange[];
}

export interface JournalEntry {
  id: string;
  at: string;
  trigger: Trigger;
  ops: AppliedOp[];
  /** Plain sentences for the History view. */
  summary: string[];
  snapshotId?: string;
  rejected: Rejected[];
}

/** An owner's order that is not a note: the home lane hands it to `suggestRule` (learning.ts). */
export interface RuleSuggestion {
  index: number;
  sourceId: string;
  quote: string;
  text: string;
}

export interface OpsResult {
  /** Orders the owner gave, kept out of the notes and waiting for a tap as rules. */
  suggestions: RuleSuggestion[];
  tree: NotesTree;
  applied: AppliedOp[];
  rejected: Rejected[];
  undo: UndoEntry | null;
  journal: JournalEntry | null;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const KINDS: readonly string[] = ['person', 'company', 'project', 'topic', 'about'];
const RETIRE: readonly string[] = ['obsolete', 'contradicted', 'replaced'];

/** Reads one raw proposal from the model; anything off-shape is undefined. */
export function parseOp(raw: unknown): Op | undefined {
  if (!isObj(raw)) return undefined;
  const sourceId = str(raw.sourceId);
  const quote = str(raw.quote);
  if (!sourceId || quote === undefined) return undefined;
  if (raw.type === 'add') {
    const text = str(raw.text);
    if (!text) return undefined;
    const noteId = str(raw.noteId);
    const title = str(raw.title);
    const kind = str(raw.kind);
    if (!noteId && !(title && kind && KINDS.includes(kind))) return undefined;
    const expires = str(raw.expires);
    if (expires !== undefined && !isRealDate(expires)) return undefined;
    return {
      type: 'add',
      ...(noteId ? { noteId } : {}),
      ...(title ? { title } : {}),
      ...(kind ? { kind: kind as NoteKind } : {}),
      text,
      sourceId,
      quote,
      ...(expires ? { expires } : {}),
    };
  }
  const noteId = str(raw.noteId);
  const lineId = str(raw.lineId);
  if (!noteId || !lineId) return undefined;
  if (raw.type === 'update') {
    const text = str(raw.text);
    return text ? { type: 'update', noteId, lineId, text, sourceId, quote } : undefined;
  }
  if (raw.type === 'retire') {
    const reason = str(raw.reason);
    return reason && RETIRE.includes(reason)
      ? { type: 'retire', noteId, lineId, reason: reason as Extract<Op, { type: 'retire' }>['reason'], sourceId, quote }
      : undefined;
  }
  return undefined;
}

export function applyOps(base: NotesTree, rawOps: readonly unknown[], ctx: OpsContext): OpsResult {
  const tree = cloneTree(base);
  const applied: AppliedOp[] = [];
  const rejected: Rejected[] = [];
  const suggestions: RuleSuggestion[] = [];
  const changes: UndoChange[] = [];
  const summary: string[] = [];
  const sources = new Map(ctx.sources.map((s) => [s.id, s]));

  rawOps.forEach((raw, index) => {
    const op = parseOp(raw);
    const reject = (reason: RejectReason) => void rejected.push({ index, reason, ...(op ? { type: op.type } : {}) });
    if (!op) return reject('invalid');
    const source = sources.get(op.sourceId);
    if (!source) return reject('source');
    const folded = foldQuote(op.quote);
    if (folded.length < MIN_QUOTE || op.quote.length > LIMITS.quote) return reject('quote');
    const sourceFolded = foldQuote(source.text);
    // The quote must come from the cited source itself; only an owner's own message is owner evidence.
    if (!sourceFolded.includes(folded)) return reject('quote');
    const ownerEvidence = source.owner;
    const text = op.type === 'retire' ? '' : op.text.trim();
    if (op.type !== 'retire' && (!text || text.length > LIMITS.text)) return reject('invalid');
    if (op.type !== 'retire' && !textMatchesQuote(text, op.quote)) return reject('quote');
    if (looksSecret(text, op.quote)) return reject('secret');
    if (looksLikeInstruction(text, op.quote)) {
      // Notes hold facts, rules hold orders. An owner's order becomes a suggested rule that waits for a tap; from mail or the web it is never kept.
      if (!ownerEvidence) return reject('instruction');
      if (op.type !== 'retire') {
        suggestions.push({ index, sourceId: source.id, quote: op.quote, text });
        summary.push(`Kept as a rule suggestion, not a note: "${clip(text)}".`);
        return;
      }
    }
    // A tainted chat never makes Confirmed lines, even from the owner's words.
    const origin: Origin = !ownerEvidence ? 'mail' : ctx.background || ctx.tainted || ctx.trigger !== 'chat' ? 'inferred' : 'stated';
    const ref = { sourceId: source.id, kind: source.kind, at: source.at, ...(source.threadId ? { threadId: source.threadId } : {}) };
    // Confirmed lines change only when the owner says so in a clean chat; every automatic pass leaves them alone.
    const mayTouchConfirmed = ownerEvidence && ctx.trigger === 'chat' && !ctx.background && !ctx.tainted;
    // Outside text may only change lines that came from the same message or thread.
    const sameThread = (line: Line) =>
      ownerEvidence ||
      (line.origin === 'mail' &&
        line.sources.some((s) => s.sourceId === ref.sourceId || (ref.threadId !== undefined && s.threadId === ref.threadId)));

    if (op.type === 'retire') {
      const line = findLine(tree, op.noteId, op.lineId);
      if (!line) return reject('missing');
      if ((isConfirmed(line) && !mayTouchConfirmed) || !sameThread(line)) return reject('protected');
      const note = findNote(tree, op.noteId) as Note;
      const index = note.lines.indexOf(line);
      const noteUpdated = note.updated;
      archiveLine(tree, op.noteId, op.lineId, op.reason, ctx.now);
      const at = ctx.now;
      changes.push({ kind: 'retired', noteId: op.noteId, lineId: op.lineId, archivedAt: at, index, noteUpdated });
      applied.push({ type: 'retire', noteId: op.noteId, lineId: op.lineId, earlierText: line.text });
      summary.push(`Let go of a line in "${clip(note.title, 40)}": "${clip(line.text)}".`);
      return;
    }

    if (op.type === 'update') {
      const line = findLine(tree, op.noteId, op.lineId);
      if (!line) return reject('missing');
      if ((isConfirmed(line) && !mayTouchConfirmed) || !sameThread(line)) return reject('protected');
      const before = structuredClone(line);
      const noteUpdated = (findNote(tree, op.noteId) as Note).updated;
      const sameWords = sameText(line.text, text);
      line.text = text;
      line.quote = op.quote;
      line.sources = sameWords ? mergeSources(line.sources, [ref]) : [ref];
      line.updated = ctx.now;
      line.origin = origin;
      if (origin === 'stated') line.edited = true;
      (findNote(tree, op.noteId) as Note).updated = ctx.now;
      changes.push({ kind: 'edited', noteId: op.noteId, before, after: structuredClone(line), noteUpdated });
      applied.push({ type: 'update', noteId: op.noteId, lineId: op.lineId, earlierText: before.text });
      summary.push(
        `Changed a line in "${clip((findNote(tree, op.noteId) as Note).title, 40)}": was "${clip(before.text)}", now "${clip(text)}".`,
      );
      return;
    }

    // add: a second source agreeing with an existing line makes it Learned instead of adding a copy
    const target = op.noteId ? findNote(tree, op.noteId) : tree.notes.find((n) => foldQuote(n.title) === foldQuote(op.title as string));
    if (op.noteId && !target) return reject('missing');
    const twin = (target ? [target] : tree.notes).flatMap((n) => n.lines.map((l) => ({ n, l }))).find(({ l }) => sameText(l.text, text));
    if (twin) {
      const { n, l } = twin;
      if (isConfirmed(l) || l.sources.some((s) => s.sourceId === ref.sourceId)) return; // nothing new to learn
      const before = structuredClone(l);
      const noteUpdated = n.updated;
      l.sources = mergeSources(l.sources, [ref]);
      l.updated = ctx.now;
      n.updated = ctx.now;
      changes.push({ kind: 'edited', noteId: n.id, before, after: structuredClone(l), noteUpdated });
      applied.push({ type: 'merge', noteId: n.id, lineId: l.id, earlierText: before.text });
      summary.push(`A second source agrees with a line in "${clip(n.title, 40)}": "${clip(l.text)}".`);
      return;
    }
    if (lineCount(tree) >= LIMITS.lines) return reject('full');
    let note = target;
    let createdNote = false;
    if (!note) {
      const title = (op.title as string).trim();
      if (!title || title.length > LIMITS.title) return reject('invalid');
      note = { id: ctx.newId(), title, kind: op.kind as NoteKind, updated: ctx.now, lines: [] };
      tree.notes = [...tree.notes, note];
      createdNote = true;
    }
    const line: Line = {
      id: ctx.newId(),
      text,
      origin,
      sources: [ref],
      quote: op.quote,
      updated: ctx.now,
      ...(op.expires ? { expires: op.expires } : {}),
    };
    note.lines = [...note.lines, line];
    const noteUpdated = note.updated;
    note.updated = ctx.now;
    changes.push({ kind: 'added', noteId: note.id, createdNote, after: structuredClone(line), noteUpdated });
    applied.push({ type: 'add', noteId: note.id, lineId: line.id });
    summary.push(`Added to "${clip(note.title, 40)}": "${clip(text)}".`);
  });

  if (rejected.length) summary.push(`Skipped ${rejected.length} change${rejected.length === 1 ? '' : 's'} that did not check out.`);
  if (!changes.length && !rejected.length && !suggestions.length)
    return { tree: base, applied, rejected, suggestions, undo: null, journal: null };
  const undo: UndoEntry | null = changes.length ? { id: ctx.newId(), at: ctx.now, trigger: ctx.trigger, changes } : null;
  const journal: JournalEntry = { id: ctx.newId(), at: ctx.now, trigger: ctx.trigger, ops: applied, summary, rejected };
  return { tree: changes.length ? tree : base, applied, rejected, suggestions, undo, journal };
}

export interface UndoResult {
  tree: NotesTree;
  restored: number;
  /** Changes left alone because the line changed again after them. */
  skipped: UndoChange[];
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Reverses one undo entry, newest change first. A change is undone only if its line still looks as the change left it. */
export function undoEntry(base: NotesTree, entry: UndoEntry): UndoResult {
  const tree = cloneTree(base);
  const skipped: UndoChange[] = [];
  let restored = 0;
  for (const change of [...entry.changes].reverse()) {
    const note = findNote(tree, change.noteId);
    if (change.kind === 'added') {
      const line = note?.lines.find((l) => l.id === change.after.id);
      if (!note || !line || !same(line, change.after)) {
        skipped.push(change);
        continue;
      }
      note.lines = note.lines.filter((l) => l !== line);
      if (change.createdNote && !note.lines.length) tree.notes = tree.notes.filter((n) => n !== note);
    } else if (change.kind === 'edited') {
      const index = note ? note.lines.findIndex((l) => l.id === change.before.id) : -1;
      if (!note || index < 0 || !same(note.lines[index], change.after)) {
        skipped.push(change);
        continue;
      }
      note.lines[index] = structuredClone(change.before);
    } else {
      const archived = tree.archive.find((l: ArchivedLine) => l.id === change.lineId && l.archived === change.archivedAt);
      if (!note || !archived) {
        skipped.push(change);
        continue;
      }
      tree.archive = tree.archive.filter((l) => l !== archived);
      const { noteId: _n, archived: _a, reason: _r, by: _b, ...line } = archived;
      note.lines.splice(Math.min(change.index, note.lines.length), 0, line);
    }
    // the note's own update time goes back too, so an undo leaves the notes exactly as they were
    note.updated = change.noteUpdated;
    restored++;
  }
  return { tree, restored, skipped };
}
