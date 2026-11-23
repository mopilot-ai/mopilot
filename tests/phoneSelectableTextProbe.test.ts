// The developer probe of the in-place selection (#4837): the same Markdown by the React Native renderer and by the native runs, heights side by side, a 30-run stack, and a build with no native view.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';

const probePath = '../mobile/src/screens/SelectableTextProbe';
const viewPath = '../mobile/src/platform/selectableText';
const { SelectableTextProbe, SAMPLES, sameHeight, TOLERANCE, runsOf } = await import(probePath);
const { setNativeSelectableText } = await import(viewPath);

function FakeNative(props: any) {
  return createElement('div', { 'data-native-run': props.runs.map((r: any) => r.t).join('') });
}

async function mount() {
  document.body.replaceChildren();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(SelectableTextProbe)));
  return { host, done: () => act(async () => root.unmount()) };
}
/** Every layout callback of the screen, in order: each row's React Native view, then its native view. */
// the probe's own measuring views; a native run's wrapper also listens to its layout (it keeps the React text's height, #5369) and is not one of them
const layouts = (host: Element) => [...host.querySelectorAll('div')].filter((d: any) => d.__onLayout && !d.__touchStartCapture) as any[];

test('heights within a point are the same layout, and anything else or nothing measured is not', () => {
  assert.equal(TOLERANCE, 1);
  assert.equal(sameHeight(26, 26.33), true);
  assert.equal(sameHeight(26, 27.5), false);
  assert.equal(sameHeight(undefined, 26), false);
  assert.equal(sameHeight(26, undefined), false);
});

test('with the native view each sample is drawn twice and compared, the stack of 30 is summed, and the verdicts follow the heights', async () => {
  setNativeSelectableText(FakeNative as any);
  try {
    const v = await mount();
    assert.match(v.host.textContent!, /native view present/);
    const calls = layouts(v.host);
    assert.equal(calls.length, (SAMPLES.length + 30) * 2);
    const report = (el: any, height: number) => act(async () => el.__onLayout({ nativeEvent: { layout: { height } } }));
    // every pair agrees, except the first sample's, which is a point and a half apart
    for (let i = 0; i < calls.length; i += 2) {
      await report(calls[i], 100);
      await report(calls[i + 1], i === 0 ? 101.5 : 100);
    }
    assert.match(v.host.textContent!, new RegExp(`${SAMPLES.length - 1} of ${SAMPLES.length} samples match`));
    assert.match(v.host.textContent!, /30 stacked runs: RN 3000 · native 3000 · same \(0\.00 pt\)/);
    assert.match(v.host.textContent!, /sample-0: RN 100 · native 101\.5/);
    // the stack drifts: a third of a point per run is ten points over thirty
    for (let i = SAMPLES.length * 2; i < calls.length; i += 2) await report(calls[i + 1], 100.33);
    assert.match(v.host.textContent!, /native 3009\.9 · DIFFERENT/);
    // runs are drawn for the Markdown a run can hold
    assert.ok(v.host.querySelectorAll('[data-native-run]').length >= SAMPLES.length);
    await v.done();
  } finally {
    setNativeSelectableText(null);
  }
});

test('a build with no native view says so, and draws only the React Native side', async () => {
  const v = await mount();
  assert.match(v.host.textContent!, /NO native view in this build/);
  assert.equal(v.host.querySelectorAll('[data-native-run]').length, 0);
  await v.done();
});

test('a Markdown text gives the stretches of blocks a native run can hold, and leaves the others out', () => {
  assert.deepEqual(
    runsOf('one\n\n- two\n\n```\ncode\n```\n\nthree').map((run: any[]) => run.map((b) => b.type)),
    [['paragraph', 'list'], ['paragraph']],
  );
  assert.deepEqual(runsOf('```\ncode\n```'), []);
});
