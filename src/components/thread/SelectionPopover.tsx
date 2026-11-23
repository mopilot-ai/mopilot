// Positions selection actions and annotation comments inside their transcript, using the popup's actual size.

import { useLayoutEffect, useState, type CSSProperties, type ReactNode, type RefObject } from 'react';

export function selectionPopoverPosition(rect: DOMRect, bounds: DOMRect, height: number): CSSProperties {
  const left = Math.max(0, bounds.left) + 8;
  const right = Math.min(window.innerWidth, bounds.right) - 8;
  const top = Math.max(0, bounds.top) + 8;
  const bottom = Math.min(window.innerHeight, bounds.bottom) - 8;
  const maxHeight = Math.max(0, bottom - top);
  const visibleHeight = Math.min(height, maxHeight);
  const center = rect.left + rect.width / 2;
  const above = rect.top - 8 - visibleHeight >= top;
  return {
    left: center,
    top: above ? Math.min(rect.top - 8, bottom) : Math.max(top, Math.min(rect.bottom + 8, bottom - visibleHeight)),
    maxWidth: Math.max(0, right - left),
    maxHeight,
    transform: `translateX(clamp(${left - center}px, -50%, calc(${right - center}px - 100%)))${above ? ' translateY(-100%)' : ''}`,
  };
}

export function SelectionPopover({
  rect,
  containerRef,
  surfaceRef,
  className = '',
  children,
}: {
  rect: DOMRect;
  containerRef: RefObject<HTMLElement | null>;
  surfaceRef: RefObject<HTMLDivElement | null>;
  className?: string;
  children: ReactNode;
}) {
  const [style, setStyle] = useState<CSSProperties>({ opacity: 0 });
  useLayoutEffect(() => {
    const element = surfaceRef.current;
    const container = containerRef.current;
    if (!element || !container) return;
    const place = () => {
      const next = selectionPopoverPosition(rect, container.getBoundingClientRect(), element.getBoundingClientRect().height);
      setStyle((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    };
    place();
    const resize = new ResizeObserver(place);
    resize.observe(element);
    resize.observe(container);
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      resize.disconnect();
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [rect, containerRef, surfaceRef]);
  return (
    <div ref={surfaceRef} className={`selection-toolbar ${className}`} style={style}>
      {children}
    </div>
  );
}
