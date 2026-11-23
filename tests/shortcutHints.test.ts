// Shortcut hints follow current preferences and contextual default precedence without stale hard-coded labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { fakeStore, render } from './support/shell-panels-kit.ts';
import { createElement, act } from 'react';
import { stubStore } from './support/stubs.ts';
const store = fakeStore({ prefs: {} });
stubStore(store.exports);
const { useShortcutHint } = await import('../src/session/shortcutHints.ts');
test('hints update on rebinding/removal and unknown commands have no hint', async () => {
  let hint!: (id: string) => string | undefined;
  function Driver() {
    hint = useShortcutHint();
    return null;
  }
  const r = await render(createElement(Driver));
  assert.equal(hint('new-chat'), '⌘N');
  assert.equal(hint('unknown'), undefined);
  await act(async () => {
    store.exports.setPrefs({ keybindings: { 'new-chat': '⌘X', search: null } });
  });
  assert.equal(hint('new-chat'), '⌘X');
  assert.equal(hint('search'), undefined);
  await r.unmount();
});
