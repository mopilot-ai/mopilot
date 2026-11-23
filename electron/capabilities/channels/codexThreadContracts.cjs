// Stateless Codex thread config, model-context notes and MCP call-attribution contracts.
const { chromeSelectionNote } = require('../browser/codexChromePick.cjs');
const { UPLOAD_HINT, NAME: IAB_NAME, screenshotUploadHint, chromeScreenshotHint } = require('../browser/iabBackend/protocol.cjs');
const { paneConfirmNote, botCheckNote, previewNote } = require('../contract/surfaceNote.cjs');
const { pluginChromeOffConfig, CUA_SERVER } = require('./codexPluginChrome.cjs');
const { isJsonRecord } = require('../../../shared/jsonRecord.mjs');
const { sageMcpEnv } = require('./sessionMcp.cjs');

const NATIVE_CUA_PLUGIN = 'unified-computer-use@openai-bundled';
// user-configured MCP servers that give the agent its own desktop or browser control
const NATIVE_CONTROL_SERVERS = ['node_repl'];

/**
 * codex_apps is never switched off or pre-approved: its calls go through Codex's own approval.
 * (features.apps=false does remove it per thread, X14, but connectors are the user's to keep.)
 */
const CODEX_APPS_SERVER = 'codex_apps';

/** How long Codex lets a MoPilot tool call run: past a take-over's wait for the user (10 minutes) and the action after it. */
const SAGE_TOOL_TIMEOUT_SEC = 15 * 60;

/**
 * The config fragment for one thread. `userServers`: names of the MCP servers the user's config defines.
 * `native`: the thread also gets the vendor's computer-use plugin (nativeThreadConfig), without its Chrome when `cua`
 * is given (codexPluginChrome.cjs).
 */
function codexThreadConfig(
  /** @type {{ serverName: string, command: string, args?: string[], socketPath: string, token: string, userServers?: string[], disableUserNodeRepl?: boolean, native?: boolean, cua?: Record<string, any> | null, chrome?: boolean }} */ {
    serverName,
    command,
    args = [],
    socketPath,
    token,
    userServers = [],
    disableUserNodeRepl = true,
    native = false,
    cua = null,
    chrome = false,
  },
) {
  const base = native
    ? nativeThreadConfig({ userServers, disableUserNodeRepl, cua, chrome })
    : nativeControlOff({ userServers, disableUserNodeRepl });
  return {
    ...base,
    mcp_servers: {
      [serverName]: {
        command,
        args,
        env: sageMcpEnv({ socketPath, token }),
        default_tools_approval_mode: 'approve',
        // Codex ends a call after 60 s by default; a card or a take-over waits for the user longer (TAKEOVER_WAIT_MS)
        tool_timeout_sec: SAGE_TOOL_TIMEOUT_SEC,
      },
      ...base.mcp_servers,
    },
  };
}

/**
 * The user's own MCP servers the MCP gateway runs in their place, off in a chat's thread (#2999 C4): `managed` (the
 * gateway's check of a server's entry, gateway/native.cjs) is asked of each server the user's config defines; none
 * without a gateway, and an isolated thread (no user servers) has none.
 * @param {string[]} userServers @param {Record<string, unknown>} configs @param {((entry: unknown) => boolean) | null} managed
 */
function gatewayThreadOff(userServers, configs, managed) {
  if (!managed) return {};
  const off = userServers.filter((n) => managed(configs[n]));
  return off.length ? { mcp_servers: Object.fromEntries(off.map((n) => [n, { enabled: false }])) } : {};
}

/** Assemble an issued session's launch contract without changing lifecycle or native routing. */
function issuedThreadConfig(
  /** @type {{ command: string, args: string[], socketPath: string | null }} */ { command, args, socketPath },
  /** @type {{ serverName: string, token: string }} */ { serverName, token },
  /** @type {Omit<Parameters<typeof codexThreadConfig>[0], 'serverName' | 'command' | 'args' | 'socketPath' | 'token'>} */ options,
) {
  // The lifecycle owner issues a session only when hasTools() confirms a socket exists.
  return codexThreadConfig({ ...options, serverName, command, args, socketPath: /** @type {string} */ (socketPath), token });
}

/** Native desktop and browser control off: the base fragment for a chat's managed thread. */
function nativeControlOff(
  /** @type {{ userServers?: string[], disableUserNodeRepl?: boolean }} */ { userServers = [], disableUserNodeRepl = true },
) {
  // codex.disableUserNodeRepl off: the user's own node_repl stays on in the thread
  const off = disableUserNodeRepl ? NATIVE_CONTROL_SERVERS.filter((n) => userServers.includes(n)) : [];
  return {
    mcp_servers: Object.fromEntries(off.map((n) => [n, { enabled: false }])),
    plugins: { [NATIVE_CUA_PLUGIN]: { enabled: false } },
  };
}

