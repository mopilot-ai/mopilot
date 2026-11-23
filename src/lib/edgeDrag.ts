// Dragging a panel edge without re-rendering what the panel holds: captured pointer, one DOM write per frame, one commit on release.

/** Values pushed between frames shown once per animation frame, at the last one. */
export interface FrameCoalescer<T> {
  /** a new value: shown on the next frame, together with any others pushed before it */
  push: (value: T) => void;
  /** drops the waiting value (a cancelled drag, an unmount) */
  cancel: () => void;
}

/** Coalesces values to one `show` per animation frame: a mouse fires more often than the screen repaints. */
export function frameCoalescer<T>(show: (value: T) => void): FrameCoalescer<T> {
  let frame = 0;
  // only a push asks for a frame, and a cancel drops the frame with the value: a frame that runs has one
  let waiting: T;
  return {
    push: (value) => {
      waiting = value;
      frame ||= requestAnimationFrame(() => {
        frame = 0;
        show(waiting);
      });
    },
    cancel: () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    },
  };
}

/** Keeps a drag's cursor and stops text selection across the app until the returned unlock (`[data-edge-drag]` in side-pane.css). */
export function lockEdgeDrag(axis: 'column' | 'row'): () => void {
  const root = document.documentElement;
  root.dataset.edgeDrag = axis;
  return () => {
    delete root.dataset.edgeDrag;
  };
}

/** Each way a press ends; a cancel keeps what the drag showed, as the lost capture does. */
const ENDS = ['pointerup', 'pointercancel', 'lostpointercapture'] as const;

/** What a drag does with the pointer: the size for a move, how a frame shows it, and where the final size goes. */
export interface EdgeDrag {
  /** which way the edge moves: the cursor the app keeps during the drag */
  axis: 'column' | 'row';
  /** the size the pointer asks for (already clamped to the panel's limits) */
  size: (event: PointerEvent) => number;
  /** shows a size on screen at once (the panel's inline style, and anything that must follow it in the same frame) */
  apply: (size: number) => void;
  /** the press is over, with or without a size to commit: the owner forgets the drag here */
  ended: () => void;
  /** the size the drag ended on, once, when the button is released after a move */
  commit: (size: number) => void;
}

/**
 * Starts a drag from a pointerdown on the edge: pointer moves are coalesced to one `apply` per animation frame, so a
 * panel holding thousands of rows is laid out once per frame rather than once per mouse event, and React state (the
 * panel's and everything under it) changes only on release. The pointer is captured because listeners on the window
 * stop hearing it over an iframe or a <webview>: a release there would leave the edge following a mouse with no button
 * held. A release the edge does not hear still ends the drag: the lost capture, a move with no button held, or the
 * window losing focus. Returns a stop that drops the drag
 * without committing (an unmount, a new press).
 */
export function startEdgeDrag(
  press: { currentTarget: Element; pointerId: number },
  { axis, size, apply, ended, commit }: EdgeDrag,
): () => void {
  const edge = press.currentTarget as HTMLElement;
  const id = press.pointerId;
  const unlock = lockEdgeDrag(axis);
  let last: PointerEvent | null = null;
  const frames = frameCoalescer((event: PointerEvent) => apply(size(event)));
  const move = (event: PointerEvent) => {
    if (event.pointerId !== id) return;
    // no button held: a release the edge did not hear, with no lost capture yet
    if (!event.buttons) return end();
    last = event;
    frames.push(event);
  };
  const stop = () => {
    frames.cancel();
    unlock();
    edge.removeEventListener('pointermove', move);
    for (const type of ENDS) edge.removeEventListener(type, release);
    window.removeEventListener('blur', end);
    if (edge.hasPointerCapture(id)) edge.releasePointerCapture(id);
  };
  const release = (event: PointerEvent) => {
    if (event.pointerId === id) end();
  };
  const end = () => {
    stop();
    ended();
    if (!last) return;
    const final = size(last);
    apply(final);
    commit(final);
  };
  edge.addEventListener('pointermove', move);
  for (const type of ENDS) edge.addEventListener(type, release);
  window.addEventListener('blur', end);
  edge.setPointerCapture(id);
  return stop;
}
