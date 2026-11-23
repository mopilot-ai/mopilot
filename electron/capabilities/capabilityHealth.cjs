// One capability-health record per MoPilot control surface (design D2), built from real state: Settings, the tools sessions get and the model's notes all read it.
//
// The vendor surfaces (Codex's Browser and Computer use, Claude in Chrome) are probed by nativeAvailability.cjs;
// this module holds MoPilot's own: computer use on its helper (the remote switch, the platform, the helper
// app in place, its last launch, the macOS permissions it last reported), Your Chrome (chosen, its tools loaded,
// the Playwright Extension installed), the user's Chrome for the native-shaped tools (B2: set up at startup, and the
// relay's Playwright Extension installed or MoPilot's own extension paired and connected) and the tool channel each harness gets MoPilot's tools through.
// A surface that cannot work is not `usable`: its tools are hidden from sessions (visibility.cjs), the status
// rows say why with the step that fixes it, and a native Codex thread's note never sends the model to it.

const { TRY_AGAIN } = require('../../shared/uiLabels.mjs');

const COMPUTER_FLAG = 'shared.computerUse.enabled';
/** The tool channel each harness family gets MoPilot's tools through. */
const CHANNEL_FLAGS = Object.freeze({
  claude: 'channel.claude.sdkMcp',
  codex: 'channel.codex.threadConfigMcp',
  acp: 'channel.acp.sessionMcp',
});
/** What computer use cannot work without; Input Monitoring only lets the user take over by moving the mouse. */
const REQUIRED_PERMISSIONS = Object.freeze(['accessibility', 'screenRecording']);
const PERMISSION_LABEL = Object.freeze({
  accessibility: 'Accessibility',
  screenRecording: 'Screen Recording',
  inputMonitoring: 'Input Monitoring',
});
const HELPER = 'MoPilot Computer Use';
/** What System Settings' privacy lists call the helper (scripts/build-helper.mjs HELPER_NAME). */
const LIST_NAME = 'MoPilot';

/**
 * @typedef {{ kind: 'computerPermission', label: string, permission: string }
 *   | { kind: 'computerCheck', label: string }
 *   | { kind: 'settings', label: string, section: string }
 *   | { kind: 'url', label: string, url: string } | { kind: 'chromeAllow', label: string } | { kind: 'chromeInstall', label: string }} HealthFix
 * @typedef {{ state: 'off' | 'unavailable' | 'error' | 'permission' | 'unknown' | 'ready', usable: boolean,
 *             reason: string | null, reasonCode?: import('../../shared/capabilityReasons.mjs').CapabilityReasonCode, fix: HealthFix | null }} SurfaceHealth
 *   usable: sessions are offered the surface's tools; reason: why it isn't ready, for the status and the model
 * @typedef {{ path: string | null, installed: boolean, packaged: boolean, platform: string, running: boolean,
 *             version: string | null, error: string | null }} HelperFacts
 * @typedef {Record<string, boolean> | null} Permissions
 */

/** The labels of the required permissions `permissions` reports off, in order. */
function missingPermissions(/** @type {Permissions} */ permissions) {
  return permissions ? REQUIRED_PERMISSIONS.filter((k) => permissions[k] === false) : [];
}

/**
 * MoPilot's computer use: whether it can work, and if not why and what fixes it.
 * @param {{ enabled: boolean, helper: HelperFacts, permissions: Permissions }} f
 * @returns {SurfaceHealth & { helperPath: string | null, version: string | null }}
 */
function computerHealth({ enabled, helper, permissions }) {
  const base = { helperPath: helper.path, version: helper.version };
  if (!enabled)
    return {
      ...base,
      state: 'off',
      usable: false,
      reasonCode: 'computer.off',
      reason: "MoPilot's computer use is turned off.",
      fix: null,
    };
  if (!helper.installed && helper.platform !== 'darwin')
    return {
      ...base,
      state: 'unavailable',
      usable: false,
      reasonCode: 'computer.platform',
      reason: "MoPilot's computer use needs macOS.",
      fix: null,
    };
  if (!helper.installed)
    return {
      ...base,
      state: 'unavailable',
      usable: false,
      reasonCode: helper.packaged ? 'computer.missing' : 'computer.build',
      reason: helper.packaged
        ? `${HELPER} is missing from this installation (${helper.path}); update or reinstall MoPilot.`
        : `${HELPER} isn't built in this checkout (${helper.path}); rebuild it (node scripts/build-helper.mjs).`,
      fix: null,
    };
  // a launch that failed is tried again by the next call: the tools stay, the status says it failed
  if (helper.error && !helper.running)
    return {
      ...base,
      state: 'error',
      usable: true,
      reasonCode: 'computer.start',
      reason: `${HELPER} couldn't start: ${helper.error}`,
      fix: { kind: 'computerCheck', label: TRY_AGAIN },
    };
  const missing = missingPermissions(permissions);
  if (missing.length)
    return {
      ...base,
      state: 'permission',
      usable: true,
      reasonCode: missing[0] === 'accessibility' ? 'computer.accessibility' : 'computer.screenRecording',
      reason: `${LIST_NAME} needs ${missing.map((k) => PERMISSION_LABEL[k]).join(' and ')} in System Settings → Privacy & Security.`,
      fix: { kind: 'computerPermission', label: 'Open System Settings', permission: missing[0] },
    };
  if (!permissions)
    return {
      ...base,
      state: 'unknown',
      usable: true,
      reasonCode: 'computer.unknown',
      reason: `${HELPER}'s permissions are checked when it first starts.`,
      fix: null,
    };
  return { ...base, state: 'ready', usable: true, reason: null, fix: null };
}

