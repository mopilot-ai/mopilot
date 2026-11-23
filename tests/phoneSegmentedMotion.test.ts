// The selected pill of a segmented control is one raised view that slides to the option picked (dur.base on the snap curve), is placed without travelling the first time, and is cut under Reduce Motion.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';

const segPath = '../mobile/src/components/Segmented';
const { Segmented } = await import(segPath);
const items = [
  { key: 'a', label: 'One' },
  { key: 'b', label: 'Two' },
  { key: 'c', label: 'Three' },
];
const g = globalThis as any;
const timings = () => (g.__phoneTimings ?? []) as { to: number; config: { duration: number; easing: unknown } }[];

async function render(selected: string) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  const show = (key: string) => act(async () => root.render(createElement(Segmented, { items, selected: key })));
  await show(selected);
  const pill = () =>
    [...host.querySelectorAll('[data-style]')].map((n) => JSON.parse(n.getAttribute('data-style')!)).find((s) => s.position === 'absolute');
  return {
    host,
    show,
    pill,
    measure: (width: number) => act(async () => g.__phoneOnLayout({ nativeEvent: { layout: { width } } })),
    done: () => act(async () => root.unmount()),
  };
}

test('the pill appears once the track is measured, sized to one option, and is placed at once', async () => {
  g.__phoneTimings = [];
  const r = await render('a');
  assert.equal(r.pill(), undefined, 'nothing to place before the track is measured');
  await r.measure(206);
  // (206 − 2·3 padding − 2·2 gaps) / 3 options
  assert.equal(r.pill().width, 65.33333333333333);
  assert.equal(r.pill().transform[0].translateX, 0);
  assert.deepEqual(timings(), [], 'the first place is not travelled to');
  await r.done();
});

test('picking another option slides the pill one option plus one gap per step over dur.base on the snap curve', async () => {
  g.__phoneTimings = [];
  const r = await render('a');
  await r.measure(206);
  await r.show('c');
  assert.deepEqual(timings().at(-1), { to: 2 * ((206 - 10) / 3 + 2), config: { duration: 200, easing: { bezier: [0.32, 0.72, 0, 1] } } });
  await r.done();
});

test('a selection that is not among the options draws no pill, and Reduce Motion places the pill without a timing', async () => {
  g.__phoneTimings = [];
  const none = await render('zzz');
  await none.measure(206);
  assert.equal(none.pill(), undefined);
  await none.done();
  g.__phoneReduceMotion = true;
  try {
    const r = await render('a');
    await r.measure(206);
    await r.show('b');
    assert.deepEqual(timings(), []);
    await r.done();
  } finally {
    delete g.__phoneReduceMotion;
  }
});
