import { test } from 'node:test';
import assert from 'node:assert/strict';
import { markFollowing, observeBottom, ScrollFollowing } from '../src/lib/streamScroll.ts';
import { window } from './support/dom.ts';
import { scrollObserver } from './support/scroll-observer.ts';

test('rendered growth is followed in the frame that grew it and never pulls a reader back down', () => {
  const originals = [globalThis.ResizeObserver, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] as const;
  let callback!: () => void,
    disconnected = false,
    follows = true,
    firstFrame: FrameRequestCallback | null = null,
    frames = 0,
    cancelled = 0;
  const observed: Element[] = [];
  (globalThis as any).ResizeObserver = class {
    constructor(cb: () => void) {
      callback = cb;
    }
    observe(target: Element) {
      observed.push(target);
    }
    disconnect() {
      disconnected = true;
    }
  };
  globalThis.requestAnimationFrame = (cb) => {
    frames++;
    firstFrame = cb;
    return frames;
  };
  globalThis.cancelAnimationFrame = () => {
    cancelled++;
  };
  try {
    // a plain object stands in for the scroller, so its scrollHeight can be set
    const container = { scrollTop: 0, scrollHeight: 500 } as { -readonly [K in keyof HTMLElement]: HTMLElement[K] };
    const content = {} as Element;
    let followedWrites = 0;
    const cleanup = observeBottom(
      container,
      content,
      () => follows,
      () => followedWrites++,
    );
    assert.equal(observed.includes(container), true, 'viewport height changes must trigger following even if the content does not resize');
    assert.equal(observed.includes(content), true);
    assert.equal(container.scrollTop, 0, 'the first follow waits a frame, for what mounted it to set its intent');
    firstFrame!(0);
    assert.equal(container.scrollTop, 500);
    container.scrollHeight = 600;
    callback();
    assert.equal(container.scrollTop, 600, 'the write lands in the callback, before the frame paints');
    assert.equal(frames, 1, 'growth never waits for another animation frame');
    assert.equal(followedWrites, 2);
    follows = false; // the reader scrolls up
    container.scrollTop = 250;
    container.scrollHeight = 700;
    callback();
    assert.equal(container.scrollTop, 250, 'no pull while reading older content');
    follows = true;
    callback();
    assert.equal(container.scrollTop, 700);
    cleanup();
    assert.equal(disconnected, true);
    assert.equal(cancelled, 0, 'the first frame already ran');
    container.scrollTop = 120;
    callback();
    assert.equal(container.scrollTop, 120, 'a queued ResizeObserver notification cannot start a disposed follow');
    // disposed before its first frame: that frame is cancelled
    observeBottom(container, content, () => follows)();
    assert.equal(cancelled, 1);
  } finally {
    [globalThis.ResizeObserver, globalThis.requestAnimationFrame, globalThis.cancelAnimationFrame] = originals;
  }
});

test('a self-contained output observes its viewport once and stops following on disposal', (t) => {
  const observer = scrollObserver(t);
  const container = document.createElement('pre');
  Object.defineProperty(container, 'scrollHeight', { configurable: true, value: 500 });
  const stop = observeBottom(container, container, () => true);
  observer.paint();
  assert.equal(container.scrollTop, 500);
  container.scrollTop = 0;
  stop();
  observer.notify(container);
  assert.equal(container.scrollTop, 0);
  assert.equal(observer.watching, 0);
  // setup-cleanup-setup still follows successfully
  const again = observeBottom(container, container, () => true);
  observer.paint();
  assert.equal(container.scrollTop, 500);
  again();
});

test('follow intent changes on actual movement, not distance after content or viewport growth', () => {
  const follow = new ScrollFollowing();
  const scroll = { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 };
  follow.set(null, false);
  assert.equal(follow.scrolled(scroll), true, 'an actual bottom can be rejoined with no previous measurement');
  follow.set(scroll, true);
  scroll.scrollHeight = 1200;
  assert.equal(follow.scrolled(scroll), true);
  scroll.clientHeight = 200;
  assert.equal(follow.scrolled(scroll), true);
  scroll.scrollTop = 690;
  assert.equal(follow.scrolled(scroll), false);
  scroll.scrollHeight = 1300;
  assert.equal(follow.scrolled(scroll), false);
  scroll.scrollTop = 1080;
  assert.equal(follow.scrolled(scroll), true, 'a downward scroll into the tolerance rejoins');
  scroll.scrollTop = 1070;
  assert.equal(follow.scrolled(scroll), false, 'a gentle upward scroll stays paused inside the same tolerance');
  assert.equal(follow.scrolled(scroll), false, 'a stationary near-bottom reader is still paused');
  scroll.scrollTop = 1100;
  assert.equal(follow.scrolled(scroll), true);
  scroll.scrollTop = 1050;
  follow.set(scroll, true);
  scroll.scrollTop = 1090;
  assert.equal(follow.scrolled(scroll, 16), true);
  follow.set(null, false);
  scroll.scrollTop = 1065;
  assert.equal(follow.scrolled(scroll), false, 'near the bottom alone is no new reader intent');
});

