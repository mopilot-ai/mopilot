// Shortcut combos from key presses, and the Electron accelerators they become (#60).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { comboFromEvent } from '../src/lib/format.ts';
import { toAccelerator } from '../shared/shortcutKeys.mjs';

const press = (code: string, key: string, mods: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) =>
  comboFromEvent({ code, key, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods });

test('punctuation is named by its physical key, so Shift does not change it', () => {
  assert.equal(press('Semicolon', ':', { shiftKey: true, metaKey: true }), '⇧⌘;');
  assert.equal(press('Slash', '?', { shiftKey: true, metaKey: true }), '⇧⌘/');
  assert.equal(press('BracketLeft', '{', { shiftKey: true, metaKey: true }), '⇧⌘[');
  assert.equal(press('Backquote', '`', { ctrlKey: true }), '⌃`');
  assert.equal(press('Comma', ',', { metaKey: true }), '⌘,');
  // letters and digits ignore the layout's character too
  assert.equal(press('KeyA', 'å', { altKey: true, metaKey: true }), '⌥⌘A');
  assert.equal(press('Digit1', '!', { shiftKey: true }), '⇧1');
  assert.equal(press('Escape', 'Escape', { shiftKey: true }), '⇧Escape');
  assert.equal(press('MetaLeft', 'Meta', { metaKey: true }), null);
});

test('combos become Electron accelerators', () => {
  assert.equal(toAccelerator('⇧⌘;'), 'Shift+CmdOrCtrl+;');
  assert.equal(toAccelerator('⌘N'), 'CmdOrCtrl+N');
  assert.equal(toAccelerator('⌃`'), 'Ctrl+`');
  assert.equal(toAccelerator('⌃⌥⇧⌘K'), 'Ctrl+Alt+Shift+CmdOrCtrl+K');
  assert.equal(toAccelerator('⌥ArrowUp'), 'Alt+Up');
  assert.equal(toAccelerator('⌘ '), 'CmdOrCtrl+Space');
  assert.equal(toAccelerator('⌘F12'), 'CmdOrCtrl+F12');
  assert.equal(toAccelerator('⌘Dead'), null);
  assert.equal(toAccelerator('⌘'), null);
  assert.equal(toAccelerator(null), null);
});
