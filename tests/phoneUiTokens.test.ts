// The design system: tokens follow the device scheme, text scales and is never capped, every pressable has a 44 pt target and a label, and the switch toggles with its state spoken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';

const dsPath = '../mobile/src/ui/ds';
const themePath = '../mobile/src/theme';
const ds = await import(dsPath);
const { light, dark } = await import(themePath);

const mount = async (node: any) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return {
    host,
    root,
    rerender: (next: any) => act(async () => root.render(next)),
    done: async () => (await act(async () => root.unmount()), host.remove()),
  };
};
const styleOf = (el: Element | null) => JSON.parse((el as HTMLElement).dataset.style!);

test('tokensFor returns the palette of the scheme and both come from the one theme source', () => {
  assert.equal(ds.tokensFor('light'), light);
  assert.equal(ds.tokensFor('dark'), dark);
});

test('useTokens follows the system scheme without a remount', async () => {
  const seen: unknown[] = [];
  const Probe = () => (seen.push(ds.useTokens()), createElement('i'));
  const view = await mount(createElement(Probe));
  (globalThis as any).__phoneDark = true;
  await view.rerender(createElement(Probe));
  delete (globalThis as any).__phoneDark;
  await view.done();
  assert.equal(seen[0], light);
  assert.equal(seen.at(-1), dark);
});

test('spacing, radii, concentric radius and feedback are Orca-sized and a concentric shape never goes below the mark radius', () => {
  assert.deepEqual(ds.spacing, { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 });
  assert.equal(ds.radii.surface, 16);
  assert.equal(ds.concentricRadius(ds.radii.surface, 6), 10);
  assert.equal(ds.concentricRadius(ds.radii.surface, 40), ds.radii.mark);
  assert.equal(ds.feedback.pressedOpacity, 0.7);
  assert.equal(ds.MIN_TARGET, 44);
});

test('textStyle takes size and weight from the scale and colour from the palette, for every tone', () => {
  for (const tone of ['ink', 'ink2', 'ink3', 'accent', 'warn', 'ok', 'bad'] as const) {
    const style = ds.textStyle(light, 'footnoteMedium', tone);
    assert.equal(style.color, light[tone]);
    assert.equal(style.fontSize, ds.typo.footnoteMedium.fontSize);
    assert.equal(style.fontWeight, '500');
  }
});

