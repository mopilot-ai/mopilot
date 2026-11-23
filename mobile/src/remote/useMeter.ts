// The picture of a recording in progress: how long it has run and how loud the last moments were. Read from the microphone's level while it records, drawn and forgotten.
import { useEffect, useState } from 'react';
import type { Media } from '../platform/media';

/** How many bars the picture holds, and how often a bar is added. */
export const BARS = 28;
export const EVERY_MS = 100;

/** Each bar has the number of the moment it was taken at, so it keeps its identity as the picture moves left. */
export type Bar = { at: number; level: number };
export type Meter = { ms: number; levels: Bar[] };
const EMPTY: Meter = { ms: 0, levels: [] };

export function useMeter(media: Media, recording: boolean): Meter {
  const [meter, setMeter] = useState<Meter>(EMPTY);
  useEffect(() => {
    if (!recording) return setMeter(EMPTY);
    const started = Date.now();
    const timer = setInterval(
      () =>
        setMeter((old) => ({
          ms: Date.now() - started,
          levels: [...old.levels, { at: (old.levels.at(-1)?.at ?? 0) + 1, level: media.level() ?? 0 }].slice(-BARS),
        })),
      EVERY_MS,
    );
    // a meter must not keep a process alive; React Native timers have no unref
    (timer as { unref?: () => void }).unref?.();
    return () => clearInterval(timer);
  }, [media, recording]);
  return meter;
}

/** "0:07", "1:05": whole seconds of a recording. */
export function clock(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
