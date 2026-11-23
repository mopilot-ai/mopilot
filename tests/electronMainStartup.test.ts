// electron/main.cjs: what happens on load and at app 'ready', and the app's lifecycle events,
// over a fake Electron and fake collaborators (tests/support/electron-main-harness.ts).
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { loadMain, unloadMain, flush, withPlatform } from './support/electron-main-harness.ts';
import { waitFor } from './support/waitFor.ts';
import edition from '../shared/edition.json' with { type: 'json' };

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());
const calls = (f: any) => f.mock.calls.map((c: any) => c.arguments);

test('on load: env scrubbed, scheme registered, the app named and its user data moved', async () => {
  const h = await loadMain();
  assert.equal(h.claude.scrubProcessEnv.mock.callCount(), 1);
  assert.equal(h.mod('platform/env.cjs').init.mock.callCount(), 1);
  assert.equal(calls(h.electron.protocol.registerSchemesAsPrivileged)[0][0][0].scheme, 'codex-asset');
  assert.deepEqual(calls(h.app.setName), [[edition.desktop.profile]]);
  assert.equal(h.app.setAppUserModelId.mock.callCount(), 0);
  assert.deepEqual(calls(h.mod('migrations/migrate.cjs').migrateUserData), [[h.appData, h.userData]]);
  assert.equal(h.app.getPath('userData'), h.userData);
  assert.equal(h.app.exit.mock.callCount(), 0);
  // the launcher for agents is configured with a bin folder under userData
  const disclaim = calls(h.mod('platform/disclaim.cjs').configure)[0][0];
  assert.equal(disclaim.launcher, '/disclaim');
  assert.equal(disclaim.dir(), path.join(h.userData, 'bin'));
});

test('a user data override skips the move; a second instance exits; Windows sets its app id', async () => {
  let h = await loadMain({ env: { MOPILOT_USER_DATA: '/x' }, singleLock: false });
  assert.equal(h.mod('migrations/migrate.cjs').migrateUserData.mock.callCount(), 0);
  assert.deepEqual(calls(h.app.exit), [[0]]);
  h = await loadMain({ env: { SAGE_USER_DATA: '/x' }, platform: 'win32' });
  assert.equal(h.mod('migrations/migrate.cjs').migrateUserData.mock.callCount(), 0);
  assert.deepEqual(calls(h.app.setAppUserModelId), [[edition.desktop.appId]]);
});

test('telemetry starts before ready with the saved consent and reports crashes', async () => {
  const h = await loadMain({ state: { prefs: { shareUsageData: true, updateChannel: 'beta' } } });
  const t = h.one('Telemetry');
  assert.equal(t.opts.userData, h.userData);
  assert.equal(t.opts.installId, 'install-1');
  assert.deepEqual(calls(t.startCrashReporter), [[true]]);
  assert.equal(t.opts.channel(), 'beta');
  assert.equal(await t.opts.accessToken(), null, 'no account yet');
  assert.deepEqual(await t.opts.versions(), { codexUserAgent: null, claude: undefined, admission: [] });
  const err = mock.method(console, 'error', () => {});
  h.processHandlers.uncaughtException(new Error('boom'));
  err.mock.restore();
  h.processHandlers.unhandledRejection(new Error('nope'));
  h.processHandlers.unhandledRejection('just text');
  h.processHandlers.uncaughtException(null);
  const errors = calls(t.error).map((c: any) => [c[0].message, c[0].kind]);
  assert.deepEqual(errors, [
    ['boom', 'uncaught'],
    ['nope', 'unhandledrejection'],
    ['just text', 'unhandledrejection'],
    [undefined, 'uncaught'],
  ]);
  h.app.emit('render-process-gone', {}, {}, { reason: 'clean-exit' });
  h.app.emit('render-process-gone', {}, {}, { reason: 'crashed', exitCode: 3 });
  h.app.emit('child-process-gone', {}, { reason: 'clean-exit', type: 'GPU' });
  h.app.emit('child-process-gone', {}, { reason: 'oom', type: 'GPU', exitCode: 9 });
  assert.deepEqual(
    calls(t.error)
      .slice(4)
      .map((c: any) => c[0].message),
    ['renderer gone: crashed (3)', 'GPU gone: oom (9)'],
  );

  // after ready: the account's token, the Codex user agent, Claude's version and the basic harnesses
  h.claude.version.mock.mockImplementation(() => '2.0');
  await h.ready();
  assert.equal(await t.opts.accessToken(), 'tok');
  h.one('CodexAdapter').init = Promise.resolve({ userAgent: 'codex/1' });
  h.one('Admission').list = () => ['adm'];
  assert.deepEqual(await t.opts.versions(), { codexUserAgent: 'codex/1', claude: '2.0', admission: ['adm'] });
  h.one('CodexAdapter').init = Promise.reject(new Error('no init'));
  assert.equal((await t.opts.versions()).codexUserAgent, undefined);
  h.one('MoPilotAccount').status = () => ({ user: { internal: true } });
  h.writeState({ prefs: { updateChannel: 'dogfood' } });
  assert.equal(t.opts.channel(), 'dogfood');
  h.writeState({});
  assert.equal(t.opts.channel(), 'stable');
});

