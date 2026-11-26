// Which list a chat shows: the rows it last showed, the commit in which the Mac's rows replace them, or the live transcript; only the last animates its rows in.
import { useEffect, useRef } from 'react';

export type SwapPhase = 'saved' | 'arriving' | 'live';

/** `answered`: the Mac's rows are here. The commit that first has them is `arriving`, whatever came before it. */
export function useSwapPhase(answered: boolean): SwapPhase {
  const arrived = useRef(false);
  const phase = !answered ? 'saved' : arrived.current ? 'live' : 'arriving';
  useEffect(() => {
    arrived.current = answered;
  }, [answered]);
  return phase;
}
