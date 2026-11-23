// FoldedText: a long message folds to a fixed height with Show more; a short one is left alone; the measure follows the text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, render, settle, window } from './support/thread-kit.ts';

mockStore();
const { FoldedText, FOLD_CLAMP_PX } = await import('../src/components/ui/FoldedText.tsx');

// happy-dom does no layout: text measures tall when it is long, and nothing at all while `hidden` says it is not shown
let hidden = false;
Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', {
  configurable: true,
  get(this: HTMLElement) {
    if (hidden) return 0;
    return this.classList.contains('fold-text') && (this.textContent ?? '').length > 100 ? FOLD_CLAMP_PX + 1 : 0;
  },
});
// a ResizeObserver the test fires by hand, as the box showing or changing width would
const observers = new Set<{ fire(): void }>();
(globalThis as any).ResizeObserver = class {
  cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
  }
  observe() {
    observers.add(this as any);
  }
  disconnect() {
    observers.delete(this as any);
  }
  fire() {
    this.cb();
  }
};
const resize = () => settle(() => observers.forEach((o) => o.fire()));

const text = (el: Element | null | undefined) => el?.textContent?.trim() ?? '';
const LONG = 'Long message. '.repeat(20);

test('a long text folds to the clamp height; Show more opens it and Show less folds it again', async () => {
  const v = await render(h(FoldedText, { text: LONG }));
  const body = v.$('.fold-text')!;
  assert.match(body.className, /clamped/);
  assert.equal(body.style.maxHeight, `${FOLD_CLAMP_PX}px`);
  const more = v.$('.fold-more') as HTMLButtonElement;
  assert.equal(text(more), 'Show more');
  assert.equal(more.getAttribute('aria-expanded'), 'false');
  await settle(() => more.click());
  assert.doesNotMatch(body.className, /clamped/);
  assert.equal(body.style.maxHeight, '');
  assert.equal(text(v.$('.fold-more')), 'Show less');
  assert.equal(v.$('.fold-more')!.getAttribute('aria-expanded'), 'true');
  await settle(() => (v.$('.fold-more') as HTMLButtonElement).click());
  assert.match(body.className, /clamped/);
});

test('a short text has no button and no clamp', async () => {
  const v = await render(h(FoldedText, { text: 'Check' }));
  assert.equal(text(v.$('.fold-text')), 'Check');
  assert.doesNotMatch(v.$('.fold-text')!.className, /clamped/);
  assert.equal(v.$('.fold-more'), null);
});

test('an empty text has nothing to fold', async () => {
  const v = await render(h(FoldedText, { text: '' }));
  assert.equal(v.$('.fold-more'), null);
});

test('children are drawn in place of the text, and the clamp can be set', async () => {
  const v = await render(h(FoldedText, { text: LONG, clamp: 50 }, h('a', { href: '#x' }, 'linked '.repeat(20))));
  assert.match(text(v.$('.fold-text a')), /^linked linked/);
  assert.equal(v.$('.fold-text')!.style.maxHeight, '50px');
});

test('the measure runs again when the text changes: a bubble that grows folds, one that shrinks unfolds', async () => {
  const host = await render(h(FoldedText, { text: 'short' }));
  assert.equal(host.$('.fold-more'), null);
  await settle(() => host.rerender(h(FoldedText, { text: LONG })));
  assert.equal(text(host.$('.fold-more')), 'Show more');
  await settle(() => host.rerender(h(FoldedText, { text: 'short again' })));
  assert.equal(host.$('.fold-more'), null);
  assert.doesNotMatch(host.$('.fold-text')!.className, /clamped/);
});

test('a bubble mounted hidden measures nothing, then folds once it shows (a pane tab brought to the front)', async () => {
  hidden = true;
  const v = await render(h(FoldedText, { text: LONG }));
  assert.equal(v.$('.fold-more'), null, 'hidden: nothing measured');
  hidden = false;
  await resize();
  assert.equal(text(v.$('.fold-more')), 'Show more');
  assert.match(v.$('.fold-text')!.className, /clamped/);
});

test('a box that resizes measures again, and the observer goes with the bubble', async () => {
  const v = await render(h(FoldedText, { text: LONG }));
  assert.equal(observers.size, 1);
  hidden = true; // as a column wide enough to hold it all
  await resize();
  assert.equal(v.$('.fold-more'), null);
  hidden = false;
  await resize();
  assert.equal(text(v.$('.fold-more')), 'Show more');
  await v.unmount();
  assert.equal(observers.size, 0);
});
