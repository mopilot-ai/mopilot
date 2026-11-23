// electron/main.cjs: windows, navigation guard, Quick Chat, tray, menus, shortcuts, downloads and
// Codex binary discovery, over a fake Electron (tests/support/electron-main-harness.ts).
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import { registerMenuShortcutCases } from './support/electron-wiring/menu-shortcuts';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { loadMain, unloadMain, flush } from './support/electron-main-harness.ts';
import { DEFAULT_PALETTE } from '../shared/defaultPalette.mjs';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());
const calls = (f: any) => f.mock.calls.map((c: any) => c.arguments);
const APP_PAGE = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', 'dist', 'index.html');
const ready = async (cfg: any = {}) => {
  const h = await loadMain(cfg);
  await h.ready();
  return h;
};
/** every menu item with a click handler */
const items = (template: any[]) => {
  const out: any[] = [];
  const walk = (list: any[]) => list.forEach((i) => (i.click && out.push(i), i.submenu && walk(i.submenu)));
  walk(template);
  return out;
};

test('the main window opens before first paint and never repeats its initial reveal', async () => {
  const h = await ready();
  const w = h.windows[0];
  assert.equal(w.opts.titleBarStyle, 'hiddenInset');
  assert.equal(w.opts.webPreferences.contextIsolation, true);
  assert.match(w.opts.webPreferences.preload, /electron\/preload\.cjs$/);
  assert.deepEqual(w.loaded, [['file', APP_PAGE, undefined]]);
  assert.deepEqual(w.log, ['show'], 'navigation starts without waiting for first paint to show the window');
  w.emit('ready-to-show');
  assert.deepEqual(w.log, ['show']);
  mock.timers.tick(2500);
  assert.deepEqual(w.log, ['show'], 'already visible');
  // Replacement windows open immediately too; a later paint cannot reopen a closed one.
  await h.invoke('window:open', 'settings');
  const w2 = h.windows[1];
  assert.deepEqual(w2.loaded, [['file', APP_PAGE, { hash: 'settings' }]]);
  await h.invoke('window:open');
  const w3 = h.windows[2];
  w3.close();
  const closedLog = [...w3.log];
  w3.emit('ready-to-show');
  mock.timers.tick(2500);
  assert.deepEqual(w2.log, ['show']);
  assert.deepEqual(w3.log, closedLog);
});

for (const action of ['hide', 'quit'] as const) {
  test(`late first paint and the old fallback cannot undo a later ${action}`, async () => {
    const h = await ready();
    const w = h.windows[0];
    if (action === 'hide') w.hide();
    else {
      h.inst.exitGate[0].passed = true;
      h.app.emit('before-quit', { preventDefault() {} });
    }
    w.emit('ready-to-show');
    mock.timers.tick(2500);
    assert.equal(w.isVisible(), false, 'the later window action supersedes startup');
    assert.deepEqual(w.log, ['show', 'hide']);
  });
}

test('focus, blur and full screen are sent to the window; closing forgets it', async () => {
  const h = await ready();
  const w = h.windows[0];
  w.focused = true;
  w.emit('focus');
  w.focused = false;
  w.emit('blur');
  w.emit('enter-full-screen');
  w.emit('leave-full-screen');
  assert.deepEqual(w.webContents.on_('window:focus'), [[true], [false]]);
  assert.deepEqual(w.webContents.on_('window:fullscreen'), [[true], [false]]);
  w.webContents.emit('did-start-loading');
  w.close();
  w.emit('focus');
  assert.equal(w.webContents.on_('window:focus').length, 2, 'nothing sent to a closed window');
  h.app.emit('activate');
  assert.equal(h.windows.length, 2, 'the closed window no longer counts');
});

