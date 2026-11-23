// The one table of vendor control errors MoPilot reads (Sky, the Codex Browser plugin, Claude in Chrome, Playwright MCP behind Your Chrome): each row's kind, the vendor codes that name it, and the wordings vendors send.
//
// Vendor control tools stop or refuse with their own error codes and sentences. A row matches by code first
// (Sky's error name or numeric code, the Browser plugin's BrowserUseSecurityError reason) and by wording
// second, within the rows of the vendor that sent the text. Every wording here was read from a shipped
// vendor build (the source is named above each group); tests/fixtures/vendor-error-wordings.json holds the
// real sentences and tests/vendorErrors.test.ts checks that each row is matched by one of them.
//
// Used by shared/skyComputerUse.mjs, which turns a match into the problem a thread step shows, and by
// electron/harness/claude/chromeLink.cjs, which reads a Claude in Chrome tool error that says the extension went away.

/** Which vendor sent a text: Codex's cua_repl carries Sky and the Browser plugin, Claude Code's claude-in-chrome the extension. */
export const VENDOR_SOURCES = Object.freeze({
  cua: Object.freeze(['sky', 'browserUse']),
  claudeInChrome: Object.freeze(['claudeInChrome']),
  yourChrome: Object.freeze(['yourChrome']),
});

/**
 * A row: its problem kind, the vendor that sends it, the vendor's error name its wordings come with (when
 * known), the codes that name it, and the wordings.
 * @typedef {{ kind: string, source: 'sky' | 'browserUse' | 'claudeInChrome' | 'yourChrome', name: string | null, codes: readonly string[], wordings: readonly RegExp[] }} VendorErrorRow
 * @type {readonly VendorErrorRow[]}
 */
