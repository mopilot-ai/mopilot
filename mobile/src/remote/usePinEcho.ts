// A sent message's pin scroll and its echo (#5686): until the scroll lands, the list still reports offsets on the way from where the view stood to the pinned place, and those say nothing about the reader.
import { type MutableRefObject, useCallback, useMemo, useRef } from 'react';

/** For this long (ms) after the pin's own scroll, a report that is not at the pinned place but on the way to it is from before the scroll landed. */
export const PIN_ECHO = 600;

export function usePinEcho(size: MutableRefObject<{ y: number }>, target: MutableRefObject<number>) {
  // when the pin itself last scrolled, and where the view stood then
  const at = useRef(0);
  const from = useRef(0);
  // a finger ends the pin before it reports (onTouchStart, onScrollBeginDrag), so a report read here has none behind it
  const landing = useCallback(() => {
    const y = size.current.y;
    const [low, high] = [Math.min(from.current, target.current), Math.max(from.current, target.current)];
    return y !== target.current && y >= low - 1 && y <= high + 1 && Date.now() - at.current < PIN_ECHO;
  }, [size, target]);
  return useMemo(
    () => ({
      /** When the pin last scrolled (ms): the reports right after it are its echo, not the reader. */
      at,
      /** The pin scrolls now, from where the view stands. */
      scrolled: () => {
        at.current = Date.now();
        from.current = size.current.y;
      },
      /** The pin's scroll has not landed yet: the list still reports the way to it. */
      landing,
      /** For the performance log. */
      state: () => ({ landing: landing(), target: target.current, from: from.current }),
    }),
    [size, target, landing],
  );
}
