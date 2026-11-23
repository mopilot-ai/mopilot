// A reply's prose as the styled runs of one native text view (#4837): which top-level blocks can share one view (paragraphs, headings and lists of paragraphs), and the runs that draw them with the sizes, spacing and indents the React Native renderer uses.
import { typo, typoHeading } from '../typography';

type Node = {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  children?: Node[];
};

/** One styled stretch: `t` its text, and as strings `fs` size, `lh` line height, `col` and `bg` colours (#rrggbb), `b` `i` `c` `d` flags, `u` a link's URL, `ps` the space after its paragraph, `hi` and `fh` its head and first-line indents. */
export type ProseRun = {
  t: string;
  fs: string;
  lh: string;
  col: string;
  bg?: string;
  b?: '1';
  i?: '1';
  c?: '1';
  /** an inline code run's size, as a string: the footnote size at the system text scale, as the React renderer sets it */
  cs?: string;
  d?: '1';
  u?: string;
  ps?: string;
  hi?: string;
  fh?: string;
  /** the paragraph's alignment: `c` centred, `r` right (left when absent): a table column's */
  al?: 'c' | 'r';
};

/** `mark` is the colour of a list's bullet or number (the React list draws it softer than the text); it is the ink where it is not given. */
export type ProseColors = { ink: string; link: string; codeBg: string; mark?: string };

/** The space between blocks of a reply, and between the items of a list, as the React Native renderer lays them (Markdown.tsx). */
export const BLOCK_GAP = 12;
export const ITEM_GAP = 4;
/** How far a list's text is indented per level: the bullet or number and its space. */
export const LIST_INDENT = 20;
/** A line break inside a paragraph (U+2028): TextKit keeps it in the paragraph, as a "\n" would end it. */
export const LINE_BREAK = '\u2028';

/** Whether a list can be one run: each item holds paragraphs (and lists of the same kind), nothing else. */
const plainList = (node: Node): boolean =>
  node.children!.every((item) =>
    item.children!.every((child) => child.type === 'paragraph' || (child.type === 'list' && plainList(child))),
  );

/** Whether a top-level block is drawn inside a native text run: paragraphs, headings and lists of paragraphs. The rest (code, tables, quotes, rules, raw html) keep their own views. */
export const inRun = (node: Node): boolean =>
  node.type === 'paragraph' || node.type === 'heading' || (node.type === 'list' && plainList(node));

/** The blocks in order, with each stretch of consecutive run blocks grouped: `{ run: [...] }`, and a block of its own as `{ block }`. */
export function groupRuns<T extends Node>(blocks: T[]): ({ run: T[] } | { block: T })[] {
  const out: ({ run: T[] } | { block: T })[] = [];
  for (const block of blocks) {
    const last = out.at(-1);
    if (inRun(block)) {
      if (last && 'run' in last) last.run.push(block);
      else out.push({ run: [block] });
    } else out.push({ block });
  }
  return out;
}

type Marks = { b?: '1'; i?: '1'; c?: '1'; d?: '1'; u?: string };
type Frame = { fs: string; lh: string; heavy: boolean; ps: string; cs: string; hi?: string; fh?: string };

