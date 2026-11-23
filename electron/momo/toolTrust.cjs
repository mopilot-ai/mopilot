// MoMo's tool calls through its trust gate (#2283): every tool a MoMo chat may use (toolIsolation.cjs) has a trust class, by
// exact name, and the capability registry's chat gate (registry.setChatGate) runs each call of a MoMo chat by it before the
// handler: a navigation, a click, typing, a key, a form fill, an upload or a script sends data to a destination (the URL's
// host, or the page or app it acts on), so the sentinel decides it under the egress rule (after a private read, a send to
// a host the chat hasn't opened asks, which refuses while there is no card) and the audit log records its intent and
// outcome; a read of a page or of the user's own history, bookmarks or clipboard is a private read, which taints the chat
// like a source read; a screenshot of the screen sends nothing; MoMo's own tools check themselves (sources go through the
// hub, sourceTrust.cjs). A tool with no class is refused.
const { ToolError } = require('../capabilities/contract/registry.cjs');
const { LEVELS, normHost } = require('./sentinelRules.cjs');
const { PROXIED } = require('./mcp/names.cjs');

/**
 * The trust class of each tool a MoMo chat may use. own: MoMo's own tools and the chat's panes, which send nothing out
 * (a source read is decided and audited by the sources hub). read: shows the screen, lists tabs or moves the view and
 * sends nothing. personal: reads the user's own history, bookmarks or clipboard. page: reads a page's text, tree,
 * console, requests or image, which may be a logged-in page. Both are private data: the chat is tainted.
 * navigate: opens its `url` (a host, or a step on the page's history). act: acts on the page or app in front (a click, a
 * key, typed text, a form fill, an upload, a script, closing a tab, starting a preview, a batch of those), which can send
 * what it types or submits there.
 */
