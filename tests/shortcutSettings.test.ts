// Shortcut recording retains failed edits, rejects conflicts and restores defaults without replacing other bindings.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { setup, defaultState, useStore, render, click, row, key, responses, resetCtl, calls } from './support/settings-harness.ts';
import { deferred } from './support/async-scenarios.ts';
await setup();
const { createElement, act } = await import('react');
const { Shortcuts } = await import('../src/components/pages/settings/Shortcuts.tsx');
beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState());
});
test('failed capture/save stays retryable; repeat/IME never save; restore removes only its own override', async () => {
  const r = await render(createElement(Shortcuts));
  const edit = () => row(r.host, 'New chat').querySelector('[aria-label="Edit shortcut"]')!;
  responses['prefs.recording'] = async () => {
    throw new Error('not ready');
  };
  await click(edit());
  assert.match(r.host.querySelector('[role="alert"]')!.textContent!, /capture/);
  responses['prefs.recording'] = async () => true;
  await key(window as any, { key: 'x', code: 'KeyX', metaKey: true, shiftKey: true, isComposing: true });
  await key(window as any, { key: 'x', code: 'KeyX', metaKey: true, shiftKey: true, repeat: true });
  assert.equal(
    calls.some((c) => c[0] === 'prefs.binding'),
    false,
  );
  await key(window as any, { key: 'z', code: 'KeyZ', metaKey: true });
  assert.match(r.host.querySelector('[role="alert"]')!.textContent!, /System undo/);
  responses['prefs.binding'] = async () => false;
  await key(window as any, { key: 'x', code: 'KeyX', metaKey: true, shiftKey: true });
  assert.match(r.host.querySelector('[role="alert"]')!.textContent!, /save/);
  assert.ok(r.host.querySelector('.kbd-recording'));
  responses['prefs.binding'] = async () => {
    throw new Error('disk full');
  };
  await key(window as any, { key: 'x', code: 'KeyX', metaKey: true, shiftKey: true });
  assert.ok(r.host.querySelector('.kbd-recording'));
  const save = deferred<boolean>();
  responses['prefs.binding'] = () => save.promise;
  await act(async () => {
    for (let i = 0; i < 2; i++)
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', metaKey: true, shiftKey: true, bubbles: true, cancelable: true }),
      );
  });
  assert.equal(calls.filter((c) => c[0] === 'prefs.binding').length, 3);
  assert.equal((edit() as HTMLButtonElement).disabled, true);
  await act(async () => {
    useStore.setState({ prefs: { ...useStore.getState().prefs, keybindings: { 'new-chat': '⇧⌘X', pin: null } } });
    save.resolve(true);
    await save.promise;
  });
  assert.equal(r.host.querySelector('.kbd-recording'), null);
  responses['prefs.binding'] = async (id: string) => {
    const bindings = { ...useStore.getState().prefs.keybindings };
    delete bindings[id];
    useStore.setState({ prefs: { ...useStore.getState().prefs, keybindings: bindings } });
    return true;
  };
  await click(row(r.host, 'New chat').querySelector('.btn')!);
  assert.deepEqual(useStore.getState().prefs.keybindings, { pin: null });
  await r.unmount();
});
test('existing conflicting customizations are visible and rejected recordings do not replace them', async () => {
  useStore.setState({ prefs: { ...useStore.getState().prefs, keybindings: { pin: '⇧⌘Q', rename: '⇧⌘Q' } } });
  const r = await render(createElement(Shortcuts));
  assert.match(row(r.host, 'Pin or unpin chat').textContent!, /Also assigned to Rename chat/);
  await click(row(r.host, 'New chat').querySelector('[aria-label="Edit shortcut"]')!);
  await key(window as any, { key: 'q', code: 'KeyQ', metaKey: true, shiftKey: true });
  assert.match(r.host.querySelector('[role="alert"]')!.textContent!, /Already used/);
  assert.equal(
    calls.some((c) => c[0] === 'prefs.binding'),
    false,
  );
  await r.unmount();
});

test('simultaneous remove and edit clicks serialize before React can disable the controls', async () => {
  const r = await render(createElement(Shortcuts));
  const wait = deferred<boolean>();
  responses['prefs.binding'] = () => wait.promise;
  const target = row(r.host, 'New chat');
  await act(async () => {
    (target.querySelector('[aria-label="Remove shortcut"]') as HTMLButtonElement).click();
    (target.querySelector('[aria-label="Remove shortcut"]') as HTMLButtonElement).click();
    (target.querySelector('[aria-label="Edit shortcut"]') as HTMLButtonElement).click();
  });
  assert.equal(calls.filter((c) => c[0] === 'prefs.binding').length, 1);
  assert.equal(r.host.querySelector('.kbd-recording'), null);
  await act(async () => {
    wait.resolve(true);
    await wait.promise;
  });
  await r.unmount();
});
