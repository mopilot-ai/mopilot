// Windowing a long thread: which turns render in full, the heights their placeholders keep, and the scroll math that
// keeps the reader's place while placeholders and turns swap.

import type { TurnState } from '../../shared/model/store';
import { memoByObject } from './memoByObject';
import { heartbeatMessage } from '../../shared/heartbeatMessage.mjs';

/** Turns render in full while they are within this many screens above or below the viewport. */
export const WINDOW_SCREENS = 2;
/** Characters per line and the line height of a reply's prose, for a turn's height before it was ever measured. */
const LINE_CHARS = 90;
const LINE_PX = 24;
/** A prompt with its bubble and the gap under it, and the space a reply's blocks add between paragraphs. */
const PROMPT_PX = 96;
const PARAGRAPH_PX = 12;
/** The collapsed "Worked for" row a turn with tool work shows. */
const WORK_PX = 40;

/** The text parts of a prompt, one per line. */
const promptText = (item: TurnState['items'][number]): string =>
  ((item as { content?: { type: string; text?: string }[] }).content ?? [])
    .flatMap((c) => (c.type === 'text' ? [c.text ?? ''] : []))
    .join('\n');
const replyText = (item: TurnState['items'][number], streaming: boolean): string =>
  heartbeatMessage(String((item as { text?: unknown }).text ?? ''), streaming);

/**
 * About how tall a turn renders, from its text: prompt and reply lines at the column's usual width. A turn's measured
 * height replaces this once it has rendered; the estimate only sizes a placeholder (and the scroll bar) until then.
 */
export const estimateTurnHeight = memoByObject((turn: TurnState): number => {
  let height = 0;
  let work = false;
  for (const item of turn.items) {
    const text =
      item.type === 'userMessage' ? promptText(item) : item.type === 'agentMessage' ? replyText(item, turn.status === 'inProgress') : null;
    if (text === null) {
      work = true;
      continue;
    }
    if (item.type === 'userMessage') height += PROMPT_PX;
    for (const line of text.split('\n')) height += line.trim() ? Math.ceil(line.length / LINE_CHARS) * LINE_PX : PARAGRAPH_PX;
  }
  return Math.max(LINE_PX, Math.round(height + (work ? WORK_PX : 0)));
});

/** The most a placeholder shows of a prompt and of a reply: what fits its first lines, never the whole of a long reply. */
const PREVIEW_PROMPT = 240;
const PREVIEW_REPLY = 600;

/** `text` as one line of plain words, at most `max` characters: list and heading marks, emphasis and runs of blanks gone. */
function flatten(text: string, max: number): string {
  return text
    .slice(0, max * 2)
    .replace(/^[#>\-*+]+\s+/gm, '')
    .replace(/[`*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/**
 * What a placeholder shows in place of its turn, so a turn the window has not rendered yet reads as text instead of a
 * blank: the turn's first prompt and the start of its last reply, flattened to plain words. Either is empty for a turn
 * with no such text.
 */
export const turnPreview = memoByObject((turn: TurnState): { prompt: string; reply: string } => {
  let prompt = '';
  let reply = '';
  for (const item of turn.items) {
    if (item.type === 'userMessage' && !prompt) prompt = flatten(promptText(item), PREVIEW_PROMPT);
    else if (item.type === 'agentMessage') reply = flatten(replyText(item, turn.status === 'inProgress'), PREVIEW_REPLY) || reply;
  }
  return { prompt, reply };
});

/**
 * The turns to render before the transcript reports what is on screen: a chat opens at its bottom, so the last turns
 * whose heights fill `budget` pixels, and always the last one.
 */
export function initialWindow(ids: readonly string[], heightOf: (id: string) => number, budget: number): Set<string> {
  const out = new Set<string>();
  let filled = 0;
  for (let i = ids.length - 1; i >= 0 && (filled < budget || !out.size); i--) {
    out.add(ids[i]);
    filled += heightOf(ids[i]);
  }
  return out;
}

/** `next` when it holds other ids than `previous`, else `previous`: a window that did not change keeps its identity. */
export function sameOrNext(previous: ReadonlySet<string>, next: ReadonlySet<string>): ReadonlySet<string> {
  return previous.size === next.size && [...next].every((id) => previous.has(id)) ? previous : next;
}

/**
 * The index of the first element whose bottom is below `top`, by binary search over elements in document order (their
 * tops and bottoms only grow): the first one on screen when `top` is the viewport's top. `length` when none is.
 */
export function firstBelow(length: number, bottomOf: (index: number) => number, top: number): number {
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bottomOf(mid) > top) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * How far to scroll so an anchor that sat `before` pixels below the viewport's top sits there again, now that it sits
 * `after` pixels below it. Under a pixel is left alone: it is rounding, and scrolling would stop a smooth scroll.
 */
export function anchorCorrection(before: number, after: number): number {
  const shift = after - before;
  return Math.abs(shift) < 1 ? 0 : shift;
}

/**
 * Which navigation entries are on screen, from their anchors' tops in document order: an entry runs from its prompt
 * to the next prompt (the last to `end`, the transcript's end), and it counts once more than `inset` of it reaches
 * below the viewport's `top`, until its prompt is below the viewport's `bottom`. Reads only the tops it needs.
 */
export function visibleEntries(
  length: number,
  topOf: (index: number) => number,
  view: { top: number; bottom: number; end: number },
  inset: number,
): number[] {
  const line = view.top + inset;
  // the first prompt below the line: the entry before it is on screen up to it
  const first = firstBelow(length, topOf, line);
  const out: number[] = [];
  if (first > 0 && (first < length || view.end > line)) out.push(first - 1);
  for (let i = first; i < length && topOf(i) < view.bottom; i++) out.push(i);
  return out;
}