test("focusing a window opens every chat its panes show; a reload or close forgets the window's view", async () => {
  const h = await ready();
  const w = h.windows[0];
  const viewed = () => h.inst.computerUse[0].onViewed.mock.calls.map((c: any) => c.arguments[0]);
  await h.invokeFrom(w.webContents, 'app:viewing', { visible: ['p', 'a'], focused: 'a' });
  assert.deepEqual(viewed(), ['p', 'a']);
  w.emit('focus');
  assert.deepEqual(viewed(), ['p', 'a', 'p', 'a']);
  // the same view again opens nothing more; after a reload it is a new view
  await h.invokeFrom(w.webContents, 'app:viewing', { visible: ['p', 'a'], focused: 'p' });
  assert.equal(viewed().length, 4);
  w.webContents.emit('did-start-loading');
  w.emit('focus');
  assert.equal(viewed().length, 4, 'a reloading window shows nothing yet');
  await h.invokeFrom(w.webContents, 'app:viewing', { visible: ['p'], focused: 'p' });
  assert.deepEqual(viewed().slice(4), ['p']);
  w.close();
  w.emit('focus');
  assert.equal(viewed().length, 5);
});

test('Windows: no frame, caption buttons in the theme colors', async () => {
  let h = await ready({ platform: 'win32' });
  assert.deepEqual(h.windows[0].opts.titleBarOverlay, {
    color: DEFAULT_PALETTE.light.bg,
    symbolColor: DEFAULT_PALETTE.light.fg,
    height: 44,
  });
  h = await loadMain({ platform: 'win32' });
  h.electron.nativeTheme.shouldUseDarkColors = true;
  await h.ready();
  assert.deepEqual(h.windows[0].opts.titleBarOverlay, { color: DEFAULT_PALETTE.dark.bg, symbolColor: DEFAULT_PALETTE.dark.fg, height: 44 });
  assert.equal(h.windows[0].opts.titleBarStyle, 'hidden');
});

test('SAGE_BOUNDS places the window; the dev server is loaded in development', async () => {
  const h = await ready({ env: { SAGE_BOUNDS: '1,2,300,400', VITE_DEV_SERVER_URL: 'http://localhost:5173' } });
  const w = h.windows[0];
  assert.deepEqual(w.bounds, { x: 1, y: 2, width: 300, height: 400 });
  assert.deepEqual(w.loaded, [['url', 'http://localhost:5173']]);
  await h.invoke('window:open', 'x');
  assert.deepEqual(h.windows[1].loaded, [['url', 'http://localhost:5173#x']]);
  // the dev server's own pages may load; anything else opens in the browser or nowhere
  const nav = (url: string) => {
    const e = { preventDefault: mock.fn() };
    w.webContents.emit('will-navigate', e, url);
    return e.preventDefault.mock.callCount();
  };
  assert.equal(nav('http://localhost:5173/#/chat'), 0);
  assert.equal(nav('http://localhost:9999/'), 1);
  assert.equal(nav('not a url'), 1);
  const view = calls(h.electron.Menu.setApplicationMenu)[0][0].template.find((m: any) => m.label === 'View');
  assert.ok(
    view.submenu.some((i: any) => i.role === 'toggleDevTools'),
    'development menu items',
  );
});

test('navigation guard: only the app page loads; web and mail links open in the browser', async () => {
  const h = await ready();
  const wc = h.windows[0].webContents;
  const opened = () => calls(h.electron.shell.openExternal).map((c: any) => c[0]);
  assert.deepEqual(wc.openHandler({ url: 'https://example.com' }), { action: 'deny' });
  assert.deepEqual(wc.openHandler({ url: 'file:///etc/passwd' }), { action: 'deny' });
  const nav = (url: string) => {
    const e = { preventDefault: mock.fn() };
    wc.emit('will-navigate', e, url);
    return e.preventDefault.mock.callCount();
  };
  assert.equal(nav(pathToFileURL(APP_PAGE).href + '#/settings'), 0);
  assert.equal(nav(pathToFileURL(APP_PAGE).href + '?x=1'), 0);
  assert.equal(nav('file:///tmp/evil.html'), 1);
  assert.equal(nav('mailto:a@b.c'), 1);
  assert.equal(nav('https://site.example/x'), 1);
  assert.equal(nav('file://remote-host/share/x.html'), 1, 'a file URL that is not a local path');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(opened(), ['https://example.com', 'mailto:a@b.c', 'https://site.example/x']);
  // a link that can't open (no browser, or a pinned run's scratch Chrome refused) opens nothing and is noted
  h.electron.shell.openExternal.mock.mockImplementationOnce(async () => {
    throw new Error('no browser');
  });
  assert.deepEqual(wc.openHandler({ url: 'https://refused.example' }), { action: 'deny' });
  await new Promise((r) => setImmediate(r));
  // tried, and its failure handled: no unhandled rejection fails this test
  assert.equal(opened().at(-1), 'https://refused.example');
  // Windows compares the page path without case
  const w = await ready({ platform: 'win32' });
  const e = { preventDefault: mock.fn() };
  w.windows[0].webContents.emit('will-navigate', e, pathToFileURL(APP_PAGE.toUpperCase()).href);
  assert.equal(e.preventDefault.mock.callCount(), 0);
});

