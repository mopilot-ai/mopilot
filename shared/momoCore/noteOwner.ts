// What the owner does to the notes with their own hands (Notes page): write a line, or forget a line or a whole note. Unlike the model's ops there is no quote to check: the owner's tap on their own paired device is the evidence, so the line is Confirmed at once; what is checked is only that it is a line (not a secret, not an order, not too long, room for it). Each change has a journal entry and an undo entry like every other change, so History shows it and Undo takes it back.
import type { JournalEntry, UndoEntry } from './noteOps.ts';
import { LIMITS, type Line, type Note, type NotesTree, archiveLine, cloneTree, findNote, lineCount } from './notes.ts';
import { clip, foldQuote, looksLikeInstruction, looksSecret, sameText } from './text.ts';

export interface OwnerDeps {
  now: string;
  newId: () => string;
}
export type OwnerWriteResult =
  | { ok: true; tree: NotesTree; undo: UndoEntry; journal: JournalEntry }
  | { ok: false; reason: 'invalid' | 'secret' | 'instruction' | 'full' | 'same' };

/** The owner writes a line under a title: into the note that has that title, or a new one. */
export function ownerWrite(base: NotesTree, input: { title: string; text: string }, deps: OwnerDeps): OwnerWriteResult {
  const title = input.title.trim();
  const text = input.text.trim();
  if (!title || title.length > LIMITS.title || !text || text.length > LIMITS.text) return { ok: false, reason: 'invalid' };
  if (looksSecret(text, title)) return { ok: false, reason: 'secret' };
  // an order is a rule: the Rules page is where it goes
  if (looksLikeInstruction(text, title)) return { ok: false, reason: 'instruction' };
  const tree = cloneTree(base);
  const existing = tree.notes.find((n) => foldQuote(n.title) === foldQuote(title));
  if ((existing ? [existing] : tree.notes).some((n) => n.lines.some((l) => sameText(l.text, text)))) return { ok: false, reason: 'same' };
  if (lineCount(tree) >= LIMITS.lines) return { ok: false, reason: 'full' };
  let note = existing;
  const createdNote = !note;
  if (!note) {
    note = { id: deps.newId(), title, kind: 'topic', updated: deps.now, lines: [] } satisfies Note;
    tree.notes = [...tree.notes, note];
  }
  const line: Line = {
    id: deps.newId(),
    text,
    origin: 'stated',
    edited: true,
    sources: [{ sourceId: `owner:${deps.newId()}`, kind: 'chat', at: deps.now }],
    quote: text.slice(0, LIMITS.quote),
    updated: deps.now,
  };
  const noteUpdated = note.updated;
  note.lines = [...note.lines, line];
  note.updated = deps.now;
  const undo: UndoEntry = {
    id: deps.newId(),
    at: deps.now,
    trigger: 'chat',
    changes: [{ kind: 'added', noteId: note.id, createdNote, after: structuredClone(line), noteUpdated }],
  };
  const journal: JournalEntry = {
    id: deps.newId(),
    at: deps.now,
    trigger: 'chat',
    ops: [{ type: 'add', noteId: note.id, lineId: line.id }],
    summary: [`You added to "${clip(note.title, 40)}": "${clip(text)}".`],
    rejected: [],
  };
  return { ok: true, tree, undo, journal };
}

export type OwnerForgetResult = { ok: true; tree: NotesTree; undo: UndoEntry; journal: JournalEntry } | { ok: false };

/** The owner forgets one line, or (with no line) every line of a note. A Confirmed line too: it is theirs. The lines are let go, so History can bring them back and Undo restores them where they were. */
export function ownerForget(base: NotesTree, noteId: string, lineId: string | undefined, deps: OwnerDeps): OwnerForgetResult {
  const tree = cloneTree(base);
  const note = findNote(tree, noteId);
  if (!note) return { ok: false };
  const targets = lineId === undefined ? note.lines.map((l) => l.id) : note.lines.filter((l) => l.id === lineId).map((l) => l.id);
  if (!targets.length) return { ok: false };
  const undoChanges: UndoEntry['changes'] = [];
  const ops: JournalEntry['ops'] = [];
  const said: string[] = [];
  for (const id of targets) {
    const line = note.lines.find((l) => l.id === id) as Line;
    const index = note.lines.indexOf(line);
    const noteUpdated = note.updated;
    archiveLine(tree, noteId, id, 'manual', deps.now);
    undoChanges.push({ kind: 'retired', noteId, lineId: id, archivedAt: deps.now, index, noteUpdated });
    ops.push({ type: 'retire', noteId, lineId: id, earlierText: line.text });
    said.push(`"${clip(line.text)}"`);
  }
  const undo: UndoEntry = { id: deps.newId(), at: deps.now, trigger: 'chat', changes: undoChanges };
  const journal: JournalEntry = {
    id: deps.newId(),
    at: deps.now,
    trigger: 'chat',
    ops,
    summary: [
      `You forgot ${targets.length === 1 ? 'a line' : `${targets.length} lines`} in "${clip(note.title, 40)}": ${said.join(', ')}.`,
    ],
    rejected: [],
  };
  return { ok: true, tree, undo, journal };
}