const CLASSES = Object.freeze({
  own: [
    'momo_calendar_events',
    // writes to Calendar and Reminders (#2139 P5) and their undo: each runs through the trust gate itself (sources/write.cjs)
    'momo_calendar_create_event',
    'momo_reminders_add',
    'momo_reminders_complete',
    'momo_undo_write',
    // a test-only MoMo tool (SAGE_DEBUG_TOOLS=1) whose change asks through the trust gate itself
    'momo_debug_action',
    'momo_files_list',
    'momo_files_read',
    // MoMo's own folder of saved text files (outputs.cjs): a save is decided and audited through the trust gate itself
    'momo_save_file',
    'momo_save_sheet',
    'momo_outputs_list',
    // shows the user a draft message as a card in the chat (draftTools.cjs): data in the chat's own history, sent nowhere
    'momo_draft',
    // reads MoMo's own index of its past chats
    'momo_history_search',
    'momo_memory_forget',
    'momo_memory_save',
    'momo_memory_search',
    // MoMo's own open loops: lists them, or closes, dismisses or snoozes one when the user asks
    'momo_open_loops',
    'momo_reminders_list',
    // adds a row to MoMo's own Up next; nothing starts until the user presses Start
    'momo_suggest',
    // proposes a routine into MoMo's own store; the user approves it in Settings before it runs
    'momo_routine_propose',
    'plugin_skill_read',
    'plugin_skills',
    'show_pane',
    'close_pane',
    'update_task_list',
    'wrap_up',
  ],
  read: [
    'browser_preview_list',
    'browser_preview_logs',
    'browser_resize_window',
    'browser_tabs_context',
    'browser_tabs_mark',
    'browser_tabs_select',
    'chrome_resize_window',
    'chrome_tabs_context_mcp',
    'computer_describe',
    'computer_elements',
    'computer_locate',
    'computer_screenshot',
    'computer_scroll',
    'desktop_app_ax_find',
    'desktop_app_bring_to_current_space',
    'desktop_app_focus',
    'desktop_app_list_windows',
    'desktop_app_release',
    'desktop_app_screenshot',
    'desktop_app_scroll',
    'desktop_app_zoom',
    'desktop_cursor_position',
    'desktop_list_granted_applications',
    'desktop_release_full_control',
    'desktop_request_access',
    'desktop_screenshot',
    'desktop_scroll',
    'desktop_shortcut_list',
    'desktop_switch_display',
    'desktop_wait',
    'desktop_zoom',
  ],
  personal: ['browser_bookmarks_search', 'browser_history_search', 'desktop_read_clipboard'],
  page: [
    // the developer tools' reads: an audit, the vitals and a HAR of the page's own traffic
    'browser_accessibility_audit',
    'browser_find',
    'browser_get_page_text',
    'browser_har',
    'browser_page_tools',
    'browser_read_console_messages',
    'browser_read_network_requests',
    'browser_read_page',
    'browser_vitals',
    'chrome_accessibility_audit',
    'chrome_find',
    'chrome_get_page_text',
    'chrome_har',
    'chrome_page_tools',
    'chrome_read_console_messages',
    'chrome_read_network_requests',
    'chrome_read_page',
    'chrome_vitals',
    'sage_browser_screenshot',
    'sage_browser_snapshot',
  ],
  navigate: ['browser_navigate', 'browser_tabs_create', 'chrome_navigate', 'chrome_tabs_create_mcp', 'sage_browser_navigate'],
  act: [
    'browser_batch',
    'browser_computer',
    'browser_file_upload',
    'browser_form_input',
    'browser_gif_creator',
    'browser_handle_dialog',
    'browser_javascript_exec',
    'browser_perf_trace',
    'browser_page_tool',
    'browser_preview_start',
    'browser_preview_stop',
    // reads the page's own world; renders_start reloads the page
    'browser_react',
    'browser_record',
    'browser_request_credentials',
    'browser_request_signin',
    'browser_save_screenshot',
    'browser_script',
    'browser_tabs_close',
    'chrome_browser_batch',
    'chrome_computer',
    'chrome_file_upload',
    'chrome_form_input',
    'chrome_gif_creator',
    'chrome_handle_dialog',
    'chrome_javascript_tool',
    'chrome_perf_trace',
    'chrome_react',
    'chrome_record',
    'chrome_page_tool',
    'chrome_tabs_close_mcp',
    'chrome_upload_image',
    'sage_browser_click',
    'sage_browser_type',
    'computer_click',
    'computer_key',
    'computer_type',
    'desktop_app_batch',
    'desktop_app_click',
    'desktop_app_drag',
    'desktop_app_file_panel',
    'desktop_app_key',
    'desktop_app_menu',
    'desktop_app_script',
    'desktop_app_type',
    'desktop_batch',
    'desktop_double_click',
    'desktop_hold_key',
    'desktop_key',
    'desktop_left_click',
    'desktop_left_click_drag',
    'desktop_left_mouse_down',
    'desktop_left_mouse_up',
    'desktop_middle_click',
    'desktop_mouse_move',
    'desktop_open_application',
    'desktop_request_full_control',
    'desktop_request_teach_access',
    'desktop_right_click',
    'desktop_shortcut_run',
    'desktop_teach_batch',
    'desktop_teach_step',
    'desktop_triple_click',
    'desktop_type',
    'desktop_write_clipboard',
  ],
});

/** @typedef {'own' | 'read' | 'personal' | 'page' | 'navigate' | 'act'} TrustClass */
/** @type {Map<string, TrustClass>} */
const CLASS_OF = new Map();
for (const [cls, names] of Object.entries(CLASSES)) for (const n of names) CLASS_OF.set(n, /** @type {TrustClass} */ (cls));

/**
 * A tool's trust class, or null when it has none (then a MoMo chat's call is refused). A coding-side MCP server's tool
 * that MoMo re-offers (mcp/proxy.cjs) is MoMo's own: the proxy asks the trust layer and the audit log itself.
 */
const trustClassOf = (/** @type {string} */ name) => CLASS_OF.get(name) ?? (PROXIED.test(name) ? 'own' : null);