test('Quick Chat: a floating window toggled by the shortcut, hidden on blur', async () => {
  const h = await loadMain();
  h.electron.screen.getDisplayNearestPoint = () => ({ workArea: { x: 10, y: 20, width: 500, height: 400 } });
  await h.ready();
  h.windows[0].close();
  await h.invoke('window:mini');
  // no main window: a hidden one is made first, so the chat has somewhere to run
  const [, main, mini] = h.windows;
  assert.deepEqual(main.log, []);
  assert.equal(mini.opts.alwaysOnTop, true);
  // one opaque frameless window, so the system draws the only frame; the first click on a button acts
  assert.equal(mini.opts.frame, false);
  assert.equal(mini.opts.transparent, undefined);
  assert.equal(mini.opts.backgroundColor, DEFAULT_PALETTE.light.bg);
  assert.equal(mini.opts.acceptFirstMouse, true);
  assert.deepEqual([mini.opts.width, mini.opts.height, mini.opts.x, mini.opts.y], [500, 400, 10, 20]);
  assert.deepEqual(mini.loaded, [['file', APP_PAGE, { hash: 'mini' }]]);
  mini.emit('ready-to-show');
  assert.deepEqual(mini.log, ['show', 'focus']);
  await h.invoke('window:mini');
  assert.deepEqual(mini.log.slice(2), ['hide'], 'visible and focused: hide');
  await h.invoke('window:mini');
  assert.deepEqual(mini.log.slice(3), ['show', 'focus']);
  assert.deepEqual(mini.webContents.on_('mini:shown'), [[]]);
  mini.focused = false;
  await h.invoke('window:mini');
  assert.deepEqual(mini.log.slice(5), ['show', 'focus'], 'visible but not focused: bring it up');
  mini.emit('blur');
  assert.equal(mini.visible, false);
  assert.equal(await h.invoke('mini:hide'), undefined);
  mini.close();
  mini.emit('blur');
  assert.equal(await h.invoke('mini:hide'), null);
  await h.invoke('window:mini');
  assert.equal(h.windows.length, 4, 'a new Quick Chat window');
});

test('Quick Chat loads the dev server in development and a large screen keeps its size', async () => {
  const h = await ready({ env: { VITE_DEV_SERVER_URL: 'http://localhost:1' } });
  h.electron.nativeTheme.shouldUseDarkColors = true;
  await h.invoke('window:mini');
  const mini = h.windows[1];
  assert.equal(mini.opts.backgroundColor, DEFAULT_PALETTE.dark.bg, 'a dark system opens on the dark surface');
  assert.deepEqual(mini.loaded, [['url', 'http://localhost:1#mini']]);
  assert.deepEqual([mini.opts.width, mini.opts.height, mini.opts.x, mini.opts.y], [640, 480, 400, 135]);
});

