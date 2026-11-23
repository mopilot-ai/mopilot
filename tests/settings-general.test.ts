// Settings → General, Appearance and Keyboard shortcuts.
import { test, beforeEach } from 'node:test';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

import { DEFAULT_PALETTE } from '../shared/defaultPalette.mjs';
import {
  setup,
  calls,
  ctl,
  responses,
  resetCtl,
  defaultState,
  useStore,
  render,
  click,
  text,
  button,
  row,
  pick,
  options,
  setValue,
  key,
  flush,
  lastPrefs,
  toggle,
  blur,
} from './support/settings-harness.ts';
import { window } from './support/dom.ts';

await setup();
const { createElement: h } = await import('react');
const { Settings } = await import('../src/components/pages/Settings.tsx');

const prefs = (p: any) => useStore.setState({ prefs: { ...useStore.getState().prefs, ...p } });
const section = (s: string) => render(h(Settings, { section: s }));
beforeEach(() => {
  resetCtl();
  useStore.setState(defaultState(), true);
});

test('general toggles and selects write their prefs', async () => {
  const { host, unmount } = await section('general');
  const expectPrefs = async (action: () => Promise<any>, want: any) => {
    await action();
    assert.deepEqual(lastPrefs(), want);
  };
  await expectPrefs(() => toggle(host, 'Default permissions'), { permission: 'read-only' });
  await expectPrefs(() => toggle(host, 'Default permissions'), { permission: 'default' });
  await expectPrefs(() => toggle(host, 'Full access'), { permission: 'full-access' });
  assert.ok((row(host, 'Default permissions').querySelector('[role=switch]') as HTMLButtonElement).disabled);
  await expectPrefs(() => toggle(host, 'Full access'), { permission: 'default' });
  await expectPrefs(() => toggle(host, 'Expand panels'), { fullViewDefault: true });
  await expectPrefs(() => toggle(host, 'Show panel button'), { bottomPanelControl: false });
  await expectPrefs(() => toggle(host, 'iOS Simulator'), { simulatorIos: false });
  await expectPrefs(() => toggle(host, 'Android Emulator'), { simulatorAndroid: false });
  await expectPrefs(() => toggle(host, 'Show reasoning'), { showReasoning: false });
  await expectPrefs(() => toggle(host, 'Apply code review fixes automatically'), { autoApplyReviewFixes: true });
  await expectPrefs(() => toggle(host, 'Resume after quota resets'), { autoContinueOnLimit: false });
  await expectPrefs(() => toggle(host, 'Switch harness at a usage limit'), { autoSwitchHarnessOnLimit: true });
  await expectPrefs(() => toggle(host, 'Switch harness at a usage limit'), { autoSwitchHarnessOnLimit: false });
  await expectPrefs(() => click(button(row(host, 'Terminal position'), 'Right')), { defaultTerminal: 'right' });
  await expectPrefs(() => click(button(row(host, 'Follow-up behavior'), 'Steer')), { followUp: 'steer' });
  assert.equal(
    [...host.querySelectorAll('.settings-row-title')].some((e) => e.textContent === 'Sessions working at once'),
    false,
  );
  await expectPrefs(() => pick(row(host, 'When you ask for an unrelated task'), 'Always start a new session'), { newTaskPrompt: 'new' });
  await expectPrefs(() => pick(row(host, 'Confirm before quitting'), 'Always'), { confirmClose: 'always' });
  await click(row(host, 'Send with').querySelector('.select-btn')!);
  assert.deepEqual(options(row(host, 'Send with')), ['Enter', '⌘ Enter']);
  await expectPrefs(() => click([...row(host, 'Send with').querySelectorAll('.menu-item')][1]), { sendWith: 'cmdEnter' });
  await expectPrefs(() => pick(row(host, 'Notifications'), 'Never'), { notifyOnComplete: 'never' });
  await expectPrefs(() => toggle(host, 'Run scheduled tasks'), { schedulerOff: true });
  await expectPrefs(() => toggle(host, 'Run scheduled tasks'), { schedulerOff: false });
  await toggle(host, 'Show in menu bar');
  // the setting changes once main has shown the menu bar item
  assert.deepEqual(calls.slice(-2), [
    ['app.setTray', true],
    ['setPrefs', { showInMenuBar: true }],
  ]);
  // a setting every harness reads links to no one harness's docs
  assert.equal(row(host, 'Full access').querySelector('a'), null);
  await unmount();
});

