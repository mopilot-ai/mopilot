// The newest blocks of a chat's transcript are what is mounted; older ones the reader already holds are revealed a page at a time as they scroll up.
import { useCallback, useRef, useState } from 'react';
import type { Block } from '../presentation/toolRuns';
import { perf } from '../perfLog';

/** How many blocks are mounted when a chat opens, and how many more one reveal adds. */
export const WINDOW = 120;

/** The window has been opened to the first block: whatever joins above it later (a page from the computer) is shown. */
export const ALL = '*';

/** The key a block is known by in the list. */
export const blockKey = (block: Block) => (block.type === 'run' ? `run:${block.key}` : block.row.key);

/**
 * The block an anchor names. A run of steps is known by its first step, so steps that join it from above (a page of older messages) change the
 * run's key: the anchor then names a step inside the run, and the run is still the block the window starts at.
 */
const blockAt = (blocks: readonly Block[], anchor: string) =>
  blocks.findIndex(
    (block) =>
      blockKey(block) === anchor ||
      (block.type === 'run' && anchor.startsWith('run:') && block.steps.some((step) => `run:${step.key}` === anchor)),
  );

/**
 * Where the mounted blocks start. The first block shown is remembered by key, so the window grows with the chat at its end and
 * nothing falls off its top while a reply streams; when that block is gone (rows replaced by a new read) it starts again from the end.
 */
export function windowStart(
  blocks: readonly Block[],
  anchor: string | null,
  size = WINDOW,
  previous: readonly Block[] = [],
): { from: number; anchor: string | null } {
  const fresh = Math.max(0, blocks.length - size);
  if (anchor === ALL) return { from: 0, anchor };
  if (anchor === null) return { from: fresh, anchor: fresh > 0 ? blockKey(blocks[fresh]) : null };
  const at = blockAt(blocks, anchor);
  if (at >= 0) return { from: at, anchor: blockKey(blocks[at]) };
  // the first block shown is gone (a turn folded into a run, a row replaced): the window starts at the next block that was there before, so what is above the reader
  // stays mounted and in place, and only a window with nothing left of what it showed starts again from the end (#5686)
  const before = previous.map(blockKey);
  const was = before.indexOf(anchor);
  if (was >= 0) {
    const held = new Map(blocks.map((block, index) => [blockKey(block), index] as const));
    for (const key of before.slice(was + 1)) {
      const index = held.get(key);
      if (index !== undefined) return { from: index, anchor: key };
    }
  }
  return { from: fresh, anchor: fresh > 0 ? blockKey(blocks[fresh]) : null };
}

/**
 * `reset` changes when another chat is opened: the window starts again at its end. `hold`: the blocks are the rows the chat last showed, drawn
 * whole before the Mac answers. When the Mac's rows replace them the window starts at the first saved row they still have (a row the Mac no
 * longer has, a re-keyed one or a send that was waiting is walked past), so no row a reader may be looking at falls out of the list; only when
 * none is there does it start at the newest. It holds once per chat: a chat that has shown the Mac's rows is never drawn from its saved ones again.
 */
export function useBlockWindow(blocks: Block[], reset: string, hold = false) {
  const anchor = useRef<string | null>(null);
  const saved = useRef<string[]>([]);
  const live = useRef(false);
  // the blocks the window was last worked out from (kept as they are: their keys are read only when the first block shown is gone): where a window whose first block is gone starts instead
  const before = useRef<readonly Block[]>([]);
  const seen = useRef(reset);
  const [, setRevealed] = useState(0);
  if (seen.current !== reset) {
    seen.current = reset;
    anchor.current = null;
    saved.current = [];
    live.current = false;
    before.current = [];
  }
  const holding = hold && !live.current;
  if (holding) {
    // a send still waiting for the computer is not one of the rows the Mac will have
    saved.current = blocks.filter((b) => b.type === 'run' || !b.row.optimistic).map(blockKey);
  } else {
    if (saved.current.length) {
      const have = new Set(blocks.map(blockKey));
      const first = saved.current.find((key) => have.has(key)) ?? null;
      // only a saved row above the newest WINDOW blocks needs the window held at it: one inside them is shown anyway, and the window then
      // stays at the end, so rows that join above later (the page cache's older rows) are shown as they would be on any chat
      const at = first === null ? -1 : blocks.findIndex((b) => blockKey(b) === first);
      anchor.current = at >= 0 && at < blocks.length - WINDOW ? first : null;
      saved.current = [];
    }
    live.current = true;
  }
  const start = holding ? { from: 0, anchor: saved.current[0] ?? null } : windowStart(blocks, anchor.current, WINDOW, before.current);
  anchor.current = start.anchor;
  before.current = blocks;
  const from = start.from;
  const reveal = useCallback(() => {
    // a page more of what is held, from the first block shown
    const page = windowStart(blocks.slice(0, from), null);
    anchor.current = page.anchor ?? ALL;
    // counted by the performance log (counts only), with the scrolls the chat asks for: a reveal grows the content above the reader
    perf.event('scroll-reveal');
    setRevealed((n) => n + 1);
  }, [blocks, from]);
  return { shown: from === 0 ? blocks : blocks.slice(from), hidden: from, reveal };
}
