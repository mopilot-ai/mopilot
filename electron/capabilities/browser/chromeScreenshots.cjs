// browser_save_screenshot on a tab of the chat's Chrome group (#1539): how a native Codex thread whose Browser plugin drives the user's Chrome through MoPilot's Chrome backend gets a file of a Chrome page for chooser.setFiles.
//
// The plugin's screenshots are images, not files, and the plugin's Chrome tab is a tab of the browser host for Chrome
// (chromeHost.cjs), not of the pane's. So the browser_* tools' browser_save_screenshot (hostScreenshots.cjs) hands an id
// its own tabs don't have to this saver, which captures it on the Chrome host: through Chrome's own site table (the read
// gate, password fields masked), into the chat's upload folder, onto the chrome_* tools' shelf (a chat that switches to
// Claude Code or ACP attaches the same Screenshot ID with chrome_upload_image). The upload itself stays the plugin's
// chooser.setFiles, which MoPilot's Chrome backend confirms per call (iabBackend/backend.cjs gateWrite).
const { ToolError } = require('../contract/registry.cjs');
const { pageGates } = require('./hostPageGates.cjs');
const { screenshotTools } = require('./hostScreenshots.cjs');
const { tabStatus } = require('./hostToolArgs.cjs');
const { explained } = require('./refusals.cjs');

/**
 * How a screenshot of a Chrome tab is attached: with the chrome_* tools where they are on (Claude Code, ACP, a Codex
 * thread since #1319 G28), else through the Browser plugin's own chooser on MoPilot's Chrome backend.
 * @param {boolean} toolsOn
 */
const attachInChrome = (toolsOn) => (/** @type {string} */ _file, /** @type {string} */ id) =>
  toolsOn
    ? `Attach it with chrome_upload_image (imageId: "${id}", ref: the file input) or chrome_file_upload (screenshots: ["${id}"])`
    : "Pass that file's path to chooser.setFiles(...) on the Browser plugin's Chrome tab (MoPilot's Chrome), as for any file";

/**
 * The saver for a tab of the chat's Chrome group, as browser_save_screenshot's `chromeShots`: null for an id the group
 * doesn't have. A tab is named by its host id (the Browser plugin's providerTabId) or by Chrome's own tab id (as the
 * chrome_* tools list it, a number or its digits); the result names it the same way.
 * @param {{ tabs: any, grants: any, folders: Parameters<typeof screenshotTools>[0]['folders'],
 *           shelf: InstanceType<typeof import('./hostScreenshots.cjs').ScreenshotShelf>, enabled: () => true | string,
 *           toolsOn?: () => boolean }} o
 *   tabs: the browser host for Chrome; grants: Chrome's site table; shelf: the chrome_* tools' own;
 *   enabled: whether MoPilot serves the user's Chrome now (a reason when it doesn't);
 *   toolsOn: whether the chrome_* tools are on, for how the result says to attach the file
 * @returns {(chatId: string, tabId: unknown) => ((args: any, ctx: any) => Promise<any[]>) | null}
 */
function chromeScreenshots({ tabs, grants, folders, shelf, enabled, toolsOn = () => false }) {
  const live = () => {
    const on = enabled();
    if (on !== true) throw new ToolError(typeof on === 'string' ? on : 'Chrome control is turned off.', 'disabled');
  };
  const { pageGate } = pageGates({ grants, tabs, live });
  const shots = screenshotTools({
    tabs,
    folders,
    shelf,
    pageGate,
    status: tabStatus,
    riskOf: (url) => grants.riskOf(url),
    attach: (file, id) => attachInChrome(toolsOn())(file, id),
  });
  /** The tab as the caller named it, outside file paths (a saved name may contain the host id). */
  const renamed = (/** @type {string} */ text, /** @type {string} */ hostId, /** @type {string} */ chromeId) =>
    text.replace(new RegExp(`(?<![\\w/.-])${hostId}(?![\\w-]|\\.\\w)`, 'g'), chromeId);
  /** Refusals name the user's Chrome (refusals.cjs), so the chat's strip and cards say which browser. */
  const save = async (/** @type {string} */ hostId, /** @type {string | null} */ chromeId, args, ctx) => {
    try {
      live();
      const out = await explained(shots.save({ ...args, tabId: hostId }, ctx), 'chrome');
      // named by Chrome's tab id: the result names the tab that way too
      return chromeId === null ? out : out.map((c) => (c?.type === 'text' ? { ...c, text: renamed(String(c.text), hostId, chromeId) } : c));
    } catch (e) {
      // and so does a refusal
      if (chromeId !== null && e instanceof Error) e.message = renamed(e.message, hostId, chromeId);
      throw e;
    }
  };
  return (chatId, tabId) => {
    const byChrome = /^\d+$/.test(String(tabId));
    const tab = tabs
      .list(chatId)
      .find(
        (/** @type {{ id: string, backend?: { tabId?: number } }} */ t) =>
          t.id === tabId || (byChrome && String(t.backend?.tabId) === String(tabId)),
      );
    return tab ? (args, ctx) => save(tab.id, tab.id === tabId ? null : String(tabId), args, ctx) : null;
  };
}

module.exports = { chromeScreenshots };
