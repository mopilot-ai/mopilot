// The control matrix (docs/control-plane/matrix.md), stream Z: what Settings and the Claude in Chrome note offer for the
// user's Chrome where MoPilot's own channel serves it (CM-Z34, #1631). A status row of a session served by the
// chrome_* tools shows that channel's pairing and connection, never "Use Your Chrome": choosing Your Chrome hides the
// chrome_* tools, and without the Playwright Extension the session (and Codex after a switch) had no Chrome left.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { facts, live, row, availabilityStatus, NativeAvailability } from './support/native-availability/fixture.ts';
import { healthOf } from './support/control-matrix-kit.ts';
import './support/dom.ts';

export const GUARDS = ['electron/', 'shared/', 'src/'];

const require = createRequire(import.meta.url);
const { DEFAULTS } = require('../electron/platform/flags.cjs');
const { servedChrome } = require('../electron/capabilities/browser/chromeControl.cjs');
const { chromeRelayHealth } = require('../electron/capabilities/capabilityHealth.cjs');
const { chromeRouteOf } = await import('../src/session/nativeAvailability.ts');

const flags =
  (over: Record<string, boolean> = {}) =>
  (k: string) =>
    over[k] ?? DEFAULTS[k] ?? false;

/** The defaults where the build ships MoPilot's extension: every session without a Chrome controller is served. */
const SERVED = { tools: true, codex: true, takeover: false, kind: 'extension' };
/** MoPilot's own extension: paired and connected unless given. */
const own = (o: Record<string, unknown> = {}) => ({
  ...chromeRelayHealth({ enabled: true, running: true, kind: 'extension', paired: true, connected: true, ...o }),
  channel: 'extension',
});
/** The relay over the Playwright Extension, as the health record names its channel. */
const relayOf = (o: Record<string, unknown>) => ({
  ...chromeRelayHealth({ enabled: true, running: true, kind: 'relay', ...o }),
  channel: 'relay',
});
/** The status with Claude in Chrome off, a managed Codex thread, and Your Chrome not chosen (#1631's VM run). */
const status = ({ relay = own(), served = SERVED, channels, yourChrome = false, ...o }: any = {}) =>
  availabilityStatus(
    facts(),
    live({
      codexNative: false,
      claudeFlag: false,
      claudeEligible: false,
      health: { ...healthOf({ yourChrome, channels }), chromeRelay: relay },
      chromeServed: served,
      ...o,
    }),
  );
const chromeRows = (s: any) => s.harnesses.map((h: any) => [h.harness, h.chrome.state, h.chrome.label, h.chrome.actions]);
const offersYourChrome = (s: any) => s.harnesses.some((h: any) => h.chrome.actions.some((a: any) => a.kind === 'yourChrome'));

test("CM-Z34: servedChrome says which sessions MoPilot serves the user's Chrome to, as main starts its channel", () => {
  assert.deepEqual(servedChrome(flags({ 'native.codex.enabled': false }), { shipped: true }), SERVED);
  // native Codex on: the chrome_* tools take the Browser plugin's Chrome's place (G28, codexChromeOff)
  assert.deepEqual(servedChrome(flags({ 'native.codex.enabled': true }), { shipped: true }), { ...SERVED, takeover: true });
  // a build without the extension: none, unless a switch for every harness is on
  assert.deepEqual(servedChrome(flags(), { shipped: false }), { tools: false, codex: false, takeover: false, kind: null });
  assert.deepEqual(servedChrome(flags({ 'shared.browser.chromeRelay': true, 'native.codex.enabled': false }), {}), {
    tools: true,
    codex: true,
    takeover: false,
    kind: 'relay',
  });
  // the chrome_* default off: native Codex threads keep MoPilot's backend, every other session has none
  const codexOnly = flags({ 'shared.browser.chromeExtensionByDefault': false, 'native.codex.enabled': true });
  assert.deepEqual(servedChrome(codexOnly, { shipped: true }), { tools: false, codex: true, takeover: false, kind: 'extension' });
});

test("CM-Z34: with Claude in Chrome off, every row served by MoPilot's extension shows it, and none offers Your Chrome", () => {
  const s = status();
  assert.deepEqual(chromeRows(s), [
    ['codex', 'fallback', "Fallback (MoPilot's extension)", []],
    ['claude', 'fallback', "Fallback (MoPilot's extension)", []],
    ['acp', 'mopilot', "MoPilot's extension", []],
  ]);
  assert.equal(row(s, 'claude').chrome.reasonCode, 'native.off');
  assert.equal(row(s, 'claude').chrome.detail, 'Claude in Chrome is turned off.');
  assert.equal(s.chromeTools, true);
});