/** The sentinel's sources for these calls: what they reach (never blocked), and the user's own data read through them. */
const SURFACES = Object.freeze({
  browser: { level: LEVELS.READ, name: 'The browser' },
  computer: { level: LEVELS.READ, name: 'Computer use' },
  personal: { level: LEVELS.READ, private: true, name: 'Your history, bookmarks and clipboard' },
  page: { level: LEVELS.READ, private: true, name: 'Pages open in the browser' },
});
/** The classes that read private data and send nothing. */
const PRIVATE_READS = new Set(['personal', 'page']);
/** Acts that run a script, or steps that may be one: whatever page they run on, they can send anywhere. */
const SCRIPTS = new Set(['browser_javascript_exec', 'browser_script', 'browser_batch', 'chrome_javascript_tool', 'chrome_browser_batch']);
/** The destination of an act whose host can't be read from its arguments: the page or app it acts on, never allow-listed. */
const ACTED_ON = Object.freeze({ browser: 'the page open in the browser', computer: 'the app in front on this Mac' });
/** A navigation's `url` that is a step on the page's own history, not a host. */
const HISTORY_STEPS = new Set(['back', 'forward', 'reload', 'stop']);
/** A web address, the kind that names a host (a file or data address names none). */
const SCHEME_URL = /^https?:\/\//i;
/** An address with a scheme: http(s) names a host; about:blank opens nothing; any other (javascript:, data:, file:) acts on the page. */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

const surfaceOf = (/** @type {string} */ name) => (/^(computer|desktop)_/.test(name) ? 'computer' : 'browser');
/** Which browser a tool drives (the user's Chrome, the panel's, the in-app one), each with its own current page. */
const browserOf = (/** @type {string} */ name) => /^(chrome|sage_browser|browser)_/.exec(name)?.[1] ?? null;

/** Every web address among the string values of `v` (a batch's steps; JSON from the harness, so it has no cycle). */
function urlsIn(/** @type {unknown} */ v, /** @type {string[]} */ out = []) {
  if (typeof v === 'string') {
    if (SCHEME_URL.test(v.trim())) out.push(v.trim());
  } else if (v && typeof v === 'object') for (const x of Object.values(v)) urlsIn(x, out);
  return out;
}

/**
 * Where a call of class `cls` sends data: none for a read or a blank page; a navigation's host (a history step or another
 * scheme acts on the page); an act's page or app, and any URL its arguments name. `current`: the host the tab it acts on
 * shows now, which an act on the page sends to; unknown, the page is a destination never allowed.
 * @returns {import('./sentinelRules.cjs').Egress | undefined}
 */
function egressOf(
  /** @type {string} */ cls,
  /** @type {string} */ name,
  /** @type {any} */ args,
  /** @type {string | null} */ current = null,
) {
  if (cls === 'read' || PRIVATE_READS.has(cls)) return undefined;
  const hosts = urlsIn(args);
  const url = typeof args?.url === 'string' ? args.url.trim() : '';
  const scheme = SCHEME.exec(url)?.[1].toLowerCase();
  // the page or app itself: never allowed after a private read (a script can send anywhere)
  const anywhere = { hosts: [...new Set(hosts)], recipients: [ACTED_ON[surfaceOf(name)]] };
  const page = current && !SCRIPTS.has(name) ? { hosts: [...new Set([current, ...hosts])] } : anywhere;
  if (cls !== 'navigate' || HISTORY_STEPS.has(url.toLowerCase())) return page;
  // a new tab with no address, or a blank page, opens nothing
  if (!url || url.toLowerCase() === 'about:blank') return hosts.length ? { hosts: [...new Set(hosts)] } : undefined;
  // another scheme acts on the page; an http(s) address without `//` (`https:@evil.example/?d=`) names no host this can read,
  // though the browser may still reach one: never allowed after a private read
  if (scheme && !SCHEME_URL.test(url)) return anywhere;
  if (!scheme) hosts.push(url);
  return { hosts: [...new Set(hosts)] };
}

/**
 * A chat's harness and account for the audit log, from its record: the current segment's harness, and the account
 * `accountOf` reads for it (each harness keeps a chat's account its own way; by default the chat's saved Claude login).
 * @param {() => { records: Map<string, any> } | null | undefined} chats
 * @param {(rec: any, segment: any) => unknown} [accountOf]
 * @returns {(chatId: string) => { harness?: string, account?: string }}
 */
const chatIdentity =
  (chats, accountOf = (rec) => rec?.meta?.account?.id) =>
  (chatId) => {
    const rec = chats()?.records.get(chatId);
    const segment = rec?.segments?.at(-1);
    const harness = segment?.kind;
    const account = rec ? accountOf(rec, segment) : undefined;
    return {
      ...(typeof harness === 'string' && harness ? { harness } : {}),
      ...(typeof account === 'string' && account ? { account } : {}),
    };
  };