test('notification kinds default on, follow saved choices, and lock when notifications are off', async () => {
  prefs({ notifyKinds: { turn: false } });
  const { host, unmount } = await section('general');
  const kinds = () => [...row(host, 'Notifications').querySelectorAll('.notify-kind [role=switch]')] as HTMLButtonElement[];
  assert.deepEqual(
    kinds().map((k) => k.getAttribute('aria-checked')),
    ['false', 'true', 'true', 'true', 'true', 'true'],
  );
  assert.deepEqual(
    [...row(host, 'Notifications').querySelectorAll('.notify-kind')].map((k) => text(k)),
    'Task finishedPhone off|Approval needed|Goal updatesPhone off|Scheduled task started|Sign-in needed|Computer use'.split('|'),
  );
  await click(kinds()[1]);
  assert.deepEqual(lastPrefs(), { notifyKinds: { turn: false, approval: false } });
  prefs({ notifyOnComplete: 'never' });
  await flush();
  assert.ok(kinds().every((k) => k.disabled));
  await unmount();
});

test('there is a switch for every kind of notification the windows send, Computer use included, and none for a pull request', async () => {
  const { KINDS } = createRequire(import.meta.url)('../electron/platform/notify.cjs');
  prefs({ notifyKinds: {} });
  const { host, unmount } = await section('general');
  const switched = new Set<string>();
  for (const k of row(host, 'Notifications').querySelectorAll<HTMLButtonElement>('.notify-kind [role=switch]')) {
    await click(k);
    for (const kind of Object.keys(lastPrefs().notifyKinds)) switched.add(kind);
  }
  // the windows' kinds; MoMo's switch is in Settings › MoMo, and a pull request never notifies (#3661)
  assert.deepEqual([...switched].sort(), [...KINDS].sort());
  assert.ok(switched.has('computer'));
  await unmount();
});

test('task folder shows a shortened path and changes only when a folder is picked', async () => {
  prefs({ projectlessFolder: '/Users/me/some/very/long/path/to/the/projectless/folder' });
  const { host, unmount } = await section('general');
  const path = text(row(host, 'Task folder').querySelector('.settings-path'));
  assert.equal(path.length, 26);
  assert.ok(path.startsWith('/Users/me/som…'));
  responses['dialog.openFolder'] = null;
  await click(button(row(host, 'Task folder'), 'Change'));
  assert.equal(lastPrefs(), undefined);
  responses['dialog.openFolder'] = '/tmp/tasks';
  await click(button(row(host, 'Task folder'), 'Change'));
  assert.deepEqual(lastPrefs(), { projectlessFolder: '/tmp/tasks' });
  assert.equal(text(row(host, 'Task folder').querySelector('.settings-path')), '/tmp/tasks');
  await unmount();
});

test('open-in lists installed apps plus the current one, each with a cached icon', async () => {
  prefs({ openDestination: 'zed' });
  let installed!: (v: any) => void;
  responses['app.installed'] = () => new Promise((r) => (installed = r));
  responses['app.icon'] = (id: string) => Promise.resolve(id === 'zed' ? 'data:zed' : null);
  const { host, unmount } = await section('general');
  const r = row(host, 'Open files in');
  await click(r.querySelector('.select-btn')!);
  assert.equal(options(r).length, 7);
  await act2(() => installed({ finder: true, cursor: true }));
  assert.deepEqual(options(r), ['Finder', 'Cursor', 'Zed']);
  assert.equal(r.querySelector('img')?.getAttribute('src'), 'data:zed');
  await click([...r.querySelectorAll('.menu-item')][1]);
  assert.deepEqual(lastPrefs(), { openDestination: 'cursor' });
  await flush();
  await unmount();
  const icons = calls.filter((c) => c[0] === 'app.icon').length;
  const again = await section('general');
  await flush();
  assert.equal(calls.filter((c) => c[0] === 'app.icon').length, icons);
  await again.unmount();
});
const act2 = async (fn: () => any) => {
  fn();
  await flush();
};

