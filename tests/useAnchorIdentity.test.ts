// useAnchor returns one object until its state changes, so effects that list it do not re-run on every render.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { mount } from './support/composer-kit.ts';

const { createElement: h, useState, act } = await import('react');
const { useAnchor } = await import('../src/components/ui/Popover.tsx');

test('useAnchor keeps one object until its state changes, so an effect listing it does not run on every render', async () => {
  const seen: any[] = [];
  let rerender = () => {};
  function T() {
    const a = useAnchor();
    const [, force] = useState(0);
    rerender = () => force((n) => n + 1);
    seen.push(a);
    return h('b', { ref: a.ref }, String(a.open));
  }
  const m = await mount(h(T));
  const settled = seen.length;
  await act(async () => rerender());
  assert.ok(seen.length > settled, 'the component rendered again');
  assert.equal(seen.at(-1), seen[settled - 1], 'no state changed: the same object');
  await act(async () => seen.at(-1).toggle());
  assert.notEqual(seen.at(-1), seen[settled - 1], 'the state changed: a new object');
  await m.unmount();
});
