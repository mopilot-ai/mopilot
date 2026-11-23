// Merging two edits to one file in a turn into a single diff file.

import type { DiffFile } from './diff';

/** Two edits to one file in a turn, shown as one file: the later hunks follow the earlier ones (D-68). */
export function mergeDiffFile(a: DiffFile, b: DiffFile): DiffFile {
  return {
    ...a,
    lines: [...a.lines, ...b.lines],
    added: a.added + b.added,
    removed: a.removed + b.removed,
    isNew: a.isNew,
    isDeleted: b.isDeleted,
    binary: b.binary ?? a.binary,
    mode: b.mode ?? a.mode,
    oldMode: a.oldMode ?? b.oldMode,
    newMode: b.newMode ?? a.newMode,
  };
}
