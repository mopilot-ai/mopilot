// What a setup step watches while it is open: the harness looked for in the background (an install in the user's own
// terminal is found without a click), how long a run has taken, and when a step has waited long enough to offer more.
import { useEffect, useState } from 'react';
import { native } from '../../lib/native';
import { ignoring } from '../../lib/ignored';
import { visiblePoll } from '../../lib/visiblePoll';
import { recheckHarness } from '../../session/harness/harnessRuns';

/** How often an open install step asks whether the harness's binary is there yet. */
export const FIND_EVERY_MS = 3000;
/** How long a step waits on its own before it offers Re-check. */
export const RECHECK_AFTER_MS = 20_000;

/** The binary each kind was last looked for again over, so a step that remounts (its row passes through Checking…)
 * does not look again over the same one: only a binary that changed (installed, rewritten, made runnable) does. */
const lookedFor = new Map<string, string>();

/**
 * While `active`, ask main every few seconds (and when the window takes focus) whether `kind`'s binary is there and
 * runs; once a new one is, look for the harness again, once. The ask is cheap: nothing is started until then.
 */
export function useFoundPoll(kind: string, active: boolean) {
  useEffect(() => {
    if (!active) return;
    let alive = true;
    const ask = () => {
      native.harnessRuns.find(kind).then(
        (bin) => {
          if (!alive || !bin || lookedFor.get(kind) === bin) return;
          lookedFor.set(kind, bin);
          recheckHarness(kind).catch(ignoring(`look for ${kind} once its binary showed up`));
        },
        ignoring(`ask whether ${kind} is installed yet`),
      );
    };
    // at once too: it may have been installed before the step opened
    ask();
    const stop = visiblePoll(`install-find:${kind}`, FIND_EVERY_MS, ask);
    return () => {
      alive = false;
      stop();
    };
  }, [kind, active]);
}

/** True once `active` has held for `ms`; false again when it stops holding. */
export function useAfter(ms: number, active: boolean) {
  const [after, setAfter] = useState(false);
  useEffect(() => {
    setAfter(false);
    if (!active) return;
    const t = setTimeout(() => setAfter(true), ms);
    return () => clearTimeout(t);
  }, [ms, active]);
  return active && after;
}

/** Seconds since `since` (ms since the epoch), ticking each second; 0 without one. */
export function useElapsed(since: number | null) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    // the clock every elapsed time on screen shares, stopped while the window is hidden
    return visiblePoll('now:1000', 1000, () => setNow(Date.now()));
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

/** 0:07, 1:32. */
export const clockText = (seconds: number) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
