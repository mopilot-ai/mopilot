// Native menu shortcut conflicts and legacy customization ownership using the real Electron main fixture.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import edition from '../../../shared/edition.json' with { type: 'json' };
export function registerMenuShortcutCases({ ready, calls }: any) {
  test('legacy native-role overrides disable the competing role and route editing keys through the renderer', async () => {
    const h = await ready({ state: { prefs: { keybindings: { pin: '⌘Q', rename: '⌘Z', 'new-chat': '⌘M' } } } });
    const template = calls(h.electron.Menu.setApplicationMenu).at(-1)![0].template;
    const items = template.flatMap((m: any) => m.submenu ?? []);
    for (const role of ['quit', 'undo', 'minimize']) assert.equal(items.find((i: any) => i.role === role).accelerator, null);
    assert.equal(
      items.some((i: any) => i.accelerator === 'CmdOrCtrl+Z'),
      false,
    );
    const pin = items.find((i: any) => i.accelerator === 'CmdOrCtrl+Q');
    assert.ok(pin);
    pin.click(undefined, undefined, { triggeredByAccelerator: true });
    assert.deepEqual(h.windows[0].webContents.on_('app:command').at(-1), ['shortcut', { id: 'pin', combo: '⌘Q' }]);
  });
  test('Windows menu: Settings and Exit in File, updates and About in Help, no paste-and-match', async () => {
    const h = await ready({ platform: 'win32' });
    const template = calls(h.electron.Menu.setApplicationMenu)[0][0].template;
    assert.equal(template[0].label, 'File');
    const file = template[0].submenu;
    assert.deepEqual(
      file.slice(-4).map((i: any) => i.label ?? i.role ?? i.type),
      ['Settings…', 'separator', 'Close Tab or Window', 'Exit'],
    );
    const help = template.find((m: any) => m.role === 'help').submenu;
    assert.deepEqual(
      help.slice(-2).map((i: any) => i.label),
      ['Check for Updates…', `About ${edition.desktop.name}`],
    );
    const edit = template.find((m: any) => m.label === 'Edit').submenu;
    assert.equal(
      edit.some((i: any) => i.role === 'pasteAndMatchStyle'),
      false,
    );
    // Help → Report a Bug… opens the focused window's bug report
    const report = help.find((i: any) => i.label === 'Report a Bug…');
    for (const i of [file.at(-4), file.at(-2), ...help.slice(-2), report]) i.click();
    assert.deepEqual(
      h.windows[0].webContents.on_('app:command').map((c: any) => (c[0] === 'shortcut' ? c[1].id : c[0])),
      ['settings', 'close-tab', 'about', 'about', 'report-bug'],
    );
    assert.equal(h.one('Updater').check.mock.callCount(), 1);
  });
  test('Help → Join the Community opens the shared community link in the browser, on every platform', async () => {
    for (const platform of ['darwin', 'win32']) {
      const h = await ready({ platform });
      const template = calls(h.electron.Menu.setApplicationMenu).at(-1)![0].template;
      template
        .find((m: any) => m.role === 'help')
        .submenu.find((i: any) => i.label === 'Join the Community')
        .click();
      assert.deepEqual(calls(h.electron.shell.openExternal).at(-1), ['https://mopilot.ai/discord']);
    }
  });
  test('persisted duplicate overrides produce only one native accelerator and one resolved action', async () => {
    const h = await ready({ state: { prefs: { keybindings: { 'new-chat': '⇧⌘Y', pin: '⇧⌘Y', rename: '⇧⌘Y' } } } });
    const template = calls(h.electron.Menu.setApplicationMenu).at(-1)[0].template;
    const entries = template.flatMap((m: any) => m.submenu ?? []).filter((i: any) => i.accelerator === 'Shift+CmdOrCtrl+Y');
    assert.equal(entries.length, 1);
    entries[0].click(undefined, undefined, { triggeredByAccelerator: true });
    assert.deepEqual(h.windows[0].webContents.on_('app:command').at(-1), ['shortcut', { id: 'new-chat', combo: '⇧⌘Y' }]);
  });
  test('legacy plain and editor bindings stay available without a native text-stealing accelerator', async () => {
    for (const key of ['A', '⌘Z']) {
      const h = await ready({ state: { prefs: { keybindings: { 'new-chat': key } } } });
      const template = calls(h.electron.Menu.setApplicationMenu).at(-1)[0].template;
      assert.equal(template[1].submenu.find((i: any) => i.label === 'New Chat').accelerator, undefined);
    }
  });
  test('visible menu clicks retain the labeled action, while native keys retain contextual resolution', async () => {
    const h = await ready({ state: { prefs: { keybindings: { 'new-chat': '⇧⌘Y', 'open-folder': '⇧⌘Y' } } } });
    const template = calls(h.electron.Menu.setApplicationMenu).at(-1)[0].template;
    const file = template.find((i: any) => i.label === 'File').submenu;
    file.find((i: any) => i.label === 'New Chat').click();
    file.find((i: any) => i.label === 'Copy Working Directory').click();
    const menu = template.find((i: any) => i.label === 'View').submenu.find((i: any) => i.label === 'Command Menu…');
    menu.click();
    menu.click(undefined, undefined, { triggeredByAccelerator: true });
    assert.deepEqual(h.windows[0].webContents.on_('app:command'), [
      ['shortcut', { id: 'new-chat' }],
      ['shortcut', { id: 'copy-cwd' }],
      ['shortcut', { id: 'command-menu' }],
      ['shortcut', { id: 'command-menu', combo: '⇧⌘P' }],
    ]);
  });
}
