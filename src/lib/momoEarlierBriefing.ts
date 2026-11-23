// The earlier "Morning briefing" routine (the starter older builds proposed, electron/momo/starterRoutines.cjs) while MoMo's Morning brief (A7) is on: the one morning note is the brief, so a person who approved the old routine is told it is still on and can pause it. Nothing is paused or removed for them: the routine is theirs, and only the one button pauses it, through the routine edit Settings › MoMo › Routines uses.
import { useState } from 'react';
import { useMomoRoutines } from './momoRoutines';

/** The name the starter proposes it under (tests/momoEarlierBriefing.test.ts keeps it equal to the starter's). */
export const EARLIER_BRIEFING = 'Morning briefing';

/** The earlier routine when it is approved and running while `on` (the brief is on), with the button that pauses it; null otherwise (never approved, paused, removed, or the brief is off). */
export function useEarlierBriefing(on: boolean) {
  const { view, edit, error } = useMomoRoutines();
  const [busy, setBusy] = useState(false);
  const routine = on ? view?.routines.find((r) => r.name === EARLIER_BRIEFING && !r.paused) : undefined;
  if (!routine) return null;
  return {
    busy,
    error,
    /** pauses only this routine; the list is read again, so the line goes once main has saved it */
    turnOff: async () => {
      setBusy(true);
      await edit(routine.id, { paused: true });
      setBusy(false);
    },
  };
}
