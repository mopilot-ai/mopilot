// Find in the chat (⌘F): where a term occurs in a thread's prompts and replies, read from its turns so a turn the long
// thread's window has not rendered is found too, and the folding both sides of the match share (case, runs of space).
import { turnEntries } from './threadNavigation';
import { foldTerm, foldText, occurrences } from '../lib/textFind';

export { foldText, foldTerm, occurrences, stepMatch } from '../lib/textFind';

/** A turn as the navigation entries read it (src/lib may not import the store's types). */
type Turn = Parameters<typeof turnEntries>[0];

/** One occurrence: the turn it is in, the prompt to jump to for that turn, and which of the turn's occurrences it is. */
export interface ChatFindMatch {
  turnId: string;
  /** the turn's first navigation entry, whose jump renders the turn; null for a turn no one typed in (a wake) */
  entryId: string | null;
  /** its place among the turn's own occurrences, in the order the turn draws them */
  ordinal: number;
}

/**
 * Markdown as the reply draws it, near enough for counting: emphasis, code and link syntax gone, a link or image as its
 * text, no heading, quote or list markers. What is left over (a table's pipes) is drawn too.
 */
export function shownText(markdown: string): string {
  return markdown
    .split('\n')
    .filter((line) => !/^\s*(```|~~~)/.test(line))
    .map((line) =>
      line
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s*(>\s?)+/, '')
        .replace(/^\s*([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, ''),
    )
    .join('\n')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '');
}

/** Each turn's count for the last term asked, by turn object: a streamed delta recounts only the turn it changed. */
const counted = new WeakMap<Turn, { needle: string; count: number }>();

/** How often `needle` (folded) occurs in a turn's prompts and replies as its data holds them. */
function dataCount(turn: Turn, needle: string): number {
  const known = counted.get(turn);
  if (known?.needle === needle) return known.count;
  const texts = turnEntries(turn).flatMap((entry) => [entry.find.said, ...entry.find.replies.map(shownText)]);
  const count = texts.reduce((n, text) => n + occurrences(foldText(text).text, needle).length, 0);
  counted.set(turn, { needle, count });
  return count;
}

/**
 * Every occurrence of `term` in the turns' prompts and replies, oldest first. A turn on screen counts what it draws
 * (`drawn`, by turn id), which is what is highlighted; one the long thread shows as a placeholder counts its data.
 */
export function chatFindMatches(turns: readonly Turn[], term: string, drawn?: ReadonlyMap<string, number>): ChatFindMatch[] {
  const needle = foldTerm(term);
  const out: ChatFindMatch[] = [];
  if (!needle) return out;
  for (const turn of turns) {
    const entryId = turnEntries(turn)[0]?.id ?? null;
    const count = drawn?.get(turn.id) ?? dataCount(turn, needle);
    for (let ordinal = 0; ordinal < count; ordinal++) out.push({ turnId: turn.id, entryId, ordinal });
  }
  return out;
}

/** The match to show first: the newest one, nearest where a reader of the chat usually is. */
export const firstMatch = (matches: readonly ChatFindMatch[]) => matches.length - 1;
