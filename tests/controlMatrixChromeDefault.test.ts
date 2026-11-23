// The control matrix (docs/control-plane/matrix.md), stream Z: who drives the user's Chrome by default on each harness.
// Codex segments get MoPilot's own extension by default (the bu1 comparison: Codex 19/21 on it), wherever the build
// ships it; codex.browser.chromeExtension off keeps the vendor's own Chrome (the ChatGPT extension) as a setting. Every
// other session without a Chrome controller of its own (ACP, a managed Codex thread, Claude without Claude in Chrome) is
// shown the chrome_* tools there by default (CM-Z32, #1483), and one left with none is told so.
import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { reverseGraph } from '../scripts/related-tests.mjs';
import assert from 'node:assert/strict';
import { bindActualControllerPlans } from './support/main-controller-plan.ts';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DEFAULTS } = require('../electron/platform/flags.cjs');
const {
  codexChromeOn,
  servedChromeKind,
  chromeControlOn,
  chromeToolsOn,
  CODEX_EXTENSION_FLAG,
  DEFAULT_EXTENSION_FLAG,
} = require('../electron/capabilities/browser/chromeControl.cjs');
const { mainChromeBackends } = require('../electron/capabilities/browser/chromeBackend.cjs');
const { extensionShipped, installHint } = require('../electron/app/chromeRelay.cjs');
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { ToolVisibility } = require('../electron/capabilities/visibility.cjs');

/** The switches as the build ships them, with `over` on top. */
const flags =
  (over: Record<string, boolean> = {}) =>
  (k: string) =>
    over[k] ?? DEFAULTS[k] ?? false;

