// MoMo's notes: the record shapes (notes holding lines with up to 5 sources and a verbatim quote), the status of a line computed and never stored, and the pure helpers that move a line between the notes and the Let go archive (schema and status rule after n8n-io/nod memory-tree.ts, Apache-2.0, see NOTICE).

export const LIMITS = { text: 4000, sources: 5, quote: 400, lines: 2000, title: 120 } as const;
/** A single-source line nobody confirmed that has been quiet this long is let go (nod: 60 days). */
export const STALE_DAYS = 60;

export type SourceKind = 'chat' | 'mail' | 'event';
export type NoteKind = 'person' | 'company' | 'project' | 'topic' | 'about';
export type Origin = 'stated' | 'inferred' | 'mail';
export type RetireReason = 'replaced' | 'expired' | 'stale' | 'duplicate' | 'obsolete' | 'contradicted' | 'manual';
export type Status = 'Mentioned once' | 'Learned' | 'Confirmed' | 'Let go';

export interface SourceRef {
  sourceId: string;
  kind: SourceKind;
  /** ISO time the source was written or received. */
  at: string;
  /** The mail thread or calendar series the source belongs to. */
  threadId?: string;
}

export interface Line {
  id: string;
  text: string;
  origin: Origin;
  sources: SourceRef[];
  /** Words copied from a source or from the owner, checked by code before the line was saved. */
  quote: string;
  updated: string;
  /** The owner edited or confirmed this line. */
  edited?: boolean;
  /** ISO date after which the line is let go. */
  expires?: string;
}

export interface Note {
  id: string;
  title: string;
  kind: NoteKind;
  updated: string;
  lines: Line[];
}

export interface ArchivedLine extends Line {
  noteId: string;
  archived: string;
  reason: RetireReason;
  /** The line that replaced or absorbed this one. */
  by?: string;
}

export interface NotesTree {
  notes: Note[];
  archive: ArchivedLine[];
}

export const emptyTree = (): NotesTree => ({ notes: [], archive: [] });
export const cloneTree = (tree: NotesTree): NotesTree => structuredClone(tree);
export const lineCount = (tree: NotesTree): number => tree.notes.reduce((n, note) => n + note.lines.length, 0);

export const isConfirmed = (line: Line): boolean => line.origin === 'stated' || line.edited === true;
const distinctSources = (line: Line): number => new Set(line.sources.map((s) => s.sourceId)).size;

/** Mentioned once until a second source agrees; Confirmed when the owner wrote, edited or confirmed it; Let go when archived. Computed, never stored. */
export function statusOf(line: Line, archived = false): Status {
  if (archived) return 'Let go';
  if (isConfirmed(line)) return 'Confirmed';
  return distinctSources(line) >= 2 ? 'Learned' : 'Mentioned once';
}

export const findNote = (tree: NotesTree, noteId: string): Note | undefined => tree.notes.find((n) => n.id === noteId);
export const findLine = (tree: NotesTree, noteId: string, lineId: string): Line | undefined =>
  findNote(tree, noteId)?.lines.find((l) => l.id === lineId);

/** Keeps the newest sources, at most LIMITS.sources, one per source id. */
export function mergeSources(...lists: SourceRef[][]): SourceRef[] {
  const byId = new Map<string, SourceRef>();
  for (const ref of lists.flat()) byId.set(ref.sourceId, ref);
  return [...byId.values()].slice(-LIMITS.sources);
}

/** Moves a line out of its note into the archive. Returns the archived line. */
export function archiveLine(
  tree: NotesTree,
  noteId: string,
  lineId: string,
  reason: RetireReason,
  now: string,
  by?: string,
): ArchivedLine | undefined {
  const note = findNote(tree, noteId);
  const line = note?.lines.find((l) => l.id === lineId);
  if (!note || !line) return undefined;
  note.lines = note.lines.filter((l) => l !== line);
  note.updated = now;
  const archived: ArchivedLine = { ...line, noteId, archived: now, reason, ...(by ? { by } : {}) };
  tree.archive = [...tree.archive, archived];
  return archived;
}

/** "Bring back": a line let go returns to its note and counts as Confirmed. */
export function bringBack(tree: NotesTree, lineId: string, now: string): boolean {
  const found = tree.archive.find((l) => l.id === lineId);
  const note = found && findNote(tree, found.noteId);
  if (!found || !note) return false;
  tree.archive = tree.archive.filter((l) => l !== found);
  const { noteId: _n, archived: _a, reason: _r, by: _b, ...line } = found;
  note.lines = [...note.lines, { ...line, origin: 'stated', edited: true, updated: now }];
  note.updated = now;
  return true;
}

/** The owner's own edit: final, and the line is Confirmed. */
export function editByOwner(tree: NotesTree, noteId: string, lineId: string, text: string, now: string): boolean {
  const line = findLine(tree, noteId, lineId);
  const trimmed = text.trim();
  if (!line || !trimmed || trimmed.length > LIMITS.text) return false;
  line.text = trimmed;
  line.edited = true;
  line.updated = now;
  return true;
}
