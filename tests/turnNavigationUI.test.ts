import { rendersOf, resetCommits } from './support/commitProbe.ts'; // first: React reads the hook as it loads
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { createElement as h } from 'react';
import { toggleMessageBookmark } from '../src/lib/navigationBookmarks.ts';
import { fakeStore, iconStubs, mockSource, stubStore } from './support/stubs.ts';
Object.defineProperty(globalThis, 'CSS', { configurable: true, value: (window as any).CSS });
let nextFrame = 0;
const frames = new Map<number, FrameRequestCallback>();
(globalThis as any).requestAnimationFrame = (cb: FrameRequestCallback) => {
  frames.set(++nextFrame, cb);
  return nextFrame;
};
(globalThis as any).cancelAnimationFrame = (id: number) => frames.delete(id);
// the rail looks again when the transcript reports a prompt crossing its edges: cross() delivers that report
const intersections = new Set<() => void>();
(globalThis as any).IntersectionObserver = function (this: any, cb: () => void) {
  this.observe = () => {};
  this.disconnect = () => intersections.delete(cb);
  intersections.add(cb);
};
const captures = new WeakMap<HTMLElement, number>();
(window.HTMLElement.prototype as any).setPointerCapture = function (id: number) {
  captures.set(this, id);
};
(window.HTMLElement.prototype as any).hasPointerCapture = function (id: number) {
  return captures.get(this) === id;
};
(window.HTMLElement.prototype as any).releasePointerCapture = function () {
  captures.delete(this);
};
// happy-dom has no real pointer, so :hover is scripted. Tests lower it to simulate a pointer that left without any leave event.
let pointerOver = true;
const originalMatches = window.Element.prototype.matches;
(window.Element.prototype as any).matches = function (selector: string) {
  return selector === ':hover' ? pointerOver : originalMatches.call(this, selector);
};
const Bookmark = (p: any) => h('svg', p);
// subscribed, as the real store is: the rail is memoized, so a change reaches it through the store, not a parent render
const nav = fakeStore<any>({ navigationBookmarks: {} });
stubStore({
  useStore: nav.useStore,
  toggleNavigationBookmark: (chat: string, id: string) =>
    nav.set((s: any) => ({ navigationBookmarks: toggleMessageBookmark(s.navigationBookmarks, chat, id) })),
});
mockSource(
  'src/components/ui/icons.tsx',
  iconStubs(() => Bookmark),
);
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { TurnNavigation } = await import('../src/components/thread/TurnNavigation.tsx');
const { navigationId } = await import('../src/session/threadNavigation.ts');
const tick = async () =>
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    for (const cb of callbacks) cb(0);
  });
const cross = async () => act(() => intersections.forEach((cb) => cb()));
const delay = async (ms: number) => act(() => new Promise((resolve) => setTimeout(resolve, ms)));
const event = (type: string, options: any = {}) =>
  type.startsWith('key')
    ? new window.KeyboardEvent(type, { bubbles: true, cancelable: true, ...options })
    : type.startsWith('pointer') || type === 'lostpointercapture'
      ? new window.PointerEvent(type, { bubbles: true, cancelable: true, ...options })
      : new window.MouseEvent(type, { bubbles: true, cancelable: true, ...options });
