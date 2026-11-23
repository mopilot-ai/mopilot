// Which registry tools an agent session is shown. One rule for every harness and tool channel:
// sage-mcp (Codex threads, ACP sessions) and Claude's SDK MCP server all ask the same predicate, so an
// agent sees one set of tools per job whatever harness runs it.
//
// - Browser: with shared.browser.parityTools on, the browser_* tools drive the in-app browser and the
//   older sage_browser_* panel tools are left out; with it off, browser_* are left out (they stay
//   registered from startup) and sage_browser_* drive the pane again: one in-app browser controller. sage_browser_* stay while they drive the user's own
//   Chrome (Your Chrome is the active channel), unless the harness already controls Chrome itself
//   (Claude in Chrome, Codex's Browser plugin): that would be a second controller.
// - Desktop: with shared.computerUse.parityTools on, the desktop_* tools replace the older computer_*
//   tools. A harness with its own computer use (Codex's computer-use plugin) gets neither, and neither is
//   shown while MoPilot's computer use cannot work here (capabilityHealth.cjs: no helper, not macOS).
// A harness counts as controlling Chrome or the computer itself only where that path really runs on this
// Mac (nativeAvailability.cjs): a session whose vendor runtime is missing keeps MoPilot's tools.
// - browser_* are registered only when browser parity was on at startup; switched off live, they stay
//   registered but are left out, so the in-app browser has one controller (sage_browser_* again).
// - Chrome over MoPilot's extension or relay (chrome_*, B2): registered when main serves the user's Chrome at
//   startup, and shown while a switch for every harness stays on or, where the build ships the extension, while its
//   default does (chromeControl.cjs chromeToolsOn), unless the session's harness controls Chrome itself or Your Chrome
//   (sage_browser_*) is the channel: either would be a second Chrome controller.
// - Design (design_*): shown while shared.design.enabled is on.
// - Page tools (WebMCP: browser_page_tools, browser_page_tool and their chrome_* twins): shown while shared.browser.webmcp is on.
// - Everything else is always shown.
// A call to a hidden tool is refused with hiddenToolMessage for the same facts, so the refusal names only
// the surfaces the session's harness really serves (hideRule carries it for a session's own rule).

const { chromeToolsOn } = require('./browser/chromeControl.cjs');
// the refusal helpers live in ./contract/toolRefusal.cjs (no browser rules to load); this module still exports them
const { hideRule, hiddenRefusalText } = require('./contract/toolRefusal.cjs');

const LEGACY_BROWSER = 'sage_browser_';
const IN_APP_BROWSER = 'browser_';
const LEGACY_COMPUTER = 'computer_';
const DESKTOP = 'desktop_';
const CHROME_RELAY = 'chrome_';
const DESIGN = 'design_';
/** A tool of each new set, to tell whether that set is registered. */
const IN_APP_BROWSER_PROBE = 'browser_navigate';
const DESKTOP_PROBE = 'desktop_screenshot';
const CHROME_RELAY_PROBE = 'chrome_navigate';
const DESIGN_PROBE = 'design_quickstart';
const LEGACY_COMPUTER_PROBE = 'computer_screenshot';

const BROWSER_PARITY_FLAG = 'shared.browser.parityTools';
const COMPUTER_FLAG = 'shared.computerUse.enabled';
const COMPUTER_PARITY_FLAG = 'shared.computerUse.parityTools';
const DESIGN_FLAG = 'shared.design.enabled';
const WEBMCP_FLAG = 'shared.browser.webmcp';
/** The page tools (WebMCP, browser/webmcpTools.cjs) of both browsers. */
const WEBMCP_TOOLS = new Set(['browser_page_tools', 'browser_page_tool', 'chrome_page_tools', 'chrome_page_tool']);

/**
 * Whether a session must not see registry tool `name`. A pure function of the facts given.
 * @param {string} name
 * @param {{ browserParity?: boolean, browserParityOff?: boolean, computerParity?: boolean, drivesUserChrome?: boolean,
 *           nativeChrome?: boolean, nativeComputer?: boolean, chromeRelay?: boolean, computerUnavailable?: string | null,
 *           designOff?: boolean, webmcpOff?: boolean }} [facts]
 *   browserParity: the browser_* tools are on and registered
 *   browserParityOff: the browser_* switch is off (any browser_* still registered are left out)
 *   computerParity: the desktop_* tools are on and registered
 *   drivesUserChrome: sage_browser_* reach the user's own Chrome (Your Chrome is the channel)
 *   nativeChrome: the session's harness controls the user's Chrome itself, and its runtime is on this Mac
 *   nativeComputer: the session's harness has its own computer use, and its runtime is on this Mac
 *   chromeRelay: the chrome_* tools are on and registered
 *   computerUnavailable: why MoPilot's computer use cannot work here (capabilityHealth.cjs), else null
 *   designOff: the design tools' switch (shared.design.enabled) is off
 *   webmcpOff: the page tools' switch (shared.browser.webmcp) is off
 * @returns {boolean}
 */