test('appearance mode, accent presets and the advanced sizes', async () => {
  const { host, unmount } = await section('appearance');
  await click(host.querySelector('.mode-thumb.dark')!);
  assert.deepEqual(lastPrefs(), { theme: 'dark' });
  assert.equal(host.querySelector('.mode-thumb.dark')!.getAttribute('title'), 'Dark');
  assert.ok(host.querySelector('.mode-thumb.dark.on'));
  const accent = row(host, 'Accent');
  assert.equal(text(accent.querySelector('.select-btn')), 'Default');
  await pick(accent, 'Purple');
  assert.deepEqual(lastPrefs(), { accent: 'purple' });
  await pick(accent, 'Default');
  assert.deepEqual(lastPrefs(), { accent: null });
  assert.equal(text(row(host, 'Background').querySelector('.color-input')), DEFAULT_PALETTE.light.bg.toUpperCase());
  assert.equal(text(row(host, 'Foreground').querySelector('.color-input')), DEFAULT_PALETTE.light.fg.toUpperCase());
  await setValue(row(host, 'Background').querySelector('input')!, '#abcdef');
  assert.deepEqual(lastPrefs(), { bgOverride: '#ABCDEF' });
  await setValue(row(host, 'Foreground').querySelector('input')!, '#123456');
  assert.deepEqual(lastPrefs(), { fgOverride: '#123456' });
  assert.equal(host.querySelector('.settings-row .settings-row-title')!.textContent, 'Mode');
  await click(button(host, 'Reset to default'));
  assert.deepEqual(lastPrefs(), {
    accent: null,
    bgOverride: null,
    fgOverride: null,
    fontFamily: null,
    themePreset: null,
    fontSize: 14,
    codeFontSize: 12,
  });
  assert.equal(
    [...host.querySelectorAll('.settings-row-title')].some((t) => text(t) === 'Chat font size'),
    false,
  );
  await click(button(host, 'Advanced'));
  await pick(row(host, 'Chat font size'), '16px');
  assert.deepEqual(lastPrefs(), { fontSize: 16 });
  await pick(row(host, 'Code font size'), '13px');
  assert.deepEqual(lastPrefs(), { codeFontSize: 13 });
  await toggle(host, 'Wrap long lines');
  assert.deepEqual(lastPrefs(), { wrapCode: true });
  await click(button(host, 'Advanced'));
  assert.equal(
    [...host.querySelectorAll('.settings-row-title')].some((t) => text(t) === 'Chat font size'),
    false,
  );
  await unmount();
});

test('a custom accent or a theme palette switches the accent to a color input', async () => {
  prefs({ accent: '#ABCDEF' });
  const { host, unmount } = await section('appearance');
  const accent = () => row(host, 'Accent');
  assert.equal(text(accent().querySelector('.select-btn')), 'Custom');
  assert.equal(text(accent().querySelector('.color-input')), '#ABCDEF');
  await pick(accent(), 'Custom');
  assert.equal(lastPrefs(), undefined);
  await pick(accent(), 'Green');
  assert.deepEqual(lastPrefs(), { accent: 'green' });
  prefs({ accent: '#ABCDEF' });
  await flush();
  await pick(accent(), 'Default');
  assert.deepEqual(lastPrefs(), { accent: null });
  prefs({ accent: '#ABCDEF' });
  await flush();
  await setValue(accent().querySelector('input')!, '#00ff00');
  assert.deepEqual(lastPrefs(), { accent: '#00FF00' });
  // a palette without an override shows the palette's colors
  ctl.dark = true;
  prefs({ accent: null, themePreset: 'dracula' });
  await flush();
  assert.equal(text(accent().querySelector('.color-input')), '#FF79C6');
  assert.equal(text(row(host, 'Background').querySelector('.color-input')), '#282A36');
  assert.equal(text(row(host, 'Foreground').querySelector('.color-input')), '#F8F8F2');
  const swatch = () => (accent().querySelector('.select-btn .color-dot') as HTMLElement).style.background;
  // an unknown named accent falls back to the default color; a dark theme without a preset has dark defaults
  prefs({ accent: 'weird', themePreset: null });
  await flush();
  assert.equal(text(accent().querySelector('.select-btn')), 'Default');
  assert.equal(text(row(host, 'Background').querySelector('.color-input')), DEFAULT_PALETTE.dark.bg.toUpperCase());
  // the Default swatch shows the accent this mode paints
  assert.equal(swatch(), DEFAULT_PALETTE.dark.accent);
  assert.equal(text(row(host, 'Foreground').querySelector('.color-input')), DEFAULT_PALETTE.dark.fg.toUpperCase());
  // a dark-only preset in light mode has no palette
  ctl.dark = false;
  prefs({ accent: null, themePreset: 'ayu' });
  await flush();
  assert.equal(text(accent().querySelector('.select-btn')), 'Default');
  assert.equal(text(host.querySelector('.theme-select')), 'AaAyu');
  assert.equal(swatch(), DEFAULT_PALETTE.light.accent);
  await unmount();
});

