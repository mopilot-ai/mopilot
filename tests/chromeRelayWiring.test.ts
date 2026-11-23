// How main wires the user's Chrome for the native-shaped tools (B2) when shared.browser.chromeRelay or
// shared.browser.chromeExtension is on at startup: setupChromeRelay gets main's grants, token, profile, images, model and
// confirmation card, the channel the switches choose and, for MoPilot's own extension, its saved pairing; the
// channel stops at quit; its host's turn ends in the turn ledger beside the in-app browser's, and its tabs are the chat's
// leases; native Codex threads get the Chrome backend and its note. Off, none of it exists.
import { test, mock, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadMain, unloadMain, flush } from './support/electron-main-harness.ts';

const require = createRequire(import.meta.url);
const { chromeRelayFacts, chromeFolders, chromeRelayNotices } = require('../electron/app/chromeRelay.cjs');
const { CapabilityHealth } = require('../electron/capabilities/capabilityHealth.cjs');

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
after(() => unloadMain());
const calls = (f: any) => f.mock.calls.map((c: any) => c.arguments);

async function relayMain(mode: 'relay' | 'extension' | 'off' | 'codex', { shipped = true, vendorCodex = mode !== 'codex' } = {}) {
  const on = mode !== 'off' && mode !== 'codex';
  const relay = {
    kind: mode,
    relay: { status: () => ({ paired: false, connected: false, version: null }) },
    tabs: { turnEnded: mock.fn(async () => undefined), leases: mock.fn((chatId: string) => [{ surface: 'chromeTab', id: '7', chatId }]) },
    stop: mock.fn(),
    onSessionPatch: mock.fn(),
    screenshots: mock.fn((chatId: string, tabId: string) => (tabId === 'tab_c1' ? `saver ${chatId}` : null)),
  };
  const setup = mock.fn(() => relay);
  const chromeBackends = {
    has: mock.fn((id: string) => id === 'th-1'),
    serves: mock.fn((id: string) => id === 'th-1'),
    loading: mock.fn(() => false),
    available: mock.fn(() => true),
    exited: mock.fn(),
  };
  const h = await loadMain({
    before: (h) => {
      const NativeAvailability = h.mod('capabilities/nativeAvailability.cjs').NativeAvailability;
      h.mod('capabilities/nativeAvailability.cjs').NativeAvailability = function (o: any) {
        assert.equal(o.live().codexChromeBackend, false, 'early status never claims an uncreated backend');
        return new NativeAvailability(o);
      };
      h.mod('platform/flags.cjs').isEnabled.mock.mockImplementation(
        (k: string) =>
          k !== 'shared.browser.viewTabs' &&
          (on || k !== 'shared.browser.chromeRelay') &&
          (mode === 'extension' || k !== 'shared.browser.chromeExtension') &&
          (!vendorCodex || k !== 'codex.browser.chromeExtension') &&
          (!vendorCodex || k !== 'shared.browser.chromeExtensionByDefault'),
      );
      h.mods['electron/capabilities/browser/host.cjs'] = { BrowserTabs: h.cls('BrowserTabs') };
      h.mods['electron/capabilities/browser/hostTools.cjs'] = { registerBrowserTools: mock.fn(), inAppBrowserEnabled: mock.fn(() => true) };
      h.mods['electron/app/chromeRelay.cjs'] = {
        setupChromeRelay: setup,
        chromeRelayFacts,
        chromeRelayNotices,
        extensionShipped: () => shipped,
      };
      h.mods['electron/capabilities/browser/chromeBackend.cjs'] = {
        mainChromeBackends: mock.fn(() => chromeBackends),
        combineBackends: mock.fn((...list: any[]) => ({ combined: list })),
        chromeBackendNote: mock.fn((id: string) => `note ${id}`),
      };
    },
  });
  await h.ready();
  await flush();
  return { h, relay, setup, chromeBackends };
}