async function fire(el: Element, type: string, options: any = {}) {
  await act(() => el.dispatchEvent(event(type, options) as any));
}
// A browser dispatches a release's click in the same task as its pointerup. Separate act() calls can let
// a macrotask (and the component's zero-delay suppression reset) run between them, so release and click together.
async function release(list: Element, options: any, mark: Element) {
  await act(() => {
    list.dispatchEvent(event('pointerup', options) as any);
    mark.dispatchEvent(event('click') as any);
  });
}
async function mount(options: any = {}) {
  const host = document.createElement('div');
  host.className = 'thread-view';
  document.body.append(host);
  const scroll = document.createElement('div');
  host.append(scroll);
  const content = document.createElement('div');
  scroll.append(content);
  Object.defineProperties(scroll, { clientHeight: { configurable: true, value: 200 }, scrollHeight: { configurable: true, value: 2000 } });
  scroll.getBoundingClientRect = () => ({ top: 100, bottom: 300 }) as any;
  const items = Array.from({ length: options.count ?? 6 }, (_, i) => ({
    id: navigationId('t', 'u' + i),
    prompt: 'Question ' + i,
    response:
      i === 0
        ? '[link](https://example.test) ![alt](https://image.test/a.png) ![](https://image.test/empty.png)\n\n```ts\ncode\n```'
        : 'Answer ' + i,
    outputs: i === 0 ? ['a.ts', 'b.ts', 'c.ts'] : [],
    canBookmark: i !== 1,
  }));
  const anchors = items.map((item, i) => {
    const el = document.createElement('div');
    el.dataset.navigationId = item.id;
    content.append(el);
    el.getBoundingClientRect = () => ({ top: 100 + i * 300 - scroll.scrollTop }) as any;
    return el;
  });
  nav.reset({ navigationBookmarks: options.saved ? { c: options.saved } : {} });
  const calls: any[] = [];
  let props = {
    threadId: 'c',
    items,
    scrollRef: { current: scroll as any },
    inPane: false,
    hasOlder: false,
    loadingOlder: false,
    onLoadOlder: async () => {
      calls.push('older');
    },
    onNavigate: (id: string, instant?: boolean) => calls.push([id, instant]),
    ...options.props,
  };
  const navHost = document.createElement('div');
  host.append(navHost);
  const root = createRoot(navHost as any);
  const update = async (p: any = {}) => {
    props = { ...props, ...p };
    await act(() => root.render(createElement(TurnNavigation, props)));
  };
  await update();
  const geometry = () => {
    const rail = host.querySelector('.turn-navigation') as HTMLElement | null;
    if (rail) rail.getBoundingClientRect = () => ({ left: 12, right: 48, top: 200, bottom: 248 }) as DOMRect;
    const list = host.querySelector('.turn-navigation-list') as HTMLElement | null;
    if (!list) return;
    list.getBoundingClientRect = () => ({ top: 200, bottom: 248 }) as any;
    Object.defineProperty(list, 'scrollTop', {
      configurable: true,
      get() {
        return (this as any)._top ?? 0;
      },
      set(v) {
        (this as any)._top = Math.max(0, Math.min(48, v));
      },
    });
    for (const [i, b] of [...host.querySelectorAll<HTMLElement>('.turn-navigation-mark')].entries())
      b.getBoundingClientRect = () =>
        ({ top: 200 + i * 12 - list.scrollTop, bottom: 212 + i * 12 - list.scrollTop, left: 12, right: 48, width: 36, height: 12 }) as any;
  };
  geometry();
  await tick();
  return {
    host,
    scroll,
    content,
    anchors,
    items,
    calls,
    update,
    geometry,
    marks: () => [...host.querySelectorAll<HTMLElement>('.turn-navigation-mark')],
    close: async () => {
      await act(() => root.unmount());
      host.remove();
      frames.clear();
    },
  };
}

test('the rail renders again only when its props change', async () => {
  const m = await mount();
  try {
    resetCommits();
    // the thread keeps the rail's props while a delta changes nothing it shows
    await m.update();
    assert.deepEqual(rendersOf('TurnNavigation'), []);
    await m.update({ items: m.items.slice(0, 5) });
    assert.equal(rendersOf('TurnNavigation').length, 1);
  } finally {
    await m.close();
  }
});

test('rail hides short chats but appears for older history or a bookmark', async () => {
  const m = await mount({ count: 3 });
  try {
    assert.equal(m.marks().length, 0);
    await m.update({ hasOlder: true });
    m.geometry();
    assert.equal(m.marks().length, 3);
    const older = m.host.querySelector('.turn-navigation-older')!;
    await fire(older, 'click');
    assert.deepEqual(m.calls, ['older']);
    await m.update({ loadingOlder: true });
    assert.equal((older as HTMLButtonElement).disabled, true);
    await m.update({ hasOlder: false });
    await act(() => nav.set({ navigationBookmarks: { c: [m.items[0].id] } }));
    assert.equal(m.marks().length, 3);
  } finally {
    await m.close();
  }
});

