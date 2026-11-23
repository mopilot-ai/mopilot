// An input method's Escape and Enter in the app's dialogs (src/components/ui/Modal.tsx, the bug report form among them)
// and the global-shortcut recorder (src/components/pages/settings/Rows.tsx HotkeyField): cancelling a candidate
// closes nothing and records nothing; the same key without a composition still does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { stubStore } from './support/stubs.ts';

stubStore({ useStore: (pick: (s: unknown) => unknown) => pick({ prefs: {} }), setPrefs: () => {} });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Modal } = await import('../src/components/ui/Modal.tsx');
const { HotkeyField } = await import('../src/components/pages/settings/Rows.tsx');

const key = (init: Record<string, unknown>) => new window.KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init }) as any;

test('a dialog stays open while Escape cancels an input method candidate, and closes on a plain Escape', async () => {
  let closed = 0;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(() =>
    root.render(createElement(Modal, { title: 'Report a bug', onClose: () => void closed++, children: createElement('textarea') })),
  );
  const field = host.querySelector('textarea')!;
  await act(() => field.dispatchEvent(key({ key: 'Escape', isComposing: true })));
  await act(() => field.dispatchEvent(key({ key: 'Escape', keyCode: 229 })));
  assert.equal(closed, 0);
  await act(() => field.dispatchEvent(key({ key: 'Escape' })));
  assert.equal(closed, 1);
  await act(() => root.unmount());
  host.remove();
});

test('the shortcut recorder ignores composing keys, stops on Escape and records a chord', async () => {
  const recorded: (string | null)[] = [];
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(() => root.render(createElement(HotkeyField, { value: null, onChange: (acc: string | null) => recorded.push(acc) })));
  const start = () => host.querySelector('[aria-label="Edit shortcut"]') as HTMLElement;
  await act(() => start().click());
  await act(() => window.dispatchEvent(key({ key: 'Escape', isComposing: true })));
  await act(() => window.dispatchEvent(key({ key: 'k', code: 'KeyK', metaKey: true, keyCode: 229 })));
  assert.deepEqual(recorded, []);
  await act(() => window.dispatchEvent(key({ key: 'k', code: 'KeyK', metaKey: true })));
  assert.deepEqual(recorded, ['Command+K']);
  await act(() => root.unmount());
  host.remove();
});