test('tray: macOS template icon, menu actions, and the controlling chat on top', async () => {
  const h = await ready();
  assert.equal(await h.invoke('app:setTray', true), undefined);
  const tray = h.trays[0];
  assert.match(tray.image.path, /trayTemplate\.png$/);
  assert.equal(tray.tooltip, 'MoPilot');
  assert.equal(tray.title, null);
  const menu = tray.menu.template;
  assert.deepEqual(
    menu.map((i: any) => i.label ?? i.type),
    ['Show MoPilot', 'New Chat', 'Open Quick Chat', 'separator', 'Quit MoPilot'],
  );
  const w = h.windows[0];
  h.emitIpc('window:ready', w.webContents);
  menu.find((item: any) => item.label === 'New Chat').click();
  await flush();
  assert.deepEqual(w.webContents.on_('app:command'), [['new-chat-default']]);
  assert.deepEqual(w.log.slice(-2), ['show', 'focus']);
  w.close();
  menu.find((item: any) => item.label === 'Show MoPilot').click();
  assert.equal(h.windows.length, 2, 'a window is opened to show');
  menu.find((item: any) => item.label === 'Open Quick Chat').click();
  assert.equal(h.windows.length, 3, 'Quick Chat');
  // an agent controlling the Mac puts "Stop" on top
  h.one('CodexAdapter').chatName = () => 'Fix';
  h.inst.computerUse[0].opts.onControlling('c1');
  assert.equal(tray.tooltip, 'Using (Fix)');
  tray.menu.template[0].click();
  assert.equal(h.inst.computerUse[0].cu.stop.mock.callCount(), 1);
  await h.invoke('app:setTray', false);
  assert.equal(tray.destroyed, false, 'still controlling');
  h.inst.computerUse[0].opts.onControlling(null);
  assert.equal(tray.destroyed, true);
});

test('tray: an empty icon gets the app name on macOS; Windows uses the .ico and a click shows the window', async () => {
  let h = await loadMain();
  h.electron.nativeImage.createFromPath.mock.mockImplementation(() => ({ isEmpty: () => true }));
  await h.ready();
  await h.invoke('app:setTray', true);
  assert.deepEqual(h.trays[0].image, { empty: true });
  assert.equal(h.trays[0].title, 'MoPilot');
  h = await loadMain({ platform: 'win32' });
  h.electron.nativeImage.createFromPath.mock.mockImplementation(() => ({ isEmpty: () => true }));
  await h.ready();
  await h.invoke('app:setTray', true);
  assert.equal(h.trays[0].title, null);
  h.trays[0].emit('click');
  assert.deepEqual(h.windows[0].log.slice(-2), ['show', 'focus']);
  h.windows[0].close();
  h.trays[0].emit('click');
  assert.equal(h.windows.length, 2);
  h = await ready({ platform: 'win32' });
  await h.invoke('app:setTray', true);
  assert.match(calls(h.electron.nativeImage.createFromPath)[0][0], /tray\.ico$/);
});

test('shortcuts: Quick Chat on ⌥Space and the voice hotkey', async () => {
  const h = await ready();
  const gs = h.electron.globalShortcut;
  assert.equal(await h.invoke('mini:shortcut', true), true);
  assert.equal(await h.invoke('mini:shortcut', true), true, 're-registered');
  h.shortcuts.get('Alt+Space')!();
  assert.equal(h.windows.length, 2, 'Quick Chat opened');
  assert.equal(await h.invoke('mini:shortcut', false), false);
  assert.equal(h.shortcuts.has('Alt+Space'), false);
  assert.equal(await h.invoke('mini:shortcut', true), true);
  gs.unregister.mock.mockImplementation(() => {
    throw new Error('x');
  });
  assert.equal(await h.invoke('mini:shortcut', true), false, 'unregister throws');
  gs.unregister.mock.mockImplementation((acc: string) => h.shortcuts.delete(acc));
  // voice
  assert.equal(await h.invoke('voice:hotkey', 'F6'), true);
  h.emitIpc('window:ready', h.windows[0].webContents);
  h.shortcuts.get('F6')!();
  await flush();
  assert.deepEqual(h.windows[0].webContents.on_('app:command').at(-1), ['start-voice']);
  for (const w of [...h.windows]) w.close();
  h.shortcuts.get('F6')!();
  assert.equal(h.windows.length, 3, 'a window opens for voice');
  // it starts voice once its page listens
  h.emitIpc('window:ready', h.windows[2].webContents);
  await flush();
  assert.deepEqual(h.windows[2].webContents.on_('app:command'), [['start-voice']]);
  assert.equal(await h.invoke('voice:hotkey', ''), true);
  assert.equal(h.shortcuts.has('F6'), false);
  gs.register.mock.mockImplementation(() => false);
  assert.equal(await h.invoke('voice:hotkey', 'F7'), false);
  assert.equal(await h.invoke('voice:hotkey', ''), true, 'nothing registered to remove');
  gs.register.mock.mockImplementation(() => {
    throw new Error('bad accelerator');
  });
  assert.equal(await h.invoke('voice:hotkey', '???'), false);
});

