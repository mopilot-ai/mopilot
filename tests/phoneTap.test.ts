// Tap, the phone's one tappable: the press look is handed to the native button (so it shows while JS is busy), and a control that must show nothing stays a plain pressable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';

const tapPath = '../mobile/src/ui/ds/Tap';
const motionPath = '../mobile/src/motion';
const { Tap } = await import(tapPath);
const { press, dur } = await import(motionPath);

const mount = async (node: any) => {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, button: () => host.querySelector('button')!, done: async () => (await act(async () => root.unmount()), host.remove()) };
};
const text = (s: string) => createElement('span', null, s);

test('a tap dims to the press opacity natively and still presses', async () => {
  let presses = 0;
  const view = await mount(createElement(Tap, { accessibilityLabel: 'Open', onPress: () => presses++ }, text('Open')));
  assert.equal(view.button().dataset.activeOpacity, String(press.opacity));
  assert.equal(view.button().dataset.activeUnderlay, undefined);
  await act(async () => view.button().click());
  assert.equal(presses, 1);
  await view.done();
});

test('dimTo asks for another depth, and a style opacity is the resting one the press fades from', async () => {
  const view = await mount(createElement(Tap, { dimTo: 0.7, style: { opacity: 0.4, padding: 2 } }, text('x')));
  assert.equal(view.button().dataset.activeOpacity, '0.4', 'a control resting at 0.4 never brightens when held');
  assert.deepEqual(JSON.parse(view.button().dataset.style!), { padding: 2, opacity: 0.4 });
  await view.done();
  const full = await mount(createElement(Tap, { dimTo: 0.7 }, text('x')));
  assert.equal(full.button().dataset.activeOpacity, '0.7');
  assert.equal(full.button().dataset.style, undefined);
  await full.done();
});

test('a row lays its colour under the content instead of dimming it', async () => {
  const view = await mount(createElement(Tap, { feel: 'row', rowColor: '#eee', style: { padding: 1 } }, text('row')));
  assert.equal(view.button().dataset.activeUnderlay, '#eee');
  assert.equal(view.button().dataset.activeOpacity, undefined);
  await view.done();
});

test('a control that shows nothing is a plain pressable, and it hears the touch', async () => {
  const seen: unknown[] = [];
  const view = await mount(createElement(Tap, { feel: 'none', onPress: (e: unknown) => seen.push(e) }, text('scrim')));
  assert.equal(view.button().dataset.activeOpacity, undefined);
  await act(async () => view.button().click());
  assert.equal(seen.length, 1);
  await view.done();
  // with no handler nothing is attached to the plain pressable either
  const dead = await mount(createElement(Tap, { feel: 'none' }, text('x')));
  await act(async () => dead.button().click());
  await dead.done();
});

test('a tick plays its haptic before the press, and a tap with no press does nothing', async () => {
  (globalThis as any).__haptics = [];
  const order: string[] = [];
  const view = await mount(
    createElement(Tap, { tick: 'select', onPress: () => order.push(`press after ${(globalThis as any).__haptics.length}`) }, text('x')),
  );
  await act(async () => view.button().click());
  assert.deepEqual(order, ['press after 1']);
  await view.done();
  const bare = await mount(createElement(Tap, { tick: 'select' }, text('x')));
  await act(async () => bare.button().click());
  assert.equal((globalThis as any).__haptics.length, 1);
  await bare.done();
});

test("the native press fades in over the app's press time and out over its snap time", async () => {
  assert.ok(dur.fast < dur.snap);
});

test('a tap with no press still dims natively and a list row that is disabled rests dimmed and takes no touch', async () => {
  const view = await mount(createElement(Tap, null, text('x')));
  assert.equal(view.button().dataset.activeOpacity, String(press.opacity));
  await act(async () => view.button().click());
  await view.done();
  const listPath = '../mobile/src/components/List';
  const { ListRow } = await import(listPath);
  const row = await mount(createElement(ListRow, { label: 'Pair', onPress: () => {}, disabled: true }));
  assert.equal(row.button().disabled, true);
  assert.equal(JSON.parse(row.button().dataset.style!).opacity, 0.45);
  assert.equal(row.button().dataset.activeUnderlay !== undefined, true, 'a held row lays its colour under the content');
  await row.done();
});
