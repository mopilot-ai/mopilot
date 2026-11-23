// The newest blocks of a chat's transcript are what is mounted; older ones the reader already holds are revealed a page at a time as they scroll up.
import { useCallback, useRef, useState } from 'react';
import type { Block } from '../presentation/toolRuns';

/** How many blocks are mounted when a chat opens, and how many more one reveal adds. */
export const WINDOW = 120;

/** The window has been opened to the first block: whatever joins above it later (a page from the computer) is shown. */
export const ALL = '*';

/** The key a block is known by in the list. */
export const blockKey = (block: Block) => (block.type === 'run' ? `run:${block.key}` : block.row.key);

/**
 * Where the mounted blocks start. The first block shown is remembered by key, so the window grows with the chat at its end and
 * nothing falls off its top while a reply streams; when that block is gone (rows replaced by a new read) it starts again from the end.
 */
export function windowStart(blocks: readonly Block[], anchor: string | null, size = WINDOW): { from: number; anchor: string | null } {
  const fresh = Math.max(0, blocks.length - size);
  if (anchor === ALL) return { from: 0, anchor };
  if (anchor === null) return { from: fresh, anchor: fresh > 0 ? blockKey(blocks[fresh]) : null };
  const at = blocks.findIndex((block) => blockKey(block) === anchor);
  return at >= 0 ? { from: at, anchor } : { from: fresh, anchor: fresh > 0 ? blockKey(blocks[fresh]) : null };
}

/** `reset` changes when another chat is opened: the window starts again at its end. */
export function useBlockWindow(blocks: Block[], reset: string) {
  const anchor = useRef<string | null>(null);
  const seen = useRef(reset);
  const [, setRevealed] = useState(0);
  if (seen.current !== reset) {
    seen.current = reset;
    anchor.current = null;
  }
  const start = windowStart(blocks, anchor.current);
  anchor.current = start.anchor;
  const from = start.from;
  const reveal = useCallback(() => {
    // a page more of what is held, from the first block shown
    const page = windowStart(blocks.slice(0, from), null);
    anchor.current = page.anchor ?? ALL;
    setRevealed((n) => n + 1);
  }, [blocks, from]);
  return { shown: from === 0 ? blocks : blocks.slice(from), hidden: from, reveal };
}
