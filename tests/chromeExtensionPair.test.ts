// Settings → Browser's MoPilot extension row (#1632): Pair opening the pairing page from main, the health record's install and turned-off states, and the row each state shows.
import { test, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { until } from './support/chrome-relay-kit.ts';
import { memoryPairing, extensionWorld } from './support/chrome-extension-kit.ts';

const require = createRequire(import.meta.url);
const { ChromeExtensionChannel } = require('../electron/capabilities/browser/chromeExtension.cjs');
const { chromeRelayHealth, CapabilityHealth } = require('../electron/capabilities/capabilityHealth.cjs');
const { extensionStatus, availabilityStatus } = require('../electron/capabilities/nativeAvailability/status.cjs');
const appRelay = require('../electron/app/chromeRelay.cjs');
const { CAPABILITY_REASONS } = await import('../shared/capabilityReasons.mjs');

const STORE = 'abcdefghijklmnopabcdefghijklmnop';
const stops: (() => void)[] = [];
after(() => stops.forEach((s) => s()));

function channel(o: any = {}) {
  const opened: string[] = [];
  const ch = new ChromeExtensionChannel({
    pairing: memoryPairing(),
    openPage: async (url: string) => opened.push(url),
    connectMs: 200,
    commandMs: 200,
    openMs: 200,
    authMs: 200,
    port: 0,
    ...o,
  });
  stops.push(() => ch.stop());
  return { ch, opened };
}

test('Pair opens the pairing page now, with a new claim code each time, never the secret', async () => {
  const { ch, opened } = channel({ pageId: () => STORE });
  assert.equal(await ch.pair(), 'opened');
  assert.equal(await ch.pair(), 'opened');
  assert.equal(opened.length, 2);
  assert.ok(opened[0].startsWith(`chrome-extension://${STORE}/options.html#pair=mopilot-claim`));
  assert.notEqual(opened[0], opened[1]);
  assert.ok(!opened[0].includes(ch.x.pairing.get().secret));
});

test('Pair answers instead of opening a page that would not work: missing or turned off in the profile, unreadable pairing', async () => {
  for (const state of ['missing', 'off'] as const) {
    const { ch, opened } = channel({ installed: () => state });
    assert.equal(await ch.pair(), state);
    assert.deepEqual(opened, []);
  }
  const pairing = memoryPairing();
  const { ch, opened } = channel({ pairing });
  await ch.start();
  pairing.set(null);
  assert.equal(await ch.pair(), 'unreadable');
  assert.deepEqual(opened, []);
  // a page that can't be opened, or a channel that can't serve, rejects: Settings shows the failure
  const broken = channel({ openPage: async () => Promise.reject(new Error('no Chrome')) });
  await assert.rejects(broken.ch.pair(), /no Chrome/);
  const noDisk = memoryPairing();
  noDisk.forPort = () => {
    throw new Error('no disk');
  };
  await assert.rejects(channel({ pairing: noDisk }).ch.pair(), /no disk/);
});

test('Pair while connected opens nothing; the page Pair opened pairs a chat that starts waiting meanwhile, without a second page', async () => {
  const connected = await extensionWorld();
  stops.push(connected.stop);
  assert.equal(await connected.channel.pair(), 'connected');
  assert.deepEqual(connected.opened, []);
  const w = await extensionWorld({ paired: false, connectMs: 3000 });
  stops.push(w.stop);
  assert.equal(await w.channel.pair(), 'opened');
  const linking = w.channel.connect('c');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(w.opened.length, 1, 'the wait uses the page the user opened');
  const code = await w.pressPair(w.opened[0]);
  assert.equal(code, `mopilot-chrome:1:${w.port}:${w.pairing.get().secret}`);
  await w.connectExtension();
  assert.equal((await linking).open, true);
});

test('a chat’s wait opens its own page once the claim from Pair has expired, and Pair replaces a wait’s claim', async (t) => {
  const { ch, opened } = channel({ connectMs: 50 });
  assert.equal(await ch.pair(), 'opened');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 121_000);
  await assert.rejects(ch.connect('c'), (e: any) => e?.code === 'not_connected');
  await until(() => opened.length === 2);
  t.mock.restoreAll();
  // a wait's page is replaced by the user's: the newest claim is the one that works
  const w = await extensionWorld({ paired: false, connectMs: 3000 });
  stops.push(w.stop);
  const linking = w.channel.connect('c');
  await until(() => w.opened.length === 1);
  assert.equal(await w.channel.pair(), 'opened');
  assert.equal(await w.pressPair(w.opened[0]), null, 'the wait’s older code no longer pairs');
  assert.ok(await w.pressPair(w.opened[1]));
  await w.connectExtension();
  assert.equal((await linking).open, true);
});