/**
 * A thread MoPilot runs for itself (a title, a handoff note, a runtime probe) uses no tools, so it starts none of
 * the user's MCP servers either: the app-server keeps each loaded thread's servers running until it exits, the
 * thread's last unsubscribe notwithstanding.
 */
function helperThreadConfig(/** @type {{ userServers?: string[] }} */ { userServers = [] }) {
  return {
    mcp_servers: Object.fromEntries(userServers.map((n) => [n, { enabled: false }])),
    plugins: { [NATIVE_CUA_PLUGIN]: { enabled: false } },
  };
}

/**
 * The vendor's computer-use plugin on, loaded whole (its instructions, approvals and cleanup hooks)
 * rather than a hand-copied cua_repl definition. The user's own node_repl stays off as on every path.
 * When MoPilot serves the user's Chrome to the thread (`cua`, codexPluginChrome.cjs cuaWithoutChrome), its cua_repl
 * is the plugin's own definition without the Chrome family, and the Chrome plugin is off (#1319 G28). A thread that keeps
 * the plugin's Chrome (`chrome`) gets `cua` as it is: the plugin's definition without its computer use (#1381).
 */
function nativeThreadConfig(
  /** @type {{ userServers?: string[], disableUserNodeRepl?: boolean, cua?: Record<string, any> | null, chrome?: boolean }} */ {
    userServers = [],
    disableUserNodeRepl = true,
    cua = null,
    chrome = false,
  } = {},
) {
  const off = disableUserNodeRepl ? NATIVE_CONTROL_SERVERS.filter((n) => userServers.includes(n)) : [];
  const fragment = {
    mcp_servers: Object.fromEntries(off.map((n) => [n, { enabled: false }])),
    plugins: { [NATIVE_CUA_PLUGIN]: { enabled: true } },
  };
  if (!cua) return fragment;
  return mergeConfig(fragment, chrome ? { mcp_servers: { [CUA_SERVER]: cua } } : pluginChromeOffConfig(cua));
}

/**
 * `extra` merged into `base`, objects key by key; neither is changed.
 * @returns {Record<string, any>}
 */
function mergeConfig(base, extra) {
  /** @type {Record<string, any>} */
  const out = { ...(isJsonRecord(base) ? base : {}) };
  for (const [k, v] of Object.entries(extra)) out[k] = isJsonRecord(v) && isJsonRecord(out[k]) ? mergeConfig(out[k], v) : v;
  return out;
}

/** The additionalContext key for the in-app browser note on a native thread's turn/start. */
const IN_APP_BROWSER_CONTEXT = 'mopilot.in-app-browser';

/**
 * What comes first in front of the parts of a turn's note that name MoPilot's tools or settings. The note is kept in the thread's Codex history, which the
 * ChatGPT/Codex app shares, so it is read again when the thread continues there without MoPilot: the tools
 * and settings it names are gone, and a model that trusts the note looks for them and reports the browser
 * unavailable instead of using the plugin's own backends.
 * @param {string} serverName
 */
function scopeNote(serverName) {
  return (
    `This note is from MoPilot and applies only while the ${serverName} MCP server is in your tool list; that server exists only while MoPilot runs this thread. ` +
    `If it is not in your tool list, ignore the parts below that name its tools or MoPilot's settings, and use the Browser and Computer plugins as usual, including their in-app browser ("iab").`
  );
}

/** Multi-step in-app browser work as one browser_script: the Playwright-style API Codex models know. */
const SCRIPT_HINT =
  'For multi-step built-in browser work, prefer one browser_script call: its code runs as an async function with the Playwright-style tab API you know (tab.goto, tab.playwright.getByRole(...).click(), fill, waitForURL, domSnapshot, screenshot), many steps per call, instead of many single browser_* calls.';
/** Never Computer Use on MoPilot's own window to get at its pane (#1362): its computer use refuses that app anyway. */
const NO_SELF_COMPUTER_USE =
  'Never use Computer Use on MoPilot (the app named MoPilot, its window, chat list or pane controls) to reach the pane: computer use never controls MoPilot, and MoPilot stops a turn whose program names it.';
/** What only browser_* do in the pane (#1362): the plugin's tab API has no Stop or Duplicate, and its providerTabId is the browser_* tab id. */
const PANE_ONLY_HINT = `The plugin cannot stop a page that keeps loading or duplicate a tab: call browser_navigate with url "stop", or browser_tabs_create with duplicate set to the tab's providerTabId (it opens beside it with its back/forward history). ${NO_SELF_COMPUTER_USE}`;
/** The existing deliverable mark also keeps tabs the user requests for later, only on MoPilot's IAB backend. */
const IAB_TAB_RETENTION_HINT = `In the Browser plugin's "iab" browser while its name is "${IAB_NAME}" (MoPilot's pane; for any other browser, ignore this paragraph): tabs you open this turn are temporary, as are tabs or windows pages open from temporary tabs; unmarked tabs close when your turn ends, except the turn's result tab. Use await tab.markDeliverable() on each tab the user asks to keep for a later message before your turn ends and before promising it will stay open. Use markHandoff() when the user must continue in the tab themselves. Do not mark temporary working tabs unless the user asks to keep them.`;

