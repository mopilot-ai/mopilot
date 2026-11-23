// Find in the chat on screen: the ranges a term covers in the rendered prompts and replies, by turn, and the page's
// highlights for them (the CSS Custom Highlight API), shared by every transcript the window shows.
import { foldText, occurrences } from '../../../lib/textFind';

/** What find reads, as src/session/threadNavigation.ts's `find` texts: the user's words, an ending plan, the final reply. */
export const FIND_REGIONS = '.user-message .fold-text, .turn > .plan-card > .md, .turn > .assistant-message .md';
/** Chrome inside those that is no part of the text (a code block's language and Copy, suggestion chips). */
const SKIP = 'button, .code-header, .md-followups, [aria-hidden="true"]';

/**
 * Where `needle` (folded, src/session/chatFind.ts) occurs in the rendered regions under `root`, in order, for every turn
 * rendered there (one with none has an empty list): what each turn on screen draws is its count.
 */
export function findRanges(root: Element, needle: string): Map<string, Range[]> {
  const out = new Map<string, Range[]>();
  if (!needle) return out;
  for (const turn of root.querySelectorAll<HTMLElement>('[data-turn-id]')) out.set(turn.dataset.turnId!, []);
  for (const region of root.querySelectorAll<HTMLElement>(FIND_REGIONS)) {
    const turnId = region.closest<HTMLElement>('[data-turn-id]')?.dataset.turnId;
    if (turnId) out.get(turnId)!.push(...textRanges(region, needle, SKIP));
  }
  return out;
}

/**
 * Where `needle` (folded, src/session/chatFind.ts) occurs in the text under `region`, in order, leaving out the text
 * of elements matching `skip` inside it: the chat's regions and the Files pane's code view alike.
 */
export function textRanges(region: Element, needle: string, skip?: string): Range[] {
  const out: Range[] = [];
  if (!needle) return out;
  const doc = region.ownerDocument;
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  const walker = doc.createTreeWalker(region, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const chrome = skip ? node.parentElement?.closest(skip) : null;
    if (chrome && region.contains(chrome)) continue;
    nodes.push(node);
    starts.push(text.length);
    text += node.data;
  }
  const folded = foldText(text);
  // the node holding original offset `i`, and the offset in it (an end may sit just past a node's last character)
  const point = (i: number, end: boolean): [Text, number] => {
    let n = nodes.length - 1;
    while (n > 0 && (end ? starts[n] >= i : starts[n] > i)) n--;
    return [nodes[n], i - starts[n]];
  };
  for (const at of occurrences(folded.text, needle)) {
    const first = folded.at[at];
    const lastAt = folded.at[at + needle.length - 1];
    const last = lastAt + (text.codePointAt(lastAt)! > 0xffff ? 2 : 1);
    const range = doc.createRange();
    range.setStart(...point(first, false));
    range.setEnd(...point(last, true));
    out.push(range);
  }
  return out;
}

interface HighlightRegistry {
  set(name: string, highlight: unknown): void;
  delete(name: string): void;
}
const registry = () => (globalThis.CSS as unknown as { highlights?: HighlightRegistry } | undefined)?.highlights;
const HighlightOf = () => (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

/** Each open find's ranges, by its view: the page has one highlight of each name, for all of them. */
const shown = new Map<object, { all: Range[]; current: Range | null }>();

function paint() {
  const highlights = registry();
  const Highlight = HighlightOf();
  if (!highlights || !Highlight) return;
  const all = [...shown.values()].flatMap((v) => v.all.filter((r) => r !== v.current));
  const current = [...shown.values()].flatMap((v) => (v.current ? [v.current] : []));
  if (all.length) highlights.set('chat-find', new Highlight(...all));
  else highlights.delete('chat-find');
  if (current.length) highlights.set('chat-find-current', new Highlight(...current));
  else highlights.delete('chat-find-current');
}

/** Show `owner`'s matches, `current` set apart; null clears them. */
export function showFindHighlights(owner: object, ranges: { all: Range[]; current: Range | null } | null) {
  if (ranges) shown.set(owner, ranges);
  else if (!shown.delete(owner)) return;
  paint();
}
