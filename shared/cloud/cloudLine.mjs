// The machine line of a cloud machine (Remote Run X6, plan "The machine line" rows 1 to 6): the words, dot and action for each lifecycle state, shared by the Mac and the phone; the first that matches wins, and a machine none of them describes falls through to the ordinary line.

/** The steps of a creation, in order, and the words the line shows for each. */
export const CREATE_WORDS = Object.freeze({ create: 'Creating…', start: 'Setting up…', connect: 'Connecting…', pair: 'Connecting…' });

/**
 * @typedef {{ gone?: boolean, creating?: 'create' | 'start' | 'connect' | 'pair' | null, waking?: boolean, asleep?: boolean, stopping?: boolean, canWake?: boolean }} CloudState
 * `gone`: the provider said so. `creating`: the step a launch is at. `waking`: a resume is in flight. `asleep`: the provider says stopped. `stopping`: the Host told its clients it is stopping. `canWake`: this client holds the provider key.
 * @param {CloudState} s
 * @returns {{ line: string, dot: 'off' | 'warn', action: 'Remove' | 'Cancel' | 'Wake' | null } | null}
 */
export function cloudLine(s) {
  if (s.gone) return { line: 'Deleted at the provider', dot: 'off', action: 'Remove' };
  if (s.creating) return { line: CREATE_WORDS[s.creating], dot: 'warn', action: 'Cancel' };
  if (s.waking) return { line: 'Waking…', dot: 'warn', action: null };
  if (s.asleep)
    return s.canWake
      ? { line: 'Asleep · wakes on next message', dot: 'off', action: 'Wake' }
      : { line: 'Asleep · wake it from your Mac', dot: 'off', action: null };
  if (s.stopping) return { line: 'Stopping · idle', dot: 'warn', action: null };
  return null;
}

/** "Stops when idle · 30 min": how long an online cloud machine may idle before its Host stops it (an hour or more in hours). @param {number | undefined} minutes */
export function idleWords(minutes) {
  if (!minutes) return undefined;
  return minutes % 60 === 0 ? `Stops when idle · ${minutes / 60} h` : `Stops when idle · ${minutes} min`;
}

/** What the phone's row says of a cloud machine that is asleep and starts when a chat does ("Wakes when you start"). */
export const WAKES_WHEN_YOU_START = 'Wakes when you start';

/** "dev-cloud has run 9 hours" (the launcher's own check at app launch); hours are rounded to the nearest whole. @param {string} name @param {number} hours */
export function hoursRunWords(name, hours) {
  const h = Math.round(hours);
  return `${name} has run ${h} ${h === 1 ? 'hour' : 'hours'}`;
}