test('Text defaults to body ink, repaints in dark, and sets no cap on the system text size', async () => {
  const view = await mount(createElement(ds.Text, null, 'Hello'));
  const first = styleOf(view.host.querySelector('[data-style]'));
  assert.equal(first.color, light.ink);
  assert.equal(first.fontSize, ds.typo.body.fontSize);
  (globalThis as any).__phoneDark = true;
  await view.rerender(createElement(ds.Text, { variant: 'caption', tone: 'ink2', selectable: true }, 'Hello'));
  delete (globalThis as any).__phoneDark;
  const second = styleOf(view.host.querySelector('[data-style]'));
  assert.equal(second.color, dark.ink2);
  assert.equal(second.fontSize, ds.typo.caption.fontSize);
  await view.done();
  const source = (await import('node:fs')).readFileSync(new URL('../mobile/src/ui/ds/Text.tsx', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /maxFontSizeMultiplier|allowFontScaling/);
});

test("pressableStyle keeps the 44 pt target and dims while disabled (the held look is the native button's)", () => {
  const rest = ds.pressableStyle(false);
  assert.deepEqual(rest[0], { minWidth: 44, minHeight: 44, justifyContent: 'center' });
  assert.deepEqual(rest.slice(1), [undefined, false]);
  assert.deepEqual(ds.pressableStyle(false, { padding: 2 })[1], { padding: 2 });
  assert.deepEqual(ds.pressableStyle(true)[2], { opacity: ds.feedback.disabledOpacity });
});

test('Pressable speaks its label, role, hint and disabled state, passes the press through, and keeps the 44 pt target', async () => {
  let presses = 0;
  const make = (props: object) =>
    createElement(ds.Pressable, { label: 'Open chat', onPress: () => presses++, ...props }, createElement(ds.Text, null, 'Open'));
  const view = await mount(make({ hint: 'Opens the chat' }));
  const button = () => view.host.querySelector('button')!;
  assert.equal(button().getAttribute('aria-label'), 'Open chat');
  assert.equal(button().getAttribute('role'), 'button');
  assert.equal(button().getAttribute('aria-description'), 'Opens the chat');
  assert.equal(button().getAttribute('aria-disabled'), 'false');
  assert.equal(styleOf(button()).minHeight, 44);
  assert.equal(styleOf(button()).minWidth, 44);
  await act(async () => button().click());
  assert.equal(presses, 1);
  await view.rerender(make({ role: 'link', disabled: true }));
  assert.equal(button().getAttribute('role'), 'link');
  assert.equal(button().getAttribute('aria-disabled'), 'true');
  assert.equal(button().disabled, true);
  await view.done();
});

test('switchColors uses the accent when on and a quiet fill when off, in both palettes', () => {
  for (const palette of [light, dark]) assert.deepEqual(ds.switchColors(palette), { off: palette.fill2, on: palette.accent });
});

test('Switch toggles to the opposite value, speaks its checked state, plays the haptic and is dead when disabled', async () => {
  const { createHaptics } = await import('../mobile/src/haptics');
  (globalThis as any).__haptics = [];
  const values: boolean[] = [];
  const make = (props: object) =>
    createElement(ds.Switch, { value: false, onValueChange: (v: boolean) => values.push(v), accessibilityLabel: 'Haptics', ...props });
  const view = await mount(make({}));
  const button = () => view.host.querySelector('button')!;
  assert.equal(button().getAttribute('aria-label'), 'Haptics');
  assert.equal(button().getAttribute('role'), 'switch');
  assert.equal(button().getAttribute('aria-checked'), 'false');
  await act(async () => button().click());
  await view.rerender(make({ value: true }));
  assert.equal(button().getAttribute('aria-checked'), 'true');
  await act(async () => button().click());
  assert.deepEqual(values, [true, false]);
  assert.deepEqual((globalThis as any).__haptics, ['selection', 'selection']);
  // Settings > Haptic feedback off: the press still toggles and stays quiet
  await createHaptics({ read: async () => 'off', write: async () => undefined }).read();
  await act(async () => button().click());
  assert.deepEqual(values, [true, false, false]);
  assert.equal((globalThis as any).__haptics.length, 2);
  await createHaptics({ read: async () => 'on', write: async () => undefined }).read();
  await view.rerender(make({ value: true, disabled: true }));
  assert.equal(button().disabled, true);
  assert.equal(button().getAttribute('aria-disabled'), 'true');
  await view.done();
});

test('useReducedMotionEnabled reads the system setting and follows a change while mounted, then lets go', async () => {
  const seen: boolean[] = [];
  const Probe = () => (seen.push(ds.useReducedMotionEnabled()), createElement('i'));
  (globalThis as any).__phoneReduceMotion = true;
  const view = await mount(createElement(Probe));
  await act(async () => new Promise((resolve) => setImmediate(resolve)));
  assert.equal(seen.at(-1), true);
  await act(async () => (globalThis as any).__phoneReduceMotionChange(false));
  assert.equal(seen.at(-1), false);
  delete (globalThis as any).__phoneReduceMotion;
  await view.done();
  assert.equal((globalThis as any).__phoneReduceMotionChange, undefined);
});

test('Switch animates the thumb over 260 ms, and instantly once Reduce Motion is on, even if it was turned on while running', async () => {
  (globalThis as any).__phoneTimings = [];
  const view = await mount(createElement(ds.Switch, { value: true, onValueChange: () => undefined, accessibilityLabel: 'Haptics' }));
  const normal = (globalThis as any).__phoneTimings.at(-1);
  await act(async () => (globalThis as any).__phoneReduceMotionChange(true));
  await view.rerender(createElement(ds.Switch, { value: false, onValueChange: () => undefined, accessibilityLabel: 'Haptics' }));
  const reduced = (globalThis as any).__phoneTimings.at(-1);
  await view.done();
  assert.equal(normal.to, 1);
  assert.equal(normal.config.duration, 260);
  assert.equal(reduced.to, 0);
  assert.equal(reduced.config.duration, 0);
});

test('the design system exposes the motion scale by name, the same objects the app animates with', async () => {
  const motionPath = '../mobile/src/motion';
  const motion = await import(motionPath);
  assert.equal(ds.dur, motion.dur);
  assert.equal(ds.ease, motion.ease);
  assert.equal(ds.spring, motion.spring);
  assert.equal(ds.press, motion.press);
  assert.equal(ds.dur.base, 200);
  assert.deepEqual(ds.ease.snap, [0.32, 0.72, 0, 1]);
});

test('the design system serves the sheet, list and icon the screens already use, from one import path', async () => {
  const components = '../mobile/src/components';
  const sheet = await import(`${components}/BottomSheet`);
  const grouped = await import(`${components}/Grouped`);
  const list = await import(`${components}/List`);
  const icon = await import(`${components}/Icon`);
  assert.equal(ds.Sheet, sheet.BottomSheet);
  assert.equal(ds.Group, grouped.Group);
  assert.equal(ds.GroupItem, grouped.GroupItem);
  assert.equal(ds.GroupLabel, grouped.GroupLabel);
  assert.equal(ds.ListGroup, list.ListGroup);
  assert.equal(ds.ListRow, list.ListRow);
  assert.equal(ds.Icon, icon.Icon);
  assert.equal(ds.IconButton, icon.IconButton);
  assert.equal(typeof ds.SheetFrame, 'function');
  assert.equal(typeof ds.SheetHeader, 'function');
  const view = await mount(
    createElement(ds.Sheet, { open: true, title: 'Select model', onClose: () => undefined }, createElement(ds.Text, null, 'Sonnet')),
  );
  assert.match(view.host.textContent ?? '', /Select model/);
  assert.match(view.host.textContent ?? '', /Sonnet/);
  await view.done();
});
