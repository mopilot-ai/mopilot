// The nightly tidy of MoMo's notes: lets go of expired lines, duplicates and single-source guesses quiet for 60 days, at most a fifth of the lines per pass and never a Confirmed line, and returns one journal entry and one restorable snapshot per run (repair rules after n8n-io/nod memory-lint.ts, Apache-2.0, see NOTICE; the snapshot-before-change idea after nanobot's gitstore, MIT).
import { clip, sameText } from './text.ts';
import {
  STALE_DAYS,
  type Line,
  type Note,
  type NotesTree,
  type RetireReason,
  archiveLine,
  cloneTree,
  isConfirmed,
  lineCount,
} from './notes.ts';
import type { AppliedOp, JournalEntry, UndoChange, UndoEntry } from './noteOps.ts';

export interface Snapshot {
  id: string;
  at: string;
  /** The notes as they were before this run changed anything. */
  tree: NotesTree;
  lineCount: number;
}

export interface TidyOptions {
  now: string;
  newId: () => string;
  /** Share of the lines one pass may let go. The design says a fifth. */
  maxShare?: number;
  staleDays?: number;
}

export interface TidyResult {
  tree: NotesTree;
  snapshot: Snapshot;
  journal: JournalEntry;
  undo: UndoEntry | null;
  /** Lines the cap held back until the next night. */
  deferred: number;
}

interface Plan {
  noteId: string;
  line: Line;
  reason: RetireReason;
  by?: string;
}

const DAY_MS = 86_400_000;
const rank = (l: Line) => (isConfirmed(l) ? 2 : 1);
const better = (a: Line, b: Line) => rank(a) - rank(b) || a.sources.length - b.sources.length || a.updated.localeCompare(b.updated);

/** Decides what to let go, most certain first: expired, duplicate, then stale. Confirmed lines are never listed. */
function plan(tree: NotesTree, now: string, staleDays: number): Plan[] {
  const today = now.slice(0, 10);
  const out: Plan[] = [];
  const taken = new Set<string>();
  for (const note of tree.notes)
    for (const line of note.lines)
      if (!isConfirmed(line) && line.expires && line.expires < today) {
        out.push({ noteId: note.id, line, reason: 'expired' });
        taken.add(line.id);
      }
  for (const note of tree.notes) {
    const group = note.lines.filter((l) => !taken.has(l.id));
    for (const [i, first] of group.entries())
      for (const second of group.slice(i + 1)) {
        if (taken.has(first.id) || taken.has(second.id) || !sameText(first.text, second.text)) continue;
        const [keep, drop] = better(first, second) >= 0 ? [first, second] : [second, first];
        if (isConfirmed(drop)) continue;
        out.push({ noteId: note.id, line: drop, reason: 'duplicate', by: keep.id });
        taken.add(drop.id);
      }
  }
  for (const note of tree.notes)
    for (const line of note.lines)
      if (
        !taken.has(line.id) &&
        !isConfirmed(line) &&
        new Set(line.sources.map((s) => s.sourceId)).size < 2 &&
        Date.parse(now) - Date.parse(line.updated) > staleDays * DAY_MS
      ) {
        out.push({ noteId: note.id, line, reason: 'stale' });
        taken.add(line.id);
      }
  return out;
}

const REASON_WORDS: Record<string, string> = {
  expired: 'out of date',
  duplicate: 'a duplicate',
  stale: `a single guess quiet for ${STALE_DAYS} days`,
};

export function tidy(base: NotesTree, options: TidyOptions): TidyResult {
  const { now, newId } = options;
  const snapshot: Snapshot = { id: newId(), at: now, tree: cloneTree(base), lineCount: lineCount(base) };
  const tree = cloneTree(base);
  const share = options.maxShare ?? 0.2;
  const cap = Math.max(1, Math.floor(lineCount(base) * share));
  const wanted = plan(tree, now, options.staleDays ?? STALE_DAYS);
  const chosen = wanted.slice(0, cap);
  const changes: UndoChange[] = [];
  const ops: AppliedOp[] = [];
  const summary: string[] = [];
  for (const item of chosen) {
    const owner = tree.notes.find((n) => n.id === item.noteId) as Note;
    const index = owner.lines.indexOf(item.line);
    const noteUpdated = owner.updated;
    archiveLine(tree, item.noteId, item.line.id, item.reason, now, item.by);
    changes.push({ kind: 'retired', noteId: item.noteId, lineId: item.line.id, archivedAt: now, index, noteUpdated });
    ops.push({ type: 'retire', noteId: item.noteId, lineId: item.line.id, earlierText: item.line.text });
    const title = (tree.notes.find((n) => n.id === item.noteId) as Note).title;
    summary.push(`Let go of a line in "${clip(title, 40)}" (${REASON_WORDS[item.reason]}): "${clip(item.line.text)}".`);
  }
  const deferred = wanted.length - chosen.length;
  if (deferred > 0) summary.push(`${deferred} more line${deferred === 1 ? '' : 's'} wait for the next night.`);
  if (!changes.length && !deferred) summary.push('Nothing to tidy tonight.');
  const journal: JournalEntry = {
    id: newId(),
    at: now,
    trigger: 'nightly',
    ops,
    summary,
    snapshotId: snapshot.id,
    rejected: [],
  };
  const undo: UndoEntry | null = changes.length ? { id: newId(), at: now, trigger: 'tidy', changes } : null;
  return { tree: changes.length ? tree : base, snapshot, journal, undo, deferred };
}

/** "Restore last night": the notes as they were before the run. Anything added since is lost, so the caller shows that first. */
export const restoreSnapshot = (snapshot: Snapshot): NotesTree => cloneTree(snapshot.tree);
