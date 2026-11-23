// The device's side of the live-events net: the app's own foreground signal and whether it is in front, and for a chat on a phone runtime the relay connection coming back (the Mac skips live events for a phone the relay says is away, and a phone that reconnects while the chat is open is not told what it missed).
import { isActive, onForeground } from '../platform/lifecycle';
import type { WatchOptions } from './liveWatch';

export { expectReply } from './liveWatch';
export const deviceWatch: WatchOptions = { foreground: (fn) => onForeground(() => fn()), visible: isActive };

/** A runtime that can say its connection changed; a runtime that cannot (a stand-in) is watched by the device's signals alone. */
type Connection = { snapshot?(): { phase?: string }; subscribe?(fn: () => void): () => void };

export function watchFor(runtime: Connection, key: string): WatchOptions {
  return {
    ...deviceWatch,
    key,
    foreground: (fn) => {
      const stopFront = deviceWatch.foreground!(fn);
      let online = runtime.snapshot?.().phase === 'online';
      const stopLink = runtime.subscribe?.(() => {
        const now = runtime.snapshot?.().phase === 'online';
        if (now && !online) fn();
        online = now;
      });
      return () => {
        stopFront();
        stopLink?.();
      };
    },
  };
}
