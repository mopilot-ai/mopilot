export type DiffSide = 'L' | 'R';
/** Where a diff comment sits: a range of diff lines (L: the old file, R: the new one) and the hunk it covers. */
export type DiffCommentRange = {
  path: string;
  workspace?: string;
  startSide: DiffSide;
  startLine: number;
  endSide: DiffSide;
  endLine: number;
  hunk: string;
};
export const DIFF_COMMENTS_HEADING: string;
export function diffCommentLines(range: Pick<DiffCommentRange, 'startSide' | 'startLine' | 'endSide' | 'endLine'>): string;
export function formatDiffComments(comments: { diff: DiffCommentRange; annotation?: string }[]): string;
export function parseDiffComments(section: string): {
  text: string;
  annotation?: string;
  file: { path: string; lines: string; side: string };
}[];