test('on at startup: the relay gets main’s grants, token, profile, images, model and cards; it stops at quit and its turn ends in the ledger', async () => {
  const { h, relay, setup, chromeBackends } = await relayMain('relay');
  assert.equal(setup.mock.callCount(), 1);
  const [o] = calls(setup)[0];
  // the user's Chrome's own site table (the second OriginGrants main makes, D4), not the in-app browser's
  assert.equal(
    o.grants,
    h.inst.OriginGrants.find((g: any) => g.opts.browser === 'chrome'),
  );
  // through action memory's recorder (app/routines.cjs, G4), which passes main's Registry through
  h.one('Registry').probe = 'main-registry';
  assert.equal(o.registry.probe, 'main-registry');
  const tokens = h.one('ChromeTokens');
  tokens.get = mock.fn((profile: string) => `token:${profile}`);
  assert.equal(o.token(), 'token:');
  assert.equal(o.profileDir(), '');
  h.electron.nativeImage.createFromBuffer = mock.fn((b: Buffer) => ({ img: b.length }));
  assert.deepEqual(o.images.fromBuffer(Buffer.from('ab')), { img: 2 });
  h.one('ChatController').ref = () => ({ kind: 'codex' });
  assert.ok(['string', 'object'].includes(typeof (await o.modelOf('c'))));
  assert.deepEqual(o.folders('c').uploads.endsWith('c'), true);
  assert.equal(o.isFlagEnabled('shared.browser.chromeRelay'), true);
  assert.equal(o.kind, 'relay');
  // the JavaScript and upload card: the relay's names the user's Chrome, the browser_* tools' the in-app browser
  const browserDeps = calls(h.mod('capabilities/browser/hostTools.cjs').registerBrowserTools)[0][1];
  const asked: string[] = [];
  h.inst.computerUse.at(-1).broker.ask = async (_c: string, _k: string, p: any) => (asked.push(p.browser), { decision: 'allow' });
  assert.equal(await o.confirm({ chatId: 'c' }, { tool: 'upload', origin: 'https://a.test' }), true);
  assert.equal(await browserDeps.confirm({ chatId: 'c' }, { tool: 'upload', origin: 'https://a.test' }), true);
  assert.deepEqual(asked, ['chrome', 'iab']);
  // browser_save_screenshot hands a tab of the chat's Chrome group to the relay's saver (#1539), and only such a tab
  assert.equal(browserDeps.chromeShots('c', 'tab_c1'), 'saver c');
  assert.equal(browserDeps.chromeShots('c', 'tab_p1'), null);
  // the turn ledger lets go of the chat's Chrome tabs beside its in-app tabs
  h.one('BrowserTabs').turnEnded = mock.fn(async () => undefined);
  h.one('SessionStore').opts.publish({ chatId: 'c', patch: { turn: 'idle' } });
  await flush();
  assert.deepEqual(calls(relay.tabs.turnEnded), [['c']]);
  // the session patch also reaches the relay, whose chat group shows the turn (#1632)
  assert.deepEqual(calls(relay.onSessionPatch), [[{ chatId: 'c', patch: { turn: 'idle' } }]]);
  // the capability-health record reports the relay: set up at startup, the extension found
  const relayHealth = () => h.one('NativeAvailability').opts.live().health.chromeRelay;
  assert.deepEqual(relayHealth(), { state: 'ready', usable: true, reason: null, fix: null, channel: 'relay' });
  // native Codex threads: the in-app and Chrome backends together, and the note for a thread with a Chrome backend
  const inj = h.one('CodexToolInjection').opts;
  assert.equal(inj.browserBackends.combined.length, 2);
  assert.equal(inj.chromeNote('th-1'), 'note th-1');
  assert.equal(inj.chromeNote('th-2'), null);
  // and while MoPilot serves Chrome through the chrome_* tools, the plugin's own cua_repl without its Chrome (#1319 G28),
  // read from the Codex home the app-server runs with
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
  const plugin = path.join(home, 'plugins', 'cache', 'openai-bundled', 'unified-computer-use', '26.1013.1');
  fs.mkdirSync(plugin, { recursive: true });
  const cua = { command: '/n', env: { BROWSER_USE_AVAILABLE_BACKENDS: 'chrome,iab' } };
  fs.writeFileSync(path.join(plugin, '.mcp.json'), JSON.stringify({ mcpServers: { cua_repl: cua } }));
  h.mod('platform/env.cjs').childEnv.mock.mockImplementation(() => ({ CODEX_HOME: home }));
  assert.equal(inj.chromeOff().env.BROWSER_USE_AVAILABLE_BACKENDS, 'iab');
  h.mod('platform/env.cjs').childEnv.mock.mockImplementation(() => ({}));
  assert.notEqual(inj.chromeOff(), undefined, "without CODEX_HOME, the user's ~/.codex");
  fs.rmSync(home, { recursive: true, force: true });
  // a quit the exit gate may still hold back leaves Chrome control running; the app going stops it
  h.app.emit('before-quit', { defaultPrevented: true, preventDefault: mock.fn() });
  assert.equal(relay.stop.mock.callCount(), 0);
  h.app.emit('will-quit', {});
  assert.equal(chromeBackends.exited.mock.callCount(), 1);
  assert.equal(relay.stop.mock.callCount(), 1);
});