/** The bot-check note (#1615) for a thread shown MoPilot's browser_* tools, whose hand-off is browser_request_signin. */
const BOT_CHECK_SIGNIN = botCheckNote(
  'In the pane, hand the tab to the user with browser_request_signin (reason "Complete the CAPTCHA") and end your turn; read the page again when the user is done; in another browser or app, ask the user in chat to complete it.',
);

/**
 * What a native thread's model is told once its browser_* tools are there. With `iab` (MoPilot
 * serves the plugin's in-app browser backend for the thread, browser/iabBackend.cjs) the plugin's iab
 * browser is MoPilot's pane, and browser_* drive the same pane. Without it the pane is reached
 * only through browser_* (multi-step work preferably as one browser_script). Either way, when the
 * vendor's Browser plugin can use Chrome, its Chrome backend is whatever browser the ChatGPT extension
 * connected (normally the user's own Chrome), never MoPilot's pane, and the model selects it by id
 * (chromeSelectionNote, with the extension instance ids MoPilot read: `known`), never by family.
 * @param {string} serverName
 * @param {boolean} [chrome]
 * @param {boolean} [iab]
 * @param {{ chrome: string[], codexApp: string[] } | null} [known]
 * @param {string | null} [own] MoPilot's own Chrome backend note (B2): replaces the rule for picking the vendor's
 */
function inAppBrowserNote(serverName, chrome = true, iab = false, known = null, own = null) {
  const select = `${own ?? chromeSelectionNote(known)} `;
  // MoPilot's Chrome backend: its Chrome tabs are saved as files by browser_save_screenshot too (#1539)
  const ownShots = own ? ` ${chromeScreenshotHint(serverName)}` : '';
  if (iab) {
    const pane = `the Browser plugin's in-app browser (the "iab" backend, agent.browsers.get("iab")) is MoPilot's own browser pane, which the user sees in this app; the browser_* tools of the ${serverName} MCP server drive the same pane. `;
    return {
      kind: 'application',
      value:
        (chrome
          ? `Browser routing in MoPilot: ${pane}The plugin's Chrome backend drives the browser the ChatGPT extension is connected to, normally the user's own Chrome, not MoPilot's pane. Use iab when the user means the built-in browser (the in-app browser), the browser pane, or a page MoPilot opened; use Chrome when they mean their Chrome. ${select}`
          : `Browser routing in MoPilot: ${pane}Use iab when the user means the built-in browser (the in-app browser), the browser pane, or a page MoPilot opened. `) +
        // MoPilot's Chrome note (own) says it already
        `${paneConfirmNote(`the browser_* tools or the plugin's "iab" browser`)} ${previewNote()} ${BOT_CHECK_SIGNIN} ${PANE_ONLY_HINT} ${SCRIPT_HINT} ${IAB_TAB_RETENTION_HINT} ${screenshotUploadHint(serverName)}${own ? '' : ` ${UPLOAD_HINT}`}${ownShots}`,
    };
  }
  const pane = `MoPilot's built-in browser pane is driven only by the browser_* tools of the ${serverName} MCP server (start with browser_navigate); the plugin's in-app browser backend (createBrowserTab("iab")) is not available in MoPilot. `;
  return {
    kind: 'application',
    value:
      (chrome
        ? `Browser routing in MoPilot: the Browser plugin's Chrome backend drives the browser the ChatGPT extension is connected to, normally the user's own Chrome. ${pane}` +
          "Use browser_* when the user means the built-in browser (the in-app browser), the browser pane, or a page MoPilot opened; use the Browser plugin for the user's Chrome. " +
          select
        : `Browser routing in MoPilot: ${pane}Use browser_* when the user means the built-in browser (the in-app browser), the browser pane, or a page MoPilot opened. `) +
      `${paneConfirmNote('the browser_* tools')} ${previewNote()} ${BOT_CHECK_SIGNIN} ${SCRIPT_HINT}${ownShots}`,
  };
}

/**
 * The payment note for a native thread whose plugin reaches MoPilot's pane through the iab backend but that is shown no
 * browser_* tools, so no routing note carries it (#1384). It is kept in the thread's Codex history, so it holds only while
 * the plugin's selected iab browser is MoPilot's (the name the plugin shows the model); the Codex app's own in-app
 * browser has no MoPilot card, and there the model keeps its own confirmation.
 */