test('hover preview, focus, bookmarks and dismissal use the actual navigation component', async () => {
  const m = await mount();
  try {
    const marks = m.marks();
    await fire(marks[0], 'pointerover');
    await delay(160);
    assert.equal(document.querySelector('.turn-navigation-prompt')!.textContent, 'Question 0');
    assert.equal(document.querySelectorAll('.turn-navigation-outputs span').length, 3);
    assert.equal(document.querySelector('.turn-navigation-outputs')!.textContent, 'a.tsb.ts+1');
    assert.equal(document.querySelector('.turn-navigation-response img') === null, true);
    assert.equal(document.querySelector('.turn-navigation-response a') === null, true);
    const preview = document.querySelector('.turn-navigation-preview')!;
    await fire(preview, 'pointerover');
    await fire(document.querySelector('[aria-label="Bookmark message"]')!, 'click');
    await m.update();
    assert.equal(marks[0].classList.contains('bookmarked'), true);
    assert.equal(marks[0].getAttribute('aria-current'), 'true');
    await fire(document.querySelector('[aria-label="Remove bookmark"]')!, 'click');
    await m.update();
    assert.equal(marks[0].classList.contains('bookmarked'), false);
    await act(() => marks[1].focus());
    assert.equal((document.querySelector('[aria-label="Bookmark message"]') as HTMLButtonElement).disabled, true);
    await fire(marks[1], 'keydown', { key: 'End' });
    assert.equal(document.activeElement === marks[5], true);
    await fire(marks[5], 'keydown', { key: 'Home' });
    assert.equal(document.activeElement === marks[0], true);
    await fire(marks[0], 'keydown', { key: 'ArrowDown' });
    assert.equal(document.activeElement === marks[1], true);
    await fire(marks[1], 'keydown', { key: 'ArrowUp' });
    assert.equal(document.activeElement === marks[0], true);
    await fire(marks[0], 'keydown', { key: 'x' });
    await fire(marks[0], 'keydown', { key: 'Home', altKey: true });
    await fire(marks[0], 'click');
    assert.deepEqual(m.calls.at(-1), [m.items[0].id, undefined]);
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    await fire(marks[0], 'pointerover');
    await delay(160);
    await fire(document.querySelector('.turn-navigation-prompt')!, 'click');
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    await act(() => marks[2].focus());
    await fire(marks[2], 'keydown', { key: 'Escape' });
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    await act(() => marks[3].focus());
    await fire(m.host, 'mousedown');
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    await act(() => marks[0].focus());
    await fire(marks[0], 'pointerout');
    await delay(190);
    assert.ok(document.querySelector('.turn-navigation-preview'));
    await act(() => marks[0].blur());
    await fire(preview, 'pointerout');
    await delay(190);
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
  } finally {
    await m.close();
  }
});

test('current location follows transcript geometry and keyboard jumps stay in the focused view', async () => {
  const m = await mount();
  try {
    m.scroll.scrollTop = 600;
    await cross();
    await tick();
    assert.ok(m.marks()[2].classList.contains('current'));
    m.scroll.scrollTop = 1801;
    await fire(m.scroll, 'scrollend');
    await tick();
    assert.ok(m.marks()[5].classList.contains('current'));
    m.scroll.scrollTop = 316;
    await act(() => m.scroll.focus()); // native div needs tabindex
    m.scroll.tabIndex = 0;
    await act(() => m.scroll.focus());
    await fire(m.scroll, 'keydown', { key: 'ArrowDown', altKey: true });
    assert.deepEqual(m.calls.at(-1), [m.items[2].id, undefined]);
    await fire(m.scroll, 'keydown', { key: 'ArrowUp', altKey: true });
    assert.deepEqual(m.calls.at(-1), [m.items[1].id, undefined]);
    const count = m.calls.length;
    await fire(m.scroll, 'keydown', { key: 'ArrowDown' });
    await fire(m.scroll, 'keydown', { key: 'ArrowDown', altKey: true, ctrlKey: true });
    assert.equal(m.calls.length, count);
    const elsewhere = document.createElement('div');
    elsewhere.className = 'thread-view';
    document.body.append(elsewhere);
    await fire(elsewhere, 'keydown', { key: 'ArrowDown', altKey: true });
    assert.equal(m.calls.length, count);
    elsewhere.remove();
    await m.update({ inPane: true });
    await fire(document.body, 'keydown', { key: 'ArrowDown', altKey: true });
    assert.equal(m.calls.length, count);
    await m.update({ inPane: false });
    await fire(document.body, 'keydown', { key: 'ArrowDown', altKey: true });
    assert.equal(m.calls.length, count + 1);
    const modal = document.createElement('div');
    modal.setAttribute('role', 'dialog');
    document.body.append(modal);
    await fire(modal, 'keydown', { key: 'ArrowDown', altKey: true });
    assert.equal(m.calls.length, count + 1);
    modal.remove();
    m.scroll.scrollTop = 1900;
    await fire(m.scroll, 'keydown', { key: 'ArrowDown', altKey: true });
    assert.equal(m.calls.length, count + 1);
    await m.update({ items: [] });
    await fire(m.scroll, 'keydown', { key: 'ArrowUp', altKey: true });
  } finally {
    await m.close();
  }
});