test('a second launch focuses the window, or opens one once the app is ready', async () => {
  const h = await loadMain();
  h.app.emit('second-instance');
  assert.equal(h.windows.length, 0, 'not ready: nothing to open');
  h.ui.isReady = true;
  h.app.emit('second-instance');
  assert.equal(h.windows.length, 1);
  const w = h.windows[0];
  w.minimized = true;
  h.app.emit('second-instance');
  assert.deepEqual(w.log.slice(-3), ['restore', 'show', 'focus']);
  h.app.emit('second-instance');
  assert.deepEqual(w.log.slice(-2), ['show', 'focus']);
});

test('a second launch with only Quick Chat left opens an app window instead of showing Quick Chat', async () => {
  const h = await loadMain();
  await h.ready();
  h.app.emit('activate');
  const main = h.windows[0];
  // Quick Chat opens beside the app window, then the app window is closed (macOS keeps the app running)
  await h.invoke('window:mini');
  const mini = h.windows[1];
  assert.equal(mini.opts.frame, false);
  main.close();
  const shown = mini.log.length;
  h.app.emit('second-instance');
  assert.equal(h.windows.length, 3, 'a new app window');
  assert.notEqual(h.windows[2].opts.frame, false);
  assert.equal(mini.log.length, shown, 'Quick Chat is left as it was');
  // the Dock icon the same way: with only Quick Chat left, it brings an app window back, not nothing
  h.windows[2].close();
  h.app.emit('activate');
  assert.equal(h.windows.length, 4, 'Quick Chat alone does not count as the app being open');
  // a hidden app window (one Quick Chat opened for its chats) is shown, not left hidden
  const hidden = h.windows[3];
  hidden.log.length = 0;
  h.app.emit('activate');
  assert.equal(h.windows.length, 4);
  assert.deepEqual(hidden.log.slice(-2), ['show', 'focus']);
});

test('ready: the renderer may use the microphone, clipboard, notifications and fonts only', async () => {
  const h = await loadMain();
  await h.ready();
  const check = calls(h.electron.session.defaultSession.setPermissionCheckHandler)[0][0];
  assert.equal(check(null, 'media'), true);
  assert.equal(check(null, 'geolocation'), false);
  const request = calls(h.electron.session.defaultSession.setPermissionRequestHandler)[0][0];
  const ask = (perm: string, details: any = {}) => {
    let got: any;
    request(null, perm, (v: boolean) => (got = v), details);
    return got;
  };
  assert.equal(ask('media', { mediaTypes: ['audio'] }), true);
  assert.equal(ask('media', { mediaTypes: ['audio', 'video'] }), false);
  assert.equal(ask('media'), true);
  assert.equal(ask('clipboard-read'), true);
  assert.equal(ask('openExternal'), false);
});

