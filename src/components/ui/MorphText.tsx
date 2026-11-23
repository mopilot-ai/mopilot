// A live label that crossfades when it changes: the old text leaves upward, the new one rises in and the width glides.
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';

/** How long the crossfade and the width glide take (Claude Desktop's MorphText). */
export const MORPH_MS = 180;

interface Layer {
  key: string;
  node: ReactNode;
}

/**
 * Shows `children`; when `morphKey` changes the previous content exits (fade, 3 px up) while the new content
 * enters from 3 px below and the box glides from the old width to the new one. The first render does not
 * animate, and a change of content under the same key just updates in place. Reduced motion turns it off in CSS.
 */
export function MorphText({ morphKey, children, className = '' }: { morphKey: string; children: ReactNode; className?: string }) {
  const [current, setCurrent] = useState<Layer>({ key: morphKey, node: children });
  const [leaving, setLeaving] = useState<Layer | null>(null);
  const [entering, setEntering] = useState(false);
  const [width, setWidth] = useState<number | null>(null);
  const box = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const settledWidth = useRef(0);

  if (morphKey !== current.key) {
    setLeaving(current);
    setCurrent({ key: morphKey, node: children });
    setEntering(true);
  } else if (children !== current.node) setCurrent({ key: morphKey, node: children });

  useLayoutEffect(() => {
    if (!leaving) settledWidth.current = box.current!.offsetWidth;
  });

  useLayoutEffect(() => {
    if (!entering || !leaving) return;
    // start from the old width, then glide to the new text's width on the next frame
    setWidth(settledWidth.current);
    const f = requestAnimationFrame(() => setWidth(inner.current!.offsetWidth));
    const t = setTimeout(() => {
      setEntering(false);
      setLeaving(null);
      setWidth(null);
    }, MORPH_MS);
    return () => {
      cancelAnimationFrame(f);
      clearTimeout(t);
    };
  }, [entering, leaving]);

  return (
    <span ref={box} className={`morph-text ${className}`} style={width === null ? undefined : { width }}>
      {leaving && (
        <span key={`out-${leaving.key}`} className="morph-layer morph-out" aria-hidden>
          {leaving.node}
        </span>
      )}
      <span key={`in-${current.key}`} ref={inner} className={`morph-layer${entering ? ' morph-enter' : ''}`}>
        {current.node}
      </span>
    </span>
  );
}
