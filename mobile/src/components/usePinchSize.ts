// Pinch to change the terminal's text size: two fingers on the output scale the size, kept for the rest of the app run.
import { useCallback, useMemo, useRef, useState } from 'react';
import { PanResponder } from 'react-native';

export const BASE_FONT = 12;
export const MIN_FONT = 9;
export const MAX_FONT = 20;

/** The size after two fingers moved from `start` apart to `now` apart, in whole points inside the limits. */
export const pinchedSize = (size: number, start: number, now: number) =>
  start > 0 ? Math.max(MIN_FONT, Math.min(MAX_FONT, Math.round((size * now) / start))) : size;

type Touch = { pageX: number; pageY: number };
const apart = (a: Touch, b: Touch) => Math.hypot(a.pageX - b.pageX, a.pageY - b.pageY);

/** What the last pinch left, so the next terminal opens at the same size. */
let remembered = BASE_FONT;

export function usePinchSize() {
  const [size, setSize] = useState(remembered);
  // the size the shell is sized to: it follows a pinch when the fingers lift, not on every step of it
  const [settled, setSettled] = useState(remembered);
  const live = useRef(size);
  const from = useRef<{ apart: number; size: number } | null>(null);
  const end = useCallback(() => {
    from.current = null;
    setSettled(live.current);
  }, []);
  const handlers = useMemo(
    () =>
      PanResponder.create({
        // two fingers take the gesture before the output's own scrolling sees it
        onMoveShouldSetPanResponderCapture: (e) => e.nativeEvent.touches.length === 2,
        onPanResponderMove: (e) => {
          const [a, b] = e.nativeEvent.touches;
          // one finger left: the next two start a new pinch
          if (!b) return void (from.current = null);
          from.current ??= { apart: apart(a, b), size: live.current };
          live.current = pinchedSize(from.current.size, from.current.apart, apart(a, b));
          remembered = live.current;
          setSize(live.current);
        },
        onPanResponderRelease: () => end(),
        onPanResponderTerminate: () => end(),
      }).panHandlers,
    [end],
  );
  return { size, settled, handlers };
}
