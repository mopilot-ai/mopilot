// Find's text matching, shared by the chat's find (src/session/chatFind.ts) and the Files pane's find in file: the folding both sides of a match share (case, runs of space), where a term occurs, and stepping between matches.

/**
 * Text as find compares it: lower case, every run of white space one space. `at[i]` is where folded character `i`
 * came from, so a match in the folded text maps back to the original (a DOM Range's offsets).
 */
export function foldText(text: string): { text: string; at: number[] } {
  let out = '';
  const at: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; ) {
    const code = text.codePointAt(i)!;
    const char = String.fromCodePoint(code);
    if (/\s/.test(char)) {
      if (!space) {
        out += ' ';
        at.push(i);
      }
      space = true;
    } else {
      // a character that lowers to more than one (İ) keeps pointing at itself for each
      for (const unit of char.toLowerCase().split('')) {
        out += unit;
        at.push(i);
      }
      space = false;
    }
    i += char.length;
  }
  return { text: out, at };
}

/** The folded term, or '' for one with nothing to find (empty or only space). */
export const foldTerm = (term: string) => foldText(term).text.trim();

/** Where `needle` (folded) starts in `haystack` (folded), without overlaps: "aa" twice in "aaaa", as a browser counts. */
export function occurrences(haystack: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) out.push(i);
  return out;
}

/** The match `step` (1 down, -1 up) from `current`, going round at either end; -1 with none. */
export function stepMatch(count: number, current: number, step: 1 | -1): number {
  if (!count) return -1;
  return (((current + step) % count) + count) % count;
}