test('the app’s Pair reaches the extension channel, and answers unavailable where main serves the relay or nothing', async () => {
  assert.equal(await appRelay.pairChromeExtension(null), 'unavailable');
  assert.equal(await appRelay.pairChromeExtension({ kind: 'relay', relay: {} }), 'unavailable');
  const pair = mock.fn(async () => 'opened');
  assert.equal(await appRelay.pairChromeExtension({ kind: 'extension', relay: { pair } }), 'opened');
  assert.equal(pair.mock.callCount(), 1);
});

test('Add to Chrome: the store page in Chrome; another browser only when Chrome can’t open; nothing without a store id', async () => {
  const opened: any[] = [];
  const external = mock.fn(async () => undefined);
  const open = mock.fn(async (url: string, o: any) => opened.push([url, o]));
  assert.equal(await appRelay.openChromeStore({ storeId: STORE, profileDir: 'Profile 2', open, external }), 'chrome');
  assert.deepEqual(opened, [[`https://chromewebstore.google.com/detail/${STORE}`, { profileDir: 'Profile 2' }]]);
  const broken = async () => Promise.reject(new Error('no Chrome'));
  assert.equal(await appRelay.openChromeStore({ storeId: STORE, open: broken, external }), 'browser');
  assert.deepEqual(external.mock.calls[0].arguments, [`https://chromewebstore.google.com/detail/${STORE}`]);
  assert.equal(await appRelay.openChromeStore({ storeId: null, open, external }), 'unavailable');
  assert.equal(typeof appRelay.openChromeStore, 'function');
});

test('the app’s Allow reaches the extension channel’s question, and answers false where main serves the relay or nothing', () => {
  assert.equal(appRelay.answerChromeAsk(null, true), false);
  assert.equal(appRelay.answerChromeAsk({ kind: 'relay', relay: {} }, true), false);
  const answerAsk = mock.fn((allow: boolean) => allow);
  assert.equal(appRelay.answerChromeAsk({ kind: 'extension', relay: { answerAsk } }, true), true);
  // only a real true allows: anything else from the renderer is Not now
  assert.equal(appRelay.answerChromeAsk({ kind: 'extension', relay: { answerAsk } }, 'yes'), false);
  assert.deepEqual(
    answerAsk.mock.calls.map((c) => c.arguments[0]),
    [true, false],
  );
});

test('health: connected wins; then the profile’s missing or turned-off extension; then pairing; the install link only with a store page', () => {
  const base = { enabled: true, running: true, kind: 'extension' as const };
  assert.equal(chromeRelayHealth({ ...base, connected: true, installed: 'missing' }).state, 'ready');
  const url = `https://chromewebstore.google.com/detail/${STORE}`;
  assert.deepEqual(chromeRelayHealth({ ...base, installed: 'missing', installUrl: url, paired: true }), {
    state: 'permission',
    usable: true,
    reasonCode: 'chrome.install',
    reason: "MoPilot's Chrome extension isn't installed in the Chrome profile MoPilot uses.",
    fix: { kind: 'chromeInstall', label: 'Add to Chrome' },
  });
  assert.equal(chromeRelayHealth({ ...base, installed: 'missing' }).fix, null);
  assert.equal(chromeRelayHealth({ ...base, installed: 'off', installUrl: url }).reasonCode, 'chrome.extensionOff');
  assert.equal(chromeRelayHealth({ ...base, installed: 'on' }).reasonCode, 'chrome.pair');
  assert.equal(chromeRelayHealth({ ...base, installed: null, paired: true }).reasonCode, 'chrome.connect');
  for (const code of ['chrome.install', 'chrome.extensionOff']) assert.ok(CAPABILITY_REASONS[code], code);
});

test('the record names the channel; the extension row shows only for MoPilot’s own extension', () => {
  const base = { isEnabled: () => true, helper: () => null, yourChrome: () => ({ chosen: false, active: false, extension: null }) };
  const own = new CapabilityHealth({ ...base, chromeRelay: () => ({ enabled: true, running: true, kind: 'extension', connected: true }) });
  assert.equal(own.snapshot().chromeRelay.channel, 'extension');
  const relay = new CapabilityHealth({ ...base, chromeRelay: () => ({ enabled: true, running: true, extension: '0.4.0' }) });
  assert.equal(relay.snapshot().chromeRelay.channel, 'relay');
  assert.equal(extensionStatus(undefined), null);
  assert.equal(extensionStatus(relay.snapshot().chromeRelay), null);
  assert.deepEqual(extensionStatus(own.snapshot().chromeRelay), {
    state: 'mopilot',
    label: 'Connected',
    detail: null,
    reasonCode: undefined,
    actions: [],
  });
  const facts = {
    platform: 'darwin',
    codex: { runtime: { present: false }, sky: { present: false }, chrome: { ready: false } },
    claude: {},
  };
  const health = { ...own.snapshot(), channels: { claude: true, codex: true, acp: true } };
  assert.equal(
    availabilityStatus(facts, { codexNative: false, claudeFlag: false, claudeEligible: false, health }).extension.label,
    'Connected',
  );
});

