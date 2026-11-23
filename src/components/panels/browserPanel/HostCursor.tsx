// The agent's pointer drawn over a Host desktop's frame (G8 #3903): positioned from the plan main sent, on its own animation loop, only on a frame of the same display geometry version (src/lib/hostCursor.ts).
import { useEffect, useRef } from 'react';
import { useEffectOn } from '../../../lib/effects';
import { type CursorMessage, type CursorState, cursorOver, cursorView, reduceCursor } from '../../../lib/hostCursor';

/** How long the cursor waits for an animation frame before painting anyway. */
const FALLBACK_MS = 50;

export type CursorFrame = { width: number; height: number; pixelsPerPoint: number; display: { x: number; y: number }; version: number };

/** The overlay element and the function that feeds it main's cursor messages. */
export function useHostCursor(
  root: React.RefObject<HTMLElement | null>,
  image: React.RefObject<HTMLImageElement | null>,
  frame: CursorFrame | null,
) {
  const state = useRef<CursorState>(null);
  const node = useRef<HTMLDivElement>(null);
  const frameRef = useRef(frame);
  frameRef.current = frame;
  const raf = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const paint = () => {
    cancelAnimationFrame(raf.current);
    clearTimeout(timer.current);
    raf.current = 0;
    const el = node.current;
    const f = frameRef.current;
    const box = image.current?.getBoundingClientRect();
    const host = root.current?.getBoundingClientRect();
    const now = performance.now();
    const v = f && box && host && f.width > 0 && f.height > 0 ? cursorView(state.current, now, f.version) : null;
    if (el) {
      // what it is placed by and what it is drawn on: a hidden cursor can be told from a missing one
      el.dataset.cursorVersion = String(state.current?.version ?? '');
      el.dataset.frameVersion = String(f?.version ?? '');
      if (v && box && host && f) {
        // display points -> the frame's pixels -> the picture as drawn
        const px = (v.x - f.display.x) * f.pixelsPerPoint;
        const py = (v.y - f.display.y) * f.pixelsPerPoint;
        el.style.transform = `translate(${box.left - host.left + (px / f.width) * box.width}px, ${box.top - host.top + (py / f.height) * box.height}px)`;
        el.dataset.shape = v.shape;
        el.hidden = false;
      } else el.hidden = true;
    }
    if (!cursorOver(state.current, now)) schedule();
  };
  // a window nobody is looking at gets no animation frames: the timer keeps the cursor on its plan's clock all the same
  const schedule = () => {
    raf.current = requestAnimationFrame(paint);
    timer.current = setTimeout(paint, FALLBACK_MS);
  };
  const kick = () => {
    if (!raf.current) schedule();
  };
  useEffect(
    () => () => {
      cancelAnimationFrame(raf.current);
      clearTimeout(timer.current);
    },
    [],
  );
  // a frame of another version hides it at once; the cursor comes back on a frame that matches
  useEffectOn([frame?.version], () => {
    kick();
    return () => undefined;
  });
  return {
    node,
    receive: (msg: CursorMessage) => {
      state.current = reduceCursor(state.current, msg, performance.now());
      kick();
    },
  };
}

export function HostCursor({ node }: { node: React.RefObject<HTMLDivElement | null> }) {
  return (
    <div ref={node} className="host-desktop-cursor" hidden aria-hidden="true" data-shape="arrow">
      <svg className="host-desktop-cursor-arrow" width="18" height="18" viewBox="0 0 18 18">
        <path className="host-desktop-cursor-shape" d="M2 1.5l12 6.2-5.2 1.6L6.6 14.6z" strokeWidth="1.2" strokeLinejoin="round" />
      </svg>
      <span className="host-desktop-cursor-disc" />
    </div>
  );
}