test('wheel intent ignores zoom, horizontal and consumed nested scrolling; the transcript can pause and rejoin', (t) => {
  const follow = new ScrollFollowing();
  const scroll = document.createElement('div');
  const child = document.createElement('pre');
  scroll.append(child);
  document.body.append(scroll);
  t.after(() => scroll.remove());
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 300 });
  const wheel = (init: WheelEventInit = {}, target: HTMLElement | null = null) => {
    const event = new window.WheelEvent('wheel', { deltaY: -20, deltaX: init.deltaX, cancelable: init.cancelable, ...init } as any);
    if (init.ctrlKey !== undefined) Object.defineProperty(event, 'ctrlKey', { value: init.ctrlKey });
    Object.defineProperty(event, 'target', { value: target });
    return follow.wheel(scroll, event as any);
  };
  scroll.scrollTop = 700;
  follow.set(scroll, true);
  assert.equal(wheel(), false);
  assert.equal(wheel({ deltaY: 20 }), true);
  assert.equal(wheel({ deltaY: 0, deltaX: 50 }), null);
  assert.equal(wheel({ ctrlKey: true }), null);
  const prevented = new window.WheelEvent('wheel', { deltaY: -20, cancelable: true });
  prevented.preventDefault();
  assert.equal(follow.wheel(scroll, prevented as any), null);
  child.style.overflowY = 'auto';
  Object.defineProperty(child, 'scrollHeight', { configurable: true, value: 500 });
  Object.defineProperty(child, 'clientHeight', { configurable: true, value: 100 });
  child.scrollTop = 100;
  assert.equal(wheel({}, child), null);
  assert.equal(wheel({ deltaY: 20 }, child), null);
  child.scrollTop = 0;
  assert.equal(wheel({}, child), false, 'the wheel chains to the transcript at the nested top');
  child.scrollTop = 400;
  assert.equal(wheel({ deltaY: 20 }, child), true);
  child.style.overscrollBehaviorY = 'contain';
  assert.equal(wheel({ deltaY: 20 }, child), null);
  child.style.overflowY = 'visible';
  assert.equal(wheel({}, child), false);
  follow.set(scroll, false);
  scroll.scrollTop = 300;
  assert.equal(wheel({ deltaY: 20 }), false, 'downward movement far above the bottom does not rejoin');
  scroll.scrollTop = 0;
  assert.equal(wheel(), false, 'an already paused top stays paused');
  follow.set(scroll, true);
  assert.equal(wheel(), true, 'an upward wheel on a short, nonmoving view does not unpin it');
});

test('browser anchor compensation near the bottom does not rejoin a paused reader', () => {
  const follow = new ScrollFollowing();
  const scroll = { scrollTop: 690, scrollHeight: 1000, clientHeight: 300 };
  follow.set(scroll, false);
  scroll.scrollHeight = 1100;
  scroll.scrollTop = 790;
  assert.equal(follow.scrolled(scroll), false, 'growth above the browser anchor preserves the same text, not downward intent');
  scroll.clientHeight = 290;
  scroll.scrollTop = 800;
  assert.equal(follow.scrolled(scroll), false, 'viewport compensation is not downward intent either');
  scroll.scrollTop = 810;
  assert.equal(follow.scrolled(scroll), true, 'a real bottom still resumes following');
});

test('keyboard scrolling respects direction, modifiers, focused controls and prevented actions', () => {
  const follow = new ScrollFollowing();
  const scroll = document.createElement('div');
  Object.defineProperty(scroll, 'scrollHeight', { configurable: true, value: 1000 });
  Object.defineProperty(scroll, 'clientHeight', { configurable: true, value: 300 });
  scroll.scrollTop = 700;
  const key = (init: KeyboardEventInit, target: HTMLElement | null = scroll) => {
    const event = new window.KeyboardEvent('keydown', init as any);
    Object.defineProperty(event, 'target', { value: target });
    return follow.key(scroll, event as any);
  };
  for (const name of ['ArrowUp', 'PageUp', 'Home']) assert.equal(key({ key: name }), false);
  for (const name of ['ArrowDown', 'PageDown', 'End', ' ']) assert.equal(key({ key: name }), true);
  assert.equal(key({ key: ' ', shiftKey: true }), false);
  for (const modifier of ['altKey', 'metaKey', 'ctrlKey']) assert.equal(key({ key: 'PageUp', [modifier]: true }), null);
  assert.equal(key({ key: 'a' }), null);
  assert.equal(key({ key: 'PageUp' }, document.createElement('input')), null);
  const prevented = new window.KeyboardEvent('keydown', { key: 'PageUp', cancelable: true });
  Object.defineProperty(prevented, 'target', { value: scroll });
  prevented.preventDefault();
  assert.equal(follow.key(scroll, prevented as any), null);
});

test('a transcript that follows its bottom is marked, so the browser does not anchor it elsewhere', () => {
  const classes = new Set<string>();
  const scroll = { classList: { toggle: (name: string, on: boolean) => (on ? classes.add(name) : classes.delete(name)) } } as any;
  markFollowing(scroll, true);
  assert.deepEqual([...classes], ['following']);
  markFollowing(scroll, false);
  assert.deepEqual([...classes], []);
  // before the transcript is in the page there is nothing to mark
  markFollowing(null, true);
});
