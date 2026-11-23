// Leaving Settings from the keyboard (⌘, again, Esc off a field), registered against the real App fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import { window as domWindow } from './dom.ts';
const window = domWindow as unknown as Window & typeof globalThis;

export function registerSettingsExitCases(fx: any) {
  const { reset, mount, cmd, key, calls, unmount, getState } = fx;
  const left = () => calls.filter((c: unknown[]) => c[0] === 'leaveSettings').length;
  const escOn = (el: Element) =>
    act(async () => {
      el.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });

  test('Settings: ⌘, again and Esc go back to the app; a section asked for still opens it', async () => {
    reset({ route: { name: 'settings', section: 'git' } });
    await mount();
    try {
      await cmd('settings', 'about');
      assert.deepEqual(getState().route, { name: 'settings', section: 'about' });
      assert.equal(left(), 0);
      await cmd('settings');
      assert.equal(left(), 1);
      assert.equal(await key({ key: 'Escape' }), true);
      assert.equal(left(), 2);
      assert.equal(await key({ key: 'Escape', metaKey: true }), false);
      assert.equal(left(), 2);
    } finally {
      await unmount();
    }
  });

  test('Settings: Esc in a field, under a dialog or outside Settings never leaves it', async () => {
    reset({ route: { name: 'settings', section: 'general' } });
    await mount();
    const input = document.createElement('input');
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    try {
      document.body.append(input);
      await escOn(input);
      assert.equal(left(), 0, 'the field keeps Esc');
      document.body.append(dialog);
      await key({ key: 'Escape' });
      assert.equal(left(), 0, 'the dialog keeps Esc');
      dialog.remove();
      await act(async () => fx.set({ route: { name: 'home' } }));
      await cmd('settings', 7);
      assert.deepEqual(getState().route, { name: 'settings', section: undefined }, '⌘, from the app opens Settings');
      await act(async () => fx.set({ route: { name: 'home' } }));
      await key({ key: 'Escape' });
      assert.equal(left(), 0);
    } finally {
      input.remove();
      dialog.remove();
      await unmount();
    }
  });
}