test('downloads go to the chosen folder without overwriting, or Electron asks', async () => {
  const h = await ready();
  const ses = h.partitions.get('persist:browser');
  const dir = path.join(h.tmp, 'dl');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'report.pdf'), '');
  await h.invoke('browser:setDownloads', dir, false);
  const item = (name: string) => Object.assign(new EventEmitter(), { getFilename: () => name, setSavePath: mock.fn() });
  const a = item('report.pdf');
  const b = item('report.pdf');
  ses.emit('will-download', {}, a);
  ses.emit('will-download', {}, b);
  assert.equal(calls(a.setSavePath)[0][0], path.join(dir, 'report (1).pdf'));
  assert.equal(calls(b.setSavePath)[0][0], path.join(dir, 'report (2).pdf'), 'one still downloading is not reused');
  a.emit('done');
  const c = item('report.pdf');
  ses.emit('will-download', {}, c);
  assert.equal(calls(c.setSavePath)[0][0], path.join(dir, 'report (1).pdf'));
  await h.invoke('browser:setDownloads', null, false);
  const d = item('x.zip');
  ses.emit('will-download', {}, d);
  assert.equal(calls(d.setSavePath)[0][0], path.join(h.app.getPath('downloads'), 'x.zip'));
  // Ask: Electron's save sheet, opened in the chosen folder on a free name (the Codex app's "report (2).csv")
  await h.invoke('browser:setDownloads', dir, true);
  const e = Object.assign(item('report.pdf'), { setSaveDialogOptions: mock.fn() });
  ses.emit('will-download', {}, e);
  assert.equal(e.setSavePath.mock.callCount(), 0);
  // report.pdf is on disk and (1) and (2) are still downloading
  assert.deepEqual(calls(e.setSaveDialogOptions)[0][0], { defaultPath: path.join(dir, 'report (3).pdf') });
  assert.equal(ses.listenerCount('will-download'), 1, 'hooked once');
});

test('download destination inspection failures cancel before setting a save path', async (t) => {
  const h = await ready();
  const ses = h.partitions.get('persist:browser');
  const denied = Object.assign(new Error('cannot inspect download folder'), { code: 'EACCES' });
  const stat = mock.method(fs, 'lstatSync', () => {
    throw denied;
  });
  t.after(() => stat.mock.restore());
  const item = Object.assign(new EventEmitter(), { getFilename: () => 'blocked.pdf', setSavePath: mock.fn(), cancel: mock.fn() });
  assert.doesNotThrow(() => ses.emit('will-download', {}, item));
  assert.equal(item.setSavePath.mock.callCount(), 0);
  assert.equal(item.cancel.mock.callCount(), 1);
  assert.equal(item.listenerCount('done'), 0);
});

