// An offer card's countdown to "New session" as a window draws it: the seconds left and the fill of that answer.
// Main owns the time (proposals.cjs waitForAnswer): a window only draws the deadline main published, so every window,
// and one that opens or reloads while it runs, shows the same moment, and none counts down what main no longer does.
import { useEffect, useMemo, useState, type CSSProperties } from 'react';

/** A countdown as main publishes it (ms epoch): when it began and when it goes ahead. */
export type Countdown = { from: number; at: number };

/** The whole seconds left until `at`, never below 0: 59.2 s left reads 60, so the last second shows 1, not 0. */
export function secondsLeft(at: number, now: number): number {
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** The seconds left until `at`, ticking as each second passes, until none is left. */
export function useSecondsLeft(at: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = () => {
      const t = Date.now();
      setNow(t);
      const left = at - t;
      // the next change is when the next whole second runs out, so the number never lags a second behind
      if (left > 0) timer = setTimeout(tick, left % 1000 || 1000);
    };
    tick();
    return () => clearTimeout(timer);
  }, [at]);
  return secondsLeft(at, now);
}

/**
 * The fill's timing: the whole countdown, started as far back as it already ran, so a card drawn late (a window that
 * opened or reloaded meanwhile) fills from where main is. Read once per countdown: the animation keeps its own time.
 */
export function fillTiming({ from, at }: Countdown, now: number): CSSProperties {
  const total = Math.max(1, at - from);
  const ran = Math.min(total, Math.max(0, now - from));
  return { '--offer-countdown': `${total}ms`, '--offer-countdown-ran': `${-ran}ms` } as CSSProperties;
}

/** The fill timing of a countdown, fixed for as long as that countdown is the one shown. */
export function useFillTiming(countdown: Countdown | null): CSSProperties | undefined {
  const from = countdown?.from;
  const at = countdown?.at;
  return useMemo(() => (from === undefined || at === undefined ? undefined : fillTiming({ from, at }, Date.now())), [from, at]);
}

/** What happens when nobody answers, under the offer's title: "Starting a new session in 42s". */
export function OfferCountdownNote({ id, at }: { id: string; at: number }) {
  const left = useSecondsLeft(at);
  // one message with its hole, so a translation can put the seconds where its language does
  const words = left > 0 ? `Starting a new session in ${left}s` : 'Starting a new session…';
  return (
    <span id={id} className="suggest-row-countdown" role="timer">
      {words}
    </span>
  );
}
