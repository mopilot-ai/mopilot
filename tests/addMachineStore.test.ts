// The Add a machine sheet's open state (src/lib/addMachine.ts): openAddMachine and closeAddMachine flip it, every reader sees the change once, and repeating either changes nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, render, act, text } from './support/settings-harness.ts';

await setup();
const { createElement: h } = await import('react');
const { openAddMachine, closeAddMachine, useAddMachineOpen } = await import('../src/lib/addMachine.ts');

const renders: string[] = [];
const Probe = ({ id }: { id: string }) => {
  const open = useAddMachineOpen();
  renders.push(`${id}:${open}`);
  return h('i', { className: id }, open ? 'open' : 'closed');
};

test('open and close reach every reader; a repeat is no change and renders nothing again', async (t) => {
  const first = await render(h(Probe, { id: 'a' }));
  const second = await render(h(Probe, { id: 'b' }));
  t.after(async () => {
    await act(() => closeAddMachine());
    await first.unmount();
    await second.unmount();
  });
  assert.equal(text(first.host), 'closed');
  await act(() => openAddMachine());
  assert.equal(text(first.host), 'open');
  assert.equal(text(second.host), 'open');
  const before = renders.length;
  await act(() => openAddMachine());
  assert.equal(renders.length, before, 'opening an open sheet changes nothing');
  await act(() => closeAddMachine());
  assert.equal(text(first.host), 'closed');
  assert.equal(text(second.host), 'closed');
  const closed = renders.length;
  await act(() => closeAddMachine());
  assert.equal(renders.length, closed, 'closing a closed sheet changes nothing');
});

test('a reader that unmounted is not told again', async () => {
  const gone = await render(h(Probe, { id: 'gone' }));
  await gone.unmount();
  const before = renders.length;
  await act(() => openAddMachine());
  await act(() => closeAddMachine());
  assert.equal(renders.length, before);
});