test('pointer dragging jumps immediately, scrolls the mark list, and suppresses its release click', async (t) => {
  // No wall-clock time: the click guard's zero-delay reset, the release's close timer and the hover
  // backstop interval only run when the test advances the clock.
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const m = await mount();
  try {
    const marks = m.marks(),
      list = m.host.querySelector('.turn-navigation-list')!;
    await fire(marks[0], 'pointerdown', { button: 1, pointerId: 1, clientY: 206 });
    await fire(list, 'pointermove', { pointerId: 1, buttons: 1, clientY: 232 });
    assert.equal(m.calls.length, 0);
    await fire(marks[0], 'pointerdown', { button: 0, pointerId: 1, clientY: 206 });
    await fire(marks[0], 'pointerout');
    await fire(marks[1], 'pointerover');
    await fire(list, 'pointermove', { pointerId: 2, buttons: 1, clientY: 232 });
    await fire(list, 'pointermove', { pointerId: 1, buttons: 1, clientY: 210 }); // 4px: a jittery click, not a scrub
    assert.equal(m.calls.length, 0);
    await fire(list, 'pointermove', { pointerId: 1, buttons: 1, clientY: 232 });
    assert.equal(m.calls.at(-1)[1], true);
    await fire(list, 'pointermove', { pointerId: 1, buttons: 1, clientY: 255 });
    for (let i = 0; i < 15; i++) await tick();
    assert.equal((list as HTMLElement).scrollTop, 48);
    await fire(list, 'pointerup', { pointerId: 2 });
    const count = m.calls.length;
    await release(list, { pointerId: 1 }, marks[0]);
    assert.equal(m.calls.length, count);
    await act(() => t.mock.timers.tick(1));
    await fire(marks[0], 'click');
    assert.equal(m.calls.length, count + 1);
    await fire(marks[5], 'pointerdown', { button: 0, pointerId: 3, clientY: 232 });
    await fire(list, 'pointermove', { pointerId: 3, buttons: 1, clientY: 195 });
    for (let i = 0; i < 15; i++) await tick();
    assert.equal((list as HTMLElement).scrollTop, 0);
    await fire(list, 'pointercancel', { pointerId: 3 });
    await fire(list, 'lostpointercapture', { pointerId: 3 });
    await fire(marks[0], 'pointerdown', { button: 0, pointerId: 4, clientY: 206 });
    await fire(list, 'pointermove', { pointerId: 4, buttons: 0, clientY: 225 });
    await fire(list, 'wheel');
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
  } finally {
    await m.close();
  }
});

test('hidden or missing transcripts, removed previews and interrupted drags are safe', async () => {
  const m = await mount();
  try {
    m.scroll.scrollTop = 1801;
    await cross();
    await tick();
    m.scroll.scrollTop = 0;
    await cross();
    await tick();
    assert.equal((m.host.querySelector('.turn-navigation-list') as HTMLElement).scrollTop, 0);
    Object.defineProperty(m.scroll, 'clientHeight', { configurable: true, value: 0 });
    await fire(m.scroll, 'keydown', { altKey: true, key: 'ArrowDown' });
    assert.equal(m.calls.length, 0);
    Object.defineProperty(m.scroll, 'clientHeight', { configurable: true, value: 200 });
    await fire(document as any, 'keydown', { altKey: true, key: 'ArrowDown' });
    assert.ok(m.calls.length);
    const mark = m.marks()[0];
    await act(() => mark.focus());
    await m.update({ items: m.items.slice(1) });
    await tick();
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    const second = m.marks()[0],
      list = m.host.querySelector('.turn-navigation-list')!;
    await fire(second, 'pointerdown', { button: 0, pointerId: 9, clientY: 206 });
    await fire(list, 'pointermove', { pointerId: 9, buttons: 1, clientY: 249 });
    await m.update({ items: [] });
    await tick();
    await fire(document as any, 'keydown', { altKey: true, key: 'ArrowUp' });
    await m.update({ items: m.items, hasOlder: true, scrollRef: { current: null } });
    await tick();
    await fire(document as any, 'keydown', { altKey: true, key: 'ArrowUp' });
    await m.update({ items: [], scrollRef: { current: m.scroll } });
    await tick();
    await fire(document as any, 'keydown', { altKey: true, key: 'ArrowUp' });
  } finally {
    await m.close();
  }
});

