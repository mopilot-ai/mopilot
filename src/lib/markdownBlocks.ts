// Where streamed Markdown can be split (the top-level blocks a parse has already closed), and whether its last code block can still grow.

/** The part of a parsed Markdown tree (mdast) this reads: each node's type, children and source offsets. */
export interface MarkdownTree {
  type: string;
  children?: MarkdownTree[];
  position?: { start: { offset?: number }; end: { offset?: number } };
}

/** Nodes whose meaning reaches across blocks: a definition applies to links and footnote marks anywhere in the text. */
const DOCUMENT_WIDE = new Set(['definition', 'footnoteDefinition']);

/** After a blank line, only these blocks can take in the next line: a list (an item or its indented text) and indented code. */
const CONTINUES = new Set(['list', 'code']);
/** A line starting with one of these could still turn into a list item or indented text that continues such a block. */
const MAY_CONTINUE = /^[\s\d*+-]/;

/**
 * The offsets in `text` where a top-level block starts that closed the block before it for good, given the parse
 * `tree` of `text`: text parsed from there on its own renders as it does inside the whole text. A block counts once
 * its first line is complete, or as soon as it starts after a blank line unless the block above is a list or code and
 * the line starts with a character that could still continue it (an indent, a digit or a list bullet). Cutting at once
 * keeps a block in the run it started in, so it never remounts. Null when the text holds a definition, which only a
 * parse of the whole text applies.
 */
export function closedBlocks(text: string, tree: MarkdownTree): number[] | null {
  if (hasDefinition(tree)) return null;
  const blocks = tree.children ?? [];
  const cuts: number[] = [];
  for (let i = 1; i < blocks.length; i++) {
    const start = blocks[i].position?.start.offset;
    const previousEnd = blocks[i - 1].position?.end.offset;
    if (start === undefined || previousEnd === undefined) continue;
    const line = text.lastIndexOf('\n', start - 1) + 1;
    const complete = text.indexOf('\n', start) >= 0;
    const afterBlank = text.slice(previousEnd, line).split('\n').length > 2;
    const mayContinue = CONTINUES.has(blocks[i - 1].type) && MAY_CONTINUE.test(text.slice(line, line + 1));
    if (complete || (afterBlank && !mayContinue)) cuts.push(line);
  }
  return cuts;
}

function hasDefinition(node: MarkdownTree): boolean {
  return DOCUMENT_WIDE.has(node.type) || (node.children ?? []).some(hasDefinition);
}

/** A fence's opening line: at most three spaces (more is indented code), then three or more backticks or tildes. */
const OPENING_FENCE = /^ {0,3}(`{3,}|~{3,})/;
/** A line that only holds a fence, after any container marks (a quote's `>`, a list item's indent). */
const CLOSING_FENCE = /^[ \t>]*(`{3,}|~{3,})[ \t]*$/;

/**
 * Whether the code block at `at` in `text`, the text of a run whose last block may still grow, can still grow: it
 * reaches the end of the text, and it is not a fenced block whose closing fence has arrived. A block without source
 * offsets cannot be placed, and is taken as complete.
 */
export function codeMayGrow(text: string, at: MarkdownTree['position']): boolean {
  const start = at?.start.offset;
  const end = at?.end.offset;
  if (start === undefined || end === undefined || text.slice(end).trim()) return false;
  const firstEnd = text.indexOf('\n', start);
  // indented code, or a fence with no line after its opening yet
  const open = firstEnd >= 0 && firstEnd < end ? OPENING_FENCE.exec(text.slice(start, firstEnd)) : null;
  if (!open) return true;
  const close = CLOSING_FENCE.exec(text.slice(text.lastIndexOf('\n', end - 1) + 1, end));
  return !(close && close[1][0] === open[1][0] && close[1].length >= open[1].length);
}
