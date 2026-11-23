// Xterm key interception keeps clear shortcuts out of the PTY and leaves ordinary shell input untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { terminalShortcut } from '../src/lib/terminalShortcuts.ts';
test('clear is intercepted before xterm and exactly one owner handles native menu aliases', () => {
  let clears = 0,
    shellWrites = 0;
  const key = (init: any, bindings = {}, platform = 'darwin') => {
    const event = new window.KeyboardEvent('keydown', { cancelable: true, ...init });
    const pass = terminalShortcut(event as unknown as KeyboardEvent, bindings, () => clears++, platform);
    if (pass) shellWrites++;
    return [pass, event.defaultPrevented];
  };
  assert.deepEqual(key({ key: 'l', code: 'KeyL', ctrlKey: true }), [false, true]);
  assert.equal(clears, 1);
  assert.equal(shellWrites, 0);
  assert.deepEqual(key({ key: 'k', code: 'KeyK', metaKey: true }), [false, true]);
  assert.equal(clears, 1, 'native command owns Cmd+K');
  key({ key: 'l', code: 'KeyL', ctrlKey: true, repeat: true });
  assert.equal(clears, 1);
  key({ key: 'l', code: 'KeyL', ctrlKey: true, isComposing: true });
  key({ key: 'b', code: 'KeyB', ctrlKey: true });
  key({ key: 'x', code: 'KeyX' });
  key({ key: 'Control', code: 'ControlLeft' });
  assert.equal(shellWrites, 4);
  assert.deepEqual(key({ key: 'l', code: 'KeyL', ctrlKey: true }, {}, 'win32'), [false, true]);
  assert.equal(clears, 2);
  key({ key: 'l', code: 'KeyL', ctrlKey: true }, { 'clear-terminal': null });
  assert.equal(shellWrites, 5);
  assert.deepEqual(key({ key: 'a', code: 'KeyA' }, { 'clear-terminal': 'A' }), [true, false]);
  assert.deepEqual(key({ key: 'z', code: 'KeyZ', metaKey: true }, { 'clear-terminal': '⌘Z' }), [true, false]);
  assert.equal(
    terminalShortcut(new window.KeyboardEvent('keyup') as unknown as KeyboardEvent, {}, () => clears++, 'darwin'),
    true,
  );
});
