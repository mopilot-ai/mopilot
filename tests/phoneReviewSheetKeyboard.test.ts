// The quick review's native sheet is outside the app frame's keyboard avoidance: while a question card's free-text field is typed in, the sheet lifts its bottom by the keyboard so its buttons stay reachable, and goes back when the keyboard hides.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from './support/phone/component-kit';
import { mount, runtimeFor, sheet, CARD } from './support/phone/review-kit';

const listeners = () => (globalThis as any).__keyboardListeners as Record<string, (e?: any) => void>;
const bottom = (host: HTMLElement) => JSON.parse(frame(host).getAttribute('data-style') ?? '{}').paddingBottom;
const frame = (host: HTMLElement) =>
  [...host.querySelectorAll('div')].find((d) => d.hasAttribute('keyboardshouldpersisttaps'))!.parentElement as HTMLElement;

test('the sheet lifts its bottom by the keyboard and lets it go, moving over the keyboard’s own length', async () => {
  (globalThis as any).__phonePlatform = 'ios';
  (globalThis as any).__phoneTimings = [];
  const moves = () => (globalThis as any).__phoneTimings as { to: number; config: { duration: number } }[];
  try {
    const v = await mount(sheet(runtimeFor({ cards: [CARD] }).runtime));
    assert.equal(bottom(v.host), 28, 'its own bottom inset with no keyboard');
    await act(async () => listeners().keyboardWillChangeFrame({ duration: 250, endCoordinates: { screenY: 606, height: 320 } }));
    assert.deepEqual([moves().at(-1)!.to, moves().at(-1)!.config.duration], [320, 250], 'the keyboard’s reach from the screen’s bottom');
    await act(async () => listeners().keyboardWillHide({ duration: 200 }));
    assert.deepEqual([moves().at(-1)!.to, moves().at(-1)!.config.duration], [0, 200], 'and back to its own inset');
  } finally {
    delete (globalThis as any).__phonePlatform;
  }
});
