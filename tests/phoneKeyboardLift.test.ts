// A page shown as a native sheet lifts its bottom bar by the keyboard's reach from the screen's bottom (iOS), since the app frame's keyboard avoidance does not reach into the sheet; New chat uses it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';

const liftPath = '../mobile/src/useKeyboardLift';
const { liftFor, liftTiming, useKeyboardLift } = await import(liftPath);
const timings = () => ((globalThis as any).__phoneTimings ?? []) as { to: number; config: any }[];

const listeners = () => (globalThis as any).__keyboardListeners as Record<string, (e?: any) => void>;

async function mount() {
  const lifts: { value: number }[] = [];
  const Probe = () => {
    lifts.push(useKeyboardLift());
    return null;
  };
  // the shared value the hook returns; its number is what a style reads on the UI thread
  const seen = { at: () => lifts.at(-1)!.value };
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(async () => root.render(createElement(Probe)));
  return { seen, unmount: () => act(async () => root.unmount()) };
}

test('the lift is the keyboard’s reach from the screen’s bottom, never negative, and moves on the event’s length', () => {
  assert.equal(liftTiming({ duration: 250 }).duration, 250);
  assert.equal(liftTiming({}).duration, 300);
  assert.equal(liftTiming().duration, 300);
  assert.equal(liftFor(926, 606), 320);
  assert.equal(liftFor(926, 926), 0);
  assert.equal(liftFor(926, 1000), 0);
  assert.equal(liftFor(926, 605.6), 320);
});

test('on iOS the lift follows the keyboard’s frame and goes back to 0 when it hides; its listeners go with the page', async () => {
  (globalThis as any).__phonePlatform = 'ios';
  (globalThis as any).__keyboardRemoved = [];
  try {
    const { seen, unmount } = await mount();
    assert.equal(seen.at(), 0);
    // the page sheet measured from inside starts at 0: the screen's bottom is what counts, not the sheet's height
    (globalThis as any).__phoneTimings = [];
    await act(async () => listeners().keyboardWillChangeFrame({ duration: 250, endCoordinates: { screenY: 606, height: 320 } }));
    assert.deepEqual(
      timings().at(-1),
      { to: 320, config: { duration: 250, easing: { bezier: [0.32, 0.72, 0, 1] } } },
      'on the keyboard’s own length',
    );
    assert.equal(seen.at(), 320);
    await act(async () => listeners().keyboardWillHide({ duration: 200 }));
    assert.equal(seen.at(), 0);
    assert.equal(timings().at(-1)!.config.duration, 200);
    await act(async () => listeners().keyboardWillHide());
    assert.equal(timings().at(-1)!.config.duration, 300, 'an event without a length takes a sheet’s');
    await unmount();
    assert.deepEqual((globalThis as any).__keyboardRemoved.sort(), ['keyboardWillChangeFrame', 'keyboardWillHide']);
  } finally {
    delete (globalThis as any).__phonePlatform;
  }
});

test('on Android nothing listens: the window resizes for the keyboard itself', async () => {
  (globalThis as any).__phonePlatform = 'android';
  (globalThis as any).__keyboardListeners = {};
  try {
    const { seen, unmount } = await mount();
    assert.deepEqual(Object.keys(listeners()), []);
    assert.equal(seen.at(), 0);
    await unmount();
  } finally {
    delete (globalThis as any).__phonePlatform;
  }
});

test('a bottom sheet rides the inset it is given (New chat passes its keyboard lift), and none by default', async () => {
  const sheetPath = '../mobile/src/components/BottomSheet';
  const { BottomSheet } = await import(sheetPath);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  // the stand-in renders a view's style as JSON in data-style
  const paddingOf = () => JSON.parse((host.firstElementChild as HTMLElement).getAttribute('data-style') ?? '{}').paddingBottom;
  const sheet = (props: object) =>
    createElement(BottomSheet, { open: true, title: 'Dictate', onClose() {}, ...props }, createElement('span', null, 'Use text'));
  await act(async () => root.render(sheet({})));
  assert.equal(paddingOf(), 0, 'frames that already avoid the keyboard (Thread, MoMo) are not lifted twice');
  await act(async () => root.render(sheet({ keyboardInset: { value: 320 } })));
  assert.equal(paddingOf(), 320, 'the sheet sits 320 pt up, on top of the keyboard');
  await act(async () => root.unmount());
});

test('New chat gives its Dictate sheet the keyboard lift', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../mobile/src/screens/NewChat.tsx', import.meta.url), 'utf8');
  assert.match(source, /title="Dictate"[\s\S]{0,120}keyboardInset=\{lift\}/);
});
