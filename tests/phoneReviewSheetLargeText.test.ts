// At a large text size the quick review's footer (Open chat, Close) scrolls with the card instead of taking half the sheet, so no choice is hidden behind it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mount, runtimeFor, sheet, CARD } from './support/phone/review-kit';

const scroller = (host: HTMLElement) => [...host.querySelectorAll('div')].find((d) => d.hasAttribute('keyboardshouldpersisttaps'));

async function open(fontScale: number) {
  (globalThis as any).__phoneFontScale = fontScale;
  const v = await mount(sheet(runtimeFor({ cards: [CARD] }).runtime));
  const button = (name: string) => [...v.host.querySelectorAll('button')].find((b) => b.textContent === name)!;
  return { ...v, button, scroll: scroller(v.host)!, reset: () => ((globalThis as any).__phoneFontScale = undefined) };
}

test('at the standard size the footer is below the scrolling cards, not in them', async () => {
  const v = await open(1);
  assert.ok(v.scroll, 'the cards scroll');
  assert.ok(v.scroll.contains(v.button('Allow once')), 'the card is in the scrolling part');
  assert.ok(!v.scroll.contains(v.button('Open chat')), 'the footer stays under it');
  v.reset();
});

test('at a large size the footer is the end of what scrolls, so every choice can be reached', async () => {
  const v = await open(2);
  assert.ok(v.scroll.contains(v.button('Allow once')));
  assert.ok(v.scroll.contains(v.button('Open chat')), 'Open chat scrolls with the card');
  assert.ok(v.scroll.contains(v.button('Close')), 'Close scrolls with the card');
  v.reset();
});
