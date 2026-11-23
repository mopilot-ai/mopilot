// When the pairing sheet is open: it opens by itself on first run (signed in with no computer, once per sign-in, so its ✕ leaves the empty state and a computer removed later does not start the camera), and hands over once a pairing begins or a computer is added; `onPaired` is told when a computer this phone just paired has been added (not one that only appeared in the list).
import { useEffect, useRef, useState } from 'react';
import type { MobileSnapshot } from './contracts';

export function usePairingSheet(state: MobileSnapshot, canOffer = true, onPaired?: () => void) {
  const [open, setOpen] = useState(false);
  const signedIn = !!state.user;
  const computers = state.pairs.length;
  // a computer that goes away meanwhile (removed from the Mac) must not close the form under what the person is typing
  const known = useRef(computers);
  // this phone began a pairing (the sheet was open, or the safety number was on screen), so the next computer added is its own
  const pairing = useRef(false);
  const told = useRef(onPaired);
  told.current = onPaired;
  useEffect(() => {
    const added = computers > known.current;
    known.current = computers;
    if (open || state.pendingPair || state.pairingCommit) pairing.current = true;
    if (added || state.pendingPair || state.pairingCommit) setOpen(false);
    if (added && pairing.current) told.current?.();
    if (added) pairing.current = false;
  }, [state.pendingPair, state.pairingCommit, computers, open]);
  const offered = useRef(false);
  const noComputer = signedIn && state.phase === 'ready' && !computers && !state.pendingPair && !state.pairingCommit;
  useEffect(() => {
    if (!signedIn) offered.current = false;
    else if (computers) offered.current = true;
    else if (noComputer && canOffer && !offered.current) {
      offered.current = true;
      setOpen(true);
    }
  }, [signedIn, computers, noComputer, canOffer]);
  return [open, setOpen] as const;
}
