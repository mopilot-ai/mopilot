// Wrap the words of a streaming run's rendered Markdown in <span class="fw"> fade spans, staggered within each reveal step.

// The reveal shows a reply in steps (textPacer.ts); each step's words fade in one after another, a few ms apart,
// as Claude Desktop's do. A word belongs to the step that revealed it, found by its source offset, so the split
// is the same for Latin text and for CJK text without spaces: a step's text is its own span even mid-sentence.
// Spans keep their position as the text grows (new words and new steps are appended), so React reuses the ones
// already on screen. A span that mounts again anyway keeps its moment (stepFade.ts) and does not fade from the
// start. Offsets only place fades: the tree's structure and text are never changed.

import { fadeDelayMs } from './textPacer';

type Node = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
  position?: { start: { offset?: number }; end: { offset?: number } };
};

/** Elements whose text is not prose: code is shown as a block, math is laid out by KaTeX. */
const SKIP = new Set(['code', 'pre', 'svg', 'math', 'annotation', 'style', 'script']);

function skipped(el: Node) {
  if (el.tagName && SKIP.has(el.tagName)) return true;
  const cls = el.properties?.className;
  return Array.isArray(cls) && cls.some((c) => typeof c === 'string' && c.startsWith('katex'));
}

/** A word with the whitespace after it (and any before the first one). */
const WORD = /(?:^\s+)?\S+\s*/g;

/** The step that revealed `offset`: the last one starting at or before it (steps are ascending), or -1. */
function stepOf(steps: readonly number[], offset: number) {
  let step = -1;
  for (let i = 0; i < steps.length && steps[i] <= offset; i++) step = i;
  return step;
}

function span(value: string, delay: number, stepTime: number | undefined): Node {
  const properties: Record<string, unknown> = { className: ['fw'] };
  // a step with a time fades on the timeline (stepFade.ts); text no step revealed fades by CSS as it mounts
  if (stepTime !== undefined && Number.isFinite(stepTime)) properties['data-fade-at'] = Math.round(stepTime + delay);
  else if (delay > 0) properties.style = `animation-delay:${delay}ms`;
  return { type: 'element', tagName: 'span', properties, children: [{ type: 'text', value }] };
}

/** The fade spans for a text node whose source starts at `start`, split where a step starts and between words. */
function wrap(value: string, start: number, end: number, steps: readonly number[], times: readonly number[]): Node[] {
  // a node whose source differs in length from its text (escapes, entities) places steps proportionally
  const ratio = end - start > 0 && end - start !== value.length ? value.length / (end - start) : 1;
  const cuts = [0];
  for (const s of steps) if (s > start && s < end) cuts.push(Math.round((s - start) * ratio));
  cuts.push(value.length);
  const out: Node[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const piece = value.slice(cuts[i], cuts[i + 1]);
    if (!piece) continue;
    if (!/\S/.test(piece)) {
      out.push({ type: 'text', value: piece });
      continue;
    }
    for (const m of piece.matchAll(WORD)) {
      const at = start + Math.round((cuts[i] + m.index) / ratio);
      const step = stepOf(steps, at);
      // text no step revealed does not wait
      out.push(span(m[0], step === -1 ? 0 : fadeDelayMs(at - steps[step]), times[step]));
    }
  }
  return out;
}

/**
 * Wrap the prose words of a run in fade spans. `steps` are where each reveal step started, as offsets into the
 * run's source (a step that started before the run is at 0 or below), and `times` when each showed on the document
 * timeline: a word's span then names the moment its fade begins, so the same word mounted again fades the same.
 */
export function rehypeWords({ steps = [] as readonly number[], times = [] as readonly number[] } = {}) {
  return (tree: Node) => {
    // remark-breaks' split text has no position: it takes up where the node before it ended
    let cursor = 0;
    const walk = (node: Node) => {
      if (!node.children) return;
      const next: Node[] = [];
      for (const child of node.children) {
        const at = child.position?.start.offset;
        if (child.type === 'text' && child.value) {
          const start = at ?? cursor;
          const end = child.position?.end.offset ?? start + child.value.length;
          cursor = end;
          next.push(...wrap(child.value, start, end, steps, times));
          continue;
        }
        if (at !== undefined) cursor = at;
        if (child.type === 'element' && !skipped(child)) walk(child);
        else if (child.type === 'root') walk(child);
        const end = child.position?.end.offset;
        if (end !== undefined) cursor = end;
        next.push(child);
      }
      node.children = next;
    };
    walk(tree);
  };
}
