// Electron main native-capabilities wiring unit cases with the shared fake main harness.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadMain, flush, calls, peerMain } from './fixture';

export function registerNativeCapabilitiesCases() {
  test("tool visibility and native threads: who drives the user's Chrome, native Codex and Claude switches, visible tools", async () => {
    const h = await peerMain();
    await flush();
    const vis = h.one('ToolVisibility').opts;
    const control = h.one('BrowserControl');
    control.drivesUserChrome = () => 1;
    assert.equal(vis.drivesUserChrome(), true);
    control.drivesUserChrome = () => 0;
    assert.equal(vis.drivesUserChrome(), false);
    const cua = calls(h.mod('capabilities/contract/serverRequests.cjs').rejectNativeCuaElicitation)[0][0];
    const inj = h.one('CodexToolInjection');
    inj.isNativeThread = (id: string) => id === 'native';
    assert.equal(cua.isNativeThread('native'), true);
    assert.equal(cua.isNativeThread('managed'), false);
    // a thread's tool calls are charged to the chat its requests belong to: a sub-agent's parent chat (CM-R10)
    h.one('ChatController').requestChat = (id: string) => (id === 'sub' ? 'parent-chat' : id);
    assert.equal(inj.opts.chatOf('sub'), 'parent-chat');
    const isEnabled = h.mod('platform/flags.cjs').isEnabled;
    isEnabled.mock.mockImplementation((name: string) => name === 'native.claude.chrome');
    // Claude in Chrome only where the user chose it in Settings → Browser; MoPilot's extension otherwise
    assert.equal(calls(h.claude.setTools)[0][0].nativeChrome(), false);
    h.writeState({ prefs: { claudeInChrome: true } });
    assert.equal(calls(h.claude.setTools)[0][0].nativeChrome(), true);
    assert.equal(inj.opts.nativeEnabled(), false);
    isEnabled.mock.mockImplementation(() => true);
    assert.equal(inj.opts.nativeEnabled(), true);
    h.one('Registry').list = () => [{ name: 'browser_click' }, { name: 'desktop_type' }];
    assert.deepEqual(inj.opts.visibleTools(), ['browser_click', 'desktop_type']);
    // the note on what the tools reach (#1319 G3) reads the browser channel for managed threads and Claude sessions
    // the relay retires where MoPilot's extension serves Chrome: BrowserControl asks main's own rule
    assert.equal(typeof h.one('BrowserControl').opts.ownChrome(), 'boolean');
    control.userChrome = () => 'preferred';
    assert.equal(inj.opts.yourChrome(), 'preferred');
    assert.equal(calls(h.claude.setTools)[0][0].yourChrome(), 'preferred');
    // the plugin store's part of a chat thread's config: nothing while plugins.codex is on
    assert.deepEqual(inj.opts.pluginConfig(), {});
    // native Codex hides MoPilot's tools only for the surfaces its runtime has on this Mac
    assert.deepEqual(inj.opts.nativeHideFor({ chrome: true, computer: false }), { host: { nativeChrome: true, nativeComputer: false } });
  });

  test('a realtime voice request starts voice mode in main; an archived chat drops its desktop grants', async () => {
    const h = await peerMain();
    await flush();
    const r = await h.invoke('codex:request', 'thread/realtime/start', { threadId: 't' });
    assert.match(r.error.message, /speech capture owner/);
    const desktop = { forget: mock.fn(async () => {}) };
    const visibility = { forget: mock.fn() };
    h.inst.computerUse[0].desktop = desktop;
    h.inst.computerUse[0].visibility = visibility;
    const onChange = h.one('ChatsStore').args[1].onChange;
    onChange('a', { meta: { archived: 123 } });
    onChange('b', { meta: { archived: null } });
    onChange('c', { meta: null });
    onChange('d', undefined);
    assert.deepEqual(calls(desktop.forget), [['a']]);
    // archived or deleted: the phantom cursor's remembered positions go too
    assert.deepEqual(calls(visibility.forget), [['a'], ['d']]);
    // the tabs its agent left open close, and its sites' consents go: the chat is over
    assert.deepEqual(calls(h.one('BrowserTabs').forget), [['a']]);
    assert.deepEqual(calls(h.inst.OriginGrants[0].forget), [['a']]);
    // its basic-harness agent lets go of the chat's session
    assert.deepEqual(calls(h.one('AcpHost').retireChat), [['a']]);
  });

  test('archiving a chat tolerates its desktop grants and its own browser storage failing to clear', async () => {
    const h = await loadMain({
      before: (h) => {
        h.mods['electron/capabilities/browser/storage.cjs'] = {
          BrowserStorage: h.cls('BrowserStorage', () => ({
            endChat: mock.fn(async () => {
              throw new Error('partition busy');
            }),
          })),
        };
      },
    });
    await h.ready();
    await flush();
    // the built-in browser's storage opens with the first panel session asked for
    h.one('PanelBrowser').opts.panelSession();
    const desktop = { forget: mock.fn(async () => Promise.reject(new Error('helper gone'))) };
    h.inst.computerUse[0].desktop = desktop;
    h.inst.computerUse[0].visibility = { forget: mock.fn() };
    h.one('ChatsStore').args[1].onChange('c1', { meta: { archived: 1 } });
    await flush();
    assert.deepEqual(calls(desktop.forget), [['c1']]);
    assert.deepEqual(calls(h.one('BrowserStorage').endChat), [['c1']]);
  });
}

