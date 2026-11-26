// Colors recognized /command and $skill tokens in the composer through the shared CSS highlight, and keeps them colored across an IME composition.

import { useLayoutEffect, useRef, type RefObject } from 'react';
import { editorTextRanges } from '../../lib/composerEditorDocument';

const NAME = 'composer-slash-command';

type Span = { start: number; end: number };
/** A range in the shared highlight and the token text it was created for. */
type Held = { range: Range; text: string };

/** Remove only these ranges: other mounted composers keep theirs in the same named entry. */
function release(held: readonly Held[]) {
  const highlights = globalThis.CSS?.highlights;
  const highlight = highlights?.get(NAME);
  if (!highlight) return;
  for (const { range } of held) highlight.delete(range);
  if (!highlight.size) highlights.delete(NAME);
}

/**
 * Color the command's text without touching the editable DOM or its undo history.
 * While an input method composes, the draft is not synced, so offsets cannot be recomputed. The ranges built for the committed
 * draft stay (DOM ranges are live), and `revalidate` drops any that were detached or whose text is no longer its token. They are rebuilt when the composition ends.
 * A draft sync or a catalog change during a composition retires the held ranges until it ends, because offsets cannot be recomputed against the un-synced DOM.
 */
export function useCommandHighlight(
  elRef: RefObject<HTMLElement | null>,
  rendered: RefObject<string>,
  signature: string,
  spans: readonly Span[],
  composing: boolean,
) {
  const live = useRef<Held[]>([]);
  const builtFor = useRef<{ spans: readonly Span[]; signature: string } | null>(null);
  useLayoutEffect(() => {
    if (composing && builtFor.current?.spans === spans && builtFor.current.signature === signature) return;
    release(live.current);
    live.current = [];
    builtFor.current = null;
    const el = elRef.current;
    const highlights = globalThis.CSS?.highlights;
    if (composing || !el || rendered.current !== signature || !spans.length || !highlights) return;
    const ranges = editorTextRanges(el, spans);
    const highlight = highlights.get(NAME) ?? new Highlight();
    for (const range of ranges) highlight.add(range);
    highlights.set(NAME, highlight);
    live.current = ranges.map((range) => ({ range, text: String(range) }));
    builtFor.current = { spans, signature };
  }, [elRef, rendered, spans, composing, signature]);
  useLayoutEffect(() => () => release(live.current), []);
  return () => {
    const stale = live.current.filter(({ range, text }) => !range.startContainer.isConnected || String(range) !== text);
    if (!stale.length) return;
    release(stale);
    live.current = live.current.filter((held) => !stale.includes(held));
  };
}
