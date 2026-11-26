// What waits for the reader to rest: while a finger is on the list or the glide after it runs, rows that join above are held, so nothing is mounted above a reader mid-scroll (#5686).
import { useRef } from 'react';

export function useGestureQueue() {
  const down = useRef(false);
  const waiting = useRef<(() => void)[]>([]);
  return useRef({
    /** Runs `apply` now, or once the reader rests. */
    after: (apply: () => void) => {
      if (down.current) waiting.current.push(apply);
      else apply();
    },
    /** A finger went down. */
    hold: () => {
      down.current = true;
    },
    /** The reader let go: what waited joins now, in the order it was asked. */
    rest: () => {
      down.current = false;
      for (const apply of waiting.current.splice(0)) apply();
    },
    /** Forgets what waited (the chat was read from its start again). */
    clear: () => {
      waiting.current = [];
    },
  }).current;
}