test('the extension row by state: Add to Chrome, turn it on, Connect while not paired or away, and why it is off', () => {
  const url = `https://chromewebstore.google.com/detail/${STORE}`;
  const row = (f: any) =>
    extensionStatus({ ...chromeRelayHealth({ enabled: true, running: true, kind: 'extension', ...f }), channel: 'extension' });
  const install = row({ installed: 'missing', installUrl: url });
  assert.deepEqual(
    [install.state, install.label, install.actions],
    ['permissions', 'Not installed', [{ kind: 'chromeInstall', label: 'Add to Chrome' }]],
  );
  assert.deepEqual([row({ installed: 'off' }).label, row({ installed: 'off' }).actions], ['Off in Chrome', []]);
  const pair = { kind: 'chromePair', label: 'Connect' };
  assert.deepEqual([row({}).state, row({}).label, row({}).actions], ['permissions', 'Not connected', [pair]]);
  assert.deepEqual(
    [row({ paired: true }).state, row({ paired: true }).label, row({ paired: true }).actions],
    ['unknown', 'Not connected', [pair]],
  );
  const off = extensionStatus({ ...chromeRelayHealth({ enabled: false, running: false, kind: 'extension' }), channel: 'extension' });
  assert.deepEqual([off.state, off.reasonCode, off.actions], ['unavailable', 'chrome.relayOff', []]);
  const restart = extensionStatus({ ...chromeRelayHealth({ enabled: true, running: false, kind: 'extension' }), channel: 'extension' });
  assert.equal(restart.reasonCode, 'chrome.restart');
});

test('the facts read the profile only while the extension isn’t connected, and give the store page as the install link', () => {
  const flags = (k: string) => k === 'shared.browser.chromeExtension';
  const inProfile = mock.fn(() => ({ id: STORE, state: 'missing' }));
  const away = { kind: 'extension', relay: { status: () => ({ paired: false, connected: false }) }, inProfile };
  const facts = (setup: any, storeId: string | null = STORE) =>
    appRelay.chromeRelayFacts({ isFlagEnabled: flags, setup, installedVersion: () => null, extensionUrl: 'u', storeId });
  const a = facts(away);
  assert.equal(a.installed, 'missing');
  assert.equal(a.installUrl, `https://chromewebstore.google.com/detail/${STORE}`);
  assert.equal(facts(away, null).installUrl, null);
  inProfile.mock.resetCalls();
  const on = facts({ ...away, relay: { status: () => ({ paired: true, connected: true }) } });
  assert.equal(on.installed, null);
  assert.equal(inProfile.mock.callCount(), 0);
  // a setup without the probe, or none at all
  assert.equal(facts({ ...away, inProfile: null }).installed, null);
  assert.equal(facts(null).installed, null);
});

test('the facts health reads: the relay’s Playwright Extension, or the extension’s pairing and connection', () => {
  const flags =
    (...keys: string[]) =>
    (k: string) =>
      keys.includes(k);
  const installedVersion = mock.fn(() => '0.0.70');
  const relay = { kind: 'relay', relay: {} };
  assert.deepEqual(
    appRelay.chromeRelayFacts({ isFlagEnabled: flags('shared.browser.chromeRelay'), setup: relay, installedVersion, extensionUrl: 'u' }),
    { enabled: true, running: true, kind: 'relay', extension: '0.0.70', extensionUrl: 'u' },
  );
  assert.deepEqual(appRelay.chromeRelayFacts({ isFlagEnabled: flags(), setup: null, installedVersion, extensionUrl: 'u' }), {
    enabled: false,
    running: false,
    kind: 'relay',
    extension: null,
    extensionUrl: 'u',
  });
  const own = { kind: 'extension', relay: { status: () => ({ paired: true, connected: false }) } };
  assert.deepEqual(
    appRelay.chromeRelayFacts({
      isFlagEnabled: flags('shared.browser.chromeExtension'),
      setup: own,
      installedVersion,
      extensionUrl: 'u',
      storeId: null,
    }),
    {
      enabled: true,
      running: true,
      kind: 'extension',
      extension: null,
      paired: true,
      connected: false,
      asking: false,
      installed: null,
      installUrl: null,
    },
  );
  // switched on after startup: not running, the extension's channel by its switch
  assert.deepEqual(
    appRelay.chromeRelayFacts({
      isFlagEnabled: flags('shared.browser.chromeExtension'),
      setup: undefined,
      installedVersion,
      extensionUrl: 'u',
      storeId: null,
    }),
    {
      enabled: true,
      running: false,
      kind: 'extension',
      extension: null,
      paired: false,
      connected: false,
      asking: false,
      installed: null,
      installUrl: null,
    },
  );
  assert.equal(installedVersion.mock.callCount(), 1, 'the profile is read only for a running relay');
});