test('pointer-focused marks dismiss after leaving while keyboard focus can reach the preview', async () => {
  const m = await mount();
  try {
    const mark = m.marks()[0];
    const matches = mark.matches.bind(mark);
    mark.matches = ((selector: string) => (selector === ':focus-visible' ? false : matches(selector))) as typeof mark.matches;
    await fire(mark, 'pointerdown', { button: 0, pointerId: 20, clientX: 20, clientY: 206 });
    await act(() => mark.focus());
    await fire(mark, 'pointerup', { pointerId: 20, clientX: 20, clientY: 206 });
    await fire(mark, 'click');
    assert.equal(document.activeElement === mark, true);
    await fire(mark, 'pointerout', { relatedTarget: m.scroll });
    await delay(190);
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    mark.matches = matches;
    await fire(mark, 'keydown', { key: 'ArrowDown' });
    await fire(m.marks()[1], 'keydown', { key: 'ArrowUp' });
    await fire(mark, 'pointerout', { relatedTarget: m.scroll });
    await delay(190);
    assert.ok(document.querySelector('.turn-navigation-preview'));
    const bookmark = document.querySelector('[aria-label="Bookmark message"]') as HTMLButtonElement;
    await act(() => bookmark.focus());
    await fire(bookmark, 'keydown', { key: 'Tab' });
    await fire(bookmark, 'pointerout', { relatedTarget: m.scroll });
    await delay(190);
    assert.ok(document.querySelector('.turn-navigation-preview'));
    await fire(bookmark, 'pointerdown', { button: 0 });
    await fire(bookmark, 'pointerout', { relatedTarget: m.scroll });
    await delay(190);
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
  } finally {
    await m.close();
  }
});

test('captured release outside closes the preview and cannot reopen it through a synthetic click', async () => {
  const m = await mount();
  try {
    const mark = m.marks()[0],
      list = m.host.querySelector('.turn-navigation-list')!;
    (m.host.querySelector('.turn-navigation') as HTMLElement).getBoundingClientRect = () =>
      ({ left: 12, right: 48, top: 200, bottom: 248 }) as DOMRect;
    const matches = mark.matches.bind(mark);
    mark.matches = ((selector: string) => (selector === ':focus-visible' ? false : matches(selector))) as typeof mark.matches;
    await fire(mark, 'pointerdown', { button: 0, pointerId: 21, clientX: 20, clientY: 206 });
    await act(() => mark.focus());
    await fire(mark, 'pointerout', { relatedTarget: m.scroll });
    await release(list, { pointerId: 21, clientX: 500, clientY: 500 }, mark);
    await delay(190);
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    assert.equal(m.calls.length, 0);
    await fire(mark, 'pointerover');
    await delay(160);
    const preview = document.querySelector('.turn-navigation-preview') as HTMLElement;
    preview.getBoundingClientRect = () => ({ left: 52, right: 300, top: 200, bottom: 320 }) as DOMRect;
    await fire(mark, 'pointerdown', { button: 0, pointerId: 22, clientX: 20, clientY: 206 });
    await fire(list, 'pointerup', { pointerId: 22, clientX: 60, clientY: 210 });
    await fire(preview, 'pointerover');
    await delay(190);
    assert.ok(document.querySelector('.turn-navigation-preview'));
    await fire(mark, 'pointerdown', { button: 0, pointerId: 23, clientX: 20, clientY: 206 });
    await fire(list, 'pointerup', { pointerId: 23, clientX: 20, clientY: 206 });
    await delay(190);
    assert.ok(document.querySelector('.turn-navigation-preview'));
  } finally {
    await m.close();
  }
});

test('scroll, resize, conversation switch and window blur clear stale navigation previews', async () => {
  const m = await mount();
  try {
    const mark = m.marks()[0],
      list = m.host.querySelector('.turn-navigation-list')!;
    const open = async () => {
      await fire(mark, 'pointerover');
      await delay(160);
      assert.ok(document.querySelector('.turn-navigation-preview'));
    };
    await open();
    await fire(m.scroll, 'scroll');
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    await open();
    await act(() => window.dispatchEvent(new window.Event('resize')));
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    await open();
    await m.update({ threadId: 'another' });
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    await open();
    await act(() => window.dispatchEvent(new window.Event('blur')));
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    await open();
    await fire(mark, 'pointerdown', { button: 0, pointerId: 24, clientY: 206 });
    await fire(list, 'pointermove', { pointerId: 24, buttons: 1, clientY: 250 });
    await fire(m.scroll, 'scroll');
    assert.ok(document.querySelector('.turn-navigation-preview'));
    await act(() => window.dispatchEvent(new window.Event('blur')));
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    assert.equal(captures.has(mark), false);
    const count = m.calls.length;
    await tick();
    await fire(list, 'pointermove', { pointerId: 24, buttons: 1, clientY: 250 });
    assert.equal(m.calls.length, count);
    await fire(mark, 'pointerdown', { button: 0, pointerId: 25, clientY: 206 });
    captures.delete(mark);
    await act(() => window.dispatchEvent(new window.Event('blur')));
    await fire(list, 'pointercancel', { pointerId: 25 });
  } finally {
    await m.close();
  }
});

