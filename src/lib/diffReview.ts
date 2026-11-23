// Reviewing a diff in the Changes pane: a file's diff with its whitespace-only edits shown as unchanged lines (Show whitespace off), and the fingerprint a Viewed mark is kept against so a later change to the file is noticed.

import { diffFileText, type DiffFile, type DiffLine } from './diff';
import type { DiffCommentRange } from '../../shared/diffComments.mjs';

const squeeze = (text: string) => text.replace(/\s+/g, '');
const ignored = new WeakMap<DiffFile, DiffFile>();

/**
 * `file` as `git diff -w` reads it, near enough: in each run of removed lines followed by added ones, a removed line
 * and the added line at the same place that differ only in whitespace become one unchanged line (the new text at both
 * numbers). Other edits stay. The same file gives back the same object.
 */
export function withoutWhitespaceChanges(file: DiffFile): DiffFile {
  const known = ignored.get(file);
  if (known) return known;
  const lines: DiffLine[] = [];
  let changed = false;
  for (let i = 0; i < file.lines.length; ) {
    if (file.lines[i].kind !== 'del') {
      lines.push(file.lines[i++]);
      continue;
    }
    const dels: DiffLine[] = [];
    while (file.lines[i]?.kind === 'del') dels.push(file.lines[i++]);
    const adds: DiffLine[] = [];
    while (file.lines[i]?.kind === 'add') adds.push(file.lines[i++]);
    const pairs = Math.min(dels.length, adds.length);
    const same = (n: number) => n < pairs && squeeze(dels[n].text) === squeeze(adds[n].text);
    // Flush each real edit run before its next unchanged line, preserving both sides' line order.
    let start = 0;
    for (let n = 0; n <= Math.max(dels.length, adds.length); n++) {
      if (n < Math.max(dels.length, adds.length) && !same(n)) continue;
      lines.push(...dels.slice(start, n), ...adds.slice(start, n));
      if (same(n)) {
        changed = true;
        lines.push({ kind: 'ctx', text: adds[n].text, oldNo: dels[n].oldNo, newNo: adds[n].newNo });
      }
      start = n + 1;
    }
  }
  const out = changed
    ? {
        ...file,
        lines,
        added: lines.filter((l) => l.kind === 'add').length,
        removed: lines.filter((l) => l.kind === 'del').length,
      }
    : file;
  ignored.set(file, out);
  return out;
}

/** Whether every edit of `file` is in whitespace: it changed lines, and none is left once whitespace is set aside. */
export function whitespaceOnly(file: DiffFile): boolean {
  if (file.added + file.removed === 0 || file.binary) return false;
  const kept = withoutWhitespaceChanges(file);
  return kept.added + kept.removed === 0;
}

/** A short fingerprint of what the file's diff says (FNV-1a over its patch), so a Viewed mark notices a later change. */
export function diffFingerprint(file: DiffFile): string {
  const text = file.binary ? JSON.stringify([diffFileText(file), file.binaryVersion]) : diffFileText(file);
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${text.length}:${(hash >>> 0).toString(36)}`;
}

/** Context size and hunk headers can differ between Git and GitHub; changed lines and selected coordinates must agree. */
export function sameReviewLines(expected: DiffFile, actual: DiffFile, range: DiffCommentRange): boolean {
  const edits = (file: DiffFile) =>
    JSON.stringify(
      file.lines.filter((line) => line.kind === 'add' || line.kind === 'del').map((line) => [line.kind, line.oldNo, line.newNo, line.text]),
    );
  if (edits(expected) !== edits(actual)) return false;
  return (
    [
      [range.startSide, range.startLine],
      [range.endSide, range.endLine],
    ] as const
  ).every(([side, number]) => {
    const column = side === 'L' ? 'oldNo' : 'newNo';
    const shown = expected.lines.find((line) => line[column] === number);
    const offered = actual.lines.find((line) => line[column] === number);
    return !!shown && !!offered && shown.text === offered.text;
  });
}