test('theme picker lists themes for the current mode and clears overrides when choosing', async () => {
  prefs({ themePreset: 'proof', bgOverride: '#000000' });
  const { host, unmount } = await section('appearance');
  const picker = host.querySelector('.theme-select')!;
  assert.equal(text(picker), 'AaProof');
  assert.ok((picker.querySelector('.theme-badge') as HTMLElement).getAttribute('style'));
  await click(picker);
  const items = () => [...host.querySelectorAll('.menu .menu-item')];
  assert.ok(items().some((i) => text(i).endsWith('Proof')));
  assert.ok(!items().some((i) => text(i).endsWith('Ayu')));
  assert.equal(
    items()
      .find((i) => text(i).endsWith('Proof'))!
      .getAttribute('aria-checked'),
    'true',
  );
  await click(items().find((i) => text(i).endsWith('GitHub'))!);
  assert.deepEqual(lastPrefs(), { themePreset: 'github', bgOverride: null, fgOverride: null, accent: null });
  await click(host.querySelector('.theme-select')!);
  await click(items().find((i) => text(i) === 'AaDefault')!);
  assert.deepEqual(lastPrefs(), { themePreset: null, bgOverride: null, fgOverride: null, accent: null });
  assert.equal(text(host.querySelector('.theme-select')), 'AaDefault');
  ctl.dark = true;
  prefs({ themePreset: 'proof' });
  await flush();
  assert.equal(host.querySelector('.theme-select .theme-badge')!.getAttribute('style'), null);
  await click(host.querySelector('.theme-select')!);
  assert.ok(items().some((i) => text(i).endsWith('Ayu')));
  await unmount();
});

test('importing a VS Code theme reads its colors, and bad files are rejected', async () => {
  const { host, unmount } = await section('appearance');
  const importBtn = () => button(host, 'Import Light theme');
  responses['dialog.openFiles'] = [];
  await click(importBtn());
  assert.equal(
    calls.some((c) => c[0] === 'fs.readText'),
    false,
  );
  responses['dialog.openFiles'] = ['/t.json'];
  const files = [
    [
      { name: 'Night', background: '#112233ff', foreground: '#445566', accent: '#778899' },
      { themePreset: null, bgOverride: '#112233', fgOverride: '#445566', accent: '#778899' },
      'Imported Night',
    ],
    [
      { colors: { 'editor.background': '#000000', foreground: '#ffffff', focusBorder: '#123456' } },
      { themePreset: null, bgOverride: '#000000', fgOverride: '#FFFFFF', accent: '#123456' },
      'Imported theme',
    ],
    [
      { colors: { 'editor.background': '#000000', 'editor.foreground': '#eeeeee', 'button.background': '#abcdef' } },
      { themePreset: null, bgOverride: '#000000', fgOverride: '#EEEEEE', accent: '#ABCDEF' },
      'Imported theme',
    ],
    [
      { background: '#000000', foreground: '#ffffff' },
      { themePreset: null, bgOverride: '#000000', fgOverride: '#FFFFFF', accent: null },
      'Imported theme',
    ],
  ] as const;
  for (const [file, want, msg] of files) {
    responses['fs.readText'] = JSON.stringify(file);
    calls.length = 0;
    await click(importBtn());
    assert.deepEqual(lastPrefs(), want);
    assert.deepEqual(calls.at(-1), ['toast', msg]);
  }
  for (const bad of [JSON.stringify({ colors: {} }), null, 'not json']) {
    responses['fs.readText'] = bad;
    calls.length = 0;
    await click(importBtn());
    assert.equal(lastPrefs(), undefined);
    assert.deepEqual(calls.at(-1), ['toast', 'That file isn’t a color theme', 'error']);
  }
  await unmount();
});

/** The default palette as the theme export writes it. */
const exported = (p: { bg: string; fg: string; accent: string }) => ({ background: p.bg, foreground: p.fg, accent: p.accent });

