// The message field's box grows and shrinks over dur.sheet on a CSS transition (the pill and the transcript above follow in the same frames), takes its first height and Reduce Motion's at once, stays between its minimum and maximum, and at rest has no shared value or animated style on the UI thread (#4986).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, createRoot } from './support/phone/component-kit';

const fieldPath = '../mobile/src/components/GrowingField';
const { GrowingField } = await import(fieldPath);
const g = globalThis as any;

async function render(props: Record<string, unknown> = {}) {
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(GrowingField, { minHeight: 24, maxHeight: 140, value: '', ...props })));
  const input = () => host.querySelector('input') as any;
  return {
    host,
    input,
    /** The box's own style: its height and, while a move is on its way, the transition. */
    box: () => {
      const raw = [...host.querySelectorAll('[data-style]')]
        .map((n) => JSON.parse(n.getAttribute('data-style')!))
        .find((st) => JSON.stringify(st).includes('hidden'));
      return Array.isArray(raw) ? Object.assign({}, ...raw.flat(9).filter(Boolean)) : raw;
    },
    layout: (height: number) => act(async () => input().__onLayout({ nativeEvent: { layout: { height } } })),
    done: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

const snap = { cubicBezier: [0.32, 0.72, 0, 1] };
const moving = (box: any) =>
  box.transitionProperty === 'height' ? [box.height, box.transitionDuration, box.transitionTimingFunction] : null;

test('while it is typed in, a new height is reached over dur.sheet on the snap curve, within the minimum and maximum', async () => {
  const r = await render();
  await r.layout(27);
  await act(async () => r.input().__focus());
  const seen: unknown[] = [];
  for (const height of [50, 50, 400, 10]) {
    await r.layout(height);
    seen.push(moving(r.box()));
  }
  assert.deepEqual(
    seen,
    [
      [50, 300, snap],
      [50, 300, snap],
      [140, 300, snap],
      [24, 300, snap],
    ],
    'a field taller than its maximum stops there and one shorter than its minimum stops there; the same height reported twice is the same move',
  );
  await r.done();
});

test('the first height, and text that arrives while nobody is typing (a draft restored after mount), are taken at once', async () => {
  const r = await render();
  await r.layout(27);
  assert.equal(r.box().height, 27);
  await r.layout(60);
  assert.equal(r.box().height, 60);
  assert.equal(moving(r.box()), null, 'not focused: no transition');
  await act(async () => r.input().__focus());
  await r.layout(80);
  assert.deepEqual(moving(r.box()), [80, 300, snap], 'focused: a move');
  await act(async () => r.input().__blur());
  await r.layout(30);
  assert.equal(r.box().height, 30);
  assert.equal(moving(r.box()), null, 'blurred again: at once');
  await r.done();
});

test('a height measured again within half a point is the same height, and the box starts at its minimum', async () => {
  const r = await render();
  assert.equal(r.box().height, 24, 'before any measure it is as tall as its minimum');
  await r.layout(30);
  await act(async () => r.input().__focus());
  await r.layout(30.3);
  assert.equal(r.box().height, 30, 'the second report is the first one again, so the box stays where it is');
  await r.done();
});

test('the transition is in the box’s style from the moment the field is focused, before any height changes, and leaves with the blur', async () => {
  // a transition added by the same update that changes the height does not run: the first growth jumped on the phone and only the shrink after it moved
  const r = await render();
  await r.layout(27);
  assert.equal(moving(r.box()), null, 'unfocused: none');
  await act(async () => r.input().__focus());
  assert.deepEqual(moving(r.box()), [27, 300, snap], 'focused: already there, with the height unchanged');
  await r.layout(60);
  assert.deepEqual(moving(r.box()), [60, 300, snap], 'so the first growth is a move from 27 to 60');
  await act(async () => r.input().__blur());
  assert.equal(moving(r.box()), null, 'blurred: gone before the next height, which is taken at once');
  assert.equal(r.box().height, 60);
  await r.done();
});

test('at rest and while it moves the box makes no shared value and no animated style: nothing of it lives on the UI thread', async () => {
  g.__phoneAnimatedHooks = 0;
  try {
    const r = await render();
    await r.layout(27);
    await act(async () => r.input().__focus());
    await r.layout(80);
    await r.layout(40);
    await act(async () => r.input().__blur());
    assert.equal(g.__phoneAnimatedHooks, 0);
    await r.done();
  } finally {
    delete g.__phoneAnimatedHooks;
  }
});

test('the field is laid out beside the flow at its own height, keeps the screen’s layout callback, and can be a plain input', async () => {
  const seen: number[] = [];
  const focus: string[] = [];
  const r = await render({
    onLayout: (e: any) => seen.push(e.nativeEvent.layout.height),
    onFocus: () => focus.push('focus'),
    onBlur: () => focus.push('blur'),
    input: (p: any) =>
      createElement('input', {
        'aria-label': 'plain',
        ref: (el: any) => {
          if (el) Object.assign(el, { __onLayout: p.onLayout, __focus: p.onFocus, __blur: p.onBlur });
        },
      }),
  });
  await r.layout(60);
  assert.deepEqual(seen, [60]);
  await act(async () => r.input().__focus());
  await act(async () => r.input().__blur());
  assert.deepEqual(focus, ['focus', 'blur'], 'the screen still hears focus and blur');
  assert.ok(r.host.querySelector('input[aria-label="plain"]'), 'the input prop draws the field');
  await r.done();
});

test('under Reduce Motion the box takes every height at once', async () => {
  g.__phoneReduceMotion = true;
  try {
    const r = await render();
    await r.layout(27);
    await act(async () => r.input().__focus());
    await r.layout(80);
    assert.equal(r.box().height, 80);
    assert.equal(moving(r.box()), null, 'focused, and still no transition');
    await r.done();
  } finally {
    delete g.__phoneReduceMotion;
  }
});
