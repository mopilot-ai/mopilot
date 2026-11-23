// A screen's way to its computer, bound to the computer it was opened on and to the connection it is on now. A screen that stays up while its computer goes away and comes back is bound again to the new connection (it would otherwise keep the offline snapshot it was drawn under, and every read it makes after that is refused as another computer's); one opened while away takes the first computer that connects; and one never takes a different computer than its own.
import { useMemo, useRef } from 'react';
import type { MobileRuntime } from '../contracts';
import { ownedRequest } from './client';

export function useOwnedRequest(runtime: MobileRuntime) {
  const { selectedPair, generation } = runtime.snapshot();
  const pair = useRef(selectedPair);
  if (pair.current === null) pair.current = selectedPair;
  const owner = pair.current;
  return useMemo(() => ownedRequest(runtime, { selectedPair: owner, generation }), [runtime, owner, generation]);
}