test('copying the theme exports the effective colors for the current mode', async () => {
  const copied = () => JSON.parse(calls.filter((c) => c[0] === 'clipboard.write').at(-1)![1]);
  const { host, unmount } = await section('appearance');
  await click(button(host, 'Copy Light theme'));
  assert.deepEqual(copied(), { name: 'Custom', type: 'light', ...exported(DEFAULT_PALETTE.light) });
  assert.deepEqual(calls.at(-1), ['toast', 'Theme copied']);
  ctl.dark = true;
  prefs({ themePreset: 'dracula' });
  await flush();
  await click(button(host, 'Copy Dark theme'));
  assert.deepEqual(copied(), { name: 'Dracula', type: 'dark', background: '#282A36', foreground: '#F8F8F2', accent: '#FF79C6' });
  prefs({ themePreset: null, bgOverride: '#010101', fgOverride: '#020202', accent: '#030303' });
  await flush();
  await click(button(host, 'Copy Dark theme'));
  assert.deepEqual(copied(), { name: 'Custom', type: 'dark', background: '#010101', foreground: '#020202', accent: '#030303' });
  prefs({ bgOverride: null, fgOverride: null, accent: null });
  await flush();
  await click(button(host, 'Copy Dark theme'));
  assert.deepEqual(copied(), { name: 'Custom', type: 'dark', ...exported(DEFAULT_PALETTE.dark) });
  await unmount();
});

test('font select lists installed fonts once, keeps an unknown saved font, and maps System to null', async () => {
  // no local-fonts API, then one that fails: only System is offered
  let r = await section('appearance');
  await click(row(r.host, 'Font').querySelector('.select-btn')!);
  assert.deepEqual(options(row(r.host, 'Font')), ['System']);
  await r.unmount();
  (window as any).queryLocalFonts = () => Promise.reject(new Error('denied'));
  r = await section('appearance');
  await flush();
  await r.unmount();
  let queries = 0;
  (window as any).queryLocalFonts = async () => {
    queries++;
    return [{ family: 'Menlo' }, { family: '.Hidden' }, { family: 'Arial' }, { family: 'Menlo' }];
  };
  prefs({ fontFamily: 'Comic' });
  r = await section('appearance');
  await flush();
  const font = () => row(r.host, 'Font');
  assert.equal(text(font().querySelector('.select-btn')), 'Comic');
  await click(font().querySelector('.select-btn')!);
  assert.deepEqual(options(font()), ['System', 'Arial', 'Menlo', 'Comic']);
  await click([...font().querySelectorAll('.menu-item')][2]);
  assert.deepEqual(lastPrefs(), { fontFamily: 'Menlo' });
  await click([...font().querySelectorAll('.menu-item')][0]);
  assert.deepEqual(lastPrefs(), { fontFamily: null });
  await r.unmount();
  r = await section('appearance');
  await flush();
  assert.equal(queries, 1);
  await click(font().querySelector('.select-btn')!);
  assert.deepEqual(options(font()), ['System', 'Arial', 'Menlo']);
  await r.unmount();
  delete (window as any).queryLocalFonts;
});

test('shortcuts show bindings, record a new combo, ignore modifiers, and can be removed', async () => {
  prefs({ keybindings: { 'new-chat': '⌘M', search: null } });
  responses['prefs.binding'] = (id: string, value?: string | null) => {
    const bindings = { ...useStore.getState().prefs.keybindings };
    if (value === undefined) delete bindings[id];
    else bindings[id] = value;
    useStore.setState({ prefs: { ...useStore.getState().prefs, keybindings: bindings } });
    return Promise.resolve(true);
  };
  const { host, unmount } = await section('shortcuts');
  assert.equal(text(row(host, 'New chat').querySelector('kbd')), '[⌘M]');
  assert.equal(text(row(host, 'Search chats').querySelector('.settings-value')), 'Unassigned');
  assert.equal(row(host, 'Search chats').querySelectorAll('button').length, 2);
  assert.equal(text(row(host, 'Open in new window').querySelector('.settings-value')), 'Unassigned');
  assert.equal(text(row(host, 'Toggle sidebar').querySelector('kbd')), '[⌘B] / [⇧⌘S]');
  await setValue(host.querySelector('.shortcuts-search input')!, 'TOGGLE S');
  assert.deepEqual([...host.querySelectorAll('.settings-row-title')].map(text), ['Toggle sidebar']);
  await setValue(host.querySelector('.shortcuts-search input')!, '');
  const edit = () => row(host, 'New chat').querySelectorAll('button')[0];
  await click(edit());
  assert.equal(text(row(host, 'New chat').querySelector('.kbd-recording')), 'Press keys…');
  await key(window as any, { key: 'Escape', code: 'Escape' });
  assert.equal(row(host, 'New chat').querySelector('.kbd-recording'), null);
  await click(edit());
  await key(window as any, { key: 'Shift', code: 'ShiftLeft', shiftKey: true });
  assert.ok(row(host, 'New chat').querySelector('.kbd-recording'));
  await key(window as any, { key: 'k', code: 'KeyK', metaKey: true });
  assert.match(host.querySelector('[role="alert"]')!.textContent!, /Already used/);
  await key(window as any, { key: 'x', code: 'KeyX', metaKey: true, shiftKey: true });
  assert.deepEqual(useStore.getState().prefs.keybindings, { 'new-chat': '⇧⌘X', search: null });
  assert.equal(row(host, 'New chat').querySelector('.kbd-recording'), null);
  await click(row(host, 'New chat').querySelector('[aria-label="Remove shortcut"]')!);
  assert.deepEqual(useStore.getState().prefs.keybindings, { 'new-chat': null, search: null });
  await unmount();
});