function isToolHidden(name, facts = {}) {
  if (typeof name !== 'string') return false;
  if (facts.webmcpOff && WEBMCP_TOOLS.has(name)) return true;
  if (name.startsWith(LEGACY_BROWSER)) return facts.drivesUserChrome ? !!facts.nativeChrome : !!facts.browserParity;
  if (name.startsWith(IN_APP_BROWSER)) return !!facts.browserParityOff;
  if (name.startsWith(LEGACY_COMPUTER)) return !!facts.computerParity || !!facts.nativeComputer || !!facts.computerUnavailable;
  if (name.startsWith(DESKTOP)) return !!facts.nativeComputer || !!facts.computerUnavailable;
  if (name.startsWith(CHROME_RELAY)) return !facts.chromeRelay || !!facts.nativeChrome || !!facts.drivesUserChrome;
  if (name.startsWith(DESIGN)) return !!facts.designOff;
  return false;
}

/**
 * What a model is told when it calls a tool this predicate hides (a session may have cached its list).
 * It names only the surface the tool belongs to, and the harness's own controller only for a surface
 * that harness serves (`chromeBy`: the name of the harness's Chrome controller, e.g. Claude in Chrome).
 * @param {string} name
 * @param {{ browserParityOff?: boolean, drivesUserChrome?: boolean, nativeComputer?: boolean, nativeChrome?: boolean, chromeBy?: string,
 *           computerUnavailable?: string | null, designOff?: boolean, webmcpOff?: boolean }} [facts]
 */
function hiddenToolMessage(name, facts = {}) {
  if (facts.webmcpOff && WEBMCP_TOOLS.has(name)) return `${name} is unavailable: page tools (WebMCP) are turned off in MoPilot.`;
  if (typeof name === 'string' && name.startsWith(DESIGN) && facts.designOff)
    return `${name} is unavailable: design tools are turned off in MoPilot.`;
  const computerTool = typeof name === 'string' && (name.startsWith(LEGACY_COMPUTER) || name.startsWith(DESKTOP));
  if (computerTool && !facts.nativeComputer && facts.computerUnavailable)
    return `${name} is unavailable: ${facts.computerUnavailable} Tell the user computer use is unavailable (Settings → Computer use says why); do not work around it.`;
  if (typeof name === 'string' && name.startsWith(LEGACY_BROWSER)) {
    if (!facts.drivesUserChrome) return `${name} is unavailable: use the browser_* tools for the built-in browser.`;
    return facts.chromeBy
      ? `${name} is unavailable in this session: Chrome is controlled by ${facts.chromeBy} here.`
      : `${name} is unavailable in this session: this harness controls the user's Chrome itself.`;
  }
  if (typeof name === 'string' && name.startsWith(IN_APP_BROWSER) && facts.browserParityOff)
    return `${name} is unavailable: Browser control is turned off for these tools.${facts.drivesUserChrome ? '' : ' Use the sage_browser_* tools for the built-in browser.'}`;
  if (typeof name === 'string' && name.startsWith(LEGACY_COMPUTER) && !facts.nativeComputer)
    return `${name} is unavailable: use the desktop_* tools to control the computer.`;
  if (facts.nativeComputer && typeof name === 'string' && (name.startsWith(LEGACY_COMPUTER) || name.startsWith(DESKTOP)))
    return `${name} is unavailable in this session: the harness's own computer use is on here; use it instead.`;
  if (typeof name === 'string' && name.startsWith(CHROME_RELAY)) {
    if (facts.nativeChrome)
      return facts.chromeBy
        ? `${name} is unavailable in this session: Chrome is controlled by ${facts.chromeBy} here.`
        : `${name} is unavailable in this session: this harness controls the user's Chrome itself.`;
    if (facts.drivesUserChrome) return `${name} is unavailable: Your Chrome is the browser channel; use the sage_browser_* tools.`;
  }
  return `${name} is unavailable in this session.`;
}

