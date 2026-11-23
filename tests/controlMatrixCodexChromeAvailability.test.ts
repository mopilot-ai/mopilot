// CM-Z35: Codex Chrome availability, status and loaded notes follow the selected provider, not another extension.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { EventEmitter } from 'node:events';
import {
  facts,
  live,
  row,
  NativeAvailability,
  probe,
  fullMac,
  without,
  SKY,
  HOSTS,
  CACHE_MCP,
  mcpJson,
  CodexToolInjection,
  ToolSessions,
  availabilityStatus,
} from './support/native-availability/fixture.ts';
import { healthOf } from './support/control-matrix-kit.ts';
import { tick as settle } from './support/async-scenarios.ts';

export const GUARDS = [
  'electron/capabilities/',
  'electron/platform/flags.cjs',
  'electron/harness/',
  'electron/platform/',
  'electron/session/',
  'shared/',
];

const require = createRequire(import.meta.url);
const { DEFAULTS } = require('../electron/platform/flags.cjs');
const { planInputs, ControllerPlans } = require('../electron/session/controllerPlan.cjs');
const { servedChrome, codexChromeRoute } = require('../electron/capabilities/browser/chromeControl.cjs');
const { mainChromeBackends, chromeBackendNote, combineBackends } = require('../electron/capabilities/browser/chromeBackend.cjs');
const { chromeRelayHealth } = require('../electron/capabilities/capabilityHealth.cjs');
const { codexChromeOff } = require('../electron/capabilities/channels/codexPluginChrome.cjs');

/** Real probe, route selection and backend manager; external plugin files, host and socket are in-memory boundaries. */
function fixture() {
  const over: Record<string, boolean> = { 'native.codex.enabled': true, 'shared.browser.chromeExtensionByDefault': false };
  const flags = (key: string) => over[key] ?? DEFAULTS[key] ?? false;
  const service: any = { chromeRelay: { tabs: {} } };
  const backend = mainChromeBackends({
    live: service,
    server: {},
    isFlagEnabled: flags,
    shellEnv: { childEnv: () => ({}) },
    shipped: true,
  });
  const files = without(fullMac(), SKY, HOSTS);
  files[CACHE_MCP] = mcpJson({ CUA_REPL_ENABLED_SURFACES: 'browser', BROWSER_USE_AVAILABLE_BACKENDS: 'chrome,iab' });
  let probed = probe(files);
  backend.o.pluginEnv = () => ({ backends: probed.codex.runtime.backends ?? [], flavor: null, version: null });
  const waits: { finish: () => void; fail: () => void }[] = [];
  backend.fs = { existsSync: () => true, chmodSync: () => {}, rmSync: () => {} };
  backend.net = {
    createServer: () =>
      Object.assign(new EventEmitter(), {
        listen(_path: string, done: () => void) {
          waits.push({ finish: done, fail: () => this.emit('error', new Error('socket refused')) });
        },
        close() {},
      }),
  };
  const health: any = { ...healthOf(), chromeRelay: ownHealth() };
  const availability = new NativeAvailability({
    probe: () => probed,
    live: () =>
      live({
        codexNative: flags('native.codex.enabled'),
        health,
        claudeEligible: () => false,
        chromeServed: servedChrome(flags, { shipped: true }),
        codexChromeBackend: backend.available(),
      }),
  });
  const injection = (hasTools = true, onLoaded = (_id: string) => {}) =>
    new CodexToolInjection({
      sessions: new ToolSessions(),
      command: '/unused/sage-mcp',
      socketPath: '/unused/socket',
      harnessPid: () => 1,
      onLoaded,
      hasTools: () => hasTools,
      nativeEnabled: () => flags('native.codex.enabled'),
      nativeSurfaces: () => availability.codexSurfaces(),
      browserBackends: backend,
      visibleTools: () => ['browser_navigate'],
      chromePending: (id: string) => backend.loading(id),
      chromeNote: (id: string) => (backend.serves(id) ? chromeBackendNote(id) : null),
      degradedNote: (surfaces: any, name: string) => availability.degradedNote(surfaces, name),
    });
  return {
    over,
    service,
    backend,
    availability,
    health,
    waits,
    injection,
    setFacts: (value: any) => {
      probed = value;
      availability.refresh({ force: true });
    },
  };
}
function ownHealth(o: Record<string, unknown> = {}) {
  return {
    ...chromeRelayHealth({ enabled: true, running: true, kind: 'extension', paired: true, connected: true, ...o }),
    channel: 'extension',
  };
}
function start(inj: any, id = 'thread', method = 'thread/start', request = 1) {
  const sent = inj.outgoing({ id: request, method, params: method === 'thread/resume' ? { threadId: id } : {} });
  inj.observe({ id: request, result: { thread: { id } } });
  return sent;
}

