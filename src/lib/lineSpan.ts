// The lines a file citation names (`#L12`, `:12`, a range `#L5-L20` or `:5-20`), as message links and inline code paths open them.

/** One line, or a range whose end comes after its start (a reversed or equal end is just the line). */
export type LineSpan = { line?: number; endLine?: number };

/** A citation's start and optional end, as written, as the lines they name. */
export function lineSpan(start: string, end?: string): LineSpan {
  const line = Number(start);
  const last = end === undefined ? undefined : Number(end);
  return last !== undefined && last > line ? { line, endLine: last } : { line };
}
