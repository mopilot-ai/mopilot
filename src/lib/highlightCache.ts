// What the highlighter's caches keep (src/lib/highlight.ts in the window, highlightEngine.ts in its worker): code up to a size, so a large file edited in place does not fill them with a copy of itself at every pause.

/** The longest code whose colored html is kept for the next time it is drawn. */
export const CACHED_CODE_MAX = 64_000;

export const cacheable = (code: string) => code.length <= CACHED_CODE_MAX;