/**
 * Your Chrome (MoPilot's sage_browser_* over the Playwright Extension).
 * @param {{ chosen: boolean, active: boolean, extension: string | null, extensionUrl?: string | null }} f
 *   chosen: the user picked it as the browser for agents (and its switch is on); active: its tools are loaded;
 *   extension: the Playwright Extension's installed version, null when it isn't found in Chrome
 * @returns {SurfaceHealth}
 */
function yourChromeHealth({ chosen, active, extension, extensionUrl = null }) {
  if (!chosen) return { state: 'off', usable: false, reasonCode: 'chrome.off', reason: "Your Chrome isn't selected.", fix: null };
  if (!active)
    return {
      state: 'unavailable',
      usable: false,
      reasonCode: 'chrome.tools',
      reason: "Your Chrome's tools couldn't be loaded; test the connection in Browser settings.",
      fix: { kind: 'settings', label: 'Browser settings', section: 'browser' },
    };
  if (!extension)
    return {
      state: 'permission',
      usable: true,
      reasonCode: 'chrome.extension',
      reason: "The Playwright Extension isn't installed in Chrome.",
      fix: extensionUrl ? { kind: 'url', label: 'Get the extension', url: extensionUrl } : null,
    };
  return { state: 'ready', usable: true, reason: null, fix: null };
}

/**
 * The user's Chrome for the native-shaped tools (B2): Claude in Chrome-shaped tools and the Codex extension backend
 * over the relay to the Playwright Extension (step 1, browser/chromeRelay.cjs) or MoPilot's own extension
 * (step 2, browser/chromeExtension.cjs).
 * @param {{ enabled: boolean, running: boolean, extension?: string | null, extensionUrl?: string | null,
 *           kind?: 'relay' | 'extension', paired?: boolean, connected?: boolean, asking?: boolean,
 *           installed?: 'on' | 'off' | 'missing' | null, installUrl?: string | null, name?: string | null }} f
 *   enabled: a switch is on now; running: it was set up at startup (the switches are read once); kind: the channel;
 *   extension: the Playwright Extension's installed version, null when it isn't found in Chrome (the relay);
 *   paired, connected: MoPilot's own extension proved the pairing secret once, and is connected now; asking: it
 *   asked through its native host and waits for the user's Allow (chromePairOffers.cjs);
 *   installed: MoPilot's own extension in the Chrome profile it pairs in (null: unread or unknown); installUrl: its
 *   Web Store page, where the build has one (#1632); name: the name the user gave this Chrome (Name this Chrome)
 * @returns {SurfaceHealth & { name?: string }}
 */
