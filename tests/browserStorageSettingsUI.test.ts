// Settings → Browser → Storage (IAB-08, src/components/pages/settings/BrowserStorage.tsx): the shared
// profile by default, "This chat only" for each chat's own storage, and the note that a change applies
// to tabs opened from then on. The component is real; the store and the Settings primitives are stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import * as React from 'react';
import { mockSource, stubStore } from './support/stubs.ts';

const f: any = {
  state: { prefs: {} },
  calls: [],
  listeners: new Set<Function>(),
  subscribe(fn: Function) {
    f.listeners.add(fn);
    return () => f.listeners.delete(fn);
  },
  setPrefs(p: any) {
    f.calls.push(['setPrefs', p]);
    f.state = { ...f.state, prefs: { ...f.state.prefs, ...p } };
    for (const fn of f.listeners) fn();
  },
};
const { act, createElement } = React;
stubStore({
  useStore: (s: (st: any) => any) => s(React.useSyncExternalStore(f.subscribe, () => f.state)),
  setPrefs: (p: any) => f.setPrefs(p),
  toast: (...a: unknown[]) => f.calls.push(['toast', ...a]),
});
mockSource('src/components/pages/Settings.tsx', {
  Row: ({ title, desc, children }: any) => createElement('div', { className: 'row', 'data-title': title, 'data-desc': desc }, children),
  Select: ({ value, options, onChange }: any) =>
    createElement(
      'select',
      { value, onChange: (e: any) => onChange(e.target.value) },
      options.map((o: any) => createElement('option', { key: o.value, value: o.value }, o.label)),
    ),
});
const { createRoot } = await import('react-dom/client');
const { BrowserStorageRow } = await import('../src/components/pages/settings/BrowserStorage.tsx');

test('storage row: shared by default; choosing This chat only saves the pref, says when it applies, and explains it', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(createElement(BrowserStorageRow)));
  const row = () => container.querySelector('.row')!;
  const select = () => container.querySelector('select') as unknown as HTMLSelectElement;
  assert.equal(row().getAttribute('data-title'), 'Storage');
  assert.equal(select().value, 'shared');
  assert.match(row().getAttribute('data-desc')!, /Every chat shares one profile/);
  assert.deepEqual(
    [...select().querySelectorAll('option')].map((o) => [o.getAttribute('value'), o.textContent]),
    [
      ['shared', 'Shared by all chats'],
      ['session', 'This chat only'],
    ],
  );
  await act(async () => {
    select().value = 'session';
    select().dispatchEvent(new window.Event('change', { bubbles: true }) as any);
  });
  assert.deepEqual(f.calls, [
    ['setPrefs', { browserStorage: 'session' }],
    ['toast', 'Applies to browser tabs opened from now on'],
  ]);
  assert.equal(select().value, 'session');
  assert.match(row().getAttribute('data-desc')!, /own cookies and site data, cleared when the chat ends/);
  // an unknown saved value reads as shared
  await act(async () => f.setPrefs({ browserStorage: 'bogus' }));
  assert.equal(select().value, 'shared');
  await act(async () => root.unmount());
});