test('CM-Z35: route B offers the real backend without the vendor extension or native computer use', async (t) => {
  const f = fixture();
  t.after(() => f.backend.exited());
  assert.equal(f.backend.available(), true);
  assert.equal(f.availability.codexSurfaces().chrome, true);
  assert.equal(f.availability.codexSurfaces().computer, false);
  const chrome = row(f.availability.status(), 'codex').chrome;
  assert.equal(chrome.state, 'mopilot');
  assert.equal(chrome.label, "MoPilot's extension");
  assert.doesNotMatch(JSON.stringify(chrome), /ChatGPT|OpenAI/);
  const published: (string | null)[] = [];
  const inj = f.injection(true, (id) => plans.loaded(id));
  const plans = new ControllerPlans({
    chats: { saved: () => false },
    sessions: { patch: (_chat: string, state: any) => published.push(state.controllerPlan.bu) },
    ref: () => ({ kind: 'codex', id: 'thread', key: 'thread' }),
    chatOf: () => 'chat',
    inputs: planInputs({
      tools: () => ['browser_navigate'],
      yourChrome: () => false,
      claude: {},
      acp: {},
      codex: {
        channel: () => true,
        loadedPath: (id: string) => inj.loadedPath(id),
        nativeSurfaces: () => f.availability.codexSurfaces(),
        iabAvailable: () => false,
        chromeBackend: () => f.backend,
      },
    }),
  });
  assert.equal(start(inj).params.config.plugins['unified-computer-use@openai-bundled'].enabled, true);
  assert.equal(f.backend.has('thread'), true, 'lifecycle membership can be starting');
  assert.equal(f.backend.serves('thread'), false, 'a pending socket cannot be offered as loaded Chrome');
  assert.deepEqual(published, [null]);
  assert.equal(inj.loadedPath('thread').chrome, false);
  f.waits[0].finish();
  await settle();
  assert.equal(f.backend.serves('thread'), true);
  assert.deepEqual(published, [null, 'mopilot-chrome']);
  assert.equal(inj.loadedPath('thread').chrome, true);
  assert.match(inj.turnContext('thread').context.value, /MoPilot Chrome/);
  assert.doesNotMatch(inj.turnContext('thread').context.value, /install ChatGPT|Selecting Chrome in the Browser plugin/);
});