test('off at startup: no relay is set up, and the turn end has no Chrome tabs to let go of', async () => {
  const { h, setup } = await relayMain('off');
  assert.equal(setup.mock.callCount(), 0);
  // browser_save_screenshot has no Chrome tab to hand off to (#1539)
  assert.equal(calls(h.mod('capabilities/browser/hostTools.cjs').registerBrowserTools)[0][1].chromeShots('c', 'tab_c1'), null);
  assert.equal(h.one('NativeAvailability').opts.live().health.chromeRelay.state, 'off');
  // switched on after startup: not set up, so not usable until a restart
  h.mod('platform/flags.cjs').isEnabled.mock.mockImplementation((k: string) => k !== 'shared.browser.viewTabs');
  assert.equal(h.one('NativeAvailability').opts.live().health.chromeRelay.state, 'unavailable');
  h.one('BrowserTabs').turnEnded = mock.fn(async () => undefined);
  h.one('SessionStore').opts.publish({ chatId: 'c', patch: { turn: 'idle' } });
  await flush();
  assert.equal(h.one('BrowserTabs').turnEnded.mock.callCount(), 1);
});

test('MoPilot’s own extension at startup: the channel is the extension, with its saved pairing; health reads its pairing, and its tabs are the chat’s leases', async () => {
  const { h, setup } = await relayMain('extension');
  assert.equal(setup.mock.callCount(), 1);
  const [o] = calls(setup)[0];
  assert.equal(o.kind, 'extension');
  // a chat whose turn runs keeps its Chrome tabs past the idle wait (CM-Z24)
  h.one('SessionStore').running = mock.fn((id: string) => id === 'busy');
  assert.equal(o.busy('busy'), true);
  assert.equal(o.busy('idle'), false);
  // Stop on a Chrome tab's control frame stops the chat's turn, as Esc does (#1632)
  // and its turn ends tell the Chrome host the agent's reply (#1699): the setup gets the chat controller
  assert.equal(o.controller, h.one('ChatController'));
  // the chat's tab group is titled for the chat (any harness's chat name), or for its id while it has none
  h.one('CodexAdapter').chatName = mock.fn((id: string) => (id === 'c' ? 'Fix login' : ''));
  assert.equal(o.chatTitle('c'), 'Fix login');
  assert.equal(o.chatTitle('d'), null);
  // its saved pairing and native host's launcher are in main's capabilities folder (chromeRelay.cjs extensionFiles)
  assert.ok(o.files.dir.endsWith('capabilities') && o.files.safeStorage && typeof o.files.packaged === 'boolean');
  // the extension connecting or going away tells the capability-health record's readers
  const changed = mock.method(CapabilityHealth.prototype, 'changed');
  o.onStatus();
  assert.equal(changed.mock.callCount(), 1);
  changed.mock.restore();
  // "Allow Chrome to connect?" goes through the app's notifier (app/chromeAskNotice.cjs)
  const notifier = h.mod('platform/notify.cjs').registerNotify.mock.calls[0].result;
  o.onAsk(true);
  o.onAsk(false);
  assert.equal(notifier.notify.mock.calls[0].arguments[0], 'approval');
  assert.deepEqual(notifier.retract.mock.calls[0].arguments, ['settings:browser']);
  // not paired yet: usable (the first step opens the pairing page), and it says so
  const health = h.one('NativeAvailability').opts.live().health.chromeRelay;
  assert.equal(health.state, 'permission');
  assert.match(health.reason, /isn't paired yet/);
  // a switch's handoff lists the chat's Chrome tabs (TargetLeases)
  const held = h.one('SwitchRunner').opts.held('c');
  assert.ok(held.some((l: any) => l.surface === 'chromeTab' && l.id === '7'));
});

test('Codex default (CM-Z26): with both switches off, a build that ships the extension serves it to Codex segments by default; the vendor’s own Chrome stays a setting', async () => {
  {
    const { h, setup } = await relayMain('codex');
    assert.equal(setup.mock.callCount(), 1);
    const [o] = calls(setup)[0];
    assert.equal(o.kind, 'extension');
    // native Codex threads get MoPilot's Chrome backend, told whether the build ships the extension
    const backends = calls(h.mod('capabilities/browser/chromeBackend.cjs').mainChromeBackends)[0][0];
    assert.equal(backends.shipped, true);
    assert.equal(h.one('NativeAvailability').opts.live().codexChromeBackend, true);
    assert.equal(h.one('CodexToolInjection').opts.chromePending('th-1'), false);
  }
  // the vendor's own Chrome chosen for Codex: nothing is set up
  assert.equal((await relayMain('codex', { vendorCodex: true })).setup.mock.callCount(), 0);
  // a build without the extension keeps Codex on the vendor's Chrome
  assert.equal((await relayMain('codex', { shipped: false })).setup.mock.callCount(), 0);
});

test('chromeFolders: the chrome_* tools name the chat’s upload folder and no downloads folder, which Chrome never saves into (#1570)', () => {
  assert.equal(chromeFolders(null), null);
  assert.equal(chromeFolders(undefined), null);
  const f = chromeFolders((chatId: string) => ({ uploads: `/u/${chatId}`, downloads: `/d/${chatId}` }));
  assert.deepEqual(f('c'), { uploads: '/u/c', downloads: null });
  assert.equal(chromeFolders(() => null)('c'), null);
});
