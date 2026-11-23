// Windows and Linux use Control for the same numbered session hint and navigation contract.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { act } from 'react';
import './support/dom.ts';
import { installNativeStub } from './support/ports/native.ts';
installNativeStub({ platform: 'win32' });
const { reset, thread, mountSidebar, key, fire } = await import('./support/shell-sidebar-kit.ts');
test('Control reveals platform-formatted session hints while Super does not advertise Control bindings', async (t) => {
  reset({ threads: { a: thread('a') }, threadOrder: ['a'] });
  const view = await mountSidebar();
  t.after(() => view.unmount());
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await key(document.body, 'Control', { ctrlKey: true });
  assert.equal(view.$$('.chat-shortcut-hint').length, 0);
  await act(async () => t.mock.timers.tick(499));
  assert.equal(view.$$('.chat-shortcut-hint').length, 0);
  await act(async () => t.mock.timers.tick(1));
  assert.deepEqual(
    view.$$('.chat-shortcut-hint').map((el) => el.textContent),
    ['Ctrl+1'],
  );
  await key(document.body, 'Meta', { metaKey: true });
  assert.deepEqual(
    view.$$('.chat-shortcut-hint').map((el) => el.textContent),
    [],
  );
  await fire(document.body, new KeyboardEvent('keyup', { key: 'Meta', bubbles: true }));
});
