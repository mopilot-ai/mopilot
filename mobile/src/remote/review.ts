// The phone's read-only review calls (diff.list, diff.read, file.read) and defensive readers of the rows and pages the Mac returns.
import { withSelections } from '../../../shared/selections.mjs';
import { bad, needs, num, rec, str, type Capabilities, type Owned } from './client';

export type Scope = 'uncommitted' | 'branch' | 'turn';
export type Change = { path: string; oldPath: string | null; status: string; binary: boolean; added: number; removed: number };
export type Changes = { files: Change[]; total: number; omitted: number; truncated: boolean };
export type Row = { id: number; k: 'hunk' | 'ctx' | 'add' | 'del' | 'meta'; t: string; w: [number, number] | null; cut: boolean };
export type DiffPage = { binary: boolean; rows: Row[]; next: number | null; total: number };
export type FilePage = { text: string; size: number; next: number | null };

const KINDS = new Set(['hunk', 'ctx', 'add', 'del', 'meta']);

export async function listChanges(request: Owned, chatId: string, scope: Scope, caps: Capabilities | null): Promise<Changes> {
  needs(caps, 'diff.list', 'review changes');
  const r = rec(await request('diff.list', { chatId, scope }));
  if (!r || !Array.isArray(r.files)) return bad('the changes');
  const files = r.files.flatMap((x) => {
    const f = rec(x);
    const path = str(f?.path);
    return path
      ? [
          {
            path,
            oldPath: str(f?.oldPath),
            status: str(f?.status) ?? 'modified',
            binary: f?.binary === true,
            added: num(f?.added) ?? 0,
            removed: num(f?.removed) ?? 0,
          },
        ]
      : [];
  });
  return { files, total: num(r.total) ?? files.length, omitted: num(r.omitted) ?? 0, truncated: r.truncated === true };
}

/** One page of a file's diff rows; `next` is where the following page starts, null at the end. */
export async function readDiff(
  request: Owned,
  chatId: string,
  change: Change,
  scope: Scope,
  from: number,
  caps: Capabilities | null,
): Promise<DiffPage> {
  needs(caps, 'diff.read', 'review changes');
  const r = rec(
    await request('diff.read', { chatId, scope, path: change.path, ...(change.oldPath ? { oldPath: change.oldPath } : {}), from }),
  );
  if (!r || !Array.isArray(r.rows)) return bad('the diff');
  const rows = r.rows.flatMap((x, at) => {
    const row = rec(x);
    const k = str(row?.k);
    if (!k || !KINDS.has(k) || typeof row?.t !== 'string') return [];
    const w = Array.isArray(row.w) && typeof row.w[0] === 'number' && typeof row.w[1] === 'number' && row.w[0] < row.w[1] ? row.w : null;
    return [{ id: from + at, k: k as Row['k'], t: row.t, w: w ? ([w[0], w[1]] as [number, number]) : null, cut: row.cut === true }];
  });
  return { binary: r.binary === true, rows, next: num(r.next), total: num(r.total) ?? rows.length };
}

/** One page of a text file, from byte `offset`. */
export async function readFile(request: Owned, chatId: string, path: string, offset: number, caps: Capabilities | null): Promise<FilePage> {
  needs(caps, 'file.read', 'open files');
  const r = rec(await request('file.read', { chatId, path, offset }));
  if (!r || typeof r.text !== 'string') return bad('the file');
  const size = num(r.size) ?? r.text.length;
  const read = num(r.bytes) ?? r.text.length;
  return { text: r.text, size, next: r.truncated === true && read > 0 ? (num(r.offset) ?? offset) + read : null };
}

export type Side = 'L' | 'R';
/** A note on one diff line: where it is, the line as shown (for the agent to find it) and what the person wrote. */
export type Note = { path: string; side: Side; line: number; hunk: string; text: string };
/** What one message can carry: the message stays far under the Mac's size limit. */
export const MOST_NOTES = 20;
export const NOTE_CHARS = 1000;
const HUNK_CHARS = 400;
const SIGN = { add: '+', del: '-', ctx: ' ' } as const;

/** The side of the diff a row is on: a removed line is the old file's, any other the new one's. */
export const sideOf = (row: Row): Side => (row.k === 'del' ? 'L' : 'R');
type Place = Pick<Note, 'path' | 'side' | 'line' | 'hunk'>;
/** The same line: its number alone is not enough, since another scope or a changed file has other text on it. */
export const sameLine = (a: Place, b: Place) => a.path === b.path && a.side === b.side && a.line === b.line && a.hunk === b.hunk;
/** The first `n` characters, never half of a surrogate pair, with … where something was cut. */
const cut = (text: string, n: number) => {
  const chars = Array.from(text);
  return chars.length > n ? `${chars.slice(0, n - 1).join('')}…` : text;
};

/** The note a person wrote on a line of a changed or context row. */
export function lineNote(path: string, row: Row & { k: keyof typeof SIGN }, line: number, text: string): Note {
  return {
    path,
    side: sideOf(row),
    line,
    hunk: cut(`${SIGN[row.k]}${row.t}`, HUNK_CHARS),
    text: Array.from(text.trim()).slice(0, NOTE_CHARS).join(''),
  };
}

/** The notes with this one added or replaced; an empty note takes its line's note away, and a full list takes no new line. */
export function setNote(notes: Note[], note: Note): Note[] {
  const rest = notes.filter((n) => !sameLine(n, note));
  if (!note.text) return rest;
  if (rest.length === notes.length && notes.length >= MOST_NOTES) return notes;
  return [...rest, note];
}

/** Said with the notes, so the agent knows what they are for. */
export const NOTES_REQUEST = 'Address these notes on the changes.';

/** One follow-up message for the notes, in the diff-comment form every agent is given and the computer shows back as comments. */
export const notesMessage = (notes: Note[]) =>
  withSelections(
    NOTES_REQUEST,
    notes.map((n) => ({
      text: n.hunk,
      annotation: n.text,
      diff: { path: n.path, startSide: n.side, startLine: n.line, endSide: n.side, endLine: n.line, hunk: n.hunk },
    })),
  );

// Notes live in memory only, kept per app session (runtime) and chat, so leaving the Changes screen does not lose an unsent note
const kept = new WeakMap<object, Map<string, Note[]>>();
export const keptNotes = (owner: object, chatId: string): Note[] => kept.get(owner)?.get(chatId) ?? [];
export function keepNotes(owner: object, chatId: string, notes: Note[]) {
  const chats = kept.get(owner) ?? new Map<string, Note[]>();
  if (notes.length) chats.set(chatId, notes);
  else chats.delete(chatId);
  kept.set(owner, chats);
}