/**
 * The registry's chat gate for MoMo's chats: each call by its trust class, through the trust gate. A call that sends
 * data goes to the sentinel as a repeatable read with destinations, so an untainted chat's acts run (audited) while
 * there is no approval card, and a failed click or navigation can be tried again; a change would ask every time and
 * could never run. After a private read, a send to a host the chat already opened is allowed (and audited), a send to a
 * new one asks (Muse's sentinel rule). An act's page is the host its tab shows at decision time, read from the browser
 * that owns the tab (`pageOf`); a page that can't be read is a new host. Only the user's intent opens a host: the address
 * a navigation names, and where it landed while the chat has read nothing private. A host reached by a click or a
 * redirect after a private read is never opened, so a send there asks.
 * @param {{ trust: ReturnType<typeof import('./trustGate.cjs').createTrustGate>,
 *           sentinel: Pick<InstanceType<typeof import('./sentinel.cjs').Sentinel>, 'setSource' | 'noteOpened' | 'taintOf'>,
 *           identity: (chatId: string) => { harness?: string, account?: string },
 *           pageOf?: (chatId: string, browser: string, tabId: unknown) => string | null | Promise<string | null> }} o
 *   pageOf: the URL the chat's tab in that browser shows now (the named tab, else its current one); none: never known
 * @returns {import('../capabilities/contract/registry.cjs').ChatGate}
 */
function createMomoCallGate({ trust, sentinel, identity, pageOf = () => null }) {
  for (const [id, s] of Object.entries(SURFACES)) sentinel.setSource(id, s);
  /** The host the tab a browser call names shows now; null when it has no web page or can't be read. */
  const hostNow = async (/** @type {string} */ chatId, /** @type {string} */ tool, /** @type {any} */ args) => {
    const browser = browserOf(tool);
    if (!browser) return null;
    let url;
    try {
      url = await pageOf(chatId, browser, args?.tabId ?? args?.tab_id ?? null);
    } catch {
      // an unreadable tab is a new host
      return null;
    }
    return typeof url === 'string' && SCHEME_URL.test(url) ? normHost(url) : null;
  };
  return async ({ chatId, tool, args, signal }, run) => {
    const cls = trustClassOf(tool);
    if (!cls) throw new ToolError(`${tool} has no trust check for MoMo, so it didn't run.`, 'unavailable');
    // MoMo's own tools check themselves; a screenshot of the screen or a tab list sends nothing and reads no page
    if (cls === 'own' || cls === 'read') return run();
    const egress = egressOf(cls, tool, args, PRIVATE_READS.has(cls) ? null : await hostNow(chatId, tool, args));
    const source = PRIVATE_READS.has(cls) ? cls : surfaceOf(tool);
    // the host a navigation opens: its own address, when that names one
    const opens = cls === 'navigate' && egress && !egress.recipients ? normHost(String(args?.url ?? '').trim()) : null;
    /** @type {{ error: unknown } | null} the handler's own failure, passed on as it was */
    let failed = null;
    /** @type {unknown} what the handler returned, kept from the gate: its own `result` field is never read as an outcome */
    let out;
    const r = await trust(
      {
        chatId,
        tool,
        source,
        kind: 'read',
        args,
        ...identity(chatId),
        ...(egress ? { egress, repeatable: true } : {}),
        // the address it opens, which may open an always-allowed site without a card (sentinelSites.cjs), shown on the card
        ...(opens ? { opens: String(args.url).trim(), summary: `Open ${String(args.url).trim().slice(0, 160)}` } : {}),
      },
      async () => {
        try {
          out = await run();
        } catch (error) {
          failed = { error };
          throw error;
        }
      },
      { signal },
    );
    if (failed) throw /** @type {{ error: unknown }} */ (failed).error;
    // every result that isn't ok carries the text the model is told (a refusal, or nothing sent)
    if (!r.ok) throw new ToolError(String(r.text), 'denied');
    // a navigation allowed by an always-allowed site opens it for the chat, as Allow once does: acts there ask no more than then
    if (opens) {
      // where it landed: opened too while the chat read nothing private; after that a redirect elsewhere opens nothing
      const landed = await hostNow(chatId, tool, args);
      sentinel.noteOpened(chatId, landed && !sentinel.taintOf(chatId).length ? [opens, landed] : [opens]);
    }
    return out;
  };
}

module.exports = { CLASSES, SURFACES, trustClassOf, egressOf, chatIdentity, createMomoCallGate };
