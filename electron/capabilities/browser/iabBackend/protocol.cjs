// Browser backend protocol metadata, limits and shared error construction.

const SOCKET_DIR = '/tmp/codex-browser-use';
const CDP_MS = 20_000;
const MAX_IN = 8 * 1024 * 1024;
const MAX_OUT = 64 * 1024 * 1024;
// the name the Codex Browser plugin shows for the pane: thread notes already in Codex history match it, so it stays
const NAME = 'MoPilot In-app Browser';
/** Methods the protocol has that MoPilot's pane does not offer (Browser.user is off in getInfo). */
const UNAVAILABLE = [
  'getUserTabs',
  'claimUserTab',
  'getUserHistory',
  'executeTabRead',
  'followSessionTab',
  'browserAuthNewTargetProtection',
];

/** The capabilities getInfo lists; their wording is MoPilot's own. */
const BROWSER_CAPABILITIES = [
  { id: 'visibility', description: "Show the browser in MoPilot's browser pane, or check whether the pane shows it." },
  { id: 'viewport', description: 'Override the tab viewport size for responsive testing; reset it when done.' },
];

const fail = (message) => new Error(message);

const NO_PASSWORDS = 'This is a password field: agents never type passwords. Ask the user to sign in themselves in the browser pane.';

/**
 * How a Codex thread tells whether a file upload on one of MoPilot's browsers worked (bu3): the plugin's
 * evaluate() hands the page script a read-only element without `files`, so `el.files` reads empty after a
 * chooser.setFiles that did attach the file, and the plugin's own upload troubleshooting names the ChatGPT extension.
 */
const UPLOAD_HINT =
  "File uploads with the Browser plugin on MoPilot's browsers: chooser.setFiles(...) that returns without an error attached the file. An element in tab.playwright evaluate() has no `files` (the plugin gives page scripts a read-only element), so `el.files` reads empty even then; check the input's `value` (it reads C:\\fakepath\\<file name> once a file is attached) or carry on and check the page's result. When setFiles fails, its error says what to fix; the plugin's upload troubleshooting about the ChatGPT browser extension does not apply to MoPilot's browsers.";

/**
 * Both screenshot hints end with when to save (#1539 IAB check: a thread took the plugin's screenshot of one page, moved to
 * the form, and only then saved, which captured the form): the save captures what the tab shows at that moment.
 */
const SAVE_WHILE_SHOWN =
  "Save it while the tab still shows that page: the plugin's own screenshots are images, not files, and a later save captures what the tab shows then.";

/**
 * How a Codex thread on the iab backend attaches a screenshot of a pane page to a form (#1530): the plugin's screenshots
 * are images, not files, and the pane refuses a data: URL, so the file comes from MoPilot's browser_save_screenshot.
 */
const screenshotUploadHint = (serverName) =>
  `To attach a screenshot of a page in the pane to a form, save it with browser_save_screenshot of the ${serverName} MCP server (tabId: the plugin tab's providerTabId; ref, region or full_page for part or all of the page) and pass the file path it returns to chooser.setFiles. A data: URL is not a file: the pane refuses it. ${SAVE_WHILE_SHOWN}`;

/**
 * How a Codex thread whose Browser plugin drives the user's Chrome through MoPilot's Chrome backend attaches a
 * screenshot of a Chrome page to a form (#1539): browser_save_screenshot takes the plugin's Chrome tab by its providerTabId.
 */
const chromeScreenshotHint = (serverName) =>
  `To attach a screenshot of a page in MoPilot's Chrome to a form, save it with browser_save_screenshot of the ${serverName} MCP server (tabId: the plugin's Chrome tab's providerTabId; ref, region or full_page for part or all of the page) and pass the file path it returns to chooser.setFiles. ${SAVE_WHILE_SHOWN}`;

module.exports = {
  SOCKET_DIR,
  CDP_MS,
  MAX_IN,
  MAX_OUT,
  NAME,
  NO_PASSWORDS,
  UNAVAILABLE,
  BROWSER_CAPABILITIES,
  UPLOAD_HINT,
  screenshotUploadHint,
  chromeScreenshotHint,
  fail,
};