test('the macOS menu sends each command to the focused window', async () => {
  const h = await ready({ state: { prefs: { keybindings: { 'new-chat': '' } } } });
  const template = calls(h.electron.Menu.setApplicationMenu)[0][0].template;
  assert.equal(template[0].label, 'MoPilot');
  const newChat = template[1].submenu.find((i: any) => i.label === 'New Chat');
  assert.equal(newChat.accelerator, undefined, 'a removed binding');
  const w = h.windows[0];
  await h.invoke('window:open');
  const other = h.windows[1];
  h.ui.focused = other;
  const before = h.windows.length;
  for (const i of items(template)) i.click();
  const sent = other.webContents.on_('app:command').map((c: any) => (c[0] === 'shortcut' ? c[1].id : c[0]));
  for (const cmd of [
    'about',
    'settings',
    'logout',
    'new-chat',
    'quick-chat',
    'new-standalone',
    'temporary-chat',
    'open-folder',
    'open-browser-tab',
    'copy-cwd',
    'toggle-sidebar',
    'toggle-bottom-panel',
    'open-terminal',
    'toggle-changes',
    'open-changes',
    'toggle-files',
    'toggle-summary',
    'command-menu',
    'search',
    'search-files',
    'toggle-activity',
    'next-attention',
    'clear-unreads',
    'prev-chat',
    'next-chat',
    'back',
    'forward',
    'shortcuts',
  ])
    assert.ok(sent.includes(cmd), cmd);
  assert.equal(w.webContents.on_('app:command').length, 0);
  assert.equal(h.windows.length, before + 1, 'New Window');
  assert.equal(h.one('Updater').check.mock.callCount(), 1);
  assert.deepEqual(calls(h.electron.shell.openExternal).flat(), [
    'https://developers.openai.com/codex',
    'https://code.claude.com/docs',
    'https://mopilot.ai/discord',
  ]);
  // no focused window: the first
  h.ui.focused = null;
  items(template)
    .find((i) => i.label === 'Command Menu…')
    .click();
  assert.deepEqual(w.webContents.on_('app:command'), [['shortcut', { id: 'command-menu' }]]);
  // no window at all: one opens for the command, and gets it once its page listens
  for (const x of [...h.windows]) x.close();
  const count = h.windows.length;
  items(template)
    .find((i) => i.label === 'Settings…')
    .click();
  assert.equal(h.windows.length, count + 1);
  const opened = h.windows.at(-1);
  h.emitIpc('window:ready', opened.webContents);
  await flush();
  assert.deepEqual(opened.webContents.on_('app:command'), [['shortcut', { id: 'settings' }]]);
});

test('saved keybindings rebuild the menu only when they change; notification prefs follow', async () => {
  const h = await ready({ state: { prefs: { notifyOnComplete: 'never', notifyKinds: { b: 1 } } } });
  const notify = calls(h.mod('platform/notify.cjs').registerNotify)[0][1];
  assert.equal(notify.getMode(), 'never');
  assert.deepEqual(notify.getKinds(), { b: 1 });
  const { onPrefs } = calls(h.mod('platform/chats.cjs').registerChats)[0][1];
  const scheduler = h.one('Scheduler');
  // on unless turned off (schedulerOff)
  onPrefs({});
  onPrefs({ schedulerOff: true });
  assert.deepEqual(
    calls(scheduler.settingsChanged)
      .slice(-2)
      .map((args: any[]) => args[0]),
    [true, false],
  );
  const menus = () => h.electron.Menu.setApplicationMenu.mock.callCount();
  const n = menus();
  onPrefs({});
  assert.equal(menus(), n);
  onPrefs({ keybindings: { search: '⌘J' } });
  assert.equal(menus(), n + 1);
  onPrefs({ keybindings: { search: '⌘J' }, notifyOnComplete: 'always', notifyKinds: { a: 1 } });
  assert.equal(menus(), n + 1);
  onPrefs(null);
  assert.equal(menus(), n + 2, 'back to the defaults');
  assert.equal(notify.getMode(), 'always');
  assert.deepEqual(notify.getKinds(), { a: 1 });
  // live Claude CLIs that fail to take a new permission don't fail the prefs change
  const adapter = h.one('ClaudeAdapter');
  adapter.permissionChanged = mock.fn(() => Promise.reject(new Error('gone')));
  onPrefs({ permission: 'plan' });
  await flush();
  assert.equal(adapter.permissionChanged.mock.callCount(), 1);
});

test('a Quick Chat handoff reports a main-window close before the readiness timeout', async () => {
  const h = await ready();
  await h.invoke('window:mini');
  const main = h.windows[0];
  const mini = h.windows.find((w: any) => w.opts.alwaysOnTop);
  let result: any;
  const waiting = h.invokeFrom(mini.webContents, 'quick-chat:settings', 'appearance').then((r: any) => {
    result = r;
  });
  main.close();
  await flush();
  try {
    assert.deepEqual(result, { ok: false, error: 'The app window was closed' });
    assert.deepEqual(main.webContents.on_('app:command'), []);
  } finally {
    mock.timers.tick(30_000);
    await waiting;
  }
});

registerMenuShortcutCases({ ready, calls });
