// The time a card is judged by, kept moving: `at` fixes it (a test), else it is the clock, read again when `deadline` passes so a card that expires does so on screen.
import { useEffect, useState } from 'react';

export function useNow(deadline: number | null, at?: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (at !== undefined || deadline === null) return;
    const wait = deadline - Date.now();
    if (wait <= 0) return setNow(Date.now());
    const t = setTimeout(() => setNow(Date.now()), Math.min(wait + 50, 2 ** 31 - 1));
    return () => clearTimeout(t);
  }, [deadline, at]);
  return at ?? now;
}
