// A basic harness's binary set by hand (Settings → CLI location): saved, then the harness is looked for again.
import { get as getState, setPrefs } from '../../store/core';
import { recheckBasic } from './acp';

/** Save `v` as basic harness `id`'s binary (null: found on PATH again), then check the harness again. */
export function pickBasicBin(id: string, v: string | null) {
  const { [id]: _drop, ...rest } = getState().prefs.acpBins ?? {};
  setPrefs({ acpBins: v ? { ...rest, [id]: v } : rest });
  // no delay needed: setPrefs sends the patch to main first, and main applies it before it handles the recheck.
  // Cannot reject: recheckBasic says itself when the check fails
  void recheckBasic(id);
}
