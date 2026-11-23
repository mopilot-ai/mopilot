// src/components/pages/welcomeRow.ts outside any row: a step's failure is a toast, and what a re-check found has nowhere to go (#2034).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { stubStore } from './support/stubs.ts';

const toasts: unknown[][] = [];
stubStore({ toast: (...a: unknown[]) => toasts.push(a) });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { useRecheck, useRun } = await import('../src/components/pages/welcomeRow.ts');

function Steps({ fail }: { fail: boolean }) {
  const run = useRun();
  const recheck = useRecheck(async () => {}, 'Still not found.');
  return createElement(
    'div',
    null,
    createElement('button', { id: 'run', onClick: () => run(async () => (fail ? Promise.reject(new Error('refused')) : undefined)) }),
    createElement('button', { id: 'recheck', onClick: recheck }),
  );
}

test('with no row, a failure is a toast and a re-check says nothing', async () => {
  const host = document.createElement('div');
  const root = createRoot(host);
  await act(() => root.render(createElement(Steps, { fail: true })));
  await act(async () => (host.querySelector('#run') as HTMLButtonElement).click());
  await act(async () => (host.querySelector('#recheck') as HTMLButtonElement).click());
  assert.deepEqual(toasts, [['refused', 'error']]);
  await act(() => root.unmount());
});