test('ready: browser tabs are sandboxed guests whose popups stay closed until the browser registers them', async () => {
  const h = await loadMain();
  await h.ready();
  const guest = h.wc({ type: 'webview' });
  const host = h.wc();
  h.app.emit('web-contents-created', {}, guest);
  const prefs: any = { preload: '/p.js', nodeIntegration: true };
  const params: any = {};
  guest.emit('will-attach-webview', {}, prefs, params);
  assert.deepEqual(prefs, {
    nodeIntegration: false,
    nodeIntegrationInSubFrames: true,
    contextIsolation: true,
    sandbox: true,
    webSecurity: true,
    webviewTag: false,
    enableBlinkFeatures: 'WebMCP', // a page's own tools (WebMCP): this harness turns every switch on
    partition: 'persist:browser',
  });
  assert.equal(params.partition, 'persist:browser');
  assert.deepEqual(guest.openHandler({ url: 'https://x.example' }), { action: 'deny' }, 'no host yet');
  guest.hostWebContents = host;
  assert.deepEqual(
    guest.openHandler({ url: 'https://x.example' }),
    { action: 'deny' },
    'the browser window policy is installed on registration',
  );
  assert.deepEqual(host.on_('app:command'), []);
  const plain = h.wc();
  h.app.emit('web-contents-created', {}, plain);
  assert.equal(plain.openHandler, null);
});

test('ready: a provider sync that fails at startup still starts the relay', async () => {
  const h = await loadMain({
    before: (h) => {
      h.mods['electron/identity/contract/codexProvider.cjs'].CodexProviders = h.cls('CodexProviders', () => ({
        sync: mock.fn(async () => {
          throw new Error('keychain locked');
        }),
      }));
    },
  });
  await h.ready();
  await flush();
  assert.deepEqual(calls(h.one('CodexProviders').sync), [['provider-input', []]]);
  assert.deepEqual(h.one('AppServer').threadConfig, { openai_base_url: 'http://relay' });
});

test('ready: the server-request owner is the thread itself before the controller exists', async () => {
  let release: any;
  const listen = new Promise<string>((r) => (release = r));
  const h = await loadMain({
    before: (h) => {
      fs.writeFileSync(path.join(h.tmp, 'sage-mcp'), '');
      h.mods['electron/capabilities/mcp/socket.cjs'].ToolSocket = h.cls('ToolSocket', () => ({ listen: mock.fn(() => listen) }));
    },
  });
  const ready = h.ready();
  await flush();
  const requests = calls(h.mod('capabilities/contract/serverRequests.cjs').codexServerRequests)[0][0];
  assert.equal(h.inst.ChatController, undefined);
  assert.deepEqual(requests.owner('th'), { chatId: 'th', segmentId: 'th' });
  release('/tmp/s.sock');
  await ready;
  assert.equal(h.one('CodexToolInjection').opts.socketPath, '/tmp/s.sock');
});

test('ready: MoPilot account consent and sign-in changes', async () => {
  const h = await loadMain({ state: { prefs: { shareUsageData: false } } });
  await h.ready();
  const mo = h.one('MoPilotAccount');
  const merge = h.mod('support/telemetry.cjs').mergeConsent;
  const t = h.one('Telemetry');
  const w = h.windows[0];
  // the stricter choice is written locally and to the account
  merge.mock.mockImplementation(() => ({ write: true, put: true, value: false }));
  t.reportMigration = () => true;
  mo.opts.onConsent(true);
  assert.deepEqual(calls(merge).at(-1), [false, true]);
  assert.deepEqual(calls(h.mod('platform/chats.cjs').patchPrefs).at(-1), [
    path.join(h.userData, 'ui-state.json'),
    { shareUsageData: false },
    [],
  ]);
  assert.deepEqual(calls(t.setConsent).at(-1), [false]);
  assert.deepEqual(w.webContents.on_('prefs:changed').at(-1), [{ set: { shareUsageData: false }, unset: [] }]);
  assert.deepEqual(calls(mo.setConsent).at(-1), [false]);
  assert.equal(calls(h.mod('migrations/migrate.cjs').record).at(-1)[1].id, 'report-marker');
  merge.mock.mockImplementation(() => ({ write: false, put: false }));
  const n = mo.setConsent.mock.callCount();
  h.writeState({});
  mo.opts.onConsent(null);
  assert.deepEqual(calls(merge).at(-1), [null, null]);
  assert.equal(mo.setConsent.mock.callCount(), n);
  // signing in or out tells Claude and the accounts the gateway key
  const accounts = h.one('Accounts');
  const keys = () => accounts.setMoPilotKey.mock.callCount();
  const k0 = keys();
  mo.opts.broadcast({ signedIn: false });
  assert.equal(keys(), k0 + 1, 'first status');
  assert.equal(h.claude.mopilotChanged.mock.callCount(), 0);
  mo.opts.broadcast({ signedIn: false });
  assert.equal(keys(), k0 + 1, 'unchanged');
  accounts.setMoPilotKey.mock.mockImplementation(async () => {
    throw new Error('x');
  });
  mo.opts.broadcast({ signedIn: true, user: { internal: false } });
  await flush();
  assert.deepEqual(calls(accounts.setMoPilotKey).at(-1), ['gw-key', 'https://api.example/v1']);
  assert.equal(h.claude.mopilotChanged.mock.callCount(), 1);
  assert.deepEqual(w.webContents.on_('mopilot:event').at(-1), [{ signedIn: true, user: { internal: false } }]);
  // an internal account moves a dogfood pick onto dogfood
  const up = h.one('Updater');
  const conf = up.configure.mock.callCount();
  mo.opts.broadcast({ signedIn: true, user: { internal: false } });
  assert.equal(up.configure.mock.callCount(), conf, 'channel unchanged');
  up.channel = 'dogfood';
  mo.opts.broadcast({ signedIn: true });
  assert.equal(up.configure.mock.callCount(), conf + 1);
  // providers for Claude
  assert.equal(calls(h.claude.setGatewayKeyProvider)[0][0](), 'gw-key');
  assert.deepEqual(await calls(h.claude.setGatewayCapsProvider)[0][0](), { m: 1 });
});

