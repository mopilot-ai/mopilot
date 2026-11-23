// The Claude presence scan's schedule: every 4 s in front, every 20 s behind, parked while the window is hidden, once on return.

type Doc = Pick<Document, 'hidden' | 'addEventListener' | 'removeEventListener'>;

/**
 * @param scan runs one scan (it records a failed one itself)
 * @param inFront whether the window has focus
 * @returns a stop function (tests)
 */
export function startPresencePolling(
  scan: () => void,
  inFront: () => boolean,
  doc: Doc | null = typeof document === 'undefined' ? null : document,
) {
  let last = 0;
  const run = (within: number) => {
    if (Date.now() - last < within) return;
    last = Date.now();
    scan();
  };
  const timer = setInterval(() => {
    // nobody sees the result of a scan while hidden; coming back scans at once
    if (doc?.hidden) return;
    run(inFront() ? 0 : 20_000);
  }, 4000);
  // the visibility and focus events can land together: one scan serves both
  const back = () => {
    if (!doc?.hidden) run(1000);
  };
  doc?.addEventListener('visibilitychange', back);
  const win = typeof window === 'undefined' ? null : window;
  win?.addEventListener('focus', back);
  return () => {
    clearInterval(timer);
    doc?.removeEventListener('visibilitychange', back);
    win?.removeEventListener('focus', back);
  };
}