test('every turn with any part on screen is current, as in Codex', async () => {
  const m = await mount();
  try {
    const current = () => m.marks().flatMap((mark, i) => (mark.classList.contains('current') ? [i] : []));
    // The viewport is 100-300; turns are 300px apart. At 450 the end of turn 1 and the start of turn 2 are both on screen.
    m.scroll.scrollTop = 450;
    await cross();
    await tick();
    assert.deepEqual(current(), [1, 2]);
    assert.deepEqual(
      m.marks().map((mark) => mark.getAttribute('aria-current')),
      [null, 'true', 'true', null, null, null],
    );
    // A turn whose last 16px or less is left at the top no longer counts.
    m.scroll.scrollTop = 585;
    await cross();
    await tick();
    assert.deepEqual(current(), [2]);
    // The last turn runs to the end of the transcript.
    m.scroll.scrollTop = 1800;
    await cross();
    await tick();
    assert.deepEqual(current(), [5]);
  } finally {
    await m.close();
  }
});

test('a bookmarked mark shows a dot and a pressed rail drops mark transitions until release', async () => {
  const m = await mount({ saved: [navigationId('t', 'u2')] });
  try {
    const dots = () => m.marks().map((mark) => !!mark.querySelector('.turn-navigation-bookmark-dot'));
    assert.deepEqual(dots(), [false, false, true, false, false, false]);
    const list = m.host.querySelector('.turn-navigation-list')!;
    await fire(m.marks()[0], 'pointerdown', { button: 0, pointerId: 30, clientX: 20, clientY: 206 });
    assert.equal(list.hasAttribute('data-scrubbing'), true);
    await fire(list, 'pointerup', { pointerId: 30, clientX: 20, clientY: 206 });
    assert.equal(list.hasAttribute('data-scrubbing'), false);
    await fire(m.marks()[0], 'pointerdown', { button: 0, pointerId: 31, clientX: 20, clientY: 206 });
    await act(() => window.dispatchEvent(new window.Event('blur') as any));
    assert.equal(list.hasAttribute('data-scrubbing'), false);
  } finally {
    await m.close();
  }
});

test('marks share one length at rest and only the hovered mark and its three neighbors grow', async () => {
  const m = await mount({ count: 10 });
  try {
    const distance = (index: number) => m.marks()[index].dataset.neighborDistance;
    const resting = () => m.marks().every((mark) => mark.dataset.neighborDistance === undefined);
    // The current message is highlighted, not lengthened.
    assert.ok(m.marks()[0].classList.contains('current'));
    assert.ok(resting());
    await fire(m.marks()[5], 'pointerover');
    assert.deepEqual(
      m.marks().map((mark) => mark.dataset.neighborDistance),
      [undefined, undefined, '3', '2', '1', '0', '1', '2', '3', undefined],
    );
    assert.ok(m.marks()[5].classList.contains('hovered'));
    // Clicking jumps but the pointer is still on the mark, so it stays emphasized.
    await fire(m.marks()[5], 'click');
    assert.deepEqual(m.calls.at(-1), [m.items[5].id, undefined]);
    assert.equal(distance(5), '0');
    assert.equal(document.querySelector('.turn-navigation-preview'), null);
    // The jump scrolls the transcript under a pointer that is still on the mark: the card hides, the emphasis stays.
    await fire(m.marks()[5], 'pointerover');
    await delay(160);
    assert.ok(document.querySelector('.turn-navigation-preview'));
    await fire(m.scroll, 'scroll');
    assert.equal(document.querySelector('.turn-navigation-preview'), null);
    assert.equal(distance(5), '0');
    await fire(m.host, 'pointermove');
    await delay(190);
    assert.ok(resting());
    // Scrubbing also emphasizes the mark under the pointer.
    await fire(m.marks()[1], 'pointerdown', { button: 0, pointerId: 31, clientY: 218 });
    await fire(m.host.querySelector('.turn-navigation-list')!, 'pointermove', { pointerId: 31, buttons: 1, clientY: 230 });
    assert.equal(distance(2), '0');
    assert.equal(distance(0), '2');
    await fire(m.host.querySelector('.turn-navigation-list')!, 'pointercancel', { pointerId: 31 });
    assert.ok(resting());
  } finally {
    await m.close();
  }
});

