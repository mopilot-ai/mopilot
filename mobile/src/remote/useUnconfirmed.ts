// The "not confirmed" notice of a screen: set when a stop, answer or send was in flight as the connection went, and gone once the chat has moved on (its turn or its cards changed) or the next action starts.
import { useEffect, useRef, useState } from 'react';
import type { Unconfirmable } from './unconfirmed';

/** `moveKey` changes when what the action was about shows its result (the turn ended, a card went away). */
export function useUnconfirmed(moveKey: string) {
  const [kind, setKind] = useState<Unconfirmable | null>(null);
  const now = useRef(moveKey);
  now.current = moveKey;
  useEffect(() => {
    void moveKey;
    setKind(null);
  }, [moveKey]);
  return {
    kind,
    clear: () => setKind(null),
    /** Starts an action; the function it returns says `kind` was not confirmed, unless the chat moved on since (the result is already on screen). */
    begin() {
      setKind(null);
      const at = now.current;
      return (lost: Unconfirmable) => {
        if (now.current === at) setKind(lost);
      };
    },
  };
}