test("CM-Z34: MoPilot's extension not paired, not connected, or needing a restart says so on its row, still without Your Chrome", () => {
  const pair = status({ relay: own({ paired: false, connected: false }) });
  assert.deepEqual(row(pair, 'acp').chrome, {
    state: 'permissions',
    label: 'Needs setup',
    detail: "MoPilot's Chrome extension isn't paired yet: the first browser step opens its pairing page in Chrome.",
    reasonCode: 'chrome.pair',
    actions: [],
  });
  assert.equal(row(pair, 'claude').chrome.detail.startsWith('Claude in Chrome is turned off. '), true);
  const away = status({ relay: own({ connected: false }) });
  assert.deepEqual(
    [row(away, 'acp').chrome.state, row(away, 'acp').chrome.label, row(away, 'acp').chrome.reasonCode],
    ['unknown', "MoPilot's extension", 'chrome.connect'],
  );
  assert.equal(row(away, 'claude').chrome.label, "Fallback (MoPilot's extension)");
  const restart = status({ relay: own({ running: false }) });
  assert.deepEqual([row(restart, 'acp').chrome.state, row(restart, 'acp').chrome.reasonCode], ['unavailable', 'chrome.restart']);
  for (const s of [pair, away, restart]) assert.equal(offersYourChrome(s), false);
  // a channel that can't serve yet (switched on after startup) isn't named to the note or Preferred browser
  assert.deepEqual([pair.chromeTools, away.chromeTools, restart.chromeTools], [true, true, false]);
});

test('CM-Z34: a row whose harness gets no MoPilot tools says so, and the relay is named as the relay', () => {
  const off = status({ channels: { claude: false } });
  assert.deepEqual([row(off, 'claude').chrome.state, row(off, 'claude').chrome.reasonCode], ['unavailable', 'tools.off']);
  const relay = status({
    relay: relayOf({ extension: '0.0.83' }),
    served: { tools: true, codex: true, kind: 'relay' },
  });
  assert.equal(row(relay, 'acp').chrome.label, "MoPilot's Chrome relay");
  // the relay without the Playwright Extension: its own fix, the extension's page
  const missing = status({
    relay: relayOf({ extension: null, extensionUrl: 'https://x' }),
    served: { tools: true, codex: true, kind: 'relay' },
  });
  assert.deepEqual(row(missing, 'acp').chrome.actions, [{ kind: 'url', label: 'Get the extension', url: 'https://x' }]);
});

test("CM-Z34: MoPilot's extension not installed: each harness's row says so, and only the extension's own row carries the install link", () => {
  const s = status({ relay: own({ connected: false, installed: 'missing', installUrl: 'https://store/x' }) });
  assert.deepEqual(
    [row(s, 'acp').chrome.state, row(s, 'acp').chrome.reasonCode, row(s, 'acp').chrome.actions],
    ['permissions', 'chrome.install', []],
  );
  assert.deepEqual(s.extension.actions, [{ kind: 'chromeInstall', label: 'Add to Chrome' }]);
  assert.equal(offersYourChrome(s), false);
});

test('CM-Z34: Your Chrome chosen is the route its rows show; only where nothing serves a session is Your Chrome offered', () => {
  // the user chose Your Chrome (it hides the chrome_* tools): its rows, as before
  const chosen = status({ yourChrome: true });
  assert.deepEqual(row(chosen, 'acp').chrome.label, 'Your Chrome');
  // a build without MoPilot's extension: the way to Your Chrome, and no chrome_* for the note to name
  const none = status({ served: { tools: false, codex: false, kind: null } });
  assert.deepEqual(row(none, 'acp').chrome.actions, [{ kind: 'yourChrome', label: 'Use Your Chrome' }]);
  assert.equal(none.chromeTools, false);
  // served, but main has no record of the channel (no facts given): the way to Your Chrome stays
  assert.equal(offersYourChrome(status({ relay: null })), true);
  // main without chromeServed (an older caller): nothing is served
  assert.equal(availabilityStatus(facts(), live({ codexNative: false })).chromeTools, false);
});

