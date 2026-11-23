// Alt+Arrow reads one scoped anchor snapshot per keypress, including virtualized gaps and live DOM replacements.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { act, createElement as h } from 'react';
import { createRoot } from 'react-dom/client';
import { fakeStore, iconStubs, mockSource, stubStore } from './support/stubs.ts';

const nav = fakeStore<any>({ navigationBookmarks: {}, focused: true });
stubStore({ useStore: nav.useStore, toggleNavigationBookmark: () => {} });
mockSource('src/components/ui/icons.tsx', iconStubs());
(globalThis as any).requestAnimationFrame = () => 1;
(globalThis as any).cancelAnimationFrame = () => {};
(globalThis as any).IntersectionObserver = class {
  observe() {}
  disconnect() {}
};
const { TurnNavigation } = await import('../src/components/thread/TurnNavigation.tsx');
const { navigationTops } = await import('../src/components/thread/navigationVisibility.ts');

async function mount(count: number) {
  const host = document.createElement('div');
  host.className = 'thread-view';
  const scroll = document.createElement('div');
  const rail = document.createElement('div');
  host.append(scroll, rail);
  document.body.append(host);
  Object.defineProperty(scroll, 'clientHeight', { value: 200 });
  scroll.getBoundingClientRect = () => ({ top: 100, bottom: 300 }) as DOMRect;
  let queries = 0,
    idReads = 0,
    positionReads = 0;
  const query = scroll.querySelectorAll.bind(scroll);
  scroll.querySelectorAll = ((selector: string) => {
    if (selector === '[data-navigation-id]') queries++;
    return query(selector);
  }) as typeof scroll.querySelectorAll;
  const items = Array.from({ length: count }, (_, i) => ({
    id: `message${i}`,
    prompt: `Question ${i}`,
    response: '',
    outputs: [],
    canBookmark: true,
    find: { said: `Question ${i}`, replies: [] },
  }));
  const anchor = (id: string, top: number) => {
    const el = document.createElement('div');
    el.dataset.navigationId = id;
    const dataset = el.dataset;
    Object.defineProperty(el, 'dataset', { configurable: true, get: () => (idReads++, dataset) });
    el.getBoundingClientRect = () => (positionReads++, { top: top - scroll.scrollTop }) as DOMRect;
    return el;
  };
  const anchors = items.map((item, i) => anchor(item.id, 100 + 300 * i));
  scroll.append(...anchors);
  const calls: string[] = [];
  const root = createRoot(rail);
  await act(() =>
    root.render(
      h(TurnNavigation, {
        threadId: 'chat',
        items,
        scrollRef: { current: scroll },
        inPane: false,
        hasOlder: false,
        loadingOlder: false,
        onLoadOlder: async () => {},
        onNavigate: (id: string) => calls.push(id),
      }),
    ),
  );
  queries = idReads = positionReads = 0;
  return {
    scroll,
    items,
    anchors,
    anchor,
    calls,
    counts: () => ({ queries, idReads, positionReads }),
    key: async (key: string) => {
      const e = new window.KeyboardEvent('keydown', { key, altKey: true, bubbles: true, cancelable: true });
      await act(() => scroll.dispatchEvent(e as any));
      return e.defaultPrevented;
    },
    close: async () => {
      await act(() => root.unmount());
      host.remove();
    },
  };
}

test('Alt+Arrow indexes the transcript anchors once rather than once per message', async () => {
  const m = await mount(200);
  try {
    assert.equal(await m.key('ArrowDown'), true);
    assert.deepEqual(m.calls, ['message1']);
    assert.deepEqual(m.counts(), { queries: 1, idReads: 200, positionReads: 200 });
    m.scroll.scrollTop = 650;
    assert.equal(await m.key('ArrowUp'), true);
    assert.deepEqual(m.calls, ['message1', 'message2']);
    assert.deepEqual(m.counts(), { queries: 2, idReads: 400, positionReads: 400 });
  } finally {
    await m.close();
  }
});

test('Alt+Arrow keeps virtualized gaps and observes replaced anchors on the next keypress', async () => {
  const m = await mount(4);
  try {
    m.anchors[1].remove();
    assert.equal(await m.key('ArrowDown'), true);
    assert.deepEqual(m.calls, ['message1']);
    // The first DOM match owns an ID, even if a later duplicate would imply another destination.
    m.scroll.prepend(m.anchor('message0', 2000));
    m.scroll.scrollTop = 650;
    assert.equal(await m.key('ArrowUp'), false);
    // Removing that duplicate must immediately restore the current anchor and its new position.
    m.scroll.firstElementChild!.remove();
    assert.equal(await m.key('ArrowUp'), true);
    assert.deepEqual(m.calls, ['message1', 'message2']);
    assert.equal(m.counts().queries, 3);
  } finally {
    await m.close();
  }
});

test('position projection preserves first matches, empty and opaque IDs, missing anchors and transcript scope', () => {
  const scroll = document.createElement('div');
  const elsewhere = document.createElement('div');
  const id = '["turn\\n\\\"", "item\\\\"]';
  const anchor = (id: string, top: number) => {
    const el = document.createElement('div');
    el.dataset.navigationId = id;
    el.getBoundingClientRect = () => ({ top }) as DOMRect;
    return el;
  };
  scroll.append(anchor('', 0), anchor(id, -20), anchor(id, 500));
  elsewhere.append(anchor(id, 900));
  const stray = anchor('unlisted', 100);
  stray.getBoundingClientRect = () => {
    throw new Error('Unlisted anchors need no position read');
  };
  scroll.append(stray);
  assert.deepEqual(navigationTops(scroll, [{ id }, { id: 'missing' }, { id: '' }, { id }]), [-20, undefined, 0, -20]);
  assert.deepEqual(navigationTops(elsewhere, [{ id }]), [900]);
  scroll.children[1].remove();
  assert.deepEqual(navigationTops(scroll, [{ id }]), [500]);
  assert.deepEqual(navigationTops(scroll, []), []);
  assert.deepEqual(navigationTops(document.createElement('div'), [{ id }]), [undefined]);
});