const iabPaymentNote = () =>
  paneConfirmNote(
    `the plugin's "iab" browser`,
    `Payments in the Browser plugin's "iab" browser while its name is "${IAB_NAME}" (MoPilot's pane; for any other browser, ignore this paragraph)`,
  );

/**
 * What the pane does that a native thread shown no browser_* tools can't (#1362): the plugin's tab API has no Stop or
 * Duplicate (its evaluate() reads a copy of the page, and MoPilot's iab backend offers no raw CDP), so the user's own
 * controls do it. Scoped to the plugin's iab browser while it is MoPilot's, as iabPaymentNote is. It says first that the
 * plugin's iab browser is the way to the pane: a model told only what it can't do there read the whole pane as unavailable.
 */
const iabPaneLimitsNote = () =>
  `In the Browser plugin's "iab" browser while its name is "${IAB_NAME}" (MoPilot's pane; for any other browser, ignore this paragraph): ` +
  'it is how you open, read and act on pages in the pane, so use it for the task as usual. Only two pane actions are not in its tab API: ' +
  'stopping a page that keeps loading, and duplicating a tab with its back/forward history. You cannot do those two yourself: ' +
  "ask the user to click Stop in the pane's toolbar, or Duplicate in the tab's right-click menu, and carry on with the rest of the task. " +
  `Open the same URL in a new tab only when the user wants the page and not its history, and say that its history is not copied. ${NO_SELF_COMPUTER_USE} ${IAB_TAB_RETENTION_HINT}`;

/**
 * A native thread's notes when it is shown no browser_* tools: MoPilot's Chrome backend note (`own`), else the rule for
 * selecting the user's Chrome (`chromeRule`, when the plugin can use Chrome), and, while the plugin's iab backend is
 * MoPilot's pane, the payment note and what only the user can do there.
 * @param {string | null} own
 * @param {string | null} chromeRule
 * @param {boolean} iab
 * @returns {string[]}
 */
const notesWithoutBrowserTools = (own, chromeRule, iab) => {
  const notes = /** @type {string[]} */ (
    [own || chromeRule, iab ? iabPaymentNote() : null, iab ? iabPaneLimitsNote() : null].filter(Boolean)
  );
  // a browser MoPilot serves (its pane, its Chrome backend) refuses bot checks; with no browser_* tools there is no
  // hand-off tool, so the user is asked in chat (#1615). The vendor's own Chrome keeps the vendor's rules.
  return iab || own ? [...notes, botCheckNote('Ask the user in chat to complete it, then continue.')] : notes;
};

/** The key under which Codex puts its turn metadata in an MCP tools/call's `_meta`. */
const TURN_METADATA = 'x-codex-turn-metadata';

/**
 * The Codex thread an MCP tools/call came from, read from the turn metadata Codex puts in its `_meta` (an object, or
 * the same as JSON text, as Codex's own plugins accept it): `session_id` is the thread at the top of the spawn tree,
 * and a sub-agent's call also names its own thread (`thread_id`, with `thread_source: "subagent"`); Codex's Browser and
 * Computer use plugins attribute a call the same way. `named`: the metadata says whose call it is (it has a
 * `thread_source`); without one, `session_id` may be a sub-agent's session rather than its own thread. `thread` is null
 * when the call carries no turn metadata (another harness, or a Codex that sends none).
 * @param {unknown} meta the call's params._meta
 * @returns {{ thread: string | null, session: string | null, named: boolean }}
 */
function codexCallThread(meta) {
  let m = isJsonRecord(meta) ? /** @type {Record<string, unknown>} */ (meta)[TURN_METADATA] : null;
  if (typeof m === 'string')
    try {
      m = JSON.parse(m);
    } catch {
      m = null;
    }
  if (!isJsonRecord(m)) return { thread: null, session: null, named: false };
  const at = /** @type {Record<string, unknown>} */ (m);
  const text = (/** @type {string} */ key) => {
    const v = at[key];
    return typeof v === 'string' && v.trim() ? v.trim() : null;
  };
  const session = text('session_id');
  const source = text('thread_source');
  const own = text('thread_id');
  if (source === 'subagent') return own ? { thread: own, session, named: true } : { thread: session, session, named: false };
  return { thread: session, session, named: source != null && session != null };
}

module.exports = {
  codexThreadConfig,
  gatewayThreadOff,
  issuedThreadConfig,
  nativeThreadConfig,
  nativeControlOff,
  helperThreadConfig,
  mergeConfig,
  codexCallThread,
  inAppBrowserNote,
  iabPaymentNote,
  iabPaneLimitsNote,
  notesWithoutBrowserTools,
  scopeNote,
  NATIVE_CUA_PLUGIN,
  CODEX_APPS_SERVER,
  IN_APP_BROWSER_CONTEXT,
};
