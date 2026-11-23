// Line numbers for a diff's rows, counted from each hunk header ("@@ -12,5 +14,7 @@"), the way a diff viewer's gutter shows them.
import type { Row } from '../remote/review';

export type NumberedRow = {
  row: Row /** The line in the file as it is now (as it was, for a removed line); null where the hunk's start is not known. */;
  line: number | null;
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

export function numberRows(rows: Row[]): NumberedRow[] {
  let before: number | null = null;
  let after: number | null = null;
  return rows.map((row) => {
    if (row.k === 'hunk') {
      const m = HUNK.exec(row.t);
      before = m ? Number(m[1]) : null;
      after = m ? Number(m[2]) : null;
      return { row, line: null };
    }
    if (row.k === 'meta') return { row, line: null };
    if (row.k === 'del') {
      const line = before;
      if (before !== null) before += 1;
      return { row, line };
    }
    const line = after;
    if (after !== null) after += 1;
    if (row.k === 'ctx' && before !== null) before += 1;
    return { row, line };
  });
}
