// The phone's motion scale matches the desktop tokens, haptics stay quiet without an engine, and buttons answer a press.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { act, createElement, createRoot } from './support/phone/component-kit';
// through a variable, so the desktop typecheck does not follow into React Native's global types
const motionPath = '../mobile/src/motion';
const uiPath = '../mobile/src/components/ui';
const { dur, ease, haptic, quiet } = await import(motionPath);
const { Button } = await import(uiPath);

const tokens = readFileSync(new URL('../src/styles/tokens.css', import.meta.url), 'utf8');
const token = (name: string) => tokens.match(new RegExp(`--${name}:\\s*([^;]+);`))?.[1].trim();

test('durations and curves are the desktop tokens, so both apps move alike', () => {
  for (const [key, name] of [
    ['fast', 'dur-fast'],
    ['snap', 'dur-snap'],
    ['base', 'dur-base'],
    ['sheet', 'dur-sheet'],
    ['slow', 'dur-slow'],
    ['revealHold', 'reveal-hold'],
  ] as const)
    assert.equal(`${dur[key as keyof typeof dur]}ms`, token(name), name);
  for (const [key, name] of [
    ['snap', 'ease-snap'],
    ['enter', 'ease-enter'],
    ['exit', 'ease-exit'],
  ] as const)
    assert.equal(`cubic-bezier(${ease[key as keyof typeof ease].join(', ')})`, token(name), name);
});

test('each moment plays its haptic, and a missing engine never throws', async () => {
  (globalThis as any).__haptics = [];
  haptic.send();
  haptic.approve();
  haptic.deny();
  haptic.select();
  haptic.error();
  assert.deepEqual((globalThis as any).__haptics, [
    'impact:light',
    'notification:success',
    'impact:medium',
    'selection',
    'notification:error',
  ]);
  // a rejected call (no engine) and a call that throws at once (no native module) are both swallowed
  assert.doesNotThrow(() => quiet(() => Promise.reject(Error('no engine'))));
  assert.doesNotThrow(() =>
    quiet(() => {
      throw Error('no module');
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
});

test('a button dims while it is held, unless it is disabled', async () => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(
      createElement('div', null, [
        createElement(Button, { key: 'a', title: 'Send', onPress: () => {} }),
        createElement(Button, { key: 'b', title: 'Later', onPress: () => {}, disabled: true }),
      ]),
    ),
  );
  const [send, later] = [...host.querySelectorAll('button')];
  assert.equal(send.getAttribute('data-active-opacity'), '0.6', 'the native button fades to the press opacity at touch-down');
  assert.equal(JSON.parse(send.getAttribute('data-style')!).opacity, undefined);
  assert.equal((later as HTMLButtonElement).disabled, true, 'a disabled button takes no touch, so it never dims');
  await act(async () => root.unmount());
  host.remove();
});

test('a row that arrives fades in on Claude’s timing while the rows around it make room in one short timed move; first rows do not, and your own message never fades', async () => {
  const motionViewsPath = '../mobile/src/components/Motion';
  const { Enter, SkipFirstEntrance } = await import(motionViewsPath);
  const { FadeIn, FadeInDown, FadeOut, LinearTransition } = await import('./support/phone/reanimated');
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () =>
    root.render(createElement(SkipFirstEntrance, null, createElement(Enter, null, createElement('span', null, 'row')))),
  );
  assert.ok(host.querySelector('[data-skip-entering="true"] [data-entering="FadeIn"][data-layout="LinearTransition"]'));
  assert.deepEqual(FadeIn.steps, [
    ['duration', 200],
    ['easing', { bezier: [0.19, 1, 0.22, 1] }],
  ]);
  assert.deepEqual(FadeOut.steps, [
    ['duration', 120],
    ['easing', { bezier: [0.8, 0, 0.4, 1] }],
  ]);
  // a timed move of dur.base on the snap curve: no spring, so the rows around a sent message do not drift for half a second
  assert.deepEqual(LinearTransition.steps, [
    ['duration', 200],
    ['easing', { bezier: [0.32, 0.72, 0, 1] }],
  ]);
  // the sent bubble also rises 8pt over the same 200 ms on the same curve
  await act(async () => root.render(createElement(Enter, { rise: true }, createElement('span', null, 'sent'))));
  assert.ok(host.querySelector('[data-entering="FadeInDown"]'));
  assert.deepEqual(FadeInDown.steps, [
    ['duration', 200],
    ['easing', { bezier: [0.19, 1, 0.22, 1] }],
    ['withInitialValues', { transform: [{ translateY: 8 }] }],
  ]);
  await act(async () => root.render(createElement(Enter, { fade: false }, createElement('span', null, 'mine'))));
  assert.equal(
    host.querySelector('[data-entering]'),
    null,
    'your own message is already on screen as the queued bubble: no fade when the computer’s copy lands',
  );
  assert.ok(host.querySelector('[data-layout="LinearTransition"]'), 'it still makes room');
  // a row whose replacement is drawn in the same frame does not fade out over it
  await act(async () => root.render(createElement(Enter, { leave: false }, createElement('span', null, 'swapped'))));
  assert.equal(host.querySelector('[data-exiting]'), null);
  await act(async () => root.unmount());
  host.remove();
});

test('a run of steps turns its chevron and fades its steps in when opened', async () => {
  const bubblePath = '../mobile/src/components/MessageBubble';
  const { ToolRun } = await import(bubblePath);
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const steps = [
    { key: 'a', role: 'step', text: 'Read a.ts' },
    { key: 'b', role: 'step', text: 'Read b.ts' },
  ];
  await act(async () => root.render(createElement(ToolRun, { steps, summary: 'Read 2 files', running: false })));
  // the view that turns, around the chevron symbol
  const chevron = () => JSON.parse(host.querySelector('[data-style*="rotate"]')!.getAttribute('data-style')!);
  assert.ok(host.querySelector('[data-style*="rotate"] [data-symbol="chevron.right"]'));
  assert.deepEqual(chevron().transform, [{ rotate: '0deg' }]);
  assert.equal(chevron().transitionDuration, 120);
  await act(async () => (host.querySelector('button') as HTMLElement).click());
  assert.deepEqual(chevron().transform, [{ rotate: '90deg' }]);
  assert.ok(host.querySelector('[data-entering="FadeIn"]')?.textContent?.includes('Read a.ts'));
  await act(async () => root.render(createElement(ToolRun, { steps, summary: 'Read 2 files', running: true })));
  // a running run is as quiet as a finished one (the working line below carries the spark), and gives no time yet
  assert.equal(host.querySelector('button')!.getAttribute('aria-label'), 'Read 2 files');
  await act(async () => root.unmount());
  host.remove();
});
