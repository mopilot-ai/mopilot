// Controls browser frame boundaries in DOM tests, including cancellation and callbacks queued for the next frame.
export function animationFrames() {
  const request = globalThis.requestAnimationFrame;
  const cancel = globalThis.cancelAnimationFrame;
  const pending = new Map<number, FrameRequestCallback>();
  let sequence = 0;
  globalThis.requestAnimationFrame = (callback) => {
    pending.set(++sequence, callback);
    return sequence;
  };
  globalThis.cancelAnimationFrame = (id) => {
    pending.delete(id);
  };
  return {
    get pending() {
      return pending.size;
    },
    frame(at = 0) {
      for (const id of [...pending.keys()]) {
        const callback = pending.get(id);
        pending.delete(id);
        callback?.(at);
      }
    },
    restore() {
      pending.clear();
      globalThis.requestAnimationFrame = request;
      globalThis.cancelAnimationFrame = cancel;
    },
  };
}