test('CM-Z35: own-route readiness ignores vendor absent/disabled/ready and MCP off; pairing and connection stay truthful setup states', () => {
  const f = fixture();
  for (const vendor of [
    { extension: false, ready: false },
    { extension: true, ready: false },
    { extension: true, ready: true },
  ]) {
    f.setFacts({ ...facts(), codex: { ...facts().codex, chrome: vendor } });
    f.backend.o.pluginEnv = () => ({ backends: ['extension'], flavor: null, version: null });
    f.health.channels.codex = false;
    f.health.yourChrome = healthOf({ yourChrome: true }).yourChrome;
    assert.equal(f.availability.codexSurfaces().chrome, true);
    assert.equal(row(f.availability.status(), 'codex').chrome.label, "MoPilot's extension");
  }
  for (const [options, code] of [
    [{ connected: false, paired: false }, 'chrome.pair'],
    [{ connected: false }, 'chrome.connect'],
    [{ connected: false, installed: 'missing' }, 'chrome.install'],
    [{ connected: false, installed: 'off' }, 'chrome.extensionOff'],
  ] as const) {
    f.health.chromeRelay = ownHealth(options);
    assert.equal(f.availability.codexSurfaces().chrome, true);
    assert.equal(row(f.availability.status(), 'codex').chrome.reasonCode, code);
  }
  delete f.health.chromeRelay;
  assert.equal(row(f.availability.status(), 'codex').chrome.state, 'unknown');
});

test('CM-Z35: missing runtime, missing plugin browser/backends, absent host and restart report the selected route accurately', () => {
  const f = fixture();
  for (const config of [{ runtime: false }, { surfaces: ['computer'] }, { backends: ['iab'] }]) {
    f.setFacts(facts(config));
    assert.equal(f.availability.codexSurfaces().chrome, false);
    const prospective = planInputs({
      tools: () => [],
      yourChrome: () => false,
      codex: {
        loadedPath: () => null,
        nativeSurfaces: () => f.availability.codexSurfaces(),
        iabAvailable: () => false,
        chromeBackend: () => f.backend,
        channel: () => true,
      },
    });
    assert.equal(prospective({ kind: 'codex', id: null }, 'chat').ownChrome, false);
    const chrome = row(f.availability.status(), 'codex').chrome;
    assert.equal(chrome.state, 'unavailable');
    assert.doesNotMatch(JSON.stringify(chrome), /ChatGPT|OpenAI/);
  }
  f.setFacts(facts({ backends: ['chrome'] }));
  f.service.chromeRelay = null;
  assert.equal(f.availability.codexSurfaces().chrome, false);
  assert.equal(row(f.availability.status(), 'codex').chrome.reasonCode, 'codex.chromeBackend');
  f.health.chromeRelay = ownHealth({ running: false });
  assert.equal(row(f.availability.status(), 'codex').chrome.reasonCode, 'chrome.restart');
  f.health.chromeRelay.fix = { kind: 'settings', label: 'Browser settings', section: 'browser' };
  assert.equal(row(f.availability.status(), 'codex').chrome.actions[0].kind, 'settings');
  f.health.yourChrome = healthOf({ yourChrome: true }).yourChrome;
  assert.equal(row(f.availability.status(), 'codex').chrome.label, 'Fallback (Your Chrome)');
  f.over['native.codex.enabled'] = false;
  assert.equal(f.availability.codexSurfaces().chrome, false);
});

test('CM-Z35: vendor selection still requires its own extension; tools/default selection is unchanged and never blames the vendor', () => {
  const f = fixture();
  f.over['codex.browser.chromeExtension'] = false;
  assert.equal(f.backend.available(), false);
  assert.equal(f.availability.codexSurfaces().chrome, false);
  assert.match(row(f.availability.status(), 'codex').chrome.detail, /ChatGPT for Chrome/);
  f.setFacts(facts());
  assert.equal(f.availability.codexSurfaces().chrome, true);
  assert.equal(row(f.availability.status(), 'codex').chrome.label, 'Native (OpenAI extension)');
  f.setFacts({ ...facts(), codex: { ...facts().codex, chrome: { extension: true, ready: false } } });
  assert.match(row(f.availability.status(), 'codex').chrome.detail, /turned off in Chrome/);
  f.over['codex.browser.chromeExtension'] = true;
  f.over['shared.browser.chromeExtensionByDefault'] = true;
  assert.equal(f.backend.available(), false);
  assert.equal(row(f.availability.status(), 'codex').chrome.label, "MoPilot's extension");
  f.setFacts(facts({ runtime: false }));
  assert.equal(row(f.availability.status(), 'codex').chrome.label, "MoPilot's extension");
  const defaults = (key: string) => DEFAULTS[key] ?? false;
  assert.equal(codexChromeRoute(servedChrome(defaults, { shipped: true })), 'tools');
  assert.equal(codexChromeRoute(servedChrome(defaults, { shipped: false })), 'vendor');
  assert.equal(
    codexChromeOff({
      isEnabled: defaults,
      shipped: true,
      server: () => ({ command: '/node', env: { BROWSER_USE_AVAILABLE_BACKENDS: 'chrome,iab' } }),
    }).env.BROWSER_USE_AVAILABLE_BACKENDS,
    'iab',
  );
});