test('replacing a signed-in MoPilot account updates both harnesses even while signedIn stays true', async () => {
  const h = await loadMain();
  await h.ready();
  const mopilot = h.one('MoPilotAccount');
  const accounts = h.one('Accounts');
  mopilot.gatewayKey.mock.mockImplementation(() => 'first');
  mopilot.opts.broadcast({ signedIn: true, user: null });
  const before = h.claude.mopilotChanged.mock.callCount();
  mopilot.gatewayKey.mock.mockImplementation(() => 'second');
  mopilot.opts.broadcast({ signedIn: true, user: null });
  assert.equal(h.claude.mopilotChanged.mock.callCount(), before + 1);
  assert.equal(calls(accounts.setMoPilotKey).at(-1)[0], 'second');
  const count = accounts.setMoPilotKey.mock.callCount();
  mopilot.opts.broadcast({ signedIn: true, user: null });
  assert.equal(accounts.setMoPilotKey.mock.callCount(), count, 'unchanged account does not restart harnesses');
});

test('ready: identity, exit gate, updater and flags are wired to the live objects', async () => {
  const h = await loadMain({ packaged: true, state: { prefs: { autoUpdate: false, updateChannel: 'beta' } } });
  await h.ready();
  const id = h.one('IdentityRegistry');
  assert.deepEqual(
    calls(id.register).map((c: any) => c[0]),
    [h.one('CodexDriver'), h.one('ClaudeDriver'), h.one('AcpDriver')],
  );
  assert.equal(h.one('CodexDriver').opts, h.one('Accounts'));
  assert.deepEqual([h.one('ClaudeDriver').opts.claude, h.one('ClaudeDriver').opts.marks()], [true, h.one('ClaudeAdapter').marks]);
  assert.deepEqual(h.one('AcpDriver').opts.list(), []);
  const gate = h.inst.exitGate[0];
  assert.equal(gate.opts.window(), null, 'the full renderer has not signaled readiness yet');
  assert.equal(gate.opts.sessions(), h.one('SessionStore'));
  assert.equal(gate.opts.controller(), h.one('ChatController'));
  assert.equal(gate.opts.codex(), h.one('CodexAdapter'));
  assert.equal(gate.opts.claude().register, h.claude.register);
  assert.equal(gate.opts.claudeTurns(), h.one('ClaudeAdapter'));
  assert.deepEqual(gate.opts.prefs(), { autoUpdate: false, updateChannel: 'beta' });
  const up = h.one('Updater');
  assert.deepEqual(calls(up.configure)[0], [{ auto: false, channel: 'beta' }]);
  up.opts.broadcast({ v: 2 });
  assert.deepEqual(h.windows[0].webContents.on_('updates:state'), [[{ v: 2 }]]);
  up.opts.gate('restart');
  assert.deepEqual(calls(gate.request), [['restart', { quiet: false }]]);
  assert.equal(await up.opts.idle(), true);
  assert.equal(await up.opts.token(), 'tok');
  // flags
  const fo = calls(h.mod('platform/flags.cjs').initFlags)[0][0];
  assert.deepEqual(fo.override, {}, 'packaged: no override');
  assert.equal(fo.url, createRequire(import.meta.url)('../electron/platform/mopilotEndpoints.cjs').endpoints?.FLAGS_URL ?? null);
  assert.equal(fo.channel(), 'stable');
  fo.onKill('codex');
  assert.deepEqual(calls(h.one('Telemetry').track).at(-1), ['kill_switch_applied', { key: 'codex', channel: 'stable', version: '1.2.3' }]);
  fo.onChange({ k: true });
  assert.equal(h.inst.computerUse[0].sync.mock.callCount(), 1);
  assert.deepEqual(h.windows[0].webContents.on_('flags:changed'), [[{ k: true }]]);
  // a switch can change what a surface can do: open settings read the capability status again
  const availability = h.windows[0].webContents.on_('availability:changed').length;
  assert.ok(availability >= 1);
  assert.equal(h.one('Admission').emit.mock.callCount(), 1);
  assert.deepEqual(calls(h.one('BrowserControl').configure).at(-1), ['builtin']);
  // a browser channel that fails to load after a switch changes is left to configure() itself
  await flush();
  const switched = h.windows[0].webContents.on_('browser:channelChanged').length;
  h.one('BrowserControl').configure.mock.mockImplementation(async () => {
    throw new Error('channel failed');
  });
  fo.onChange({ k: false });
  await flush();
  assert.equal(h.windows[0].webContents.on_('browser:channelChanged').length, switched);
  assert.equal(h.windows[0].webContents.on_('availability:changed').length, availability + 1);
  assert.deepEqual(calls(h.mod('platform/flags.cjs').registerFlags)[0][1], { flags: fo });
  // the rest of startup
  assert.equal(h.one('Scheduler').start.mock.callCount(), 1);
  assert.deepEqual(calls(h.one('Admission').refresh)[0], []);
  assert.equal(h.one('MoPilotAccount').refreshStatus.mock.callCount(), 1);
  assert.deepEqual(calls(h.one('Telemetry').track)[0], ['app_open', { version: '1.2.3' }]);
});