/** The inline content of a paragraph or heading as runs, each carrying the paragraph's frame and the marks around it. */
function inline(nodes: Node[], marks: Marks, frame: Frame, colors: ProseColors, out: ProseRun[]) {
  for (const node of nodes) {
    const run = (t: string, extra: Marks = {}): ProseRun => {
      const m = { ...marks, ...extra };
      return {
        t,
        fs: frame.fs,
        // a line of inline code only is as tall as the code's own line height, as React Native draws it
        lh: m.c ? String((typo.footnote.lineHeight! * Number(frame.cs)) / typo.footnote.fontSize!) : frame.lh,
        col: m.u ? colors.link : colors.ink,
        ...(m.c && { bg: colors.codeBg }),
        ...((m.b || frame.heavy) && { b: '1' as const }),
        ...(m.i && { i: '1' as const }),
        ...(m.c && { c: '1' as const, cs: frame.cs }),
        ...(m.d && { d: '1' as const }),
        ...(m.u && { u: m.u }),
        ps: frame.ps,
        ...(frame.hi && { hi: frame.hi }),
        ...(frame.fh && { fh: frame.fh }),
      };
    };
    // a line break inside a paragraph is a line separator, not a new paragraph: a new one would take the paragraph's spacing and first-line indent again
    if (node.type === 'text' || node.type === 'html') out.push(run(node.value!.replace(/\n/g, LINE_BREAK)));
    else if (node.type === 'break') out.push(run(LINE_BREAK));
    else if (node.type === 'inlineCode') out.push(run(node.value!, { c: '1' }));
    else if (node.type === 'strong') inline(node.children!, { ...marks, b: '1' }, frame, colors, out);
    else if (node.type === 'emphasis') inline(node.children!, { ...marks, i: '1' }, frame, colors, out);
    else if (node.type === 'delete') inline(node.children!, { ...marks, d: '1' }, frame, colors, out);
    else if (node.type === 'link') inline(node.children!, { ...marks, u: node.url! }, frame, colors, out);
    // an image reads as its description; anything else inline (a reference link, a deletion) as the text it holds
    else if (node.type === 'image' || node.type === 'imageReference') out.push(run(node.alt || ''));
    else inline(node.children!, marks, frame, colors, out);
  }
}

/**
 * A line break before a line of another height (a line of inline code after text, a first line that is the code's own) ends its paragraph, as
 * React Native's "\n" does: TextKit takes a paragraph's line height from its first character, so a separator would draw the code's line at the
 * text's height. The paragraph that ends has no space after it (the block's space comes after the last one), and the one that starts is indented
 * where the item's text is, not where its mark is.
 */
function splitAtHeights(runs: ProseRun[], frame: Frame): ProseRun[] {
  const out = runs.map((run) => ({ ...run }));
  let first = 0;
  out.forEach((run, i) => {
    const next = out[i + 1];
    if (!next || !run.t.endsWith(LINE_BREAK) || next.lh === out[first].lh) return;
    run.t = `${run.t.slice(0, -1)}\n`;
    for (let k = first; k <= i; k++) out[k].ps = '0';
    first = i + 1;
    if (frame.hi) next.fh = frame.hi;
  });
  return out;
}

/** One paragraph's runs, closed by its line break (the last paragraph of a run has none), with `ps` the space after it; `lead` is a list item's mark. */
function paragraph(children: Node[], frame: Frame, colors: ProseColors, last: boolean, lead: ProseRun[] = []): ProseRun[] {
  const body: ProseRun[] = [];
  inline(children, {}, frame, colors, body);
  const out = splitAtHeights([...lead, ...body], frame);
  if (!last)
    out.push({
      t: '\n',
      fs: frame.fs,
      // the break takes the height of the line it ends: a line of inline code only is not made taller by it
      lh: [{ lh: frame.lh }, ...out].at(-1)!.lh,
      col: colors.ink,
      ps: frame.ps,
      ...(frame.hi && { hi: frame.hi }),
      ...(frame.fh && { fh: frame.fh }),
    });
  return out;
}

