import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act } from 'react';
import { fakeStore, render, click, flush } from './support/shell-chrome-kit.ts';
import { stubStore } from './support/stubs.ts';

const store = fakeStore<any>({ threadsCursor: null });
const loads: boolean[] = [];
let finish: () => void = () => {};
stubStore({ useStore: store.useStore, loadThreads: (more: boolean) => (loads.push(more), new Promise<void>((r) => (finish = r))) });
const { MoreChats } = await import('../src/components/sidebar/MoreChats.tsx');

const inScroller = () => createElement('div', { className: 'sidebar-scroll' }, createElement(MoreChats));
function metrics(el: Element, m: { scrollTop: number; clientHeight: number; scrollHeight: number }) {
  for (const [k, v] of Object.entries(m)) Object.defineProperty(el, k, { configurable: true, value: v });
}
const scroll = (el: Element) => act(async () => el.dispatchEvent(new (globalThis as any).window.Event('scroll')));
const settle = async () => {
  await act(async () => finish());
  await flush();
};

test('nothing is shown while there is no next page', async () => {
  store.reset({ threadsCursor: null });
  const { host, unmount } = await render(inScroller());
  assert.equal(host.querySelector('[data-testid="more-chats"]'), null);
  await unmount();
});

test('"Show more chats" loads the next page once, reading "Loading…" until it arrives', async () => {
  store.reset({ threadsCursor: 'c1' });
  loads.length = 0;
  const { host, unmount } = await render(inScroller());
  const button = host.querySelector('[data-testid="more-chats"]') as HTMLButtonElement;
  assert.equal(button.textContent, 'Show more chats');
  assert.equal(button.disabled, false);
  await click(button);
  assert.deepEqual(loads, [true]);
  assert.equal(button.textContent, 'Loading…');
  assert.equal(button.disabled, true);
  await click(button);
  assert.deepEqual(loads, [true], 'a disabled button does not load again');
  await settle();
  assert.equal(button.textContent, 'Show more chats');
  assert.equal(button.disabled, false);
  await unmount();
});

test('scrolling the sidebar near its end loads the next page; scrolling elsewhere does not', async () => {
  store.reset({ threadsCursor: 'c1' });
  loads.length = 0;
  const { host, unmount } = await render(inScroller());
  const scroller = host.querySelector('.sidebar-scroll')!;
  metrics(scroller, { scrollTop: 100, clientHeight: 400, scrollHeight: 1000 });
  await scroll(scroller);
  assert.deepEqual(loads, []);
  metrics(scroller, { scrollTop: 520, clientHeight: 400, scrollHeight: 1000 });
  // two scroll events before the re-render still start only one request
  await act(async () => {
    scroller.dispatchEvent(new (globalThis as any).window.Event('scroll'));
    scroller.dispatchEvent(new (globalThis as any).window.Event('scroll'));
  });
  assert.deepEqual(loads, [true]);
  // while loading the listener is detached
  await scroll(scroller);
  assert.deepEqual(loads, [true]);
  await settle();
  await scroll(scroller);
  assert.deepEqual(loads, [true, true]);
  await settle();
  // once the last page is in, the row disappears and scrolling does nothing
  await act(async () => store.setState({ threadsCursor: null }));
  assert.equal(host.querySelector('[data-testid="more-chats"]'), null);
  await scroll(scroller);
  assert.deepEqual(loads, [true, true]);
  await unmount();
});

test('outside a scrolling sidebar the button still works and nothing listens for scrolls', async () => {
  store.reset({ threadsCursor: 'c1' });
  loads.length = 0;
  const { host, unmount } = await render(createElement(MoreChats));
  await scroll(host);
  assert.deepEqual(loads, []);
  await click(host.querySelector('[data-testid="more-chats"]'));
  assert.deepEqual(loads, [true]);
  await settle();
  await unmount();
});
