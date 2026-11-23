// An IntersectionObserver that reports every observed element on screen, as Chromium's first report does for a sidebar
// row in view. happy-dom's never reports, which would leave useOnScreen's callers (src/lib/onScreen.ts) waiting forever.
class AllOnScreen {
  private readonly callback: (entries: { target: Element; isIntersecting: boolean }[]) => void;
  constructor(callback: (entries: { target: Element; isIntersecting: boolean }[]) => void) {
    this.callback = callback;
  }
  observe(target: Element) {
    queueMicrotask(() => this.callback([{ target, isIntersecting: true }]));
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
(globalThis as any).IntersectionObserver = AllOnScreen;