test("CM-Z26: Codex segments drive the user's Chrome through MoPilot's extension by default where the build ships it; the vendor's own Chrome is a setting", () => {
  assert.equal(CODEX_EXTENSION_FLAG, 'codex.browser.chromeExtension');
  assert.equal(DEFAULTS['codex.browser.chromeExtension'], true, 'on by default, so the server can still turn it off');
  assert.equal(DEFAULTS['shared.browser.chromeExtension'], false, 'a switch for every harness, off');
  const shipped = { shipped: true };
  // the defaults: Codex gets the extension, served at startup
  assert.equal(codexChromeOn(flags(), shipped), true);
  assert.equal(servedChromeKind(flags(), shipped), 'extension');
  // no switch for every harness is on: the chrome_* tools follow the default for builds that ship the extension (CM-Z32)
  assert.equal(chromeControlOn(flags()), false);
  const registry = new Registry();
  registry.register({
    name: 'chrome_navigate',
    description: 'd',
    policy: 'observe',
    inputSchema: { type: 'object' },
    handler: async () => 'ok',
  });
  // a build without the extension: hidden
  const vis = new ToolVisibility({ registry, isEnabled: flags(), drivesUserChrome: () => false });
  assert.equal(vis.hides('chrome_navigate'), true);
  // a build without the extension (packaged, for now) keeps Codex on the vendor's Chrome
  assert.equal(codexChromeOn(flags(), { shipped: false }), false);
  assert.equal(servedChromeKind(flags()), null);
  // the default off (the server can turn it off): Codex keeps the vendor's own Chrome, unless a switch for every
  // harness serves MoPilot's Chrome to all of them
  const noDefault = { 'codex.browser.chromeExtension': false };
  assert.equal(codexChromeOn(flags(noDefault), shipped), false);
  // ... the channel is still served for every other session's chrome_* tools (CM-Z32), and with that default off too, none
  assert.equal(servedChromeKind(flags(noDefault), shipped), 'extension');
  assert.equal(servedChromeKind(flags({ ...noDefault, [DEFAULT_EXTENSION_FLAG]: false }), shipped), null);
  assert.equal(codexChromeOn(flags({ ...noDefault, 'shared.browser.chromeExtension': true }), shipped), true);
  // native Codex threads off: no Codex backend
  assert.equal(codexChromeOn(flags({ 'native.codex.enabled': false }), shipped), false);
  // a switch for every harness still serves Codex too, on its channel
  assert.equal(codexChromeOn(flags({ 'shared.browser.chromeRelay': true }), { shipped: false }), true);
  assert.equal(servedChromeKind(flags({ 'shared.browser.chromeRelay': true }), shipped), 'relay');
  // the Codex backend follows the same rule
  const backends = (over: Record<string, boolean>, s: boolean) =>
    mainChromeBackends({
      live: {},
      server: {},
      isFlagEnabled: flags(over),
      shellEnv: { childEnv: () => ({}) },
      home: '/nonexistent',
      shipped: s,
    });
  // ... only while the chrome_* tools are off: with them on (the default), a Codex thread gets them instead (CM-Z33)
  const noTools = { 'shared.browser.chromeExtensionByDefault': false };
  assert.equal(backends(noTools, true).o.enabled(), true);
  assert.equal(backends({}, true).o.enabled(), false);
  assert.equal(backends(noTools, false).o.enabled(), false);
  assert.equal(backends({ ...noTools, 'codex.browser.chromeExtension': false }, true).o.enabled(), false);
  assert.equal(backends({ 'shared.browser.chromeExtension': true }, false).o.enabled(), false);
  // this checkout ships the extension; a packaged app's (inside its asar) does through the Web Store's id (#1632)
  const packaged = '/Applications/MoPilot.app/Contents/Resources/app.asar/electron/chrome-extension';
  assert.equal(extensionShipped(), true);
  assert.equal(extensionShipped(packaged, 'abcdefghijklmnopabcdefghijklmnop'), true);
  assert.equal(extensionShipped(packaged, null), false);
  assert.match(installHint('/x/app.asar/electron/chrome-extension', null), /doesn't ship/);
});

test("CM-Z26: a native Codex thread MoPilot serves the user's Chrome to hands a sign-in over to the plugin on MoPilot's Chrome, not to Your Chrome or the vendor's", async (t) => {
  const { handoffRoute, movedNote, opensInUserChrome, ROUTE_LABEL } = await import('../shared/chromeHandoff.mjs');
  const { chatHandoffRoute } = require('../electron/capabilities/browser/handoff.cjs');
  assert.equal(
    handoffRoute({ vendor: 'codex-browser-plugin', relay: null, yourChrome: true, onChrome: true, codexExtension: true }),
    'codex-extension',
  );
  assert.equal(handoffRoute({ vendor: null, relay: null, yourChrome: true, onChrome: false }), 'your-chrome');
  assert.equal(opensInUserChrome('codex-extension'), true);
  // the site opens in the Chrome profile MoPilot's channel uses, where the chat's tab group is
  const { openSiteForRoute } = require('../electron/capabilities/browser/openSite.cjs');
  const opened: any[] = [];
  await openSiteForRoute('https://a.test/', 'codex-extension', {
    openExternal: async () => assert.fail('not the default browser'),
    openInChrome: async (u: string, p: any) => void opened.push([u, p]),
    vendorProfile: () => assert.fail("not the vendor's profile"),
    profileDir: 'Profile 3',
  });
  assert.deepEqual(opened, [['https://a.test/', { profileDir: 'Profile 3' }]]);
  assert.equal(ROUTE_LABEL['codex-extension'], 'the Codex Browser plugin');
  assert.match(movedNote('codex-extension', 'https://a.test/'), /"MoPilot Chrome" from agent\.browsers\.list\(\) by its id/);
  const route = (o: any) =>
    chatHandoffRoute({ plan: null, isEnabled: () => false, channel: 'builtin', relay: { kind: 'extension' }, ...o });
  assert.equal(route({ codexExtension: true }), 'codex-extension');
  // no channel set up at startup: nothing to continue on
  assert.equal(route({ codexExtension: true, relay: null }), 'none');
  assert.equal(route({}), 'none');
  // main's wiring: the chat's current segment's thread, as its Codex Chrome backends know it
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const { loadMain, unloadMain, flush } = await import('./support/electron-main-harness.ts');
  const realRelay = require('../electron/app/chromeRelay.cjs');
  const realBackend = require('../electron/capabilities/browser/chromeBackend.cjs');
  let serving = true;
  const h = await loadMain({
    before: (h: any) => {
      h.mod('platform/flags.cjs').isEnabled.mock.mockImplementation(
        (k: string) => k !== 'shared.browser.viewTabs' && !k.startsWith('shared.browser.chrome') && k !== 'remote.enabled',
      );
      h.mods['electron/capabilities/browser/host.cjs'] = { BrowserTabs: h.cls('BrowserTabs') };
      h.mods['electron/capabilities/browser/hostTools.cjs'] = {
        registerBrowserTools: t.mock.fn(),
        inAppBrowserEnabled: t.mock.fn(() => true),
      };
      h.mods['electron/app/chromeRelay.cjs'] = {
        ...realRelay,
        setupChromeRelay: () => ({
          kind: 'extension',
          relay: { status: () => ({}) },
          tabs: { turnEnded: async () => undefined },
          stop: () => undefined,
        }),
      };
      h.mods['electron/capabilities/browser/chromeBackend.cjs'] = {
        ...realBackend,
        mainChromeBackends: () => ({
          has: (id: string) => id === 'th-1',
          serves: (id: string) => serving && id === 'th-1',
          loading: () => false,
          available: () => true,
          exited: () => undefined,
        }),
      };
    },
  });
  try {
    await h.ready();
    await flush();
    const w = h.windows[0];
    assert.equal(await h.invokeFrom(w.webContents, 'browser:handoffRoute', 'codex'), 'none', 'no snapshot is no route');
    const tools = h.one('CodexToolInjection');
    tools.hasTools = () => false;
    tools.toolsOf = () => [];
    tools.loadedPath = (id: string) => ({ chrome: serving && id === 'th-1', computer: false, iab: false, tools: false });
    tools.routedSurfaces = () => ({ surfaces: {} });
    bindActualControllerPlans(h);
    h.one('ChatController').ref = (chatId: string) => {
      if (chatId === 'gone') throw new Error('no segment');
      return { kind: 'codex', id: chatId === 'codex' ? 'th-1' : 'th-2' };
    };
    assert.equal(await h.invokeFrom(w.webContents, 'browser:handoffRoute', 'codex'), 'codex-extension');
    serving = false;
    assert.equal(
      await h.invokeFrom(w.webContents, 'browser:handoffRoute', 'codex'),
      'none',
      'pending or disabled membership is not serving',
    );
    assert.equal(await h.invokeFrom(w.webContents, 'browser:handoffRoute', 'other'), 'none');
    assert.equal(await h.invokeFrom(w.webContents, 'browser:handoffRoute', 'gone'), 'none');
  } finally {
    unloadMain();
  }
});

test("CM-Z32: where the build ships MoPilot's extension, every session without a Chrome controller of its own (ACP, a managed Codex thread, Claude without Claude in Chrome) is shown the chrome_* tools; one left with none is told so (#1483)", async () => {
  const { setupChromeRelay, chromeRelayFacts } = require('../electron/app/chromeRelay.cjs');
  const { chatHandoffRoute } = require('../electron/capabilities/browser/handoff.cjs');
  const { surfaceNote, registryNote } = require('../electron/capabilities/contract/surfaceNote.cjs');
  const { CLAUDE_IN_CHROME_HOST } = require('../electron/capabilities/visibility.cjs');
  assert.equal(DEFAULT_EXTENSION_FLAG, 'shared.browser.chromeExtensionByDefault');
  assert.equal(DEFAULTS[DEFAULT_EXTENSION_FLAG], true, 'on by default, so the server can still turn it off');
  const shipped = { shipped: true };
  const off = { [DEFAULT_EXTENSION_FLAG]: false };
  // the rule: on by default where the build ships the extension; a switch for every harness turns it on anywhere
  assert.equal(chromeToolsOn(flags(), shipped), true);
  assert.equal(chromeToolsOn(flags(), { shipped: false }), false);
  assert.equal(chromeToolsOn(flags()), false, 'a build is taken not to ship it unless it says so');
  assert.equal(chromeToolsOn(flags(off), shipped), false);
  assert.equal(chromeToolsOn(flags({ ...off, 'shared.browser.chromeRelay': true }), { shipped: false }), true);
  // served at startup even with Codex's own default off and native Codex threads off: ACP needs the channel too
  const noCodex = { 'codex.browser.chromeExtension': false, 'native.codex.enabled': false };
  assert.equal(servedChromeKind(flags(noCodex), shipped), 'extension');
  assert.equal(servedChromeKind(flags({ ...noCodex, ...off }), shipped), null);
  // the capability-health record calls it on wherever it is served
  const facts = (over: Record<string, boolean>) =>
    chromeRelayFacts({ isFlagEnabled: flags(over), setup: null, installedVersion: () => null, extensionUrl: 'u' });
  assert.equal(facts(noCodex).enabled, true);
  assert.equal(facts({ ...noCodex, ...off }).enabled, false);

  // who is shown them: every session, unless its harness drives Chrome itself or Your Chrome is the channel
  const registry = new Registry();
  registry.register({
    name: 'chrome_navigate',
    description: 'd',
    policy: 'observe',
    inputSchema: { type: 'object' },
    handler: async () => 'ok',
  });
  const vis = (over: Record<string, boolean> = {}, o: any = {}) =>
    new ToolVisibility({ registry, isEnabled: flags(over), drivesUserChrome: () => !!o.yourChrome, chromeShipped: true });
  assert.equal(vis().hides('chrome_navigate'), false, 'an ACP session, a managed Codex thread');
  assert.equal(vis().hides('chrome_navigate', CLAUDE_IN_CHROME_HOST), true, 'Claude in Chrome');
  assert.equal(vis().hides('chrome_navigate', { nativeChrome: true }), true, "a native Codex thread's plugin");
  assert.equal(vis({}, { yourChrome: true }).hides('chrome_navigate'), true, 'Your Chrome is the channel');
  assert.equal(vis(off).hides('chrome_navigate'), true, 'the default turned off');
  assert.equal(
    new ToolVisibility({ registry: new Registry(), isEnabled: flags(), chromeShipped: true }).hides('chrome_navigate'),
    true,
    'not served',
  );

  // the tools themselves: on with the default, refused once the server turns it off (this checkout ships the extension)
  const on = new Set([DEFAULT_EXTENSION_FLAG]);
  const tools = new Registry();
  tools.setApprover(() => true);
  const s = setupChromeRelay({
    registry: tools,
    grants: { browser: 'chrome', peek: () => 'ok', turnEnded: () => undefined },
    token: () => 'tok',
    profileDir: () => '',
    images: { fromBuffer: (b: Buffer) => b },
    isFlagEnabled: (k: string) => on.has(k),
    open: async () => undefined,
  });
  try {
    assert.match(JSON.stringify(await tools.invoke('acp-chat', 's', 'chrome_tabs_context_mcp', { createIfEmpty: false })), /no tab group/);
    on.clear();
    assert.match(
      JSON.stringify(await tools.invoke('acp-chat', 's', 'chrome_tabs_context_mcp', {})),
      /Chrome control through MoPilot is turned off/,
    );
  } finally {
    s.stop();
  }

  // "Continue in Chrome" from such a chat goes to MoPilot's Chrome tools by the same rule as the tools (`toolsOn`)
  on.add(DEFAULT_EXTENSION_FLAG);
  const route = () =>
    chatHandoffRoute({
      plan: null,
      channelEnabled: true,
      tools: ['chrome_tabs_context_mcp', 'chrome_navigate'],
      isEnabled: () => false,
      channel: 'builtin',
      relay: { kind: s.kind, toolsOn: s.toolsOn },
    });
  assert.equal(route(), 'relay');
  on.clear();
  assert.equal(route(), 'none');

  // a session with no tool for the user's Chrome is told so, never left to retry a browser it can only look at
  const none = /The user's own Chrome, where they are signed in: no tool in this chat acts in it/;
  const look = /the tools for apps on this Mac can only look at a browser, never click or type in it, whatever the user grants/;
  const acp = registryNote(
    { list: () => ['browser_navigate', 'desktop_left_click'].map((name) => ({ name })) },
    { drivesUserChrome: () => false },
  );
  assert.match(acp, none);
  assert.match(acp, look);
  assert.match(acp, /tell the user it can't be done from this chat instead of retrying or asking for more access/);
  // only the in-app browser: no word about apps
  assert.match(surfaceNote(['browser_navigate'], { yourChrome: false }), none);
  assert.doesNotMatch(surfaceNote(['browser_navigate'], { yourChrome: false }), look);
  // a Chrome tool, Your Chrome, or the harness's own Chrome controller: not said
  assert.doesNotMatch(surfaceNote(['browser_navigate', 'chrome_navigate'], { yourChrome: false }), none);
  assert.doesNotMatch(surfaceNote(['sage_browser_click', 'desktop_left_click'], { yourChrome: true }), none);
  assert.doesNotMatch(surfaceNote(['browser_navigate', 'desktop_left_click'], { yourChrome: false, ownChrome: true }), none);

  // a desktop step refused in a browser says no grant raises it, so the model doesn't ask the user for more access
  const { SAFARI, rig, rejects } = await import('./support/desktop-kit.ts');
  const r = rig();
  await r.ready([SAFARI]);
  r.helper.front = SAFARI;
  await rejects(
    r.call('desktop_left_click', { coordinate: [1, 1] }),
    'tier',
    /Safari is never granted more than this, so don't ask the user for more access/,
  );
});

// IPC queries and registration callers are contract owners even when their file primarily tests another feature.
test('main browser handoff query and registration consumers stay explicit in the contract inventory', () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const sources = readdirSync(new URL('./', import.meta.url), { recursive: true })
    .filter((p): p is string => typeof p === 'string' && /\.(?:[cm]?js|[cm]?ts|tsx)$/.test(p))
    .map((p) => ({ path: `tests/${p.replaceAll('\\', '/')}`, text: readFileSync(new URL(p, import.meta.url), 'utf8') }));
  const queryFiles = Object.fromEntries(
    ['handoffRoute', 'handoffContinuation', 'continueInChrome'].map((name) => [
      name,
      sources
        .filter(({ text }) => new RegExp('[\"\'`]browser:' + name + '[\"\'`]').test(text))
        .map(({ path }) => path)
        .sort(),
    ]),
  );
  assert.deepEqual(queryFiles, {
    handoffRoute: [
      'tests/browserPageEdgesWiring.test.ts',
      'tests/controlMatrixChromeDefault.test.ts',
      'tests/e2e/browser-blank-tab-recovery.spec.ts',
      'tests/support/chrome-matrix/main-wiring.ts',
    ],
    handoffContinuation: ['tests/support/chrome-matrix/main-wiring.ts'],
    continueInChrome: ['tests/support/chrome-matrix/main-wiring.ts', 'tests/support/electron-wiring/browser-routing.ts'],
  });
  const graph = reverseGraph(root);
  assert.deepEqual([...(graph.get(['electron', 'app', 'ipc', 'browser.cjs'].join('/')) ?? [])].sort(), [
    'tests/automationUpdateIpc.test.ts', // names the electron/app folder (module resolution); loads no IPC module
    'tests/automationsMomoTasks.test.ts', // the same
    'tests/browserDuplicateWiring.test.ts',
    'tests/browserPreviewIpc.test.ts',
    'tests/controlMatrixChromeDefault.test.ts', // this executable source-inventory owner
    'tests/harnessNamedCopy.test.ts', // reads electron/app/ipc's source text for its copy scan; registers nothing
    'tests/moduleBoundaries.test.ts', // boundary fixtures name electron/app; loads no IPC module
    'tests/support/site-contracts/contracts.ts',
    'tests/support/site-contracts/handoff.ts',
  ]);
  // browser-routing deliberately replaces chromeHandoff: electronMainWiring owns its wiring-only evidence.
});