test('document movement dismisses missed leaves without postponing the deadline', async () => {
  const m = await mount();
  try {
    const mark = m.marks()[0];
    await fire(m.host, 'pointermove'); // Closed navigation has no timer to cancel.
    await fire(mark, 'pointerover');
    await delay(160);
    await fire(m.host, 'pointermove');
    await delay(100);
    await fire(m.host, 'pointermove');
    await delay(100);
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    // Leaving during the delayed open cancels the pending preview.
    await fire(mark, 'pointerover');
    await fire(m.host, 'pointermove');
    await delay(190);
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    await fire(mark, 'pointerover');
    await delay(160);
    await fire(m.host, 'pointermove');
    await delay(80);
    const preview = document.querySelector('.turn-navigation-preview')!;
    await fire(preview, 'pointermove');
    await delay(190);
    assert.ok(document.querySelector('.turn-navigation-preview'));
    await fire(mark, 'pointermove');
    await delay(190);
    assert.ok(document.querySelector('.turn-navigation-preview'));
    await fire(m.host, 'pointermove');
    await delay(190);
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
  } finally {
    await m.close();
  }
});

test('pointer focus cannot reopen a jumped preview and other popovers dismiss it', async () => {
  const m = await mount();
  try {
    const mark = m.marks()[0],
      matches = mark.matches.bind(mark);
    mark.matches = ((selector: string) => (selector === ':focus-visible' ? false : matches(selector))) as typeof mark.matches;
    await fire(mark, 'pointerover');
    await delay(160);
    await fire(mark, 'pointerdown', { button: 0, pointerId: 40, clientX: 20, clientY: 206 });
    await act(() => mark.focus());
    await fire(mark, 'pointerup', { pointerId: 40, clientX: 20, clientY: 206 });
    await fire(mark, 'click');
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    assert.deepEqual(m.calls.at(-1), [m.items[0].id, undefined]);
    await act(() => mark.blur());
    await act(() => mark.focus());
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    await fire(mark, 'pointerover');
    await delay(160);
    const bookmark = document.querySelector('[aria-label="Bookmark message"]')!;
    await fire(bookmark, 'pointerdown');
    await fire(bookmark, 'click');
    await m.update();
    assert.ok(document.querySelector('.turn-navigation-preview'));
    const other = document.createElement('div');
    other.className = 'popover-layer';
    document.body.append(other);
    await fire(other, 'pointerdown');
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
    other.remove();
    mark.matches = matches;
    await act(() => mark.blur());
    await act(() => mark.focus());
    assert.ok(document.querySelector('.turn-navigation-preview'));
    await fire(m.host, 'pointermove');
    await delay(190);
    assert.equal(!!document.querySelector('.turn-navigation-preview'), false);
  } finally {
    await m.close();
  }
});

test('main and side views share a single preview including delayed opens and unmounts', async () => {
  const main = await mount(),
    side = await mount({ props: { threadId: 'side', inPane: true } });
  try {
    const mainMark = main.marks()[0],
      sideMark = side.marks()[1];
    await fire(mainMark, 'pointerover');
    await delay(160);
    assert.equal(document.querySelectorAll('.turn-navigation-preview').length, 1);
    await fire(sideMark, 'pointerover');
    assert.equal(document.querySelectorAll('.turn-navigation-preview').length, 0);
    await delay(160);
    assert.equal(document.querySelectorAll('.turn-navigation-preview').length, 1);
    assert.equal(document.querySelector('.turn-navigation-prompt')!.textContent, 'Question 1');
    await fire(mainMark, 'pointerover');
    await act(() => sideMark.focus());
    await delay(160);
    assert.equal(document.querySelectorAll('.turn-navigation-preview').length, 1);
    assert.equal(document.querySelector('.turn-navigation-prompt')!.textContent, 'Question 1');
    // Unmounting an inactive view must not release the other view's ownership.
    await main.close();
    assert.equal(document.querySelectorAll('.turn-navigation-preview').length, 1);
  } finally {
    if (main.host.isConnected) await main.close();
    await side.close();
  }
  assert.equal(document.querySelectorAll('.turn-navigation-preview').length, 0);
  const next = await mount();
  try {
    await fire(next.marks()[0], 'pointerover');
    await next.close();
    await delay(160);
    assert.equal(document.querySelectorAll('.turn-navigation-preview').length, 0);
  } finally {
    if (next.host.isConnected) await next.close();
  }
});

