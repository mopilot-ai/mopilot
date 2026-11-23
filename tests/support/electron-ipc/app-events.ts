// Electron IPC app-events unit cases with the shared fake main harness.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { flush, calls, ready, isMainIpc } from './fixture';

export function registerAppEventsCases() {
  test('telemetry, updates, notices, app info and diagnostics', async () => {
    const h = await ready({ state: { prefs: { claudeBin: '/c' } } });
    for (const name of ['MoPilotAccount', 'Telemetry']) {
      const registered = calls(h.one(name).register);
      assert.equal(registered.length, 1);
      assert.ok(isMainIpc(h, registered[0][0]), name);
    }
    await h.invoke('telemetry:consent', false);
    assert.deepEqual(calls(h.one('Telemetry').setConsent), [[false]]);
    assert.deepEqual(calls(h.one('MoPilotAccount').setConsent).at(-1), [false]);
    const up = h.one('Updater');
    assert.deepEqual(await h.invoke('updates:state'), { s: 1 });
    await h.invoke('updates:check');
    await h.invoke('updates:install', { now: true });
    assert.deepEqual([calls(up.check), calls(up.install)], [[[{ manual: true }]], [[{ now: true }]]]);
    // the update channel: dogfood only for an internal account
    await h.invoke('updates:configure', { auto: false, channel: 'dogfood' });
    assert.deepEqual(calls(up.configure).at(-1), [{ auto: false, channel: 'beta' }]);
    h.one('MoPilotAccount').status = () => ({ user: { internal: true } });
    await h.invoke('updates:configure', null);
    assert.deepEqual(calls(up.configure).at(-1), [{ auto: false, channel: 'dogfood' }]);
    const notices = await h.invoke('app:openNotices');
    assert.equal(notices.notices.appPath, '/app');
    notices.notices.openPath('/n');
    assert.deepEqual(calls(h.electron.shell.openPath).at(-1), ['/n']);
    h.electron.nativeTheme.shouldUseDarkColors = true;
    assert.deepEqual(await h.invoke('app:info'), {
      username: os.userInfo().username.trim(),
      version: '1.2.3',
      platform: process.platform,
      home: h.home,
      codexHome: path.join(h.home, '.codex'),
      codexBin: 'codex',
      dark: true,
    });
    h.mod('platform/env.cjs').childEnv.mock.mockImplementation(() => ({ CODEX_HOME: '/ch' }));
    assert.equal((await h.invoke('app:info')).codexHome, '/ch');
    const diag = (await h.invoke('app:diagnostics')).diagnostics;
    assert.deepEqual(diag.harnesses, { Codex: 'codex', 'Claude Code': '/bin/claude' });
    assert.equal(diag.envStatus, 'env-ok');
    assert.deepEqual(calls(h.claude.turnApi.detect).at(-1), ['/c']);
    h.claude.turnApi.detect.mock.mockImplementation(async () => {
      throw new Error('x');
    });
    h.writeState({});
    const failed = (await h.invoke('app:diagnostics')).diagnostics;
    assert.deepEqual(failed.harnesses, { Codex: 'codex', 'Claude Code': null });
    // the lookup's error is not lost: it is listed with the ignored errors
    assert.deepEqual(
      failed.ignored.filter((e: any) => e.context === 'find Claude Code for the diagnostics').map((e: any) => e.message),
      ['x'],
    );
  });

  test('notifications open the chat; window chrome IPC; theme changes reach every window', async () => {
    const h = await ready();
    const o = calls(h.mod('platform/notify.cjs').registerNotify)[0][1];
    assert.equal(o.Notification, h.electron.Notification);
    assert.equal(o.isFocused(), false);
    const w = h.windows[0];
    h.ui.focused = w;
    assert.equal(o.isFocused(), true);
    h.emitIpc('window:ready', w.webContents);
    o.onClick('c1');
    await flush();
    assert.deepEqual(w.webContents.on_('app:command'), [['open-chat', 'c1']]);
    w.close();
    // no window open: one opens, and gets the chat once its page listens (a command sent before would be lost)
    o.onClick('c2');
    await flush();
    assert.deepEqual(h.windows[1].webContents.on_('app:command'), []);
    h.emitIpc('window:ready', h.windows[1].webContents);
    await flush();
    assert.deepEqual(h.windows[1].webContents.on_('app:command'), [['open-chat', 'c2']]);
    const w2 = h.windows[1];
    await h.invoke('app:setTheme', 'dark');
    assert.equal(h.electron.nativeTheme.themeSource, 'dark');
    assert.equal(await h.invokeFrom(w2.webContents, 'window:isFocused'), true, 'focused by the click');
    w2.focused = false;
    assert.equal(await h.invokeFrom(w2.webContents, 'window:isFocused'), false);
    assert.equal(await h.invokeFrom(h.wc(), 'window:isFocused'), true, 'no window');
    assert.equal(await h.invokeFrom(w2.webContents, 'window:titleBarOverlay', '#000', '#fff'), undefined);
    assert.equal(w2.overlay, null, 'macOS: nothing');
    await h.invokeFrom(w2.webContents, 'window:toggleMaximize');
    assert.equal(w2.maximized, true);
    await h.invokeFrom(w2.webContents, 'window:toggleMaximize');
    assert.equal(w2.maximized, false);
    assert.equal(await h.invokeFrom(h.wc(), 'window:toggleMaximize'), undefined);
    h.electron.nativeTheme.shouldUseDarkColors = false;
    h.electron.nativeTheme.emit('updated');
    assert.deepEqual(w2.webContents.on_('theme:changed'), [[false]]);
  });

  test('Windows: the caption buttons follow the theme the window sends', async () => {
    const h = await ready({ platform: 'win32' });
    const w = h.windows[0];
    await h.invokeFrom(w.webContents, 'window:titleBarOverlay', '#111', 2);
    assert.deepEqual(w.overlay, { color: '#111', symbolColor: '2', height: 44 });
    assert.equal(await h.invokeFrom(w.webContents, 'window:titleBarOverlay', 'throw', 'x'), undefined);
    assert.equal(await h.invokeFrom(h.wc(), 'window:titleBarOverlay', '#1', '#2'), undefined);
  });
}
