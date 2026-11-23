// src/components/harnessPicker/quickSwitch.ts: a sheet with nothing to decide confirms itself once, on its first render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { render } from './support/thread-kit.ts';
import { useQuickSwitch } from '../src/components/harnessPicker/quickSwitch.ts';

function Probe({ quiet, confirm, out }: { quiet: boolean; confirm: () => void; out: boolean[] }) {
  out.push(useQuickSwitch(quiet, confirm));
  return null;
}

test('quiet on the first render confirms exactly once across re-renders', async () => {
  let n = 0;
  const out: boolean[] = [];
  const v = await render(h(Probe, { quiet: true, confirm: () => n++, out }));
  await v.rerender(h(Probe, { quiet: true, confirm: () => n++, out }));
  await v.rerender(h(Probe, { quiet: false, confirm: () => n++, out }));
  assert.equal(n, 1);
  assert.deepEqual(out, [true, true, true]);
});

test('a sheet that opened with something at risk never confirms itself', async () => {
  let n = 0;
  const out: boolean[] = [];
  const v = await render(h(Probe, { quiet: false, confirm: () => n++, out }));
  await v.rerender(h(Probe, { quiet: true, confirm: () => n++, out }));
  assert.equal(n, 0);
  assert.deepEqual(out, [false, false]);
});
