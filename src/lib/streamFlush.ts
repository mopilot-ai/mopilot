// The preload brackets each stream:batch it unpacks with these two window events (electron/bridge/spec.cjs), so a flush's
// many events, which the preload hands to their listeners one by one, can be applied as one store commit.
export const STREAM_FLUSH_BEGIN = 'native:stream-flush-begin';
export const STREAM_FLUSH_END = 'native:stream-flush-end';

/** Calls `begin` and `end` around each stream batch `target` hears of; returns the stop function. */
export function followStreamFlush(target: EventTarget, begin: () => void, end: () => void): () => void {
  target.addEventListener(STREAM_FLUSH_BEGIN, begin);
  target.addEventListener(STREAM_FLUSH_END, end);
  return () => {
    target.removeEventListener(STREAM_FLUSH_BEGIN, begin);
    target.removeEventListener(STREAM_FLUSH_END, end);
  };
}
