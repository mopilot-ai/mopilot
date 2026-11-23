// Whether a Host's desktop tools are announced to it (electron/host/toolRelay.cjs `hostToolsFor`). A Host that gains a desktop is told at once; one that loses it (a probe that briefly fails while a helper restarts) only after it stays gone, so a running chat is not refused its tools by a blip and the list is not sent twice for one.
const GONE_MS = 30_000;

/**
 * @param {object} o
 * @param {() => boolean} o.has whether the machine's row reports a desktop now
 * @param {() => void} o.resync tell the Host the tool list again
 * @param {number} [o.goneMs] how long a lost desktop must stay lost
 * @param {(fn: () => void, ms: number) => unknown} [o.setTimer]
 * @param {(timer: unknown) => void} [o.clearTimer]
 */
function desktopAnnounce({
  has,
  resync,
  goneMs = GONE_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms).unref?.(),
  clearTimer = (t) => clearTimeout(/** @type {any} */ (t)),
}) {
  let announced = has();
  /** @type {unknown} */
  let pending = null;
  const cancel = () => {
    if (pending !== null) clearTimer(pending);
    pending = null;
  };
  return {
    /** What the Host is told now: the filter reads this, never the row. */
    announced: () => announced,
    /** The machine's row changed. */
    onRow() {
      const now = has();
      if (now === announced) return cancel();
      if (now) {
        cancel();
        announced = true;
        return resync();
      }
      if (pending !== null) return;
      pending = setTimer(() => {
        pending = null;
        if (has()) return;
        announced = false;
        resync();
      }, goneMs);
    },
    dispose: cancel,
  };
}

module.exports = { desktopAnnounce, GONE_MS };