test('ready without packaging: MOPILOT_FLAGS overrides; a failed admission probe is ignored', async () => {
  const h = await loadMain({
    env: { MOPILOT_FLAGS: 'a=1' },
    before: (h) =>
      (h.mods['electron/harness/admission.cjs'].Admission = h.cls('Admission', () => ({
        list: () => [],
        refresh: mock.fn(async () => Promise.reject(new Error('probe failed'))),
      }))),
  });
  await h.ready();
  await flush();
  assert.deepEqual(calls(h.mod('platform/flags.cjs').initFlags)[0][0].override, { parsed: 'a=1' });
  // reportMigrationOnce: nothing to report, then telemetry throws
  assert.equal(calls(h.mod('migrations/migrate.cjs').record).length, 0);
  h.one('Telemetry').reportMigration = () => {
    throw new Error('x');
  };
  await h.invoke('telemetry:consent', true);
  assert.deepEqual(calls(h.one('MoPilotAccount').setConsent).at(-1), [true]);
});

test('ready: computer use, its vision fallback, and who controls the Mac', async () => {
  const h = await loadMain();
  await h.ready();
  const cu = h.inst.computerUse[0];
  // through action memory's recorder (app/routines.cjs, G4), which passes main's Registry through
  h.one('Registry').probe = 'main-registry';
  assert.equal(cu.opts.registry.probe, 'main-registry');
  assert.equal(cu.opts.userData, h.userData);
  const { on, pick } = cu.opts.vision.backendFor;
  assert.equal(on(), true);
  const caps = h.one('CapsService');
  const pickBackend = h.mod('capabilities/vision/decide.cjs').pickBackend;
  caps.get = async () => ({ provider: { id: 'anthropic', label: 'Anthropic' } });
  h.claude.visionAuth.mock.mockImplementation(() => ({ baseUrl: 'https://anth', headers: { k: 1 } }));
  await pick('c1');
  assert.deepEqual(calls(pickBackend).at(-1)[0], {
    provider: { provider: { id: 'anthropic', label: 'Anthropic' }, auth: { baseUrl: 'https://anth', headers: { k: 1 } } },
    mopilot: { signedIn: true, model: 'vision-model' },
    chatVendor: 'Anthropic',
  });
  caps.get = async () => ({ provider: { id: 'mopilot' } });
  h.one('MoPilotAccount').gatewayKey = () => null;
  await pick('c1');
  assert.deepEqual(calls(pickBackend).at(-1)[0], {
    provider: null,
    mopilot: { signedIn: false, model: 'vision-model' },
    chatVendor: 'MoPilot',
  });
  caps.get = async () => ({ provider: { id: 'openai' } });
  await pick('c1');
  assert.equal(calls(pickBackend).at(-1)[0].chatVendor, 'openai');
  caps.get = async () => {
    throw new Error('x');
  };
  await pick('c1');
  assert.equal(calls(pickBackend).at(-1)[0].chatVendor, null);
  // reading the screen: MoPilot credits, or the provider's own model on its own credentials
  const vision = h.mod('capabilities/vision/backend.cjs').anthropicVision;
  h.one('MoPilotAccount').gatewayKey = () => 'gw';
  const r: any = await cu.opts.vision.read({ source: 'mopilot', model: 'm' }, { prompt: 'p' });
  assert.equal(r.o.baseUrl, 'https://api.example');
  assert.deepEqual(r.o.headers(), { authorization: 'Bearer gw' });
  const pr: any = await cu.opts.vision.read({ source: 'provider', model: 'pm' }, { prompt: 'p' });
  assert.equal(pr.o.baseUrl, 'https://anth');
  assert.deepEqual(pr.o.headers(), { k: 1 });
  assert.equal(vision.mock.callCount(), 2);
  h.claude.visionAuth.mock.mockImplementation(() => null);
  await assert.rejects(cu.opts.vision.read({ source: 'provider' }, { prompt: 'p' }), /no credentials/);
  // e2e's fake backend
  process.env.SAGE_VISION_FAKE = '{"source":"fake"}';
  try {
    assert.deepEqual(await pick('c1'), { source: 'fake' });
    assert.equal(await cu.opts.vision.read({}, { prompt: 'Where is the button?' }), '{"x": 0, "y": 0}');
    assert.equal(await cu.opts.vision.read({}, { prompt: 'Describe' }), 'A fake screen');
  } finally {
    delete process.env.SAGE_VISION_FAKE;
  }
  // stop, the paused-goal notification, and the tray while an agent controls the Mac
  cu.opts.stop('c9');
  assert.deepEqual(calls(h.one('ChatController').stopChat), [['c9']]);
  const notifier = h.mod('platform/notify.cjs').registerNotify.mock.calls[0].result;
  const codex = h.one('CodexAdapter');
  codex.chatName = () => 'Fix bug';
  cu.opts.notify('c9', 'Safari');
  codex.chatName = () => '';
  cu.opts.notify('c9', 'Safari');
  assert.deepEqual(calls(notifier.notify), [
    ['auth', 'c9', { title: '"Fix bug" needs your OK to control Safari. Goal paused.', body: '', chatTitle: 'Fix bug' }],
    ['auth', 'c9', { title: '"This chat" needs your OK to control Safari. Goal paused.', body: '', chatTitle: 'This chat' }],
  ]);
  // "<Agent> is using <App>": the Computer use notification kind, the agent's name and the chat's; after Esc, the chat in front
  cu.opts.notifyKind('computer', 'c9', { title: 'Codex is using Safari' });
  void cu.opts.showChat('c9');
  assert.deepEqual(calls(notifier.notify).at(-1), ['computer', 'c9', { title: 'Codex is using Safari' }]);
  const ctl = h.one('ChatController');
  ctl.ref = (id: string) => ({ kind: id === 'c9' ? 'acp:gemini' : 'acp:other' });
  assert.equal(cu.opts.agentName('c9'), 'Gemini');
  assert.equal(cu.opts.agentName('c8'), null);
  assert.deepEqual(
    calls(h.mod('capabilities/computerUse.cjs').agentLabel).map((c: any[]) => c[0]),
    ['acp:gemini', 'acp:other'],
  );
  assert.equal(cu.opts.chatName('c9'), null);
  codex.chatName = () => 'Fix bug';
  assert.equal(cu.opts.chatName('c9'), 'Fix bug');
  codex.chatName = () => '';
  assert.equal(h.trays.length, 0);
  cu.opts.onControlling('c9');
  assert.equal(h.trays.length, 1);
  codex.chatName = () => 'Fix bug';
  cu.opts.onControlling('c9');
  assert.deepEqual([h.trays[0].tooltip, h.trays[0].menu.template[0].label], ['Using ()', 'Stop computer use'], 'unchanged: not rebuilt');
  cu.opts.onControlling(null);
  assert.deepEqual([h.trays[0].destroyed, calls(notifier.hold)], [true, [[true], [true], [false]]]);
});