export const VENDOR_ERRORS = Object.freeze(
  [
    // Sky: SkyComputerUseService (`strings`) and the cua_repl client (sky_js targets/mac: native-pipe.js, computer-use-policy.js)
    {
      kind: 'permissions',
      source: 'sky',
      name: 'permissionsNotGranted',
      codes: ['permissionsNotGranted'],
      wordings: [/Computer Use permissions are not granted/i],
    },
    {
      kind: 'permissionsPending',
      source: 'sky',
      name: 'permissionsPending',
      codes: ['permissionsPending'],
      wordings: [/Computer Use permissions are still pending/i],
    },
    { kind: 'appBlocked', source: 'sky', codes: [], wordings: [/Computer Use is blocked from using the app\b/i] },
    {
      kind: 'appRefused',
      source: 'sky',
      codes: ['appNotAllowed'],
      wordings: [/Computer Use is not allowed to use the app\b/i, /Computer use actions are not allowed for system security process/i],
    },
    {
      kind: 'notApproved',
      source: 'sky',
      codes: [],
      wordings: [/Computer Use was not approved\b/i, /Computer Use approval denied\b/i, /Computer Use permission request canceled\b/i],
    },
    {
      kind: 'blockedUrl',
      source: 'sky',
      name: 'blockedURL',
      codes: ['blockedURL'],
      wordings: [
        /Computer Use stopped due to encountering a disallowed URL/i,
        /Computer Use is not allowed on (?:the current browser URL|this URL)/i,
      ],
    },
    {
      kind: 'versionMismatch',
      source: 'sky',
      name: 'incompatibleClientVersion',
      codes: ['incompatibleClientVersion'],
      wordings: [/Sky Computer Use API version mismatch\b/i, /Computer Use server and client have a version mismatch/i],
    },
    { kind: 'screenLocked', source: 'sky', name: 'screenLocked', codes: ['screenLocked'], wordings: [/\bThe Mac is locked\b/i] },
    {
      kind: 'userStopped',
      source: 'sky',
      name: 'userStoppedSession',
      codes: ['userStoppedSession', 'userIntervened'],
      wordings: [/\bsession has been explicitly stopped by the user\b/i],
    },
    {
      kind: 'serviceMissing',
      source: 'sky',
      codes: [],
      wordings: [/Computer Use could not start because its runtime app is missing/i],
    },
    {
      kind: 'serviceUnavailable',
      source: 'sky',
      codes: [],
      wordings: [
        /Sky Computer Use (?:native pipe|host service|service startup)\b/i,
        /Computer Use (?:IPC server|XPC session) is unavailable/i,
        /Computer Use bootstrap (?:failed|response)\b/i,
        /Could not (?:receive|send) the Computer Use bootstrap response/i,
        /Timed out establishing the Computer Use connection/i,
        /protected Computer Use app-group container is unavailable/i,
      ],
    },
    {
      kind: 'turnEnded',
      source: 'sky',
      codes: [],
      wordings: [/Computer Use is unavailable because the current turn ended/i],
    },
    { kind: 'disabled', source: 'sky', codes: [], wordings: [/Computer Use is disabled by your configuration/i] },

    // Codex Browser plugin: BrowserUseSecurityError (plugins/browser/browser-client.mjs) and browser-service.mjs
    {
      kind: 'siteBlocked',
      source: 'browserUse',
      codes: ['site_status_blocked', 'navigation_url_policy_blocked', 'browser_navigation_blocked'],
      wordings: [
        /The site-safety policy blocks this action/i,
        /The browser URL policy blocks this action/i,
        /The browser blocked this navigation/i,
        /\bBrowser Use is not permitted on\b/i,
      ],
    },
    {
      kind: 'browserDeclined',
      source: 'browserUse',
      codes: ['user_declined'],
      wordings: [/The user declined permission for this action/i],
    },
    {
      kind: 'browserCheckUnavailable',
      source: 'browserUse',
      codes: [
        'approval_cancelled',
        'approval_failed_closed',
        'approval_unavailable',
        'browser_capability_unavailable',
        'browser_context_unavailable',
        'enterprise_policy_unavailable',
        'guardian_timed_out',
        'site_status_unavailable',
      ],
      wordings: [/Browser Use could not complete this action because a browser security check was unavailable/i],
    },
    {
      kind: 'browserPolicy',
      source: 'browserUse',
      codes: ['enterprise_policy_blocked', 'browser_capability_blocked', 'persisted_user_denied', 'guardian_denied'],
      wordings: [
        /The admin-enforced policy blocks this action/i,
        /The browser capability policy blocks this action/i,
        /A saved user permission setting blocks this action/i,
        /Auto-review denied this action/i,
        // any other refusal under the plugin's policy prefix
        /Browser Use rejected this action due to browser security policy/i,
      ],
    },
    // The Browser plugin's Chrome backend answered from the ChatGPT extension inside the Codex desktop app's own
    // in-app browser (the Owl shell), whose tabs API refuses chrome.windows.create (Owl's tabs_api.cc)
    {
      kind: 'codexAppBrowser',
      source: 'browserUse',
      codes: [],
      wordings: [/Creating browser windows from extensions is not supported in Owl/i],
    },

    // Playwright MCP behind Your Chrome (@playwright/mcp 0.0.83, playwright-core coreBundle.js): Chrome's profile has no
    // Playwright Extension, so the connection can't open (#1319 G21)
    {
      kind: 'chromeExtensionMissing',
      source: 'yourChrome',
      codes: [],
      wordings: [/Playwright Extension not found in/i],
    },
    // Claude in Chrome: the extension's navigate tool and its site-category check (fcoeoabgfenejglbffodgkkbkcdhcgfn 1.0.100).
    // Its errorCode is shared by site and policy blocks, so its rows match by wording only.
    {
      kind: 'siteBlocked',
      source: 'claudeInChrome',
      codes: [],
      wordings: [/This site is not allowed due to safety restrictions/i],
    },
    {
      kind: 'browserPolicy',
      source: 'claudeInChrome',
      codes: [],
      wordings: [
        /This site is blocked by (?:your organization|a policy set by your browser|your site permissions)/i,
        /Claude in Chrome is turned off (?:in your settings|by your organization)/i,
        /A navigation was blocked by policy/i,
      ],
    },
    {
      kind: 'browserDeclined',
      source: 'claudeInChrome',
      codes: [],
      wordings: [/Navigation to this domain is not allowed/i],
    },
    {
      kind: 'browserCheckUnavailable',
      source: 'claudeInChrome',
      codes: [],
      wordings: [/Could not verify this site's safety category/i],
    },
    // Claude in Chrome over the CLI's plain native messaging asks for site permission in a small Claude
    // window inside Chrome (mcpPermissions, 30 s): the chat only sees the call wait, then these.
    {
      kind: 'chromePromptTimedOut',
      source: 'claudeInChrome',
      codes: [],
      wordings: [/No response to the Claude in Chrome permission prompt/i],
    },
    {
      kind: 'chromePromptUnavailable',
      source: 'claudeInChrome',
      codes: [],
      wordings: [/The Claude in Chrome permission prompt window couldn't be opened/i],
    },
    // Claude in Chrome's link to the extension: the CLI's claude-in-chrome server answers a call it could not
    // deliver with these (Claude Code's onToolCallDisconnected and its tool-error mapping; Claude Desktop
    // 2.31226.1 serves the same server and adds the lost-result wording).
    {
      kind: 'chromeDisconnected',
      source: 'claudeInChrome',
      codes: [],
      wordings: [/\bBrowser extension is not connected\b/i],
    },
    {
      kind: 'chromeConnectionLost',
      source: 'claudeInChrome',
      codes: [],
      wordings: [
        /\btool call failed because the Chrome extension disconnected mid-operation\b/i,
        /\bcall was never delivered to the Chrome extension\b/i,
        /\btool call was sent, but the connection was lost before its result came back\b/i,
      ],
    },
    {
      kind: 'chromeNoResponse',
      source: 'claudeInChrome',
      codes: [],
      wordings: [/\btool did not respond in time\b/i],
    },
  ].map((row) => Object.freeze({ name: null, ...row, codes: Object.freeze(row.codes), wordings: Object.freeze(row.wordings) })),
);

/**
 * Sky's error names that have no state of their own: requests the model recovers from itself (no session yet,
 * an ambiguous or missing app) or internal faults. They read as an unknown Sky problem with their raw name and code.
 */
export const SKY_ERRORS_WITHOUT_STATE = Object.freeze([
  'senderProcessNotAuthenticated',
  'couldNotGetRequestData',
  'couldNotGetRequestTypeName',
  'couldNotResolveRequestType',
  'unhandledEvent',
  'unknownError',
  'runningApplicationNotFound',
  'accessibilityError',
  'invalidApp',
  'noActiveSession',
  'couldNotGetSenderPID',
  'ambiguousApp',
  'couldNotGetBootstrapPort',
]);

/**
 * Sky's messages that ask the model to recover by itself (fetch the app's state again, wait for the user to
 * finish typing): not a stop, so a failed call that says only this carries no problem.
 */
export const SKY_MODEL_RECOVERS = Object.freeze([
  /Computer Use is not active for\b/i,
  /\bThe user is still interacting with\b/i,
  /\bThe user changed '/i,
  /Computer Use could not persist the approval permanently\b/i,
]);

/** The kinds that say Claude in Chrome's extension went away: the session's link is read again (electron/harness/claude/chromeLink.cjs). */
export const CHROME_LINK_DOWN = Object.freeze(['chromeDisconnected', 'chromeConnectionLost']);

const rowsOf = (sources) => VENDOR_ERRORS.filter((r) => sources.includes(r.source));

/**
 * The row the first of a vendor's codes names (Sky's error name, a Browser plugin refusal reason), among the
 * rows of `sources`; null when none does. Codes decide before wording: they are the vendor's own classification.
 * @param {(string | null | undefined)[]} codes
 * @param {readonly string[]} sources
 * @returns {VendorErrorRow | null}
 */
export function vendorErrorByCode(codes, sources) {
  const rows = rowsOf(sources);
  for (const code of codes) {
    const row = code ? rows.find((r) => r.codes.includes(code)) : undefined;
    if (row) return row;
  }
  return null;
}

/**
 * The first row of `sources` (in table order) with a wording in `text`, and where that wording starts; null when none.
 * @param {string} text
 * @param {readonly string[]} sources
 * @returns {{ row: VendorErrorRow, index: number } | null}
 */
export function vendorErrorByWording(text, sources) {
  for (const row of rowsOf(sources)) {
    for (const re of row.wordings) {
      const m = re.exec(text);
      if (m) return { row, index: m.index };
    }
  }
  return null;
}

/**
 * Whether a Claude in Chrome tool error says the extension went away (a CHROME_LINK_DOWN row of the table).
 * @param {unknown} text
 */
export function chromeLinkDown(text) {
  if (typeof text !== 'string') return false;
  const hit = vendorErrorByWording(text, VENDOR_SOURCES.claudeInChrome);
  return !!hit && CHROME_LINK_DOWN.includes(hit.row.kind);
}