test('CM-Z34: a native Codex thread without the ChatGPT extension shows the channel MoPilot serves it, else Your Chrome', () => {
  const nativeFacts = facts({ chrome: false });
  const at = (served: any) =>
    row(
      availabilityStatus(
        nativeFacts,
        live({ health: { ...healthOf(), chromeRelay: own() }, chromeServed: served, codexChromeBackend: true }),
      ),
      'codex',
    ).chrome;
  assert.equal(at({ tools: false, codex: true, kind: 'extension' }).label, "MoPilot's extension");
  assert.deepEqual(
    at({ tools: false, codex: false, kind: null }).actions.map((a: any) => a.kind),
    ['url', 'yourChrome'],
  );
});

test("CM-Z34: where the chrome_* tools replace the Browser plugin's Chrome in a native Codex thread, its row is that channel", () => {
  const s = availabilityStatus(
    facts(),
    live({ health: { ...healthOf(), chromeRelay: own() }, chromeServed: { ...SERVED, takeover: true } }),
  );
  assert.deepEqual(
    [row(s, 'codex').chrome.state, row(s, 'codex').chrome.label, row(s, 'codex').chrome.actions],
    ['mopilot', "MoPilot's extension", []],
  );
  // the vendor's Chrome kept for Codex (no takeover): the ChatGPT extension's native row, as before
  assert.equal(row(status({ codexNative: true, served: SERVED }), 'codex').chrome.label, 'Native (OpenAI extension)');
});

test('CM-Z34: chromeRouteOf names what reaches Chrome for Claude: Your Chrome as the channel, a usable own row, else nothing', () => {
  const claude = (state: string) => ({ harness: 'claude', label: 'Claude Code', chrome: { state }, computer: { state: 'mopilot' } });
  const at = (chromeTools: boolean, state: string | null) =>
    ({ platform: 'darwin', at: 1, chromeTools, harnesses: state ? [claude(state)] : [] }) as any;
  assert.equal(chromeRouteOf(at(true, 'fallback'), 'builtin'), 'own');
  assert.equal(chromeRouteOf(at(true, 'permissions'), 'builtin'), 'own');
  // Claude's tools off, or the channel can't work: the row is unavailable, and the note says nothing serves Claude
  assert.equal(chromeRouteOf(at(true, 'unavailable'), 'builtin'), 'none');
  assert.equal(chromeRouteOf(at(false, 'fallback'), 'builtin'), 'none');
  assert.equal(chromeRouteOf(at(true, null), 'builtin'), 'none');
  assert.equal(chromeRouteOf(null, 'builtin'), 'none');
  assert.equal(chromeRouteOf(at(true, 'fallback'), 'chrome'), 'yourChrome');
});

test("CM-Z34: NativeAvailability's status hands main's chromeServed to the rows", () => {
  const n = new NativeAvailability({
    probe: () => facts(),
    live: () => ({
      codexNative: false,
      claudeFlag: false,
      claudeEligible: () => false,
      health: { ...healthOf(), chromeRelay: own() },
      chromeServed: SERVED,
    }),
  });
  const s = n.status();
  assert.equal(s.chromeTools, true);
  assert.equal(row(s, 'claude').chrome.label, "Fallback (MoPilot's extension)");
});

/**
 * Every place that can switch the browser channel to Your Chrome, and why each never takes away a route that works
 * (#1631: the note's Set up did, unconditionally). A new one is added here only with its reason.
 */
const YOUR_CHROME_SWITCHES: Record<string, string> = {
  // the user's explicit choice under Preferred browser (Browser.tsx goes through `apply`, with no literal), and its desc
  // says when Your Chrome takes the place of MoPilot's extension
  'src/components/browser/ClaudeInChromeNote.tsx': "only on the 'none' route: no chrome_* tools serve Claude (main's chromeTools)",
  'src/components/pages/settings/NativeControlStatus.tsx':
    "the row's Use Your Chrome action, which status.cjs offers only where MoPilot's channel serves no session",
  'src/session/handoffResult.ts':
    "a finished hand-off on the 'your-chrome' route, which handoff.cjs picks only while the chrome_* tools are off",
  'electron/capabilities/browser/handoff.cjs':
    'the same hand-off in main, said with a toast when it changes the saved Preferred browser (#1523)',
};

test('CM-Z34: every switch of the browser channel to Your Chrome is one this inventory names, with its reason', () => {
  const out = execFileSync('git', ['grep', '-l', '-E', "(browserChannel|channel): '(chrome)'", '--', 'src', 'electron', 'shared'], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
  });
  assert.deepEqual(out.trim().split('\n').sort(), Object.keys(YOUR_CHROME_SWITCHES).sort());
});