/** A list's items as paragraphs led by their mark ("•" or "3."), indented one level further for each list inside another. */
function list(
  node: Node,
  level: number,
  base: { fs: number; lh: number },
  colors: ProseColors,
  gapAfter: number,
  last: boolean,
): ProseRun[] {
  const out: ProseRun[] = [];
  const items = node.children!;
  items.forEach((item, n) => {
    const lastItem = n === items.length - 1;
    const hi = LIST_INDENT * (level + 1);
    const frame: Frame = {
      fs: String(base.fs),
      cs: String((typo.footnote.fontSize! * base.fs) / typo.reply.fontSize!),
      lh: String(base.lh),
      heavy: false,
      ps: String(ITEM_GAP),
      hi: String(hi),
      fh: String(hi - LIST_INDENT),
    };
    const mark = node.ordered ? `${node.start! + n}.` : '•';
    const paragraphs = item.children!.filter((child) => child.type === 'paragraph');
    const nested = item.children!.filter((child) => child.type === 'list');
    // an item with nothing in it is its mark alone on a line, as the React renderer draws it (not left out, with the item after it taking its place)
    if (paragraphs.length === 0 && nested.length === 0) {
      const ps = String(lastItem ? gapAfter : ITEM_GAP);
      const bullet: ProseRun = {
        t: `${mark}\t`,
        fs: frame.fs,
        lh: frame.lh,
        col: colors.mark ?? colors.ink,
        ps,
        hi: frame.hi,
        fh: frame.fh,
      };
      out.push(bullet);
      if (!(lastItem && last)) out.push({ ...bullet, t: '\n' });
      return;
    }
    paragraphs.forEach((child, k) => {
      const lastHere = lastItem && last && k === paragraphs.length - 1 && nested.length === 0;
      // the space after a paragraph of an item: the list's gap after its last paragraph, an item's gap otherwise
      const ps = String(lastItem && k === paragraphs.length - 1 && nested.length === 0 ? gapAfter : ITEM_GAP);
      // a paragraph after the first of an item has no mark: its first line sits where the item's text does
      const own = { ...frame, ps, ...(k > 0 && { fh: frame.hi }) };
      const lead: ProseRun[] =
        k === 0 ? [{ t: `${mark}\t`, fs: own.fs, lh: own.lh, col: colors.mark ?? colors.ink, ps, hi: own.hi, fh: own.fh }] : [];
      out.push(...paragraph(child.children!, own, colors, lastHere, lead));
    });
    nested.forEach((child, k) =>
      out.push(...list(child, level + 1, base, colors, lastItem ? gapAfter : ITEM_GAP, lastItem && last && k === nested.length - 1)),
    );
  });
  return out;
}

/**
 * The runs of consecutive run blocks (see `inRun`): body text at the reply's size and line height (`scale` is the system text scale, which
 * React Native applies to both), headings at their own, lists indented, blocks a gap apart. No run after the last block ends in a line break.
 */
export function proseRuns(blocks: Node[], colors: ProseColors, scale = 1): ProseRun[] {
  const body = { fs: typo.reply.fontSize! * scale, lh: typo.reply.lineHeight! * scale };
  const out: ProseRun[] = [];
  blocks.forEach((block, n) => {
    const last = n === blocks.length - 1;
    if (block.type === 'list') {
      out.push(...list(block, 0, body, colors, BLOCK_GAP, last));
      return;
    }
    const heading = block.type === 'heading' ? typoHeading[block.depth!] : null;
    const frame: Frame = {
      fs: String((heading?.fontSize ?? typo.reply.fontSize!) * scale),
      cs: String(typo.footnote.fontSize! * scale),
      lh: String((heading?.lineHeight ?? typo.reply.lineHeight!) * scale),
      heavy: heading !== null,
      ps: String(BLOCK_GAP),
    };
    out.push(...paragraph(block.children!, frame, colors, last));
  });
  return out;
}

/** A table cell's runs: the footnote size the React cell draws, semibold in the header, aligned as its column says, no space after it. */
export function cellRuns(
  cell: Node,
  header: boolean,
  align: 'left' | 'right' | 'center' | null | undefined,
  colors: ProseColors,
  scale = 1,
): ProseRun[] {
  const size = String(typo.footnote.fontSize! * scale);
  const frame: Frame = { fs: size, lh: String(typo.footnote.lineHeight! * scale), cs: size, heavy: header, ps: '0' };
  const out: ProseRun[] = [];
  inline(cell.children!, {}, frame, colors, out);
  const al = align === 'center' ? 'c' : align === 'right' ? 'r' : undefined;
  return al ? out.map((run) => ({ ...run, al })) : out;
}