test('CM-Z35: socket failure or current route revocation never turns a loaded own backend into vendor Chrome', async (t) => {
  for (const hasTools of [true, false]) {
    const f = fixture();
    t.after(() => f.backend.exited());
    const inj = f.injection(hasTools);
    start(inj);
    f.waits[0].fail();
    await settle();
    assert.equal(f.backend.serves('thread'), false);
    assert.equal(inj.loadedPath('thread').chrome, false);
    assert.match(inj.turnContext('thread').context.value, /reload/i);
    assert.doesNotMatch(
      inj.turnContext('thread').context.value,
      /ChatGPT extension|install ChatGPT|Browser plugin's Chrome backend is the ChatGPT/,
    );
    inj.observe({ method: 'thread/closed', params: { threadId: 'thread' } });
    const loadedWith = start(inj, 'thread', 'thread/resume', 2);
    f.waits[1].finish();
    await settle();
    assert.equal(inj.loadedPath('thread').chrome, true);
    const entry = f.backend.servers.get('thread');
    f.over['codex.browser.chromeExtension'] = false;
    f.setFacts(facts());
    assert.equal(f.backend.has('thread'), true, 'load identity persists; permission to use it does not');
    assert.equal(f.backend.serves('thread'), false);
    assert.equal(entry.backend.enabled(), false, 'commands still read the current route gate');
    await assert.rejects(entry.backend.handle('getInfo', { session_id: 'thread' }), /turned off/);
    assert.equal(inj.loadedPath('thread').chrome, false);
    assert.match(inj.turnContext('thread').context.value, /reload/i);
    assert.doesNotMatch(inj.turnContext('thread').context.value, /install ChatGPT|Selecting Chrome in the Browser plugin/);
    // a resume while loaded carries the config the thread loaded with, never one for the new route (#2500)
    const again = inj.outgoing({ id: 3, method: 'thread/resume', params: { threadId: 'thread' } });
    assert.deepEqual(again.params.config, loadedWith.params.config, 'already loaded threads never rewrite their config');
  }
});

test('CM-Z35: load-time provenance survives both directions of a route switch until unload/resume', async (t) => {
  for (const initiallyOwn of [false, true]) {
    const f = fixture();
    t.after(() => f.backend.exited());
    f.setFacts(facts({ chrome: false, backends: ['chrome'] }));
    f.over['codex.browser.chromeExtension'] = initiallyOwn;
    if (initiallyOwn) f.service.chromeRelay = null;
    const inj = f.injection();
    start(inj);
    assert.equal(inj.loadedPath('thread').chrome, false);
    f.over['codex.browser.chromeExtension'] = !initiallyOwn;
    f.service.chromeRelay = { tabs: {} };
    f.setFacts(facts({ backends: ['chrome'] }));
    assert.equal(inj.loadedPath('thread').chrome, false);
    const note = inj.turnContext('thread').context.value;
    assert.match(note, /reloaded to apply the selected Chrome route/);
    assert.doesNotMatch(note, /install ChatGPT|ChatGPT extension/);
    inj.observe({ method: 'thread/closed', params: { threadId: 'thread' } });
    start(inj, 'thread', 'thread/resume', 2);
    if (!initiallyOwn) {
      f.waits.at(-1)!.finish();
      await settle();
    }
    assert.equal(inj.loadedPath('thread').chrome, true, 'reload adopts the current selected route');
  }
});