test('ready: startup prefs turn on the shortcuts, the tray and downloads', async () => {
  const h = await loadMain({
    state: {
      prefs: {
        miniShortcut: true,
        voiceHotkey: 'F5',
        showInMenuBar: true,
        downloadsDir: '/dl',
        askWhereToSave: true,
        keybindings: { settings: '⌘;' },
      },
    },
  });
  await h.ready();
  assert.ok(h.shortcuts.has('Alt+Space'));
  assert.ok(h.shortcuts.has('F5'));
  assert.equal(h.trays.length, 1);
  const file = h.electron.Menu.setApplicationMenu.mock.calls[0].arguments[0].template[0].submenu.find((i: any) => i.label === 'Settings…');
  assert.equal(file.accelerator, 'CmdOrCtrl+;');
  // activate opens a window only when there is none, and otherwise brings the one there is forward
  h.app.emit('activate');
  assert.equal(h.windows.length, 1);
  assert.deepEqual(h.windows[0].log.slice(-2), ['show', 'focus']);
  h.windows[0].close();
  h.app.emit('activate');
  assert.equal(h.windows.length, 2);
});

test('closing every window quits except on macOS or with a tray icon', async () => {
  const h = await loadMain();
  await h.ready();
  await withPlatform('darwin', () => h.app.emit('window-all-closed'));
  assert.equal(h.app.quit.mock.callCount(), 0);
  await withPlatform('linux', () => h.app.emit('window-all-closed'));
  assert.equal(h.app.quit.mock.callCount(), 1);
  await h.invoke('app:setTray', true);
  await withPlatform('win32', () => h.app.emit('window-all-closed'));
  assert.equal(h.app.quit.mock.callCount(), 1);
  h.app.emit('will-quit');
  assert.equal(h.electron.globalShortcut.unregisterAll.mock.callCount(), 1);
});

