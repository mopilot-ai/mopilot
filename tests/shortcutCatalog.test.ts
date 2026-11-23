// Behavioral invariants for the shared desktop shortcut catalog and cross-platform resolution.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SHORTCUT_ACTIONS,
  bindingsFor,
  effectiveBindings,
  resolveShortcut,
  bindingConflict,
  scopesOverlap,
  nativeRoleBindings,
} from '../shared/shortcuts.mjs';
import { comboFromEvent, toAccelerator, nativeShortcutAccelerator, isEditingShortcut } from '../shared/shortcutKeys.mjs';

export const GUARDS = ['shared/'];
const action = (id: string) => SHORTCUT_ACTIONS.find((a) => a.id === id)!;
test('every platform default resolves to its action in its owning scope without ambiguous defaults', () => {
  assert.equal(new Set(SHORTCUT_ACTIONS.map((a) => a.id)).size, SHORTCUT_ACTIONS.length);
  for (const platform of ['darwin', 'win32', 'linux'])
    for (const a of SHORTCUT_ACTIONS) {
      for (const key of bindingsFor(a, {}, platform)) {
        assert.equal(resolveShortcut(key, {}, a.scope, platform)?.id, a.id, `${platform} ${a.id} ${key}`);
        assert.equal(bindingConflict(a.id, key, {}, platform), undefined, `${platform} ${a.id}`);
        assert.ok(toAccelerator(key), `${a.id} has a native encoding`);
      }
    }
});
test('custom bindings replace all aliases, explicit removals remain removed, and custom bindings override defaults', () => {
  assert.deepEqual(bindingsFor(action('new-chat'), { 'new-chat': '⌘K' }), ['⌘K']);
  assert.deepEqual(bindingsFor(action('new-chat'), { 'new-chat': null }), []);
  assert.deepEqual(bindingsFor(action('new-chat'), { 'new-chat': '' }), []);
  assert.deepEqual(effectiveBindings(action('command-menu'), { 'new-chat': '⌘K' }), ['⇧⌘P']);
  assert.equal(resolveShortcut('⌘K', { 'new-chat': '⌘K' })?.id, 'new-chat');
  assert.equal(resolveShortcut('⇧⌘O', { 'new-chat': '⌘K' }), null);
  assert.equal(bindingConflict('new-chat', '⌘K', {})?.id, 'command-menu');
  assert.equal(bindingConflict('absent', '⌘K', {}), undefined);
  assert.deepEqual(bindingsFor(action('new-window'), {}), []);
});
test('terminal and browser retain local keys; other focus scopes do not acquire those actions', () => {
  assert.equal(resolveShortcut('⌘K', {}, 'terminal')?.id, 'clear-terminal');
  assert.equal(resolveShortcut('⌘K', {})?.id, 'command-menu');
  assert.equal(resolveShortcut('⇧⌘C', {}, 'browser')?.id, 'browser-copy-url');
  assert.equal(resolveShortcut('⇧⌘C', {})?.id, 'copy-cwd');
  assert.equal(resolveShortcut('⌃B', {}, 'terminal'), null);
  // a shell's Escape (⌃[) and ⌃] stay the terminal's; elsewhere they cycle the split view panes, never natively
  assert.equal(resolveShortcut('⌃[', {}, 'terminal'), null);
  assert.equal(resolveShortcut('⌃]', {}, 'terminal'), null);
  assert.equal(resolveShortcut('⌃[', {})?.id, 'prev-pane');
  assert.equal(resolveShortcut('⌃]', {})?.id, 'next-pane');
  assert.equal(action('next-pane').menu || action('prev-pane').menu, false);
  assert.deepEqual(bindingsFor(action('move-to-background'), {}), []);
  assert.equal(action('move-to-background').menu, false);
  assert.equal(resolveShortcut('⌃B', { 'move-to-background': '⌃B' }, 'terminal'), null);
  assert.equal(scopesOverlap('browser', 'terminal'), false);
  assert.equal(scopesOverlap('browser', 'browser'), true);
  assert.equal(scopesOverlap('chat', 'composer'), true);
  assert.equal(resolveShortcut('unassigned', {}), null);
  assert.equal(resolveShortcut('⌘F', {})?.id, 'find-in-chat');
  // a focused page or pane finds in the page, as Claude Desktop's and the ChatGPT app's browsers do
  assert.equal(resolveShortcut('⌘F', {}, 'browser')?.id, 'browser-find');
  assert.equal(resolveShortcut('⌘G', {}, 'browser')?.id, 'browser-find-next');
  assert.equal(resolveShortcut('⇧⌘G', {}, 'browser')?.id, 'browser-find-previous');
  assert.equal(resolveShortcut('F3', {}, 'browser', 'win32')?.id, 'browser-find-next');
  assert.equal(resolveShortcut('⇧F3', {}, 'browser', 'win32')?.id, 'browser-find-previous');
  assert.equal(resolveShortcut('⇧⌘G', {}, 'app', 'win32')?.id, 'open-changes', 'the review tab keeps its key outside the page');
  assert.equal(resolveShortcut('⌘G', {}), null);
  assert.equal(resolveShortcut('⇧⌘T', {}), null);
});
test('physical key matching includes keypad keys and Windows Super independently from Control', () => {
  const press = (code: string, key: string, mods: object = {}, mac = true) =>
    comboFromEvent({ code, key, ctrlKey: false, shiftKey: false, metaKey: false, altKey: false, ...mods }, mac);
  assert.equal(press('NumpadAdd', '+', { metaKey: true }), '⌘NumpadAdd');
  assert.equal(press('NumpadSubtract', '-', { metaKey: true }), '⌘NumpadSubtract');
  assert.equal(press('Numpad0', '0', { metaKey: true }), '⌘Numpad0');
  assert.equal(press('KeyD', 'D', { shiftKey: true, metaKey: true }, false), '⇧◆D');
  assert.equal(resolveShortcut('⇧◆D', {}, 'chat', 'win32')?.id, 'environment-action');
  assert.equal(press('KeyA', 'a', { altKey: true, shiftKey: true, ctrlKey: true }, false), '⌥⇧⌘A');
  assert.equal(press('ShiftLeft', 'Shift'), null);
  assert.equal(press('', 'F10'), 'F10');
  assert.equal(press('', 'é'), 'É');
  assert.equal(toAccelerator('F4'), 'F4');
  assert.equal(toAccelerator('⌘NumpadAdd'), 'CmdOrCtrl+numadd');
  for (const key of [null, '', '⌘', '⌘Dead', 'constructor', 'F25', 'A', '⇧A', 'Enter']) assert.equal(toAccelerator(key), null);
});

test('native roles are reserved for new assignments, while persisted editing overrides use contextual dispatch', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    for (const [role, key] of Object.entries(nativeRoleBindings(platform)))
      assert.equal(bindingConflict('pin', key, {}, platform)?.id, `native-${role}`);
    for (const key of ['⌘Z', '⇧⌘Z', '⌘C', '⌘X', '⌘V', '⇧⌘V', '⌘A']) {
      assert.equal(isEditingShortcut(key, platform), true);
      assert.equal(nativeShortcutAccelerator(key, platform), null);
    }
    assert.equal(nativeShortcutAccelerator('⌥⌘P', platform), 'Alt+CmdOrCtrl+P');
    assert.equal(nativeShortcutAccelerator('A', platform), null);
  }
  assert.equal(isEditingShortcut('⌥⇧⌘V'), true);
  assert.equal(isEditingShortcut('⌘Y', 'win32'), true);
  assert.equal(nativeShortcutAccelerator('⌘Q'), 'CmdOrCtrl+Q');
  assert.equal(resolveShortcut('⌘Z', { pin: '⌘Z' })?.id, 'pin');
});
