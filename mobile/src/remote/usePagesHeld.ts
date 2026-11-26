// Whether this chat's Mac pages from rows it holds (so a page costs little and the phone may fill in the background), asked once per connection and asked again when the Mac next answers if it could not be reached.
import { useCallback, useEffect, useRef, useState } from 'react';
import { capabilities, type Owned } from './client';

export function usePagesHeld(request: Owned) {
  const [cheap, setCheap] = useState(false);
  // whether the Mac has answered the question: one that could not be reached is asked again by `askAgain`, or the fill would never start
  const answered = useRef(false);
  const live = useRef(request);
  live.current = request;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const ask = useCallback(
    (owner: Owned) =>
      capabilities(owner).then(
        (caps) => {
          // a late answer for an earlier connection, or for a screen that is gone, says nothing about this one
          if (!mounted.current || owner !== live.current) return;
          answered.current = true;
          setCheap(caps.olderRowsHeld === true);
        },
        () => undefined,
      ),
    [],
  );
  // asked after the open's own requests have gone out (chat.follow is the first of an open, tests/phoneChatOpen.test.ts); the fill waits BACKFILL_GAP_MS anyway
  useEffect(() => {
    answered.current = false;
    setCheap(false);
    const timer = setTimeout(() => void ask(request), 0);
    return () => clearTimeout(timer);
  }, [request, ask]);
  /** Called when the Mac has just answered with a new snapshot: asks again only if the first ask never got an answer. */
  const askAgain = useCallback(() => {
    if (!answered.current) void ask(live.current);
  }, [ask]);
  return { cheap, askAgain };
}