test('Your Chrome that fails to set up still reports its state, with no chat waiting for it', async () => {
  const h = await loadMain({
    before: (hh) => {
      hh.mod('capabilities/browser/chromeToken.cjs').ChromeTokens = function () {
        throw new Error('no keychain');
      };
    },
  });
  await h.ready();
  await flush();
  assert.deepEqual(await h.invoke('browser:chromeState'), {
    active: null,
    hasToken: false,
    extensionUrl: h.mod('capabilities/browser/extension.cjs').EXTENSION_URL,
    waitingChats: 0,
  });
});

test('quitting before ready waits for the CLIs to exit, then stops the processes', async () => {
  const h = await loadMain();
  const e = { preventDefault: mock.fn() };
  h.app.emit('before-quit', e);
  // the Claude Code CLIs close their Chrome tab groups as they exit: quitting waits for that first
  assert.equal(e.preventDefault.mock.callCount(), 1);
  assert.equal(h.claude.closeAll.mock.callCount(), 1);
  assert.equal(h.one('AppServer').stop.mock.callCount(), 0);
  h.app.emit('before-quit', e);
  assert.equal(e.preventDefault.mock.callCount(), 2, 'another quit while waiting is held too');
  await waitFor(() => h.app.quit.mock.callCount() === 1, 'the quit that follows the transcript drain');
  h.app.emit('before-quit', e);
  assert.equal(e.preventDefault.mock.callCount(), 2);
  assert.equal(h.one('AppServer').stop.mock.callCount(), 1);
  assert.equal(h.claude.closeAll.mock.callCount(), 1);
  assert.equal(h.mod('platform/pty.cjs').killAll.mock.callCount(), 1);
});