test('pointer entry replaces keyboard focus and rapid hovering leaves no stuck cards', async () => {
  const m = await mount();
  try {
    const marks = m.marks();
    await act(() => marks[0].focus());
    assert.equal(document.querySelectorAll('.turn-navigation-preview').length, 1);
    for (const mark of marks.slice(1, 4)) await fire(mark, 'pointerover');
    await delay(160);
    assert.equal(document.querySelectorAll('.turn-navigation-preview').length, 1);
    assert.equal(document.querySelector('.turn-navigation-prompt')!.textContent, 'Question 3');
    // No pointermove is needed to switch from keyboard to pointer interaction.
    await fire(marks[3], 'pointerout', { relatedTarget: m.scroll });
    await delay(190);
    assert.equal(document.querySelectorAll('.turn-navigation-preview').length, 0);
  } finally {
    await m.close();
  }
});

test('a hover or preview whose leave event never arrives is cleared once the pointer is no longer over the rail', async () => {
  const m = await mount();
  try {
    const mark = m.marks()[0];
    // Hover emphasis without a preview card.
    await fire(mark, 'pointerover');
    assert.ok(mark.classList.contains('hovered'));
    pointerOver = false;
    await delay(300);
    assert.equal(mark.classList.contains('hovered'), false);
    assert.equal(document.querySelector('.turn-navigation-preview') === null, true);
    // An open preview card.
    pointerOver = true;
    await fire(mark, 'pointerover');
    await delay(160);
    assert.ok(document.querySelector('.turn-navigation-preview'));
    await delay(300);
    assert.ok(document.querySelector('.turn-navigation-preview'), 'pointer still over the rail keeps the card');
    pointerOver = false;
    await delay(300);
    assert.equal(document.querySelector('.turn-navigation-preview') === null, true);
    // A pointer press or pending open timer is never interrupted.
    pointerOver = true;
    await fire(mark, 'pointerover');
    pointerOver = false;
    await fire(mark, 'pointerdown', { button: 0, pointerId: 31, clientY: 206 });
    await delay(300);
    assert.ok(mark.classList.contains('hovered'));
    await fire(m.host.querySelector('.turn-navigation-list')!, 'pointercancel', { pointerId: 31 });
    // Keyboard focus keeps the preview reachable even without a pointer.
    pointerOver = true;
    await fire(mark, 'pointerover');
    pointerOver = false;
    await act(() => mark.focus());
    await fire(m.host.querySelector('.turn-navigation')!, 'keydown', { key: 'Tab' });
    await delay(300);
    assert.ok(mark.classList.contains('hovered'));
  } finally {
    pointerOver = true;
    await m.close();
  }
});

test('a stale keyboard flag cannot keep a preview open after focus leaves without a blur event', async () => {
  const m = await mount();
  const descriptor = Object.getOwnPropertyDescriptor(document, 'activeElement');
  try {
    const mark = m.marks()[0];
    pointerOver = false;
    await act(() => mark.focus());
    await delay(300);
    assert.ok(document.querySelector('.turn-navigation-preview'), 'actual keyboard focus retains the preview');
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => document.body });
    await delay(300);
    assert.equal(document.querySelector('.turn-navigation-preview'), null);
  } finally {
    if (descriptor) Object.defineProperty(document, 'activeElement', descriptor);
    else delete (document as any).activeElement;
    pointerOver = true;
    await m.close();
  }
});

test('native window focus loss dismisses the preview without relying on a DOM blur', async () => {
  const m = await mount();
  try {
    await act(() => m.marks()[0].focus());
    assert.ok(document.querySelector('.turn-navigation-preview'));
    await act(() => nav.set({ focused: false }));
    assert.equal(document.querySelector('.turn-navigation-preview'), null);
    await act(() => nav.set({ focused: true }));
    assert.equal(document.querySelector('.turn-navigation-preview'), null, 'regaining focus does not reopen the card');
  } finally {
    await m.close();
  }
});
