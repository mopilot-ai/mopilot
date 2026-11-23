// Keeping a streaming thread scrolled to the bottom as its content grows, unless the user scrolled away.

/**
 * Follow content/viewport growth. A ResizeObserver callback runs after layout and before the frame paints, so the
 * write happens in the frame that grew the content: waiting for the next animation frame would paint each new line
 * clipped once and then snap the view by a line height. Record each clamped write before its asynchronous scroll event.
 */
export function observeBottom(container: HTMLElement, content: Element, follows: () => boolean, followed?: () => void) {
  let alive = true;
  const follow = () => {
    if (!alive || !follows()) return;
    container.scrollTop = container.scrollHeight;
    followed?.();
  };
  const observer = new ResizeObserver(follow);
  observer.observe(container);
  if (content !== container) observer.observe(content);
  // the first follow waits a frame, so what mounted it (a ref callback, a chat switch) has set its intent by then
  let first = requestAnimationFrame(() => {
    first = 0;
    follow();
  });
  return () => {
    alive = false;
    observer.disconnect();
    if (first) cancelAnimationFrame(first);
  };
}

type ScrollPosition = Pick<HTMLElement, 'scrollTop' | 'scrollHeight' | 'clientHeight'>;
type WheelInput = Pick<WheelEvent, 'deltaX' | 'deltaY' | 'ctrlKey' | 'defaultPrevented' | 'target'>;
type KeyInput = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'altKey' | 'metaKey' | 'ctrlKey' | 'defaultPrevented' | 'target'>;

/** One viewport's follow intent: layout growth is not an instruction to stop following. */
export class ScrollFollowing {
  following = true;
  private top: number | null = null;
  private height = 0;
  private viewport = 0;

  /** Reset intent or remember an owned write before the browser delivers its scroll event. */
  set(scroll: ScrollPosition | null, on: boolean) {
    this.following = on;
    this.top = scroll?.scrollTop ?? null;
    this.height = scroll?.scrollHeight ?? 0;
    this.viewport = scroll?.clientHeight ?? 0;
  }

  /** Actual upward movement yields, even within the rejoin tolerance; a stationary, growing bottom does not. */
  scrolled(scroll: ScrollPosition, tolerance = 40): boolean {
    const top = scroll.scrollTop;
    const gap = scroll.scrollHeight - scroll.clientHeight - top;
    if (this.top !== null && top < this.top && gap > 1) this.following = false;
    else if (
      gap <= 1 ||
      (gap < tolerance &&
        this.top !== null &&
        top > this.top &&
        scroll.scrollHeight === this.height &&
        scroll.clientHeight === this.viewport)
    )
      this.following = true;
    this.set(scroll, this.following);
    return this.following;
  }

  /** null means this input belongs to another control, horizontal scrolling or zoom. */
  wheel(scroll: HTMLElement, event: WheelInput): boolean | null {
    if (event.defaultPrevented || event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return null;
    let element = event.target instanceof Element ? event.target : null;
    for (; element && element !== scroll; element = element.parentElement) {
      const style = getComputedStyle(element);
      if (!['auto', 'scroll'].includes(style.overflowY)) continue;
      const available = event.deltaY < 0 ? element.scrollTop : element.scrollHeight - element.clientHeight - element.scrollTop;
      if (available > 0 || ['contain', 'none'].includes(style.overscrollBehaviorY)) return null;
    }
    return this.direction(scroll, event.deltaY);
  }

  key(scroll: HTMLElement, event: KeyInput): boolean | null {
    if (event.target !== scroll || event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) return null;
    if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) return this.direction(scroll, -1);
    if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) return this.direction(scroll, 1);
    return null;
  }

  private direction(scroll: ScrollPosition, delta: number): boolean {
    if (delta < 0) return scroll.scrollTop > 0 ? false : this.following;
    return scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 40 || this.following;
  }
}

/**
 * Marks whether a thread follows the bottom of its transcript, as the transcript's `following` class. While it
 * follows, following is the anchor: the browser's own scroll anchoring is off then (thread.css), because it moves the
 * view off the bottom when content goes in above what it anchors on (a message just sent goes in below the turn on
 * screen), and the view would stop following the reply.
 */
export function markFollowing(scroll: HTMLElement | null, on: boolean) {
  scroll?.classList.toggle('following', on);
}
