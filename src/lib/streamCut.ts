// Where a streaming reply's paced text may end: never inside Markdown that renders differently once it closes.

// A prefix of streamed Markdown is not the Markdown of that prefix: `**bol` renders the asterisks, and the
// closing `**` then turns the shown word into a <strong>, remounting it and replaying its fade (the flicker).
// The paced reveal therefore stops only where every construct opened on the line has closed, the way Claude
// Desktop's streaming text does. Received text is never held for long: MAX_HOLD bounds what waits for a
// construct to close, and a finished reply shows everything.
// What only a later line decides still changes form, as it does in Claude Desktop: a setext underline (`===`)
// under a paragraph line, a list turned loose by a blank line and an indented block, a table header without its
// outer pipes, and a footnote's back link.

/** At most this many received characters wait for a construct to close (Claude Desktop's value). */
export const MAX_HOLD = 600;
/** A cut inside a word moves back to the word's start when that is at most this many characters back. */
export const WORD_SNAP = 24;

/** Block markers at a line's start: quotes, a heading, a list item (with a task box) or a table's pipe. */
const MARKERS = /^[ \t]*(?:>[ \t]?)*(?:#{1,6}[ \t]+|(?:[-*+]|\d{1,9}[.)])[ \t]+(?:\[[ xX]\][ \t]+)?|\|)?/;
/** A line holding only what could still become a block marker: `#`, `-`, `1.`, `>`, `- [`. */
const MARKER_ONLY = /^[ \t]*(?:>[ \t]*)*(?:#{1,6}|[-*+]|\d{1,9}[.)]?|(?:[-*+]|\d{1,9}[.)])[ \t]+\[[ xX]?\]?)?[ \t]*$/;
/** A line that may be a fence, a thematic break or a setext underline: shown once it is complete. */
const WHOLE_LINE = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(?:`{3,}[^`\n]*|~{3,}[^\n]*|`{1,2}|~{1,2}|(?:[-*_=][ \t]*)+)$/;
const FENCE_OPEN = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)?(`{3,}|~{3,})/;
const FENCE_CLOSE = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/;
const MATH_FENCE = /^[ \t>]*\$\$/;
const TABLE_ROW = /^[ \t]*(?:>[ \t]*)*\|/;
/** Scripts that put spaces between words: a word of them cut short may still grow into something else. */
const SPACED =
  /^[\p{Script=Latin}\p{Script=Cyrillic}\p{Script=Greek}\p{Script=Hangul}\p{Script=Arabic}\p{Script=Hebrew}\p{Script=Armenian}\p{Script=Georgian}\p{Script=Devanagari}\p{Script=Bengali}\p{N}\p{P}\p{S}\p{M}\u200C\u200D]+$/u;

/** A line that may be a table row: it starts with a pipe (a table without its outer pipes is a known limit). */
function tableRow(line: string) {
  return TABLE_ROW.test(line);
}

/**
 * Where the paragraph holding the line at `lineStart` starts: back over the lines it continues, to a blank line or a
 * line that starts a block (a list item, a heading, a quote, a table row, a fence). Emphasis, code spans and links
 * can run across the lines of a paragraph, not out of it.
 */
function paragraphStart(text: string, lineStart: number) {
  let start = lineStart;
  while (start > 0) {
    if (/\S/.test(lineAt(text, start).text.slice(0, markerLength(lineAt(text, start).text)))) break;
    const previous = lineAt(text, start - 1);
    if (!previous.text.trim() || FENCE_OPEN.test(previous.text) || FENCE_CLOSE.test(previous.text) || /^ {0,3}#/.test(previous.text)) break;
    start = previous.start;
  }
  return start;
}

interface Line {
  start: number;
  end: number;
  text: string;
}

/** How long the block markers at the start of `line` are (every part of MARKERS is optional: it always matches). */
function markerLength(line: string) {
  return (MARKERS.exec(line) as RegExpExecArray)[0].length;
}

function lineAt(text: string, at: number): Line {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const nl = text.indexOf('\n', start);
  const end = nl === -1 ? text.length : nl;
  return { start, end, text: text.slice(start, end) };
}

type Block = { opened: number; fence: string; math: boolean };

/** The last text's blocks: the block each line start sits in, found in one pass (a step asks for many lines). */
let blocks: { text: string; at: Map<number, Block | null> } = { text: '', at: new Map([[0, null]]) };

/** The fenced code or `$$` math block the line starting at `lineStart` sits in, or null. */
function blockAt(text: string, lineStart: number): Block | null {
  if (blocks.text !== text) blocks = { text, at: blockMap(text) };
  return blocks.at.get(lineStart) ?? null;
}

/** The block each line start of `text` sits in. */
function blockMap(text: string) {
  const map = new Map<number, Block | null>([[0, null]]);
  let open: Block | null = null;
  for (let at = 0; at < text.length; ) {
    const nl = text.indexOf('\n', at);
    const line = text.slice(at, nl === -1 ? text.length : nl);
    if (open?.math) {
      if (line.trim().endsWith('$$')) open = null;
    } else if (open) {
      const close = FENCE_CLOSE.exec(line);
      if (close && close[1][0] === open.fence[0] && close[1].length >= open.fence.length) open = null;
    } else {
      const fence = FENCE_OPEN.exec(line);
      if (fence) open = { opened: at, fence: fence[1], math: false };
      else if (MATH_FENCE.test(line) && !/\$\$.*\$\$/.test(line.trim())) open = { opened: at, fence: '$$', math: true };
    }
    if (nl === -1) break;
    at = nl + 1;
    map.set(at, open);
  }
  return map;
}

/** The end of the run of `ch` starting at `at`. */
function runEnd(s: string, at: number, ch: string) {
  let end = at;
  while (s[end] === ch) end++;
  return end;
}

/**
 * Where the earliest construct still open in `s` (a line up to the cut, from `from`) starts, or -1: a code span, `$$`
 * math, a link or image, emphasis, an autolink, an inline directive, an entity or a dangling backslash.
 */
export function openConstruct(s: string, from = 0): number {
  const emphasis = new Map<string, number>();
  let earliest = -1;
  const open = (at: number) => {
    if (earliest === -1 || at < earliest) earliest = at;
  };
  for (let i = from; i < s.length; ) {
    const ch = s[i];
    if (ch === '\\') {
      if (i + 1 >= s.length) open(i);
      if (s.startsWith('\\(', i) || s.startsWith('\\[', i)) {
        const close = s.indexOf(s[i + 1] === '(' ? '\\)' : '\\]', i + 2);
        if (close === -1) {
          open(i);
          break;
        }
        i = close + 2;
        continue;
      }
      i += 2;
      continue;
    }
    if (ch === '`' || (ch === '$' && s[i + 1] === '$')) {
      const end = runEnd(s, i, ch);
      const fence = s.slice(i, end);
      const close = s.indexOf(fence, end);
      if (close === -1) {
        open(i);
        break;
      }
      i = runEnd(s, close, ch);
      continue;
    }
    if (ch === '[' || (ch === '!' && s[i + 1] === '[')) {
      const at = i;
      const label = s.indexOf(']', ch === '!' ? i + 2 : i + 1);
      if (label === -1 || label === s.length - 1) {
        open(at);
        break;
      }
      if (s[label + 1] === '(') {
        const close = s.indexOf(')', label + 2);
        if (close === -1) {
          open(at);
          break;
        }
        i = close + 1;
        continue;
      }
      i = label + 1;
      continue;
    }
    if (ch === '<' && /[A-Za-z/!?]/.test(s[i + 1] ?? 'a')) {
      if (s.indexOf('>', i + 1) === -1) open(i);
      i++;
      continue;
    }
    if (s.startsWith(':codex-', i)) {
      if (s.indexOf('}', i) === -1) open(i);
      i++;
      continue;
    }
    if (ch === '\uE200') {
      if (s.indexOf('\uE201', i) === -1) open(i);
      i++;
      continue;
    }
    if (ch === '&' && /^&#?\w{0,10}$/.test(s.slice(i))) {
      open(i);
      break;
    }
    if (ch === '*' || ch === '_' || ch === '~') {
      const end = runEnd(s, i, ch);
      const before = s[i - 1] ?? ' ';
      const after = s[end] ?? '';
      // an opener needs text after it; `_` inside a word (snake_case) neither opens nor closes
      const intraword = ch === '_' && /\w/.test(before) && /\w/.test(after);
      // a run at the end of the text may still open: more text decides
      const canOpen = !intraword && !/\s/.test(after) && !(ch === '_' && /\w/.test(before));
      const canClose = !intraword && !/\s/.test(before) && i > from;
      const kinds = end - i >= 2 ? [ch + ch, ...(ch !== '~' && (end - i) % 2 === 1 ? [ch] : [])] : [ch];
      for (const kind of kinds) {
        if (emphasis.has(kind)) {
          if (canClose) emphasis.delete(kind);
        } else if (canOpen) emphasis.set(kind, i);
      }
      i = end;
      continue;
    }
    i++;
  }
  for (const at of emphasis.values()) open(at);
  return earliest;
}

/** Constructs whose first characters are plain text until the rest arrives. */
const STARTS = ['$$', '![', ':codex-'];

/**
 * Where a construct starting at the end of `shown` (`$` of `$$`, `!` of `![`, `:co` of `:codex-`) begins in `text`,
 * or -1: it is one when the text after the cut, as far as it has arrived, goes on into its start.
 */
function startingConstruct(text: string, shown: string, cut: number) {
  for (let at = Math.max(0, shown.length - 6); at < shown.length; at++) {
    const begun = shown.slice(at);
    const from = cut - begun.length;
    const next = text.slice(from, from + 7);
    const arrived = from + 7 >= text.length;
    if (STARTS.some((start) => start.startsWith(begun) && (next.startsWith(start) || (arrived && start.startsWith(next))))) return from;
  }
  return -1;
}

/**
 * Moves a cut inside a word back to the word's start, when the word started at most WORD_SNAP characters back and
 * not before `floor`. A word at the end of what has arrived may not be whole yet (`h` may become `https://…`, a
 * link), so it waits too. Only scripts that space their words snap: Chinese or Japanese text cuts anywhere.
 */
function snapToWord(text: string, cut: number, floor: number) {
  if (cut <= floor || /\s/.test(text[cut - 1]) || /\s/.test(text[cut] ?? 'x')) return cut;
  let start = cut - 1;
  const limit = Math.max(floor, cut - WORD_SNAP);
  while (start > limit && !/\s/.test(text[start - 1])) start--;
  // a word longer than WORD_SNAP is cut where it is
  if (start > floor && !/\s/.test(text[start - 1])) return cut;
  return SPACED.test(text.slice(start, cut)) ? start : cut;
}

/** A cut never splits a surrogate pair. */
function wholeChar(text: string, cut: number) {
  return cut > 0 && cut < text.length && (text.charCodeAt(cut) & 0xfc00) === 0xdc00 ? cut - 1 : cut;
}

/**
 * The furthest point at or before `cut` where `text` (all the reply received so far) may stop showing, so nothing
 * shown renders differently once more text arrives. Returns `from` or less when no such point is after `from`.
 * Each rule looks at the line the cut is in; a point it moves back to is checked again, so a line it holds whole
 * hands the decision to the line before it.
 */
export function safeEnd(text: string, from: number, cut: number, words = true): number {
  for (;;) {
    let end: number;
    if (cut > 0 && text[cut - 1] === '\n') {
      // a cut at a line's start ends the line before it: that line, now complete, decides
      const before = safeEnd(text, from, cut - 1, words);
      end = before === cut - 1 ? cut : before;
    } else end = lineSafeEnd(text, from, cut, words);
    if (end >= cut || end <= from) return end;
    cut = end;
  }
}

function lineSafeEnd(text: string, from: number, cut: number, words: boolean): number {
  const line = lineAt(text, cut);
  const shown = text.slice(line.start, cut);
  const complete = line.end < text.length && cut === line.end;
  const block = blockAt(text, line.start);
  if (block?.math) return block.opened;
  if (block) {
    // code shows as it grows, except a line that may yet close the fence
    if (!complete && /^[ \t>]*(`+|~+)[ \t]*$/.test(shown)) return line.start;
    return wholeChar(text, cut);
  }
  if (FENCE_OPEN.test(line.text)) return complete ? cut : line.start;
  if (!complete && (MARKER_ONLY.test(shown) || WHOLE_LINE.test(shown))) return line.start;
  if (tableRow(line.text)) {
    // a table shows once its delimiter line is in: until then its header row is a paragraph
    const previous = line.start > 0 ? lineAt(text, line.start - 1) : null;
    if (!previous || !tableRow(previous.text)) return line.start;
    const beforePrevious = previous.start > 0 ? lineAt(text, previous.start - 1) : null;
    if (!complete && (!beforePrevious || !tableRow(beforePrevious.text))) return previous.start;
  }
  const paragraph = paragraphStart(text, line.start);
  const openAt = openConstruct(text.slice(paragraph, cut), markerLength(lineAt(text, paragraph).text));
  if (openAt !== -1) {
    // a construct right after its line's markers holds the whole line, so the markers do not show alone
    const at = paragraph + openAt;
    const its = lineAt(text, at);
    return at <= its.start + markerLength(its.text) ? its.start : wholeChar(text, at);
  }
  const markers = markerLength(shown);
  const starting = startingConstruct(text, shown, cut);
  if (starting !== -1) return starting;
  // what a snapped cut leaves out may close a construct the shorter text leaves open: safeEnd checks again from there
  const end = words ? snapToWord(text, cut, Math.max(from, line.start + markers)) : cut;
  // markers with nothing after them yet (`- ` under a paragraph is a setext underline) wait with their line
  return markers && end <= line.start + markers ? line.start : wholeChar(text, end);
}

/**
 * The furthest the reveal may go in `text`: the safe end of all of it, but never more than MAX_HOLD behind
 * while a construct stays open. A finished reply passes `final` and shows everything; `words: false` shows a last
 * word that may not be whole yet.
 */
export function revealCeiling(text: string, final = false, words = true): number {
  if (final) return text.length;
  return Math.max(safeEnd(text, 0, text.length, words), text.length - MAX_HOLD);
}

/**
 * Streaming Markdown shown without pacing (reasoning, a plan): up to where nothing shown changes form when the
 * rest arrives. Its last word shows as it arrives: no step comes later to show it once whole. Finished text is
 * shown whole.
 */
export function settledText(text: string, streaming: boolean): string {
  return streaming ? text.slice(0, revealCeiling(text, false, false)) : text;
}

/**
 * Where a step that wants to show `want` characters after `from` ends: the furthest safe point at or before
 * `from + want`, or, when there is none after `from`, the furthest before the next `want` characters, and so on
 * up to `ceiling`. When no point before it is safe, the step ends `want` on, still no further than `ceiling`.
 */
export function stepEnd(text: string, from: number, want: number, ceiling: number): number {
  if (from >= ceiling) return ceiling;
  let candidate = Math.min(from + want, ceiling);
  let end = safeEnd(text, from, candidate);
  while (end <= from && candidate < ceiling) {
    candidate = Math.min(candidate + want, ceiling);
    end = safeEnd(text, from, candidate);
  }
  // nothing safe before the ceiling (a construct that never closes): go on in steps, not one jump
  return end > from ? Math.min(end, ceiling) : Math.min(ceiling, from + want);
}