/** What a Claude session with Claude in Chrome does itself, as ToolVisibility host facts. */
const CLAUDE_IN_CHROME_HOST = Object.freeze({ nativeChrome: true, chromeBy: 'Claude in Chrome' });

/**
 * The predicate bound to the app's live state, read at every call: remote switches, the user's
 * browser channel and what is registered can change while sessions run.
 */
class ToolVisibility {
  /**
   * @param {{ registry: { has(name: string): boolean }, isEnabled: (key: string) => boolean,
   *           drivesUserChrome?: () => boolean, computerUnavailable?: () => string | null, chromeShipped?: boolean }} o
   *   computerUnavailable: why MoPilot's computer use cannot work here, from the capability health record;
   *   chromeShipped: this build ships MoPilot's extension, so the chrome_* tools are on by default (chromeToolsOn)
   */
  constructor(o) {
    this.registry = o.registry;
    this.isEnabled = o.isEnabled;
    this.chromeShipped = !!o.chromeShipped;
    this.drivesUserChrome = o.drivesUserChrome || (() => false);
    this.computerUnavailable = o.computerUnavailable || (() => null);
  }

  /**
   * The app-wide facts, plus what the session's harness does itself (`host`).
   * @param {{ nativeChrome?: boolean, nativeComputer?: boolean, chromeBy?: string }} [host]
   */
  facts(host = {}) {
    return {
      browserParity: this.isEnabled(BROWSER_PARITY_FLAG) && this.registry.has(IN_APP_BROWSER_PROBE),
      browserParityOff: !this.isEnabled(BROWSER_PARITY_FLAG),
      computerParity: this.isEnabled(COMPUTER_FLAG) && this.isEnabled(COMPUTER_PARITY_FLAG) && this.registry.has(DESKTOP_PROBE),
      drivesUserChrome: !!this.drivesUserChrome(),
      chromeRelay: chromeToolsOn(this.isEnabled, { shipped: this.chromeShipped }) && this.registry.has(CHROME_RELAY_PROBE),
      nativeChrome: !!host.nativeChrome,
      nativeComputer: !!host.nativeComputer,
      computerUnavailable: this.computerUnavailable() || null,
      // only while the design tools are registered and their switch is off
      ...(this.registry.has(DESIGN_PROBE) && !this.isEnabled(DESIGN_FLAG) ? { designOff: true } : {}),
      // only while the page tools are registered and their switch is off
      ...([...WEBMCP_TOOLS].some((n) => this.registry.has(n)) && !this.isEnabled(WEBMCP_FLAG) ? { webmcpOff: true } : {}),
      ...(typeof host.chromeBy === 'string' && host.chromeBy ? { chromeBy: host.chromeBy } : {}),
    };
  }

  /**
   * Whether a session must not see `name`. Without `host`, the rule for every session (the
   * registry's own filter); with it, the rule for a session whose harness has native Chrome or
   * computer use.
   * @param {string} name
   * @param {{ nativeChrome?: boolean, nativeComputer?: boolean, chromeBy?: string }} [host]
   */
  hides(name, host = {}) {
    return isToolHidden(name, this.facts(host));
  }

  /**
   * The message for a call to a tool `hides` left out.
   * @param {string} name
   * @param {{ nativeChrome?: boolean, nativeComputer?: boolean, chromeBy?: string }} [host]
   */
  message(name, host = {}) {
    return hiddenToolMessage(name, this.facts(host));
  }

  /** Whether a session without the harness's own computer use gets MoPilot's (desktop_* or computer_*). */
  managedComputer() {
    return [DESKTOP_PROBE, LEGACY_COMPUTER_PROBE].some((n) => this.registry.has(n) && !this.hides(n));
  }

  /**
   * `hides` for one kind of session, as a session's `hide(name)` option, carrying its refusal `message`.
   * @param {{ nativeChrome?: boolean, nativeComputer?: boolean, chromeBy?: string }} host
   */
  forHost(host) {
    return hideRule(
      (name) => this.hides(name, host),
      (name) => this.message(name, host),
    );
  }
}

module.exports = {
  isToolHidden,
  hiddenToolMessage,
  hideRule,
  hiddenRefusalText,
  CLAUDE_IN_CHROME_HOST,
  ToolVisibility,
  IN_APP_BROWSER_PROBE,
  DESKTOP_PROBE,
};
