// A long block of text folded to a fixed height with a fade and "Show more", as Claude Desktop folds a long prompt.

import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** Text taller than this folds behind "Show more" (Claude Desktop's 300 px threshold less 100). */
export const FOLD_CLAMP_PX = 200;

/**
 * `text` is what is measured and `children` what is drawn (the text with its links, say); it sits inside the caller's
 * bubble. The measure runs again when `text` changes and whenever the text's box resizes: a bubble mounted hidden (a pane
 * tab behind another) measures once it shows, and one in a column that narrows or widens folds or unfolds with it.
 */
export function FoldedText({ text, children = text, clamp = FOLD_CLAMP_PX }: { text: string; children?: ReactNode; clamp?: number }) {
  const body = useRef<HTMLDivElement>(null);
  const [tall, setTall] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    const el = body.current!;
    // nothing to fold in an empty text; `text` is also what makes a changed text measure again
    const measure = () => setTall(text !== '' && el.scrollHeight > clamp);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text, clamp]);
  const folded = tall && !expanded;
  return (
    <>
      <div ref={body} className={folded ? 'fold-text clamped' : 'fold-text'} style={folded ? { maxHeight: clamp } : undefined}>
        {children}
      </div>
      {tall && (
        <button className="fold-more" aria-expanded={expanded} onClick={() => setExpanded((e) => !e)}>
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}
    </>
  );
}
