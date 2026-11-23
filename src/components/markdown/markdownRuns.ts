// A streaming reply's Markdown split into runs of closed blocks, with the tail parsed once per frame and long runs without word spans.

import { useEffect, useRef } from 'react';
import { unified, type Processor } from 'unified';
import remarkParse from 'remark-parse';
import { remarkPlugins } from '../../lib/markdownMath';
import { closedBlocks, type MarkdownTree } from '../../lib/markdownBlocks';

/** Parses text into its top-level blocks with the same remark plugins the view renders with. */
const blockParser = unified()
  .use(remarkParse)
  .use([...remarkPlugins])
  .freeze();

/** The tail's parse, for the run that renders the same text: a streaming frame then parses its tail once, not twice. */
let tailParse: { text: string; tree: ReturnType<typeof blockParser.parse> } | null = null;

/**
 * Splitting reads only the tree's top-level blocks, which the plugins' transforms (line breaks) do not change, so it
 * needs the parse alone. The tree is kept for the view, which transforms it: it is handed out once.
 */
function parseBlocks(text: string) {
  const tree = blockParser.parse(text);
  tailParse = { text, tree };
  return tree as MarkdownTree;
}

/** What a commit did not take of the tail's parse is stale: let it go rather than keep a tree of the tail alive. */
function releaseTailParse() {
  tailParse = null;
}

/** Makes the view's processor take the tail's parse for the same text instead of parsing it again. */
function reuseTailParse(this: Processor) {
  const parse = this.parser!;
  this.parser = (doc, file) => {
    if (tailParse?.text !== doc) return parse(doc, file);
    const { tree } = tailParse;
    tailParse = null;
    return tree;
  };
}

/** The remark plugins the view renders a run with. */
export const viewRemarkPlugins = [...remarkPlugins, reuseTailParse];

/**
 * A streaming run longer than this renders its words without fade spans from then on: every frame renders the run
 * again, and a span per word costs more than its fade is worth (a 4 kB paragraph's spans cost about 4 ms a frame).
 */
export const WORD_SPAN_LIMIT = 2000;

interface StreamedSegments {
  /** The source this reply last rendered, so the next render can tell how much of it is already on screen. */
  text: string;
  /** How much of the reply is on screen: a block starting below this has rendered and must not move run. */
  shown: number;
  /** The source up to the last boundary found, which every later text of this reply must start with. */
  base: string;
  /** Where each run after the first starts. */
  cuts: number[];
  /** A definition makes the whole reply one run: it applies to links anywhere in it. */
  whole: boolean;
  /** Whether this reply has streamed while on screen; it keeps its runs once it finishes. */
  streamed: boolean;
  /** Where each run starts that outgrew WORD_SPAN_LIMIT while it streamed: it keeps rendering without word spans. */
  plain: Set<number>;
}

export interface Segment {
  start: number;
  text: string;
  /** Whether the run may wrap its words in fade spans. */
  words: boolean;
}

/**
 * A streaming reply's runs of closed blocks and the tail after them. Only the tail re-parses as text arrives: before
 * each render the tail is parsed for the boundaries it closed, and the runs are cut there first, except behind what
 * has already rendered, which stays where it is. A reply that streamed
 * keeps its runs once it finishes (they render the same HTML as one parse, without remounting what is on screen);
 * a reply that never streamed here, such as history, is one run.
 */
export function useStreamedSegments(source: string, streaming: boolean): Segment[] {
  const state = useRef<StreamedSegments>({
    text: '',
    shown: 0,
    base: '',
    cuts: [],
    whole: false,
    streamed: false,
    plain: new Set(),
  }).current;
  useEffect(releaseTailParse);
  if (streaming) state.streamed = true;
  if (source !== state.text) {
    // text the reply shows less of than before (it was re-paced) has that much on screen, not what it had
    state.shown = Math.min(state.text.length, source.length);
    state.text = source;
  }
  // text that no longer extends what was split (a rewrite, or a late directive or math rewrite) starts again, and so
  // does what is on screen: the rewritten text is split from the start, so none of its blocks has rendered yet
  // (a run that went plain stays plain: the runs found again start where they did, and one whose text did not change
  // would fade all its words in again)
  if (!source.startsWith(state.base)) Object.assign(state, { base: '', cuts: [], whole: false, shown: 0 });
  // While it streams, the tail is split before it renders, so every block renders first in the run it stays in: text
  // that brings several blocks at once (a window in the background, batched deltas) never remounts them later (#1221).
  if (streaming && !state.whole) {
    const start = state.cuts.at(-1) ?? 0;
    const tail = source.slice(start);
    const closed = closedBlocks(tail, parseBlocks(tail));
    if (closed === null) state.whole = true;
    else {
      // A block whose first line could still continue the one above it (a list or indented code) closes only once
      // that line is complete, a render after it first appeared. Cutting there then would move a block that is on
      // screen into a run of its own, remounting it: take only the boundaries in the text this render adds.
      const fresh = closed.filter((cut) => start + cut >= state.shown);
      if (fresh.length) {
        state.cuts.push(...fresh.map((cut) => start + cut));
        state.base += tail.slice(0, fresh[fresh.length - 1]);
      }
    }
  }
  const starts = !state.streamed || state.whole ? [0] : [0, ...state.cuts];
  // A run keeps its start, so a run that went plain stays plain: putting its spans back would fade it all in again.
  const last = starts[starts.length - 1];
  if (streaming && source.length - last > WORD_SPAN_LIMIT) state.plain.add(last);
  return starts.map((start, i) => ({ start, text: source.slice(start, starts[i + 1]), words: !state.plain.has(start) }));
}