test('quitting asks the exit gate first, then cleans up', async () => {
  const h = await loadMain();
  await h.ready();
  const gate = h.inst.exitGate[0];
  gate.request = mock.fn(async () => false);
  const e = { preventDefault: mock.fn() };
  h.app.emit('before-quit', e);
  await flush();
  assert.equal(e.preventDefault.mock.callCount(), 1);
  assert.equal(h.app.quit.mock.callCount(), 0, 'the user kept the app open');
  gate.request = mock.fn(async () => true);
  h.app.emit('before-quit', e);
  await flush();
  assert.equal(h.app.quit.mock.callCount(), 1);
  gate.passed = true;
  // a rollout watcher is let go on quit
  const file = path.join(h.tmp, 'sessions', 'r.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  h.one('ChatController').chatOf = (id: string) => `chat:${id}`;
  assert.equal(await h.invoke('codex:watchRollout', 't1', file), true);
  h.app.emit('before-quit', e);
  // the gate passed: quitting waits for the Claude Code and Your Chrome CLIs to exit, then goes through
  assert.equal(e.preventDefault.mock.callCount(), 3);
  assert.equal(h.one('ChromeChannel').stopAll.mock.callCount(), 1, 'only once the gate passed');
  await waitFor(() => h.app.quit.mock.callCount() === 2, 'the quit that follows the transcript drain');
  h.app.emit('before-quit', e);
  assert.equal(e.preventDefault.mock.callCount(), 3);
  for (const name of ['Accounts', 'Updater', 'Telemetry'])
    assert.equal(h.one(name)[name === 'Telemetry' ? 'persist' : 'dispose'].mock.callCount(), 1, name);
  assert.equal(h.one('AcpHost').closeAll.mock.callCount(), 1);
  assert.equal(h.inst.computerUse[0].stop.mock.callCount(), 1);
  assert.equal(h.one('ChromeChannel').stopAll.mock.callCount(), 1, 'a cancelled quit leaves every chat its Chrome');
  assert.equal(h.claude.closeAll.mock.callCount(), 1);
  assert.deepEqual(calls(h.one('ExternalWrites').forget), [['chat:t1', { kind: 'codex', key: 't1' }]]);
});

test('quitting waits for computer use to give the Mac back (held keys, hidden apps, the clipboard) before its helper stops', async () => {
  const h = await loadMain();
  await h.ready();
  h.inst.exitGate[0].passed = true;
  const cu = h.inst.computerUse[0];
  let holding = true;
  let letGo!: () => void;
  cu.holding = mock.fn(() => holding);
  cu.letGo = mock.fn(() => new Promise<void>((r) => (letGo = r)));
  const e = { preventDefault: mock.fn() };
  h.app.emit('before-quit', e);
  assert.equal(e.preventDefault.mock.callCount(), 1);
  assert.equal(cu.stop.mock.callCount(), 0, 'the helper still runs while it gives things back');
  assert.equal(h.one('AppServer').stop.mock.callCount(), 0);
  // a second Cmd+Q meanwhile waits for the same give-back (computer use no longer says it holds anything)
  holding = false;
  h.app.emit('before-quit', e);
  assert.equal(e.preventDefault.mock.callCount(), 2);
  assert.equal(cu.letGo.mock.callCount(), 1);
  assert.equal(cu.stop.mock.callCount(), 0);
  letGo();
  await flush();
  await new Promise((r) => setImmediate(r));
  assert.equal(h.app.quit.mock.callCount(), 1, 'then quits again');
  // then the Claude Code and Your Chrome CLIs get their moment to close their Chrome tab groups
  h.app.emit('before-quit', e);
  assert.equal(e.preventDefault.mock.callCount(), 3);
  assert.equal(h.claude.closeAll.mock.callCount(), 1);
  assert.equal(h.one('ChromeChannel').stopAll.mock.callCount(), 1);
  assert.equal(cu.stop.mock.callCount(), 0);
  await waitFor(() => h.app.quit.mock.callCount() === 2, 'the quit that follows the transcript drain');
  h.app.emit('before-quit', e);
  assert.equal(e.preventDefault.mock.callCount(), 3);
  assert.equal(cu.stop.mock.callCount(), 1);
});

test('the basic-harness identity driver lists nothing before admission opens', async () => {
  const h = await loadMain({
    before: (h) => (h.mods['electron/identity/drivers/acp.cjs'].AcpDriver = h.cls('AcpDriver', (o: any) => ({ early: o.list() }))),
  });
  await h.ready();
  assert.deepEqual(h.one('AcpDriver').early, []);
});
