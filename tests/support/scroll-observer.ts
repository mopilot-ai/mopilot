// Deterministic layout notifications and paint frames for viewport-following unit tests.
import type { TestContext } from 'node:test';

export function scrollObserver(t: TestContext) {
  const originals = [globalThis.ResizeObserver, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] as const;
  const observers = new Set<{ targets: Set<Element>; notify: () => void }>();
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  globalThis.ResizeObserver = class {
    targets = new Set<Element>();
    notify: () => void;
    constructor(notify: () => void) {
      this.notify = notify;
      observers.add(this);
    }
    observe(target: Element) {
      this.targets.add(target);
    }
    disconnect() {
      observers.delete(this);
    }
    unobserve(target: Element) {
      this.targets.delete(target);
    }
  } as any;
  globalThis.requestAnimationFrame = (cb) => {
    frames.set(++next, cb);
    return next;
  };
  globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
  t.after(() => {
    [globalThis.ResizeObserver, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = originals;
  });
  return {
    notify(target: Element) {
      for (const observer of observers) if (observer.targets.has(target)) observer.notify();
    },
    paint() {
      const pending = [...frames.values()];
      frames.clear();
      for (const cb of pending) cb(0);
    },
    get pending() {
      return frames.size;
    },
    get watching() {
      return observers.size;
    },
  };
}