test('CM-Z35: toolsOf exposes only the loaded session filtered inventory, never future intent', () => {
  const inj = new CodexToolInjection({
    sessions: new ToolSessions(),
    command: '/unused/sage-mcp',
    socketPath: '/unused/socket',
    harnessPid: () => 1,
    nativeEnabled: () => true,
    nativeSurfaces: () => ({ chrome: true, computer: true }),
    nativeHideFor: () => (name: string) => name.startsWith('chrome_'),
    visibleTools: () => ['browser_navigate', 'chrome_navigate'],
  });
  assert.equal(inj.toolsOf('thread'), null);
  start(inj);
  assert.deepEqual(inj.toolsOf('thread'), ['browser_navigate']);
  inj.observe({ method: 'thread/closed', params: { threadId: 'thread' } });
  assert.equal(inj.toolsOf('thread'), null);
  const noMcp = fixture();
  noMcp.service.chromeRelay = null;
  noMcp.setFacts(facts());
  const bare = noMcp.injection(false);
  start(bare);
  assert.deepEqual(bare.toolsOf('thread'), []);
});

test('CM-Z35: a route/service appearing while start is pending cannot alter the accepted load snapshot', async (t) => {
  for (const initiallyOwn of [false, true]) {
    const f = fixture();
    t.after(() => f.backend.exited());
    f.setFacts(facts({ chrome: true, backends: ['chrome'] }));
    f.over['codex.browser.chromeExtension'] = initiallyOwn;
    if (initiallyOwn) f.service.chromeRelay = null;
    const inj = f.injection();
    inj.outgoing({ id: 1, method: 'thread/start', params: {} });
    f.over['codex.browser.chromeExtension'] = true;
    f.service.chromeRelay = { tabs: {} };
    inj.observe({ id: 1, result: { thread: { id: 'thread' } } });
    await settle();
    assert.equal(f.backend.has('thread'), false);
    assert.equal(f.waits.length, 0, 'the unselected backend never starts');
    assert.equal(inj.loadedPath('thread').chrome, !initiallyOwn);
  }
});

test('CM-Z35: settled backend refreshes only its still-current load, never an unloaded or replacement generation', async (t) => {
  const f = fixture();
  t.after(() => f.backend.exited());
  const changes: string[] = [];
  const inj = f.injection(true, (id) => changes.push(id));
  start(inj);
  assert.deepEqual(changes, ['thread']);
  inj.observe({ method: 'thread/closed', params: { threadId: 'thread' } });
  start(inj, 'thread', 'thread/resume', 2);
  assert.deepEqual(changes, ['thread', 'thread']);
  f.waits[0].finish();
  await settle();
  assert.deepEqual(changes, ['thread', 'thread'], 'retired success cannot refresh its replacement');
  assert.equal(inj.loadedPath('thread').chrome, false);
  f.waits[1].finish();
  await settle();
  assert.deepEqual(changes, ['thread', 'thread', 'thread']);
  assert.equal(inj.loadedPath('thread').chrome, true);
  inj.observe({ method: 'thread/closed', params: { threadId: 'thread' } });
  start(inj, 'thread', 'thread/resume', 3);
  inj.observe({ method: 'thread/closed', params: { threadId: 'thread' } });
  f.waits[2].fail();
  await settle();
  assert.equal(changes.length, 4, 'retired rejection cannot refresh a disposed load');
  assert.equal(inj.loadedPath('thread'), null);
});

