// The current time, read again every `ms` while the screen is open, so what depends on a chat's age keeps up with the clock.
import { useEffect, useState } from 'react';

export function useNow(ms = 60_000) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    // a clock must not keep a process alive; React Native timers have no unref
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}
