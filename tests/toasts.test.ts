import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { stubStore } from './support/stubs.ts';

const dismissed: number[] = [];
let toasts: any[] = [];
stubStore({ useStore: (f: any) => f({ toasts }), dismissToast: (id: number) => dismissed.push(id) });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Toasts } = await import('../src/components/ui/Toasts.tsx');

test('toasts render by kind and an action dismisses before running', async () => {
  const ran: string[] = [];
  toasts = [
    { id: 1, text: 'saved', kind: 'success' },
    { id: 2, text: 'failed', kind: 'error', action: { label: 'Retry', run: () => ran.push('retry') } },
    { id: 3, text: 'plain' },
  ];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(() => root.render(createElement(Toasts)));
  assert.deepEqual(
    [...host.querySelectorAll('.toast')].map((t) => t.className),
    ['toast success', 'toast error', 'toast info'],
  );
  await act(() => (host.querySelector('.toast-action') as HTMLElement).click());
  assert.deepEqual(dismissed, [2]);
  assert.deepEqual(ran, ['retry']);
  await act(() => root.unmount());
});