test('CM-Z35: a pending note is corrected after completion, with or without the MCP channel', async (t) => {
  for (const hasTools of [false, true]) {
    const f = fixture();
    t.after(() => f.backend.exited());
    const inj = f.injection(hasTools);
    start(inj);
    assert.equal(f.backend.loading('thread'), true);
    const pending = inj.turnContext('thread');
    assert.match(pending.context.value, /still starting/);
    assert.doesNotMatch(pending.context.value, /could not load|must be reloaded/);
    inj.contextForwarded('thread', pending.key, inj.contextReceipt('thread'));
    assert.equal(inj.turnContext('thread'), null);
    f.waits[0].finish();
    await settle();
    assert.equal(f.backend.loading('thread'), false);
    assert.match(inj.turnContext('thread').context.value, /MoPilot Chrome/);
    assert.doesNotMatch(inj.turnContext('thread').context.value, /still starting|must be reloaded/);
  }
});

test('CM-Z35: an independent IAB failure cannot suppress settled own-Chrome publication', async (t) => {
  for (const sync of [false, true]) {
    const f = fixture();
    t.after(() => f.backend.exited());
    let published = 0;
    const inj = f.injection(true, () => published++);
    inj.browserBackends = combineBackends(
      {
        available: () => false,
        has: () => false,
        unloaded: () => {},
        exited: () => {},
        loaded: () => {
          if (sync) throw Error('IAB mkdir denied');
          return Promise.reject(Error('IAB mkdir denied'));
        },
      },
      f.backend,
    );
    start(inj);
    await settle();
    assert.equal(published, 1, 'one failed backend cannot settle another still starting');
    f.waits[0].finish();
    await settle();
    assert.equal(published, 2);
    assert.equal(inj.loadedPath('thread').chrome, true);
    assert.match(inj.turnContext('thread').context.value, /MoPilot Chrome/);
  }
});

test('CM-Z35: incomplete own-channel health stays unknown and revoked pending startup is not reported as progress', async (t) => {
  const f = fixture();
  t.after(() => f.backend.exited());
  const unknown = row(
    availabilityStatus(
      facts(),
      live({
        chromeServed: { tools: false, codex: true, kind: null },
        codexChromeBackend: true,
      }),
    ),
    'codex',
  ).chrome;
  assert.equal(unknown.state, 'unknown');
  assert.equal(unknown.label, "MoPilot's Chrome backend");
  f.health.chromeRelay = { ...ownHealth(), usable: false, reason: null };
  f.service.chromeRelay = null;
  assert.equal(row(f.availability.status(), 'codex').chrome.reasonCode, 'codex.chromeBackend');
  f.service.chromeRelay = { tabs: {} };

  const inj = f.injection();
  start(inj);
  f.over['native.codex.enabled'] = false;
  assert.equal(f.backend.loading('thread'), false);
  assert.doesNotMatch(inj.turnContext('thread').context.value, /still starting/);
  f.waits[0].finish();
  await settle();
  assert.equal(f.backend.serves('thread'), false);
});

test('CM-Z35: a failing optional backend note cannot fabricate a vendor route or break thread traffic', async (t) => {
  const f = fixture();
  t.after(() => f.backend.exited());
  const inj = f.injection();
  start(inj);
  f.waits[0].finish();
  await settle();
  inj.chromeNote = () => {
    throw Error('note unavailable');
  };
  assert.equal(inj.loadedPath('thread').chrome, false);
  assert.match(inj.turnContext('thread').context.value, /could not load|must be reloaded/);
  assert.doesNotMatch(inj.turnContext('thread').context.value, /Selecting Chrome in the Browser plugin|install.*ChatGPT/);
});

test('CM-Z35: unloaded and managed threads expose only their own active inventory', () => {
  const f = fixture();
  const inj = f.injection();
  assert.equal(inj.turnContext('not-loaded'), null);
  f.over['native.codex.enabled'] = false;
  start(inj);
  assert.deepEqual(inj.loadedPath('thread'), { chrome: false, computer: false, iab: false, tools: true });
  assert.deepEqual(inj.toolsOf('thread'), ['browser_navigate']);
  assert.match(inj.turnContext('thread').context.value, /browser_\*/);
});