function chromeRelayHealth({
  enabled,
  running,
  extension = null,
  extensionUrl = null,
  kind = 'relay',
  paired = false,
  connected = false,
  asking = false,
  installed = null,
  installUrl = null,
  name = null,
}) {
  const own = kind === 'extension';
  const what = own ? "MoPilot's Chrome extension" : "MoPilot's Chrome relay";
  if (!enabled) return { state: 'off', usable: false, reasonCode: 'chrome.relayOff', reason: `${what} is turned off.`, fix: null };
  if (!running)
    return {
      state: 'unavailable',
      usable: false,
      reasonCode: 'chrome.restart',
      reason: `${what} was switched on after MoPilot started; restart MoPilot to use it.`,
      fix: null,
    };
  // the first browser step says not_connected with the same steps; the tools stay, so the model can tell the user
  if (own) {
    if (connected) return { state: 'ready', usable: true, reason: null, fix: null, ...(name ? { name } : {}) };
    // the extension asked through its native host: the user's Allow pairs it (chromePairOffers.cjs)
    if (asking)
      return {
        state: 'permission',
        usable: true,
        reasonCode: 'chrome.allow',
        reason: 'Chrome is waiting for your OK.',
        fix: { kind: 'chromeAllow', label: 'Allow' },
      };
    // the profile's word wins over pairing: a page can't be opened, nor the extension connect, where it isn't on
    if (installed === 'missing')
      return {
        state: 'permission',
        usable: true,
        reasonCode: 'chrome.install',
        reason: "MoPilot's Chrome extension isn't installed in the Chrome profile MoPilot uses.",
        fix: installUrl ? { kind: 'chromeInstall', label: 'Add to Chrome' } : null,
      };
    if (installed === 'off')
      return {
        state: 'permission',
        usable: true,
        reasonCode: 'chrome.extensionOff',
        reason: "MoPilot's Chrome extension is turned off in Chrome: turn it on in chrome://extensions.",
        fix: null,
      };
    if (!paired)
      return {
        state: 'permission',
        usable: true,
        reasonCode: 'chrome.pair',
        reason: "MoPilot's Chrome extension isn't paired yet: the first browser step opens its pairing page in Chrome.",
        fix: null,
      };
    return {
      state: 'unknown',
      usable: true,
      reasonCode: 'chrome.connect',
      reason: "MoPilot's Chrome extension isn't connected right now: it connects when Chrome is open with the extension on.",
      fix: null,
    };
  }
  if (!extension)
    return {
      state: 'permission',
      usable: true,
      reasonCode: 'chrome.extension',
      reason: "The Playwright Extension isn't installed in Chrome.",
      fix: extensionUrl ? { kind: 'url', label: 'Get the extension', url: extensionUrl } : null,
    };
  return { state: 'ready', usable: true, reason: null, fix: null };
}

/**
 * The record, bound to the app's live state; every reader asks it at the moment it needs it.
 */
class CapabilityHealth {
  /**
   * @param {{ isEnabled: (key: string) => boolean, helper: () => (HelperFacts & { permissions?: Permissions }) | null | undefined,
   *           yourChrome: () => { chosen: boolean, active: boolean, extension: string | null, extensionUrl?: string | null },
   *           chromeRelay?: (() => Parameters<typeof chromeRelayHealth>[0]) | null,
   *           sageMcp?: () => boolean, onChange?: () => void }} o
   *   chromeRelay: the Chrome relay's facts, where main runs it; without it the record has no chromeRelay surface
   *   helper: MoPilot's helper as computerUse.cjs last saw it (null before computer use is set up);
   *   sageMcp: sage-mcp exists (Codex and ACP get MoPilot's tools only through it)
   */
  constructor(o) {
    this.o = o;
    /** @type {string | null} */
    this.last = null;
  }

  /** @returns {ReturnType<typeof computerHealth>} */
  computer() {
    // before computer use is set up nothing is known about the helper yet; nothing launched it either
    const h = this.o.helper() ?? {
      path: null,
      installed: true,
      packaged: false,
      platform: process.platform,
      running: false,
      version: null,
      error: null,
    };
    const { permissions = null, ...helper } = h;
    return computerHealth({ enabled: this.o.isEnabled(COMPUTER_FLAG), helper, permissions });
  }

  /** @returns {SurfaceHealth} */
  yourChrome() {
    return yourChromeHealth(this.o.yourChrome());
  }

  /** The Chrome relay, or null where the record isn't given its facts. */
  chromeRelay() {
    if (!this.o.chromeRelay) return null;
    const facts = this.o.chromeRelay();
    // which channel it is: Settings shows MoPilot's own extension's row only for it
    return { ...chromeRelayHealth(facts), channel: facts.kind ?? 'relay' };
  }

  /** Whether each harness family gets MoPilot's tools at all. */
  channels() {
    const sage = this.o.sageMcp ? this.o.sageMcp() : true;
    return {
      claude: this.o.isEnabled(CHANNEL_FLAGS.claude),
      codex: sage && this.o.isEnabled(CHANNEL_FLAGS.codex),
      acp: sage && this.o.isEnabled(CHANNEL_FLAGS.acp),
    };
  }

  /** Everything, as the status rows and notes read it. */
  snapshot() {
    const relay = this.chromeRelay();
    return {
      computer: this.computer(),
      yourChrome: this.yourChrome(),
      ...(relay ? { chromeRelay: relay } : {}),
      channels: this.channels(),
    };
  }

  /** Something it is built from may have changed: tells onChange when the record did. */
  changed() {
    const next = JSON.stringify(this.snapshot());
    if (next === this.last) return false;
    this.last = next;
    this.o.onChange?.();
    return true;
  }
}

module.exports = {
  CapabilityHealth,
  computerHealth,
  yourChromeHealth,
  chromeRelayHealth,
  missingPermissions,
  CHANNEL_FLAGS,
  REQUIRED_PERMISSIONS,
};
