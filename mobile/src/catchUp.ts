// While the app catches up (after coming back to the front, and when the relay connection is back after a long absence, when the backlog only arrives), a streaming reply shows what it has at once, with no pacing and no word fade, and the followed chat shows what it holds only a few times: the fade clock, the paced reveal and a render per event otherwise keep the JS thread so busy that the buffered messages are taken in at about one every 27 ms.
import { useEffect, useRef } from 'react';
let until = 0;
/** How long the catch-up lasts from the moment it is started. */
export const CATCH_UP_MS = 5000;

export function startCatchUp(ms = CATCH_UP_MS) {
  until = Date.now() + ms;
}
export const catchingUp = () => Date.now() < until;

/** Starts the catch-up when `away` ends: the computer is back after the app lost it. */
export function useCatchUpWhenBack(away: boolean) {
  const was = useRef(away);
  useEffect(() => {
    if (was.current && !away) startCatchUp();
    was.current = away;
  }, [away]);
}
