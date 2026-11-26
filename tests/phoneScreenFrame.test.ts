// The frame every screen sits in lifts it above the iOS keyboard (a real iPhone showed the composer, the terminal input and pairing's Continue under it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
// variable paths: tsconfig.node.json includes tests/*.ts, and a static import would pull React Native's types (setTimeout as a number) into the Node project
const uiPath = '../mobile/src/components/ui';
const framePath = '../mobile/src/remote/frameLift';
const appPath = '../mobile/src/MobileApp';
const { ScreenFrame } = await import(uiPath);
const { useFrameLift, useComposerGrowth } = await import(framePath);
const { MobileApp } = await import(appPath);

const behaviorOf = (host: HTMLElement) => host.querySelector('[data-keyboard-behavior]')?.getAttribute('data-keyboard-behavior');
const g = globalThis as any;
const render = async (platform: string) => {
  g.__phonePlatform = platform;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(ScreenFrame, null, createElement('button', { 'aria-label': 'bar' }))));
  return { host, done: async () => (await act(async () => root.unmount()), host.remove()) };
};
/** The padding the frame gives its content: iOS lifts it by the keyboard's own height, read in every frame; Android pads through KeyboardAvoidingView. */
const liftOf = (host: HTMLElement) => {
  const frame = host.querySelector('[data-safe-area-provider] > [data-style] > [data-style]') as HTMLElement | null;
  return frame ? JSON.parse(frame.dataset.style!).paddingBottom : undefined;
};

test('on iOS the frame lifts its content by the keyboard’s height less the home indicator’s, on edge-to-edge Android it pads through KeyboardAvoidingView', async () => {
  g.__safeAreaInsets = { top: 47, bottom: 34, left: 0, right: 0 };
  g.__phoneKeyboardHeight = 0;
  const ios = await render('ios');
  assert.equal(liftOf(ios.host), 0, 'no keyboard, no lift');
  assert.equal(behaviorOf(ios.host), undefined, 'the keyboard avoiding view is not used on iOS');
  assert.ok(ios.host.querySelector('[data-safe-area-provider] button[aria-label="bar"]'), 'the content is inside');
  await ios.done();
  g.__phoneKeyboardHeight = 336;
  const open = await render('ios');
  assert.equal(liftOf(open.host), 302, 'the keyboard covers the home indicator, which the screens keep clear');
  await open.done();
  g.__phoneKeyboardHeight = 20;
  const low = await render('ios');
  assert.equal(liftOf(low.host), 0, 'never negative');
  await low.done();
  const android = await render('android');
  assert.equal(behaviorOf(android.host), 'padding');
  assert.equal(liftOf(android.host), undefined);
  assert.ok(android.host.querySelector('[data-keyboard-behavior] button[aria-label="bar"]'), 'the content is inside');
  await android.done();
  delete g.__phonePlatform;
  delete g.__phoneKeyboardHeight;
  delete g.__safeAreaInsets;
});

test('on both platforms the frame takes the side insets from safe-area-context and leaves the status bar and home indicator to each screen', async () => {
  g.__safeAreaInsets = { top: 47, bottom: 34, left: 5, right: 7 };
  for (const platform of ['android', 'ios']) {
    const { host, done } = await render(platform);
    assert.ok(
      host.querySelector('[data-safe-area-provider] button[aria-label="bar"]'),
      `${platform}: the insets are given to every screen`,
    );
    const frame = JSON.parse((host.querySelector('[data-safe-area-provider] > [data-style]') as HTMLElement).dataset.style!);
    assert.deepEqual(
      [frame.paddingLeft, frame.paddingRight, frame.paddingTop, frame.paddingBottom],
      [5, 7, undefined, undefined],
      platform,
    );
    // a screen keeps the home indicator clear at its bottom, which the keyboard covers: the lift leaves it out
    if (platform === 'android') assert.equal(host.querySelector('[data-keyboard-behavior]')!.getAttribute('data-keyboard-offset'), '-34');
    await done();
  }
  delete g.__phonePlatform;
  delete g.__safeAreaInsets;
});

test('the app keeps its screens inside the frame', async () => {
  const online = {
    phase: 'online',
    generation: 1,
    user: { id: 'u', name: 'Dana' },
    pairs: [{ pairId: 'p', macId: 'm', name: 'Studio Mac' }],
    selectedPair: 'p',
    error: null,
  };
  const s = scripted(
    (m) => (m === 'chats.recent' ? { chats: [{ id: 'c1', title: 'Fix login', state: 'idle', project: null }] } : undefined),
    online,
  );
  s.runtime.start = async () => {};
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(MobileApp, { runtime: s.runtime })));
  await flush();
  assert.ok(host.querySelector('[data-safe-area-provider] button[aria-label="Open chat Fix login"]'));
  await act(async () => root.unmount());
  host.remove();
});

test('the frame gives what is inside it the lift its own padding is made of: one value, the same number', async () => {
  const g = globalThis as any;
  g.__phonePlatform = 'ios';
  g.__safeAreaInsets = { top: 0, bottom: 34, left: 0, right: 0 };
  g.__phoneKeyboardHeight = 336;
  let seen: { value: number } | null = null;
  const Inside = () => {
    seen = useFrameLift();
    return null;
  };
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(ScreenFrame, null, createElement(Inside))));
  assert.equal(seen!.value, 302);
  const padded = JSON.parse((host.querySelector('[data-safe-area-provider] > [data-style] > [data-style]') as HTMLElement).dataset.style!);
  assert.equal(padded.paddingBottom, seen!.value);
  g.__phoneKeyboardHeight = 0;
  assert.equal(seen!.value, 0, 'it follows the keyboard');
  // outside any frame there is none
  await act(async () => root.render(createElement(Inside)));
  assert.equal(seen, null);
  await act(async () => root.unmount());
  host.remove();
  delete g.__phonePlatform;
  delete g.__safeAreaInsets;
  delete g.__phoneKeyboardHeight;
});

test('the frame keeps how much taller than one line the composer is, for the chat inside it, on both platforms', async () => {
  for (const platform of ['ios', 'android']) {
    (globalThis as any).__phonePlatform = platform;
    let seen: { extra: number } | null = null;
    const Inside = () => {
      seen = useComposerGrowth();
      return null;
    };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(ScreenFrame, null, createElement(Inside))));
    assert.deepEqual(seen, { extra: 0 }, platform);
    await act(async () => root.render(createElement(Inside)));
    assert.equal(seen, null, `${platform}: outside a frame there is none`);
    await act(async () => root.unmount());
    host.remove();
  }
  delete (globalThis as any).__phonePlatform;
});