test('the menu bar switch says when main could not change it, either way', async () => {
  responses['app.setTray'] = () => Promise.reject(new Error('no tray'));
  const { host, unmount } = await section('general');
  await toggle(host, 'Show in menu bar');
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't show MoPilot in the menu bar: no tray", 'error']);
  assert.equal(useStore.getState().prefs.showInMenuBar, false, 'not shown, so not saved as shown');
  prefs({ showInMenuBar: true });
  await flush();
  await toggle(host, 'Show in menu bar');
  await flush();
  assert.deepEqual(calls.at(-1), ['toast', "Couldn't remove it from the menu bar: no tray", 'error']);
  assert.equal(useStore.getState().prefs.showInMenuBar, true);
  await unmount();
});

test("open-in offers every app when the installed list can't be read; an icon that fails or arrives late is left out", async () => {
  responses['app.installed'] = () => Promise.reject(new Error('no list'));
  responses['app.icon'] = () => Promise.reject(new Error('no icon'));
  prefs({ openDestination: 'xcode' });
  const { host, unmount } = await section('general');
  await flush();
  const r = row(host, 'Open files in');
  await click(r.querySelector('.select-btn')!);
  assert.equal(options(r).length, 7);
  assert.equal(r.querySelector('img'), null);
  // an icon for an app the select has moved past does not replace the new one's
  let late!: (u: string) => void;
  responses['app.icon'] = (id: string) => (id === 'terminal' ? new Promise((res) => (late = res)) : Promise.resolve('data:iterm'));
  prefs({ openDestination: 'terminal' });
  await flush();
  prefs({ openDestination: 'iterm' });
  await flush();
  late('data:terminal');
  await flush();
  assert.equal(row(host, 'Open files in').querySelector('img')?.getAttribute('src'), 'data:iterm');
  await unmount();
});

test('notification quiet hours: off by default, on at the usual times, each time saves when left, the same time is refused, off clears', async () => {
  const { host, unmount } = await section('general');
  const quiet = () => row(host, 'Notification quiet hours');
  assert.equal(quiet().querySelector('input'), null, 'off: no times');
  assert.match(text(quiet()), /Off/);
  await toggle(host, 'Notification quiet hours');
  assert.deepEqual(lastPrefs(), { notifyQuietHours: { start: '22:00', end: '07:00' } });
  prefs({ notifyQuietHours: { start: '22:00', end: '07:00' } });
  await flush();
  const start = quiet().querySelector<HTMLInputElement>('[aria-label="Notification quiet hours start"]')!;
  const end = quiet().querySelector<HTMLInputElement>('[aria-label="Notification quiet hours end"]')!;
  assert.deepEqual([start.value, end.value], ['22:00', '07:00']);
  assert.match(text(quiet()), /Your phone hears once when they end/);
  await setValue(start, '23:30');
  await blur(start);
  assert.deepEqual(lastPrefs(), { notifyQuietHours: { start: '23:30', end: '07:00' } });
  prefs({ notifyQuietHours: { start: '23:30', end: '07:00' } });
  await flush();
  await setValue(end, '23:30');
  await blur(end);
  assert.deepEqual(calls.filter((c) => c[0] === 'toast').at(-1), ['toast', "Quiet hours can't start and end at the same time", 'error']);
  assert.deepEqual(lastPrefs(), { notifyQuietHours: { start: '23:30', end: '07:00' } }, 'nothing new was saved');
  await toggle(host, 'Notification quiet hours');
  assert.deepEqual(lastPrefs(), { notifyQuietHours: null });
  await unmount();
});