export function registerNativeAvailabilityCases() {
  test('native availability: the live facts it reads, a change tells every window, and the Codex stop hook', async () => {
    const h = await loadMain();
    await h.ready();
    const na = h.one('NativeAvailability');
    const flags = h.mod('platform/flags.cjs').isEnabled;
    flags.mock.mockImplementation((k: string) => k !== 'native.claude.chrome');
    h.claude.nativeChromeFor.mock.mockImplementation((a: any) => a === 'acct-1');
    h.claude.identity.accounts = () => ({ state: { active: 'acct-1' } });
    const facts = na.opts.live();
    assert.equal(facts.codexNative, true);
    // Codex Computer Use only when chosen in Settings → Computer use (#1381)
    assert.equal(facts.codexNativeComputer, false);
    assert.equal(facts.claudeFlag, false);
    assert.equal(facts.claudeEligible(), true);
    // MoPilot's own surfaces come from the capability health record: before computer use reports its
    // helper nothing is known (usable, unchecked); Your Chrome not chosen is off; the channels follow the switches
    assert.equal(facts.health.computer.state, 'unknown');
    assert.equal(facts.health.yourChrome.state, 'off');
    assert.deepEqual(Object.keys(facts.health.channels), ['claude', 'codex', 'acp']);
    // Your Chrome chosen with its tools loaded and the Playwright Extension installed is ready
    const control = h.one('BrowserControl');
    control.drivesUserChrome = () => true;
    control.active = 'chrome';
    assert.equal(na.opts.live().health.yourChrome.state, 'ready');
    // computer use's helper as it reports it: a missing helper hides desktop_* from every session
    const cu = h.inst.computerUse[0];
    const hides = calls(h.one('Registry').setHidden)[0][0];
    assert.equal(hides('desktop_click'), false);
    cu.helperFacts = () => ({
      path: '/h.app',
      installed: false,
      packaged: true,
      platform: 'darwin',
      running: false,
      version: null,
      error: null,
    });
    assert.equal(hides('desktop_click'), true);
    assert.match(
      calls(h.one('Registry').setHidden)[0][1]('desktop_click'),
      /missing from this installation \(\/h\.app\); update or reinstall MoPilot/,
    );
    // its changes tell every window; Settings opens a permission pane through the shell
    const before = h.windows[0].webContents.on_('availability:changed').length;
    cu.opts.onHealth();
    assert.equal(h.windows[0].webContents.on_('availability:changed').length, before + 1);
    cu.opts.openExternal('x-apple.systempreferences:pane');
    assert.deepEqual(calls(h.electron.shell.openExternal).at(-1), ['x-apple.systempreferences:pane']);
    // an update of Codex Computer Use waits while a native thread runs it
    const inj = h.one('CodexToolInjection');
    inj.nativeComputerLoaded = () => true;
    assert.equal(na.opts.skyInUse(), true);
    inj.nativeComputerLoaded = () => undefined;
    assert.equal(na.opts.skyInUse(), false);
    h.claude.identity.accounts = () => null;
    assert.equal(na.opts.live().claudeEligible(), false);
    na.opts.onChange();
    assert.equal(h.windows[0].webContents.on_('availability:changed').length, before + 2);
    // probed again when a window is focused, and forced when a settings page asks
    na.status = mock.fn(() => 'status');
    // and a basic harness that reads signed out is checked again (signed in from the user's own terminal)
    const admission = h.one('Admission');
    admission.recheckSignedOut = mock.fn(async () => Promise.reject(new Error('probe failed')));
    h.app.emit('browser-window-focus');
    assert.equal(admission.recheckSignedOut.mock.callCount(), 1);
    assert.equal(await h.invoke('availability:status', true), 'status');
    assert.equal(await h.invoke('availability:status', 'yes'), 'status');
    assert.deepEqual(calls(na.refresh), [[], [{ force: true }]]);
    // Try again / Check again
    na.retry = mock.fn(() => 'retried');
    assert.equal(await h.invoke('availability:retry'), 'retried');
    // Settings → Computer use's Codex Computer Use switch: saved, the probe runs again (installing it when due) and
    // every window hears of it; only a true turns it on
    const grants = h.inst.computerUse[0].grants;
    na.refresh = mock.fn();
    na.onChange = mock.fn();
    assert.equal(await h.invoke('computer:setCodexNativeComputer', true), true);
    assert.equal(await h.invoke('computer:setCodexNativeComputer', 'yes'), false);
    assert.deepEqual(calls(grants.setCodexNativeComputer), [[true], [false]]);
    assert.deepEqual(calls(na.refresh), [[{ force: true }], [{ force: true }]]);
    assert.equal(na.onChange.mock.callCount(), 2);
    grants.codexNativeComputer.mock.mockImplementation(() => true);
    assert.equal(na.opts.live().codexNativeComputer, true);
    // the probe reads the Codex home the app-server runs with: CODEX_HOME, else ~/.codex
    const env = h.mod('platform/env.cjs').childEnv;
    env.mock.mockImplementation(() => ({ CODEX_HOME: '/codex-home' }));
    assert.deepEqual(na.opts.probe(), { probed: { codexHome: '/codex-home' } });
    // a Chrome-only native thread's cua_repl comes from the plugin's own definition in that home: none there, nothing narrowed
    assert.equal(h.one('CodexToolInjection').opts.computerOff(), null);
    env.mock.mockImplementation(() => ({}));
    assert.match(na.opts.probe().probed.codexHome, /\/\.codex$/);

    const codex = h.one('CodexAdapter');
    const ctl = h.one('ChatController');
    codex.opts.onStopped('c1', 't1');
    assert.deepEqual(calls(ctl.codexStopped), [['c1', 't1']]);
    const tools = h.one('CodexToolInjection').opts;
    na.codexSurfaces = mock.fn(() => ['chrome']);
    na.degradedNote = mock.fn((s: any, name: string) => `note ${s} ${name}`);
    assert.deepEqual(tools.nativeSurfaces(), ['chrome']);
    assert.equal(tools.degradedNote(['chrome'], 'sage'), 'note chrome sage');
  });
}
