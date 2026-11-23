// Holds a live label on screen for a minimum time so fast changes don't flicker (Claude Desktop's 650 ms label dwell).
import { useEffect, useRef, useState } from 'react';

/** How long a live label stays before the next one replaces it, and how long a return to the rest value waits. */
export const LABEL_DWELL_MS = 650;

export interface DwellOptions<T> {
  /** the value meaning "nothing live": leaving it is immediate, returning to it also waits `fallHoldMs` */
  restKey?: T;
  fallHoldMs?: number;
  /** a change that should show at once (moving forward through a known order) */
  isAdvance?: (shown: T, next: T) => boolean;
}

/**
 * How much longer the shown value must stay before `target` may replace it: the rest of its minimum dwell,
 * and for a return to the rest value, the rest of the fall hold counted from when the target went to rest.
 */
export function dwellWait(o: {
  now: number;
  shownSince: number;
  minMs: number;
  toRest: boolean;
  restSince: number | null;
  fallHoldMs: number;
}): number {
  const dwell = o.minMs - (o.now - o.shownSince);
  const hold = o.toRest ? o.fallHoldMs - (o.now - (o.restSince ?? o.now)) : 0;
  return Math.max(dwell, hold);
}

/**
 * The value to show for a live `value`: changes wait until the shown one has been up `minMs`. A change of
 * `resetKey` (another row, another turn) shows the new value at once.
 */
export function useMinDwell<T>(value: T, minMs: number = LABEL_DWELL_MS, opts?: DwellOptions<T>, resetKey?: unknown): T {
  const [shown, setShown] = useState(value);
  const [key, setKey] = useState(resetKey);
  const keyChanged = resetKey !== key;
  if (keyChanged) setKey(resetKey);
  const rest = opts?.restKey;
  const hasRest = rest !== undefined;
  const toRest = hasRest && value === rest;
  const fromRest = hasRest && shown === rest;
  const advance = !fromRest && !toRest && value !== shown && opts?.isAdvance?.(shown, value) === true;
  const current = keyChanged || fromRest || advance ? value : shown;
  if (current !== shown) setShown(current);
  const shownRef = useRef(current);
  const shownSince = useRef(0);
  const restSince = useRef<number | null>(null);
  const fallHoldMs = opts?.fallHoldMs ?? 0;
  useEffect(() => {
    const now = performance.now();
    if (shownRef.current !== current) {
      shownRef.current = current;
      shownSince.current = now;
    }
    if (toRest) restSince.current ??= now;
    else restSince.current = null;
    if (value === current) return;
    const wait = dwellWait({ now, shownSince: shownSince.current, minMs, toRest, restSince: restSince.current, fallHoldMs });
    if (wait <= 0) {
      setShown(value);
      return;
    }
    // any change to what shows clears this timer first (the effect re-runs)
    const t = setTimeout(() => setShown(value), wait);
    return () => clearTimeout(t);
  }, [value, minMs, current, toRest, fallHoldMs]);
  return current;
}
