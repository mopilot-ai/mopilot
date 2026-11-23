// Claude in Chrome's connection in one Claude Code session (BU-07): connected or not, which browser, and the
// CLI's own reconnect and browser picker.
//
// The terminal's /chrome dialog reads this state and acts on it; the SDK-bundled CLI offers the same to a host
// over its control channel: get_chrome_dialog (allowed, installed, connected, paired_browser, urls),
// get_chrome_browsers / select_chrome_browser (its "Select browser" picker), and mcp_reconnect on the
// claude-in-chrome server ("Reconnect extension"). The SDK exposes them as Query methods (getChromeDialog,
// getChromeBrowsers, selectChromeBrowser, reconnectMcpServer); a CLI without the dialog falls back to the
// server's mcp status, which can only tell a server that failed (the link is down), never that the extension
// answers. MoPilot never talks to the extension itself.

const { contentBlocks } = require('../../../shared/contentBlocks.mjs');
const { noteIgnored } = require('../../ignored.cjs');
const { withTimeout: timed } = require('../../platform/timeout.cjs');
const { chromeLinkDown } = require('../../../shared/vendorErrors.mjs');
const SERVER = 'claude-in-chrome';
/** A reading that knows only that the server runs: nothing about the extension behind it. */
const UNKNOWN = Object.freeze({ unknown: true });
const CHROME_TOOL = /^mcp__claude-in-chrome__/;

const texts = (content) =>
  typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? contentBlocks(content)
          .filter((b) => b.type === 'text')
          .map((b) => String(b.text))
      : [];

/** An error's message, for a rejection that may not be an Error. */
const errorText = (e) => (e instanceof Error ? e.message : String(e));

/** A CLI request that gives up after `ms`. */
const withTimeout = (p, ms) => timed(p, ms, 'Timed out');

/**
 * The link as the session's CLI reports it now: {connected, browser, installed, urls}; UNKNOWN when only the
 * server's status says it runs (an older CLI); null when the CLI can't say (no session, or neither the dialog
 * nor the mcp status answers).
 */
async function readLink(q, ms = 5000) {
  if (!q) return null;
  if (typeof q.getChromeDialog === 'function') {
    try {
      const d = await withTimeout(q.getChromeDialog(), ms);
      if (d && typeof d === 'object') {
        return {
          connected: d.connected === true,
          browser: typeof d.paired_browser === 'string' && d.paired_browser ? d.paired_browser : null,
          installed: d.installed !== false,
          reconnectUrl: typeof d.urls?.reconnect === 'string' ? d.urls.reconnect : null,
          permissionsUrl: typeof d.urls?.permissions === 'string' ? d.urls.permissions : null,
        };
      }
    } catch (error) {
      // no dialog info: fall back to the MCP server status below
      noteIgnored("read Claude in Chrome's connection", error);
    }
  }
  if (typeof q.mcpServerStatus !== 'function') return null;
  try {
    const rows = await withTimeout(q.mcpServerStatus(), ms);
    const row = Array.isArray(rows) ? rows.find((s) => s?.name === SERVER) : null;
    if (!row) return null;
    // a running server says nothing about the extension behind it: the link is unknown, not connected
    if (row.status === 'connected') return UNKNOWN;
    return { connected: false, browser: null, installed: true, reconnectUrl: null, permissionsUrl: null };
  } catch (error) {
    // the CLI can't say
    noteIgnored("read Claude in Chrome's server status", error);
    return null;
  }
}

/** The browsers the session's server can use, [] when it can't list them (not connected, older CLI). */
async function listBrowsers(q, ms = 5000) {
  if (typeof q?.getChromeBrowsers !== 'function') return [];
  try {
    const r = await withTimeout(q.getChromeBrowsers(), ms);
    return (Array.isArray(r?.browsers) ? r.browsers : [])
      .filter((b) => b && typeof b.device_id === 'string')
      .map((b) => ({ id: b.device_id, name: typeof b.name === 'string' && b.name ? b.name : b.device_id, current: b.current === true }));
  } catch (error) {
    // not connected, or an older CLI: no browsers to pick from
    noteIgnored('list the browsers Claude in Chrome can use', error);
    return [];
  }
}

/** Switches the session to another paired browser, as the terminal's picker does. */
async function selectBrowser(q, id, ms = 10000) {
  if (typeof q?.selectChromeBrowser !== 'function') throw new Error("This Claude Code can't switch browsers.");
  await withTimeout(q.selectChromeBrowser(String(id)), ms);
}

/** The terminal's "Reconnect extension": the session reconnects its claude-in-chrome server. */
async function reconnect(q, ms = 30000) {
  if (typeof q?.reconnectMcpServer !== 'function') throw new Error("This Claude Code can't reconnect Claude in Chrome.");
  await withTimeout(q.reconnectMcpServer(SERVER), ms);
}

/**
 * Watches one session's messages for the moments its link may have changed, and keeps the last reading.
 * `note` answers why to read the link again, or null: 'start' (the session started with the server),
 * 'error' (a Claude in Chrome tool said the extension went away, in a wording of the vendor error table:
 * shared/vendorErrors.mjs chromeLinkDown), 'working' (a tool worked while the link read as down). A reading
 * is `dropped` when the link is down after it was up, or a tool found it gone: a session whose server is
 * still connecting at its start is not a drop.
 */
class ChromeLink {
  constructor() {
    this.pending = new Set();
    /** @type {{ connected?: boolean, [k: string]: unknown } | null} the last link read for the session, or null before one */
    this.state = null;
  }

  note(msg) {
    if (msg?.type === 'system' && msg.subtype === 'init')
      return Array.isArray(msg.mcp_servers) && msg.mcp_servers.some((s) => s?.name === SERVER) ? 'start' : null;
    const blocks = msg?.message?.content;
    if (!Array.isArray(blocks)) return null;
    /** @type {'error' | 'working' | null} */
    let why = null;
    for (const b of blocks) {
      if (msg.type === 'assistant' && b?.type === 'tool_use' && CHROME_TOOL.test(String(b.name))) this.pending.add(b.id);
      if (msg.type !== 'user' || b?.type !== 'tool_result' || !this.pending.delete(b.tool_use_id)) continue;
      if (b.is_error && texts(b.content).some(chromeLinkDown)) why = 'error';
      // a working tool after a disconnect means the link is back
      else if (!b.is_error && this.state?.connected === false) why ??= 'working';
    }
    return why;
  }

  /**
   * Keeps a new reading (with whether it is a drop); true when it differs from the last one. A CLI that
   * can't say (`link` null) leaves the last reading, and whether it was a drop, as it was; a server that runs
   * (UNKNOWN) clears a reading that said the link was down, since it may well be back.
   */
  set(link, why = null) {
    if (!link) return false;
    if (link === UNKNOWN) {
      const changed = this.state !== null;
      this.state = null;
      return changed;
    }
    const dropped = !link.connected && (why === 'error' || this.state?.connected === true || this.state?.dropped === true);
    const next = { ...link, dropped };
    const changed = JSON.stringify(next) !== JSON.stringify(this.state);
    this.state = next;
    return changed;
  }
}

module.exports = { errorText, ChromeLink, readLink, listBrowsers, selectBrowser, reconnect, SERVER, UNKNOWN };
