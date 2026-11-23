// The frame every screen sits in lifts it above the iOS keyboard (a real iPhone showed the composer, the terminal input and pairing's Continue under it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot, flush } from './support/phone/component-kit';
import { scripted } from './support/phone/m3';
// variable paths: tsconfig.node.json includes tests/*.ts, and a static import would pull React Native's types (setTimeout as a number) into the Node project
const uiPath = '../mobile/src/components/ui';
const appPath = '../mobile/src/MobileApp';
const { ScreenFrame } = await import(uiPath);
const { MobileApp } = await import(appPath);

const behaviorOf = (host: HTMLElement) => host.querySelector('[data-keyboard-behavior]')?.getAttribute('data-keyboard-behavior');

test('the frame pads its content above the keyboard on iOS and on edge-to-edge Android, which does not resize the window', async () => {
  for (const [platform, behavior] of [
    ['ios', 'padding'],
    ['android', 'padding'],
  ]) {
    (globalThis as any).__phonePlatform = platform;
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(ScreenFrame, null, createElement('button', { 'aria-label': 'bar' }))));
    assert.equal(behaviorOf(host), behavior, platform);
    assert.ok(host.querySelector('[data-keyboard-behavior] button[aria-label="bar"]'), 'the content is inside');
    await act(async () => root.unmount());
    host.remove();
  }
  delete (globalThis as any).__phonePlatform;
});

test('on both platforms the frame takes the side insets from safe-area-context and leaves the status bar and home indicator to each screen', async () => {
  for (const platform of ['android', 'ios']) {
    (globalThis as any).__phonePlatform = platform;
    (globalThis as any).__safeAreaInsets = { top: 47, bottom: 34, left: 5, right: 7 };
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(createElement(ScreenFrame, null, createElement('button', { 'aria-label': 'bar' }))));
    assert.ok(
      host.querySelector('[data-safe-area-provider] [data-keyboard-behavior]'),
      `${platform}: the insets are given to every screen`,
    );
    const frame = JSON.parse((host.querySelector('[data-safe-area-provider] > [data-style]') as HTMLElement).dataset.style!);
    assert.deepEqual(
      [frame.paddingLeft, frame.paddingRight, frame.paddingTop, frame.paddingBottom],
      [5, 7, undefined, undefined],
      platform,
    );
    // a screen keeps the home indicator clear at its bottom, which the keyboard covers: the lift leaves it out
    assert.equal(host.querySelector('[data-keyboard-behavior]')!.getAttribute('data-keyboard-offset'), '-34', platform);
    await act(async () => root.unmount());
    host.remove();
  }
  delete (globalThis as any).__phonePlatform;
  delete (globalThis as any).__safeAreaInsets;
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
  assert.ok(host.querySelector('[data-keyboard-behavior] button[aria-label="Open chat Fix login"]'));
  await act(async () => root.unmount());
  host.remove();
});
